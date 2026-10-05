import type { Sprinkle } from '@nampu/types'
import { and, asc, eq, gt, isNotNull, isNull, lt, notInArray, or, sql } from 'drizzle-orm'
import type { Db } from '../context'
import { creators, projects, type SprinkleRow, sprinklePayouts } from '../db/schema'
import { type NwcConnection, parseNwcUrl } from '../lightning/nwc'
import { msatToSats } from './util'

/** Projects ending this soon aren't picked: the payout might land after the deadline. */
const ENDING_MARGIN_MS = 10 * 60_000

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
