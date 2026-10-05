import { NOSTR_AUTH_KIND, NOSTR_HTTP_AUTH_KIND, type NostrEvent } from '@nampu/types'
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

/** Relays used for NIP-46. */
export const RELAYS = ['wss://relay.nsec.app', 'wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net']
/** Relays for kind-0 lookups: purplepag.es indexes profiles; relay.nsec.app only carries NIP-46. */
const PROFILE_RELAYS = ['wss://purplepag.es', 'wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net']

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
  picture?: string
}

/** Best-effort kind-0 lookup over raw WebSockets (no library), for onboarding prefill. */
export async function fetchProfile(pubkey: string, timeoutMs = 3500): Promise<NostrProfile | null> {
  return (await fetchProfiles([pubkey], timeoutMs, true)).get(pubkey) ?? null
}

/**
 * Latest kind-0 per author from all PROFILE_RELAYS. Resolves when every relay has sent EOSE (or
 * failed), at the timeout, or — with `early` — as soon as every author has a profile.
 */
function fetchProfiles(authors: string[], timeoutMs: number, early = false): Promise<Map<string, NostrProfile>> {
  return new Promise((resolve) => {
    const sockets: WebSocket[] = []
    const best = new Map<string, { created_at: number; content: string }>()
    let pending = PROFILE_RELAYS.length
    let done = false
    const finish = () => {
      if (done) return
      done = true
      sockets.forEach((s) => s.close())
      clearTimeout(timer)
      const out = new Map<string, NostrProfile>()
      for (const [pk, ev] of best) {
        try {
          const p = JSON.parse(ev.content) as unknown
          if (p && typeof p === 'object') out.set(pk, p as NostrProfile)
        } catch {
          // skip malformed metadata
        }
      }
      resolve(out)
    }
    const relayDone = () => (--pending <= 0 || (early && best.size === authors.length)) && finish()
    const timer = setTimeout(finish, timeoutMs)
    for (const url of PROFILE_RELAYS) {
      try {
        const ws = new WebSocket(url)
        sockets.push(ws)
        // finish() may have closed it already (another relay answered first).
        ws.onopen = () => !done && ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(['REQ', 'p', { kinds: [0], authors, limit: authors.length }]))
        ws.onmessage = (m) => {
          const msg = JSON.parse(String(m.data)) as unknown[]
          if (msg[0] === 'EVENT') {
            const ev = msg[2] as { pubkey: string; created_at: number; content: string }
            const prev = best.get(ev.pubkey)
            if (authors.includes(ev.pubkey) && (!prev || ev.created_at > prev.created_at)) best.set(ev.pubkey, ev)
          } else if (msg[0] === 'EOSE') {
            ws.close()
            relayDone()
          }
        }
        ws.onerror = relayDone
      } catch {
        relayDone()
      }
    }
  })
}

// Supporter rows each ask for one profile; lookups made in the same tick share one REQ.
let queue = new Map<string, ((p: NostrProfile | null) => void)[]>()
let flushTimer: ReturnType<typeof setTimeout> | null = null

export function loadProfile(pubkey: string): Promise<NostrProfile | null> {
  return new Promise((resolve) => {
    queue.set(pubkey, [...(queue.get(pubkey) ?? []), resolve])
    flushTimer ??= setTimeout(() => {
      const batch = queue
      queue = new Map()
      flushTimer = null
      const authors = [...batch.keys()]
      for (let i = 0; i < authors.length; i += 100) {
        const chunk = authors.slice(i, i + 100)
        void fetchProfiles(chunk, 4000).then((found) => chunk.forEach((pk) => batch.get(pk)!.forEach((r) => r(found.get(pk) ?? null))))
      }
    }, 30)
  })
}

export const profileName = (p: NostrProfile | null | undefined) => (p?.display_name || p?.displayName || p?.name || '').trim()

/** Only https images, so a profile can't point the page at http: or data: URLs. */
export function profilePicture(p: NostrProfile | null | undefined): string | null {
  const raw = typeof p?.picture === 'string' ? p.picture.trim() : ''
  try {
    return raw.length < 2048 && new URL(raw).protocol === 'https:' ? raw : null
  } catch {
    return null
  }
}

/** NIP-98 proof that the supporter owns their pubkey, for POST /api/p/:slug/invoices. */
export function signSupporterProof(slug: string) {
  if (!window.nostr) throw new Error('no NIP-07 extension')
  return window.nostr.signEvent({
    kind: NOSTR_HTTP_AUTH_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['u', `${window.location.origin}/api/p/${encodeURIComponent(slug)}/invoices`],
      ['method', 'POST'],
    ],
    content: '',
  })
}

/** "npub1abcd…wxyz" */
export async function shortNpub(pubkey: string) {
  const { npubEncode } = await import('nostr-tools/nip19')
  const n = npubEncode(pubkey)
  return `${n.slice(0, 9)}…${n.slice(-4)}`
}
