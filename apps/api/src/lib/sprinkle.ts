import type { Sprinkle } from '@nampu/types'
import { and, asc, eq, gt, isNotNull, isNull, lt, notInArray, or, sql } from 'drizzle-orm'
import type { Db } from '../context'
import { isUniqueViolation } from '../db/errors'
import { creators, projects, type SprinkleRow, sprinklePayouts, sprinkles } from '../db/schema'
import { type NwcConnection, NwcError, NwcWallet, parseNwcUrl } from '../lightning/nwc'
import { ApiError } from './errors'
import { msatToSats, newId } from './util'

/** Projects ending this soon aren't picked: the payout might land after the deadline. */
const ENDING_MARGIN_MS = 10 * 60_000
/** How long the supporter has to pay the platform wallet's invoice. */
const INVOICE_EXPIRY_S = 600

export const sprinkleUnavailable = () => new ApiError(503, 'sprinkle_unavailable', 'random sprinkles are not available right now')

export function nwcConnection(env: Env): NwcConnection | null {
  if (!env.NWC_URL) return null
  try {
    return parseNwcUrl(env.NWC_URL)
  } catch (e) {
    console.error('NWC_URL is invalid', e instanceof Error ? e.message : e)
    return null
  }
}

/** Active, not about to end, and the creator can receive (has a Lightning Address). */
const eligible = (now: number) =>
  and(
    eq(projects.status, 'active'),
    or(isNull(projects.endsAt), gt(projects.endsAt, now + ENDING_MARGIN_MS)),
    isNotNull(creators.lightningAddress),
  )

/** Still short of its goal; a project without a goal never counts as funded. */
const unfunded = or(isNull(projects.goalSats), lt(projects.raisedMsat, sql`${projects.goalSats} * 1000`))

export async function countEligible(db: Db): Promise<{ all: number; unfunded: number }> {
  const [row] = await db
    .select({ all: sql<number>`count(*)`, unfunded: sql<number>`coalesce(sum(case when ${unfunded} then 1 else 0 end), 0)` })
    .from(projects)
    .innerJoin(creators, eq(creators.id, projects.creatorId))
    .where(eligible(Date.now()))
  return { all: row?.all ?? 0, unfunded: row?.unfunded ?? 0 }
}

/** Uniform random sample of eligible projects, skipping ones this sprinkle already tried. */
export async function pickProjects(db: Db, n: number, exclude: string[], excludeFunded: boolean): Promise<string[]> {
  if (n <= 0) return []
  const rows = await db
    .select({ id: projects.id })
    .from(projects)
    .innerJoin(creators, eq(creators.id, projects.creatorId))
    .where(and(eligible(Date.now()), excludeFunded ? unfunded : undefined, exclude.length ? notInArray(projects.id, exclude) : undefined))
    .orderBy(sql`random()`)
    .limit(n)
  return rows.map((r) => r.id)
}

/**
 * Makes the platform wallet's invoice (NWC make_invoice) and the pending sprinkle, and starts its
 * SprinkleRoom. `sharesSats` is what each picked project gets; their sum may be less than the
 * amount (fee reserve, the platform's share). Callers check there are enough eligible projects.
 */
export async function createSprinkle(
  env: Env,
  db: Db,
  input: { amountSats: number; sharesSats: number[]; excludeFunded: boolean; supporterName?: string | null; comment?: string | null; description: string },
): Promise<SprinkleRow> {
  const conn = nwcConnection(env)
  if (!conn) throw sprinkleUnavailable()
  const shares = input.sharesSats.map((s) => s * 1000)
  const even = shares.every((s) => s === shares[0])

  let invoice
  const wallet = new NwcWallet(conn)
  try {
    invoice = await (await wallet.client()).makeInvoice(input.amountSats * 1000, input.description, INVOICE_EXPIRY_S)
  } catch (e) {
    console.error('sprinkle: make_invoice failed', e instanceof NwcError ? `${e.code}: ${e.message}` : e)
    throw sprinkleUnavailable()
  } finally {
    wallet.close()
  }

  const now = Date.now()
  const id = newId()
  let row
  try {
    ;[row] = await db
      .insert(sprinkles)
      .values({
        id,
        amountMsat: input.amountSats * 1000,
        projectCount: shares.length,
        perProjectMsat: Math.floor(shares.reduce((a, b) => a + b, 0) / shares.length / 1000) * 1000,
        sharesMsat: even ? null : shares,
        excludeFunded: input.excludeFunded,
        supporterName: input.supporterName || null,
        comment: input.comment || null,
        bolt11: invoice.invoice,
        paymentHash: invoice.paymentHash,
        createdAt: now,
        expiresAt: invoice.expiresAt ?? now + INVOICE_EXPIRY_S * 1000,
      })
      .returning()
  } catch (e) {
    if (isUniqueViolation(e)) throw sprinkleUnavailable()
    throw e
  }
  await env.SPRINKLE_ROOM.get(env.SPRINKLE_ROOM.idFromName(id)).start(id)
  return row!
}

/** Each project's amount, in order. */
export const sprinkleShares = (s: SprinkleRow): number[] => s.sharesMsat ?? Array<number>(s.projectCount).fill(s.perProjectMsat)

/** Shares not yet covered by a live (not failed) payout, i.e. what still needs a project. */
export function missingShares(shares: number[], liveAmounts: number[]): number[] {
  const left = [...liveAmounts]
  return shares.filter((s) => {
    const i = left.indexOf(s)
    if (i === -1) return true
    left.splice(i, 1)
    return false
  })
}

export async function toSprinkle(db: Db, s: SprinkleRow): Promise<Sprinkle> {
  const payouts = await db
    .select({ slug: projects.slug, title: projects.title, amountMsat: sprinklePayouts.amountMsat, status: sprinklePayouts.status })
    .from(sprinklePayouts)
    .innerJoin(projects, eq(projects.id, sprinklePayouts.projectId))
    .where(eq(sprinklePayouts.sprinkleId, s.id))
    .orderBy(asc(sprinklePayouts.createdAt), asc(sprinklePayouts.id))
  return {
    id: s.id,
    amountSats: msatToSats(s.amountMsat),
    projectCount: s.projectCount,
    perProjectSats: msatToSats(s.perProjectMsat),
    excludeFunded: s.excludeFunded,
    bolt11: s.bolt11,
    status: s.status,
    createdAt: s.createdAt,
    expiresAt: s.expiresAt,
    paidAt: s.paidAt,
    payouts: payouts.map((p) => ({
      slug: p.slug,
      title: p.title,
      amountSats: msatToSats(p.amountMsat),
      // "paying" is an internal retry state; to the supporter it's still on its way.
      status: p.status === 'paying' ? 'pending' : p.status,
    })),
  }
}
