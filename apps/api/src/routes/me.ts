import { writeLimit } from '../lib/ratelimit'
import type { GetMeResponse, ListMyProjectsResponse, UpdateCreatorResponse } from '@nampu/types'
import { desc, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import * as v from 'valibot'
import { type AppEnv, lnurlOptions, publicOrigin } from '../context'
import { isUniqueViolation } from '../db/errors'
import { creators, projects } from '../db/schema'
import { probeLightningAddress } from '../lightning/lnurl'
import { decodeNpub } from '../lib/bech32'
import { ApiError } from '../lib/errors'
import { displayNameSchema, handleSchema, json, lightningAddressSchema } from '../lib/validate'
import { requireCreator, requireOnboarded } from '../middleware'
import { toCreator, toProject } from '../serialize'

const updateCreatorBody = v.object({
  handle: v.optional(handleSchema),
  displayName: v.optional(displayNameSchema),
  lightningAddress: v.optional(v.nullable(lightningAddressSchema)),
  npub: v.optional(v.nullable(v.pipe(v.string(), v.trim(), v.maxLength(100)))),
})

export const meRoutes = new Hono<AppEnv>()
  .use(requireCreator)
  .get('/', (c) => c.json(toCreator(c.var.creator) satisfies GetMeResponse))

  .patch('/', writeLimit, json(updateCreatorBody), async (c) => {
    const body = c.req.valid('json')
    const me = c.var.creator
    const patch: Partial<typeof creators.$inferInsert> = { updatedAt: Date.now() }
    if (body.handle !== undefined) patch.handle = body.handle
    if (body.displayName !== undefined) patch.displayName = body.displayName

    // Onboarding sets both at once; neither may be left empty afterwards.
    const handleAfter = patch.handle ?? me.handle
    const nameAfter = patch.displayName ?? me.displayName
    if ((handleAfter === null) !== (nameAfter === null)) {
      throw new ApiError(422, 'validation_failed', 'handle and displayName are required together', [
        { path: handleAfter === null ? 'handle' : 'displayName', message: 'required' },
      ])
    }

    if (body.npub !== undefined) {
      if (body.npub === null || body.npub === '') patch.npub = null
      else if (decodeNpub(body.npub)) patch.npub = body.npub.toLowerCase()
      else throw new ApiError(422, 'validation_failed', 'invalid npub', [{ path: 'npub', message: 'expected npub1…' }])
    }

    if (body.lightningAddress !== undefined) {
      if (body.lightningAddress === null || body.lightningAddress === '') {
        const live = await c.var.db.query.projects.findFirst({
          columns: { id: true },
          where: (p, { and, eq }) => and(eq(p.creatorId, me.id), eq(p.status, 'active')),
        })
        if (live) throw new ApiError(409, 'conflict', 'close your active projects before removing the Lightning Address')
        patch.lightningAddress = null
      } else if (body.lightningAddress.toLowerCase() !== me.lightningAddress) {
        patch.lightningAddress = await probeLightningAddress(body.lightningAddress, lnurlOptions(c.env))
      }
    }

    try {
      const [row] = await c.var.db.update(creators).set(patch).where(eq(creators.id, me.id)).returning()
      return c.json(toCreator(row!) satisfies UpdateCreatorResponse)
    } catch (e) {
      if (isUniqueViolation(e)) throw new ApiError(409, 'conflict', 'handle is taken')
      throw e
    }
  })

  .get('/projects', requireOnboarded, async (c) => {
    const rows = await c.var.db
      .select()
      .from(projects)
      .where(eq(projects.creatorId, c.var.creator.id))
      .orderBy(desc(projects.createdAt))
      .limit(100)
    const origin = publicOrigin(c.env, c.req.url)
    return c.json({ projects: rows.map((r) => toProject(r, c.var.creator, origin)) } satisfies ListMyProjectsResponse)
  })
