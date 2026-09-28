import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { AppEnv } from '../src/context'
import { ApiError } from '../src/lib/errors'
import { rateLimit } from '../src/lib/ratelimit'

/** In-memory stand-in for the Workers RateLimit binding. */
function fakeLimiter(limit: number) {
  const counts = new Map<string, number>()
  const keys: string[] = []
  return {
    keys,
    limit: async ({ key }: { key: string }) => {
      keys.push(key)
      const n = (counts.get(key) ?? 0) + 1
      counts.set(key, n)
      return { success: n <= limit }
    },
  }
}

function app(limiter: ReturnType<typeof fakeLimiter> | undefined) {
  const a = new Hono<AppEnv>()
  a.onError((err, c) => (err instanceof ApiError ? c.json(err.toBody(), err.status) : c.text('boom', 500)))
  a.post('/x', rateLimit('RL_INVOICE', 'invoice'), (c) => c.text('ok'))
  const env = { RL_INVOICE: limiter } as unknown as Env
  return (ip?: string) => a.request('/x', { method: 'POST', headers: ip ? { 'cf-connecting-ip': ip } : {} }, env)
}

describe('rateLimit', () => {
  it('allows up to the limit, then answers 429 with Retry-After and the ApiError body', async () => {
    const lim = fakeLimiter(2)
    const call = app(lim)
    expect((await call('1.1.1.1')).status).toBe(200)
    expect((await call('1.1.1.1')).status).toBe(200)
    const res = await call('1.1.1.1')
    expect(res.status).toBe(429)
    expect(res.headers.get('retry-after')).toBe('60')
    expect(await res.json()).toMatchObject({ error: { code: 'rate_limited' } })
  })

  it('keys by client IP and scope', async () => {
    const lim = fakeLimiter(1)
    const call = app(lim)
    expect((await call('1.1.1.1')).status).toBe(200)
    expect((await call('2.2.2.2')).status).toBe(200)
    expect((await call()).status).toBe(200)
    expect(lim.keys).toEqual(['invoice:1.1.1.1', 'invoice:2.2.2.2', 'invoice:local'])
  })

  it('is a no-op when the binding is missing', async () => {
    expect((await app(undefined)()).status).toBe(200)
  })
})
