import { createMiddleware } from 'hono/factory'
import type { AppEnv } from '../context'

/**
 * With PUBLIC_ORIGIN set, every other host (workers.dev, www.) redirects there, path and
 * query kept. Auth depends on it: the Nostr relay tag and LNURL callbacks are checked
 * against PUBLIC_ORIGIN, so logging in on another host would fail.
 */
export const canonicalHost = createMiddleware<AppEnv>(async (c, next) => {
  const origin = c.env.PUBLIC_ORIGIN
  if (origin) {
    const url = new URL(c.req.url)
    const target = new URL(origin)
    if (url.host !== target.host) {
      // 308 keeps the method and body for non-GET requests.
      const status = c.req.method === 'GET' || c.req.method === 'HEAD' ? 301 : 308
      return c.redirect(`${target.origin}${url.pathname}${url.search}`, status)
    }
  }
  await next()
})
