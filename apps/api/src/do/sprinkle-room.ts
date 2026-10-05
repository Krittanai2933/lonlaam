import { DurableObject } from 'cloudflare:workers'
import { and, asc, eq } from 'drizzle-orm'
import { getDb, type Db } from '../context'
import { creators, invoices, projects, type SprinklePayoutRow, type SprinkleRow, sprinklePayouts, sprinkles } from '../db/schema'
import { verifyPayment } from '../lightning/lnurl'
import { NwcClient, NwcError } from '../lightning/nwc'
import { ApiError } from '../lib/errors'
import { createProjectInvoice } from '../lib/project-invoice'
import { nwcConnection, pickProjects } from '../lib/sprinkle'
import { hexToBytes, msatToSats, newId, sha256Hex } from '../lib/util'

/**
 * One instance per sprinkle (idFromName(sprinkleId)), driven entirely by alarms:
 *
 * 1. pending: ask the platform wallet (NWC lookup_invoice) whether the supporter paid.
 * 2. distributing: pick random eligible projects, get an invoice from each creator's
 *    Lightning Address (createProjectInvoice, same as a direct payment) and pay it with
 *    NWC pay_invoice. The project's own Durable Object then sees it settle via LUD-21 and
 *    counts it like any other supporter payment.
 *
 * All state lives in D1 (sprinkles / sprinkle_payouts); each alarm run reloads it, so a
 * crash or retried alarm just picks up where the last one stopped. Paying the same BOLT11
 * twice is safe (one payment hash), and a new invoice is only requested for a payout after
 * the creator's wallet confirmed the previous one was not paid.
 */

/** Payouts handled per alarm run: ~4 subrequests each (LNURL ×2, project DO, verify) + 1 relay socket. */
const PAYOUTS_PER_RUN = 3
/** Attempts (new invoices) per project before it is replaced by another one. */
const MAX_ATTEMPTS = 3
/** Give up distributing after this long; whatever is left stays in the platform wallet. */
const DISTRIBUTE_DEADLINE_MS = 2 * 60 * 60_000
const EXPIRY_GRACE_MS = 30_000
/** How often to re-check a payout whose payment may still be in flight. */
const RECHECK_MS = 15_000
/** Wallet-side problems (empty, over budget, relay down): wait instead of burning attempts. */
const WALLET_BACKOFF_MS = [10_000, 30_000, 60_000, 5 * 60_000]
/** These mean the platform wallet itself can't pay right now, not that this project is bad. */
const WALLET_ERRORS = new Set(['INSUFFICIENT_BALANCE', 'QUOTA_EXCEEDED', 'RATE_LIMITED', 'RESTRICTED', 'UNAUTHORIZED', 'NOT_IMPLEMENTED'])

const pollInterval = (ageMs: number) => (ageMs < 2 * 60_000 ? 3_000 : 10_000)

export class SprinkleRoom extends DurableObject<Env> {
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

    let client: NwcClient | null = null
    try {
      client = await NwcClient.connect(conn)
      const next = s.status === 'pending' ? await this.checkPayment(db, client, s) : await this.distribute(db, client, s)
      await this.ctx.storage.put('walletFailures', 0)
      if (next !== null) await this.ctx.storage.setAlarm(Math.max(next, Date.now() + 500))
    } catch (e) {
      console.warn('sprinkle: run failed', { sprinkle: id, error: e instanceof Error ? e.message : String(e) })
      await this.backoff()
    } finally {
      client?.close()
    }
  }

  private async backoff(): Promise<void> {
    const n = (await this.ctx.storage.get<number>('walletFailures')) ?? 0
    await this.ctx.storage.put('walletFailures', n + 1)
    await this.ctx.storage.setAlarm(Date.now() + WALLET_BACKOFF_MS[Math.min(n, WALLET_BACKOFF_MS.length - 1)]!)
  }

  /** Returns when to run next, or null when there is nothing left to do. */
  private async checkPayment(db: Db, client: NwcClient, s: SprinkleRow): Promise<number | null> {
    const now = Date.now()
    const { settled } = await client.lookupInvoice(s.paymentHash)
    if (!settled) {
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
    console.log('sprinkle: paid', { sprinkle: s.id, sats: msatToSats(s.amountMsat), projects: s.projectCount })
    return this.distribute(db, client, paid)
  }

  private async distribute(db: Db, client: NwcClient, s: SprinkleRow): Promise<number | null> {
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

    for (const p of payouts.filter(open).slice(0, PAYOUTS_PER_RUN)) await this.payout(db, client, s, p)

    payouts = await this.payouts(db, s.id)
    if (!payouts.some(open) && payouts.filter((p) => p.status === 'paid').length >= s.projectCount) return this.finish(db, s, 'complete')
    // Fresh work: continue right away. Only in-flight payments left: check back later.
    return Date.now() + (payouts.some((p) => p.status === 'pending') || payouts.filter((p) => p.status !== 'failed').length < s.projectCount ? 1000 : RECHECK_MS)
  }

  private async payout(db: Db, client: NwcClient, s: SprinkleRow, p: SprinklePayoutRow): Promise<void> {
    const set = (v: Partial<SprinklePayoutRow>) => db.update(sprinklePayouts).set({ ...v, updatedAt: Date.now() }).where(eq(sprinklePayouts.id, p.id))

    // A payment was sent earlier (maybe still in flight): find out what happened before anything else.
    if (p.status === 'paying' && p.invoiceId) {
      if (Date.now() - p.updatedAt < RECHECK_MS) return
      const inv = await db.query.invoices.findFirst({ where: eq(invoices.id, p.invoiceId) })
      if (!inv) return void (await set({ status: 'pending', invoiceId: null }))
      if (inv.status === 'paid') return void (await set({ status: 'paid' }))
      const v = await verifyPayment(inv.verifyUrl).catch(() => null)
      if (v?.settled) return void (await set({ status: 'paid' }))
      if (!v) return // creator's wallet unreachable: can't tell yet, ask again next run
      if (inv.expiresAt > Date.now() + 60_000) return this.pay(client, p, inv.bolt11, inv.paymentHash, set, true)
      // Expired and confirmed unpaid: safe to request a fresh invoice.
      return void (await set({ status: p.attempts >= MAX_ATTEMPTS ? 'failed' : 'pending', invoiceId: null }))
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
    await set({ status: 'paying', invoiceId: inv.id, attempts: p.attempts + 1 })
    await this.pay(client, { ...p, attempts: p.attempts + 1 }, inv.bolt11, inv.paymentHash, set)
  }

  private async pay(
    client: NwcClient,
    p: SprinklePayoutRow,
    bolt11: string,
    paymentHash: string,
    set: (v: Partial<SprinklePayoutRow>) => Promise<unknown>,
    /** Re-sending an invoice that was sent before: an error may just mean the first try is still in flight. */
    resend = false,
  ): Promise<void> {
    try {
      const { preimage } = await client.payInvoice(bolt11)
      const bytes = hexToBytes(preimage)
      if (!bytes || (await sha256Hex(bytes)) !== paymentHash) {
        // Wallet claims success with a bogus preimage: let the creator's verify URL decide next run.
        console.warn('sprinkle: preimage mismatch', { payout: p.id })
        return
      }
      await set({ status: 'paid', lastError: null })
    } catch (e) {
      if (!(e instanceof NwcError)) throw e
      // No answer: the payment may still complete. Stay "paying"; the next run checks the invoice.
      if (e.ambiguous) return void (await set({ lastError: e.message }))
      // The platform wallet can't pay at all: don't blame the project, back off the whole run.
      if (WALLET_ERRORS.has(e.code)) {
        await set({ lastError: e.message })
        throw e
      }
      // Keep the invoice until it expires and the creator's wallet confirms it unpaid.
      if (resend) return void (await set({ lastError: e.message }))
      // Definite failure (e.g. no route): this invoice wasn't paid, so a new one is safe.
      await set({ status: p.attempts >= MAX_ATTEMPTS ? 'failed' : 'pending', invoiceId: null, lastError: e.message })
    }
  }

  private async finish(db: Db, s: SprinkleRow, reason: string): Promise<null> {
    const payouts = await this.payouts(db, s.id)
    const paidMsat = payouts.filter((p) => p.status === 'paid').reduce((sum, p) => sum + p.amountMsat, 0)
    await db.update(sprinkles).set({ status: 'done', completedAt: Date.now() }).where(eq(sprinkles.id, s.id))
    console.log('sprinkle: done', { sprinkle: s.id, reason, paidSats: msatToSats(paidMsat), keptSats: msatToSats(s.amountMsat - paidMsat) })
    return null
  }

  private payouts(db: Db, sprinkleId: string) {
    return db.select().from(sprinklePayouts).where(eq(sprinklePayouts.sprinkleId, sprinkleId)).orderBy(asc(sprinklePayouts.createdAt), asc(sprinklePayouts.id))
  }
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300)
