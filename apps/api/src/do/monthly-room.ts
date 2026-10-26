import { type MonthlyReason, monthlyPlatformShare } from '@nampu/types'
import { DurableObject } from 'cloudflare:workers'
import { and, eq } from 'drizzle-orm'
import { type Db, getDb } from '../context'
import { type MonthlyCycleRow, monthlyCycles, type MonthlyPlanRow, monthlyPlans, sprinkles } from '../db/schema'
import { NwcError, NwcWallet, parseNwcUrl } from '../lightning/nwc'
import { sendEmail } from '../lib/email'
import { ApiError } from '../lib/errors'
import { drawMonth, needsPaymentEmail, reasonFor } from '../lib/monthly'
import { unseal } from '../lib/secretbox'
import { countEligible, createSprinkle } from '../lib/sprinkle'
import { hexToBytes, msatToSats, sha256Hex } from '../lib/util'

/**
 * One instance per monthly cycle (idFromName(cycleId)), driven by alarms:
 *
 * 1. Draw this month's split and make a sprinkle for it (the platform wallet's invoice).
 * 2. Next run, pay that invoice from the supporter's own wallet over their NWC connection.
 *    SprinkleRoom sees the payment and distributes it like any sprinkle.
 * 3. If their wallet can't pay after a few tries (or at once when the connection is revoked,
 *    or there is none), the month waits for them to pay by hand (needs_payment) and they get
 *    one email, if they verified an address.
 *
 * A new sprinkle is only made once the previous one is `expired` (SprinkleRoom confirmed with
 * the platform wallet that it was never paid), so a payment still in flight can't be doubled.
 * Re-paying the same invoice is safe (one payment hash).
 */

/** Wait after the nth failed attempt; the attempt after the last one goes to manual. */
const RETRY_MS = [10 * 60_000, 60 * 60_000, 6 * 60 * 60_000]
const MAX_ATTEMPTS = RETRY_MS.length + 1
/** No answer (dropped relay, timeout): the payment may still land, so look again soon. */
const AMBIGUOUS_RECHECK_MS = 30_000
/** Don't send an invoice this close to its expiry; wait for SprinkleRoom to settle it instead. */
const EXPIRY_MARGIN_MS = 60_000
/** SprinkleRoom marks an unpaid sprinkle expired within ~40s after its expiry. */
const EXPIRY_SETTLE_MS = 45_000
/** Platform wallet down: not the supporter's fault, so wait without counting attempts. */
const PLATFORM_BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000, 60 * 60_000]
/** Give the platform this long before handing the month to the supporter anyway. */
const PLATFORM_DEADLINE_MS = 24 * 60 * 60_000
/** These mean the connection itself is unusable; retrying won't help. */
const FATAL = new Set(['UNAUTHORIZED', 'RESTRICTED', 'NOT_IMPLEMENTED'])

export class MonthlyRoom extends DurableObject<Env> {
  // ─── RPC ────────────────────────────────────────────────────────────────────

  /** Idempotent: keeps an alarm that is already scheduled (the cron re-kicks old cycles). */
  async start(cycleId: string): Promise<void> {
    await this.ctx.storage.put('id', cycleId)
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now())
  }

  // ─── Alarm ──────────────────────────────────────────────────────────────────

  override async alarm(): Promise<void> {
    const id = await this.ctx.storage.get<string>('id')
    if (!id) return
    const db = getDb(this.env.DB)
    const cycle = await db.query.monthlyCycles.findFirst({ where: eq(monthlyCycles.id, id) })
    if (!cycle || cycle.status !== 'charging') return
    const plan = await db.query.monthlyPlans.findFirst({ where: eq(monthlyPlans.id, cycle.planId) })
    if (!plan) return
    if (plan.status !== 'active') return void (await this.close(db, cycle, 'missed', 'paused'))

    try {
      const next = await this.step(db, plan, cycle)
      if (next !== null) await this.ctx.storage.setAlarm(Math.max(next, Date.now() + 200))
    } catch (e) {
      console.warn('monthly: run failed', { cycle: id, error: e instanceof Error ? e.message : String(e) })
      await this.ctx.storage.setAlarm(Date.now() + 60_000)
    }
  }

  /** Returns when to run next, or null when this cycle needs nothing more from us. */
  private async step(db: Db, plan: MonthlyPlanRow, cycle: MonthlyCycleRow): Promise<number | null> {
    const now = Date.now()
    const spr = cycle.sprinkleId ? await db.query.sprinkles.findFirst({ where: eq(sprinkles.id, cycle.sprinkleId) }) : null
    if (spr && (spr.status === 'distributing' || spr.status === 'done')) return this.paid(db, cycle, spr.paidAt)
    // Maybe paid at the last moment: let SprinkleRoom find out before anything new is made.
    if (spr?.status === 'pending' && spr.expiresAt - now < EXPIRY_MARGIN_MS) return Math.max(spr.expiresAt + EXPIRY_SETTLE_MS, now + 5_000)

    if (!plan.nwcSealed) return this.manual(db, plan, cycle, 'no_wallet', 'no wallet connected')
    let conn
    try {
      conn = parseNwcUrl(await unseal(this.env, plan.nwcSealed, plan.creatorId))
    } catch (e) {
      return this.manual(db, plan, cycle, 'wallet_revoked', `stored connection unusable: ${errText(e)}`)
    }

    if (!spr || spr.status === 'expired') {
      // Make the invoice in this run and pay it in the next: each run stays within the CPU budget.
      const made = await this.makeSprinkle(db, plan, cycle)
      return made === 'later' ? this.platformBackoff(db, plan, cycle) : made === 'none' ? null : now
    }

    const wallet = new NwcWallet(conn)
    try {
      const { preimage } = await (await wallet.client()).payInvoice(spr.bolt11)
      const bytes = hexToBytes(preimage)
      // SprinkleRoom confirms with the platform wallet; a bogus preimage just means "look again".
      if (bytes && (await sha256Hex(bytes)) === spr.paymentHash) {
        console.log('monthly: paid from supporter wallet', { cycle: cycle.id, sats: msatToSats(spr.amountMsat) })
        return this.paid(db, cycle, Date.now())
      }
      return now + 5_000
    } catch (e) {
      if (!(e instanceof NwcError)) throw e
      return this.failed(db, plan, cycle, e)
    } finally {
      wallet.close()
    }
  }

  private async makeSprinkle(db: Db, plan: MonthlyPlanRow, cycle: MonthlyCycleRow): Promise<'made' | 'later' | 'none'> {
    const count = await countEligible(db)
    const amountSats = msatToSats(cycle.amountMsat)
    const shares = drawMonth({ amountSats, tipPercent: cycle.tipPercent, projectsMin: plan.projectsMin, projectsMax: plan.projectsMax }, plan.excludeFunded ? count.unfunded : count.all)
    if (!shares) {
      await this.close(db, cycle, 'missed', 'no_projects')
      return 'none'
    }
    try {
      const s = await createSprinkle(this.env, db, {
        amountSats,
        sharesSats: shares,
        platformShareSats: monthlyPlatformShare(amountSats, cycle.tipPercent),
        excludeFunded: plan.excludeFunded,
        supporterName: plan.supporterName,
        comment: plan.comment,
        description: `${this.env.SITE_NAME} · monthly sprinkle to ${shares.length} projects`,
      })
      await db.update(monthlyCycles).set({ sprinkleId: s.id }).where(eq(monthlyCycles.id, cycle.id))
      await this.ctx.storage.put('platformFailures', 0)
      return 'made'
    } catch (e) {
      if (e instanceof ApiError && e.code === 'sprinkle_unavailable') return 'later'
      throw e
    }
  }

  private async failed(db: Db, plan: MonthlyPlanRow, cycle: MonthlyCycleRow, e: NwcError): Promise<number | null> {
    const attempts = cycle.attempts + 1
    console.warn('monthly: supporter wallet did not pay', { cycle: cycle.id, attempts, code: e.code, message: e.message })
    if (FATAL.has(e.code) || attempts >= MAX_ATTEMPTS) return this.manual(db, plan, cycle, reasonFor(e.code), e.message, attempts)
    await db.update(monthlyCycles).set({ attempts, lastError: errText(e) }).where(eq(monthlyCycles.id, cycle.id))
    return Date.now() + (e.ambiguous && attempts === 1 ? AMBIGUOUS_RECHECK_MS : RETRY_MS[attempts - 1]!)
  }

  private async platformBackoff(db: Db, plan: MonthlyPlanRow, cycle: MonthlyCycleRow): Promise<number | null> {
    if (Date.now() - cycle.createdAt > PLATFORM_DEADLINE_MS) return this.manual(db, plan, cycle, 'payment_failed', 'platform wallet unavailable')
    const n = (await this.ctx.storage.get<number>('platformFailures')) ?? 0
    await this.ctx.storage.put('platformFailures', n + 1)
    return Date.now() + PLATFORM_BACKOFF_MS[Math.min(n, PLATFORM_BACKOFF_MS.length - 1)]!
  }

  /** Hands the month to the supporter, emailing them once if they verified an address. */
  private async manual(db: Db, plan: MonthlyPlanRow, cycle: MonthlyCycleRow, reason: MonthlyReason, error: string, attempts = cycle.attempts): Promise<null> {
    const [moved] = await db
      .update(monthlyCycles)
      .set({ status: 'needs_payment', reason, attempts, lastError: error.slice(0, 300) })
      .where(and(eq(monthlyCycles.id, cycle.id), eq(monthlyCycles.status, 'charging')))
      .returning({ id: monthlyCycles.id })
    if (!moved) return null
    console.log('monthly: needs payment by hand', { cycle: cycle.id, reason })
    if (plan.email && plan.emailVerified && cycle.notifiedAt === null) {
      if (await sendEmail(this.env, { to: plan.email, ...needsPaymentEmail(this.env, msatToSats(cycle.amountMsat), reason) })) {
        await db.update(monthlyCycles).set({ notifiedAt: Date.now() }).where(eq(monthlyCycles.id, cycle.id))
      }
    }
    return null
  }

  private async paid(db: Db, cycle: MonthlyCycleRow, paidAt: number | null): Promise<null> {
    await db
      .update(monthlyCycles)
      .set({ status: 'paid', reason: null, paidAt: paidAt ?? Date.now() })
      .where(and(eq(monthlyCycles.id, cycle.id), eq(monthlyCycles.status, 'charging')))
    return null
  }

  private async close(db: Db, cycle: MonthlyCycleRow, status: 'missed', reason: MonthlyReason): Promise<void> {
    await db.update(monthlyCycles).set({ status, reason }).where(and(eq(monthlyCycles.id, cycle.id), eq(monthlyCycles.status, 'charging')))
  }
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300)
