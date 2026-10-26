import type { Milestone } from '@nampu/types'
import { sql } from 'drizzle-orm'
import { check, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

// All timestamps are Unix epoch milliseconds. All amounts are msat unless named *_sats.

const now = sql`(CAST(unixepoch('subsec') * 1000 AS INTEGER))`

export const creators = sqliteTable('creators', {
  id: text('id').primaryKey(),
  /** null until onboarding (PATCH /api/me) is done. */
  handle: text('handle').unique(),
  displayName: text('display_name'),
  lightningAddress: text('lightning_address'),
  /** bech32 npub shown publicly for announcements/zaps. */
  npub: text('npub'),
  /** Login identities (hex). At least one is set. */
  nostrPubkey: text('nostr_pubkey').unique(),
  lnurlAuthKey: text('lnurl_auth_key').unique(),
  createdAt: integer('created_at').notNull().default(now),
  updatedAt: integer('updated_at').notNull().default(now),
})

export const sessions = sqliteTable(
  'sessions',
  {
    /** SHA-256 (hex) of the bearer token. Tokens are 256-bit random, so a fast hash is enough. */
    tokenHash: text('token_hash').primaryKey(),
    creatorId: text('creator_id')
      .notNull()
      .references(() => creators.id, { onDelete: 'cascade' }),
    createdAt: integer('created_at').notNull().default(now),
    expiresAt: integer('expires_at').notNull(),
  },
  (t) => [index('sessions_creator_idx').on(t.creatorId), index('sessions_expires_idx').on(t.expiresAt)],
)

export const authChallenges = sqliteTable(
  'auth_challenges',
  {
    /** Nostr challenge or LNURL-auth k1 (32 bytes hex). */
    id: text('id').primaryKey(),
    kind: text('kind', { enum: ['nostr', 'lnurl'] }).notNull(),
    /** LNURL-auth only: SHA-256 of the secret the browser polls with. */
    pollTokenHash: text('poll_token_hash'),
    /** LNURL-auth only: wallet linking key, set by the callback. */
    linkingKey: text('linking_key'),
    createdAt: integer('created_at').notNull().default(now),
    expiresAt: integer('expires_at').notNull(),
  },
  (t) => [
    index('auth_challenges_expires_idx').on(t.expiresAt),
    check('auth_challenges_kind_check', sql`${t.kind} IN ('nostr', 'lnurl')`),
  ],
)

export const projects = sqliteTable(
  'projects',
  {
    id: text('id').primaryKey(),
    creatorId: text('creator_id')
      .notNull()
      .references(() => creators.id, { onDelete: 'cascade' }),
    slug: text('slug').notNull().unique(),
    title: text('title').notNull(),
    summary: text('summary').notNull().default(''),
    body: text('body').notNull().default(''),
    coverKey: text('cover_key'),
    category: text('category', { enum: ['edu', 'media', 'tech', 'community', 'art'] }),
    goalSats: integer('goal_sats'),
    milestones: text('milestones', { mode: 'json' }).$type<Milestone[]>().notNull().default(sql`'[]'`),
    /** Payments are refused after this time. */
    endsAt: integer('ends_at'),
    /** Denormalized from paid invoices; updated in the same D1 batch as the invoice. */
    raisedMsat: integer('raised_msat').notNull().default(0),
    supporterCount: integer('supporter_count').notNull().default(0),
    status: text('status', { enum: ['draft', 'active', 'closed'] }).notNull().default('draft'),
    publishedAt: integer('published_at'),
    /**
     * English machine translation of title/summary/body/milestone labels (ProjectTranslator).
     * Null when there is none yet, or when the creator already wrote in English.
     */
    titleEn: text('title_en'),
    summaryEn: text('summary_en'),
    bodyEn: text('body_en'),
    milestonesEn: text('milestones_en', { mode: 'json' }).$type<string[]>(),
    /** translationSourceHash() of the text the *_en columns were made from (or judged not to need translating). */
    enSourceHash: text('en_source_hash'),
    /** The creator wrote the *_en columns in the editor; ProjectTranslator leaves them alone. */
    enManual: integer('en_manual', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at').notNull().default(now),
    updatedAt: integer('updated_at').notNull().default(now),
  },
  (t) => [
    index('projects_creator_idx').on(t.creatorId, t.createdAt),
    check('projects_status_check', sql`${t.status} IN ('draft', 'active', 'closed')`),
    check('projects_category_check', sql`${t.category} IS NULL OR ${t.category} IN ('edu', 'media', 'tech', 'community', 'art')`),
  ],
)

export const invoices = sqliteTable(
  'invoices',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    amountMsat: integer('amount_msat').notNull(),
    supporterName: text('supporter_name'),
    /** Hex Nostr pubkey proven by a NIP-98 signature (see nip98Pubkey); shown as their profile. */
    supporterPubkey: text('supporter_pubkey'),
    comment: text('comment'),
    bolt11: text('bolt11').notNull(),
    paymentHash: text('payment_hash').notNull().unique(),
    /** LUD-21 verify URL returned by the creator's LNURL-pay callback. Never exposed. */
    verifyUrl: text('verify_url').notNull(),
    status: text('status', { enum: ['pending', 'paid', 'expired'] }).notNull().default('pending'),
    preimage: text('preimage'),
    createdAt: integer('created_at').notNull().default(now),
    expiresAt: integer('expires_at').notNull(),
    paidAt: integer('paid_at'),
  },
  (t) => [
    // Supporter feed / stats (status = 'paid' AND paid_at range) and pending-count checks.
    index('invoices_project_status_paid_idx').on(t.projectId, t.status, t.paidAt),
    check('invoices_status_check', sql`${t.status} IN ('pending', 'paid', 'expired')`),
    check('invoices_amount_check', sql`${t.amountMsat} > 0`),
  ],
)

/** One supporter payment to the platform wallet (NWC), split across random projects. */
export const sprinkles = sqliteTable(
  'sprinkles',
  {
    id: text('id').primaryKey(),
    amountMsat: integer('amount_msat').notNull(),
    projectCount: integer('project_count').notNull(),
    perProjectMsat: integer('per_project_msat').notNull(),
    /** Random split (monthly): one amount per project. Null = projectCount × perProjectMsat. */
    sharesMsat: text('shares_msat', { mode: 'json' }).$type<number[]>(),
    /** Only pick projects still short of their goal. */
    excludeFunded: integer('exclude_funded', { mode: 'boolean' }).notNull().default(false),
    supporterName: text('supporter_name'),
    comment: text('comment'),
    /** Invoice from the platform wallet (NWC make_invoice). */
    bolt11: text('bolt11').notNull(),
    paymentHash: text('payment_hash').notNull().unique(),
    status: text('status', { enum: ['pending', 'distributing', 'done', 'expired'] }).notNull().default('pending'),
    createdAt: integer('created_at').notNull().default(now),
    expiresAt: integer('expires_at').notNull(),
    paidAt: integer('paid_at'),
    completedAt: integer('completed_at'),
    /**
     * The supporter's share for the platform (monthly tipPercent), forwarded to PLATFORM_ADDRESS
     * once the projects are paid. Status null = nothing to forward; `paying` = an invoice was
     * fetched and pay_invoice sent (maybe in flight). No CHECK constraint: adding one to an
     * existing table makes drizzle rebuild it, and on D1 that DROP cascades to the payouts.
     */
    shareMsat: integer('share_msat').notNull().default(0),
    shareStatus: text('share_status', { enum: ['pending', 'paying', 'paid', 'failed'] }),
    shareBolt11: text('share_bolt11'),
    sharePaymentHash: text('share_payment_hash'),
    shareAttempts: integer('share_attempts').notNull().default(0),
    shareError: text('share_error'),
  },
  (t) => [
    index('sprinkles_status_idx').on(t.status, t.createdAt),
    check('sprinkles_status_check', sql`${t.status} IN ('pending', 'distributing', 'done', 'expired')`),
  ],
)

/**
 * One project's share of a sprinkle. `paying` = an invoice from the creator's wallet exists
 * and pay_invoice was sent (maybe in flight); a failed payout is replaced by another project.
 */
export const sprinklePayouts = sqliteTable(
  'sprinkle_payouts',
  {
    id: text('id').primaryKey(),
    sprinkleId: text('sprinkle_id')
      .notNull()
      .references(() => sprinkles.id, { onDelete: 'cascade' }),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    /** The project invoice this payout pays; settles through the project's normal LUD-21 polling. */
    invoiceId: text('invoice_id').references(() => invoices.id, { onDelete: 'set null' }),
    amountMsat: integer('amount_msat').notNull(),
    status: text('status', { enum: ['pending', 'paying', 'paid', 'failed'] }).notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    createdAt: integer('created_at').notNull().default(now),
    updatedAt: integer('updated_at').notNull().default(now),
  },
  (t) => [
    index('sprinkle_payouts_sprinkle_idx').on(t.sprinkleId, t.createdAt),
    check('sprinkle_payouts_status_check', sql`${t.status} IN ('pending', 'paying', 'paid', 'failed')`),
  ],
)

/** A supporter's monthly sprinkle; at most one per account. */
export const monthlyPlans = sqliteTable(
  'monthly_plans',
  {
    id: text('id').primaryKey(),
    creatorId: text('creator_id')
      .notNull()
      .unique()
      .references(() => creators.id, { onDelete: 'cascade' }),
    amountMsat: integer('amount_msat').notNull(),
    projectsMin: integer('projects_min').notNull(),
    projectsMax: integer('projects_max').notNull(),
    excludeFunded: integer('exclude_funded', { mode: 'boolean' }).notNull().default(true),
    /** Percent of each month kept by the platform, on top of the fee reserve. */
    tipPercent: integer('tip_percent').notNull().default(0),
    supporterName: text('supporter_name'),
    comment: text('comment'),
    /** The supporter's NWC connection string, AES-GCM sealed (lib/secretbox). Null = pay by hand. */
    nwcSealed: text('nwc_sealed'),
    /** Shown to the supporter: lud16 from the connection string, or the relay host. */
    nwcLabel: text('nwc_label'),
    status: text('status', { enum: ['active', 'paused'] }).notNull().default('active'),
    billingDay: integer('billing_day').notNull(),
    nextChargeAt: integer('next_charge_at').notNull(),
    email: text('email'),
    emailVerified: integer('email_verified', { mode: 'boolean' }).notNull().default(false),
    /** SHA-256 of the pending verification token. */
    emailTokenHash: text('email_token_hash'),
    emailTokenExpiresAt: integer('email_token_expires_at'),
    createdAt: integer('created_at').notNull().default(now),
    updatedAt: integer('updated_at').notNull().default(now),
  },
  (t) => [
    index('monthly_plans_due_idx').on(t.status, t.nextChargeAt),
    check('monthly_plans_status_check', sql`${t.status} IN ('active', 'paused')`),
  ],
)

/** One month of a plan, charged by MonthlyRoom through a sprinkle. */
export const monthlyCycles = sqliteTable(
  'monthly_cycles',
  {
    id: text('id').primaryKey(),
    planId: text('plan_id')
      .notNull()
      .references(() => monthlyPlans.id, { onDelete: 'cascade' }),
    dueAt: integer('due_at').notNull(),
    /** Snapshot of the plan when the month started. */
    amountMsat: integer('amount_msat').notNull(),
    tipPercent: integer('tip_percent').notNull(),
    status: text('status', { enum: ['charging', 'needs_payment', 'paid', 'missed'] }).notNull().default('charging'),
    /** MonthlyReason, when it needs paying by hand or was missed. */
    reason: text('reason'),
    /** The latest sprinkle made for this month (earlier ones expired unpaid). */
    sprinkleId: text('sprinkle_id').references(() => sprinkles.id, { onDelete: 'set null' }),
    /** Failed automatic payment attempts. */
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    notifiedAt: integer('notified_at'),
    createdAt: integer('created_at').notNull().default(now),
    paidAt: integer('paid_at'),
  },
  (t) => [
    uniqueIndex('monthly_cycles_plan_due_idx').on(t.planId, t.dueAt),
    index('monthly_cycles_status_idx').on(t.status, t.createdAt),
    check('monthly_cycles_status_check', sql`${t.status} IN ('charging', 'needs_payment', 'paid', 'missed')`),
  ],
)

export type CreatorRow = typeof creators.$inferSelect
export type ProjectRow = typeof projects.$inferSelect
export type InvoiceRow = typeof invoices.$inferSelect
export type SprinkleRow = typeof sprinkles.$inferSelect
export type SprinklePayoutRow = typeof sprinklePayouts.$inferSelect
export type MonthlyPlanRow = typeof monthlyPlans.$inferSelect
export type MonthlyCycleRow = typeof monthlyCycles.$inferSelect
