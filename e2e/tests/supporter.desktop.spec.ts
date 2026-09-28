import { expect, seedCreator, seedProject, test, uid, wallet } from '../fixtures'

// 1c (Discover hero + trending), 2c (project with sticky panel), 3c (two-column modal).

test('discover: a project with sats this week appears in the trending list', async ({ page }) => {
  const c = await seedCreator()
  const p = await seedProject(c.token, { title: `มาแรง ${uid()}` })
  // Outrank anything else in the e2e database.
  await wallet.payProject(p.slug, 100_000)
  await wallet.payProject(p.slug, 100_000)
  await wallet.waitForRaised(p.slug, 200_000)

  await page.goto('/')
  const trending = page.locator('h6', { hasText: 'มาแรงสัปดาห์นี้' }).locator('..')
  await expect(trending.getByText(p.title)).toBeVisible()
  await page.getByRole('link', { name: 'วิธีการทำงาน' }).first().click()
  await expect(page.getByRole('heading', { name: 'ล้นหลามทำงานอย่างไร' })).toBeInViewport()
})

test('discover: sort menu opens unclipped and reorders the grid', async ({ page }) => {
  const c = await seedCreator()
  const tag = uid()
  const older = await seedProject(c.token, { title: `เก่า ${tag}` })
  const newer = await seedProject(c.token, { title: `ใหม่ ${tag}` })
  await wallet.payProject(older.slug, 5_000) // "trending" puts the older one first
  await wallet.waitForRaised(older.slug, 5_000)

  await page.goto('/')
  await page.getByPlaceholder('ค้นหาโปรเจกต์').fill(tag)
  const titles = page.locator('.card-title')
  await expect(titles.first()).toHaveText(older.title)

  await page.getByRole('button', { name: /เรียงตาม/ }).click()
  const last = page.getByRole('menuitem', { name: 'ใกล้ครบเป้า' })
  await expect(last).toBeVisible()
  // Hit-test the bottom item: a clipping ancestor would make this land elsewhere.
  expect(await last.evaluate((el) => {
    const r = el.getBoundingClientRect()
    return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))
  })).toBe(true)

  await page.getByRole('menuitem', { name: 'ใหม่ล่าสุด' }).click()
  await expect(page.getByRole('menu')).toBeHidden()
  await expect(page.getByRole('button', { name: 'เรียงตาม: ใหม่ล่าสุด' })).toBeVisible()
  await expect(titles.first()).toHaveText(newer.title)
})

test('contribute modal: pay → thank-you, totals update on the page', async ({ page }) => {
  const c = await seedCreator()
  const p = await seedProject(c.token, { goalSats: 10_000 })
  await page.goto(`/p/${p.slug}`)
  await expect(page.getByText('จากเป้า 10,000 sats · 0%')).toBeVisible()

  await page.getByRole('button', { name: 'สนับสนุน', exact: true }).first().click()
  await expect(page.getByText('เลือกจำนวนแล้วกดสร้าง invoice เพื่อแสดง QR')).toBeVisible()
  await page.getByRole('button', { name: /^1,000/ }).click()
  await page.getByRole('button', { name: 'สร้าง invoice' }).click()
  await expect(page.getByRole('img', { name: 'Lightning invoice QR' })).toBeVisible()
  await wallet.payLast()
  await expect(page.getByText('ขอบคุณ!')).toBeVisible({ timeout: 15_000 })
  await page.getByRole('button', { name: 'กลับไปที่โปรเจกต์' }).click()
  await expect(page.getByText('จากเป้า 10,000 sats · 10%')).toBeVisible()
})

test('contribute modal: unreachable creator node shows the error state, retry works', async ({ page }) => {
  const c = await seedCreator()
  const p = await seedProject(c.token)
  await page.goto(`/p/${p.slug}`)
  await page.getByRole('button', { name: 'สนับสนุน', exact: true }).first().click()
  await wallet.failNext()
  await page.getByRole('button', { name: 'สร้าง invoice' }).click()
  await expect(page.getByText('สร้าง invoice ไม่สำเร็จ')).toBeVisible()
  await expect(page.getByText('lnurl_error · 502')).toBeVisible()
  await page.getByRole('button', { name: 'ลองอีกครั้ง' }).click()
  await expect(page.getByText('รอการชำระเงิน')).toBeVisible()
})
