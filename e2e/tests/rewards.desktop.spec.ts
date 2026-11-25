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
  // A second row with a name but no minimum is held back, and the editor says so.
  await page.getByRole('button', { name: 'เพิ่มรางวัล' }).click()
  const half = page.getByRole('region', { name: 'สติกเกอร์' })
  await page.getByLabel('ชื่อรางวัล', { exact: true }).nth(1).fill('สติกเกอร์')
  await page.getByLabel('จำนวนจำกัด').nth(1).focus()
  await expect(half.getByText('ใส่ยอดขั้นต่ำ', { exact: false })).toHaveCount(0) // still typing in this row
  await page.getByLabel('ชื่อรางวัล', { exact: true }).first().focus()
  await expect(half.getByRole('alert')).toHaveText(/ใส่ยอดขั้นต่ำ/)
  await expect(page.getByText('มีรางวัลที่กรอกไม่ครบ ยังไม่ถูกบันทึก')).toBeVisible()
  await half.getByRole('button', { name: 'ลบรางวัล' }).click()
  await expect(page.getByText('มีรางวัลที่กรอกไม่ครบ ยังไม่ถูกบันทึก')).toHaveCount(0)
  const saved = () => call<Project>('GET', `/api/projects/${p.id}`, { token: c.token })
  await expect.poll(async () => (await saved()).rewards).toMatchObject([
    { title: 'โปสการ์ดจากดอย', minSats: 5000, limit: 2, description: 'เขียนด้วยมือ ส่งทางไปรษณีย์', claimed: 0, backers: 0 },
  ])
  const rewardId = (await saved()).rewards[0]!.id

  // Its English text, written by the creator alongside the rest of the English version.
  await page.goto(`/projects/${p.id}/edit?step=1`)
  await page.getByRole('button', { name: 'เขียนภาษาอังกฤษเอง' }).click()
  await page.getByLabel('ชื่อโปรเจกต์ (English)').fill('Mountain library')
  await expect(page.getByText('5,000 sats', { exact: true })).toBeVisible() // the reward's Thai name and minimum label its English inputs
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
  const card = page.getByRole('article', { name: /โปสการ์ดจากดอย/ })
  await expect(card).toContainText('5,000 sats ขึ้นไป')
  await expect(card).toContainText('ผู้สนับสนุน 0 คน · เหลือ 2')
  // Another viewer, already on the page, sees the counts change without reloading.
  const observer = await browser.newPage()
  const hello = observer
    .waitForEvent('websocket', (ws) => ws.url().includes(`/api/p/${p.slug}/ws`))
    .then((ws) => ws.waitForEvent('framereceived', (f) => String(f.payload).includes('"hello"')))
  await observer.goto(`/p/${p.slug}`)
  await hello
  const observed = observer.getByRole('article', { name: /โปสการ์ดจากดอย/ })
  await expect(observed).toContainText('ผู้สนับสนุน 0 คน · เหลือ 2')
  await card.getByRole('button').click()
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
  await expect(observed).toContainText('ผู้สนับสนุน 0 คน · เหลือ 1')
  await wallet.payLast()
  await expect(modal.getByText('ขอบคุณ!')).toBeVisible({ timeout: 15_000 })
  await expect(observed).toContainText('ผู้สนับสนุน 1 คน · เหลือ 1')
  await observer.close()
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
  await expect(reader.getByRole('article', { name: /Postcard from the mountain/ })).toContainText('1 backer · 1 left')
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
  await expect(row).toContainText('รอส่ง')
  await row.getByRole('button', { name: 'ทำเครื่องหมายว่าส่งแล้ว' }).click()
  await expect(kpi).toContainText('ส่งครบแล้ว')
  await expect(row).not.toContainText('รอส่ง')
  // Undo puts it back to send; marking it again settles it.
  await row.getByRole('button', { name: 'เลิกทำ' }).click()
  await expect(row).toContainText('รอส่ง')
  await expect(kpi).toContainText('ดูรายการ')
  await row.getByRole('button', { name: 'ทำเครื่องหมายว่าส่งแล้ว' }).click()
  await expect(row.getByRole('button', { name: 'เลิกทำ' })).toBeVisible()
  await expect(kpi).toContainText('ส่งครบแล้ว')
  const stats = await call<ProjectStatsResponse>('GET', `/api/projects/${p.id}/stats?range=all`, { token: c.token })
  expect(stats.allTime.rewardsToSend).toBe(0)
  const owner = await call<ListOwnerSupportersResponse>('GET', `/api/projects/${p.id}/supporters?filter=reward`, { token: c.token })
  expect(owner.supporters[0]!.reward).toMatchObject({ id: rewardId, contact: 'kaew@example.com', sentAt: expect.any(Number) })

  // An unpaid invoice holds the last one; then the reward is sold out.
  await call('POST', `/api/p/${p.slug}/invoices`, { body: { amountSats: 5000, rewardId, contact: 'npub1someone' } })
  await expect(call('POST', `/api/p/${p.slug}/invoices`, { body: { amountSats: 5000, rewardId, contact: 'x' } })).rejects.toThrow(/409.*reward_unavailable/)
  await expect(call('POST', `/api/p/${p.slug}/invoices`, { body: { amountSats: 4999, rewardId: 'nope', contact: 'x' } })).rejects.toThrow(/409/)
  await page.goto(`/p/${p.slug}`)
  const soldOut = page.getByRole('article', { name: /โปสการ์ดจากดอย/ })
  await expect(soldOut.getByRole('button')).toBeDisabled()
  await expect(soldOut).toContainText('หมดแล้ว')
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

test('rewards: leaving an invoice frees its reward, and the next contribution starts fresh', async ({ page, browser }) => {
  const c = await seedCreator()
  const p = await seedProject(c.token)
  await call('PATCH', `/api/projects/${p.id}`, {
    token: c.token,
    body: { rewards: [{ id: 'mug', title: 'แก้วกาแฟ', description: '', minSats: 2000, limit: 1 }] },
  })
  const observer = await browser.newPage()
  const hello = observer
    .waitForEvent('websocket', (ws) => ws.url().includes(`/api/p/${p.slug}/ws`))
    .then((ws) => ws.waitForEvent('framereceived', (f) => String(f.payload).includes('"hello"')))
  await observer.goto(`/p/${p.slug}`)
  await hello
  const observed = observer.getByRole('article', { name: /แก้วกาแฟ/ })
  await expect(observed).toContainText('เหลือ 1')

  await page.goto(`/p/${p.slug}`)
  const own = page.locator('article', { hasText: 'แก้วกาแฟ' })
  await page.getByRole('article', { name: /แก้วกาแฟ/ }).getByRole('button').click()
  const modal = page.getByRole('dialog')
  const contact = modal.getByLabel('ผู้สร้างติดต่อคุณทางไหน: อีเมล, Nostr, LINE…')
  await contact.fill('mug@example.com')
  const create = modal.getByRole('button', { name: 'สร้าง invoice' })
  const qr = modal.getByRole('img', { name: 'Lightning invoice QR' })
  await create.click()
  await expect(qr).toBeVisible()
  // The payer's own page shows the claim too (its refetch must not come from the browser cache).
  await expect(own).toContainText('หมดแล้ว')
  await expect(observed).toContainText('หมดแล้ว')
  await page.waitForTimeout(1500)
  await expect(own).toContainText('หมดแล้ว')

  // Going back to change the amount gives the reward back, so the new invoice can take it again.
  await modal.getByRole('button', { name: 'แก้ไข' }).click()
  await expect(observed).toContainText('เหลือ 1')
  await modal.getByRole('button', { name: /^5,000/ }).click()
  await create.click()
  await expect(qr).toBeVisible()
  await expect(observed).toContainText('หมดแล้ว')

  // Cancelling frees it at once, and the next open has no reward chosen.
  await modal.getByRole('button', { name: 'ปิด' }).first().click()
  await page.getByRole('button', { name: 'ยกเลิก invoice' }).click()
  await expect(observed).toContainText('เหลือ 1')
  await expect(own).toContainText('เหลือ 1')
  await page.getByRole('button', { name: 'สนับสนุน', exact: true }).click()
  await expect(modal.getByRole('radio', { name: 'ไม่รับรางวัล' })).toBeChecked()
  await modal.getByRole('radio', { name: /แก้วกาแฟ/ }).check()
  await expect(contact).toHaveValue('')

  // After paying, the next open starts fresh as well.
  await contact.fill('mug@example.com')
  await create.click()
  await expect(qr).toBeVisible()
  await wallet.payLast()
  await expect(modal.getByText('ขอบคุณ!')).toBeVisible({ timeout: 15_000 })
  await modal.getByRole('button', { name: 'กลับไปที่โปรเจกต์' }).click()
  await expect(observed).toContainText('หมดแล้ว')
  await page.getByRole('button', { name: 'สนับสนุน', exact: true }).click()
  await expect(modal.getByRole('radio', { name: 'ไม่รับรางวัล' })).toBeChecked()
  await expect(modal.getByRole('radio', { name: /แก้วกาแฟ/ })).toBeDisabled()
  await observer.close()
})

test('rewards: releasing an invoice is idempotent and only touches a pending one', async () => {
  const c = await seedCreator()
  const p = await seedProject(c.token)
  await call('PATCH', `/api/projects/${p.id}`, { token: c.token, body: { rewards: [{ id: 'pin', title: 'Pin', description: '', minSats: 1000, limit: 1 }] } })
  const inv = await call<{ id: string }>('POST', `/api/p/${p.slug}/invoices`, { body: { amountSats: 1000, rewardId: 'pin', contact: 'x' } })
  await expect(call('POST', `/api/p/${p.slug}/invoices`, { body: { amountSats: 1000, rewardId: 'pin', contact: 'y' } })).rejects.toThrow(/409/)
  await call('POST', `/api/invoices/${inv.id}/release`)
  await call('POST', `/api/invoices/${inv.id}/release`)
  await expect(call('POST', '/api/invoices/nope/release')).rejects.toThrow(/404/)
  // Paid after release: it counts as support, without the reward.
  await wallet.payLast()
  await wallet.waitForRaised(p.slug, 1000)
  const pub = await call<PublicProject>('GET', `/api/p/${p.slug}`)
  expect(pub.rewards[0]).toMatchObject({ claimed: 0, backers: 0 })
  const paid = await call<{ id: string }>('POST', `/api/p/${p.slug}/invoices`, { body: { amountSats: 1000, rewardId: 'pin', contact: 'y' } })
  await wallet.payLast()
  await wallet.waitForRaised(p.slug, 2000)
  await call('POST', `/api/invoices/${paid.id}/release`)
  const after = await call<ListOwnerSupportersResponse>('GET', `/api/projects/${p.id}/supporters?filter=reward`, { token: c.token })
  expect(after.supporters.map((s) => s.reward?.contact)).toEqual(['y'])
})
