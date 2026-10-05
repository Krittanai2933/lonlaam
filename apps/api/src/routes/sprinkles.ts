import type { CreateSprinkleResponse, GetSprinkleResponse, SprinkleConfigResponse } from '@nampu/types'
import { LIMITS, SPRINKLE, sprinkleShare } from '@nampu/types'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import * as v from 'valibot'
import type { AppEnv } from '../context'
import { isUniqueViolation } from '../db/errors'
import { sprinkles } from '../db/schema'
import { NwcError, NwcWallet } from '../lightning/nwc'
import { ApiError, notFound } from '../lib/errors'
import { rateLimit } from '../lib/ratelimit'
import { countEligible, nwcConnection, toSprinkle } from '../lib/sprinkle'
import { newId } from '../lib/util'
import { json } from '../lib/validate'

/** How long the supporter has to pay the platform wallet's invoice. */
const INVOICE_EXPIRY_S = 600

const createSprinkleBody = v.object({
  amountSats: v.pipe(v.number(), v.safeInteger(), v.minValue(SPRINKLE.amountSats.min), v.maxValue(SPRINKLE.amountSats.max)),
  projectCount: v.pipe(v.number(), v.safeInteger(), v.minValue(SPRINKLE.projects.min), v.maxValue(SPRINKLE.projects.max)),
  supporterName: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(LIMITS.supporterName.max))),
  comment: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(LIMITS.comment.max))),
})

const unavailable = () => new ApiError(503, 'sprinkle_unavailable', 'random sprinkles are not available right now')

export const sprinkleRoutes = new Hono<AppEnv>()
  .get('/config', async (c) => {
    const enabled = nwcConnection(c.env) !== null
    c.header('cache-control', 'public, max-age=30')
    return c.json({ enabled, eligibleProjects: enabled ? await countEligible(c.var.db) : 0 } satisfies SprinkleConfigResponse)
  })

  /** Custodial: the supporter pays the platform wallet, which pays each picked project (SprinkleRoom). */
  .post('/', rateLimit('RL_INVOICE', 'sprinkle'), json(createSprinkleBody), async (c) => {
    const body = c.req.valid('json')
    const conn = nwcConnection(c.env)
    if (!conn) throw unavailable()
    const perProjectSats = sprinkleShare(body.amountSats, body.projectCount)
    if (perProjectSats < SPRINKLE.minSatsPerProject) {
      throw new ApiError(422, 'amount_out_of_range', `each project must get at least ${SPRINKLE.minSatsPerProject} sats; raise the amount or pick fewer projects`)
    }
    const eligible = await countEligible(c.var.db)
    if (eligible < body.projectCount) {
      throw new ApiError(409, 'not_enough_projects', `only ${eligible} projects are accepting payments right now`)
    }

    let invoice
    const wallet = new NwcWallet(conn)
    try {
      invoice = await (await wallet.client()).makeInvoice(body.amountSats * 1000, `${c.env.SITE_NAME} · sprinkle to ${body.projectCount} projects`, INVOICE_EXPIRY_S)
    } catch (e) {
      console.error('sprinkle: make_invoice failed', e instanceof NwcError ? `${e.code}: ${e.message}` : e)
      throw unavailable()
    } finally {
      wallet.close()
    }

    const now = Date.now()
    const id = newId()
    let row
    try {
      ;[row] = await c.var.db
        .insert(sprinkles)
        .values({
          id,
          amountMsat: body.amountSats * 1000,
          projectCount: body.projectCount,
          perProjectMsat: perProjectSats * 1000,
          supporterName: body.supporterName || null,
          comment: body.comment || null,
          bolt11: invoice.invoice,
          paymentHash: invoice.paymentHash,
          createdAt: now,
          expiresAt: invoice.expiresAt ?? now + INVOICE_EXPIRY_S * 1000,
        })
        .returning()
    } catch (e) {
      if (isUniqueViolation(e)) throw unavailable()
      throw e
    }
    await c.env.SPRINKLE_ROOM.get(c.env.SPRINKLE_ROOM.idFromName(id)).start(id)
    return c.json((await toSprinkle(c.var.db, row!)) satisfies CreateSprinkleResponse, 201)
  })

  .get('/:id', rateLimit('RL_POLL', 'sprinkle-poll'), async (c) => {
    const row = await c.var.db.query.sprinkles.findFirst({ where: eq(sprinkles.id, c.req.param('id')) })
    if (!row) throw notFound('sprinkle')
    c.header('cache-control', 'no-store')
    return c.json((await toSprinkle(c.var.db, row)) satisfies GetSprinkleResponse)
  })
