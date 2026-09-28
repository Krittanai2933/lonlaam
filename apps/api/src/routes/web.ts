import { Hono } from 'hono'
import { type AppEnv, mediaBase, publicOrigin } from '../context'
import { coverUrl } from '../serialize'
import { findPublicProject } from './public'

/** Non-API routes: R2 media and the SEO shell for /p/:slug. */
export const webRoutes = new Hono<AppEnv>()

  // Media keys are random and never reused, so responses are immutable. With MEDIA_ORIGIN
  // set, new URLs point at the R2 public domain; this route keeps older links working.
  .get('/media/:key{.+}', async (c) => {
    const key = c.req.param('key')
    if (!key.startsWith('covers/') && !key.startsWith('images/')) return c.notFound()
    const obj = await c.env.MEDIA.get(key, { onlyIf: c.req.raw.headers, range: c.req.raw.headers })
    if (!obj) return c.notFound()
    const headers = new Headers()
    obj.writeHttpMetadata(headers)
    headers.set('etag', obj.httpEtag)
    headers.set('x-content-type-options', 'nosniff')
    headers.set('content-security-policy', "default-src 'none'")
    if (!('body' in obj)) return new Response(null, { status: 304, headers })
    // R2 reports a range even for full reads, so only answer 206 to an actual Range request.
    if (c.req.header('range') && obj.range && 'offset' in obj.range) {
      const offset = obj.range.offset ?? 0
      const length = obj.range.length ?? obj.size - offset
      headers.set('content-range', `bytes ${offset}-${offset + length - 1}/${obj.size}`)
      return new Response(obj.body, { status: 206, headers })
    }
    return new Response(obj.body, { headers })
  })

  // Serve the SPA's index.html with per-project <title>/meta/OG tags injected by
  // HTMLRewriter (streaming, no DOM parse, so negligible CPU).
  .get('/p/:slug', async (c) => {
    const origin = publicOrigin(c.env, c.req.url)
    const [shell, found] = await Promise.all([
      // "/" rather than "/index.html": the latter redirects under default html_handling.
      c.env.ASSETS.fetch(new URL('/', c.req.url)),
      findPublicProject(c.var.db, c.req.param('slug')),
    ])
    if (!shell.ok) return shell

    const site = c.env.SITE_NAME
    const url = `${origin}/p/${encodeURIComponent(c.req.param('slug').toLowerCase())}`
    let title: string
    let tags: [attr: 'name' | 'property', key: string, value: string][]
    if (found) {
      const { project, creator } = found
      const image = coverUrl(mediaBase(c.env, c.req.url), project.coverKey)
      title = `${project.title} · ${site}`
      const description = project.summary || `Support ${creator.displayName} on ${site}`
      tags = [
        ['name', 'description', description],
        ['property', 'og:type', 'website'],
        ['property', 'og:site_name', site],
        ['property', 'og:title', project.title],
        ['property', 'og:description', description],
        ['property', 'og:url', url],
        ['name', 'twitter:card', image ? 'summary_large_image' : 'summary'],
        ['name', 'twitter:title', project.title],
        ['name', 'twitter:description', description],
      ]
      if (image) tags.push(['property', 'og:image', image], ['name', 'twitter:image', image])
    } else {
      title = `Not found · ${site}`
      tags = [['name', 'robots', 'noindex']]
    }

    const head =
      tags.map(([attr, key, value]) => `<meta ${attr}="${key}" content="${esc(value)}">`).join('') +
      (found ? `<link rel="canonical" href="${esc(url)}">` : '')

    const res = new HTMLRewriter()
      .on('head > title', { element: (el) => void el.remove() })
      .on('head > meta[name="description"]', { element: (el) => void el.remove() })
      .on('head', {
        element: (el) => void el.append(`<title>${esc(title)}</title>${head}`, { html: true }),
      })
      .transform(shell)

    const headers = new Headers(res.headers)
    headers.set('content-type', 'text/html; charset=utf-8')
    headers.set('cache-control', 'public, max-age=60')
    headers.delete('etag')
    return new Response(res.body, { status: found ? 200 : 404, headers })
  })

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`)
}
