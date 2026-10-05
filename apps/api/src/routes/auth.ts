import { rateLimit } from '../lib/ratelimit'
import type { LnurlAuthPollResponse, LnurlAuthStartResponse, LoginResponse, NostrChallengeResponse } from '@nampu/types'
import { NOSTR_AUTH_KIND } from '@nampu/types'
import { and, eq, gt, isNotNull, isNull, lt } from 'drizzle-orm'
import { Hono } from 'hono'
import type { Context } from 'hono'
import * as v from 'valibot'
import { type AppEnv, publicOrigin } from '../context'
import { authChallenges, sessions } from '../db/schema'
import { encodeLnurl } from '../lib/bech32'
import { ApiError } from '../lib/errors'
import { loginWith } from '../lib/session'
import { EVENT_CLOCK_SKEW_S, verifyLnurlAuth, verifyNostrEvent } from '../lib/signatures'
import { randomHex32, sha256Hex } from '../lib/util'
import { json, nostrEventSchema } from '../lib/validate'
import { requireCreator } from '../middleware'

const CHALLENGE_TTL_MS = 5 * 60_000

const nostrLoginBody = v.object({ event: nostrEventSchema })

const authFailed = (msg: string) => new ApiError(401, 'auth_failed', msg)

/** Cheap housekeeping, off the response path. */
function sweep(c: Context<AppEnv>) {
  const now = Date.now()
  c.executionCtx.waitUntil(
    c.var.db
      .batch([
        c.var.db.delete(authChallenges).where(lt(authChallenges.expiresAt, now)),
        c.var.db.delete(sessions).where(lt(sessions.expiresAt, now)),
      ])
      .catch((e) => console.warn('sweep failed', e)),
  )
}

// LUD-04 wallet responses are always 200 with a status field.
const lnurlOk = (c: Context<AppEnv>) => c.json({ status: 'OK' })
const lnurlErr = (c: Context<AppEnv>, reason: string) => c.json({ status: 'ERROR', reason })

export const authRoutes = new Hono<AppEnv>()
  // ─── Nostr (NIP-07 / NIP-46 sign a NIP-42-style auth event) ─────────────────
  .post('/nostr/challenge', rateLimit('RL_AUTH', 'challenge'), async (c) => {
    const challenge = randomHex32()
    const expiresAt = Date.now() + CHALLENGE_TTL_MS
    await c.var.db.insert(authChallenges).values({ id: challenge, kind: 'nostr', expiresAt })
    sweep(c)
    return c.json({ challenge, expiresAt } satisfies NostrChallengeResponse)
  })

  .post('/nostr', rateLimit('RL_AUTH', 'login'), json(nostrLoginBody), async (c) => {
    const { event } = c.req.valid('json')
    if (event.kind !== NOSTR_AUTH_KIND) throw authFailed(`event kind must be ${NOSTR_AUTH_KIND}`)
    if (Math.abs(event.created_at - Date.now() / 1000) > EVENT_CLOCK_SKEW_S) throw authFailed('event timestamp out of range')

    const tag = (name: string) => event.tags.find((t) => t[0] === name)?.[1]
    const challenge = tag('challenge')
    const relay = tag('relay')
    let relayHost: string | null = null
    try {
      relayHost = relay ? new URL(relay).host : null
    } catch {
      // handled below
    }
    if (!challenge || !/^[0-9a-f]{64}$/.test(challenge)) throw authFailed('missing challenge tag')
    // Binds the signature to this site, so a challenge signed elsewhere can't be replayed here.
    if (relayHost !== new URL(publicOrigin(c.env, c.req.url)).host) throw authFailed('relay tag does not match this site')
    if (!(await verifyNostrEvent(event))) throw authFailed('invalid event id or signature')

    // Consume the challenge atomically: a second use finds nothing.
    const [consumed] = await c.var.db
      .delete(authChallenges)
      .where(and(eq(authChallenges.id, challenge), eq(authChallenges.kind, 'nostr'), gt(authChallenges.expiresAt, Date.now())))
      .returning({ id: authChallenges.id })
    if (!consumed) throw authFailed('challenge expired or already used')

    const res = await loginWith(c.var.db, { kind: 'nostr', pubkey: event.pubkey })
    return c.json(res satisfies LoginResponse)
  })

  // ─── LNURL-auth (LUD-04) ─────────────────────────────────────────────────────
  .post('/lnurl', rateLimit('RL_AUTH', 'challenge'), async (c) => {
    const k1 = randomHex32()
    const pollToken = randomHex32()
    const expiresAt = Date.now() + CHALLENGE_TTL_MS
    await c.var.db
      .insert(authChallenges)
      .values({ id: k1, kind: 'lnurl', pollTokenHash: await sha256Hex(pollToken), expiresAt })
    sweep(c)
    const callback = `${publicOrigin(c.env, c.req.url)}/api/auth/lnurl/callback?tag=login&k1=${k1}&action=login`
    return c.json({ k1, lnurl: encodeLnurl(callback), pollToken, expiresAt } satisfies LnurlAuthStartResponse)
  })

  // Called by the wallet, not the browser.
  .get('/lnurl/callback', rateLimit('RL_POLL', 'lnurl-cb'), async (c) => {
    const { tag, k1 = '', sig = '', key = '' } = c.req.query()
    if (tag !== 'login') return lnurlErr(c, 'unsupported tag')
    const k = key.toLowerCase()
    if (!verifyLnurlAuth(k1.toLowerCase(), sig.toLowerCase(), k)) return lnurlErr(c, 'invalid signature')
    const [row] = await c.var.db
      .update(authChallenges)
      .set({ linkingKey: k })
      .where(
        and(
          eq(authChallenges.id, k1.toLowerCase()),
          eq(authChallenges.kind, 'lnurl'),
          isNull(authChallenges.linkingKey),
          gt(authChallenges.expiresAt, Date.now()),
        ),
      )
      .returning({ id: authChallenges.id })
    return row ? lnurlOk(c) : lnurlErr(c, 'login request expired or already used')
  })

  .get('/lnurl/:k1', rateLimit('RL_POLL', 'lnurl-poll'), async (c) => {
    const k1 = c.req.param('k1').toLowerCase()
    const pollToken = c.req.header('x-poll-token') ?? ''
    c.header('cache-control', 'no-store')
    if (!/^[0-9a-f]{64}$/.test(k1) || !/^[0-9a-f]{64}$/.test(pollToken)) throw authFailed('invalid poll request')
    const pollHash = await sha256Hex(pollToken)
    const owns = and(eq(authChallenges.id, k1), eq(authChallenges.kind, 'lnurl'), eq(authChallenges.pollTokenHash, pollHash))

    // Claim a signed-in challenge exactly once.
    const [claimed] = await c.var.db
      .delete(authChallenges)
      .where(and(owns, isNotNull(authChallenges.linkingKey)))
      .returning({ linkingKey: authChallenges.linkingKey })
    if (claimed?.linkingKey) {
      const res = await loginWith(c.var.db, { kind: 'lnurl', key: claimed.linkingKey })
      return c.json({ status: 'ok', ...res } satisfies LnurlAuthPollResponse)
    }
    const pending = await c.var.db.query.authChallenges.findFirst({
      columns: { expiresAt: true },
      where: owns,
    })
    if (!pending || pending.expiresAt <= Date.now()) return c.json({ status: 'expired' } satisfies LnurlAuthPollResponse)
    return c.json({ status: 'pending' } satisfies LnurlAuthPollResponse)
  })

  // ─── Session ────────────────────────────────────────────────────────────────
  .post('/logout', requireCreator, async (c) => {
    await c.var.db.delete(sessions).where(eq(sessions.tokenHash, c.var.sessionHash))
    return c.body(null, 204)
  })
