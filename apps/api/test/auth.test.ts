import { NOSTR_AUTH_KIND } from '@nampu/types'
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js'
import { describe, expect, it } from 'vitest'
import { Bech32Error, bech32Decode, decodeNpub, encodeLnurl, encodeNpub, fromWords } from '../src/lib/bech32'
import { bytesToHex, hexToBytes } from '../src/lib/hex'
import { nostrEventId, verifyLnurlAuth, verifyNostrEvent } from '../src/lib/signatures'

describe('bech32', () => {
  it('decodes the LUD-01 test vector', () => {
    const lnurl =
      'LNURL1DP68GURN8GHJ7UM9WFMXJCM99E3K7MF0V9CXJ0M385EKVCENXC6R2C35XVUKXEFCV5MKVV34X5EKZD3EV56NYD3HXQURZEPEXEJXXEPNXSCRVWFNV9NXZCN9XQ6XYEFHVGCXXCMYXYMNSERXFQ5FNS'
    const { hrp, words } = bech32Decode(lnurl)
    expect(hrp).toBe('lnurl')
    const url = new TextDecoder().decode(fromWords(words))
    expect(url).toBe('https://service.com/api?q=3fc3645b439ce8e7f2553a69e5267081d96dcd340693afabe04be7b0ccd178df')
    expect(encodeLnurl(url)).toBe(lnurl.toLowerCase())
  })

  it('round-trips the NIP-19 npub vector', () => {
    const hex = '7e7e9c42a91bfef19fa929e5fda1b72e0ebc1a4c1141673e2794234d86addf4e'
    const npub = 'npub10elfcs4fr0l0r8af98jlmgdh9c8tcxjvz9qkw038js35mp4dma8qzvjptg'
    expect(encodeNpub(hex)).toBe(npub)
    expect(decodeNpub(npub)).toBe(hex)
  })

  it('rejects bad npubs', () => {
    expect(decodeNpub('npub10elfcs4fr0l0r8af98jlmgdh9c8tcxjvz9qkw038js35mp4dma8qzvjptq')).toBeNull() // checksum
    expect(decodeNpub('nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5')).toBeNull() // wrong hrp
    expect(decodeNpub('hello')).toBeNull()
    expect(() => bech32Decode('Npub1abc')).toThrow(Bech32Error)
  })
})

async function signedEvent(overrides: Partial<{ created_at: number; tags: string[][] }> = {}) {
  const sk = schnorr.utils.randomSecretKey()
  const base = {
    pubkey: bytesToHex(schnorr.getPublicKey(sk)),
    created_at: Math.floor(Date.now() / 1000),
    kind: NOSTR_AUTH_KIND,
    tags: [['challenge', 'ab'.repeat(32)], ['relay', 'https://nampu.test']],
    content: '',
    ...overrides,
  }
  const id = await nostrEventId(base)
  const sig = bytesToHex(schnorr.sign(hexToBytes(id)!, sk))
  return { ...base, id, sig }
}

describe('Nostr event verification', () => {
  it('accepts a correctly signed event', async () => {
    expect(await verifyNostrEvent(await signedEvent())).toBe(true)
  })
  it('rejects tampering with content, tags or id', async () => {
    const e = await signedEvent()
    expect(await verifyNostrEvent({ ...e, content: 'x' })).toBe(false)
    expect(await verifyNostrEvent({ ...e, tags: [['challenge', 'cd'.repeat(32)]] })).toBe(false)
    expect(await verifyNostrEvent({ ...e, sig: e.sig.replace(/^./, e.sig[0] === 'a' ? 'b' : 'a') })).toBe(false)
    expect(await verifyNostrEvent({ ...e, pubkey: 'zz' })).toBe(false)
  })
})

describe('LNURL-auth (LUD-04)', () => {
  const sk = secp256k1.utils.randomSecretKey()
  const key = bytesToHex(secp256k1.getPublicKey(sk, true))
  const k1 = bytesToHex(crypto.getRandomValues(new Uint8Array(32)))
  const sig = bytesToHex(secp256k1.sign(hexToBytes(k1)!, sk, { prehash: false, format: 'der' }))

  it('verifies a DER signature over k1', () => {
    expect(verifyLnurlAuth(k1, sig, key)).toBe(true)
  })
  it('rejects a different k1, key or malformed input', () => {
    const other = bytesToHex(crypto.getRandomValues(new Uint8Array(32)))
    expect(verifyLnurlAuth(other, sig, key)).toBe(false)
    expect(verifyLnurlAuth(k1, sig, bytesToHex(secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true)))).toBe(false)
    expect(verifyLnurlAuth(k1, 'nothex', key)).toBe(false)
    expect(verifyLnurlAuth(k1, sig, '04' + key.slice(2))).toBe(false)
  })
})
