// Local stand-in for a creator's Lightning Address provider (LUD-06/12/16/21).
//   alice@localhost:<port>   → normal wallet with LUD-21 verify
//   legacy@localhost:<port>  → no `verify` URL (should be rejected by the API)
// Test controls: POST /pay/<paymentHash> settles an invoice; GET /last returns the latest one;
// POST /fail-next makes the next invoice request fail (simulates an unreachable node).
//
// Also the platform wallet for sprinkles: a tiny Nostr relay on :<port+1> that answers NIP-47
// (NWC) requests itself. Its connection string is MOCK_NWC_URL below (wrangler.jsonc env.dev).
// Controls: GET /nwc/last (latest make_invoice), POST /pay/<hash> settles it like any invoice,
// GET /nwc/payments lists pay_invoice calls, POST /nwc/fail-next[?code=…] fails the next
// pay_invoice (default PAYMENT_FAILED), POST /nwc/drop-next pays the next one but drops the
// socket instead of answering (like a relay hiccup).
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import * as nip04 from 'nostr-tools/nip04'
import * as nip44 from 'nostr-tools/nip44'
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure'
import { WebSocketServer } from 'ws'
import { encodeBolt11, newPreimage } from '../test/fixtures/bolt11-encode.mjs'

const port = Number(process.env.MOCK_WALLET_PORT ?? 8790)
const base = `http://localhost:${port}`
const invoices = new Map() // paymentHash → { preimage, pr, settled }
let last = null
let failNext = false

// ─── NWC (platform wallet) ────────────────────────────────────────────────────

const relayPort = port + 1
// Fixed test keys: the client secret is public on purpose (it only controls this mock).
const walletSk = createHash('sha256').update('nampu-mock-nwc-wallet').digest()
const walletPk = getPublicKey(walletSk)
const clientSk = createHash('sha256').update('nampu-mock-nwc-client').digest('hex')
console.log(`[mock-wallet] NWC: nostr+walletconnect://${walletPk}?relay=ws://localhost:${relayPort}&secret=${clientSk}`)
let lastNwc = null
let nwcFailNext = null // error code for the next pay_invoice
let nwcDropNext = false
const nwcPayments = [] // { paymentHash, ok, error? }
// Like a real wallet, lookup_invoice only knows invoices this wallet made or tried to pay
// (the shared `invoices` map also holds the creators' LNURL invoices).
const nwcKnown = new Set()

function nwcHandle(method, params) {
  if (method === 'make_invoice') {
    const { preimage, paymentHash } = newPreimage()
    const expiry = params.expiry ?? 600
    const pr = encodeBolt11({ amountMsat: params.amount, paymentHash, expiry })
    invoices.set(paymentHash, { preimage, pr, settled: false })
    lastNwc = { paymentHash, pr, amountMsat: params.amount }
    nwcKnown.add(paymentHash)
    const now = Math.floor(Date.now() / 1000)
    return { type: 'incoming', invoice: pr, payment_hash: paymentHash, amount: params.amount, created_at: now, expires_at: now + expiry }
  }
  if (method === 'lookup_invoice') {
    const inv = nwcKnown.has(params.payment_hash) && invoices.get(params.payment_hash)
    if (!inv) throw { code: 'NOT_FOUND', message: 'invoice not found' }
    return {
      type: 'incoming',
      invoice: inv.pr,
      payment_hash: params.payment_hash,
      state: inv.settled ? 'settled' : inv.failed ? 'failed' : 'pending',
      ...(inv.settled && { settled_at: Math.floor(Date.now() / 1000), preimage: inv.preimage }),
    }
  }
  if (method === 'pay_invoice') {
    const entry = [...invoices.entries()].find(([, v]) => v.pr === params.invoice)
    const paymentHash = entry?.[0] ?? null
    if (paymentHash) nwcKnown.add(paymentHash)
    const fail = (message, code = 'PAYMENT_FAILED') => {
      nwcPayments.push({ paymentHash, ok: false, error: message })
      if (entry) entry[1].failed = true
      throw { code, message }
    }
    if (nwcFailNext) {
      const code = nwcFailNext
      nwcFailNext = null
      fail(code === 'PAYMENT_FAILED' ? 'no route (simulated)' : `${code} (simulated)`, code)
    }
    if (!entry) fail('unknown invoice')
    if (entry[1].settled) fail('invoice already paid')
    entry[1].settled = true
    entry[1].failed = false
    nwcPayments.push({ paymentHash, ok: true })
    return { preimage: entry[1].preimage, fees_paid: 0 }
  }
  throw { code: 'NOT_IMPLEMENTED', message: `unknown method ${method}` }
}

const subs = new Map() // ws → Map(subId → filter)
const matches = (f, ev) =>
  (!f.kinds || f.kinds.includes(ev.kind)) &&
  (!f.authors || f.authors.includes(ev.pubkey)) &&
  (!f['#e'] || ev.tags.some((t) => t[0] === 'e' && f['#e'].includes(t[1])))
const publish = (ev) => {
  for (const [ws, m] of subs) for (const [id, f] of m) if (matches(f, ev)) ws.send(JSON.stringify(['EVENT', id, ev]))
}
const infoEvent = finalizeEvent({ kind: 13194, created_at: Math.floor(Date.now() / 1000), tags: [['encryption', 'nip44_v2 nip04']], content: 'pay_invoice make_invoice lookup_invoice' }, walletSk)

new WebSocketServer({ port: relayPort }).on('connection', (ws) => {
  subs.set(ws, new Map())
  ws.on('close', () => subs.delete(ws))
  ws.on('message', (raw) => {
    let msg
    try {
      msg = JSON.parse(String(raw))
    } catch {
      return
    }
    const [type, a, b] = msg
    if (type === 'REQ') {
      subs.get(ws).set(a, b)
      if (matches(b, infoEvent)) ws.send(JSON.stringify(['EVENT', a, infoEvent]))
      ws.send(JSON.stringify(['EOSE', a]))
    } else if (type === 'CLOSE') {
      subs.get(ws).delete(a)
    } else if (type === 'EVENT') {
      ws.send(JSON.stringify(['OK', a.id, true, '']))
      if (a.kind !== 23194 || !a.tags.some((t) => t[0] === 'p' && t[1] === walletPk)) return
      const v04 = a.content.includes('?iv=')
      const decrypt = (c) => (v04 ? nip04.decrypt(walletSk, a.pubkey, c) : nip44.decrypt(c, nip44.getConversationKey(walletSk, a.pubkey)))
      const encrypt = (t) => (v04 ? nip04.encrypt(walletSk, a.pubkey, t) : nip44.encrypt(t, nip44.getConversationKey(walletSk, a.pubkey)))
      const { method, params } = JSON.parse(decrypt(a.content))
      let body
      try {
        body = { result_type: method, error: null, result: nwcHandle(method, params ?? {}) }
        if (method === 'pay_invoice' && nwcDropNext) {
          nwcDropNext = false
          return ws.terminate() // paid, but the answer never arrives
        }
      } catch (e) {
        body = { result_type: method, error: { code: e.code ?? 'INTERNAL', message: e.message ?? String(e) }, result: null }
      }
      publish(finalizeEvent({ kind: 23195, created_at: Math.floor(Date.now() / 1000), tags: [['p', a.pubkey], ['e', a.id]], content: encrypt(JSON.stringify(body)) }, walletSk))
    }
  })
})

const send = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

createServer((req, res) => {
  const url = new URL(req.url, base)
  const [, a, b] = url.pathname.split('/')
  if (req.method === 'GET' && url.pathname.startsWith('/.well-known/lnurlp/')) {
    const name = url.pathname.split('/').pop()
    return send(res, 200, {
      tag: 'payRequest',
      callback: `${base}/cb/${name}`,
      minSendable: 1000,
      maxSendable: 100_000_000,
      commentAllowed: 100,
      metadata: JSON.stringify([['text/plain', `pay ${name}`]]),
    })
  }
  if (req.method === 'GET' && a === 'cb') {
    if (failNext) {
      failNext = false
      return send(res, 200, { status: 'ERROR', reason: 'node unreachable' })
    }
    const amountMsat = Number(url.searchParams.get('amount'))
    const { preimage, paymentHash } = newPreimage()
    const pr = encodeBolt11({ amountMsat, paymentHash, expiry: 600 })
    invoices.set(paymentHash, { preimage, pr, settled: false })
    last = { paymentHash, pr, comment: url.searchParams.get('comment') }
    return send(res, 200, { pr, routes: [], ...(b !== 'legacy' && { verify: `${base}/verify/${paymentHash}` }) })
  }
  if (req.method === 'GET' && a === 'verify') {
    const inv = invoices.get(b)
    if (!inv) return send(res, 404, { status: 'ERROR', reason: 'not found' })
    return send(res, 200, { status: 'OK', settled: inv.settled, preimage: inv.settled ? inv.preimage : null, pr: inv.pr })
  }
  if (req.method === 'POST' && a === 'pay') {
    const inv = invoices.get(b)
    if (!inv) return send(res, 404, { error: 'not found' })
    inv.settled = true
    return send(res, 200, { ok: true })
  }
  if (req.method === 'GET' && a === 'last') return send(res, 200, last)
  if (a === 'nwc' && req.method === 'GET' && b === 'last') return send(res, 200, lastNwc)
  if (a === 'nwc' && req.method === 'GET' && b === 'payments') return send(res, 200, nwcPayments)
  if (a === 'nwc' && req.method === 'POST' && b === 'fail-next') {
    nwcFailNext = url.searchParams.get('code') ?? 'PAYMENT_FAILED'
    return send(res, 200, { ok: true })
  }
  if (a === 'nwc' && req.method === 'POST' && b === 'drop-next') {
    nwcDropNext = true
    return send(res, 200, { ok: true })
  }
  if (req.method === 'POST' && a === 'fail-next') {
    failNext = true
    return send(res, 200, { ok: true })
  }
  send(res, 404, { status: 'ERROR', reason: 'not found' })
}).listen(port, () => console.log(`[mock-wallet] ${base}`))
