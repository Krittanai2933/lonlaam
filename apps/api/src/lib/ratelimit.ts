import type { Context } from 'hono'
import { createMiddleware } from 'hono/factory'
import type { AppEnv } from '../context'
import { ApiError } from './errors'

/** Rate limiter bindings declared in wrangler.jsonc (all use a 60s period). */
export type LimiterName = 'RL_INVOICE' | 'RL_AUTH' | 'RL_POLL' | 'RL_WRITE'

const PERIOD_S = 60

/** Client IP as seen by Cloudflare; a fixed key locally where the header is absent. */
export const clientIp = (c: Context<AppEnv>) => c.req.header('cf-connecting-ip') ?? 'local'

/**
 * Workers Rate Limiting binding (Free plan, no subrequest, ~no CPU). Counters are per
 * Cloudflare location and eventually consistent — meant to stop abuse, not to meter.
 * `key` is namespaced with `scope` so several routes can share one binding's budget.
 */
export const rateLimit = (name: LimiterName, scope: string, key: (c: Context<AppEnv>) => string = clientIp) =>
  createMiddleware<AppEnv>(async (c, next) => {
    const limiter = c.env[name]
    if (limiter) {
      const { success } = await limiter.limit({ key: `${scope}:${key(c)}` })
      if (!success) {
        c.header('retry-after', String(PERIOD_S))
        throw new ApiError(429, 'rate_limited', 'too many requests, please try again in a minute')
      }
    }
    await next()
  })

/** Authenticated writes, keyed by creator (run after requireCreator). Covers the LN address probe. */
export const writeLimit = rateLimit('RL_WRITE', 'write', (c) => c.var.creator.id)
