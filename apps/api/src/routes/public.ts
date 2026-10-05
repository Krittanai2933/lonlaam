import { rateLimit } from '../lib/ratelimit'
import type { CreateInvoiceResponse, GetInvoiceResponse, GetPublicProjectResponse, LeaderboardResponse, ListSupportersResponse } from '@nampu/types'
import { LIMITS, PUBLIC_PAGE } from '@nampu/types'
import { and, desc, eq, ne } from 'drizzle-orm'
import { Hono } from 'hono'
import type { Context } from 'hono'
import * as v from 'valibot'
import { type AppEnv, type Db, mediaBase, publicOrigin } from '../context'
import { creators, invoices, projects } from '../db/schema'
import { ApiError, notFound } from '../lib/errors'
import { nip98Pubkey } from '../lib/signatures'
import { json, nostrEventSchema } from '../lib/validate'
import { createProjectInvoice, roomFor } from '../lib/project-invoice'
import { pageLimit, supporterPage } from '../lib/supporters'
import { clampLimit, LEADERBOARD_LIMIT } from '../lib/discover'
import { toInvoice, toPublicProject, toSupporter } from '../serialize'

const createInvoiceBody = v.object({
  amountSats: v.pipe(v.number(), v.safeInteger(), v.minValue(LIMITS.invoiceSats.min), v.maxValue(LIMITS.invoiceSats.max)),
  supporterName: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(LIMITS.supporterName.max))),
  comment: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(LIMITS.comment.max))),
  nostrProof: v.optional(nostrEventSchema),
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

/** Largest single payments (names are free text, so summing by name would be spoofable). */
function leaderRows(db: Db, projectId: string, limit: number) {
  return db
    .select({
      id: invoices.id,
      supporterName: invoices.supporterName,
      supporterPubkey: invoices.supporterPubkey,
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
      ...toPublicProject(project, creator, mediaBase(c.env, c.req.url)),
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

  /** Non-custodial: the invoice comes from the creator's own wallet (see createProjectInvoice). */
  .post('/p/:slug/invoices', rateLimit('RL_INVOICE', 'invoice'), json(createInvoiceBody), async (c) => {
    const body = c.req.valid('json')
    const { project, creator } = await requirePublicProject(c)
    if (project.status !== 'active' || (project.endsAt !== null && project.endsAt <= Date.now())) {
      throw new ApiError(409, 'project_not_active', 'this project is not accepting payments')
    }
    if (!creator.lightningAddress) throw new ApiError(409, 'lightning_address_missing', 'creator has no Lightning Address')
    // The proof only adds a profile picture/name; a bad one never blocks a payment.
    const { nostrProof, ...input } = body
    const supporterPubkey = nostrProof
      ? await nip98Pubkey(nostrProof, `${publicOrigin(c.env, c.req.url)}/api/p/${project.slug}/invoices`, 'POST')
      : null
    const row = await createProjectInvoice(c.env, c.var.db, project.id, creator.lightningAddress, { ...input, supporterPubkey })
    return c.json(toInvoice(row) satisfies CreateInvoiceResponse, 201)
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
