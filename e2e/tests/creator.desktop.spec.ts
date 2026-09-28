import { expect, seedCreator, seedProject, signInAs, test, wallet } from '../fixtures'
import { readFileSync } from 'node:fs'

// 5b (dashboard table) and 6b (editor with sidebar + live preview).

test('dashboard: KPIs, search, message filter, CSV, logout', async ({ page }) => {
  const c = await seedCreator('Desk Creator')
  const p = await seedProject(c.token, { goalSats: 10_000 })
  await wallet.payProject(p.slug, 3000, 'ploy', 'รอสมุดอยู่นะคะ')
  await wallet.payProject(p.slug, 1000)
  await wallet.waitForRaised(p.slug, 4000)
  await signInAs(page, c.token)
  await page.goto(`/dashboard/${p.id}`)

  await expect(page.getByRole('heading', { name: p.title })).toBeVisible()
  await expect(page.getByText('4,000', { exact: true }).first()).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText('1 คนไม่ระบุชื่อ')).toBeVisible()

  await page.getByPlaceholder('ค้นหาชื่อหรือข้อความ').fill('zzz')
  await expect(page.getByText('ไม่พบผู้สนับสนุนที่ตรงกับการค้นหา')).toBeVisible()
  await page.getByPlaceholder('ค้นหาชื่อหรือข้อความ').fill('')
  await page.getByText('มีข้อความ', { exact: true }).click()
  await expect(page.getByRole('cell', { name: 'รอสมุดอยู่นะคะ' })).toBeVisible()
  await expect(page.getByRole('cell', { name: 'ไม่ระบุชื่อ' })).toHaveCount(0)

  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'CSV' }).click()
  const csv = readFileSync((await (await download).path())!, 'utf8')
  expect(csv).toContain('รอสมุดอยู่นะคะ')

  await page.getByRole('button', { name: 'Desk Creator' }).click()
  await page.getByRole('menuitem', { name: 'ออกจากระบบ' }).click()
  await expect(page).toHaveURL(/\/login$/)
})

test('editor: live card preview and the goal lock on a published project', async ({ page }) => {
  const c = await seedCreator()
  const p = await seedProject(c.token, { goalSats: 10_000 })
  await wallet.payProject(p.slug, 6000)
  await wallet.waitForRaised(p.slug, 6000)
  await signInAs(page, c.token)
  await page.goto(`/projects/${p.id}/edit?step=0`)

  await page.getByLabel('ชื่อโปรเจกต์').fill('ชื่อใหม่ที่เห็นในการ์ด')
  await expect(page.locator('article.card').getByText('ชื่อใหม่ที่เห็นในการ์ด')).toBeVisible()
  await expect(page.getByLabel('ลิงก์โปรเจกต์')).toBeDisabled() // slug locked once published

  await page.getByRole('button', { name: 'เป้าหมายและระยะเวลา' }).click()
  await expect(page.getByText(/ลดเป้าหมายต่ำกว่ายอดที่ได้รับแล้ว \(6,000 sats\)/).first()).toBeVisible()
  await page.getByLabel('เป้าหมาย').fill('5000')
  await expect(page.getByText(/ลดเป้าหมายต่ำกว่ายอดที่ได้รับแล้ว/)).toHaveCount(2) // note + field error
})
