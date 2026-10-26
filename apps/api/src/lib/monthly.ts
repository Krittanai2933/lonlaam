import type { MonthlyCycle, MonthlyPlan, MonthlyReason } from '@nampu/types'
import { MONTHLY, monthlyDistributable, SPRINKLE } from '@nampu/types'
import { and, asc, eq, inArray, lt, lte } from 'drizzle-orm'
import { type Db, getDb } from '../context'
import { type MonthlyCycleRow, monthlyCycles, type MonthlyPlanRow, monthlyPlans, sprinkles } from '../db/schema'
import type { NwcConnection } from '../lightning/nwc'
import { siteOrigin } from './email'
import { secretboxEnabled } from './secretbox'
import { nwcConnection } from './sprinkle'
import { msatToSats, newId } from './util'

const HOUR = 60 * 60_000
const DAY = 24 * HOUR
/** Plans started per cron run; each costs one Durable Object call. */
const DUE_PER_RUN = 25

export const monthlyRoom = (env: Env, cycleId: string) => env.MONTHLY_ROOM.get(env.MONTHLY_ROOM.idFromName(cycleId))

/** Needs the platform wallet (every month is a sprinkle). Auto-pay also needs NWC_ENC_KEY. */
export const monthlyEnabled = (env: Env) => nwcConnection(env) !== null
export const autoPayEnabled = (env: Env) => monthlyEnabled(env) && secretboxEnabled(env)

// ─── The monthly draw ─────────────────────────────────────────────────────────

/**
 * Splits `totalSats` across `count` projects at random: each gets the sprinkle minimum, and the
 * rest is cut by exponential weights (a uniform random split). Sums to exactly totalSats.
 */
export function drawShares(totalSats: number, count: number, rand: () => number = Math.random): number[] {
  const extra = totalSats - count * SPRINKLE.minSatsPerProject
  const weights = Array.from({ length: count }, () => -Math.log(1 - rand()) || Number.EPSILON)
  const sum = weights.reduce((a, b) => a + b, 0)
  const shares = weights.map((w) => SPRINKLE.minSatsPerProject + Math.floor((extra * w) / sum))
  // Rounding left fewer than `count` sats over; hand them out one each.
  let left = totalSats - shares.reduce((a, b) => a + b, 0)
  for (let i = 0; left > 0; i = (i + 1) % count, left--) shares[i]!++
  return shares
}

/**
 * This month's split: a random project count in [min, max], capped by what's open and by how
 * many minimum shares the distributable amount covers. Null when nothing can be paid.
 */
export function drawMonth(
  plan: { amountSats: number; tipPercent: number; projectsMin: number; projectsMax: number },
  eligible: number,
  rand: () => number = Math.random,
): number[] | null {
  const total = monthlyDistributable(plan.amountSats, plan.tipPercent)
  const hi = Math.min(plan.projectsMax, eligible, Math.floor(total / SPRINKLE.minSatsPerProject))
  if (hi < 1) return null
  const lo = Math.min(plan.projectsMin, hi)
  return drawShares(total, lo + Math.floor(rand() * (hi - lo + 1)), rand)
}

/**
 * The charge after `prevMs`: next calendar month (UTC), on `billingDay` or that month's last
 * day, at the same time of day.
 */
export function nextDue(prevMs: number, billingDay: number): number {
  const d = new Date(prevMs)
  const y = d.getUTCFullYear()
  const m = d.getUTCMonth() + 1
  const days = new Date(Date.UTC(y, m + 1, 0)).getUTCDate()
  return Date.UTC(y, m, Math.min(billingDay, days), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds())
}

/** What the supporter sees as their wallet: the Lightning Address in the string, else the relay host. */
export function nwcLabel(url: string, conn: NwcConnection): string {
  try {
    const lud16 = new URL(url.trim()).searchParams.get('lud16')?.trim()
    if (lud16 && lud16.length <= 100 && lud16.includes('@')) return lud16
  } catch {
    // parseNwcUrl already accepted it
  }
  return new URL(conn.relays[0]!.replace(/^ws/, 'http')).host
}

/** NIP-47 error code (or TIMEOUT/RELAY) → why the month needs paying by hand. */
export function reasonFor(code: string): MonthlyReason {
  switch (code) {
    case 'UNAUTHORIZED':
    case 'RESTRICTED':
      return 'wallet_revoked'
    case 'NOT_IMPLEMENTED':
      return 'wallet_unsupported'
    case 'INSUFFICIENT_BALANCE':
      return 'insufficient_balance'
    case 'QUOTA_EXCEEDED':
      return 'quota_exceeded'
    case 'RELAY':
    case 'TIMEOUT':
      return 'wallet_unreachable'
    default:
      return 'payment_failed'
  }
}

// ─── Serialization ────────────────────────────────────────────────────────────

export function toPlan(r: MonthlyPlanRow): MonthlyPlan {
  return {
    amountSats: msatToSats(r.amountMsat),
    projectsMin: r.projectsMin,
    projectsMax: r.projectsMax,
    excludeFunded: r.excludeFunded,
    tipPercent: r.tipPercent,
    supporterName: r.supporterName,
    comment: r.comment,
    wallet: r.nwcSealed ? r.nwcLabel : null,
    status: r.status,
    billingDay: r.billingDay,
    nextChargeAt: r.nextChargeAt,
    email: r.email,
    emailVerified: r.emailVerified,
    createdAt: r.createdAt,
  }
}

export const toCycle = (r: MonthlyCycleRow): MonthlyCycle => ({
  id: r.id,
  dueAt: r.dueAt,
  amountSats: msatToSats(r.amountMsat),
  status: r.status,
  reason: r.reason as MonthlyReason | null,
  sprinkleId: r.sprinkleId,
  paidAt: r.paidAt,
})

// ─── Lifecycle ────────────────────────────────────────────────────────────────

/**
 * Starts the month due at `dueAt` (once: plan + dueAt is unique) and moves the plan to its next
 * charge, skipping months that already went by (a paused or late plan isn't charged for them).
 */
export async function startCycle(env: Env, db: Db, plan: MonthlyPlanRow, dueAt: number): Promise<MonthlyCycleRow | null> {
  const [row] = await db
    .insert(monthlyCycles)
    .values({ id: newId(), planId: plan.id, dueAt, amountMsat: plan.amountMsat, tipPercent: plan.tipPercent })
    .onConflictDoNothing()
    .returning()
  const now = Date.now()
  let next = nextDue(dueAt, plan.billingDay)
  while (next <= now) next = nextDue(next, plan.billingDay)
  await db
    .update(monthlyPlans)
    .set({ nextChargeAt: next })
    .where(and(eq(monthlyPlans.id, plan.id), eq(monthlyPlans.nextChargeAt, dueAt)))
  if (row) await monthlyRoom(env, row.id).start(row.id)
  return row ?? null
}

/** Months whose sprinkle got paid (automatically or by hand) become `paid`. */
export async function settleCycles(db: Db, planId?: string): Promise<void> {
  const open = ['charging', 'needs_payment'] as const
  const rows = await db
    .select({ id: monthlyCycles.id, paidAt: sprinkles.paidAt })
    .from(monthlyCycles)
    .innerJoin(sprinkles, eq(sprinkles.id, monthlyCycles.sprinkleId))
    .where(and(inArray(monthlyCycles.status, open), inArray(sprinkles.status, ['distributing', 'done']), planId ? eq(monthlyCycles.planId, planId) : undefined))
  for (const r of rows) {
    await db
      .update(monthlyCycles)
      .set({ status: 'paid', reason: null, paidAt: r.paidAt ?? Date.now() })
      .where(and(eq(monthlyCycles.id, r.id), inArray(monthlyCycles.status, open)))
  }
}

/** Cron: settle paid months, give up on old unpaid ones, start the ones due. */
export async function runMonthly(env: Env): Promise<void> {
  if (!monthlyEnabled(env)) return
  const db = getDb(env.DB)
  const now = Date.now()
  await settleCycles(db)
  await db
    .update(monthlyCycles)
    .set({ status: 'missed', reason: 'unpaid' })
    .where(and(eq(monthlyCycles.status, 'needs_payment'), lt(monthlyCycles.createdAt, now - MONTHLY.payWithinDays * DAY)))

  const due = await db
    .select()
    .from(monthlyPlans)
    .where(and(eq(monthlyPlans.status, 'active'), lte(monthlyPlans.nextChargeAt, now)))
    .orderBy(asc(monthlyPlans.nextChargeAt))
    .limit(DUE_PER_RUN)
  for (const plan of due) {
    try {
      await startCycle(env, db, plan, plan.nextChargeAt)
    } catch (e) {
      console.error('monthly: start failed', { plan: plan.id, error: e instanceof Error ? e.message : String(e) })
    }
  }

  // A room that lost its alarm (crash between insert and start): start() is a no-op otherwise.
  const charging = await db
    .select({ id: monthlyCycles.id })
    .from(monthlyCycles)
    .where(and(eq(monthlyCycles.status, 'charging'), lt(monthlyCycles.createdAt, now - HOUR)))
    .limit(10)
  for (const c of charging) await monthlyRoom(env, c.id).start(c.id)
  if (due.length) console.log('monthly: started', { plans: due.length })
}

// ─── Email copy (both languages: plans don't store one) ──────────────────────

const REASON_TEXT: Record<MonthlyReason, [th: string, en: string]> = {
  no_wallet: ['ยังไม่ได้เชื่อมกระเป๋าไว้จ่ายอัตโนมัติ', 'no wallet is connected for automatic payment'],
  wallet_revoked: ['กระเป๋าปฏิเสธการเชื่อมต่อ (อาจถูกยกเลิกสิทธิ์)', 'your wallet refused the connection (it may have been revoked)'],
  wallet_unsupported: ['กระเป๋านี้ไม่รองรับการจ่ายผ่าน NWC', 'your wallet does not support paying over NWC'],
  insufficient_balance: ['ยอดเงินในกระเป๋าไม่พอ', 'your wallet balance was too low'],
  quota_exceeded: ['เกินงบที่ตั้งไว้ในกระเป๋า', 'it would exceed the budget set in your wallet'],
  payment_failed: ['การจ่ายไม่สำเร็จ', 'the payment failed'],
  wallet_unreachable: ['ติดต่อกระเป๋าไม่ได้', 'your wallet could not be reached'],
  no_projects: ['ไม่มีโปรเจกต์ที่เปิดรับ', 'no projects are open'],
  paused: ['หยุดไว้ชั่วคราว', 'it is paused'],
  unpaid: ['ไม่ได้ชำระ', 'it was not paid'],
}

export function needsPaymentEmail(env: Env, amountSats: number, reason: MonthlyReason) {
  const link = `${siteOrigin(env)}/monthly`
  const [th, en] = REASON_TEXT[reason]
  return {
    subject: `${env.SITE_NAME}: ยังจ่ายรายเดือนไม่สำเร็จ / Your monthly sprinkle needs you`,
    text: [
      `ยอดสนับสนุนรายเดือน ${amountSats} sats ของคุณยังจ่ายอัตโนมัติไม่ได้ เพราะ${th}`,
      `จ่ายเองได้ที่ ${link} ภายใน ${MONTHLY.payWithinDays} วัน`,
      '',
      `Your monthly sprinkle of ${amountSats} sats couldn't be paid automatically: ${en}.`,
      `You can pay it at ${link} within ${MONTHLY.payWithinDays} days.`,
    ].join('\n'),
  }
}

export function verifyEmail(env: Env, link: string) {
  return {
    subject: `${env.SITE_NAME}: ยืนยันอีเมล / Confirm your email`,
    text: [
      `กดลิงก์นี้เพื่อยืนยันอีเมลสำหรับแจ้งเตือนการสนับสนุนรายเดือน (หมดอายุใน 24 ชั่วโมง):`,
      link,
      '',
      'Open this link to confirm the email for your monthly sprinkle notices (expires in 24 hours):',
      link,
      '',
      'ถ้าคุณไม่ได้ขอ ไม่ต้องทำอะไร / If you did not ask for this, ignore this email.',
    ].join('\n'),
  }
}
