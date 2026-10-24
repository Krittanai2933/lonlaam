import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../src/lib/errors'
import { fetchPayRequest, lightningAddressUrl, requestInvoice, verifyPayment } from '../src/lightning/lnurl'

const secure = { allowInsecure: false }
const jsonResponse = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })

afterEach(() => vi.restoreAllMocks())

describe('lightningAddressUrl', () => {
  it('maps name@domain to the LUD-16 well-known URL', () => {
    expect(lightningAddressUrl(' Alice@Example.com ', secure)).toEqual({
      address: 'alice@example.com',
      url: 'https://example.com/.well-known/lnurlp/alice',
    })
  })
  it('rejects localhost unless insecure mode is on', () => {
    expect(() => lightningAddressUrl('a@localhost:8787', secure)).toThrow(ApiError)
    expect(lightningAddressUrl('a@localhost:8787', { allowInsecure: true }).url).toBe('http://localhost:8787/.well-known/lnurlp/a')
  })
  it('rejects garbage', () => {
    for (const bad of ['alice', '@example.com', 'alice@', 'al ice@example.com', 'a@exa_mple.com']) {
      expect(() => lightningAddressUrl(bad, secure), bad).toThrow(ApiError)
    }
  })
})

describe('LNURL-pay', () => {
  const payReq = {
    tag: 'payRequest',
    callback: 'https://example.com/cb?x=1',
    minSendable: 1000,
    maxSendable: 1_000_000,
    commentAllowed: 5,
    metadata: '[]',
  }

  it('parses a payRequest', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(payReq))
    await expect(fetchPayRequest('alice@example.com', secure)).resolves.toEqual({
      callback: 'https://example.com/cb?x=1',
      minSendable: 1000,
      maxSendable: 1_000_000,
      commentAllowed: 5,
    })
  })

  it('rejects an http callback', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ ...payReq, callback: 'http://example.com/cb' }))
    await expect(fetchPayRequest('alice@example.com', secure)).rejects.toMatchObject({ code: 'lnurl_error' })
  })

  it('flags maxSendable 0 as an address that cannot receive', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ ...payReq, maxSendable: 0 }))
    await expect(fetchPayRequest('alice@example.com', secure)).rejects.toMatchObject({ code: 'lnurl_cannot_receive' })
  })

  it('passes amount, trims the comment and requires a verify URL', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ pr: 'lnbc1...', verify: 'https://example.com/v/1' }))
    const pay = { callback: payReq.callback, minSendable: 1000, maxSendable: 1_000_000, commentAllowed: 5 }
    await expect(requestInvoice(pay, 21_000, 'hello world', secure)).resolves.toEqual({ pr: 'lnbc1...', verify: 'https://example.com/v/1' })
    const called = new URL(String(spy.mock.calls[0]![0]))
    expect(called.searchParams.get('x')).toBe('1')
    expect(called.searchParams.get('amount')).toBe('21000')
    expect(called.searchParams.get('comment')).toBe('hello')

    spy.mockResolvedValue(jsonResponse({ pr: 'lnbc1...' }))
    await expect(requestInvoice(pay, 21_000, undefined, secure)).rejects.toMatchObject({ code: 'lnurl_verify_unsupported' })
  })

  it('surfaces wallet errors', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ status: 'ERROR', reason: 'nope' }))
    await expect(fetchPayRequest('alice@example.com', secure)).rejects.toMatchObject({ code: 'lnurl_error', message: 'LNURL: nope' })
  })

  it('refuses oversized responses', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('x'.repeat(70_000)))
    await expect(fetchPayRequest('alice@example.com', secure)).rejects.toMatchObject({ code: 'lnurl_error' })
  })
})

describe('verifyPayment (LUD-21)', () => {
  it('reads settled + preimage', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ status: 'OK', settled: true, preimage: 'AB', pr: 'x' }))
    await expect(verifyPayment('https://example.com/v/1')).resolves.toEqual({ settled: true, preimage: 'ab' })
  })
  it('treats unsettled as not paid', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ status: 'OK', settled: false, preimage: null, pr: 'x' }))
    await expect(verifyPayment('https://example.com/v/1')).resolves.toEqual({ settled: false, preimage: null })
  })
})
