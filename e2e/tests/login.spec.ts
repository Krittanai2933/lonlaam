import { secp256k1 } from '@noble/curves/secp256k1.js'
import type { LnurlAuthStartResponse } from '@nampu/types'
import { APP, expect, installNip07, test } from '../fixtures'

// Runs on both layouts: 4a (mobile tabs) and 4b (desktop two-column modal).

test('NIP-07 extension login creates an account and goes to onboarding', async ({ page }) => {
  await installNip07(page)
  await page.goto('/login')
  await page.getByRole('button', { name: /ส่วนขยายเบราว์เซอร์/ }).click()
  await expect(page).toHaveURL(/\/welcome$/)
  await expect(page.getByRole('heading', { name: 'ตั้งชื่อที่แสดง' })).toBeVisible()
})

test('without an extension the button is disabled and a hint is shown', async ({ page }) => {
  await page.goto('/login')
  await expect(page.getByRole('button', { name: /ส่วนขยายเบราว์เซอร์/ })).toBeDisabled()
  await expect(page.getByText('ไม่พบส่วนขยาย Nostr ในเบราว์เซอร์นี้', { exact: false })).toBeVisible()
})

test('LNURL-auth: QR → wallet callback → session', async ({ page }, info) => {
  const starts: Promise<LnurlAuthStartResponse>[] = []
  page.on('response', (r) => {
    if (r.url().endsWith('/api/auth/lnurl') && r.request().method() === 'POST') starts.push(r.json())
  })
  await page.goto('/login')
  if (info.project.name === 'mobile') await page.getByText('Lightning', { exact: true }).click()
  await expect(page.getByRole('img', { name: 'LNURL-auth QR' })).toBeVisible()
  // React StrictMode may start twice in dev; the QR shows the latest one.
  await expect.poll(() => starts.length).toBeGreaterThan(0)
  await page.waitForTimeout(300)
  const start = await starts.at(-1)!

  // Act as the wallet (LUD-04): sign k1 with a linking key and call back.
  const sk = secp256k1.utils.randomSecretKey()
  const key = Buffer.from(secp256k1.getPublicKey(sk, true)).toString('hex')
  const sig = Buffer.from(secp256k1.sign(Buffer.from(start.k1, 'hex'), sk, { prehash: false, format: 'der' })).toString('hex')
  const cb = await (await fetch(`${APP}/api/auth/lnurl/callback?tag=login&k1=${start.k1}&sig=${sig}&key=${key}`)).json()
  expect(cb).toEqual({ status: 'OK' })

  await expect(page).toHaveURL(/\/welcome$/)
})
