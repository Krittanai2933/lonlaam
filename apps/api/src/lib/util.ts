import { bytesToHex } from './hex'

export { bytesToHex, hexToBytes } from './hex'

const ID_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz' // Crockford base32, lowercase

/** 20 chars ≈ 100 bits of randomness; URL-safe and unguessable. */
export function newId(len = 20): string {
  const bytes = crypto.getRandomValues(new Uint8Array(len))
  let s = ''
  for (const b of bytes) s += ID_ALPHABET[b & 31]
  return s
}

export function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return 'np_' + btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** 32 random bytes as hex (LNURL-auth k1, Nostr challenge). */
export const randomHex32 = () => bytesToHex(crypto.getRandomValues(new Uint8Array(32)))

export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const data = typeof input === 'string' ? new TextEncoder().encode(input) : input
  return bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', data)))
}

export const msatToSats = (msat: number) => Math.floor(msat / 1000)

/**
 * Fetch JSON from an untrusted third party with a timeout and a body-size cap,
 * so a hostile endpoint can't burn CPU with a huge payload.
 */
export async function fetchJsonLimited(
  url: string,
  { timeoutMs = 5000, maxBytes = 64 * 1024 }: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<unknown> {
  const res = await fetch(url, {
    headers: { accept: 'application/json' },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  })
  const declared = Number(res.headers.get('content-length') ?? '0')
  if (declared > maxBytes) {
    await res.body?.cancel()
    throw new Error(`response too large (${declared} bytes)`)
  }
  if (!res.body) throw new Error(`empty response (HTTP ${res.status})`)
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel()
      throw new Error('response too large')
    }
    chunks.push(value)
  }
  const buf = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    buf.set(c, off)
    off += c.byteLength
  }
  const text = new TextDecoder().decode(buf)
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`invalid JSON (HTTP ${res.status})`)
  }
}
