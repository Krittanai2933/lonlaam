/**
 * LNURL-pay (LUD-06/16), comments (LUD-12) and payment verification (LUD-21).
 * Each exported network call costs exactly one subrequest.
 */
import { ApiError } from '../lib/errors'
import { fetchJsonLimited } from '../lib/util'

export interface LnurlOptions {
  /** Dev only: allow http:// and host:port domains (for a local mock wallet). */
  allowInsecure: boolean
}

export interface PayRequest {
  callback: string
  minSendable: number
  maxSendable: number
  commentAllowed: number
}

export interface CallbackInvoice {
  pr: string
  verify: string
}

export interface VerifyResult {
  settled: boolean
  preimage: string | null
}

const NAME_RE = /^[a-z0-9\-_.+]{1,64}$/
const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/
const DEV_DOMAIN_RE = /^(?:localhost|127\.0\.0\.1|[a-z0-9.-]+)(?::\d{1,5})?$/

/** Normalizes and validates a Lightning Address; returns its LUD-16 well-known URL. */
export function lightningAddressUrl(address: string, opts: LnurlOptions): { address: string; url: string } {
  const normalized = address.trim().toLowerCase()
  const at = normalized.lastIndexOf('@')
  const name = normalized.slice(0, at)
  const domain = normalized.slice(at + 1)
  const domainOk = DOMAIN_RE.test(domain) || (opts.allowInsecure && DEV_DOMAIN_RE.test(domain))
  if (at < 1 || !NAME_RE.test(name) || !domainOk) {
    throw new ApiError(422, 'validation_failed', 'invalid Lightning Address', [
      { path: 'lightningAddress', message: 'expected name@domain' },
    ])
  }
  const scheme = opts.allowInsecure && !DOMAIN_RE.test(domain) ? 'http' : 'https'
  return { address: normalized, url: `${scheme}://${domain}/.well-known/lnurlp/${name}` }
}

function checkUrl(raw: unknown, what: string, opts: LnurlOptions): string {
  if (typeof raw !== 'string') throw lnurlError(`${what} missing`)
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    throw lnurlError(`${what} is not a URL`)
  }
  if (u.protocol !== 'https:' && !(opts.allowInsecure && u.protocol === 'http:')) {
    throw lnurlError(`${what} must be https`)
  }
  return u.toString()
}

const lnurlError = (msg: string) => new ApiError(502, 'lnurl_error', `LNURL: ${msg}`)

async function get(url: string): Promise<Record<string, unknown>> {
  let body: unknown
  try {
    body = await fetchJsonLimited(url)
  } catch (e) {
    throw lnurlError(e instanceof Error ? e.message : 'request failed')
  }
  if (typeof body !== 'object' || body === null) throw lnurlError('unexpected response')
  const obj = body as Record<string, unknown>
  if (obj.status === 'ERROR') throw lnurlError(String(obj.reason ?? 'wallet returned an error').slice(0, 200))
  return obj
}

export async function fetchPayRequest(address: string, opts: LnurlOptions): Promise<PayRequest> {
  const { url } = lightningAddressUrl(address, opts)
  const r = await get(url)
  if (r.tag !== 'payRequest') throw lnurlError('not a payRequest')
  const minSendable = Number(r.minSendable)
  const maxSendable = Number(r.maxSendable)
  if (!Number.isSafeInteger(minSendable) || !Number.isSafeInteger(maxSendable) || minSendable < 1 || maxSendable < minSendable) {
    // getalby.com (and others) advertise maxSendable 0 when no wallet is connected to the account.
    if (maxSendable === 0) {
      throw new ApiError(422, 'lnurl_cannot_receive', 'LNURL: this Lightning Address cannot receive payments right now (maxSendable is 0)')
    }
    throw lnurlError('invalid min/maxSendable')
  }
  const commentAllowed = Number.isSafeInteger(Number(r.commentAllowed)) ? Math.max(0, Number(r.commentAllowed)) : 0
  return { callback: checkUrl(r.callback, 'callback', opts), minSendable, maxSendable, commentAllowed }
}

async function callback(pay: PayRequest, amountMsat: number, comment: string | undefined) {
  const u = new URL(pay.callback)
  u.searchParams.set('amount', String(amountMsat))
  // LUD-12: only send a comment if the wallet accepts one, trimmed to its limit.
  if (comment && pay.commentAllowed > 0) u.searchParams.set('comment', comment.slice(0, pay.commentAllowed))
  const r = await get(u.toString())
  if (typeof r.pr !== 'string' || r.pr.length === 0) throw lnurlError('callback returned no invoice')
  return r as typeof r & { pr: string }
}

/**
 * An invoice we pay ourselves (forwarding the platform's share): the preimage is our proof,
 * so LUD-21 isn't required. Returns the BOLT11.
 */
export async function requestPlainInvoice(pay: PayRequest, amountMsat: number, comment: string | undefined): Promise<string> {
  return (await callback(pay, amountMsat, comment)).pr
}

export async function requestInvoice(
  pay: PayRequest,
  amountMsat: number,
  comment: string | undefined,
  opts: LnurlOptions,
): Promise<CallbackInvoice> {
  const r = await callback(pay, amountMsat, comment)
  if (r.verify === undefined || r.verify === null) {
    throw new ApiError(
      422,
      'lnurl_verify_unsupported',
      'This wallet does not support LUD-21 payment verification; use a Lightning Address provider that returns a `verify` URL.',
    )
  }
  return { pr: r.pr, verify: checkUrl(r.verify, 'verify', opts) }
}

/** LUD-21. Throws on network/format errors so the caller can back off and retry. */
export async function verifyPayment(verifyUrl: string): Promise<VerifyResult> {
  const r = await get(verifyUrl)
  if (r.status !== 'OK') throw new Error('verify: unexpected status')
  const settled = r.settled === true
  const preimage = typeof r.preimage === 'string' && r.preimage.length > 0 ? r.preimage.toLowerCase() : null
  return { settled, preimage }
}

/**
 * Checks that an address resolves and that its callback returns a LUD-21 `verify` URL,
 * by requesting (and discarding) an invoice for minSendable. Costs 2 subrequests.
 */
export async function probeLightningAddress(address: string, opts: LnurlOptions): Promise<string> {
  const { address: normalized } = lightningAddressUrl(address, opts)
  const pay = await fetchPayRequest(normalized, opts)
  await requestInvoice(pay, pay.minSendable, undefined, opts)
  return normalized
}
