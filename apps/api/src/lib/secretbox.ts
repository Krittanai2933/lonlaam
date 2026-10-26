/**
 * AES-256-GCM for secrets we must keep but never show again (a supporter's NWC connection
 * string). The key is the NWC_ENC_KEY secret (64 hex chars); `context` (the owner's id) is bound
 * as additional data, so a sealed value copied to another row doesn't open.
 * Format: base64url(12-byte IV ‖ ciphertext+tag).
 */
import { hexToBytes } from './hex'

const keys = new Map<string, Promise<CryptoKey>>()

export const secretboxEnabled = (env: Env) => /^[0-9a-f]{64}$/i.test(env.NWC_ENC_KEY ?? '')

function key(env: Env): Promise<CryptoKey> {
  const hex = env.NWC_ENC_KEY ?? ''
  if (!secretboxEnabled(env)) throw new Error('NWC_ENC_KEY is missing or not 64 hex chars')
  let k = keys.get(hex)
  if (!k) {
    k = crypto.subtle.importKey('raw', hexToBytes(hex.toLowerCase())!, 'AES-GCM', false, ['encrypt', 'decrypt'])
    keys.set(hex, k)
  }
  return k
}

const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const unb64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))

export async function seal(env: Env, plaintext: string, context: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(context) }, await key(env), new TextEncoder().encode(plaintext))
  const out = new Uint8Array(12 + ct.byteLength)
  out.set(iv)
  out.set(new Uint8Array(ct), 12)
  return b64url(out)
}

/** Throws if the key is wrong, the data was altered, or it was sealed for another context. */
export async function unseal(env: Env, sealed: string, context: string): Promise<string> {
  const data = unb64url(sealed)
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: data.slice(0, 12), additionalData: new TextEncoder().encode(context) }, await key(env), data.slice(12))
  return new TextDecoder().decode(pt)
}
