import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { AppEnv } from '../src/context'
import { canonicalHost } from '../src/lib/canonical'

function app(publicOrigin: string) {
  const a = new Hono<AppEnv>().use(canonicalHost).all('*', (c) => c.text('ok'))
  const env = { PUBLIC_ORIGIN: publicOrigin } as unknown as Env
  return (url: string, method = 'GET') => a.request(url, { method }, env)
}

describe('canonicalHost', () => {
  const call = app('https://lonlaam.com')

  it('serves the canonical host', async () => {
    const res = await call('https://lonlaam.com/p/x?a=1')
    expect(res.status).toBe(200)
  })

  it('301s www, the typo domain and workers.dev to the canonical origin, keeping path and query', async () => {
    for (const host of ['www.lonlaam.com', 'loalaam.com', 'www.loalaam.com', 'nampu.example.workers.dev']) {
      const res = await call(`https://${host}/p/chiangmai-library?ref=nostr`)
      expect(res.status).toBe(301)
      expect(res.headers.get('location')).toBe('https://lonlaam.com/p/chiangmai-library?ref=nostr')
    }
  })

  it('uses 308 for non-GET so the method and body survive', async () => {
    const res = await call('https://www.lonlaam.com/api/auth/lnurl', 'POST')
    expect(res.status).toBe(308)
    expect(res.headers.get('location')).toBe('https://lonlaam.com/api/auth/lnurl')
  })

  it('does nothing when PUBLIC_ORIGIN is empty (local dev)', async () => {
    const res = await app('')('http://localhost:8787/api/health')
    expect(res.status).toBe(200)
  })
})
