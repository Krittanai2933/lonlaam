import type { Project } from '@nampu/types'
import { call, expect, seedCreator, seedProject, signInAs, test, wallet } from '../fixtures'
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
  expect(csv.startsWith('\uFEFFpaid_at,'), 'CSV opens with a UTF-8 BOM for Excel').toBe(true)
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

test('editor: preview opens the full page of a draft, only for its owner', async ({ page, context }) => {
  const c = await seedCreator()
  const p = await seedProject(c.token, { goalSats: 10_000, publish: false })
  await signInAs(page, c.token)
  await page.goto(`/projects/${p.id}/edit?step=0`)

  const [tab] = await Promise.all([context.waitForEvent('page'), page.getByRole('link', { name: 'ดูตัวอย่าง' }).click()])
  await expect(tab).toHaveURL(new RegExp(`/p/${p.slug}\\?preview=${p.id}$`))
  await expect(tab.getByText('ตัวอย่างหน้าโปรเจกต์ เห็นเฉพาะคุณ')).toBeVisible()
  await expect(tab.getByRole('heading', { name: p.title })).toBeVisible()
  await expect(tab.getByRole('button', { name: 'ยังรับการสนับสนุนในตัวอย่างไม่ได้' }).first()).toBeDisabled()

  // The public page still hides the draft.
  await tab.goto(`/p/${p.slug}`)
  await expect(tab.getByText('ไม่พบโปรเจกต์')).toBeVisible()
})

test('editor: the creator writes their own English version', async ({ page, browser }) => {
  const c = await seedCreator()
  const p = await seedProject(c.token, { title: 'ห้องสมุดชุมชน', body: 'เรื่องราวภาษาไทย' })
  await signInAs(page, c.token)
  await page.goto(`/projects/${p.id}/edit?step=1`)
  page.on('dialog', (d) => void d.accept())

  // No API key locally, so automatic translation fails and the fields start empty.
  await page.getByRole('button', { name: 'เขียนภาษาอังกฤษเอง' }).click()
  await expect(page.getByText('แปลอัตโนมัติไม่ได้ตอนนี้')).toBeVisible()
  await page.getByLabel('ชื่อโปรเจกต์ (English)').fill('Community Library')
  await page.getByLabel('คำโปรยสั้นๆ (English)').fill('Books for everyone')
  await page.getByLabel('เรื่องราว (English)').fill('Our story in English')
  await page.getByLabel(/10,000 sats/).fill('First step')
  const saved = () => call<Project>('GET', `/api/projects/${p.id}`, { token: c.token })
  await expect.poll(async () => (await saved()).translation?.milestones[0]?.label).toBe('First step')

  // English readers get the creator's version, without the "automatically translated" note.
  const reader = await browser.newPage()
  await reader.addInitScript(() => localStorage.setItem('nampu.lang', 'en'))
  await reader.goto(`/p/${p.slug}`)
  await expect(reader.getByRole('heading', { name: 'Community Library' })).toBeVisible()
  await expect(reader.getByText('Our story in English')).toBeVisible()
  await expect(reader.getByText('First step')).toBeVisible()
  await expect(reader.getByText('Automatically translated from Thai')).toHaveCount(0)
  await reader.getByRole('button', { name: 'Show original' }).click()
  await expect(reader.getByRole('heading', { name: 'ห้องสมุดชุมชน' })).toBeVisible()

  // Changing the Thai afterwards flags the English for review.
  await page.goto(`/projects/${p.id}/edit?step=1`)
  await expect(page.getByLabel('ชื่อโปรเจกต์ (English)')).toHaveValue('Community Library')
  await page.getByRole('textbox', { name: 'เรื่องราว', exact: true }).fill('เรื่องราวภาษาไทยฉบับแก้')
  await expect(page.getByText('คุณแก้ภาษาไทยหลังจากเขียนภาษาอังกฤษไว้')).toBeVisible({ timeout: 10_000 })

  // Back to automatic: the creator's English is gone (and nothing translates it locally).
  await page.getByRole('button', { name: 'กลับไปใช้คำแปลอัตโนมัติ' }).click()
  await expect(page.getByRole('button', { name: 'เขียนภาษาอังกฤษเอง' })).toBeVisible()
  await expect.poll(async () => (await saved()).translation).toBeNull()
  // The public response is cacheable for 10s.
  await expect(async () => {
    await reader.reload()
    await expect(reader.getByRole('heading', { name: 'ห้องสมุดชุมชน' })).toBeVisible({ timeout: 1000 })
  }).toPass({ timeout: 20_000 })
  await reader.close()
})
