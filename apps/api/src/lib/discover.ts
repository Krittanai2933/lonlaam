import type { DiscoverSort, ProjectCategory } from '@nampu/types'
import { DISCOVER_SORTS, PROJECT_CATEGORIES } from '@nampu/types'
import { ApiError } from './errors'

export const DISCOVER_LIMIT = { default: 12, max: 48 } as const
export const LEADERBOARD_LIMIT = { default: 5, max: 20 } as const
/** Offset paging stops here; deeper pages aren't useful for discovery and cost D1 reads. */
export const MAX_OFFSET = 1000
export const WEEK_MS = 7 * 86_400_000

// Opaque cursor = base36 offset of the next page.
export const encodeOffsetCursor = (offset: number) => offset.toString(36)

export function decodeOffsetCursor(raw: string | undefined): number {
  if (!raw) return 0
  if (!/^[0-9a-z]{1,4}$/.test(raw)) throw new ApiError(400, 'bad_request', 'invalid cursor')
  const n = parseInt(raw, 36)
  if (n > MAX_OFFSET) throw new ApiError(400, 'bad_request', 'invalid cursor')
  return n
}

export const clampLimit = (raw: string | undefined, l: { default: number; max: number }) =>
  Math.min(Math.max(Math.floor(Number(raw)) || l.default, 1), l.max)

export interface DiscoverQuery {
  category: ProjectCategory | null
  sort: DiscoverSort
  q: string
  limit: number
  offset: number
}

export function parseDiscoverQuery(query: Record<string, string | undefined>): DiscoverQuery {
  const category = query.category || null
  if (category !== null && !(PROJECT_CATEGORIES as readonly string[]).includes(category)) {
    throw new ApiError(422, 'validation_failed', 'invalid category', [{ path: 'category', message: `one of ${PROJECT_CATEGORIES.join(', ')}` }])
  }
  const sort = query.sort || 'trending'
  if (!(DISCOVER_SORTS as readonly string[]).includes(sort)) {
    throw new ApiError(422, 'validation_failed', 'invalid sort', [{ path: 'sort', message: `one of ${DISCOVER_SORTS.join(', ')}` }])
  }
  return {
    category: category as ProjectCategory | null,
    sort: sort as DiscoverSort,
    q: (query.q ?? '').trim().slice(0, 100),
    limit: clampLimit(query.limit, DISCOVER_LIMIT),
    offset: decodeOffsetCursor(query.cursor),
  }
}
