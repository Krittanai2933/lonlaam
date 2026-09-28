import { rateLimit } from '../lib/ratelimit'
import type { CreateInvoiceResponse, GetInvoiceResponse, GetPublicProjectResponse, LeaderboardResponse, ListSupportersResponse } from '@nampu/types'
import { LIMITS, PUBLIC_PAGE } from '@nampu/types'
import { and, desc, eq, ne } from 'drizzle-orm'
import { Hono } from 'hono'
import type { Context } from 'hono'
import * as v from 'valibot'
import { type AppEnv, type Db, lnurlOptions, publicOrigin } from '../context'
import { isUniqueViolation } from '../db/errors'
import { creators, invoices, projects } from '../db/schema'
import { MAX_PENDING } from '../do/project-room'
import { Bolt11Error, decodeBolt11 } from '../lightning/bolt11'
import { fetchPayRequest, requestInvoice } from '../lightning/lnurl'
import { ApiError, notFound } from '../lib/errors'
import { newId } from '../lib/util'
import { json } from '../lib/validate'
import { pageLimit, supporterPage } from '../lib/supporters'
import { clampLimit, LEADERBOARD_LIMIT } from '../lib/discover'
import { toInvoice, toPublicProject, toSupporter } from '../serialize'

const createInvoiceBody = v.object({
  amountSats: v.pipe(v.number(), v.safeInteger(), v.minValue(LIMITS.invoiceSats.min), v.maxValue(LIMITS.invoiceSats.max)),
  supporterName: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(LIMITS.supporterName.max))),
  comment: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(LIMITS.comment.max))),
})

/** Public projects are active or closed; drafts are invisible. */
export async function findPublicProject(db: Db, slug: string) {
  const [row] = await db
    .select({
      project: projects,
      creator: {
        handle: creators.handle,
        displayName: creators.displayName,
        npub: creators.npub,
        lightningAddress: creators.lightningAddress,
      },
    })
    .from(projects)
    .innerJoin(creators, eq(creators.id, projects.creatorId))
    .where(and(eq(projects.slug, slug.toLowerCase()), ne(projects.status, 'draft')))
    .limit(1)
  return row ?? null
}

async function requirePublicProject(c: Context<AppEnv>) {
  const row = await findPublicProject(c.var.db, c.req.param('slug') ?? '')
  if (!row) throw notFound('project')
  return row
}

const roomFor = (env: Env, projectId: string) => env.PROJECT_ROOM.get(env.PROJECT_ROOM.idFromName(projectId))

/** Largest single payments (names are free text, so summing by name would be spoofable). */
function leaderRows(db: Db, projectId: string, limit: number) {
  return db
    .select({
      id: invoices.id,
      supporterName: invoices.supporterName,
      comment: invoices.comment,
      amountMsat: invoices.amountMsat,
      paidAt: invoices.paidAt,
    })
    .from(invoices)
    .where(and(eq(invoices.projectId, projectId), eq(invoices.status, 'paid')))
    .orderBy(desc(invoices.amountMsat), desc(invoices.paidAt), desc(invoices.id))
    .limit(limit)
}

export const publicRoutes = new Hono<AppEnv>()
  .get('/p/:slug', async (c) => {
    const { project, creator } = await requirePublicProject(c)
    const [supporters, leaders] = await Promise.all([
      supporterPage(c.var.db, project.id, {}, undefined, PUBLIC_PAGE.supporters),
      leaderRows(c.var.db, project.id, PUBLIC_PAGE.leaders),
    ])
    c.header('cache-control', 'public, max-age=10')
    return c.json({
      ...toPublicProject(project, creator, publicOrigin(c.env, c.req.url)),
      supporters,
      leaders: leaders.map(toSupporter),
    } satisfies GetPublicProjectResponse)
  })

  .get('/p/:slug/supporters', async (c) => {
    const { project } = await requirePublicProject(c)
    return c.json(
      (await supporterPage(c.var.db, project.id, {}, c.req.query('cursor'), pageLimit(c.req.query('limit')))) satisfies ListSupportersResponse,
    )
  })

  .get('/p/:slug/leaderboard', async (c) => {
    const { project } = await requirePublicProject(c)
    const rows = await leaderRows(c.var.db, project.id, clampLimit(c.req.query('limit'), LEADERBOARD_LIMIT))
    c.header('cache-control', 'public, max-age=15')
    return c.json({ leaders: rows.map(toSupporter) } satisfies LeaderboardResponse)
  })

  /**
   * Non-custodial flow: the invoice is issued by the creator's own wallet via LNURL-pay
   * (2 subrequests), and the project's Durable Object polls its LUD-21 verify URL.
   */
  .post('/p/:slug/invoices', rateLimit('RL_INVOICE', 'invoice'), json(createInvoiceBody), async (c) => {
    const body = c.req.valid('json')
    const { project, creator } = await requirePublicProject(c)
    if (project.status !== 'active' || (project.endsAt !== null && project.endsAt <= Date.now())) {
      throw new ApiError(409, 'project_not_active', 'this project is not accepting payments')
    }
    if (!creator.lightningAddress) throw new ApiError(409, 'lightning_address_missing', 'creator has no Lightning Address')

    const opts = lnurlOptions(c.env)
    const amountMsat = body.amountSats * 1000
    const pay = await fetchPayRequest(creator.lightningAddress, opts)
    if (amountMsat < pay.minSendable || amountMsat > pay.maxSendable) {
      throw new ApiError(
        422,
        'amount_out_of_range',
        `amount must be between ${Math.ceil(pay.minSendable / 1000)} and ${Math.floor(pay.maxSendable / 1000)} sats`,
      )
    }
    const cb = await requestInvoice(pay, amountMsat, body.comment || undefined, opts)

    let decoded
    try {
      decoded = decodeBolt11(cb.pr)
    } catch (e) {
      throw new ApiError(502, 'lnurl_error', `LNURL: wallet returned an invalid invoice (${e instanceof Bolt11Error ? e.message : 'decode failed'})`)
    }
    if (decoded.amountMsat !== amountMsat) throw new ApiError(502, 'lnurl_error', 'LNURL: invoice amount does not match request')
    const now = Date.now()
    const expiresAt = (decoded.timestamp + decoded.expiry) * 1000
    if (expiresAt <= now + 30_000) throw new ApiError(502, 'lnurl_error', 'LNURL: invoice is already expired')

    const id = newId()
    // Register with the DO before the row exists: if the insert then fails, the DO just
    // polls an unknown invoice until expiry and its conditional updates match nothing.
    const tracked = await roomFor(c.env, project.id).trackInvoice({
      id,
      projectId: project.id,
      verifyUrl: cb.verify,
      paymentHash: decoded.paymentHash,
      amountMsat,
      createdAt: now,
      expiresAt,
    })
    if (!tracked.ok) {
      throw new ApiError(429, 'rate_limited', `too many unpaid invoices for this project (max ${MAX_PENDING}); try again shortly`)
    }

    try {
      const [row] = await c.var.db
        .insert(invoices)
        .values({
          id,
          projectId: project.id,
          amountMsat,
          supporterName: body.supporterName || null,
          comment: body.comment || null,
          bolt11: cb.pr,
          paymentHash: decoded.paymentHash,
          verifyUrl: cb.verify,
          createdAt: now,
          expiresAt,
        })
        .returning()
      return c.json(toInvoice(row!) satisfies CreateInvoiceResponse, 201)
    } catch (e) {
      if (isUniqueViolation(e)) throw new ApiError(502, 'lnurl_error', 'LNURL: wallet reused a payment hash')
      throw e
    }
  })

  .get('/invoices/:id', async (c) => {
    const row = await c.var.db.query.invoices.findFirst({ where: eq(invoices.id, c.req.param('id')) })
    if (!row) throw notFound('invoice')
    c.header('cache-control', 'no-store')
    return c.json(toInvoice(row) satisfies GetInvoiceResponse)
  })

  // Upgrade handled by the project's Durable Object (Hibernation API).
  .get('/p/:slug/ws', async (c) => {
    if (c.req.header('upgrade')?.toLowerCase() !== 'websocket') {
      throw new ApiError(426, 'bad_request', 'expected a WebSocket upgrade')
    }
    const { project } = await requirePublicProject(c)
    const headers = new Headers(c.req.raw.headers)
    headers.set('x-project-id', project.id)
    return roomFor(c.env, project.id).fetch(new Request(c.req.url, { headers }))
  })
