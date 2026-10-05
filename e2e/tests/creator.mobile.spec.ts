import type { Project } from '@nampu/types'
import { call, expect, LN_NO_LUD21, LN_OK, nostrLogin, seedCreator, seedProject, signInAs, test, uid, wallet } from '../fixtures'

// 6a (wizard) → 5a (dashboard), starting from a brand-new account.

test('onboard, build a project in the wizard, publish, and see a payment arrive live', async ({ page }) => {
  const { token } = await nostrLogin()
  await signInAs(page, token)
  const run = uid()

  // Onboarding
  await page.goto('/dashboard')
  await expect(page).toHaveURL(/\/welcome$/)
  await page.getByLabel('ชื่อที่แสดง').fill(`Kru Kaew ${run}`)
  await expect(page.getByLabel('ชื่อผู้ใช้')).toHaveValue(`kru-kaew-${run}`)
  await page.getByRole('button', { name: 'เริ่มใช้งาน' }).click()
  await expect(page).toHaveURL(/\/projects\/new$/) // no projects yet

  // Step 1: slug is suggested from the Latin part of the title, and required
  await page.getByLabel('ชื่อโปรเจกต์').fill('สอนเด็กบนดอยใช้ Lightning')
  await expect(page.getByLabel('ลิงก์โปรเจกต์')).toHaveValue('lightning')
  await page.getByLabel('ลิงก์โปรเจกต์').fill('')
  await page.getByRole('button', { name: 'ถัดไป' }).click()
  await expect(page.getByText('ใส่ชื่อและลิงก์โปรเจกต์ก่อน')).toBeVisible()
  const slug = `doi-${run}`
  await page.getByLabel('ลิงก์โปรเจกต์').fill(slug)
  await page.getByLabel('คำโปรยสั้นๆ').fill('ชุดการสอนและมือถือมือสอง 20 เครื่อง')
  await page.getByRole('radio', { name: 'การศึกษา' }).click()
  await page.getByRole('button', { name: 'ถัดไป' }).click()
  await expect(page).toHaveURL(/\/projects\/\w+\/edit\?step=1/)
  const id = page.url().match(/projects\/(\w+)\/edit/)![1]!

  // Step 2–4
  await page.getByLabel('เรื่องราว').fill('เล่าเรื่อง')
  await page.getByRole('button', { name: 'Bold' }).click()
  await page.getByRole('button', { name: 'ถัดไป' }).click()
  await page.getByLabel('เป้าหมาย').fill('20000')
  await expect(page.getByLabel('เป้าหมาย')).toHaveValue('20,000')
  await page.getByRole('button', { name: 'เพิ่ม' }).click()
  await page.getByLabel('sats').first().fill('5000')
  await page.getByLabel('รายละเอียด').first().fill('มือถือ 5 เครื่องแรก')
  await page.getByRole('button', { name: 'ถัดไป' }).click()
  await expect(page.getByText('เร็วๆ นี้').first()).toBeVisible() // rewards: coming soon
  await page.getByRole('button', { name: 'ถัดไป' }).click()

  // Step 5: publishing needs a LUD-21-capable Lightning Address
  await page.getByRole('button', { name: 'เผยแพร่โปรเจกต์' }).click()
  await expect(page.getByText('ใส่ Lightning address ก่อนเผยแพร่')).toBeVisible()
  await page.getByLabel('Lightning address').fill(LN_NO_LUD21)
  await page.getByLabel('Lightning address').press('Enter')
  await expect(page.getByText(/LUD-21/)).toBeVisible()
  await page.getByLabel('Lightning address').fill(LN_OK)
  await page.getByLabel('Lightning address').press('Enter')
  await expect(page.getByText('ตรวจสอบแล้ว รับ sats ได้')).toBeVisible()
  await page.getByRole('button', { name: 'เผยแพร่โปรเจกต์' }).click()
  await expect(page).toHaveURL(new RegExp(`/dashboard/${id}$`))

  // Autosave persisted every step
  const saved = await call<Project>('GET', `/api/projects/${id}`, { token })
  expect(saved).toMatchObject({ status: 'active', category: 'edu', goalSats: 20000, body: 'เล่าเรื่อง****', milestones: [{ sats: 5000, label: 'มือถือ 5 เครื่องแรก' }] })

  // Live payment over the project's WebSocket, no reload
  await expect(page.getByText('ยังไม่มีผู้สนับสนุน', { exact: false })).toBeVisible()
  await wallet.payProject(slug, 2100, 'แก้ว', 'สู้ๆ ครับ')
  await expect(page.getByText('+2,100')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText('สู้ๆ ครับ')).toBeVisible()
})

test('editor: preview link opens the owner-only page of a draft', async ({ page, context }) => {
  const c = await seedCreator()
  const p = await seedProject(c.token, { publish: false })
  await signInAs(page, c.token)
  await page.goto(`/projects/${p.id}/edit?step=0`)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)

  const [tab] = await Promise.all([context.waitForEvent('page'), page.getByRole('link', { name: 'ดูตัวอย่าง' }).click()])
  await expect(tab).toHaveURL(new RegExp(`/p/${p.slug}\\?preview=${p.id}$`))
  await expect(tab.getByText('ตัวอย่างหน้าโปรเจกต์ เห็นเฉพาะคุณ')).toBeVisible()
  await expect(tab.getByRole('button', { name: 'ยังรับการสนับสนุนในตัวอย่างไม่ได้' }).first()).toBeDisabled()
})
