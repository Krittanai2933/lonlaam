# ล้นหลาม Lonlaam

Non-custodial Bitcoin Lightning crowdfunding that runs on the Cloudflare Workers Free plan. It is live at
[lonlaam.com](https://lonlaam.com). The code name, used for packages and resources, is **nampu** (น้ำพุ).

Supporters pay creators straight from their own wallets. Each invoice comes from the creator's own
Lightning Address, and payments are confirmed with LUD-21, so the platform never holds project money.

## Features

- **Passwordless login** with Nostr (NIP-07 extension or NIP-46 signer) or LNURL-auth.
- **Projects** with a Markdown story, cover and inline images, a goal, milestones, an end date, and an
  English version (written by the creator or machine translated).
- **Contributions** by Lightning invoice from the creator's wallet. Supporters can stay anonymous or
  prove a Nostr identity. The live activity feed and leaderboard update over WebSocket.
- **Rewards.** Creators offer tiers with a minimum amount and an optional limit. Supporters pick one when
  paying and leave a contact that only the creator sees. The dashboard tracks what is still to send.
- **Creator dashboard** with stats by time range, supporter search and filters, and CSV export.
- **Discover** page with categories, search, and trending, new, ending and funded sorts.
- **Sprinkles.** A supporter pays once and it is split across random projects, either once or every month
  from their own wallet over Nostr Wallet Connect.

## Packages

| Package | What |
|---|---|
| `apps/api` | Hono Worker: API, D1, Durable Objects, R2, SEO shell; serves `apps/web/dist` as static assets. See its README. |
| `apps/web` | Vite + React SPA (creator login, onboarding, project editor, dashboard). |
| `packages/ui` | Classical/Nampu design system: tokens as Tailwind v4 `@theme` + CSS variables, DS component classes, React components. |
| `packages/types` | API contract shared by api and web. |

## Develop

```sh
pnpm install
pnpm --filter @nampu/api db:migrate:local
pnpm --filter @nampu/api dev        # Worker on :8787 (wrangler dev --env dev)
pnpm --filter @nampu/web dev        # Vite on :5173, proxies /api, /media, /p/ to :8787
```

For local payments and Lightning Address checks, run the mock wallet
(`node apps/api/scripts/mock-wallet.mjs`) and use `alice@localhost:8790` as the Lightning Address.

Demo data and payments (with all three running):

```sh
node apps/api/scripts/seed-demo.mjs                       # 6 sample projects + payments; prints a session token
node apps/api/scripts/demo-pay.mjs chiangmai-library 5000 "ป้าแดง" "เป็นกำลังใจให้นะ"
```

When you pay an invoice from the UI, settle it with `curl -X POST localhost:8790/pay/$(curl -s localhost:8790/last | jq -r .paymentHash)`.

## Check / build / deploy

```sh
pnpm typecheck && pnpm test
pnpm --filter @nampu/api smoke      # API end-to-end against wrangler dev (stop dev servers first)
pnpm e2e                            # browser e2e (Playwright), see below
pnpm build                          # web build → worker dry-run bundle
pnpm --filter @nampu/api db:migrate:remote
pnpm --filter @nampu/api run deploy
```

The smoke test resets the local dev database (`apps/api/.wrangler/state`). Back it up first if you want
to keep your local data. Apply migrations before deploying, because the new code reads the new columns.

## Self-host

You need a Cloudflare account. Everything fits the Workers Free plan.

1. Create the resources and paste the D1 `database_id` into `apps/api/wrangler.jsonc`:

   ```sh
   npx wrangler d1 create nampu
   npx wrangler r2 bucket create nampu-media
   ```

2. In `apps/api/wrangler.jsonc`, replace the values that belong to lonlaam.com:
   - `routes` (custom domains), `PUBLIC_ORIGIN` and `MEDIA_ORIGIN`.
   - `SITE_NAME` and `EMAIL_FROM`.
   - `PLATFORM_ADDRESS`, the Lightning Address that receives the platform's share of monthly
     sprinkles. Leave it empty to keep that share in the platform wallet.
   - The rate limit `namespace_id`s, if they clash with another Worker in your account.

   Then run `pnpm --filter @nampu/api cf-typegen`.

3. Set `SUPPORT_ADDRESS` in `apps/web/src/components/PublicChrome.tsx` to the Lightning Address that
   receives donations to your instance.

4. Set the secrets you need. Every one is optional, and the feature it enables stays off without it.

   | Secret | Enables |
   |---|---|
   | `NWC_URL` | Sprinkles: a Nostr Wallet Connect string for the platform wallet that receives and splits them. |
   | `NWC_ENC_KEY` | Automatic monthly payment: encrypts supporters' NWC strings (`openssl rand -hex 32`). Never change it once set. |
   | `RESEND_API_KEY` | Email notices for monthly sprinkles, sent through [Resend](https://resend.com) from `EMAIL_FROM`. |
   | `ANTHROPIC_API_KEY` | Machine translation of project text to English. |

   ```sh
   cd apps/api && npx wrangler secret put NWC_URL
   ```

5. Build, migrate and deploy with the commands in the previous section.

Creators need a Lightning Address whose wallet supports LUD-21 (`verify`). The platform checks this when
they save it.

### Browser e2e (`e2e/`)

Playwright drives the real stack: mock wallet, `wrangler dev --env dev` with its own local state
(`apps/api/.wrangler/e2e`, reset on start) and Vite. Each spec runs at 390px (**mobile** project) and
1280px (**desktop** project); `*.mobile.spec.ts` / `*.desktop.spec.ts` run on one layout only. Any page
error or `console.error` fails the test.

```sh
pnpm --filter @nampu/e2e install-browser   # once (Chromium)
pnpm e2e                                   # reuses dev servers if they are already running
CI=1 pnpm e2e                              # always starts fresh servers, 1 retry, GitHub reporter
pnpm --filter @nampu/e2e e2e:ui            # interactive
```

Covered: Nostr (NIP-07) and LNURL-auth login, onboarding, the 5-step editor with autosave and publish,
Lightning Address LUD-21 check, dashboard live updates / search / filter / CSV / logout, goal lock,
Discover filters, search and trending, and every contribute state (create, copy, pay, anonymous,
cancel-confirm, amount error, expiry, node unreachable + retry), rewards (editor, the creator's English
reward text, reward card → picker with minimum and contact, reward tag in the live feed, sold out, dashboard
"to send" count and mark sent, mobile rewards tab), and the monthly sprinkle (login without
onboarding, auto-pay from an NWC wallet, revoked wallet → pay by hand, pause/resume, cancel). Not covered: NIP-46 remote signers and
publishing a share note to real Nostr relays.

## Rate limits

Workers Rate Limiting bindings (Free plan; per Cloudflare location, 60s window), declared in
`apps/api/wrangler.jsonc`:

| Binding | Routes | Key | Limit / min |
|---|---|---|---|
| `RL_INVOICE` | `POST /api/p/:slug/invoices` | IP | 10 |
| `RL_AUTH` | Nostr challenge + login, LNURL-auth start | IP | 20 |
| `RL_POLL` | LNURL-auth wallet callback + browser poll | IP | 60 |
| `RL_WRITE` | `PATCH /api/me` (Lightning Address probe), project create/update, uploads | creator | 30 |

Over the limit → `429 rate_limited` with `Retry-After: 60`. `--env dev` raises all but `RL_WRITE` so
the smoke/e2e/seed scripts can run; the smoke test checks the real 429. The `namespace_id`s must be
unique within your Cloudflare account. Invoices are also capped at 50 pending per project.

## Design tokens

`packages/ui/src/styles/theme.css` is the single source: DS variable names (`--color-bg`,
`--color-accent-700`, …) double as Tailwind utilities (`bg-bg`, `text-accent-700`, `border-divider`,
`text-success`, `font-heading`, `text-h1`, `p-s3`, `rounded-md`, `shadow-md`). Dark mode redefines the
same variables under `[data-theme=dark]`, with a `dark:` variant for the rare exception.
