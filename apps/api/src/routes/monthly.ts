import type { GetMonthlyResponse, MonthlyConfigResponse, PayMonthlyCycleResponse, PutMonthlyResponse } from '@nampu/types'
import { LIMITS, MONTHLY, monthlyDistributable, monthlyPlatformShare, SPRINKLE } from '@nampu/types'
import { and, desc, eq, gt } from 'drizzle-orm'
import { Hono } from 'hono'
import * as v from 'valibot'
import { type AppEnv, type Db, lnurlOptions, publicOrigin } from '../context'
import { isUniqueViolation } from '../db/errors'
import { type MonthlyPlanRow, monthlyCycles, monthlyPlans, sprinkles } from '../db/schema'
import { type NwcConnection, NwcError, NwcWallet, parseNwcUrl } from '../lightning/nwc'
import { emailEnabled, sendEmail } from '../lib/email'
import { ApiError, notFound } from '../lib/errors'
import { autoPayEnabled, drawMonth, monthlyEnabled, nwcLabel, settleCycles, startCycle, toCycle, toPlan, verifyEmail } from '../lib/monthly'
import { rateLimit, writeLimit } from '../lib/ratelimit'
import { seal } from '../lib/secretbox'
import { countEligible, createSprinkle, toSprinkle } from '../lib/sprinkle'
import { msatToSats, newId, randomHex32, sha256Hex } from '../lib/util'
import { json } from '../lib/validate'
import { requireCreator } from '../middleware'

const EMAIL_TOKEN_TTL_MS = 24 * 60 * 60_000
/** A manual payment reuses the month's invoice only if it has at least this long left. */
const REUSE_INVOICE_MS = 2 * 60_000

const int = (min: number, max: number) => v.pipe(v.number(), v.safeInteger(), v.minValue(min), v.maxValue(max))
const optionalText = (max: number) => v.optional(v.nullable(v.pipe(v.string(), v.trim(), v.maxLength(max))))

const putBody = v.object({
  amountSats: int(MONTHLY.amountSats.min, MONTHLY.amountSats.max),
  projectsMin: int(SPRINKLE.projects.min, SPRINKLE.projects.max),
  projectsMax: int(SPRINKLE.projects.min, SPRINKLE.projects.max),
  excludeFunded: v.optional(v.boolean()),
  tipPercent: v.optional(int(0, MONTHLY.tipPercent.max)),
  supporterName: optionalText(LIMITS.supporterName.max),
  comment: optionalText(LIMITS.comment.max),
  nwcUrl: v.optional(v.nullable(v.pipe(v.string(), v.trim(), v.maxLength(2000)))),
  email: v.optional(v.nullable(v.pipe(v.string(), v.trim(), v.toLowerCase(), v.maxLength(MONTHLY.email.max), v.email()))),
  status: v.optional(v.picklist(['active', 'paused'])),
})

const unavailable = (what = 'monthly sprinkles are') => new ApiError(503, 'monthly_unavailable', `${what} not available right now`)

async function state(db: Db, plan: MonthlyPlanRow | undefined): Promise<GetMonthlyResponse> {
  if (!plan) return { plan: null, cycles: [] }
  await settleCycles(db, plan.id)
  const cycles = await db.select().from(monthlyCycles).where(eq(monthlyCycles.planId, plan.id)).orderBy(desc(monthlyCycles.dueAt)).limit(MONTHLY.history)
  return { plan: toPlan(plan), cycles: cycles.map(toCycle) }
}

/** Asks the supporter's wallet what this connection may do; it must be allowed to pay. */
async function checkWallet(conn: NwcConnection): Promise<void> {
  const wallet = new NwcWallet(conn)
  try {
    const info = await (await wallet.client()).getInfo()
    if (info.methods && !info.methods.includes('pay_invoice')) {
      throw new ApiError(422, 'nwc_invalid', 'this connection is not allowed to pay invoices (pay_invoice)')
    }
  } catch (e) {
    if (!(e instanceof NwcError)) throw e
    if (e.ambiguous) throw new ApiError(422, 'nwc_unreachable', `could not reach your wallet: ${e.message}`)
    // Some wallets don't offer get_info to restricted connections; pay_invoice may still work.
    if (e.code === 'NOT_IMPLEMENTED' || e.code === 'RESTRICTED') return
    throw new ApiError(422, 'nwc_invalid', `your wallet refused the connection: ${e.message}`)
  } finally {
    wallet.close()
  }
}

export const monthlyRoutes = new Hono<AppEnv>()
  .get('/config', async (c) => {
    const enabled = monthlyEnabled(c.env)
    c.header('cache-control', 'public, max-age=30')
    const count = enabled ? await countEligible(c.var.db) : { all: 0 }
    return c.json({ enabled, autoPay: autoPayEnabled(c.env), email: emailEnabled(c.env), eligibleProjects: count.all } satisfies MonthlyConfigResponse)
  })

  /** The link in the verification email; lands back on the monthly page. */
  .get('/email/verify', rateLimit('RL_POLL', 'monthly-email'), async (c) => {
    const token = c.req.query('token') ?? ''
    let ok = false
    if (/^[0-9a-f]{64}$/.test(token)) {
      const rows = await c.var.db
        .update(monthlyPlans)
        .set({ emailVerified: true, emailTokenHash: null, emailTokenExpiresAt: null })
        .where(and(eq(monthlyPlans.emailTokenHash, await sha256Hex(token)), gt(monthlyPlans.emailTokenExpiresAt, Date.now())))
        .returning({ id: monthlyPlans.id })
      ok = rows.length > 0
    }
    return c.redirect(`/monthly?email=${ok ? 'verified' : 'invalid'}`, 302)
  })

  .get('/', requireCreator, async (c) => {
    const plan = await c.var.db.query.monthlyPlans.findFirst({ where: eq(monthlyPlans.creatorId, c.var.creator.id) })
    c.header('cache-control', 'no-store')
    return c.json((await state(c.var.db, plan)) satisfies GetMonthlyResponse)
  })

  .put('/', requireCreator, writeLimit, json(putBody), async (c) => {
    const body = c.req.valid('json')
    const db = c.var.db
    const me = c.var.creator
    if (!monthlyEnabled(c.env)) throw unavailable()
    if (body.projectsMin > body.projectsMax) {
      throw new ApiError(422, 'validation_failed', 'projectsMin must not exceed projectsMax', [{ path: 'projectsMin', message: 'must be ≤ projectsMax' }])
    }
    const existing = await db.query.monthlyPlans.findFirst({ where: eq(monthlyPlans.creatorId, me.id) })
    const tipPercent = body.tipPercent ?? existing?.tipPercent ?? 0
    if (monthlyDistributable(body.amountSats, tipPercent) < body.projectsMin * SPRINKLE.minSatsPerProject) {
      throw new ApiError(422, 'amount_out_of_range', `each project must get at least ${SPRINKLE.minSatsPerProject} sats; raise the amount or pick fewer projects`)
    }

    const now = Date.now()
    const patch: Partial<typeof monthlyPlans.$inferInsert> = {
      amountMsat: body.amountSats * 1000,
      projectsMin: body.projectsMin,
      projectsMax: body.projectsMax,
      tipPercent,
      updatedAt: now,
    }
    if (body.excludeFunded !== undefined) patch.excludeFunded = body.excludeFunded
    if (body.supporterName !== undefined) patch.supporterName = body.supporterName || null
    if (body.comment !== undefined) patch.comment = body.comment || null
    if (body.status !== undefined) patch.status = body.status

    if (body.nwcUrl === null || body.nwcUrl === '') {
      patch.nwcSealed = null
      patch.nwcLabel = null
    } else if (body.nwcUrl !== undefined) {
      if (!autoPayEnabled(c.env)) throw unavailable('automatic payment is')
      let conn
      try {
        conn = parseNwcUrl(body.nwcUrl)
      } catch (e) {
        throw new ApiError(422, 'nwc_invalid', e instanceof Error ? e.message : 'invalid connection string')
      }
      if (!lnurlOptions(c.env).allowInsecure && conn.relays.some((r) => !r.startsWith('wss://'))) {
        throw new ApiError(422, 'nwc_invalid', 'relays must use wss://')
      }
      await checkWallet(conn)
      patch.nwcSealed = await seal(c.env, body.nwcUrl, me.id)
      patch.nwcLabel = nwcLabel(body.nwcUrl, conn)
    }

    // A new (or still unverified) address gets a fresh verification link.
    let verifyToken: string | null = null
    if (body.email === null || body.email === '') {
      Object.assign(patch, { email: null, emailVerified: false, emailTokenHash: null, emailTokenExpiresAt: null })
    } else if (body.email !== undefined && !(body.email === existing?.email && existing.emailVerified)) {
      if (!emailEnabled(c.env)) throw new ApiError(503, 'email_unavailable', 'email notices are not available right now')
      verifyToken = randomHex32()
      Object.assign(patch, { email: body.email, emailVerified: false, emailTokenHash: await sha256Hex(verifyToken), emailTokenExpiresAt: now + EMAIL_TOKEN_TTL_MS })
    }

    let plan: MonthlyPlanRow
    if (existing) {
      ;[plan] = (await db.update(monthlyPlans).set(patch).where(eq(monthlyPlans.id, existing.id)).returning()) as [MonthlyPlanRow]
      // Resumed with a month due: charge it now rather than at the next cron run.
      if (existing.status === 'paused' && plan.status === 'active' && plan.nextChargeAt <= now) {
        await startCycle(c.env, db, plan, plan.nextChargeAt)
        plan = (await db.query.monthlyPlans.findFirst({ where: eq(monthlyPlans.id, plan.id) }))!
      }
    } else {
      try {
        ;[plan] = (await db
          .insert(monthlyPlans)
          .values({
            ...patch,
            id: newId(),
            creatorId: me.id,
            amountMsat: body.amountSats * 1000,
            projectsMin: body.projectsMin,
            projectsMax: body.projectsMax,
            billingDay: new Date(now).getUTCDate(),
            nextChargeAt: now,
            createdAt: now,
          })
          .returning()) as [MonthlyPlanRow]
      } catch (e) {
        if (isUniqueViolation(e)) throw new ApiError(409, 'conflict', 'you already have a monthly plan')
        throw e
      }
      // The first month is charged right away.
      if (plan.status === 'active') await startCycle(c.env, db, plan, now)
      plan = (await db.query.monthlyPlans.findFirst({ where: eq(monthlyPlans.id, plan.id) }))!
    }

    if (verifyToken && plan.email) {
      const link = `${publicOrigin(c.env, c.req.url)}/api/monthly/email/verify?token=${verifyToken}`
      c.executionCtx.waitUntil(sendEmail(c.env, { to: plan.email, ...verifyEmail(c.env, link) }))
    }
    return c.json((await state(db, plan)) satisfies PutMonthlyResponse)
  })

  /** Stops future months and forgets the wallet connection; past sprinkles stay as they are. */
  .delete('/', requireCreator, async (c) => {
    await c.var.db.delete(monthlyPlans).where(eq(monthlyPlans.creatorId, c.var.creator.id))
    return c.body(null, 204)
  })

  .post('/cycles/:id/pay', requireCreator, rateLimit('RL_INVOICE', 'monthly-pay'), async (c) => {
    const db = c.var.db
    const plan = await db.query.monthlyPlans.findFirst({ where: eq(monthlyPlans.creatorId, c.var.creator.id) })
    if (!plan) throw notFound('monthly plan')
    await settleCycles(db, plan.id)
    const cycle = await db.query.monthlyCycles.findFirst({ where: and(eq(monthlyCycles.id, c.req.param('id')), eq(monthlyCycles.planId, plan.id)) })
    if (!cycle) throw notFound('month')
    const current = cycle.sprinkleId ? await db.query.sprinkles.findFirst({ where: eq(sprinkles.id, cycle.sprinkleId) }) : undefined
    if (cycle.status === 'paid' && current) return c.json((await toSprinkle(db, current)) satisfies PayMonthlyCycleResponse)
    if (cycle.status !== 'needs_payment') throw new ApiError(409, 'conflict', 'this month is not waiting for payment')
    if (current?.status === 'pending' && current.expiresAt - Date.now() > REUSE_INVOICE_MS) {
      return c.json((await toSprinkle(db, current)) satisfies PayMonthlyCycleResponse)
    }

    const count = await countEligible(db)
    const amountSats = msatToSats(cycle.amountMsat)
    const shares = drawMonth({ amountSats, tipPercent: cycle.tipPercent, projectsMin: plan.projectsMin, projectsMax: plan.projectsMax }, plan.excludeFunded ? count.unfunded : count.all)
    if (!shares) throw new ApiError(409, 'not_enough_projects', 'no projects are accepting payments right now')
    const s = await createSprinkle(c.env, db, {
      amountSats,
      sharesSats: shares,
      platformShareSats: monthlyPlatformShare(amountSats, cycle.tipPercent),
      excludeFunded: plan.excludeFunded,
      supporterName: plan.supporterName,
      comment: plan.comment,
      description: `${c.env.SITE_NAME} · monthly sprinkle to ${shares.length} projects`,
    })
    await db.update(monthlyCycles).set({ sprinkleId: s.id }).where(eq(monthlyCycles.id, cycle.id))
    return c.json((await toSprinkle(db, s)) satisfies PayMonthlyCycleResponse, 201)
  })
