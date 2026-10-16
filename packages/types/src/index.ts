/**
 * @nampu/types — API contract shared by apps/api and apps/web.
 *
 * Conventions
 * - Amounts on the wire are whole **sats** (integers). The API stores msat internally.
 * - Timestamps are Unix epoch **milliseconds** (number).
 * - Authenticated routes use `Authorization: Bearer <SessionToken>` (from a login endpoint).
 * - Every non-2xx response body is an `ApiErrorBody`.
 */

// ─── Limits (shared so the frontend can validate before sending) ──────────────

export const LIMITS = {
  handle: { min: 3, max: 32, pattern: '^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$' },
  displayName: { min: 1, max: 64 },
  slug: { min: 3, max: 64, pattern: '^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$' },
  title: { min: 1, max: 120 },
  summary: { max: 140 },
  body: { max: 20_000 },
  supporterName: { max: 64 },
  comment: { max: 280 },
  milestones: { max: 10, label: { min: 1, max: 120 } },
  /** English versions run longer than Thai, so they get more room. */
  translation: { title: 200, summary: 280, body: 30_000, label: 200 },
  /** Hard cap per invoice, independent of what the creator's wallet allows. */
  invoiceSats: { min: 1, max: 10_000_000 },
  goalSats: { min: 1, max: 2_100_000_000_000_000 },
  cover: { maxBytes: 5 * 1024 * 1024, types: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] },
  supportersPage: { default: 20, max: 50 },
  /** Max rows in a CSV export. */
  supportersCsv: { max: 5000 },
} as const

export type CoverContentType = (typeof LIMITS.cover.types)[number]

export const PROJECT_CATEGORIES = ['edu', 'media', 'tech', 'community', 'art'] as const
export type ProjectCategory = (typeof PROJECT_CATEGORIES)[number]

// ─── Errors ───────────────────────────────────────────────────────────────────

export type ErrorCode =
  | 'bad_request'
  | 'validation_failed'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'payload_too_large'
  | 'unsupported_media_type'
  | 'rate_limited'
  /** Login signature, challenge or event is invalid, expired or already used. */
  | 'auth_failed'
  /** The creator must set a handle and display name first (PATCH /api/me). */
  | 'onboarding_required'
  /** Creator has not set a Lightning Address yet. */
  | 'lightning_address_missing'
  /** The Lightning Address could not be resolved, or its LNURL-pay response is invalid. */
  | 'lnurl_error'
  /** The creator's wallet does not return a LUD-21 `verify` URL, so payments cannot be confirmed. */
  | 'lnurl_verify_unsupported'
  /** Amount is outside the wallet's minSendable/maxSendable or LIMITS.invoiceSats. */
  | 'amount_out_of_range'
  /** A published project's goal cannot go below what it has already raised. */
  | 'goal_below_raised'
  /** Project is a draft, closed, or past its end date. */
  | 'project_not_active'
  /** Sprinkle is switched off (no platform wallet configured) or the wallet is unreachable. */
  | 'sprinkle_unavailable'
  /** Fewer projects are accepting payments than the sprinkle asked for. */
  | 'not_enough_projects'
  /** Automatic translation is switched off (no API key) or failed. */
  | 'translation_unavailable'
  | 'internal'

export interface ApiErrorBody {
  error: {
    code: ErrorCode
    message: string
    /** Field-level issues when code === 'validation_failed'. */
    issues?: { path: string; message: string }[]
  }
}

// ─── Auth ─────────────────────────────────────────────────────────────────────
//
// Two login methods, both passwordless. The first successful login creates the
// creator account; `creator.handle === null` means onboarding is still needed.
//
// Nostr (NIP-07 extension or NIP-46 remote signer):
//   1. POST /api/auth/nostr/challenge            → NostrChallengeResponse
//   2. sign an event { kind: NOSTR_AUTH_KIND, content: '', tags: [['challenge', c], ['relay', origin]] }
//   3. POST /api/auth/nostr { event }            → LoginResponse
//
// LNURL-auth (LUD-04), e.g. Alby / Phoenix / Zeus:
//   1. POST /api/auth/lnurl                       → LnurlAuthStartResponse (show `lnurl` as QR)
//   2. the wallet calls GET /api/auth/lnurl/callback?tag=login&k1=…&sig=…&key=…
//   3. GET /api/auth/lnurl/:k1 with `X-Poll-Token` every ~2s → LnurlAuthPollResponse

/** Opaque bearer token for one device/session. */
export type SessionToken = string

/** NIP-42 client authentication kind. */
export const NOSTR_AUTH_KIND = 22242

/**
 * NIP-98 HTTP auth kind, used as the optional supporter proof on POST /api/p/:slug/invoices:
 * tags [['u', <absolute URL of that endpoint>], ['method', 'POST']], content ''. Signed when the
 * supporter picks "use my Nostr name", so it may be up to 10 minutes old (NIP-98 suggests 60s).
 */
export const NOSTR_HTTP_AUTH_KIND = 27235

export interface NostrEvent {
  id: string
  pubkey: string
  created_at: number
  kind: number
  tags: string[][]
  content: string
  sig: string
}

export interface NostrChallengeResponse {
  challenge: string
  expiresAt: number
}

export interface NostrLoginRequest {
  event: NostrEvent
}

export interface LoginResponse {
  token: SessionToken
  creator: Creator
  /** True when this login created the account. */
  isNew: boolean
}

export interface LnurlAuthStartResponse {
  k1: string
  /** bech32 `lnurl1…`; render as QR / `lightning:` link. */
  lnurl: string
  /** Secret that proves this browser started the login; send as `X-Poll-Token`. */
  pollToken: string
  expiresAt: number
}

export type LnurlAuthPollResponse =
  | { status: 'pending' }
  | { status: 'expired' }
  | ({ status: 'ok' } & LoginResponse)

/** POST /api/auth/logout — revokes the current session. 204. */

// ─── Creators ─────────────────────────────────────────────────────────────────

export interface PublicCreator {
  handle: string
  displayName: string
  /** bech32 npub for announcements and zaps, if set. */
  npub: string | null
}

/** The authenticated creator's own view. */
export interface Creator {
  id: string
  /** null until onboarding is done. */
  handle: string | null
  displayName: string | null
  lightningAddress: string | null
  npub: string | null
  /** Login identities linked to this account. */
  logins: { nostr: boolean; lnurl: boolean }
  createdAt: number
  updatedAt: number
}

/**
 * PATCH /api/me
 * - handle + displayName are required together to finish onboarding.
 * - Setting lightningAddress probes it for LNURL-pay + LUD-21 support.
 */
export interface UpdateCreatorRequest {
  handle?: string
  displayName?: string
  lightningAddress?: string | null
  npub?: string | null
}
export type UpdateCreatorResponse = Creator

/** GET /api/me */
export type GetMeResponse = Creator

// ─── Projects ─────────────────────────────────────────────────────────────────

export type ProjectStatus = 'draft' | 'active' | 'closed'

export interface Milestone {
  sats: number
  label: string
}

export interface ProjectStats {
  raisedSats: number
  supporterCount: number
}

export interface PublicProject extends ProjectStats {
  id: string
  slug: string
  title: string
  summary: string
  /** Markdown. Render with a sanitizing renderer on the client. */
  body: string
  /** Absolute URL, or null when no cover is set. */
  coverUrl: string | null
  category: ProjectCategory | null
  goalSats: number | null
  /** Ascending by sats. */
  milestones: Milestone[]
  /** Payments are refused after this time. null = open-ended. */
  endsAt: number | null
  status: Exclude<ProjectStatus, 'draft'>
  creator: PublicCreator
  publishedAt: number | null
  createdAt: number
  /**
   * English machine translation of the creator's text, for readers using the English UI.
   * null until one has been made (shortly after publishing or an edit), and for projects
   * already written in English. May briefly lag the latest edit.
   */
  translation: ProjectTranslation | null
}

export interface ProjectTranslation {
  lang: 'en'
  /** 'creator': written by the creator in the editor. 'machine': automatic translation. */
  by: 'creator' | 'machine'
  title: string
  summary: string
  /** Markdown, like PublicProject.body. */
  body: string
  /** Same order and length as PublicProject.milestones (labels without a translation stay as written). */
  milestones: Milestone[]
}

/** The creator's own English version (UpdateProjectRequest.translation). */
export interface ProjectTranslationInput {
  title: string
  summary: string
  body: string
  /** One label per milestone, in milestone order; '' = keep the original label. */
  milestones: string[]
}

/** Owner view: includes drafts. */
export interface Project extends Omit<PublicProject, 'status'> {
  status: ProjectStatus
  updatedAt: number
  /** The creator wrote the English version, and the Thai text has changed since. */
  translationStale: boolean
}

/** POST /api/projects — creates a draft. Requires onboarding. */
export interface CreateProjectRequest {
  slug: string
  title: string
  summary?: string
  body?: string
  category?: ProjectCategory | null
  goalSats?: number | null
  milestones?: Milestone[]
  endsAt?: number | null
}
export type CreateProjectResponse = Project

/**
 * PATCH /api/projects/:id
 * Status transitions: draft → active (requires lightning address), active ⇄ closed.
 * Slug is locked once published; goalSats can't drop below raisedSats once published.
 */
export interface UpdateProjectRequest {
  slug?: string
  title?: string
  summary?: string
  body?: string
  category?: ProjectCategory | null
  goalSats?: number | null
  milestones?: Milestone[]
  endsAt?: number | null
  status?: ProjectStatus
  /**
   * The creator's own English version, which replaces the automatic translation and is never
   * overwritten by it. null = go back to the automatic translation. milestones must have one
   * entry per milestone (after this update).
   */
  translation?: ProjectTranslationInput | null
}
export type UpdateProjectResponse = Project

/**
 * POST /api/projects/:id/translate — automatic English translation of the project's saved
 * text, for the creator to edit. Nothing is stored. 503 translation_unavailable when off.
 */
export type TranslateProjectResponse = ProjectTranslationInput

/** GET /api/me/projects */
export interface ListMyProjectsResponse {
  projects: Project[]
}

/** GET /api/projects/:id (owner) */
export type GetProjectResponse = Project

/**
 * PUT /api/projects/:id/cover
 * Body: raw image bytes. Headers: Content-Type (one of LIMITS.cover.types), Content-Length.
 * DELETE /api/projects/:id/cover removes it.
 */
export type UploadCoverResponse = Project

/**
 * POST /api/projects/:id/images — inline image for the story (Markdown `![](url)`).
 * Same body/headers/limits as the cover. Images are never deleted automatically.
 */
export interface UploadImageResponse {
  /** Absolute URL under /media/. */
  url: string
}

/**
 * GET /api/p/:slug (public; active or closed projects only). Carries the first page of
 * supporters and the top-5 leaderboard so the project page loads with one request.
 */
export interface GetPublicProjectResponse extends PublicProject {
  supporters: ListSupportersResponse
  leaders: Supporter[]
}

/** Default page sizes embedded in GetPublicProjectResponse. */
export const PUBLIC_PAGE = { supporters: 20, leaders: 5 } as const

// ─── Discover ─────────────────────────────────────────────────────────────────

/**
 * - trending: sats received in the last 7 days (desc), then raised
 * - new: publishedAt desc
 * - ending: endsAt asc (open-ended projects last)
 * - funded: raised / goal desc (closest to or past the goal first; no-goal projects last)
 */
export const DISCOVER_SORTS = ['trending', 'new', 'ending', 'funded'] as const
export type DiscoverSort = (typeof DISCOVER_SORTS)[number]

/** Card-sized project: no story body. */
export interface ProjectSummary extends Omit<PublicProject, 'body' | 'translation'> {
  translation: Pick<ProjectTranslation, 'lang' | 'title' | 'summary'> | null
  /** Sats received in the last 7 days. */
  weekSats: number
}

/**
 * GET /api/projects?category=&sort=&q=&limit=&cursor=
 * Only active projects that are not past endsAt. `q` matches title or summary.
 * limit: default 12, max 48. Cacheable for ~30s.
 */
export interface ListProjectsQuery {
  category?: ProjectCategory
  sort?: DiscoverSort
  q?: string
  limit?: number
  cursor?: string
}
export interface ListProjectsResponse {
  projects: ProjectSummary[]
  nextCursor: string | null
}

/** GET /api/p/:slug/leaderboard?limit= (default 5, max 20) — largest single payments, desc. */
export interface LeaderboardResponse {
  leaders: Supporter[]
}

// ─── Owner analytics ──────────────────────────────────────────────────────────

export const STATS_RANGES = ['today', '7d', '30d', 'all'] as const
export type StatsRange = (typeof STATS_RANGES)[number]

/** Number of buckets in ProjectStatsResponse.buckets. */
export const STATS_BUCKETS = 14

/**
 * GET /api/projects/:id/stats?range=<StatsRange>&tz=<minutes east of UTC, e.g. 420 for Bangkok>
 * `tz` only affects where "today" starts.
 */
export interface ProjectStatsResponse {
  range: StatsRange
  /** Window covered by `totalSats`/`backers`/`buckets`. */
  from: number
  to: number
  totalSats: number
  backers: number
  anonymous: number
  /** Rounded down; 0 when there are no backers. */
  avgSats: number
  /** Same-length window immediately before `from`; null for 'all'. */
  previous: { totalSats: number; backers: number } | null
  /** STATS_BUCKETS equal slices of [from, to), oldest first. */
  buckets: { from: number; sats: number; backers: number }[]
  allTime: { raisedSats: number; backers: number; anonymous: number; goalSats: number | null }
}

// ─── Supporters (paid invoices) ───────────────────────────────────────────────

export interface Supporter {
  invoiceId: string
  name: string | null
  /** Hex pubkey the supporter proved with a signature, for showing their Nostr profile. */
  pubkey: string | null
  comment: string | null
  amountSats: number
  paidAt: number
}

/** GET /api/p/:slug/supporters?limit=&cursor= — newest first. */
export interface ListSupportersResponse {
  supporters: Supporter[]
  /** Pass as `cursor` to fetch the next page; null when there are no more. */
  nextCursor: string | null
}

export type SupporterFilter = 'all' | 'message'

/**
 * GET /api/projects/:id/supporters?q=&filter=<SupporterFilter>&limit=&cursor= (owner) → ListSupportersResponse
 * Add `format=csv` for a text/csv download (up to LIMITS.supportersCsv rows, ignores cursor/limit).
 * `q` matches supporter name or comment (case-insensitive substring).
 */
export interface ListOwnerSupportersQuery {
  q?: string
  filter?: SupporterFilter
  limit?: number
  cursor?: string
  format?: 'json' | 'csv'
}

// ─── Invoices ─────────────────────────────────────────────────────────────────

export type InvoiceStatus = 'pending' | 'paid' | 'expired'

/** POST /api/p/:slug/invoices */
export interface CreateInvoiceRequest {
  amountSats: number
  supporterName?: string
  comment?: string
  /** NOSTR_HTTP_AUTH_KIND event. An invalid or stale proof is ignored, not rejected. */
  nostrProof?: NostrEvent
}

export interface Invoice {
  id: string
  projectId: string
  amountSats: number
  /** BOLT11 payment request — render as QR / `lightning:` link. */
  bolt11: string
  status: InvoiceStatus
  createdAt: number
  expiresAt: number
  paidAt: number | null
}
export type CreateInvoiceResponse = Invoice

/** GET /api/invoices/:id — polling fallback for clients without WebSocket. */
export type GetInvoiceResponse = Invoice

// ─── Sprinkle (one payment, split across random projects) ──────────────────────
//
// Unlike project invoices this flow is custodial for a few seconds: the supporter pays the
// platform's wallet (NWC), which then pays an invoice from each chosen creator's Lightning
// Address. Each payout shows up as a normal supporter payment on that project.

export const SPRINKLE = {
  amountSats: { min: 21, max: 21_000 },
  projects: { min: 1, max: 10 },
  minSatsPerProject: 21,
  /** Kept back from the total to pay Lightning routing fees on the payouts. */
  feeReservePercent: 2,
} as const

/** Sats each project receives (equal split after the fee reserve, rounded down). */
export const sprinkleShare = (amountSats: number, projectCount: number) =>
  Math.floor((amountSats * (100 - SPRINKLE.feeReservePercent)) / 100 / projectCount)

/** GET /api/sprinkles/config */
export interface SprinkleConfigResponse {
  enabled: boolean
  /** Projects a sprinkle can currently pay (caps projectCount). */
  eligibleProjects: number
  /** Of those, the ones that haven't reached their goal (or have none): the cap with excludeFunded. */
  eligibleUnfunded: number
}

/** POST /api/sprinkles */
export interface CreateSprinkleRequest {
  amountSats: number
  projectCount: number
  /** Skip projects that already reached their goal (projects without a goal stay in). Default false. */
  excludeFunded?: boolean
  supporterName?: string
  comment?: string
}

/** pending: waiting for the supporter's payment · distributing: paying projects · done · expired: never paid */
export type SprinkleStatus = 'pending' | 'distributing' | 'done' | 'expired'
export type SprinklePayoutStatus = 'pending' | 'paid' | 'failed'

export interface SprinklePayout {
  slug: string
  title: string
  amountSats: number
  status: SprinklePayoutStatus
}

export interface Sprinkle {
  id: string
  amountSats: number
  projectCount: number
  perProjectSats: number
  excludeFunded: boolean
  bolt11: string
  status: SprinkleStatus
  createdAt: number
  expiresAt: number
  paidAt: number | null
  /** Projects picked so far (filled once the payment arrives); failed ones are replaced. */
  payouts: SprinklePayout[]
}
export type CreateSprinkleResponse = Sprinkle
/** GET /api/sprinkles/:id */
export type GetSprinkleResponse = Sprinkle

// ─── Real-time (WebSocket) ────────────────────────────────────────────────────
//
// Connect: GET /api/p/:slug/ws  (optionally ?invoice=<invoiceId> to also get that
// invoice's `invoice` events, including expiry).
// Keep-alive: send the literal text "ping"; the server replies "pong" without
// waking the Durable Object.

export interface WsHelloMessage {
  type: 'hello'
  projectId: string
  serverTime: number
}

/** Broadcast to everyone watching the project when a payment settles. */
export interface WsPaymentMessage {
  type: 'payment'
  supporter: Supporter
  stats: ProjectStats
}

/** Sent only to sockets that subscribed with ?invoice=<id>. */
export interface WsInvoiceMessage {
  type: 'invoice'
  invoiceId: string
  status: Exclude<InvoiceStatus, 'pending'>
}

export type WsServerMessage = WsHelloMessage | WsPaymentMessage | WsInvoiceMessage

export const WS_PING = 'ping'
export const WS_PONG = 'pong'

// ─── Misc ─────────────────────────────────────────────────────────────────────

/** GET /api/health */
export interface HealthResponse {
  ok: true
  time: number
}
