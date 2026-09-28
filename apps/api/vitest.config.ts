import { defineConfig } from 'vitest/config'

// Unit tests for pure modules (no Workers runtime needed). End-to-end behaviour is
// covered by scripts/smoke.mjs against `wrangler dev`.
export default defineConfig({ test: { include: ['test/**/*.test.ts'] } })
