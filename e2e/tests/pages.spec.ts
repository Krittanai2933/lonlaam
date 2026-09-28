import { expect, seedCreator, seedProject, signInAs, test } from '../fixtures'

// Every screen renders on both layouts and in both themes without page errors
// (the fixture fails the test on any pageerror / console.error).

test('public pages render, theme and language toggles work', async ({ page }) => {
  const c = await seedCreator()
  const p = await seedProject(c.token)

  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'ระดมทุนด้วย Bitcoin ให้คนที่ลงมือทำ' })).toBeVisible()
  await page.getByRole('button', { name: 'สลับธีม' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.getByRole('button', { name: 'EN' }).click()
  await expect(page.getByRole('heading', { name: 'Bitcoin crowdfunding for people who build' })).toBeVisible()

  await page.goto(`/p/${p.slug}`)
  await expect(page.getByRole('heading', { name: p.title })).toBeVisible()
  await page.goto('/p/does-not-exist')
  await expect(page.getByText(/Project not found|ไม่พบโปรเจกต์นี้/)).toBeVisible()
})

test('creator pages render for a signed-in creator', async ({ page }) => {
  const c = await seedCreator()
  const p = await seedProject(c.token)
  await signInAs(page, c.token)
  await page.goto(`/dashboard/${p.id}`)
  await expect(page.getByText('แดชบอร์ดผู้สร้าง').first()).toBeVisible()
  for (const step of [0, 1, 2, 3, 4]) {
    await page.goto(`/projects/${p.id}/edit?step=${step}`)
    await expect(page.getByRole('heading', { level: 2 }).first()).toBeVisible()
  }
  await page.goto('/projects/new')
  await expect(page.getByLabel('ชื่อโปรเจกต์')).toHaveValue('')
})

test('signed-out creator routes redirect to login', async ({ page }) => {
  await page.goto('/dashboard')
  await expect(page).toHaveURL(/\/login$/)
})
