import { writeLimit } from '../lib/ratelimit'
import type {
  CoverContentType,
  CreateProjectResponse,
  GetProjectResponse,
  ListSupportersResponse,
  ProjectStatsResponse,
  ProjectStatus,
  StatsRange,
  SupporterFilter,
  UpdateProjectResponse,
  UploadCoverResponse,
  UploadImageResponse,
} from '@nampu/types'
import { LIMITS, PROJECT_CATEGORIES, STATS_BUCKETS, STATS_RANGES } from '@nampu/types'
import { and, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import type { Context } from 'hono'
import * as v from 'valibot'
import { type AppEnv, publicOrigin } from '../context'
import { isUniqueViolation } from '../db/errors'
import { type ProjectRow, projects } from '../db/schema'
import { ApiError, notFound } from '../lib/errors'
import { pageLimit, supporterPage, supporterRows } from '../lib/supporters'
import { msatToSats, newId } from '../lib/util'
import { bodySchema, goalSchema, json, slugSchema, summarySchema, titleSchema } from '../lib/validate'
import { requireCreator, requireOnboarded } from '../middleware'
import { coverUrl, toProject } from '../serialize'

const milestonesSchema = v.pipe(
  v.array(
    v.object({
      sats: v.pipe(v.number(), v.safeInteger(), v.minValue(1), v.maxValue(LIMITS.goalSats.max)),
      label: v.pipe(v.string(), v.trim(), v.minLength(LIMITS.milestones.label.min), v.maxLength(LIMITS.milestones.label.max)),
    }),
  ),
  v.maxLength(LIMITS.milestones.max),
  v.check((ms) => ms.every((m, i) => i === 0 || m.sats > ms[i - 1]!.sats), 'milestones must be strictly ascending by sats'),
)
const categorySchema = v.nullable(v.picklist(PROJECT_CATEGORIES))
const endsAtSchema = v.nullable(v.pipe(v.number(), v.safeInteger(), v.minValue(0)))

const createBody = v.object({
  slug: slugSchema,
  title: titleSchema,
  summary: v.optional(summarySchema),
  body: v.optional(bodySchema),
  category: v.optional(categorySchema),
  goalSats: v.optional(goalSchema),
  milestones: v.optional(milestonesSchema),
  endsAt: v.optional(endsAtSchema),
})

const updateBody = v.object({
  slug: v.optional(slugSchema),
  title: v.optional(titleSchema),
  summary: v.optional(summarySchema),
  body: v.optional(bodySchema),
  category: v.optional(categorySchema),
  goalSats: v.optional(goalSchema),
  milestones: v.optional(milestonesSchema),
  endsAt: v.optional(endsAtSchema),
  status: v.optional(v.picklist(['draft', 'active', 'closed'])),
})

const TRANSITIONS: Record<ProjectStatus, readonly ProjectStatus[]> = {
  draft: ['active'],
  active: ['closed'],
  closed: ['active'],
}

const IMAGE_EXT: Record<CoverContentType, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

const DAY_MS = 86_400_000

const endsAtInPast = () =>
  new ApiError(422, 'validation_failed', 'end date must be in the future', [{ path: 'endsAt', message: 'must be in the future' }])

async function ownProject(c: Context<AppEnv>): Promise<ProjectRow> {
  const row = await c.var.db.query.projects.findFirst({
    where: and(eq(projects.id, c.req.param('id') ?? ''), eq(projects.creatorId, c.var.creator.id)),
  })
  if (!row) throw notFound('project')
  return row
}

const respond = (c: Context<AppEnv>, row: ProjectRow) => toProject(row, c.var.creator, publicOrigin(c.env, c.req.url))

/** Validates an image upload and streams it into R2 under `prefix/<projectId>/`. */
async function putImage(c: Context<AppEnv>, prefix: 'covers' | 'images', projectId: string) {
  const type = (c.req.header('content-type') ?? '').split(';')[0]!.trim().toLowerCase() as CoverContentType
  const ext = IMAGE_EXT[type]
  if (!ext) throw new ApiError(415, 'unsupported_media_type', `image must be one of ${LIMITS.cover.types.join(', ')}`)
  const length = Number(c.req.header('content-length'))
  if (!Number.isSafeInteger(length) || length <= 0) throw new ApiError(411, 'bad_request', 'Content-Length is required')
  if (length > LIMITS.cover.maxBytes) throw new ApiError(413, 'payload_too_large', `image must be ≤ ${LIMITS.cover.maxBytes} bytes`)
  if (!c.req.raw.body) throw new ApiError(400, 'bad_request', 'empty body')
  const key = `${prefix}/${projectId}/${newId(12)}.${ext}`
  // Raw body streamed straight into R2 (no buffering, negligible CPU).
  await c.env.MEDIA.put(key, c.req.raw.body, {
    httpMetadata: { contentType: type, cacheControl: 'public, max-age=31536000, immutable' },
  })
  return key
}

/** Window for a stats range. `tz` = minutes east of UTC. */
function statsWindow(range: StatsRange, tz: number, project: ProjectRow, now: number) {
  let from: number
  if (range === 'today') {
    const offset = tz * 60_000
    from = Math.floor((now + offset) / DAY_MS) * DAY_MS - offset
  } else if (range === '7d') from = now - 7 * DAY_MS
  else if (range === '30d') from = now - 30 * DAY_MS
  else from = project.publishedAt ?? project.createdAt // invoices only exist after publishing
  const span = Math.max(now - from, STATS_BUCKETS) // avoid a zero-width window
  return { from, to: from + span, span, prevFrom: range === 'all' ? null : from - span }
}

function csvCell(value: string | number | null): string {
  let s = value === null ? '' : String(value)
  // Neutralize spreadsheet formulas (CSV injection).
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export const projectRoutes = new Hono<AppEnv>()
  .use(requireCreator, requireOnboarded)

  .post('/', writeLimit, json(createBody), async (c) => {
    const body = c.req.valid('json')
    const now = Date.now()
    if (body.endsAt != null && body.endsAt <= now) throw endsAtInPast()
    try {
      const [row] = await c.var.db
        .insert(projects)
        .values({
          id: newId(),
          creatorId: c.var.creator.id,
          slug: body.slug,
          title: body.title,
          summary: body.summary ?? '',
          body: body.body ?? '',
          category: body.category ?? null,
          goalSats: body.goalSats ?? null,
          milestones: body.milestones ?? [],
          endsAt: body.endsAt ?? null,
          createdAt: now,
          updatedAt: now,
        })
        .returning()
      return c.json(respond(c, row!) satisfies CreateProjectResponse, 201)
    } catch (e) {
      if (isUniqueViolation(e)) throw new ApiError(409, 'conflict', 'slug is taken')
      throw e
    }
  })

  .get('/:id', async (c) => c.json(respond(c, await ownProject(c)) satisfies GetProjectResponse))

  .patch('/:id', writeLimit, json(updateBody), async (c) => {
    const body = c.req.valid('json')
    const current = await ownProject(c)
    const now = Date.now()
    const patch: Partial<typeof projects.$inferInsert> = { updatedAt: now }

    if (body.title !== undefined) patch.title = body.title
    if (body.summary !== undefined) patch.summary = body.summary
    if (body.body !== undefined) patch.body = body.body
    if (body.category !== undefined) patch.category = body.category
    if (body.milestones !== undefined) patch.milestones = body.milestones
    if (body.endsAt !== undefined) {
      if (body.endsAt !== null && body.endsAt <= now) throw endsAtInPast()
      patch.endsAt = body.endsAt
    }
    if (body.goalSats !== undefined) {
      // Once published, supporters have seen the goal; it can't drop below what's raised.
      if (body.goalSats !== null && current.status !== 'draft' && body.goalSats * 1000 < current.raisedMsat) {
        throw new ApiError(
          409,
          'goal_below_raised',
          `goal can't be lower than what's already raised (${msatToSats(current.raisedMsat)} sats)`,
        )
      }
      patch.goalSats = body.goalSats
    }
    if (body.slug !== undefined && body.slug !== current.slug) {
      // Published URLs (and their OG cards) must stay stable.
      if (current.status !== 'draft') throw new ApiError(409, 'conflict', 'slug can only change while the project is a draft')
      patch.slug = body.slug
    }
    if (body.status !== undefined && body.status !== current.status) {
      if (!TRANSITIONS[current.status].includes(body.status)) {
        throw new ApiError(409, 'conflict', `cannot change status from ${current.status} to ${body.status}`)
      }
      if (body.status === 'active') {
        if (!c.var.creator.lightningAddress) {
          throw new ApiError(409, 'lightning_address_missing', 'set a Lightning Address before publishing')
        }
        const endsAt = patch.endsAt !== undefined ? patch.endsAt : current.endsAt
        if (endsAt != null && endsAt <= now) throw endsAtInPast()
      }
      patch.status = body.status
      if (body.status === 'active' && current.publishedAt === null) patch.publishedAt = now
    }

    try {
      const [row] = await c.var.db.update(projects).set(patch).where(eq(projects.id, current.id)).returning()
      return c.json(respond(c, row!) satisfies UpdateProjectResponse)
    } catch (e) {
      if (isUniqueViolation(e)) throw new ApiError(409, 'conflict', 'slug is taken')
      throw e
    }
  })

  // ─── Media ──────────────────────────────────────────────────────────────────

  .put('/:id/cover', writeLimit, async (c) => {
    const current = await ownProject(c)
    const key = await putImage(c, 'covers', current.id)
    const [row] = await c.var.db
      .update(projects)
      .set({ coverKey: key, updatedAt: Date.now() })
      .where(eq(projects.id, current.id))
      .returning()
    if (current.coverKey) c.executionCtx.waitUntil(c.env.MEDIA.delete(current.coverKey))
    return c.json(respond(c, row!) satisfies UploadCoverResponse)
  })

  .delete('/:id/cover', async (c) => {
    const current = await ownProject(c)
    const [row] = await c.var.db
      .update(projects)
      .set({ coverKey: null, updatedAt: Date.now() })
      .where(eq(projects.id, current.id))
      .returning()
    if (current.coverKey) c.executionCtx.waitUntil(c.env.MEDIA.delete(current.coverKey))
    return c.json(respond(c, row!) satisfies UploadCoverResponse)
  })

  // Inline story images; never deleted automatically (old story revisions may still link them).
  .post('/:id/images', writeLimit, async (c) => {
    const current = await ownProject(c)
    const key = await putImage(c, 'images', current.id)
    return c.json({ url: coverUrl(publicOrigin(c.env, c.req.url), key)! } satisfies UploadImageResponse, 201)
  })

  // ─── Analytics ──────────────────────────────────────────────────────────────

  .get('/:id/stats', async (c) => {
    const project = await ownProject(c)
    const range = (c.req.query('range') ?? '7d') as StatsRange
    if (!STATS_RANGES.includes(range)) throw new ApiError(400, 'bad_request', `range must be one of ${STATS_RANGES.join(', ')}`)
    const tz = Math.min(Math.max(Math.trunc(Number(c.req.query('tz')) || 0), -840), 840)
    const now = Date.now()
    const { from, to, span, prevFrom } = statsWindow(range, tz, project, now)

    // One pass over the (project_id, status, paid_at) index: bucket -1 is the previous window.
    const [buckets, anon] = await c.env.DB.batch<{ b: number; msat: number; n: number; anon: number }>([
      c.env.DB.prepare(
        `SELECT CASE WHEN paid_at < ?1 THEN -1 ELSE MIN(?4 - 1, CAST((paid_at - ?1) * ?4 / ?2 AS INTEGER)) END AS b,
                SUM(amount_msat) AS msat, COUNT(*) AS n, SUM(supporter_name IS NULL) AS anon
           FROM invoices
          WHERE project_id = ?3 AND status = 'paid' AND paid_at >= ?5 AND paid_at <= ?6
          GROUP BY b`,
      ).bind(from, span, project.id, STATS_BUCKETS, prevFrom ?? from, to),
      c.env.DB.prepare(
        `SELECT 0 AS b, 0 AS msat, 0 AS n, COUNT(*) AS anon FROM invoices
          WHERE project_id = ?1 AND status = 'paid' AND supporter_name IS NULL`,
      ).bind(project.id),
    ])

    const series = Array.from({ length: STATS_BUCKETS }, (_, i) => ({
      from: from + Math.floor((i * span) / STATS_BUCKETS),
      sats: 0,
      backers: 0,
    }))
    let totalMsat = 0
    let backers = 0
    let anonymous = 0
    let prev = { msat: 0, n: 0 }
    for (const r of buckets!.results) {
      if (r.b < 0) {
        prev = { msat: r.msat, n: r.n }
        continue
      }
      const slot = series[r.b]!
      slot.sats = msatToSats(r.msat)
      slot.backers = r.n
      totalMsat += r.msat
      backers += r.n
      anonymous += r.anon
    }

    return c.json({
      range,
      from,
      to,
      totalSats: msatToSats(totalMsat),
      backers,
      anonymous,
      avgSats: backers ? Math.floor(msatToSats(totalMsat) / backers) : 0,
      previous: prevFrom === null ? null : { totalSats: msatToSats(prev.msat), backers: prev.n },
      buckets: series,
      allTime: {
        raisedSats: msatToSats(project.raisedMsat),
        backers: project.supporterCount,
        anonymous: anon!.results[0]?.anon ?? 0,
        goalSats: project.goalSats,
      },
    } satisfies ProjectStatsResponse)
  })

  .get('/:id/supporters', async (c) => {
    const project = await ownProject(c)
    const filter = c.req.query('filter') === 'message' ? 'message' : ('all' satisfies SupporterFilter)
    const query = { q: c.req.query('q'), filter } as const

    if (c.req.query('format') === 'csv') {
      const rows = await supporterRows(c.var.db, project.id, query, undefined, LIMITS.supportersCsv.max)
      const lines = ['paid_at,name,amount_sats,comment']
      for (const r of rows) {
        lines.push(
          [new Date(r.paidAt ?? 0).toISOString(), r.supporterName, msatToSats(r.amountMsat), r.comment].map(csvCell).join(','),
        )
      }
      return c.body(lines.join('\r\n') + '\r\n', 200, {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="${project.slug}-supporters.csv"`,
        'cache-control': 'no-store',
      })
    }

    c.header('cache-control', 'no-store')
    return c.json(
      (await supporterPage(c.var.db, project.id, query, c.req.query('cursor'), pageLimit(c.req.query('limit')))) satisfies ListSupportersResponse,
    )
  })
