/**
 * Minimal BOLT11 decoder: amount, timestamp, expiry and payment hash only.
 *
 * It deliberately skips signature verification: the invoice comes from the creator's
 * own LNURL-pay server, and settlement is confirmed separately via LUD-21 by checking
 * sha256(preimage) === paymentHash.
 */
import { BECH32_CHARSET, Bech32Error, bech32Decode, fromWords } from '../lib/bech32'
import { bytesToHex } from '../lib/hex'

const MULTIPLIER_MSAT: Record<string, bigint> = {
  // 1 BTC = 1e11 msat
  m: 100_000_000n, // milli-BTC
  u: 100_000n, // micro-BTC
  n: 100n, // nano-BTC
}

export interface DecodedBolt11 {
  network: string
  /** null when the invoice has no amount (we reject those). */
  amountMsat: number | null
  /** Unix seconds. */
  timestamp: number
  /** Seconds; BOLT11 default is 3600 when the `x` tag is absent. */
  expiry: number
  /** Lowercase hex, 32 bytes. */
  paymentHash: string
}

export class Bolt11Error extends Error {}

export function decodeBolt11(invoice: string): DecodedBolt11 {
  const pr = invoice.trim().toLowerCase().replace(/^lightning:/, '')
  let hrp: string
  let data: number[]
  try {
    ;({ hrp, words: data } = bech32Decode(pr))
  } catch (e) {
    throw new Bolt11Error(e instanceof Bech32Error ? e.message : 'invalid bech32')
  }
  // 104 signature words (65 bytes) + 7 timestamp words minimum.
  if (data.length < 104 + 7) throw new Bolt11Error('too short')

  const m = /^ln(bc|tb|bcrt|tbs|sb)(\d*)([munp]?)$/.exec(hrp)
  if (!m) throw new Bolt11Error('unknown prefix')
  const [, network = '', amountStr = '', mult = ''] = m
  const amountMsat = parseAmount(amountStr, mult)

  const words = data.slice(0, data.length - 104)
  const timestamp = wordsToInt(words.slice(0, 7))
  let expiry = 3600
  let paymentHash: string | null = null

  let i = 7
  while (i + 3 <= words.length) {
    const tag = BECH32_CHARSET[words[i]!]
    const len = (words[i + 1]! << 5) | words[i + 2]!
    const field = words.slice(i + 3, i + 3 + len)
    if (field.length !== len) throw new Bolt11Error('truncated field')
    i += 3 + len
    if (tag === 'p' && len === 52 && paymentHash === null) {
      paymentHash = bytesToHex(fromWords(field, false))
    } else if (tag === 'x') {
      expiry = wordsToInt(field)
    }
  }
  if (!paymentHash) throw new Bolt11Error('missing payment hash')
  return { network, amountMsat, timestamp, expiry, paymentHash }
}

function parseAmount(amount: string, mult: string): number | null {
  if (!amount) return null
  const n = BigInt(amount)
  let msat: bigint
  if (!mult) msat = n * 100_000_000_000n
  else if (mult === 'p') {
    // 1 pico-BTC = 0.1 msat; must be a whole msat.
    if (n % 10n !== 0n) throw new Bolt11Error('sub-msat amount')
    msat = n / 10n
  } else msat = n * MULTIPLIER_MSAT[mult]!
  if (msat > BigInt(Number.MAX_SAFE_INTEGER)) throw new Bolt11Error('amount too large')
  return Number(msat)
}

function wordsToInt(words: number[]): number {
  let v = 0
  for (const w of words) v = v * 32 + w
  return v
}
