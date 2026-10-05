import { DurableObject } from 'cloudflare:workers'
import { and, asc, eq } from 'drizzle-orm'
import { getDb, type Db } from '../context'
import { creators, invoices, projects, type SprinklePayoutRow, type SprinkleRow, sprinklePayouts, sprinkles } from '../db/schema'
import { verifyPayment } from '../lightning/lnurl'
import { NwcError, NwcWallet } from '../lightning/nwc'
import { ApiError } from '../lib/errors'
import { createProjectInvoice } from '../lib/project-invoice'
import { nwcConnection, pickProjects } from '../lib/sprinkle'
import { hexToBytes, msatToSats, newId, sha256Hex } from '../lib/util'

/**
 * One instance per sprinkle (idFromName(sprinkleId)), driven entirely by alarms:
 *
 * 1. pending: ask the platform wallet (NWC lookup_invoice) whether the supporter paid.
 * 2. distributing: pick random eligible projects, get an invoice from each creator's
 *    Lightning Address (createProjectInvoice, same as a direct payment) and pay them
 *    concurrently with NWC pay_invoice. The project's own Durable Object then sees each
 *    settle via LUD-21 and counts it like any other supporter payment.
 *
 * All state lives in D1 (sprinkles / sprinkle_payouts); each alarm run reloads it, so a
 * crash or retried alarm just picks up where the last one stopped. Paying the same BOLT11
 * twice is safe (one payment hash), and a payout only gets a new invoice once we know the
 * previous one was not paid: our wallet says the payment failed, or the creator's wallet
 * confirms the expired invoice unpaid.
 */

/** Payouts handled per alarm run: ~4 subrequests each (LNURL ×2, project DO, verify) + the relay socket(s). */
const PAYOUTS_PER_RUN = 5
/** Definite failures (no invoice, no route…) per project before it is replaced by another one. */
const MAX_ATTEMPTS = 3
/** Give up distributing after this long; whatever is left stays in the platform wallet. */
const DISTRIBUTE_DEADLINE_MS = 2 * 60 * 60_000
const EXPIRY_GRACE_MS = 30_000
/** How soon to look again at a payout whose payment may still be in flight. */
const RECHECK_MS = 3_000
/** Wallet-side problems (empty, over budget, relay down): wait, growing, instead of hammering. */
const WALLET_BACKOFF_MS = [10_000, 30_000, 60_000, 5 * 60_000]
/** These mean the platform wallet itself can't pay right now, not that this project is bad. */
const WALLET_ERRORS = new Set(['INSUFFICIENT_BALANCE', 'QUOTA_EXCEEDED', 'RATE_LIMITED', 'RESTRICTED', 'UNAUTHORIZED', 'NOT_IMPLEMENTED'])

const pollInterval = (ageMs: number) => (ageMs < 2 * 60_000 ? 3_000 : 10_000)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** What our own wallet knows about a payment hash. */
type Lookup = 'settled' | 'failed' | 'pending' | 'none' | 'unknown'
type SetPayout = (v: Partial<SprinklePayoutRow>) => Promise<unknown>

export class SprinkleRoom extends DurableObject<Env> {
  /** Something moved forward this run (a payout paid, the supporter's payment seen). */
  private progressed = false

  // ─── RPC ────────────────────────────────────────────────────────────────────

  async start(sprinkleId: string): Promise<void> {
    await this.ctx.storage.put('id', sprinkleId)
    await this.ctx.storage.setAlarm(Date.now() + pollInterval(0))
  }

  // ─── Alarm ──────────────────────────────────────────────────────────────────

  override async alarm(): Promise<void> {
    const id = await this.ctx.storage.get<string>('id')
    if (!id) return
    const db = getDb(this.env.DB)
    const s = await db.query.sprinkles.findFirst({ where: eq(sprinkles.id, id) })
    if (!s || s.status === 'done' || s.status === 'expired') return

    const conn = nwcConnection(this.env)
    if (!conn) {
      console.error('sprinkle: NWC_URL missing, cannot continue', { sprinkle: id })
      return this.backoff()
    }

    const wallet = new NwcWallet(conn)
    this.progressed = false
    try {
      const next = s.status === 'pending' ? await this.checkPayment(db, wallet, s) : await this.distribute(db, wallet, s)
      // Only real progress resets the backoff; a run that merely waited must not.
      if (this.progressed) await this.ctx.storage.put('walletFailures', 0)
      if (next !== null) await this.ctx.storage.setAlarm(Math.max(next, Date.now() + 200))
    } catch (e) {
      console.warn('sprinkle: run failed', { sprinkle: id, error: e instanceof Error ? e.message : String(e) })
      await this.backoff()
    } finally {
      wallet.close()
    }
  }

  private async backoff(): Promise<void> {
    const n = (await this.ctx.storage.get<number>('walletFailures')) ?? 0
    await this.ctx.storage.put('walletFailures', n + 1)
    await this.ctx.storage.setAlarm(Date.now() + WALLET_BACKOFF_MS[Math.min(n, WALLET_BACKOFF_MS.length - 1)]!)
  }

  /** Returns when to run next, or null when there is nothing left to do. */
  private async checkPayment(db: Db, wallet: NwcWallet, s: SprinkleRow): Promise<number | null> {
    const now = Date.now()
    if ((await this.lookup(wallet, s.paymentHash)) !== 'settled') {
      if (now >= s.expiresAt + EXPIRY_GRACE_MS) {
        await db.update(sprinkles).set({ status: 'expired' }).where(and(eq(sprinkles.id, s.id), eq(sprinkles.status, 'pending')))
        return null
      }
      return now + pollInterval(now - s.createdAt)
    }
    const [paid] = await db
      .update(sprinkles)
      .set({ status: 'distributing', paidAt: now })
      .where(and(eq(sprinkles.id, s.id), eq(sprinkles.status, 'pending')))
      .returning()
    if (!paid) return now // changed under us; reload next run
    this.progressed = true
    console.log('sprinkle: paid', { sprinkle: s.id, sats: msatToSats(s.amountMsat), projects: s.projectCount })
    return this.distribute(db, wallet, paid)
  }

  private async distribute(db: Db, wallet: NwcWallet, s: SprinkleRow): Promise<number | null> {
    const now = Date.now()
    if (now - (s.paidAt ?? s.createdAt) > DISTRIBUTE_DEADLINE_MS) return this.finish(db, s, 'deadline')

    let payouts = await this.payouts(db, s.id)
    const open = (p: SprinklePayoutRow) => p.status === 'pending' || p.status === 'paying'
    const live = payouts.filter((p) => p.status !== 'failed')
    if (live.length < s.projectCount) {
      const picked = await pickProjects(db, s.projectCount - live.length, payouts.map((p) => p.projectId))
      if (picked.length) {
        await db.insert(sprinklePayouts).values(picked.map((projectId) => ({ id: newId(), sprinkleId: s.id, projectId, amountMsat: s.perProjectMsat })))
        payouts = await this.payouts(db, s.id)
      } else if (!payouts.some(open)) {
        return this.finish(db, s, 'no more eligible projects')
      }
    }

    // Concurrently, over one shared wallet connection that reconnects if the relay drops it.
    const results = await Promise.allSettled(payouts.filter(open).slice(0, PAYOUTS_PER_RUN).map((p) => this.payout(db, wallet, s, p)))
    const failure = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')
    if (failure) throw failure.reason

    payouts = await this.payouts(db, s.id)
    if (!payouts.some(open) && payouts.filter((p) => p.status === 'paid').length >= s.projectCount) return this.finish(db, s, 'complete')
    // Fresh work: continue right away. Only in-flight payments left: look again shortly.
    const fresh = payouts.some((p) => p.status === 'pending') || payouts.filter((p) => p.status !== 'failed').length < s.projectCount
    return Date.now() + (fresh ? 200 : RECHECK_MS)
  }

  private async payout(db: Db, wallet: NwcWallet, s: SprinkleRow, p: SprinklePayoutRow): Promise<void> {
    const set: SetPayout = (v) => db.update(sprinklePayouts).set({ ...v, updatedAt: Date.now() }).where(eq(sprinklePayouts.id, p.id))

    // A payment was sent earlier (maybe still in flight): find out what happened before anything else.
    if (p.status === 'paying' && p.invoiceId) {
      if (Date.now() - p.updatedAt < RECHECK_MS) return
      const inv = await db.query.invoices.findFirst({ where: eq(invoices.id, p.invoiceId) })
      if (!inv) return void (await set({ status: 'pending', invoiceId: null }))
      if (inv.status === 'paid') return this.markPaid(set)
      const valid = inv.expiresAt > Date.now() + 60_000

      // Our own wallet first (same socket, no extra subrequest), then the creator's.
      const ours = await this.lookup(wallet, inv.paymentHash)
      if (ours === 'settled') return this.markPaid(set)
      if (ours === 'pending') return // in flight: look again shortly
      if (ours === 'failed' || ours === 'none') {
        // Definitely not paid: re-send the same invoice (safe), or get a new one once it expired.
        if (valid) return this.pay(wallet, p, inv.bolt11, inv.paymentHash, set)
        return void (await set({ status: 'pending', invoiceId: null }))
      }
      const v = await verifyPayment(inv.verifyUrl).catch(() => null)
      if (v?.settled) return this.markPaid(set)
      if (!v) return // neither wallet can tell yet: ask again next run
      if (valid) return this.pay(wallet, p, inv.bolt11, inv.paymentHash, set, true)
      // Expired and the creator's wallet confirms it unpaid: safe to request a fresh invoice.
      return void (await set({ status: 'pending', invoiceId: null }))
    }

    if (p.attempts >= MAX_ATTEMPTS) return void (await set({ status: 'failed' }))
    const [target] = await db
      .select({ status: projects.status, endsAt: projects.endsAt, lightningAddress: creators.lightningAddress })
      .from(projects)
      .innerJoin(creators, eq(creators.id, projects.creatorId))
      .where(eq(projects.id, p.projectId))
    if (!target || target.status !== 'active' || (target.endsAt !== null && target.endsAt <= Date.now()) || !target.lightningAddress) {
      return void (await set({ status: 'failed', lastError: 'project no longer accepting payments' }))
    }

    let inv
    try {
      inv = await createProjectInvoice(this.env, db, p.projectId, target.lightningAddress, {
        amountSats: msatToSats(p.amountMsat),
        supporterName: s.supporterName,
        comment: s.comment,
      })
    } catch (e) {
      const permanent = e instanceof ApiError && (e.code === 'amount_out_of_range' || e.code === 'lnurl_verify_unsupported' || e.code === 'validation_failed')
      const attempts = p.attempts + 1
      return void (await set({ attempts, status: permanent || attempts >= MAX_ATTEMPTS ? 'failed' : 'pending', lastError: errText(e) }))
    }
    // Record the invoice before paying, so an interrupted run knows a payment may be in flight.
    await set({ status: 'paying', invoiceId: inv.id })
    await this.pay(wallet, p, inv.bolt11, inv.paymentHash, set)
  }

  private async pay(
    wallet: NwcWallet,
    p: SprinklePayoutRow,
    bolt11: string,
    paymentHash: string,
    set: SetPayout,
    /** Re-sending without knowing the first try's outcome: an error may just mean it's still in flight. */
    resend = false,
  ): Promise<void> {
    try {
      const { preimage } = await (await wallet.client()).payInvoice(bolt11)
      const bytes = hexToBytes(preimage)
      if (!bytes || (await sha256Hex(bytes)) !== paymentHash) {
        // Wallet claims success with a bogus preimage: let the next check decide.
        return void console.warn('sprinkle: preimage mismatch', { payout: p.id })
      }
      await this.markPaid(set)
    } catch (e) {
      if (!(e instanceof NwcError)) throw e
      if (e.ambiguous) {
        // No answer (relay dropped us, timeout): ask the wallet what happened, reconnecting if needed.
        const state = await this.lookup(wallet, paymentHash, 3)
        if (state === 'settled') return this.markPaid(set)
        if (state !== 'failed') return void (await set({ lastError: e.message })) // in flight or unknown: look again shortly
      } else if (WALLET_ERRORS.has(e.code)) {
        // The platform wallet refused (nothing was sent): retry later with a fresh invoice, without
        // counting it against the project, and back off the whole run.
        await set({ status: 'pending', invoiceId: null, lastError: e.message })
        throw e
      } else if (resend) {
        return void (await set({ lastError: e.message }))
      }
      // Definite failure (e.g. no route): this invoice wasn't paid, so a new one is safe.
      const attempts = p.attempts + 1
      await set({ attempts, status: attempts >= MAX_ATTEMPTS ? 'failed' : 'pending', invoiceId: null, lastError: e.message })
    }
  }

  private async markPaid(set: SetPayout): Promise<void> {
    this.progressed = true
    await set({ status: 'paid', lastError: null })
  }

  /** lookup_invoice on our wallet, retrying (on a fresh connection) after transport errors. */
  private async lookup(wallet: NwcWallet, paymentHash: string, tries = 2): Promise<Lookup> {
    for (let i = 0; i < tries; i++) {
      try {
        return (await (await wallet.client()).lookupInvoice(paymentHash)).state
      } catch (e) {
        if (e instanceof NwcError && e.code === 'NOT_FOUND') return 'none'
        if (!(e instanceof NwcError) || !e.ambiguous) return 'unknown'
        if (i < tries - 1) await sleep(1000)
      }
    }
    return 'unknown'
  }

  private async finish(db: Db, s: SprinkleRow, reason: string): Promise<null> {
    const payouts = await this.payouts(db, s.id)
    const paidMsat = payouts.filter((p) => p.status === 'paid').reduce((sum, p) => sum + p.amountMsat, 0)
    await db.update(sprinkles).set({ status: 'done', completedAt: Date.now() }).where(eq(sprinkles.id, s.id))
    this.progressed = true
    console.log('sprinkle: done', { sprinkle: s.id, reason, paidSats: msatToSats(paidMsat), keptSats: msatToSats(s.amountMsat - paidMsat) })
    return null
  }

  private payouts(db: Db, sprinkleId: string) {
    return db.select().from(sprinklePayouts).where(eq(sprinklePayouts.sprinkleId, sprinkleId)).orderBy(asc(sprinklePayouts.createdAt), asc(sprinklePayouts.id))
  }
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300)
