// Local stand-in for a creator's Lightning Address provider (LUD-06/12/16/21).
//   alice@localhost:<port>   → normal wallet with LUD-21 verify
//   legacy@localhost:<port>  → no `verify` URL (should be rejected by the API)
// Test controls: POST /pay/<paymentHash> settles an invoice; GET /last returns the latest one;
// POST /fail-next makes the next invoice request fail (simulates an unreachable node).
import { createServer } from 'node:http'
import { encodeBolt11, newPreimage } from '../test/fixtures/bolt11-encode.mjs'

const port = Number(process.env.MOCK_WALLET_PORT ?? 8790)
const base = `http://localhost:${port}`
const invoices = new Map() // paymentHash → { preimage, pr, settled }
let last = null
let failNext = false

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
  if (req.method === 'POST' && a === 'fail-next') {
    failNext = true
    return send(res, 200, { ok: true })
  }
  send(res, 404, { status: 'ERROR', reason: 'not found' })
}).listen(port, () => console.log(`[mock-wallet] ${base}`))
