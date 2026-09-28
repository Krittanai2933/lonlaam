import { NOSTR_AUTH_KIND, type NostrEvent } from '@nampu/types'
import { api } from './api'

interface Nip07 {
  getPublicKey(): Promise<string>
  signEvent(e: Omit<NostrEvent, 'id' | 'pubkey' | 'sig'>): Promise<NostrEvent>
}

declare global {
  interface Window {
    nostr?: Nip07
  }
}

/** Relays used for NIP-46 and profile lookups. */
export const RELAYS = ['wss://relay.nsec.app', 'wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net']

export const hasNip07 = () => typeof window !== 'undefined' && !!window.nostr

type SignFn = (template: { kind: number; created_at: number; tags: string[][]; content: string }) => Promise<NostrEvent>

async function loginWith(sign: SignFn) {
  const { challenge } = await api.nostrChallenge()
  const event = await sign({
    kind: NOSTR_AUTH_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['challenge', challenge],
      ['relay', window.location.origin],
    ],
    content: '',
  })
  return { login: await api.nostrLogin(event), pubkey: event.pubkey }
}

/** NIP-07 browser extension (Alby, nos2x, …). */
export async function loginWithExtension() {
  if (!window.nostr) throw new Error('no NIP-07 extension')
  return loginWith((t) => window.nostr!.signEvent(t))
}

// NIP-46 needs relays + NIP-44; loaded only when the user picks it.
const nip46 = () => import('nostr-tools/nip46')
const pure = () => import('nostr-tools/pure')

/** bunker://… or name@nsec.app (NIP-05) pasted by the user. */
export async function loginWithBunker(input: string, onAuthUrl: (url: string) => void) {
  const [{ BunkerSigner, parseBunkerInput }, { generateSecretKey }] = await Promise.all([nip46(), pure()])
  const bp = await parseBunkerInput(input.trim())
  if (!bp) throw new BunkerInputError()
  const signer = BunkerSigner.fromBunker(generateSecretKey(), bp, { onauth: onAuthUrl })
  try {
    await signer.connect()
    return await loginWith((t) => signer.signEvent(t) as Promise<NostrEvent>)
  } finally {
    void signer.close()
  }
}

export class BunkerInputError extends Error {}

/**
 * Client-initiated NIP-46 (nostrconnect://) for signer apps such as Amber/nsec.app.
 * Returns the URI to open/show, and a promise that resolves once the app connects and signs.
 */
export async function startSignerApp(signal: AbortSignal) {
  const [{ BunkerSigner, createNostrConnectURI }, { generateSecretKey, getPublicKey }] = await Promise.all([nip46(), pure()])
  const sk = generateSecretKey()
  const secret = crypto.getRandomValues(new Uint32Array(2)).join('')
  const uri = createNostrConnectURI({
    clientPubkey: getPublicKey(sk),
    relays: RELAYS.slice(0, 2),
    secret,
    name: 'Lonlaam',
    url: window.location.origin,
    perms: [`sign_event:${NOSTR_AUTH_KIND}`],
  })
  const done = (async () => {
    const signer = await BunkerSigner.fromURI(sk, uri, {}, signal)
    try {
      return await loginWith((t) => signer.signEvent(t) as Promise<NostrEvent>)
    } finally {
      void signer.close()
    }
  })()
  return { uri, done }
}

export interface NostrProfile {
  name?: string
  display_name?: string
  displayName?: string
}

/** Best-effort kind-0 lookup over raw WebSockets (no library), for onboarding prefill. */
export function fetchProfile(pubkey: string, timeoutMs = 3500): Promise<NostrProfile | null> {
  return new Promise((resolve) => {
    const sockets: WebSocket[] = []
    let best: { created_at: number; content: string } | null = null
    let pending = RELAYS.length
    const finish = () => {
      sockets.forEach((s) => s.close())
      clearTimeout(timer)
      try {
        resolve(best ? (JSON.parse(best.content) as NostrProfile) : null)
      } catch {
        resolve(null)
      }
    }
    const timer = setTimeout(finish, timeoutMs)
    for (const url of RELAYS) {
      try {
        const ws = new WebSocket(url)
        sockets.push(ws)
        ws.onopen = () => ws.send(JSON.stringify(['REQ', 'p', { kinds: [0], authors: [pubkey], limit: 1 }]))
        ws.onmessage = (m) => {
          const msg = JSON.parse(String(m.data)) as unknown[]
          if (msg[0] === 'EVENT') {
            const ev = msg[2] as { created_at: number; content: string }
            if (!best || ev.created_at > best.created_at) best = ev
          } else if (msg[0] === 'EOSE') {
            ws.close()
            if (--pending === 0 || best) finish()
          }
        }
        ws.onerror = () => --pending === 0 && finish()
      } catch {
        --pending
      }
    }
  })
}
