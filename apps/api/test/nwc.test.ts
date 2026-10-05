import { SPRINKLE, sprinkleShare } from '@nampu/types'
import { describe, expect, it } from 'vitest'
import { parseNwcUrl } from '../src/lightning/nwc'

const PK = 'ebdda12636f35f00fe588fbcf77fa6f763ea4a88eaa1fcd6d51fc31d4fd334d5'
const SECRET = 'a5dc994f93583db22acc96d86081ae48061d293f0aafd12d3692c5ab5aa5b3ad'

describe('parseNwcUrl', () => {
  it('parses a connection string', () => {
    const c = parseNwcUrl(`nostr+walletconnect://${PK}?relay=wss%3A%2F%2Frelay.getalby.com%2Fv1&secret=${SECRET}&lud16=x@y.com`)
    expect(c.walletPubkey).toBe(PK)
    expect(c.relay).toBe('wss://relay.getalby.com/v1')
    expect(c.secret).toHaveLength(32)
  })

  it('rejects malformed strings', () => {
    expect(() => parseNwcUrl('https://example.com')).toThrow(/nostr\+walletconnect/)
    expect(() => parseNwcUrl(`nostr+walletconnect://${PK}?secret=${SECRET}`)).toThrow(/relay/)
    expect(() => parseNwcUrl(`nostr+walletconnect://${PK}?relay=wss://r.example&secret=abcd`)).toThrow(/secret/)
    expect(() => parseNwcUrl(`nostr+walletconnect://nothex?relay=wss://r.example&secret=${SECRET}`)).toThrow(/pubkey/)
  })
})

describe('sprinkleShare', () => {
  it('splits evenly after the fee reserve, rounding down', () => {
    expect(sprinkleShare(1000, 3)).toBe(326)
    expect(sprinkleShare(21_000, 10)).toBe(2058)
    expect(sprinkleShare(21, 1)).toBe(20)
  })

  it('never pays out more than was received', () => {
    for (const amount of [21, 99, 1000, 4321, 21_000]) {
      for (let n = 1; n <= SPRINKLE.projects.max; n++) expect(sprinkleShare(amount, n) * n).toBeLessThanOrEqual(amount)
    }
  })
})
