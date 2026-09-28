// Dev helper: fill a local stack (wrangler dev + mock wallet) with the design's sample projects.
//   node scripts/seed-demo.mjs            (API=http://localhost:5173 to go through the Vite proxy)
// Prints a session token for the first creator; paste it into the browser console:
//   localStorage.setItem('nampu.session', '<token>'); location.href = '/dashboard'
import { schnorr } from '@noble/curves/secp256k1.js'

const API = process.env.API ?? 'http://localhost:5173'
const WALLET = process.env.WALLET ?? 'http://localhost:8790'
const hex = (b) => Buffer.from(b).toString('hex')
const sha256 = async (s) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))

async function call(method, path, { token, body } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: { ...(body && { 'content-type': 'application/json' }), ...(token && { authorization: `Bearer ${token}` }) },
    body: body && JSON.stringify(body),
  })
  const data = await res.json().catch(() => null)
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(data)}`)
  return data
}

async function nostrLogin() {
  const sk = schnorr.utils.randomSecretKey()
  const pubkey = hex(schnorr.getPublicKey(sk))
  const { challenge } = await call('POST', '/api/auth/nostr/challenge')
  const ev = { pubkey, created_at: Math.floor(Date.now() / 1000), kind: 22242, tags: [['challenge', challenge], ['relay', API]], content: '' }
  ev.id = hex(await sha256(JSON.stringify([0, ev.pubkey, ev.created_at, ev.kind, ev.tags, ev.content])))
  ev.sig = hex(schnorr.sign(Buffer.from(ev.id, 'hex'), sk))
  return (await call('POST', '/api/auth/nostr', { body: { event: ev } })).token
}

async function pay(slug, amountSats, supporterName, comment) {
  await call('POST', `/api/p/${slug}/invoices`, { body: { amountSats, ...(supporterName && { supporterName }), ...(comment && { comment }) } })
  const last = await (await fetch(`${WALLET}/last`)).json()
  await fetch(`${WALLET}/pay/${last.paymentHash}`, { method: 'POST' })
}

const day = 86_400_000
// Sample data from the design kit (nampu-kit.js), goals scaled down ×1/100 to fit the mock wallet.
const creators = [
  { handle: 'lanna-btc', displayName: 'ชมรมบิตคอยน์ล้านนา' },
  { handle: 'kru-kaew', displayName: 'ครูแก้ว' },
  { handle: 'ton-mint', displayName: 'ต้น & มิ้นท์' },
]
const projects = [
  { by: 0, slug: 'chiangmai-library', title: 'ห้องสมุด Bitcoin เชียงใหม่', category: 'edu', goalSats: 50000, days: 18,
    summary: 'พื้นที่อ่านหนังสือและเวิร์กช็อปฟรีสำหรับคนที่อยากเข้าใจเงินที่ซื่อสัตย์',
    body: 'เชียงใหม่มีคนสนใจ Bitcoin มากขึ้นทุกปี แต่ยังไม่มีที่ให้นั่งอ่าน ถาม และลองใช้จริงด้วยกัน เราจึงอยากเปิดห้องสมุดเล็กๆ ใกล้คูเมือง เปิดฟรีทุกวันเสาร์\n\nยอดที่ได้จะใช้กับค่าเช่าหนึ่งปี ชั้นหนังสือ หนังสือภาษาไทยและอังกฤษราว 300 เล่ม และอุปกรณ์สำหรับเวิร์กช็อปเรื่องกระเป๋าเงินและการเก็บรักษา\n\nทุกเดือนเราจะโพสต์บัญชีรายรับรายจ่ายในหน้าอัปเดต ผู้สนับสนุนทุกคนจะได้รับเชิญมาวันเปิดห้องสมุด',
    milestones: [{ sats: 15000, label: 'ค่าเช่า 3 เดือนแรกและชั้นหนังสือ' }, { sats: 30000, label: 'หนังสือ 300 เล่มและอุปกรณ์เวิร์กช็อป' }, { sats: 50000, label: 'ค่าเช่าครบหนึ่งปี' }],
    pays: [[10000, 'satoshi_th', 'ดีใจที่มีที่แบบนี้ในเชียงใหม่'], [5000, null, ''], [2100, 'nong_pleng', ''], [1000, 'jack@getalby.com', 'Stay humble, stack sats'], [21000, 'npub1q…k9x', 'ขอให้ห้องสมุดเปิดได้ตามแผนครับ'], [690, 'mint', '']] },
  { by: 1, slug: 'doi-lightning', title: 'สอนเด็กบนดอยใช้ Lightning', category: 'edu', goalSats: 21000, days: 6,
    summary: 'ชุดการสอนและมือถือมือสอง 20 เครื่องสำหรับโรงเรียน 4 แห่งในแม่ฮ่องสอน', body: 'ชุดการสอนและมือถือมือสอง 20 เครื่องสำหรับโรงเรียน 4 แห่งในแม่ฮ่องสอน',
    pays: [[8000, 'ploy', 'สู้ๆ ค่ะครู'], [6000, null, ''], [4600, 'kru_somchai', '']] },
  { by: 2, slug: 'honest-money-s2', title: 'พอดแคสต์ “เงินที่ซื่อสัตย์” ซีซัน 2', category: 'media', goalSats: 15000, days: 32,
    summary: 'สัมภาษณ์คนทำงานจริงในวงการ 12 ตอน พร้อมซับไทยและอังกฤษ', body: 'สัมภาษณ์คนทำงานจริงในวงการ 12 ตอน พร้อมซับไทยและอังกฤษ', pays: [[3000, 'fan01', 'รอฟังอยู่'], [2100, null, ''], [2300, 'bee', '']] },
  { by: 1, slug: 'solar-node', title: 'โหนดชุมชนพลังงานแสงอาทิตย์', category: 'tech', goalSats: 60000, days: 3,
    summary: 'รัน full node และ Lightning node ด้วยแผงโซลาร์ในหมู่บ้าน', body: 'รัน full node และ Lightning node ด้วยแผงโซลาร์ในหมู่บ้าน', pays: [[50000, 'nan_makers_fan', ''], [12100, null, '']] },
  { by: 2, slug: 'phangan-cafe', title: 'ร้านกาแฟรับ sats เกาะพะงัน', category: 'community', goalSats: 12000, days: 41,
    summary: 'ร้านเล็กๆ ที่รับชำระด้วย Lightning เท่านั้น และสอนร้านข้างเคียงให้รับด้วย', body: 'ร้านเล็กๆ ที่รับชำระด้วย Lightning เท่านั้น', pays: [[2900, 'coffee_lover', '']] },
  { by: 0, slug: 'thai-bitcoin-book', title: 'แปลหนังสือ Bitcoin เป็นภาษาไทย', category: 'art', goalSats: 30000, days: 24,
    summary: 'แปล ตรวจทาน และเผยแพร่ฟรีภายใต้สัญญาอนุญาตแบบเปิด', body: 'แปล ตรวจทาน และเผยแพร่ฟรีภายใต้สัญญาอนุญาตแบบเปิด', pays: [[20500, 'reader', 'ขอบคุณทีมแปล']] },
]

const tokens = []
for (const c of creators) {
  const token = await nostrLogin()
  await call('PATCH', '/api/me', { token, body: { ...c, lightningAddress: 'alice@localhost:8790' } })
  tokens.push(token)
}
for (const p of projects) {
  const { by, days, pays, ...body } = p
  const created = await call('POST', '/api/projects', { token: tokens[by], body: { ...body, endsAt: Date.now() + days * day } })
  await call('PATCH', `/api/projects/${created.id}`, { token: tokens[by], body: { status: 'active' } })
  for (const [amt, name, comment] of pays) await pay(p.slug, amt, name, comment)
  console.log(`✓ ${p.slug} (${pays.length} payments)`)
}
await call('POST', '/api/projects', { token: tokens[0], body: { slug: 'draft-idea', title: 'ไอเดียโปรเจกต์ (ร่าง)' } })
console.log('\nPayments settle within a few seconds (Durable Object alarms).')
console.log(`Session for "${creators[0].displayName}":\n  localStorage.setItem('nampu.session', '${tokens[0]}'); location.href = '/dashboard'`)
