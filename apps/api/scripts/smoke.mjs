// End-to-end smoke test: mock wallet + `wrangler dev --env dev` with local D1/R2/DO.
//   pnpm --filter @nampu/api smoke
import { spawn, execSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'
import { createHash } from 'node:crypto'
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js'

const API = 'http://localhost:8787'
const WALLET_PORT = 8790
const WALLET = `http://localhost:${WALLET_PORT}`
const procs = []
// Each child leads its own process group, and the whole group is killed: SIGTERM to
// `npx wrangler dev` alone leaves wrangler/workerd running on :8787 (breaks a following e2e run).
const cleanup = () =>
  procs.forEach((p) => {
    try {
      process.kill(-p.pid, 'SIGTERM')
    } catch {
      // already gone
    }
  })
process.on('exit', cleanup)

function start(cmd, args, env = {}) {
  const p = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  const tag = `[${args[0] ?? cmd}]`
  p.stdout.on('data', (d) => process.env.VERBOSE && process.stdout.write(`${tag} ${d}`))
  p.stderr.on('data', (d) => process.env.VERBOSE && process.stderr.write(`${tag} ${d}`))
  procs.push(p)
  return p
}

async function waitFor(url) {
  for (let i = 0; i < 120; i++) {
    try {
      await fetch(url)
      return
    } catch {
      await sleep(500)
    }
  }
  throw new Error(`timeout waiting for ${url}`)
}

async function call(method, path, { token, body, headers = {} } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: {
      ...(body !== undefined && !(body instanceof Uint8Array) && { 'content-type': 'application/json' }),
      ...(token && { authorization: `Bearer ${token}` }),
      ...headers,
    },
    body: body === undefined ? undefined : body instanceof Uint8Array ? body : JSON.stringify(body),
  })
  const text = await res.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    json = text
  }
  return { status: res.status, json, headers: res.headers }
}

const step = (name) => console.log(`✓ ${name}`)

execSync('node ../../scripts/ensure-web-dist.mjs', { stdio: 'inherit' })
execSync('rm -rf .wrangler/state && npx wrangler d1 migrations apply nampu --local --env dev', { stdio: 'ignore' })
start('node', ['scripts/mock-wallet.mjs'], { MOCK_WALLET_PORT: String(WALLET_PORT) })
start('npx', ['wrangler', 'dev', '--env', 'dev', '--port', '8787'])
await waitFor(`${WALLET}/last`)
await waitFor(`${API}/api/health`)
step('servers up')

const hex = (b) => Buffer.from(b).toString('hex')

// ─── Nostr login (NIP-07 style signed auth event) ────────────────────────────
async function nostrLogin(sk) {
  const { json: ch } = await call('POST', '/api/auth/nostr/challenge')
  const unsigned = {
    pubkey: hex(schnorr.getPublicKey(sk)),
    created_at: Math.floor(Date.now() / 1000),
    kind: 22242,
    tags: [['challenge', ch.challenge], ['relay', API]],
    content: '',
  }
  const id = createHash('sha256')
    .update(JSON.stringify([0, unsigned.pubkey, unsigned.created_at, unsigned.kind, unsigned.tags, unsigned.content]))
    .digest('hex')
  const event = { ...unsigned, id, sig: hex(schnorr.sign(Buffer.from(id, 'hex'), sk)) }
  return { event, res: await call('POST', '/api/auth/nostr', { body: { event } }) }
}
const nostrSk = schnorr.utils.randomSecretKey()
const first = await nostrLogin(nostrSk)
assert.equal(first.res.status, 200, JSON.stringify(first.res.json))
assert.equal(first.res.json.isNew, true)
assert.equal(first.res.json.creator.handle, null)
assert.match(first.res.json.creator.npub, /^npub1/)
const token = first.res.json.token
assert.match(token, /^np_/)
const replay = await call('POST', '/api/auth/nostr', { body: { event: first.event } })
assert.equal(replay.json.error.code, 'auth_failed', 'challenge is single-use')
const again = await nostrLogin(nostrSk)
assert.equal(again.res.json.isNew, false)
assert.equal(again.res.json.creator.id, first.res.json.creator.id)
step('Nostr login: new account, replay rejected, second login same account')

// ─── LNURL-auth (we act as the wallet) ───────────────────────────────────────
const lnStart = await call('POST', '/api/auth/lnurl')
assert.match(lnStart.json.lnurl, /^lnurl1/)
const poll = () => call('GET', `/api/auth/lnurl/${lnStart.json.k1}`, { headers: { 'x-poll-token': lnStart.json.pollToken } })
assert.equal((await poll()).json.status, 'pending')
assert.equal(
  (await call('GET', `/api/auth/lnurl/${lnStart.json.k1}`, { headers: { 'x-poll-token': 'ab'.repeat(32) } })).json.status,
  'expired',
  'wrong poll token sees nothing',
)
const walletSk = secp256k1.utils.randomSecretKey()
const linkingKey = hex(secp256k1.getPublicKey(walletSk, true))
const k1sig = hex(secp256k1.sign(Buffer.from(lnStart.json.k1, 'hex'), walletSk, { prehash: false, format: 'der' }))
const badCb = await call('GET', `/api/auth/lnurl/callback?tag=login&k1=${lnStart.json.k1}&sig=${k1sig}&key=${hex(secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true))}`)
assert.equal(badCb.json.status, 'ERROR')
const cb = await call('GET', `/api/auth/lnurl/callback?tag=login&k1=${lnStart.json.k1}&sig=${k1sig}&key=${linkingKey}`)
assert.deepEqual(cb.json, { status: 'OK' })
const done = await poll()
assert.equal(done.json.status, 'ok', JSON.stringify(done.json))
assert.equal(done.json.isNew, true)
assert.equal(done.json.creator.logins.lnurl, true)
assert.equal((await poll()).json.status, 'expired', 'claimed once')
const lnToken = done.json.token
assert.equal((await call('POST', '/api/auth/logout', { token: lnToken })).status, 204)
assert.equal((await call('GET', '/api/me', { token: lnToken })).status, 401)
step('LNURL-auth: QR → wallet callback → poll → session, logout revokes')

// ─── Onboarding ──────────────────────────────────────────────────────────────
assert.equal((await call('GET', '/api/me/projects', { token })).json.error.code, 'onboarding_required')
const half = await call('PATCH', '/api/me', { token, body: { handle: 'alice' } })
assert.equal(half.status, 422, 'handle and displayName required together')
const onboard = await call('PATCH', '/api/me', {
  token,
  body: { handle: 'alice', displayName: 'Alice', lightningAddress: `alice@localhost:${WALLET_PORT}` },
})
assert.equal(onboard.status, 200, JSON.stringify(onboard.json))
assert.equal(onboard.json.handle, 'alice')
assert.equal(onboard.json.lightningAddress, `alice@localhost:${WALLET_PORT}`)
assert.equal((await call('PATCH', '/api/me', { token, body: { npub: 'npub1nope' } })).status, 422)
step('onboarding + LUD-21 probe')

const legacy = await call('PATCH', '/api/me', { token, body: { lightningAddress: `legacy@localhost:${WALLET_PORT}` } })
assert.equal(legacy.status, 422)
assert.equal(legacy.json.error.code, 'lnurl_verify_unsupported')
step('wallet without LUD-21 rejected')

assert.equal((await call('GET', '/api/me')).status, 401)
// Second account can't take the same handle.
const bob = await nostrLogin(schnorr.utils.randomSecretKey())
const taken = await call('PATCH', '/api/me', { token: bob.res.json.token, body: { handle: 'alice', displayName: 'Bob' } })
assert.equal(taken.status, 409)
const invalid = await call('PATCH', '/api/me', { token: bob.res.json.token, body: { handle: 'A!', displayName: '' } })
assert.equal(invalid.status, 422)
assert.equal(invalid.json.error.code, 'validation_failed')
step('auth / conflict / validation errors')

const created = await call('POST', '/api/projects', {
  token,
  body: {
    slug: 'water-well',
    title: 'Water well <for> "village"',
    summary: 'Clean water for 200 families',
    goalSats: 1_000_000,
    category: 'community',
    milestones: [{ sats: 300_000, label: 'Drilling' }, { sats: 1_000_000, label: 'Pump + tank' }],
    endsAt: Date.now() + 30 * 86_400_000,
  },
})
assert.equal(created.status, 201, JSON.stringify(created.json))
const projectId = created.json.id
assert.equal(created.json.category, 'community')
assert.equal(created.json.milestones.length, 2)
const unsorted = await call('PATCH', `/api/projects/${projectId}`, {
  token,
  body: { milestones: [{ sats: 5, label: 'b' }, { sats: 1, label: 'a' }] },
})
assert.equal(unsorted.status, 422)
assert.equal((await call('PATCH', `/api/projects/${projectId}`, { token, body: { endsAt: Date.now() - 1000 } })).status, 422)
assert.equal((await call('PATCH', `/api/projects/${projectId}`, { token, body: { summary: 'x'.repeat(141) } })).status, 422)
assert.equal((await call('GET', '/api/p/water-well')).status, 404, 'drafts are not public')
const published = await call('PATCH', `/api/projects/${projectId}`, { token, body: { status: 'active' } })
assert.equal(published.json.status, 'active')
assert.ok(published.json.publishedAt)
assert.equal((await call('PATCH', `/api/projects/${projectId}`, { token, body: { slug: 'other' } })).status, 409)
step('project create / publish / slug lock')

const png = Uint8Array.from(
  Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'),
)
const cover = await call('PUT', `/api/projects/${projectId}/cover`, { token, body: png, headers: { 'content-type': 'image/png' } })
assert.equal(cover.status, 200, JSON.stringify(cover.json))
const media = await fetch(cover.json.coverUrl)
assert.equal(media.status, 200)
assert.equal(media.headers.get('content-type'), 'image/png')
assert.equal((await media.arrayBuffer()).byteLength, png.byteLength)
const inline = await call('POST', `/api/projects/${projectId}/images`, { token, body: png, headers: { 'content-type': 'image/png' } })
assert.equal(inline.status, 201, JSON.stringify(inline.json))
assert.match(inline.json.url, /\/media\/images\//)
assert.equal((await fetch(inline.json.url)).status, 200)
const cur = await call('GET', `/api/projects/${projectId}`, { token })
assert.equal(cur.json.coverUrl, cover.json.coverUrl, 'inline image does not touch the cover')
assert.equal(
  (await call('POST', `/api/projects/${projectId}/images`, { token, body: png, headers: { 'content-type': 'image/svg+xml' } })).status,
  415,
)
step('cover + inline image upload to R2 + /media')

const html = await (await fetch(`${API}/p/water-well`)).text()
assert.match(html, /<title>Water well &#60;for&#62; &#34;village&#34; · ล้นหลาม \(dev\)<\/title>/)
assert.match(html, /<meta property="og:image" content="http:\/\/localhost:8787\/media\/covers\//)
assert.match(html, /<meta property="og:description" content="Clean water for 200 families">/)
assert.equal((await fetch(`${API}/p/nope`)).status, 404)
step('SEO meta injection on /p/:slug')

const tooSmall = await call('POST', '/api/p/water-well/invoices', { body: { amountSats: 0 } })
assert.equal(tooSmall.status, 422)

const inv = await call('POST', '/api/p/water-well/invoices', {
  body: { amountSats: 21, supporterName: 'Bob', comment: 'good luck!' },
})
assert.equal(inv.status, 201, JSON.stringify(inv.json))
assert.equal(inv.json.status, 'pending')
assert.equal(inv.json.amountSats, 21)
assert.match(inv.json.bolt11, /^lnbc210n1/)
assert.equal(inv.json.verifyUrl, undefined, 'verify URL must not leak')
const walletLast = await (await fetch(`${WALLET}/last`)).json()
assert.equal(walletLast.comment, 'good luck!')
step('invoice via LNURL-pay')

// Two sockets: a viewer, and the payer subscribed to their invoice.
const events = { viewer: [], payer: [] }
const open = (name, qs = '') =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(`${API.replace('http', 'ws')}/api/p/water-well/ws${qs}`)
    ws.onmessage = (e) => events[name].push(e.data === 'pong' ? 'pong' : JSON.parse(e.data))
    ws.onopen = () => resolve(ws)
    ws.onerror = reject
  })
const viewer = await open('viewer')
const payer = await open('payer', `?invoice=${inv.json.id}`)
viewer.send('ping')
await sleep(300)
assert.equal(events.viewer[0]?.type, 'hello')
assert.ok(events.viewer.includes('pong'))
step('WebSocket hello + auto ping/pong')

await fetch(`${WALLET}/pay/${walletLast.paymentHash}`, { method: 'POST' })
const t0 = Date.now()
while (!events.payer.some((m) => m.type === 'invoice') && Date.now() - t0 < 15_000) await sleep(200)
const paidEvt = events.viewer.find((m) => m.type === 'payment')
assert.ok(paidEvt, 'viewer got payment event')
assert.deepEqual(paidEvt.stats, { raisedSats: 21, supporterCount: 1 })
assert.equal(paidEvt.supporter.name, 'Bob')
assert.deepEqual(events.payer.find((m) => m.type === 'invoice'), { type: 'invoice', invoiceId: inv.json.id, status: 'paid' })
assert.ok(!events.viewer.some((m) => m.type === 'invoice'), 'invoice events go only to the subscribed socket')
step(`payment detected by DO alarm in ${Date.now() - t0}ms, broadcast over WS`)

const status = await call('GET', `/api/invoices/${inv.json.id}`)
assert.equal(status.json.status, 'paid')
const project = await call('GET', '/api/p/water-well')
assert.equal(project.json.raisedSats, 21)
assert.equal(project.json.supporterCount, 1)
assert.equal(project.json.supporters.supporters[0].comment, 'good luck!', 'first supporter page embedded')
assert.equal(project.json.leaders[0].amountSats, 21, 'leaderboard embedded')
const supporters = await call('GET', '/api/p/water-well/supporters?limit=1')
assert.equal(supporters.json.supporters.length, 1)
assert.equal(supporters.json.supporters[0].comment, 'good luck!')
assert.equal(supporters.json.nextCursor, null)
step('D1 state: invoice paid, totals + supporter feed updated')

// A second, anonymous payment without a comment for stats/search.
const inv2 = await call('POST', '/api/p/water-well/invoices', { body: { amountSats: 1000 } })
await fetch(`${WALLET}/pay/${(await (await fetch(`${WALLET}/last`)).json()).paymentHash}`, { method: 'POST' })
for (let i = 0; i < 75 && (await call('GET', `/api/invoices/${inv2.json.id}`)).json.status !== 'paid'; i++) await sleep(200)

const week = await call('GET', `/api/projects/${projectId}/stats?range=7d&tz=420`, { token })
assert.equal(week.status, 200, JSON.stringify(week.json))
assert.equal(week.json.totalSats, 1021)
assert.equal(week.json.backers, 2)
assert.equal(week.json.anonymous, 1)
assert.equal(week.json.avgSats, 510)
assert.deepEqual(week.json.previous, { totalSats: 0, backers: 0 })
assert.equal(week.json.buckets.length, 14)
assert.equal(week.json.buckets.at(-1).sats, 1021, 'recent payments land in the last bucket')
assert.deepEqual(week.json.allTime, { raisedSats: 1021, backers: 2, anonymous: 1, goalSats: 1_000_000 })
const today = await call('GET', `/api/projects/${projectId}/stats?range=today&tz=420`, { token })
assert.equal(today.json.totalSats, 1021)
const all = await call('GET', `/api/projects/${projectId}/stats?range=all`, { token })
assert.equal(all.json.previous, null)
assert.equal(all.json.buckets.reduce((a, b) => a + b.sats, 0), 1021)
assert.equal((await call('GET', `/api/projects/${projectId}/stats?range=1y`, { token })).status, 400)
step('owner stats: range totals, anonymous, buckets, previous window')

const search = await call('GET', `/api/projects/${projectId}/supporters?q=bo`, { token })
assert.deepEqual(search.json.supporters.map((s) => s.name), ['Bob'])
const withMsg = await call('GET', `/api/projects/${projectId}/supporters?filter=message`, { token })
assert.equal(withMsg.json.supporters.length, 1)
assert.equal((await call('GET', `/api/projects/${projectId}/supporters?q=%25`, { token })).json.supporters.length, 0, 'LIKE wildcards escaped')
const csvRes = await fetch(`${API}/api/projects/${projectId}/supporters?format=csv`, { headers: { authorization: `Bearer ${token}` } })
assert.match(csvRes.headers.get('content-type'), /text\/csv/)
const csv = (await csvRes.text()).trim().split('\r\n')
assert.equal(csv[0], 'paid_at,name,amount_sats,comment')
assert.equal(csv.length, 3)
assert.match(csv[2], /,Bob,21,good luck!$/)
assert.equal((await call('GET', `/api/projects/${projectId}/supporters`, { token: bob.res.json.token })).status, 403, 'not onboarded')
step('owner supporters: search, filter, CSV')

// Published goal can't drop below what's raised.
const lower = await call('PATCH', `/api/projects/${projectId}`, { token, body: { goalSats: 500 } })
assert.equal(lower.json.error.code, 'goal_below_raised')
assert.equal((await call('PATCH', `/api/projects/${projectId}`, { token, body: { goalSats: 2000 } })).status, 200)
step('goal lock after publishing')

// Past the end date, invoices are refused (set directly: the API won't accept a past endsAt).
execSync(`npx wrangler d1 execute nampu --local --env dev --command "UPDATE projects SET ends_at = 1 WHERE id = '${projectId}'"`, { stdio: 'ignore' })
const ended = await call('POST', '/api/p/water-well/invoices', { body: { amountSats: 5 } })
assert.equal(ended.json.error.code, 'project_not_active')
execSync(`npx wrangler d1 execute nampu --local --env dev --command "UPDATE projects SET ends_at = NULL WHERE id = '${projectId}'"`, { stdio: 'ignore' })
step('invoices refused after endsAt')

// Closed projects stay visible but stop taking payments.
await call('PATCH', `/api/projects/${projectId}`, { token, body: { status: 'closed' } })
const closed = await call('POST', '/api/p/water-well/invoices', { body: { amountSats: 5 } })
assert.equal(closed.json.error.code, 'project_not_active')
step('closed project rejects invoices')

// ─── Discover list + leaderboard ──────────────────────────────────────────────
{
  const DAY = 86_400_000
  const sql = (q) => execSync(`npx wrangler d1 execute nampu --local --env dev --command "${q}"`, { stdio: 'ignore' })
  const mk = async (slug, body) => {
    const r = await call('POST', '/api/projects', { token, body: { slug, ...body } })
    assert.equal(r.status, 201, JSON.stringify(r.json))
    return r.json.id
  }
  const publish = async (id) => assert.equal((await call('PATCH', `/api/projects/${id}`, { token, body: { status: 'active' } })).status, 200)
  // Create + pay invoices, then wait for the DO to settle all of them.
  const payAll = async (slug, amounts) => {
    const ids = []
    for (const amountSats of amounts) {
      const inv = await call('POST', `/api/p/${slug}/invoices`, { body: { amountSats, supporterName: `s${amountSats}` } })
      assert.equal(inv.status, 201, JSON.stringify(inv.json))
      await fetch(`${WALLET}/pay/${(await (await fetch(`${WALLET}/last`)).json()).paymentHash}`, { method: 'POST' })
      ids.push(inv.json.id)
    }
    const t0 = Date.now()
    for (const id of ids) {
      while ((await call('GET', `/api/invoices/${id}`)).json.status !== 'paid') {
        assert.ok(Date.now() - t0 < 30_000, 'payments settle')
        await sleep(300)
      }
    }
  }

  const a = await mk('disc-a', { title: 'Kids library', summary: 'Books for kids', category: 'edu', goalSats: 400, endsAt: Date.now() + 10 * DAY })
  await publish(a)
  const b = await mk('disc-b', { title: 'Village node', summary: 'Solar powered full node', category: 'tech', goalSats: 100, endsAt: Date.now() + 2 * DAY })
  await publish(b)
  const cId = await mk('disc-c', { title: 'Mural', summary: 'Paint the market wall', category: 'art' })
  await publish(cId)
  await mk('disc-draft', { title: 'Draft only', category: 'edu' })
  const e = await mk('disc-ended', { title: 'Ended one', category: 'edu', endsAt: Date.now() + DAY })
  await publish(e)
  await payAll('disc-a', [300, 200, 50])
  await payAll('disc-b', [100])
  await payAll('disc-c', [700])
  sql(`UPDATE invoices SET paid_at = ${Date.now() - 8 * DAY} WHERE project_id = '${cId}'`) // outside the 7-day window
  sql(`UPDATE projects SET ends_at = 1 WHERE id = '${e}'`)

  const list = async (qs) => {
    const r = await call('GET', `/api/projects${qs}`) // no token: public
    assert.equal(r.status, 200, JSON.stringify(r.json))
    return r
  }
  const slugs = (r) => r.json.projects.map((p) => p.slug)

  const trending = await list('')
  assert.deepEqual(slugs(trending), ['disc-a', 'disc-b', 'disc-c'], 'trending = week sats; draft, ended, closed hidden')
  assert.equal(trending.headers.get('cache-control'), 'public, max-age=30')
  const byslug = Object.fromEntries(trending.json.projects.map((p) => [p.slug, p]))
  assert.equal(byslug['disc-a'].weekSats, 550)
  assert.equal(byslug['disc-b'].weekSats, 100)
  assert.equal(byslug['disc-c'].weekSats, 0)
  assert.equal(byslug['disc-c'].raisedSats, 700)
  assert.equal(byslug['disc-a'].body, undefined, 'summaries omit body')
  assert.equal(byslug['disc-a'].creator.handle, 'alice')
  assert.deepEqual(slugs(await list('?sort=new')), ['disc-c', 'disc-b', 'disc-a'])
  assert.deepEqual(slugs(await list('?sort=ending')), ['disc-b', 'disc-a', 'disc-c'])
  assert.deepEqual(slugs(await list('?sort=funded')), ['disc-a', 'disc-b', 'disc-c'])
  assert.deepEqual(slugs(await list('?category=tech')), ['disc-b'])
  assert.deepEqual(slugs(await list('?q=SOLAR')), ['disc-b'])
  assert.deepEqual(slugs(await list('?q=%25')), [], '% is literal')
  const p1 = await list('?sort=new&limit=2')
  assert.deepEqual(slugs(p1), ['disc-c', 'disc-b'])
  assert.ok(p1.json.nextCursor)
  const p2 = await list(`?sort=new&limit=2&cursor=${p1.json.nextCursor}`)
  assert.deepEqual(slugs(p2), ['disc-a'])
  assert.equal(p2.json.nextCursor, null)
  assert.equal((await call('GET', '/api/projects?cursor=!!')).status, 400)
  assert.equal((await call('GET', '/api/projects?category=food')).status, 422)
  assert.equal((await call('GET', '/api/projects?sort=random')).status, 422)
  assert.equal((await call('POST', '/api/projects', { body: { slug: 'nope', title: 'x' } })).status, 401, 'owner routes still need auth')
  assert.equal((await call('GET', `/api/projects/${a}`, { token })).status, 200, 'owner GET still works')
  step('discover: sorts, weekSats, category, q, paging, visibility')

  const lb = await call('GET', '/api/p/disc-a/leaderboard?limit=2')
  assert.deepEqual(lb.json.leaders.map((l) => l.amountSats), [300, 200])
  assert.equal(lb.json.leaders[0].name, 's300')
  assert.equal(lb.headers.get('cache-control'), 'public, max-age=15')
  assert.equal((await call('GET', '/api/p/disc-a/leaderboard')).json.leaders.length, 3)
  assert.deepEqual((await call('GET', '/api/p/disc-a')).json.leaders.map((l) => l.amountSats), [300, 200, 50], 'embedded leaderboard')
  assert.equal((await call('GET', '/api/p/disc-draft/leaderboard')).status, 404)
  step('leaderboard: largest payments first, limit')
}

// ─── Sprinkle: one payment to the platform wallet (mock NWC), split across random projects ───
{
  const cfg = (await call('GET', '/api/sprinkles/config')).json
  assert.equal(cfg.enabled, true)
  assert.ok(cfg.eligibleProjects >= 2, `need 2 eligible projects, have ${cfg.eligibleProjects}`)
  const tooSmall = await call('POST', '/api/sprinkles', { body: { amountSats: 21, projectCount: 2 } })
  assert.equal(tooSmall.status, 422)
  assert.equal(tooSmall.json.error.code, 'amount_out_of_range')
  if (cfg.eligibleProjects < 10) {
    const tooMany = await call('POST', '/api/sprinkles', { body: { amountSats: 21_000, projectCount: cfg.eligibleProjects + 1 } })
    assert.equal(tooMany.json.error.code, 'not_enough_projects')
  }

  const created = await call('POST', '/api/sprinkles', { body: { amountSats: 1000, projectCount: 2, supporterName: 'Sprinkler', comment: 'sprinkle!' } })
  assert.equal(created.status, 201, JSON.stringify(created.json))
  assert.equal(created.json.status, 'pending')
  assert.equal(created.json.perProjectSats, 490)
  const nwcInvoice = await (await fetch(`${WALLET}/nwc/last`)).json()
  assert.equal(nwcInvoice.pr, created.json.bolt11)
  // The first payout attempt fails (no route): it must be retried with a fresh invoice.
  await fetch(`${WALLET}/nwc/fail-next`, { method: 'POST' })
  await fetch(`${WALLET}/pay/${nwcInvoice.paymentHash}`, { method: 'POST' })

  let s
  const t0 = Date.now()
  for (;;) {
    s = (await call('GET', `/api/sprinkles/${created.json.id}`)).json
    if (s.status === 'done' || Date.now() - t0 > 30_000) break
    await sleep(500)
  }
  assert.equal(s.status, 'done', JSON.stringify(s))
  assert.equal(s.payouts.length, 2)
  assert.ok(s.payouts.every((p) => p.status === 'paid' && p.amountSats === 490))
  const payments = await (await fetch(`${WALLET}/nwc/payments`)).json()
  assert.ok(payments.some((p) => !p.ok), 'expected the simulated failure')

  // Each payout lands as an ordinary supporter payment on its project.
  for (const p of s.payouts) {
    let found = null
    for (let i = 0; i < 40 && !found; i++) {
      found = (await call('GET', `/api/p/${p.slug}/supporters`)).json.supporters.find((x) => x.name === 'Sprinkler' && x.amountSats === 490)
      if (!found) await sleep(500)
    }
    assert.ok(found, `payout to ${p.slug} not visible as a supporter`)
    assert.equal(found.comment, 'sprinkle!')
  }
  step(`sprinkle: NWC invoice → paid → split across 2 random projects in ${Date.now() - t0}ms, failed payout retried`)
}

// Rate limiting: RL_WRITE keeps its production limit (30/min per creator) in --env dev.
{
  const { res } = await nostrLogin(schnorr.utils.randomSecretKey())
  const token = res.json.token
  const rlHandle = `rl-${Date.now() % 1e6}`
  let limited = null
  for (let i = 0; i < 40 && !limited; i++) {
    const r = await call('PATCH', '/api/me', { token, body: { handle: rlHandle, displayName: `rl ${i}` } })
    if (r.status === 429) limited = { i, r }
    else assert.equal(r.status, 200, JSON.stringify(r.json))
  }
  assert.ok(limited, 'expected a 429 within 40 writes')
  assert.ok(limited.i >= 25, `limited too early (after ${limited.i} writes)`)
  assert.equal(limited.r.json.error.code, 'rate_limited')
  assert.equal(limited.r.headers.get('retry-after'), '60')
  // Other creators have their own budget.
  const other = await nostrLogin(schnorr.utils.randomSecretKey())
  assert.equal((await call('PATCH', '/api/me', { token: other.res.json.token, body: { handle: `${rlHandle}-b`, displayName: 'fresh' } })).status, 200)
  step(`rate limit: 429 + Retry-After after ${limited.i} writes, per-creator budget`)
}

viewer.close()
payer.close()
console.log('\nall smoke checks passed')
cleanup()
process.exit(0)
