import { expect, test } from '../fixtures'

// Large screens scale the whole page with `zoom` (components.css) instead of stretching it.

for (const [width, height, zoom] of [
  [1280, 800, '1'],
  [2560, 1440, '1.5'],
  [3840, 2160, '2'],
] as const) {
  test(`${width}px: page zoom ${zoom}, no horizontal scroll, full-height pages fit the screen`, async ({ page }) => {
    await page.setViewportSize({ width, height })
    for (const [path, ready] of [
      ['/', page.getByRole('heading', { name: 'ล้นหลามทำงานอย่างไร' })],
      ['/login', page.getByRole('button', { name: /ส่วนขยายเบราว์เซอร์/ })],
    ] as const) {
      await page.goto(path)
      await expect(ready).toBeVisible()
      const m = await page.evaluate(() => {
        const d = document.documentElement
        return { zoom: getComputedStyle(d).zoom, sw: d.scrollWidth, cw: d.clientWidth, sh: d.scrollHeight, ch: d.clientHeight }
      })
      expect(m.zoom).toBe(zoom)
      expect(m.sw, `${path} scrolls horizontally`).toBeLessThanOrEqual(m.cw)
      // /login is a min-h-screen page with little content: 100vh must not be multiplied by zoom.
      if (path === '/login') expect(m.sh, 'login taller than the screen').toBeLessThanOrEqual(m.ch)
    }
  })
}
