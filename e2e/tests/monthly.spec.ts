import { expect, installNip07, nostrLogin, seedCreator, seedProject, signInAs, test, WALLET } from '../fixtures'

// Monthly sprinkle (added — no design), both layouts. The mock wallet's NWC connection doubles
// as the supporter's own wallet (it can pay the platform's invoices).

const MOCK_NWC =
  'nostr+walletconnect://ebdda12636f35f00fe588fbcf77fa6f763ea4a88eaa1fcd6d51fc31d4fd334d5?relay=ws://localhost:8791&secret=a5dc994f93583db22acc96d86081ae48061d293f0aafd12d3692c5ab5aa5b3ad'

test.beforeEach(async () => {
  // Something open to sprinkle on.
  const c = await seedCreator()
  await seedProject(c.token, { goalSats: 10_000_000 })
  await seedProject(c.token, { goalSats: 10_000_000 })
})

test('login from /monthly skips creator onboarding and comes back', async ({ page }) => {
  await installNip07(page)
  await page.goto('/monthly')
  await expect(page).toHaveURL(/\/login$/)
  await page.getByRole('button', { name: /ส่วนขยายเบราว์เซอร์/ }).click()
  await expect(page).toHaveURL(/\/monthly$/)
  await expect(page.getByRole('heading', { name: 'สุ่มแจกน้ำใจทุกเดือน' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'เริ่มสนับสนุนรายเดือน' })).toBeVisible()
})

test('start with a wallet: first month paid automatically, then see the draw', async ({ page }) => {
  const { token } = await nostrLogin()
  await signInAs(page, token)
  await page.goto('/monthly')
  await page.getByRole('button', { name: '1,000', exact: true }).click()
  await page.getByRole('radio', { name: '5%' }).click()
  // 1000 − 2% − 5% = 930 sats to projects, 50 to Lonlaam, 20 for fees.
  await expect(page.getByText('930 sats สุ่มแบ่งให้ 1–3 โปรเจกต์ · 50 sats ให้ล้นหลาม · 20 sats ค่าธรรมเนียมเครือข่าย')).toBeVisible()
  await page.getByRole('button', { name: 'มากสุด +1' }).click()
  await expect(page.getByText('930 sats สุ่มแบ่งให้ 1–4 โปรเจกต์', { exact: false })).toBeVisible()
  await page.getByLabel('จ่ายอัตโนมัติจากกระเป๋าของคุณ (NWC)').fill(MOCK_NWC)
  await page.getByRole('button', { name: 'เริ่มสนับสนุนรายเดือน' }).click()

  await expect(page.getByText('เชื่อมต่อแล้ว: localhost:8791')).toBeVisible()
  await expect(page.getByText('ใช้งานอยู่')).toBeVisible()
  const history = page.locator('section', { has: page.getByRole('heading', { name: 'ประวัติ' }) })
  await expect(history.getByText('จ่ายแล้ว')).toBeVisible({ timeout: 20_000 })

  await history.getByRole('button', { name: 'ดูผลการสุ่ม' }).click()
  await expect(page.getByText(/ส่งถึง \d โปรเจกต์แล้ว ขอบคุณ!/)).toBeVisible({ timeout: 20_000 })
  await page.getByRole('button', { name: 'ปิด' }).last().click()

  // Pause, then resume.
  await page.getByRole('button', { name: 'หยุดชั่วคราว' }).click()
  await expect(page.getByRole('button', { name: 'กลับมาสนับสนุน' })).toBeVisible()
  await page.getByRole('button', { name: 'กลับมาสนับสนุน' }).click()
  await expect(page.getByText('ใช้งานอยู่')).toBeVisible()
})

test('wallet refuses → month waits → pay by hand with a QR', async ({ page }) => {
  const { token } = await nostrLogin()
  await signInAs(page, token)
  await page.goto('/monthly')
  await fetch(`${WALLET}/nwc/fail-next?code=UNAUTHORIZED`, { method: 'POST' })
  await page.getByLabel('จ่ายอัตโนมัติจากกระเป๋าของคุณ (NWC)').fill(MOCK_NWC)
  await page.getByRole('button', { name: 'เริ่มสนับสนุนรายเดือน' }).click()

  await expect(page.getByText(/จ่ายอัตโนมัติไม่สำเร็จ \(กระเป๋าปฏิเสธการเชื่อมต่อ\)/)).toBeVisible({ timeout: 20_000 })
  await page.getByRole('button', { name: /^จ่ายตอนนี้ · 2,100 sats/ }).click()
  await expect(page.getByRole('img', { name: 'Lightning invoice QR' })).toBeVisible()
  const last = await (await fetch(`${WALLET}/nwc/last`)).json()
  await fetch(`${WALLET}/pay/${last.paymentHash}`, { method: 'POST' })
  await expect(page.getByText(/ส่งถึง \d โปรเจกต์แล้ว ขอบคุณ!/)).toBeVisible({ timeout: 20_000 })
  await page.getByRole('button', { name: 'ปิด' }).last().click()
  const history = page.locator('section', { has: page.getByRole('heading', { name: 'ประวัติ' }) })
  await expect(history.getByText('จ่ายแล้ว')).toBeVisible()

  // Cancel removes the plan.
  page.once('dialog', (d) => void d.accept())
  await page.getByRole('button', { name: 'ยกเลิกรายเดือน' }).click()
  await expect(page.getByRole('button', { name: 'เริ่มสนับสนุนรายเดือน' })).toBeVisible()
})
