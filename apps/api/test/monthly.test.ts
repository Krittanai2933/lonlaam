import { monthlyDistributable, SPRINKLE } from '@nampu/types'
import { describe, expect, it } from 'vitest'
import { parseNwcUrl } from '../src/lightning/nwc'
import { drawMonth, drawShares, nextDue, nwcLabel, reasonFor } from '../src/lib/monthly'
import { seal, unseal } from '../src/lib/secretbox'
import { missingShares } from '../src/lib/sprinkle'

/** Deterministic PRNG (mulberry32) so failures reproduce. */
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('drawShares', () => {
  it('sums to the total and gives everyone at least the minimum', () => {
    const r = rng(1)
    for (const total of [21, 100, 999, 5000, 21_000]) {
      for (let n = 1; n <= Math.min(10, Math.floor(total / SPRINKLE.minSatsPerProject)); n++) {
        const s = drawShares(total, n, r)
        expect(s).toHaveLength(n)
        expect(s.reduce((a, b) => a + b, 0)).toBe(total)
        expect(Math.min(...s)).toBeGreaterThanOrEqual(SPRINKLE.minSatsPerProject)
      }
    }
  })

  it('actually varies', () => {
    const s = drawShares(10_000, 5, rng(7))
    expect(new Set(s).size).toBeGreaterThan(1)
  })
})

describe('drawMonth', () => {
  const plan = { amountSats: 1000, tipPercent: 0, projectsMin: 2, projectsMax: 5 }

  it('picks a count in range and splits what is left after the fee and tip', () => {
    const r = rng(3)
    const seen = new Set<number>()
    for (let i = 0; i < 200; i++) {
      const s = drawMonth(plan, 100, r)!
      seen.add(s.length)
      expect(s.length).toBeGreaterThanOrEqual(2)
      expect(s.length).toBeLessThanOrEqual(5)
      expect(s.reduce((a, b) => a + b, 0)).toBe(monthlyDistributable(1000, 0))
    }
    expect([...seen].sort()).toEqual([2, 3, 4, 5])
    const tipped = drawMonth({ ...plan, tipPercent: 10 }, 100, r)!
    expect(tipped.reduce((a, b) => a + b, 0)).toBe(880)
  })

  it('caps by open projects and by the minimum share, and gives up with nothing to pay', () => {
    expect(drawMonth(plan, 1, rng(1))).toHaveLength(1)
    // 100 sats, 2% fee → 98: room for 4 minimum shares only.
    for (let i = 0; i < 50; i++) expect(drawMonth({ ...plan, amountSats: 100, projectsMax: 10 }, 100, rng(i))!.length).toBeLessThanOrEqual(4)
    expect(drawMonth(plan, 0)).toBeNull()
    expect(drawMonth({ ...plan, amountSats: 21 }, 100)).toBeNull()
  })
})

describe('nextDue', () => {
  const at = (s: string) => Date.parse(s)
  it('moves one calendar month, keeping the time of day', () => {
    expect(new Date(nextDue(at('2026-10-26T08:15:00Z'), 26)).toISOString()).toBe('2026-11-26T08:15:00.000Z')
    expect(new Date(nextDue(at('2026-12-05T00:00:00Z'), 5)).toISOString()).toBe('2027-01-05T00:00:00.000Z')
  })
  it('uses the last day of short months, then goes back to the billing day', () => {
    const jan = at('2027-01-31T10:00:00Z')
    const feb = nextDue(jan, 31)
    expect(new Date(feb).toISOString()).toBe('2027-02-28T10:00:00.000Z')
    expect(new Date(nextDue(feb, 31)).toISOString()).toBe('2027-03-31T10:00:00.000Z')
    expect(new Date(nextDue(at('2028-01-30T10:00:00Z'), 30)).toISOString()).toBe('2028-02-29T10:00:00.000Z')
  })
})

describe('missingShares', () => {
  it('returns the shares no live payout covers, counting duplicates', () => {
    expect(missingShares([100, 200, 100], [])).toEqual([100, 200, 100])
    expect(missingShares([100, 200, 100], [100])).toEqual([200, 100])
    expect(missingShares([100, 200, 100], [100, 200, 100])).toEqual([])
    expect(missingShares([50, 50], [50])).toEqual([50])
  })
})

describe('nwcLabel / reasonFor', () => {
  const PK = 'ebdda12636f35f00fe588fbcf77fa6f763ea4a88eaa1fcd6d51fc31d4fd334d5'
  const SECRET = 'a5dc994f93583db22acc96d86081ae48061d293f0aafd12d3692c5ab5aa5b3ad'
  it('prefers the lud16 in the string, else the relay host', () => {
    const a = `nostr+walletconnect://${PK}?relay=wss://relay.getalby.com/v1&secret=${SECRET}&lud16=me@getalby.com`
    expect(nwcLabel(a, parseNwcUrl(a))).toBe('me@getalby.com')
    const b = `nostr+walletconnect://${PK}?relay=wss://relay.primal.net&secret=${SECRET}`
    expect(nwcLabel(b, parseNwcUrl(b))).toBe('relay.primal.net')
  })
  it('maps wallet errors to reasons', () => {
    expect(reasonFor('UNAUTHORIZED')).toBe('wallet_revoked')
    expect(reasonFor('QUOTA_EXCEEDED')).toBe('quota_exceeded')
    expect(reasonFor('TIMEOUT')).toBe('wallet_unreachable')
    expect(reasonFor('PAYMENT_FAILED')).toBe('payment_failed')
  })
})

describe('secretbox', () => {
  const env = { NWC_ENC_KEY: 'ab'.repeat(32) } as Env
  it('round-trips, and only opens with the same key and context', async () => {
    const sealed = await seal(env, 'nostr+walletconnect://secret', 'creator-1')
    expect(sealed).not.toContain('secret')
    expect(await unseal(env, sealed, 'creator-1')).toBe('nostr+walletconnect://secret')
    await expect(unseal(env, sealed, 'creator-2')).rejects.toThrow()
    await expect(unseal({ NWC_ENC_KEY: 'cd'.repeat(32) } as Env, sealed, 'creator-1')).rejects.toThrow()
  })
  it('uses a fresh IV each time', async () => {
    expect(await seal(env, 'x', 'c')).not.toBe(await seal(env, 'x', 'c'))
  })
})
