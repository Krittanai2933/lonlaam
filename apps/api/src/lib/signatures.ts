/**
 * secp256k1 signature checks for login: BIP-340 Schnorr (Nostr, NIP-01) and
 * DER ECDSA (LNURL-auth, LUD-04). ~1–2ms CPU each with @noble/curves.
 */
import type { NostrEvent } from '@nampu/types'
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js'
import { hexToBytes } from './hex'
import { sha256Hex } from './util'

const HEX64 = /^[0-9a-f]{64}$/
const HEX128 = /^[0-9a-f]{128}$/

/** NIP-01 event id: sha256 of the canonical serialization. */
export const nostrEventId = (e: Omit<NostrEvent, 'id' | 'sig'>) =>
  sha256Hex(JSON.stringify([0, e.pubkey, e.created_at, e.kind, e.tags, e.content]))

export async function verifyNostrEvent(e: NostrEvent): Promise<boolean> {
  if (!HEX64.test(e.id) || !HEX64.test(e.pubkey) || !HEX128.test(e.sig)) return false
  if ((await nostrEventId(e)) !== e.id) return false
  try {
    return schnorr.verify(hexToBytes(e.sig)!, hexToBytes(e.id)!, hexToBytes(e.pubkey)!)
  } catch {
    return false
  }
}

/** LUD-04: `sig` is DER-encoded ECDSA over the raw 32-byte k1; `key` is a compressed pubkey. */
export function verifyLnurlAuth(k1Hex: string, sigHex: string, keyHex: string): boolean {
  const k1 = HEX64.test(k1Hex) ? hexToBytes(k1Hex) : null
  const sig = /^[0-9a-f]{16,146}$/.test(sigHex) ? hexToBytes(sigHex) : null
  const key = /^0[23][0-9a-f]{64}$/.test(keyHex) ? hexToBytes(keyHex) : null
  if (!k1 || !sig || !key) return false
  try {
    // lowS: false — LUD-04 doesn't require low-S, and k1 is single-use so malleability is harmless.
    return secp256k1.verify(sig, k1, key, { prehash: false, format: 'der', lowS: false })
  } catch {
    return false
  }
}
