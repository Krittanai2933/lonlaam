import { defineConfig } from '@playwright/test'

const CI = !!process.env.CI
const API_DIR = '../apps/api'

/**
 * Full-stack e2e: mock Lightning wallet (:8790) + API Worker via `wrangler dev --env dev`
 * with its own local state (.wrangler/e2e, reset on start) + Vite (:5173).
 * Locally, already-running dev servers are reused; tests create uniquely named data so
 * they don't depend on a clean database.
 */
export default defineConfig({
  testDir: './tests',
  // The mock wallet's GET /last is global state, so tests run one at a time.
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  retries: CI ? 1 : 0,
  forbidOnly: CI,
  reporter: CI ? [['github'], ['html', { open: 'never' }]] : [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    // Layouts switch at 1024px: 6a/5a/4a/1a/2a/3a vs 6b/5b/4b/1c/2c/3c.
    {
      name: 'mobile',
      testIgnore: /\.desktop\.spec\.ts$/,
      use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
    },
    {
      name: 'desktop',
      testIgnore: /\.mobile\.spec\.ts$/,
      use: { viewport: { width: 1280, height: 900 } },
    },
  ],
  webServer: [
    {
      command: 'node scripts/mock-wallet.mjs',
      cwd: API_DIR,
      url: 'http://localhost:8790/last',
      reuseExistingServer: !CI,
    },
    {
      command:
        'node ../../scripts/ensure-web-dist.mjs && rm -rf .wrangler/e2e && ' +
        'pnpm exec wrangler d1 migrations apply nampu --local --env dev --persist-to .wrangler/e2e && ' +
        'pnpm exec wrangler dev --env dev --port 8787 --persist-to .wrangler/e2e',
      cwd: API_DIR,
      url: 'http://localhost:8787/api/health',
      timeout: 180_000,
      reuseExistingServer: !CI,
    },
    {
      command: 'pnpm exec vite --port 5173 --strictPort',
      cwd: '../apps/web',
      url: 'http://localhost:5173',
      timeout: 60_000,
      reuseExistingServer: !CI,
    },
  ],
})
