// Dev helper: create an invoice for a project and settle it with the mock wallet.
//   node scripts/demo-pay.mjs <slug> [sats=1000] [name] [comment]
const [slug, sats = '1000', name, comment] = process.argv.slice(2)
if (!slug) throw new Error('usage: node scripts/demo-pay.mjs <slug> [sats] [name] [comment]')
const API = process.env.API ?? 'http://localhost:8787'
const WALLET = process.env.WALLET ?? 'http://localhost:8790'
const res = await fetch(`${API}/api/p/${slug}/invoices`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ amountSats: Number(sats), ...(name && { supporterName: name }), ...(comment && { comment }) }),
})
const inv = await res.json()
if (!res.ok) throw new Error(JSON.stringify(inv))
const last = await (await fetch(`${WALLET}/last`)).json()
await fetch(`${WALLET}/pay/${last.paymentHash}`, { method: 'POST' })
console.log(`paid ${sats} sats → ${slug} (invoice ${inv.id}); the dashboard updates within a few seconds`)
