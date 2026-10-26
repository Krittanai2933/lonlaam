import type { CreateSprinkleResponse, GetSprinkleResponse, SprinkleConfigResponse } from '@nampu/types'
import { LIMITS, SPRINKLE, sprinkleShare } from '@nampu/types'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import * as v from 'valibot'
import type { AppEnv } from '../context'
import { sprinkles } from '../db/schema'
import { ApiError, notFound } from '../lib/errors'
import { rateLimit } from '../lib/ratelimit'
import { countEligible, createSprinkle, nwcConnection, sprinkleUnavailable, toSprinkle } from '../lib/sprinkle'
import { json } from '../lib/validate'

const createSprinkleBody = v.object({
  amountSats: v.pipe(v.number(), v.safeInteger(), v.minValue(SPRINKLE.amountSats.min), v.maxValue(SPRINKLE.amountSats.max)),
  projectCount: v.pipe(v.number(), v.safeInteger(), v.minValue(SPRINKLE.projects.min), v.maxValue(SPRINKLE.projects.max)),
  excludeFunded: v.optional(v.boolean(), false),
  supporterName: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(LIMITS.supporterName.max))),
  comment: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(LIMITS.comment.max))),
})

export const sprinkleRoutes = new Hono<AppEnv>()
  .get('/config', async (c) => {
    const enabled = nwcConnection(c.env) !== null
    c.header('cache-control', 'public, max-age=30')
    const count = enabled ? await countEligible(c.var.db) : { all: 0, unfunded: 0 }
    return c.json({ enabled, eligibleProjects: count.all, eligibleUnfunded: count.unfunded } satisfies SprinkleConfigResponse)
  })

  /** Custodial: the supporter pays the platform wallet, which pays each picked project (SprinkleRoom). */
  .post('/', rateLimit('RL_INVOICE', 'sprinkle'), json(createSprinkleBody), async (c) => {
    const body = c.req.valid('json')
    if (!nwcConnection(c.env)) throw sprinkleUnavailable()
    const perProjectSats = sprinkleShare(body.amountSats, body.projectCount)
    if (perProjectSats < SPRINKLE.minSatsPerProject) {
      throw new ApiError(422, 'amount_out_of_range', `each project must get at least ${SPRINKLE.minSatsPerProject} sats; raise the amount or pick fewer projects`)
    }
    const count = await countEligible(c.var.db)
    const eligible = body.excludeFunded ? count.unfunded : count.all
    if (eligible < body.projectCount) {
      throw new ApiError(409, 'not_enough_projects', `only ${eligible} projects are accepting payments right now`)
    }
    const row = await createSprinkle(c.env, c.var.db, {
      amountSats: body.amountSats,
      sharesSats: Array<number>(body.projectCount).fill(perProjectSats),
      excludeFunded: body.excludeFunded,
      supporterName: body.supporterName,
      comment: body.comment,
      description: `${c.env.SITE_NAME} · sprinkle to ${body.projectCount} projects`,
    })
    return c.json((await toSprinkle(c.var.db, row)) satisfies CreateSprinkleResponse, 201)
  })

  .get('/:id', rateLimit('RL_POLL', 'sprinkle-poll'), async (c) => {
    const row = await c.var.db.query.sprinkles.findFirst({ where: eq(sprinkles.id, c.req.param('id')) })
    if (!row) throw notFound('sprinkle')
    c.header('cache-control', 'no-store')
    return c.json((await toSprinkle(c.var.db, row)) satisfies GetSprinkleResponse)
  })
