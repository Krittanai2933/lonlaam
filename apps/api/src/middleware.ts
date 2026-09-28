import { eq } from 'drizzle-orm'
import { createMiddleware } from 'hono/factory'
import type { AppEnv } from './context'
import { creators, sessions } from './db/schema'
import { ApiError } from './lib/errors'
import { sha256Hex } from './lib/util'

export const requireCreator = createMiddleware<AppEnv>(async (c, next) => {
  const m = /^Bearer\s+(np_[A-Za-z0-9_-]{43})$/.exec(c.req.header('authorization') ?? '')
  if (!m) throw new ApiError(401, 'unauthorized', 'missing or malformed bearer token')
  const hash = await sha256Hex(m[1]!)
  const [row] = await c.var.db
    .select({ creator: creators, expiresAt: sessions.expiresAt })
    .from(sessions)
    .innerJoin(creators, eq(creators.id, sessions.creatorId))
    .where(eq(sessions.tokenHash, hash))
    .limit(1)
  if (!row || row.expiresAt <= Date.now()) throw new ApiError(401, 'unauthorized', 'invalid or expired session')
  c.set('creator', row.creator)
  c.set('sessionHash', hash)
  await next()
})

/** Must run after requireCreator. */
export const requireOnboarded = createMiddleware<AppEnv>(async (c, next) => {
  if (!c.var.creator.handle || !c.var.creator.displayName) {
    throw new ApiError(403, 'onboarding_required', 'set a handle and display name first')
  }
  await next()
})
