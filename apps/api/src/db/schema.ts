import type { Milestone } from '@nampu/types'
import { sql } from 'drizzle-orm'
import { check, index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

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

export type CreatorRow = typeof creators.$inferSelect
export type ProjectRow = typeof projects.$inferSelect
export type InvoiceRow = typeof invoices.$inferSelect
