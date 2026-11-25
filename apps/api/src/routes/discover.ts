import type { ListProjectsResponse, ProjectSummary } from '@nampu/types'
import { type SQL, and, asc, desc, eq, gt, isNull, or, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { type AppEnv, mediaBase } from '../context'
import { creators, invoices, projects } from '../db/schema'
import { encodeOffsetCursor, MAX_OFFSET, parseDiscoverQuery, WEEK_MS } from '../lib/discover'
import { likePattern } from '../lib/supporters'
import { msatToSats } from '../lib/util'
import { toPublicProject } from '../serialize'

/** Public project listing for Discover. Mounted before the owner routes, so no auth. */
export const discoverRoutes = new Hono<AppEnv>().get('/', async (c) => {
  const query = parseDiscoverQuery(c.req.query())
  const now = Date.now()

  // Per-project correlated sum; served by the (project_id, status, paid_at) index.
  const weekMsat = sql<number>`coalesce((
    select sum(${invoices.amountMsat}) from ${invoices}
    where ${invoices.projectId} = ${projects.id} and ${invoices.status} = 'paid' and ${invoices.paidAt} > ${now - WEEK_MS}
  ), 0)`.mapWith(Number)

  const conds: (SQL | undefined)[] = [eq(projects.status, 'active'), or(isNull(projects.endsAt), gt(projects.endsAt, now))]
  if (query.category) conds.push(eq(projects.category, query.category))
  if (query.q) {
    const pattern = likePattern(query.q)
    conds.push(sql`(${projects.title} LIKE ${pattern} ESCAPE '\\' OR ${projects.summary} LIKE ${pattern} ESCAPE '\\')`)
  }

  const order: SQL[] = {
    trending: [desc(weekMsat), desc(projects.raisedMsat)],
    new: [desc(projects.publishedAt)],
    ending: [sql`${projects.endsAt} is null`, asc(projects.endsAt)],
    funded: [sql`${projects.goalSats} is null`, desc(sql`cast(${projects.raisedMsat} as real) / (${projects.goalSats} * 1000)`)],
  }[query.sort]

  const rows = await c.var.db
    .select({
      project: projects,
      weekMsat,
      creator: { handle: creators.handle, displayName: creators.displayName, npub: creators.npub },
    })
    .from(projects)
    .innerJoin(creators, eq(creators.id, projects.creatorId))
    .where(and(...conds))
    .orderBy(...order, asc(projects.id))
    .limit(query.limit + 1)
    .offset(query.offset)

  const media = mediaBase(c.env, c.req.url)
  const page = rows.slice(0, query.limit)
  const out: ProjectSummary[] = page.map((r) => {
    const { body: _body, translation: t, rewards: _rewards, ...rest } = toPublicProject(r.project, r.creator, media, undefined)
    return { ...rest, translation: t && { lang: t.lang, title: t.title, summary: t.summary }, weekSats: msatToSats(r.weekMsat) }
  })
  c.header('cache-control', 'public, max-age=30')
  return c.json({
    projects: out,
    nextCursor: rows.length > query.limit && query.offset + query.limit <= MAX_OFFSET ? encodeOffsetCursor(query.offset + query.limit) : null,
  } satisfies ListProjectsResponse)
})
