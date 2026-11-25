import type { SupporterFilter } from '@nampu/types'
import { LIMITS } from '@nampu/types'
import { type SQL, and, desc, eq, isNotNull, lt, ne, or, sql } from 'drizzle-orm'
import type { Db } from '../context'
import { invoices } from '../db/schema'

// Cursor = "<paidAt>.<invoiceId>" of the last item on the previous page.
const encodeCursor = (paidAt: number, id: string) => `${paidAt}.${id}`
function decodeCursor(raw: string | undefined): { paidAt: number; id: string } | null {
  const m = raw ? /^(\d{1,16})\.([0-9a-z]{1,40})$/.exec(raw) : null
  return m ? { paidAt: Number(m[1]), id: m[2]! } : null
}

/** `%q%` for LIKE … ESCAPE '\\', with the user's own %, _ and \\ escaped. */
export const likePattern = (q: string) => `%${q.replace(/[\\%_]/g, '\\$&')}%`

export const pageLimit = (raw: string | undefined) =>
  Math.min(Math.max(Number(raw) || LIMITS.supportersPage.default, 1), LIMITS.supportersPage.max)

export interface SupporterQuery {
  q?: string | undefined
  filter?: SupporterFilter | undefined
}

/** Paid invoices of a project, newest first, optionally searched/filtered. */
export function supporterRows(db: Db, projectId: string, query: SupporterQuery, cursorRaw: string | undefined, limit: number) {
  const cursor = decodeCursor(cursorRaw)
  const conds: (SQL | undefined)[] = [eq(invoices.projectId, projectId), eq(invoices.status, 'paid')]
  if (cursor) {
    conds.push(or(lt(invoices.paidAt, cursor.paidAt), and(eq(invoices.paidAt, cursor.paidAt), lt(invoices.id, cursor.id))))
  }
  const q = query.q?.trim().slice(0, 100)
  if (q) {
    const pattern = likePattern(q)
    conds.push(sql`(${invoices.supporterName} LIKE ${pattern} ESCAPE '\\' OR ${invoices.comment} LIKE ${pattern} ESCAPE '\\')`)
  }
  if (query.filter === 'message') conds.push(and(isNotNull(invoices.comment), ne(invoices.comment, '')))
  if (query.filter === 'reward') conds.push(isNotNull(invoices.rewardId))
  return db
    .select({
      id: invoices.id,
      supporterName: invoices.supporterName,
      supporterPubkey: invoices.supporterPubkey,
      comment: invoices.comment,
      amountMsat: invoices.amountMsat,
      paidAt: invoices.paidAt,
      rewardId: invoices.rewardId,
      rewardTitle: invoices.rewardTitle,
      contact: invoices.contact,
      rewardSentAt: invoices.rewardSentAt,
    })
    .from(invoices)
    .where(and(...conds))
    .orderBy(desc(invoices.paidAt), desc(invoices.id))
    .limit(limit)
}

export type SupporterRow = Awaited<ReturnType<typeof supporterRows>>[number]

/** `serialize` decides what is exposed: toSupporter for public routes, toOwnerSupporter for the creator. */
export async function supporterPage<T>(
  db: Db,
  projectId: string,
  query: SupporterQuery,
  cursorRaw: string | undefined,
  limit: number,
  serialize: (r: SupporterRow) => T,
): Promise<{ supporters: T[]; nextCursor: string | null }> {
  const rows = await supporterRows(db, projectId, query, cursorRaw, limit + 1)
  const page = rows.slice(0, limit)
  const last = page.at(-1)
  return {
    supporters: page.map(serialize),
    nextCursor: rows.length > limit && last ? encodeCursor(last.paidAt ?? 0, last.id) : null,
  }
}
