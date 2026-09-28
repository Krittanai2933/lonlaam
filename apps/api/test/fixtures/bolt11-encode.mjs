// Test-only BOLT11 encoder (unsigned: the signature is zero bytes, which the
// worker's decoder does not check). Shared by unit tests and the mock wallet.
import { createHash, randomBytes } from 'node:crypto'

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]

function polymod(values) {
  let chk = 1
  for (const v of values) {
    const b = chk >> 25
    chk = ((chk & 0x1ffffff) << 5) ^ v
    for (let i = 0; i < 5; i++) if ((b >> i) & 1) chk ^= GEN[i]
  }
  return chk
}
const hrpExpand = (hrp) => [...[...hrp].map((c) => c.charCodeAt(0) >> 5), 0, ...[...hrp].map((c) => c.charCodeAt(0) & 31)]

function toWords(bytes) {
  const out = []
  let acc = 0
  let bits = 0
  for (const b of bytes) {
    acc = ((acc << 8) | b) & 0xffff
    bits += 8
    while (bits >= 5) {
      bits -= 5
      out.push((acc >> bits) & 31)
    }
  }
  if (bits > 0) out.push((acc << (5 - bits)) & 31)
  return out
}
const intWords = (n, len) => Array.from({ length: len }, (_, i) => Math.floor(n / 32 ** (len - 1 - i)) % 32)
const tagged = (tag, words) => [CHARSET.indexOf(tag), words.length >> 5, words.length & 31, ...words]

/** amount in msat must be a multiple of 100 (encoded with the 'n' multiplier). */
export function encodeBolt11({ amountMsat, paymentHash, timestamp = Math.floor(Date.now() / 1000), expiry = 600, network = 'bc' }) {
  if (amountMsat % 100 !== 0) throw new Error('fixture supports msat multiples of 100 only')
  const hrp = `ln${network}${amountMsat / 100}n`
  const data = [
    ...intWords(timestamp, 7),
    ...tagged('p', toWords(Buffer.from(paymentHash, 'hex'))),
    ...tagged('d', toWords(Buffer.from('nampu test'))),
    ...tagged('x', minimalWords(expiry)),
    ...toWords(new Uint8Array(65)),
  ]
  const mod = polymod([...hrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0]) ^ 1
  const checksum = Array.from({ length: 6 }, (_, i) => (mod >> (5 * (5 - i))) & 31)
  return hrp + '1' + [...data, ...checksum].map((w) => CHARSET[w]).join('')
}

function minimalWords(n) {
  const w = []
  do {
    w.unshift(n % 32)
    n = Math.floor(n / 32)
  } while (n > 0)
  return w
}

export function newPreimage() {
  const preimage = randomBytes(32)
  return { preimage: preimage.toString('hex'), paymentHash: createHash('sha256').update(preimage).digest('hex') }
}
