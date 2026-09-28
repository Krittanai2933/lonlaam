import { decode as refDecode } from 'light-bolt11-decoder'
import { describe, expect, it } from 'vitest'
import { Bolt11Error, decodeBolt11 } from '../src/lightning/bolt11'
// @ts-expect-error untyped JS fixture
import { encodeBolt11, newPreimage } from './fixtures/bolt11-encode.mjs'

describe('decodeBolt11', () => {
  it('decodes amount, timestamp, expiry and payment hash', () => {
    const { paymentHash } = newPreimage()
    const pr: string = encodeBolt11({ amountMsat: 21_000, paymentHash, timestamp: 1_700_000_000, expiry: 600 })
    expect(decodeBolt11(pr)).toEqual({ network: 'bc', amountMsat: 21_000, timestamp: 1_700_000_000, expiry: 600, paymentHash })
  })

  it('agrees with an independent decoder', () => {
    const { paymentHash } = newPreimage()
    const pr: string = encodeBolt11({ amountMsat: 1_234_500, paymentHash, expiry: 86_400 })
    const ref = refDecode(pr)
    const get = (name: string) => ref.sections.find((s: { name: string }) => s.name === name) as { value: unknown } | undefined
    const ours = decodeBolt11(pr)
    expect(String(ours.amountMsat)).toBe(get('amount')?.value)
    expect(ours.paymentHash).toBe(get('payment_hash')?.value)
    expect(ours.expiry).toBe(get('expiry')?.value)
  })

  it('accepts the lightning: prefix and upper case', () => {
    const { paymentHash } = newPreimage()
    const pr: string = encodeBolt11({ amountMsat: 1000, paymentHash })
    expect(decodeBolt11('lightning:' + pr.toUpperCase()).paymentHash).toBe(paymentHash)
  })

  it('rejects a corrupted checksum', () => {
    const { paymentHash } = newPreimage()
    const pr: string = encodeBolt11({ amountMsat: 1000, paymentHash })
    const bad = pr.slice(0, -1) + (pr.endsWith('q') ? 'p' : 'q')
    expect(() => decodeBolt11(bad)).toThrow(Bolt11Error)
  })

  it('rejects truncated input', () => {
    expect(() => decodeBolt11('lnbc1qqqq')).toThrow(Bolt11Error)
  })
})
