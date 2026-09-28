# @nampu/api

A single Worker (Hono) that serves the API, the `/p/:slug` SEO shell, `/media/*` from R2,
and the SPA static assets from `apps/web/dist`. The API contract lives in `packages/types`.

## Setup

```sh
pnpm install
npx wrangler d1 create nampu            # paste database_id into wrangler.jsonc
npx wrangler r2 bucket create nampu-media
pnpm --filter @nampu/api db:migrate:local
pnpm --filter @nampu/api dev            # wrangler dev --env dev (allows http:// LNURL)
pnpm --filter @nampu/api smoke          # e2e: mock wallet + wrangler dev
pnpm --filter @nampu/api db:migrate:remote && pnpm --filter @nampu/api deploy
```

After changing `src/db/schema.ts`, run `pnpm db:generate` to produce a new SQL file in `migrations/`.
After changing `wrangler.jsonc`, run `pnpm cf-typegen`.

## Auth (passwordless)

The first successful login creates the account (`creator.handle === null` → onboarding via `PATCH /api/me`
with `handle` + `displayName`; project routes return `403 onboarding_required` until then). Each login opens
a 90-day session (`sessions` table, one row per device, SHA-256 of the `np_…` bearer token).

- **Nostr** (NIP-07 extension / NIP-46 signer): `POST /api/auth/nostr/challenge` → sign a kind-22242 event with
  tags `["challenge", c]` and `["relay", <site origin>]` → `POST /api/auth/nostr { event }`. The server checks
  the NIP-01 id, the BIP-340 signature, ±10 min timestamp, the relay host = this site, and consumes the
  challenge atomically (single use, 5 min TTL).
- **LNURL-auth** (LUD-04): `POST /api/auth/lnurl` → `{ k1, lnurl, pollToken }`; the wallet calls
  `GET /api/auth/lnurl/callback?tag=login&k1&sig&key` (DER ECDSA over k1); the browser polls
  `GET /api/auth/lnurl/:k1` with `X-Poll-Token` until `status: ok`. The poll token binds the session to the
  browser that showed the QR, so a photographed QR can't be used to steal the session.
- `POST /api/auth/logout` revokes the current session.

Signature checks use `@noble/curves` (~0.7 ms warm, ~2 ms cold per verify). Behind a dev proxy, keep the
`Host` header (Vite `changeOrigin: false`) so the relay/LNURL origin matches what the browser sees.

## Owner endpoints

- `GET /api/projects/:id/stats?range=today|7d|30d|all&tz=<minutes>` — one indexed D1 aggregate: totals,
  anonymous count, previous-window comparison, 14 buckets.
- `GET /api/projects/:id/supporters?q=&filter=all|message&cursor=&limit=` — `&format=csv` exports up to
  5000 rows (formula-injection safe).
- `POST /api/projects/:id/images` — inline story images (same limits as the cover).

## Public endpoints (Discover)

- `GET /api/projects?category=&sort=trending|new|ending|funded&q=&limit=&cursor=` — no auth. Active projects not
  past `endsAt`, without story body, each with `weekSats` (paid in the last 7 days, correlated sum on the
  `(project_id, status, paid_at)` index). Offset cursor (base36, max 1000); `limit` 12 default / 48 max;
  `cache-control: public, max-age=30`. Registered before the owner `/api/projects/*` routes so it skips auth.
- `GET /api/p/:slug/leaderboard?limit=` — largest single payments (5 default / 20 max). Names are free text,
  so totals are not summed by name. `max-age=15`.

## Payment flow (non-custodial)

1. `POST /api/p/:slug/invoices` → Worker fetches the creator's LUD-16 `payRequest` (subrequest 1),
   then calls its callback with amount/comment (subrequest 2). The callback must return a LUD-21 `verify` URL.
2. The BOLT11 is decoded (amount, expiry, payment hash — no signature check) and must match the request.
3. `ProjectRoom.trackInvoice()` (DO RPC) stores the invoice in the DO's SQLite and sets an alarm. Then the
   invoice row is inserted into D1 and returned to the payer.
4. The alarm polls due invoices (≤ 25 per run): every 3s for the first 2 min → 10s → 30s → 60s, until
   expiry + 30s. When `settled` is true and `sha256(preimage) == payment_hash`, one D1 batch marks the
   invoice paid and increments the project totals. The update is conditional on `status='pending'`, so it
   stays idempotent when retried. The event is then broadcast over WebSocket.
5. With nothing pending, the alarm is deleted and the DO hibernates. WebSocket `ping` → `pong` is handled
   by the runtime without waking it.

Money never passes through the platform. Wallets that don't implement LUD-21 are rejected when the
creator sets their address (`PATCH /api/me` probes by requesting a throwaway invoice).

## Free plan budget

| Limit | How it is kept |
|---|---|
| 10 ms CPU / request | No crypto beyond SHA-256 (WebCrypto); streaming HTMLRewriter; R2 uploads streamed; LNURL responses capped at 64 KiB |
| 50 subrequests | Invoice creation = 2, address probe = 2, alarm ≤ 25 verify calls |
| DO requests (100k/day) | Poll interval backs off with invoice age; ≤ 50 pending invoices per project; no alarm when idle |
| Bundle size | ~98 KiB gzip (hono, drizzle-orm, valibot, noble secp256k1); no `nodejs_compat` |
| Abuse | Workers Rate Limiting bindings per IP / per creator (see root README), 429 + `Retry-After` |

## Known gaps / next steps

- Rate limits are per Cloudflare location and eventually consistent (by design of the binding): they stop
  bursts and scripted abuse, not a distributed attacker. Expired challenges/sessions are swept on each new challenge.
- Rewards and project updates are not modelled yet.
