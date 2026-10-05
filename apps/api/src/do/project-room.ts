import { DurableObject } from 'cloudflare:workers'
import type { WsInvoiceMessage, WsPaymentMessage, WsServerMessage } from '@nampu/types'
import { WS_PING, WS_PONG } from '@nampu/types'
import { and, eq, exists, sql } from 'drizzle-orm'
import { getDb } from '../context'
import { invoices, projects } from '../db/schema'
import { verifyPayment } from '../lightning/lnurl'
import { hexToBytes, msatToSats, sha256Hex } from '../lib/util'
import { toSupporter } from '../serialize'

/**
 * One instance per project (idFromName(projectId)).
 *
 * - Fans out real-time events to viewers via the WebSocket Hibernation API, so idle
 *   connections cost nothing while the object is evicted from memory.
 * - Tracks that project's pending invoices in its own SQLite storage and polls each
 *   LUD-21 verify URL from an alarm until it settles or expires. When nothing is
 *   pending, no alarm is set and the object can hibernate.
 */

export interface TrackInvoiceInput {
  id: string
  projectId: string
  verifyUrl: string
  paymentHash: string
  amountMsat: number
  createdAt: number
  expiresAt: number
}

export type TrackInvoiceResult = { ok: true } | { ok: false; reason: 'too_many_pending' }

/** Cap on concurrently pending invoices per project (bounds polling cost and abuse). */
export const MAX_PENDING = 50
/** Verify calls per alarm run; stays well under the 50-subrequest limit per invocation. */
const MAX_POLLS_PER_ALARM = 25
/** Keep checking a bit past expiry in case the payment raced the deadline. */
const EXPIRY_GRACE_MS = 30_000
const MAX_SOCKETS = 1000

/** Poll fast while the payer is likely looking at the QR code, then back off. */
function pollInterval(ageMs: number): number {
  if (ageMs < 2 * 60_000) return 3_000
  if (ageMs < 10 * 60_000) return 10_000
  if (ageMs < 30 * 60_000) return 30_000
  return 60_000
}

interface PendingRow extends Record<string, SqlStorageValue> {
  id: string
  project_id: string
  verify_url: string
  payment_hash: string
  amount_msat: number
  created_at: number
  expires_at: number
  next_check_at: number
  failures: number
}

export class ProjectRoom extends DurableObject<Env> {
  private readonly sql: SqlStorage

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.sql = ctx.storage.sql
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS pending (
        id            TEXT PRIMARY KEY,
        project_id    TEXT NOT NULL,
        verify_url    TEXT NOT NULL,
        payment_hash  TEXT NOT NULL,
        amount_msat   INTEGER NOT NULL,
        created_at    INTEGER NOT NULL,
        expires_at    INTEGER NOT NULL,
        next_check_at INTEGER NOT NULL,
        failures      INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS pending_next ON pending(next_check_at);
    `)
    // Answered by the runtime without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(WS_PING, WS_PONG))
  }

  // ─── RPC ────────────────────────────────────────────────────────────────────

  async trackInvoice(inv: TrackInvoiceInput): Promise<TrackInvoiceResult> {
    const count = this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM pending').one().n
    if (count >= MAX_PENDING) return { ok: false, reason: 'too_many_pending' }
    const nextCheckAt = Date.now() + pollInterval(0)
    this.sql.exec(
      `INSERT OR IGNORE INTO pending (id, project_id, verify_url, payment_hash, amount_msat, created_at, expires_at, next_check_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      inv.id, inv.projectId, inv.verifyUrl, inv.paymentHash, inv.amountMsat, inv.createdAt, inv.expiresAt, nextCheckAt,
    )
    await this.scheduleAt(nextCheckAt)
    return { ok: true }
  }

  // ─── WebSocket ──────────────────────────────────────────────────────────────

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('expected websocket', { status: 426 })
    }
    if (this.ctx.getWebSockets().length >= MAX_SOCKETS) {
      return new Response('too many connections', { status: 503 })
    }
    const projectId = request.headers.get('x-project-id') ?? ''
    const invoiceId = new URL(request.url).searchParams.get('invoice')

    const { 0: client, 1: server } = new WebSocketPair()
    const tags = ['all']
    if (invoiceId && /^[0-9a-z]{1,40}$/.test(invoiceId)) tags.push(`inv:${invoiceId}`)
    this.ctx.acceptWebSocket(server, tags)
    server.send(JSON.stringify({ type: 'hello', projectId, serverTime: Date.now() } satisfies WsServerMessage))
    return new Response(null, { status: 101, webSocket: client })
  }

  override async webSocketMessage(_ws: WebSocket, _message: string | ArrayBuffer): Promise<void> {
    // Clients have nothing to say beyond "ping", which the auto-response handles.
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      ws.close(code === 1005 ? 1000 : code, reason)
    } catch {
      // already closed
    }
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    try {
      ws.close(1011, 'error')
    } catch {
      // already closed
    }
  }

  private send(tag: string, msg: WsServerMessage): void {
    const data = JSON.stringify(msg)
    for (const ws of this.ctx.getWebSockets(tag)) {
      try {
        ws.send(data)
      } catch {
        // socket is closing; the runtime will clean it up
      }
    }
  }

  // ─── Payment polling ────────────────────────────────────────────────────────

  override async alarm(): Promise<void> {
    const now = Date.now()
    const due = this.sql
      .exec<PendingRow>('SELECT * FROM pending WHERE next_check_at <= ? ORDER BY next_check_at LIMIT ?', now + 500, MAX_POLLS_PER_ALARM)
      .toArray()
    // Checks are independent; one bad wallet must not block the others.
    await Promise.allSettled(due.map((row) => this.check(row, now)))
    await this.scheduleNext()
  }

  private async check(row: PendingRow, now: number): Promise<void> {
    let settled = false
    let preimage: string | null = null
    try {
      const res = await verifyPayment(row.verify_url)
      if (res.settled) {
        if (res.preimage && !(await preimageMatches(res.preimage, row.payment_hash))) {
          console.warn('verify: preimage does not match payment hash', { invoice: row.id })
        } else {
          settled = true
          preimage = res.preimage
        }
      }
    } catch (e) {
      console.warn('verify failed', { invoice: row.id, error: e instanceof Error ? e.message : String(e) })
      this.sql.exec('UPDATE pending SET failures = failures + 1 WHERE id = ?', row.id)
    }

    if (settled) return this.settle(row, preimage, now)
    if (now >= row.expires_at + EXPIRY_GRACE_MS) return this.expire(row)

    // Back off harder while the wallet's verify endpoint keeps failing.
    const backoff = Math.min(2 ** row.failures, 8)
    const next = Math.min(now + pollInterval(now - row.created_at) * backoff, row.expires_at + EXPIRY_GRACE_MS)
    this.sql.exec('UPDATE pending SET next_check_at = ? WHERE id = ?', Math.max(next, now + 1000), row.id)
  }

  private async settle(row: PendingRow, preimage: string | null, now: number): Promise<void> {
    const db = getDb(this.env.DB)
    const stillPending = and(eq(invoices.id, row.id), eq(invoices.status, 'pending'))
    // One D1 batch = one transaction. The project update is conditional on the invoice
    // still being pending, so a retried alarm can never double-count a payment.
    const [projectRows, invoiceRows] = await db.batch([
      db
        .update(projects)
        .set({
          raisedMsat: sql`${projects.raisedMsat} + ${row.amount_msat}`,
          supporterCount: sql`${projects.supporterCount} + 1`,
        })
        .where(and(eq(projects.id, row.project_id), exists(db.select({ one: sql`1` }).from(invoices).where(stillPending))))
        .returning({ raisedMsat: projects.raisedMsat, supporterCount: projects.supporterCount }),
      db
        .update(invoices)
        .set({ status: 'paid', paidAt: now, preimage })
        .where(stillPending)
        .returning({
          id: invoices.id,
          supporterName: invoices.supporterName,
          supporterPubkey: invoices.supporterPubkey,
          comment: invoices.comment,
          amountMsat: invoices.amountMsat,
          paidAt: invoices.paidAt,
        }),
    ])
    this.sql.exec('DELETE FROM pending WHERE id = ?', row.id)

    const stats = projectRows[0]
    const inv = invoiceRows[0]
    if (!stats || !inv) return // already handled elsewhere
    this.send('all', {
      type: 'payment',
      supporter: toSupporter(inv),
      stats: { raisedSats: msatToSats(stats.raisedMsat), supporterCount: stats.supporterCount },
    } satisfies WsPaymentMessage)
    this.send(`inv:${row.id}`, { type: 'invoice', invoiceId: row.id, status: 'paid' } satisfies WsInvoiceMessage)
  }

  private async expire(row: PendingRow): Promise<void> {
    const db = getDb(this.env.DB)
    await db
      .update(invoices)
      .set({ status: 'expired' })
      .where(and(eq(invoices.id, row.id), eq(invoices.status, 'pending')))
    this.sql.exec('DELETE FROM pending WHERE id = ?', row.id)
    this.send(`inv:${row.id}`, { type: 'invoice', invoiceId: row.id, status: 'expired' } satisfies WsInvoiceMessage)
  }

  private async scheduleNext(): Promise<void> {
    const next = this.sql.exec<{ t: number | null }>('SELECT MIN(next_check_at) AS t FROM pending').one().t
    if (next === null) await this.ctx.storage.deleteAlarm()
    else await this.ctx.storage.setAlarm(Math.max(next, Date.now() + 1000))
  }

  private async scheduleAt(t: number): Promise<void> {
    const current = await this.ctx.storage.getAlarm()
    if (current === null || current > t) await this.ctx.storage.setAlarm(t)
  }
}

async function preimageMatches(preimageHex: string, paymentHash: string): Promise<boolean> {
  const bytes = hexToBytes(preimageHex)
  if (!bytes || bytes.length !== 32) return false
  return (await sha256Hex(bytes)) === paymentHash
}
