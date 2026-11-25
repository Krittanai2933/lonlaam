import type { PublicReward, Reward } from '@nampu/types'
import { LIMITS } from '@nampu/types'
import { and, count, eq, gt, inArray, isNotNull, or } from 'drizzle-orm'
import * as v from 'valibot'
import type { Db } from '../context'
import { invoices } from '../db/schema'
import { ApiError } from './errors'

const R = LIMITS.rewards

/** Stored ascending by minSats (stable, so equal tiers keep the creator's order). */
export const rewardsSchema = v.pipe(
  v.array(
    v.object({
      id: v.pipe(v.string(), v.regex(new RegExp(R.id.pattern))),
      title: v.pipe(v.string(), v.trim(), v.minLength(R.title.min), v.maxLength(R.title.max)),
      description: v.pipe(v.string(), v.trim(), v.maxLength(R.description.max)),
      minSats: v.pipe(v.number(), v.safeInteger(), v.minValue(LIMITS.invoiceSats.min), v.maxValue(LIMITS.invoiceSats.max)),
      limit: v.nullable(v.pipe(v.number(), v.safeInteger(), v.minValue(R.limit.min), v.maxValue(R.limit.max))),
    }),
  ),
  v.maxLength(R.max),
  v.check((rs) => new Set(rs.map((r) => r.id)).size === rs.length, 'reward ids must be unique'),
  v.transform((rs): Reward[] => [...rs].sort((a, b) => a.minSats - b.minSats)),
)

/** Claims per reward: paid invoices plus unpaid ones that can still be paid, keyed by project then reward id. */
export async function rewardClaims(db: Db, projectIds: string[], now = Date.now()): Promise<Map<string, Map<string, number>>> {
  const out = new Map<string, Map<string, number>>()
  if (!projectIds.length) return out
  const rows = await db
    .select({ projectId: invoices.projectId, rewardId: invoices.rewardId, n: count() })
    .from(invoices)
    .where(
      and(
        inArray(invoices.projectId, projectIds),
        isNotNull(invoices.rewardId),
        or(eq(invoices.status, 'paid'), and(eq(invoices.status, 'pending'), gt(invoices.expiresAt, now))),
      ),
    )
    .groupBy(invoices.projectId, invoices.rewardId)
  for (const r of rows) {
    let m = out.get(r.projectId)
    if (!m) out.set(r.projectId, (m = new Map()))
    m.set(r.rewardId!, r.n)
  }
  return out
}

export const toPublicRewards = (rewards: Reward[], claims: Map<string, number> | undefined): PublicReward[] =>
  rewards.map((r) => ({ ...r, claimed: claims?.get(r.id) ?? 0 }))

/**
 * The reward a supporter asked for, checked against the project's current rewards. Claims are
 * counted before the invoice exists, so concurrent requests can oversell a limited reward by a
 * few; the creator sees every claim on the dashboard.
 */
export function chooseReward(
  rewards: Reward[],
  claims: Map<string, number> | undefined,
  input: { rewardId: string; amountSats: number; contact: string | undefined },
): Reward & { contact: string } {
  const reward = rewards.find((r) => r.id === input.rewardId)
  if (!reward) throw new ApiError(409, 'reward_unavailable', 'this reward is no longer offered')
  if (input.amountSats < reward.minSats) {
    throw new ApiError(422, 'validation_failed', `this reward needs at least ${reward.minSats} sats`, [
      { path: 'amountSats', message: `must be at least ${reward.minSats}` },
    ])
  }
  const contact = input.contact?.trim() ?? ''
  if (!contact) {
    throw new ApiError(422, 'validation_failed', 'say how the creator can reach you for the reward', [{ path: 'contact', message: 'required with a reward' }])
  }
  if (reward.limit !== null && (claims?.get(reward.id) ?? 0) >= reward.limit) {
    throw new ApiError(409, 'reward_unavailable', 'this reward has none left')
  }
  return { ...reward, contact }
}
