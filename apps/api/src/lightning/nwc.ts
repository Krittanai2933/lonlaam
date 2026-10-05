/**
 * Nostr Wallet Connect (NIP-47) client for the platform wallet used by sprinkles.
 *
 * One `NwcClient` = one outbound WebSocket to the wallet's relay (1 subrequest). Requests are
 * kind-23194 events encrypted to the wallet; responses are kind-23195 events tagged with the
 * request id. NIP-44 is used when the wallet's info event advertises it, else NIP-04.
 */
import * as nip04 from 'nostr-tools/nip04'
import * as nip44 from 'nostr-tools/nip44'
import { finalizeEvent, verifyEvent, type Event } from 'nostr-tools/pure'
import { hexToBytes } from '../lib/util'

const INFO_KIND = 13194
const REQUEST_KIND = 23194
const RESPONSE_KIND = 23195

export interface NwcConnection {
  walletPubkey: string
  relay: string
  secret: Uint8Array
}

export class NwcError extends Error {
  constructor(
    /** NIP-47 error code (PAYMENT_FAILED, INSUFFICIENT_BALANCE, …), or TIMEOUT / RELAY for transport problems. */
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
  /** The wallet may or may not have acted on the request (no answer). */
  get ambiguous() {
    return this.code === 'TIMEOUT' || this.code === 'RELAY'
  }
}

/** nostr+walletconnect://<wallet pubkey>?relay=<wss url>&secret=<hex> */
export function parseNwcUrl(url: string): NwcConnection {
  let u: URL
  try {
    u = new URL(url.trim())
  } catch {
    throw new Error('NWC: not a URL')
  }
  if (u.protocol !== 'nostr+walletconnect:') throw new Error('NWC: expected nostr+walletconnect://')
  const walletPubkey = (u.host || u.pathname.replace(/^\/+/, '')).toLowerCase()
  const relay = u.searchParams.get('relay')
  const secret = hexToBytes(u.searchParams.get('secret') ?? '')
  if (!/^[0-9a-f]{64}$/.test(walletPubkey)) throw new Error('NWC: invalid wallet pubkey')
  if (!relay || !/^wss?:\/\//.test(relay)) throw new Error('NWC: missing relay')
  if (!secret || secret.length !== 32) throw new Error('NWC: invalid secret')
  return { walletPubkey, relay, secret }
}

export interface MakeInvoiceResult {
  invoice: string
  paymentHash: string
  expiresAt: number | null
}

export interface LookupInvoiceResult {
  settled: boolean
  preimage: string | null
}

export interface PayInvoiceResult {
  preimage: string
  feesPaidMsat: number | null
}

type Waiter = { resolve: (e: Event) => void; reject: (e: Error) => void; eose?: () => void }

export class NwcClient {
  private readonly waiters = new Map<string, Waiter>()
  private encryption: 'nip04' | 'nip44_v2' = 'nip04'
  private closed = false

  private constructor(
    private readonly conn: NwcConnection,
    private readonly ws: WebSocket,
  ) {
    ws.addEventListener('message', (m) => this.onMessage(m.data))
    ws.addEventListener('close', () => this.fail(new NwcError('RELAY', 'relay connection closed')))
    ws.addEventListener('error', () => this.fail(new NwcError('RELAY', 'relay connection error')))
  }

  static async connect(conn: NwcConnection, { timeoutMs = 8000 } = {}): Promise<NwcClient> {
    // Workers open outbound WebSockets with an Upgrade fetch (http(s) scheme).
    const url = conn.relay.replace(/^ws/, 'http')
    let res: Response
    try {
      res = await fetch(url, { headers: { upgrade: 'websocket' }, signal: AbortSignal.timeout(timeoutMs) })
    } catch (e) {
      throw new NwcError('RELAY', `cannot reach relay: ${e instanceof Error ? e.message : String(e)}`)
    }
    const ws = res.webSocket
    if (!ws) throw new NwcError('RELAY', `relay refused WebSocket (HTTP ${res.status})`)
    ws.accept()
    const client = new NwcClient(conn, ws)
    await client.detectEncryption(timeoutMs)
    return client
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    try {
      this.ws.close(1000, 'done')
    } catch {
      // already closed
    }
  }

  async makeInvoice(amountMsat: number, description: string, expirySecs: number): Promise<MakeInvoiceResult> {
    const r = await this.request('make_invoice', { amount: amountMsat, description, expiry: expirySecs })
    if (typeof r.invoice !== 'string' || typeof r.payment_hash !== 'string') throw new NwcError('OTHER', 'make_invoice: bad result')
    return { invoice: r.invoice, paymentHash: r.payment_hash.toLowerCase(), expiresAt: typeof r.expires_at === 'number' ? r.expires_at * 1000 : null }
  }

  async lookupInvoice(paymentHash: string): Promise<LookupInvoiceResult> {
    const r = await this.request('lookup_invoice', { payment_hash: paymentHash })
    const settled = (typeof r.settled_at === 'number' && r.settled_at > 0) || r.state === 'settled'
    return { settled, preimage: typeof r.preimage === 'string' && r.preimage ? r.preimage.toLowerCase() : null }
  }

  async payInvoice(bolt11: string, timeoutMs = 45_000): Promise<PayInvoiceResult> {
    const r = await this.request('pay_invoice', { invoice: bolt11 }, timeoutMs)
    if (typeof r.preimage !== 'string') throw new NwcError('OTHER', 'pay_invoice: no preimage')
    return { preimage: r.preimage.toLowerCase(), feesPaidMsat: typeof r.fees_paid === 'number' ? r.fees_paid : null }
  }

  // ─── Protocol ───────────────────────────────────────────────────────────────

  /** Uses NIP-44 if the wallet's replaceable info event lists it (NIP-47 "encryption" tag). */
  private async detectEncryption(timeoutMs: number): Promise<void> {
    const sub = `i${crypto.randomUUID().slice(0, 8)}`
    let info: Event | null = null
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs)
      this.waiters.set(sub, {
        resolve: (e) => {
          info = e
        },
        reject: () => {
          clearTimeout(timer)
          resolve()
        },
        eose: () => {
          clearTimeout(timer)
          resolve()
        },
      })
      this.send(['REQ', sub, { kinds: [INFO_KIND], authors: [this.conn.walletPubkey], limit: 1 }])
    })
    this.waiters.delete(sub)
    this.send(['CLOSE', sub])
    const tag = (info as Event | null)?.tags.find((t) => t[0] === 'encryption')?.[1] ?? ''
    if (tag.split(/\s+/).includes('nip44_v2')) this.encryption = 'nip44_v2'
  }

  private async request(method: string, params: Record<string, unknown>, timeoutMs = 15_000): Promise<Record<string, unknown>> {
    if (this.closed) throw new NwcError('RELAY', 'client closed')
    const plaintext = JSON.stringify({ method, params })
    const tags = [['p', this.conn.walletPubkey]]
    if (this.encryption === 'nip44_v2') tags.push(['encryption', 'nip44_v2'])
    const event = finalizeEvent(
      { kind: REQUEST_KIND, created_at: Math.floor(Date.now() / 1000), tags, content: this.encrypt(plaintext) },
      this.conn.secret,
    )
    const sub = `r${event.id.slice(0, 12)}`
    const response = new Promise<Event>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(sub)
        reject(new NwcError('TIMEOUT', `${method}: no answer from wallet`))
      }, timeoutMs)
      this.waiters.set(sub, {
        resolve: (e) => {
          clearTimeout(timer)
          this.waiters.delete(sub)
          resolve(e)
        },
        reject: (err) => {
          clearTimeout(timer)
          this.waiters.delete(sub)
          reject(err)
        },
      })
    })
    // Subscribe before publishing so the answer can't slip past.
    this.send(['REQ', sub, { kinds: [RESPONSE_KIND], authors: [this.conn.walletPubkey], '#e': [event.id] }])
    this.send(['EVENT', event])
    const reply = await response
    this.send(['CLOSE', sub])

    let body: { result_type?: string; error?: { code?: string; message?: string } | null; result?: Record<string, unknown> | null }
    try {
      body = JSON.parse(this.decrypt(reply.content))
    } catch {
      throw new NwcError('OTHER', `${method}: undecryptable response`)
    }
    if (body.error) throw new NwcError(String(body.error.code ?? 'OTHER'), `${method}: ${String(body.error.message ?? 'wallet error').slice(0, 200)}`)
    if (!body.result) throw new NwcError('OTHER', `${method}: empty result`)
    return body.result
  }

  private encrypt(text: string): string {
    if (this.encryption === 'nip44_v2') return nip44.encrypt(text, nip44.getConversationKey(this.conn.secret, this.conn.walletPubkey))
    return nip04.encrypt(this.conn.secret, this.conn.walletPubkey, text)
  }

  private decrypt(payload: string): string {
    // Wallets answer in the scheme they were asked in, but accept either (NIP-04 payloads contain "?iv=").
    if (payload.includes('?iv=')) return nip04.decrypt(this.conn.secret, this.conn.walletPubkey, payload)
    return nip44.decrypt(payload, nip44.getConversationKey(this.conn.secret, this.conn.walletPubkey))
  }

  private onMessage(data: unknown): void {
    if (typeof data !== 'string') return
    let msg: unknown[]
    try {
      msg = JSON.parse(data)
    } catch {
      return
    }
    if (!Array.isArray(msg)) return
    const [type, a, b] = msg
    if (type === 'EVENT' && typeof a === 'string') {
      const w = this.waiters.get(a)
      const e = b as Event
      // Only the wallet's own signed events count; anyone can publish to a relay.
      if (w && e?.pubkey === this.conn.walletPubkey && verifyEvent(e)) w.resolve(e)
    } else if (type === 'EOSE' && typeof a === 'string') {
      this.waiters.get(a)?.eose?.()
    } else if (type === 'OK' && b === false) {
      const reason = String(msg[3] ?? 'rejected')
      for (const w of this.waiters.values()) w.reject(new NwcError('RELAY', `relay rejected request: ${reason.slice(0, 200)}`))
    } else if (type === 'CLOSED' && typeof a === 'string') {
      this.waiters.get(a)?.reject(new NwcError('RELAY', `relay closed subscription: ${String(b ?? '').slice(0, 200)}`))
    }
  }

  private send(msg: unknown[]): void {
    try {
      this.ws.send(JSON.stringify(msg))
    } catch {
      this.fail(new NwcError('RELAY', 'relay connection lost'))
    }
  }

  private fail(err: NwcError): void {
    for (const w of [...this.waiters.values()]) w.reject(err)
  }
}
