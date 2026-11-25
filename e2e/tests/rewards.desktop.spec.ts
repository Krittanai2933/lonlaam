import type { ListOwnerSupportersResponse, Project, ProjectStatsResponse, PublicProject } from '@nampu/types'
import { APP, call, expect, seedCreator, seedProject, signInAs, test, wallet } from '../fixtures'

// 6b step 4 (rewards) → 2c reward cards → 3c reward picker → 5b rewards to send.

test('rewards: the creator adds one, a supporter picks it and pays, the creator marks it sent', async ({ page, browser }) => {
  const c = await seedCreator()
  const p = await seedProject(c.token, { publish: false })
  await signInAs(page, c.token)
  page.on('dialog', (d) => void d.accept())

  // Editor: add a limited reward, then publish.
  await page.goto(`/projects/${p.id}/edit?step=3`)
  await page.getByRole('button', { name: 'เพิ่มรางวัล' }).click()
  await page.getByLabel('ชื่อรางวัล', { exact: true }).fill('โปสการ์ดจากดอย')
  await page.getByLabel('สนับสนุนขั้นต่ำ').fill('5000')
  await page.getByLabel('จำนวนจำกัด').fill('2')
  await page.getByLabel('รายละเอียดรางวัล').fill('เขียนด้วยมือ ส่งทางไปรษณีย์')
  const saved = () => call<Project>('GET', `/api/projects/${p.id}`, { token: c.token })
  await expect.poll(async () => (await saved()).rewards).toMatchObject([
    { title: 'โปสการ์ดจากดอย', minSats: 5000, limit: 2, description: 'เขียนด้วยมือ ส่งทางไปรษณีย์', claimed: 0, backers: 0 },
  ])
  const rewardId = (await saved()).rewards[0]!.id

  // Its English text, written by the creator alongside the rest of the English version.
  await page.goto(`/projects/${p.id}/edit?step=1`)
  await page.getByRole('button', { name: 'เขียนภาษาอังกฤษเอง' }).click()
  await page.getByLabel('ชื่อโปรเจกต์ (English)').fill('Mountain library')
  await page.getByLabel('ชื่อรางวัล โปสการ์ดจากดอย (English)').fill('Postcard from the mountain')
  await expect.poll(async () => (await saved()).translation?.rewards).toEqual([
    { id: rewardId, title: 'Postcard from the mountain', description: 'เขียนด้วยมือ ส่งทางไปรษณีย์' },
  ])
  await page.goto(`/projects/${p.id}/edit?step=4`)
  await page.getByRole('button', { name: 'เผยแพร่โปรเจกต์' }).click()
  await expect(page).toHaveURL(new RegExp(`/dashboard/${p.id}$`))
  await expect(page.getByText('ส่งครบแล้ว')).toBeVisible()

  // Supporter: the reward card opens the contribute modal with it chosen.
  await page.goto(`/p/${p.slug}`)
  const card = page.getByRole('button', { name: /โปสการ์ดจากดอย/ })
  await expect(card).toContainText('5,000 sats ขึ้นไป')
  await expect(card).toContainText('ผู้สนับสนุน 0 คน · เหลือ 2')
  await card.click()
  const modal = page.getByRole('dialog')
  await expect(modal.getByRole('radio', { name: /โปสการ์ดจากดอย/ })).toBeChecked()
  await modal.getByRole('button', { name: /^1,000/ }).click()
  await expect(modal.getByText('รางวัลนี้ต้องสนับสนุนอย่างน้อย 5,000 sats')).toBeVisible()
  const create = modal.getByRole('button', { name: 'สร้าง invoice' })
  await expect(create).toBeDisabled()
  await modal.getByRole('button', { name: /^5,000/ }).click()
  await expect(create).toBeDisabled() // no contact yet
  await modal.getByLabel('ผู้สร้างติดต่อคุณทางไหน: อีเมล, Nostr, LINE…').fill('kaew@example.com')
  await modal.getByLabel('ชื่อที่จะแสดง (ไม่บังคับ)').fill('แก้ว')
  await create.click()
  await expect(modal.getByRole('img', { name: 'Lightning invoice QR' })).toBeVisible()
  await wallet.payLast()
  await expect(modal.getByText('ขอบคุณ!')).toBeVisible({ timeout: 15_000 })
  await modal.getByRole('button', { name: 'กลับไปที่โปรเจกต์' }).click()

  // The activity feed shows the reward they chose (live, from the WebSocket broadcast).
  await expect(page.getByText('แก้ว').first()).toBeVisible()
  await expect(page.locator('.tag', { hasText: 'โปสการ์ดจากดอย' }).first()).toBeVisible()

  // Public responses name the reward but never the contact.
  const pub = await fetch(`${APP}/api/p/${p.slug}`).then((r) => r.text())
  expect(pub).not.toContain('kaew@example.com')
  const pubData = JSON.parse(pub) as PublicProject & { supporters: { supporters: { reward: unknown }[] } }
  expect(pubData.supporters.supporters[0]!.reward).toEqual({ id: rewardId, title: 'โปสการ์ดจากดอย' })
  expect(pubData.rewards[0]).toMatchObject({ claimed: 1, backers: 1 })

  // English readers see the creator's English reward text on the cards and in the feed.
  const reader = await browser.newPage()
  await reader.addInitScript(() => localStorage.setItem('nampu.lang', 'en'))
  await reader.goto(`/p/${p.slug}`)
  await expect(reader.getByRole('button', { name: /Postcard from the mountain/ })).toContainText('1 backers · 1 left')
  await expect(reader.locator('.tag', { hasText: 'Postcard from the mountain' }).first()).toBeVisible()
  await reader.close()

  // Dashboard: one reward to send; marking it sent clears the count.
  await page.goto(`/dashboard/${p.id}`)
  const kpi = page.getByText('รางวัลที่ต้องส่ง').locator('..')
  await expect(kpi).toContainText('1')
  await kpi.getByRole('button', { name: 'ดูรายการ' }).click()
  await expect(page.getByRole('radio', { name: 'มีรางวัล' })).toBeChecked()
  const row = page.getByRole('row', { name: /แก้ว/ })
  await expect(row).toContainText('kaew@example.com')
  const sent = row.getByRole('button', { name: 'ส่งแล้ว' })
  await expect(sent).toHaveAttribute('aria-pressed', 'false')
  await sent.click()
  await expect(sent).toHaveAttribute('aria-pressed', 'true')
  await expect(kpi).toContainText('ส่งครบแล้ว')
  const stats = await call<ProjectStatsResponse>('GET', `/api/projects/${p.id}/stats?range=all`, { token: c.token })
  expect(stats.allTime.rewardsToSend).toBe(0)
  const owner = await call<ListOwnerSupportersResponse>('GET', `/api/projects/${p.id}/supporters?filter=reward`, { token: c.token })
  expect(owner.supporters[0]!.reward).toMatchObject({ id: rewardId, contact: 'kaew@example.com', sentAt: expect.any(Number) })

  // An unpaid invoice holds the last one; then the reward is sold out.
  await call('POST', `/api/p/${p.slug}/invoices`, { body: { amountSats: 5000, rewardId, contact: 'npub1someone' } })
  await expect(call('POST', `/api/p/${p.slug}/invoices`, { body: { amountSats: 5000, rewardId, contact: 'x' } })).rejects.toThrow(/409.*reward_unavailable/)
  await expect(call('POST', `/api/p/${p.slug}/invoices`, { body: { amountSats: 4999, rewardId: 'nope', contact: 'x' } })).rejects.toThrow(/409/)
  // A fresh page: this one may still hold the public response (cacheable for 10s).
  const later = await browser.newPage()
  await later.goto(`/p/${p.slug}`)
  const soldOut = later.getByRole('button', { name: /โปสการ์ดจากดอย/ })
  await expect(soldOut).toBeDisabled()
  await expect(soldOut).toContainText('หมดแล้ว')
  await later.close()
})

test('rewards: a reward needs its minimum and a contact', async () => {
  const c = await seedCreator()
  const p = await seedProject(c.token)
  const project = await call<Project>('PATCH', `/api/projects/${p.id}`, {
    token: c.token,
    body: { rewards: [{ id: 'tee', title: 'T-shirt', description: '', minSats: 10_000, limit: null }] },
  })
  expect(project.rewards).toMatchObject([{ id: 'tee', claimed: 0 }])
  await expect(call('POST', `/api/p/${p.slug}/invoices`, { body: { amountSats: 9999, rewardId: 'tee', contact: 'x' } })).rejects.toThrow(/422.*amountSats/)
  await expect(call('POST', `/api/p/${p.slug}/invoices`, { body: { amountSats: 10_000, rewardId: 'tee', contact: ' ' } })).rejects.toThrow(/422.*contact/)
  await expect(
    call('PATCH', `/api/projects/${p.id}`, {
      token: c.token,
      body: { rewards: [{ id: 'a', title: 'A', description: '', minSats: 1, limit: null }, { id: 'a', title: 'B', description: '', minSats: 2, limit: null }] },
    }),
  ).rejects.toThrow(/422/)
})
