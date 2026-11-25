import { call, expect, seedCreator, seedProject, signInAs, test, wallet } from '../fixtures'

// 6a step 4, 2a reward cards, 5a rewards tab.

test('rewards on mobile: editor fits, the card shows on the page, the rewards tab marks it sent', async ({ page }) => {
  const c = await seedCreator()
  const p = await seedProject(c.token)
  await call('PATCH', `/api/projects/${p.id}`, {
    token: c.token,
    body: { rewards: [{ id: 'sticker', title: 'สติกเกอร์', description: 'ชุดสติกเกอร์ 5 แผ่น', minSats: 2000, limit: null }] },
  })
  await call('POST', `/api/p/${p.slug}/invoices`, { body: { amountSats: 2100, supporterName: 'ฝน', rewardId: 'sticker', contact: 'LINE @fon' } })
  await wallet.payLast()
  await wallet.waitForRaised(p.slug, 2100)

  await signInAs(page, c.token)
  await page.goto(`/projects/${p.id}/edit?step=3`)
  await expect(page.getByLabel('ชื่อรางวัล', { exact: true })).toHaveValue('สติกเกอร์')
  await expect(page.getByText('มีคนเลือกแล้ว 1 คน')).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)

  await page.goto(`/p/${p.slug}`)
  await expect(page.getByRole('article', { name: /สติกเกอร์/ })).toContainText('ผู้สนับสนุน 1 คน')

  await page.goto(`/dashboard/${p.id}`)
  await page.getByRole('button', { name: 'รางวัล', exact: true }).click()
  await expect(page.getByText('LINE @fon')).toBeVisible()
  await expect(page.getByText('รอส่ง')).toBeVisible()
  await page.getByRole('button', { name: 'ทำเครื่องหมายว่าส่งแล้ว' }).click()
  await expect(page.getByRole('button', { name: 'เลิกทำ' })).toBeVisible()
  await expect(page.getByText('รอส่ง')).toHaveCount(0)
  await expect.poll(async () => (await call<{ allTime: { rewardsToSend: number } }>('GET', `/api/projects/${p.id}/stats?range=all`, { token: c.token })).allTime.rewardsToSend).toBe(0)
})
