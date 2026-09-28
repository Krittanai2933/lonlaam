/**
 * bech32 (BIP-173) without the 90-character limit, as used by BOLT11, LNURL (LUD-01)
 * and Nostr (NIP-19).
 */

export const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
const CHARSET_REV: Record<string, number> = Object.fromEntries([...BECH32_CHARSET].map((c, i) => [c, i]))
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]

export class Bech32Error extends Error {}

function polymod(values: number[]): number {
  let chk = 1
  for (const v of values) {
    const b = chk >> 25
    chk = ((chk & 0x1ffffff) << 5) ^ v
    for (let i = 0; i < 5; i++) if ((b >> i) & 1) chk ^= GEN[i]!
  }
  return chk
}

function hrpExpand(hrp: string): number[] {
  const out: number[] = []
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) >> 5)
  out.push(0)
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) & 31)
  return out
}

function checksum(hrp: string, words: number[]): number[] {
  const mod = polymod([...hrpExpand(hrp), ...words, 0, 0, 0, 0, 0, 0]) ^ 1
  return Array.from({ length: 6 }, (_, i) => (mod >> (5 * (5 - i))) & 31)
}

/** Decodes to hrp + 5-bit words (checksum removed). Input may be upper or lower case. */
export function bech32Decode(input: string, maxLength = 7089): { hrp: string; words: number[] } {
  if (input.length > maxLength) throw new Bech32Error('too long')
  if (input !== input.toLowerCase() && input !== input.toUpperCase()) throw new Bech32Error('mixed case')
  const s = input.toLowerCase()
  const sep = s.lastIndexOf('1')
  if (sep < 1 || sep + 7 > s.length) throw new Bech32Error('missing separator')
  const hrp = s.slice(0, sep)
  const words: number[] = []
  for (const c of s.slice(sep + 1)) {
    const v = CHARSET_REV[c]
    if (v === undefined) throw new Bech32Error('invalid character')
    words.push(v)
  }
  if (polymod([...hrpExpand(hrp), ...words]) !== 1) throw new Bech32Error('bad checksum')
  return { hrp, words: words.slice(0, -6) }
}

export function bech32Encode(hrp: string, words: number[]): string {
  return hrp + '1' + [...words, ...checksum(hrp, words)].map((w) => BECH32_CHARSET[w]).join('')
}

/** 8-bit bytes → 5-bit words, padded. */
export function toWords(bytes: Uint8Array): number[] {
  const out: number[] = []
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

/** 5-bit words → 8-bit bytes. With `strict`, non-zero or over-long padding is rejected. */
export function fromWords(words: number[], strict = true): Uint8Array {
  const out: number[] = []
  let acc = 0
  let bits = 0
  for (const w of words) {
    acc = ((acc << 5) | w) & 0x1fff
    bits += 5
    while (bits >= 8) {
      bits -= 8
      out.push((acc >> bits) & 0xff)
    }
  }
  if (strict && (bits >= 5 || (acc & ((1 << bits) - 1)) !== 0)) throw new Bech32Error('invalid padding')
  return Uint8Array.from(out)
}

export const encodeLnurl = (url: string) => bech32Encode('lnurl', toWords(new TextEncoder().encode(url)))

export const encodeNpub = (pubkeyHex: string) => bech32Encode('npub', toWords(hexToBytesStrict(pubkeyHex)))

/** Returns the 32-byte hex pubkey, or null if `npub` is not a valid npub. */
export function decodeNpub(npub: string): string | null {
  try {
    const { hrp, words } = bech32Decode(npub.trim(), 200)
    if (hrp !== 'npub') return null
    const bytes = fromWords(words)
    if (bytes.length !== 32) return null
    let hex = ''
    for (const b of bytes) hex += b.toString(16).padStart(2, '0')
    return hex
  } catch {
    return null
  }
}

function hexToBytesStrict(hex: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})+$/i.test(hex)) throw new Bech32Error('invalid hex')
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}
