import { test as base, expect, type Page } from '@playwright/test'
import { schnorr } from '@noble/curves/secp256k1.js'
import { createHash } from 'node:crypto'
import type { LoginResponse, Project } from '@nampu/types'

export const APP = 'http://localhost:5173'
export const WALLET = 'http://localhost:8790'
/** Lightning Addresses served by apps/api/scripts/mock-wallet.mjs. */
export const LN_OK = 'alice@localhost:8790'
export const LN_NO_LUD21 = 'legacy@localhost:8790'

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex')
let counter = 0
/** Unique, slug-safe suffix so tests never collide with existing data. */
export const uid = () => `${Date.now().toString(36)}${(counter++).toString(36)}`

// ─── HTTP helpers (through the Vite proxy, like the browser) ─────────────────

export async function call<T = unknown>(method: string, path: string, { token, body }: { token?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(APP + path, {
    method,
    headers: { ...(body !== undefined && { 'content-type': 'application/json' }), ...(token && { authorization: `Bearer ${token}` }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data = await res.json().catch(() => null)
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(data)}`)
  return data as T
}

export function nostrKey() {
  const sk = schnorr.utils.randomSecretKey()
  return { sk, pubkey: hex(schnorr.getPublicKey(sk)) }
}

/** Sign a Nostr event template the way a NIP-07 extension would. */
export function signEvent(sk: Uint8Array, t: { kind: number; created_at: number; tags: string[][]; content: string }) {
  const pubkey = hex(schnorr.getPublicKey(sk))
  const id = createHash('sha256').update(JSON.stringify([0, pubkey, t.created_at, t.kind, t.tags, t.content])).digest('hex')
  return { ...t, pubkey, id, sig: hex(schnorr.sign(Buffer.from(id, 'hex'), sk)) }
}

export async function nostrLogin(sk = nostrKey().sk): Promise<LoginResponse> {
  const { challenge } = await call<{ challenge: string }>('POST', '/api/auth/nostr/challenge')
  const event = signEvent(sk, { kind: 22242, created_at: Math.floor(Date.now() / 1000), tags: [['challenge', challenge], ['relay', APP]], content: '' })
  return call<LoginResponse>('POST', '/api/auth/nostr', { body: { event } })
}

/** An onboarded creator with a verified Lightning Address. */
export async function seedCreator(name = 'E2E Creator') {
  const { token } = await nostrLogin()
  const handle = `e2e-${uid()}`
  await call('PATCH', '/api/me', { token, body: { handle, displayName: name, lightningAddress: LN_OK } })
  return { token, handle, displayName: name }
}

export async function seedProject(token: string, over: Partial<{ title: string; summary: string; body: string; category: string; goalSats: number; days: number; publish: boolean }> = {}) {
  const slug = `e2e-${uid()}`
  const p = await call<Project>('POST', '/api/projects', {
    token,
    body: {
      slug,
      title: over.title ?? `โปรเจกต์ทดสอบ ${slug}`,
      summary: over.summary ?? 'คำโปรยสำหรับทดสอบ',
      body: over.body ?? 'เรื่องราวของโปรเจกต์ทดสอบ',
      category: over.category ?? 'edu',
      goalSats: over.goalSats ?? 50_000,
      endsAt: Date.now() + (over.days ?? 10) * 86_400_000,
      milestones: [{ sats: 10_000, label: 'ขั้นแรก' }],
    },
  })
  if (over.publish !== false) await call('PATCH', `/api/projects/${p.id}`, { token, body: { status: 'active' } })
  return { ...p, slug }
}

// ─── Mock wallet controls ─────────────────────────────────────────────────────

export const wallet = {
  async last(): Promise<{ paymentHash: string; pr: string; comment: string | null }> {
    return (await fetch(`${WALLET}/last`)).json()
  },
  /** Settle the most recent invoice issued by the mock wallet. */
  async payLast() {
    const last = await this.last()
    await fetch(`${WALLET}/pay/${last.paymentHash}`, { method: 'POST' })
    return last
  },
  async failNext() {
    await fetch(`${WALLET}/fail-next`, { method: 'POST' })
  },
  /** Wait until the project's Durable Object has confirmed payments totalling `sats` (alarm polls every ~3s). */
  async waitForRaised(slug: string, sats: number) {
    await expect
      .poll(async () => (await call<{ raisedSats: number }>('GET', `/api/p/${slug}`)).raisedSats, { timeout: 20_000, intervals: [500] })
      .toBe(sats)
  },
  /** Create an invoice through the API and settle it immediately. */
  async payProject(slug: string, amountSats: number, supporterName?: string, comment?: string) {
    await call('POST', `/api/p/${slug}/invoices`, { body: { amountSats, supporterName, comment } })
    return this.payLast()
  },
}

// ─── Browser helpers ──────────────────────────────────────────────────────────

export async function signInAs(page: Page, token: string) {
  await page.addInitScript((t) => localStorage.setItem('nampu.session', t), token)
}

/** Stub a NIP-07 extension whose signatures are real (signed in Node). */
export async function installNip07(page: Page, sk = nostrKey().sk) {
  await page.exposeFunction('__e2eSign', (t: Parameters<typeof signEvent>[1]) => signEvent(sk, t))
  await page.addInitScript(() => {
    const w = window as unknown as { nostr: unknown; __e2eSign: (t: unknown) => Promise<unknown> }
    w.nostr = { getPublicKey: async () => '', signEvent: (t: unknown) => w.__e2eSign(t) }
  })
}

/**
 * Every test starts in Thai, light theme, and fails if the page throws or logs an error.
 */
export const test = base.extend<{ pageErrors: string[] }>({
  pageErrors: [
    async ({ page }, use) => {
      const errors: string[] = []
      page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
      page.on('console', (m) => {
        // Resource failures we trigger on purpose (e.g. 4xx from the API) are not app errors.
        if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(`console: ${m.text()}`)
      })
      await page.addInitScript(() => {
        localStorage.setItem('nampu.lang', 'th')
        if (!localStorage.getItem('nampu.theme')) localStorage.setItem('nampu.theme', 'light')
      })
      await use(errors)
      expect(errors, 'page errors').toEqual([])
    },
    { auto: true },
  ],
})

export { expect }
