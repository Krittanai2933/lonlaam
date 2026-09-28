import { expect, seedCreator, seedProject, test, uid, wallet } from '../fixtures'

// 1a (Discover) → 2a (project) → 3a (invoice sheet).

test('discover: category chips and search lead to the project', async ({ page }) => {
  const c = await seedCreator()
  const tag = uid()
  const media = await seedProject(c.token, { title: `พอดแคสต์ ${tag}`, category: 'media' })
  await seedProject(c.token, { title: `ห้องสมุด ${tag}`, category: 'edu' })

  await page.goto('/')
  await page.getByPlaceholder('ค้นหาโปรเจกต์').fill(tag)
  await expect(page.getByText(`ห้องสมุด ${tag}`)).toBeVisible()
  await page.getByRole('radio', { name: 'สื่อ' }).click()
  await expect(page.getByText(`ห้องสมุด ${tag}`)).toHaveCount(0)
  await page.getByText(`พอดแคสต์ ${tag}`).click()
  await expect(page).toHaveURL(new RegExp(`/p/${media.slug}$`))
  await expect(page.getByRole('heading', { name: `พอดแคสต์ ${tag}` })).toBeVisible()

  await page.goto('/')
  await page.getByPlaceholder('ค้นหาโปรเจกต์').fill(`zzz-${tag}`)
  await expect(page.getByText('ไม่พบโปรเจกต์ที่ตรงกับการค้นหา')).toBeVisible()
})

test('contribute: create, copy, pay → thank-you; supporter shows up live', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  const c = await seedCreator()
  const p = await seedProject(c.token)
  await page.goto(`/p/${p.slug}`)

  await page.getByRole('button', { name: 'สนับสนุน', exact: true }).click()
  await page.getByRole('button', { name: /^5,000/ }).click()
  await page.getByLabel('ชื่อที่จะแสดง (ไม่บังคับ)').fill('ป้าแดง')
  await page.getByLabel('ข้อความถึงผู้สร้าง (ไม่บังคับ)').fill('เป็นกำลังใจให้นะ')
  await page.getByRole('button', { name: 'สร้าง invoice' }).click()
  await expect(page.getByText('รอการชำระเงิน')).toBeVisible()

  await page.getByRole('button', { name: 'คัดลอก', exact: true }).click()
  await expect(page.getByText('คัดลอก invoice แล้ว')).toBeVisible()
  const copied = await page.evaluate(() => navigator.clipboard.readText())
  const issued = await wallet.last()
  expect(copied).toBe(issued.pr)
  expect(issued.comment).toBe('เป็นกำลังใจให้นะ')

  await wallet.payLast()
  await expect(page.getByText('ขอบคุณ!')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText('ป้าแดง')).toBeVisible()
  await page.getByRole('button', { name: 'กลับไปที่โปรเจกต์' }).click()
  await page.getByRole('tab', { name: 'ผู้สนับสนุน' }).click()
  await expect(page.getByText('“เป็นกำลังใจให้นะ”')).toBeVisible()
})

test('contribute: anonymous hides the name field; closing a live invoice asks first', async ({ page }) => {
  const c = await seedCreator()
  const p = await seedProject(c.token)
  await page.goto(`/p/${p.slug}`)
  await page.getByRole('button', { name: 'สนับสนุน', exact: true }).click()
  await page.getByText('ไม่แสดงชื่อของฉัน').click()
  await expect(page.getByLabel('ชื่อที่จะแสดง (ไม่บังคับ)')).toHaveCount(0)
  await page.getByRole('button', { name: 'สร้าง invoice' }).click()
  await expect(page.getByText('รอการชำระเงิน')).toBeVisible()
  await page.getByRole('button', { name: 'ปิด' }).click()
  await expect(page.getByText('ยกเลิกการสนับสนุน?')).toBeVisible()
  await page.getByRole('button', { name: 'ยกเลิก invoice' }).click()
  await expect(page.getByText('รอการชำระเงิน')).toHaveCount(0)
})

test('contribute: amount above the wallet maximum stays on the amount step', async ({ page }) => {
  const c = await seedCreator()
  const p = await seedProject(c.token)
  await page.goto(`/p/${p.slug}`)
  await page.getByRole('button', { name: 'สนับสนุน', exact: true }).click()
  await page.getByRole('button', { name: 'ใส่จำนวนเอง' }).click()
  await page.getByLabel('ใส่จำนวนเอง').fill('200000') // mock wallet max is 100,000 sats
  await page.getByRole('button', { name: 'สร้าง invoice' }).click()
  await expect(page.getByText(/amount must be between/)).toBeVisible()
  await expect(page.getByRole('button', { name: 'สร้าง invoice' })).toBeVisible()
})

test('contribute: an expired invoice can be replaced', async ({ page }) => {
  const c = await seedCreator()
  const p = await seedProject(c.token)
  await page.clock.install()
  await page.goto(`/p/${p.slug}`)
  await page.getByRole('button', { name: 'สนับสนุน', exact: true }).click()
  await page.getByRole('button', { name: 'สร้าง invoice' }).click()
  await expect(page.getByText('รอการชำระเงิน')).toBeVisible()
  await page.clock.fastForward('11:00') // mock invoices expire after 10 minutes
  await expect(page.getByText('หมดอายุแล้ว', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'สร้าง invoice ใหม่' }).click()
  await expect(page.getByText('รอการชำระเงิน')).toBeVisible()
})
