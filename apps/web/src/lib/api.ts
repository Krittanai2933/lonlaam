import type {
  ApiErrorBody,
  CreateInvoiceRequest,
  CreateInvoiceResponse,
  CreateProjectRequest,
  CreateProjectResponse,
  CreateSprinkleRequest,
  CreateSprinkleResponse,
  ErrorCode,
  GetInvoiceResponse,
  GetMeResponse,
  GetMonthlyResponse,
  GetProjectResponse,
  GetPublicProjectResponse,
  GetSprinkleResponse,
  LeaderboardResponse,
  ListMyProjectsResponse,
  ListOwnerSupportersResponse,
  ListOwnerSupportersQuery,
  ListProjectsQuery,
  ListProjectsResponse,
  ListSupportersResponse,
  LnurlAuthPollResponse,
  LnurlAuthStartResponse,
  LoginResponse,
  MonthlyConfigResponse,
  NostrChallengeResponse,
  NostrEvent,
  PayMonthlyCycleResponse,
  ProjectStatsResponse,
  PutMonthlyRequest,
  PutMonthlyResponse,
  SetRewardSentResponse,
  SprinkleConfigResponse,
  StatsRange,
  TranslateProjectResponse,
  UpdateCreatorRequest,
  UpdateCreatorResponse,
  UpdateProjectRequest,
  UpdateProjectResponse,
  UploadCoverResponse,
  UploadImageResponse,
} from '@nampu/types'

const TOKEN_KEY = 'nampu.session'

export const tokenStore = {
  get(): string | null {
    try {
      return localStorage.getItem(TOKEN_KEY)
    } catch {
      return null
    }
  },
  set(token: string | null) {
    try {
      if (token) localStorage.setItem(TOKEN_KEY, token)
      else localStorage.removeItem(TOKEN_KEY)
    } catch {
      // storage unavailable (private mode): session lasts for this tab only
    }
  },
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly issues?: ApiErrorBody['error']['issues'],
  ) {
    super(message)
  }
}

/** User-facing text for an error: localized for known cases, server message otherwise. */
export function errorText(e: unknown, t: { rateLimited: string; somethingWrong: string }): string {
  if (e instanceof ApiError && e.code === 'rate_limited') return t.rateLimited
  return e instanceof Error && e.message ? e.message : t.somethingWrong
}

/** Fired when the server rejects our session so the auth layer can log out. */
export const UNAUTHORIZED_EVENT = 'nampu:unauthorized'

async function request<T>(method: string, path: string, init: { body?: unknown; raw?: BodyInit; headers?: Record<string, string> } = {}): Promise<T> {
  const token = tokenStore.get()
  const headers: Record<string, string> = { ...init.headers }
  if (token) headers.authorization = `Bearer ${token}`
  let body: BodyInit | undefined = init.raw
  if (init.body !== undefined) {
    headers['content-type'] = 'application/json'
    body = JSON.stringify(init.body)
  }
  const res = await fetch(path, { method, headers, body })
  if (res.status === 204) return undefined as T
  const data = await res.json().catch(() => null)
  if (!res.ok) {
    const err = (data as ApiErrorBody | null)?.error
    if (res.status === 401 && token) window.dispatchEvent(new Event(UNAUTHORIZED_EVENT))
    throw new ApiError(res.status, err?.code ?? 'internal', err?.message ?? `HTTP ${res.status}`, err?.issues)
  }
  return data as T
}

const qs = (params: Record<string, string | number | undefined>) => {
  const u = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') u.set(k, String(v))
  const s = u.toString()
  return s ? `?${s}` : ''
}

export const api = {
  // auth
  nostrChallenge: () => request<NostrChallengeResponse>('POST', '/api/auth/nostr/challenge'),
  nostrLogin: (event: NostrEvent) => request<LoginResponse>('POST', '/api/auth/nostr', { body: { event } }),
  lnurlStart: () => request<LnurlAuthStartResponse>('POST', '/api/auth/lnurl'),
  lnurlPoll: (k1: string, pollToken: string) => request<LnurlAuthPollResponse>('GET', `/api/auth/lnurl/${k1}`, { headers: { 'x-poll-token': pollToken } }),
  logout: () => request<void>('POST', '/api/auth/logout'),

  // public
  projects: (q: ListProjectsQuery) => request<ListProjectsResponse>('GET', `/api/projects${qs({ ...q })}`),
  publicProject: (slug: string) => request<GetPublicProjectResponse>('GET', `/api/p/${encodeURIComponent(slug)}`),
  publicSupporters: (slug: string, cursor?: string, limit = 20) =>
    request<ListSupportersResponse>('GET', `/api/p/${encodeURIComponent(slug)}/supporters${qs({ cursor, limit })}`),
  leaderboard: (slug: string, limit = 5) => request<LeaderboardResponse>('GET', `/api/p/${encodeURIComponent(slug)}/leaderboard${qs({ limit })}`),
  createInvoice: (slug: string, body: CreateInvoiceRequest) =>
    request<CreateInvoiceResponse>('POST', `/api/p/${encodeURIComponent(slug)}/invoices`, { body }),
  invoice: (id: string) => request<GetInvoiceResponse>('GET', `/api/invoices/${id}`),
  sprinkleConfig: () => request<SprinkleConfigResponse>('GET', '/api/sprinkles/config'),
  createSprinkle: (body: CreateSprinkleRequest) => request<CreateSprinkleResponse>('POST', '/api/sprinkles', { body }),
  sprinkle: (id: string) => request<GetSprinkleResponse>('GET', `/api/sprinkles/${id}`),

  // monthly (any logged-in account)
  monthlyConfig: () => request<MonthlyConfigResponse>('GET', '/api/monthly/config'),
  monthly: () => request<GetMonthlyResponse>('GET', '/api/monthly'),
  putMonthly: (body: PutMonthlyRequest) => request<PutMonthlyResponse>('PUT', '/api/monthly', { body }),
  deleteMonthly: () => request<void>('DELETE', '/api/monthly'),
  payMonthlyCycle: (id: string) => request<PayMonthlyCycleResponse>('POST', `/api/monthly/cycles/${id}/pay`),

  // creator
  me: () => request<GetMeResponse>('GET', '/api/me'),
  updateMe: (body: UpdateCreatorRequest) => request<UpdateCreatorResponse>('PATCH', '/api/me', { body }),
  myProjects: () => request<ListMyProjectsResponse>('GET', '/api/me/projects'),

  // projects (owner)
  createProject: (body: CreateProjectRequest) => request<CreateProjectResponse>('POST', '/api/projects', { body }),
  project: (id: string) => request<GetProjectResponse>('GET', `/api/projects/${id}`),
  updateProject: (id: string, body: UpdateProjectRequest) => request<UpdateProjectResponse>('PATCH', `/api/projects/${id}`, { body }),
  uploadCover: (id: string, file: File) =>
    request<UploadCoverResponse>('PUT', `/api/projects/${id}/cover`, { raw: file, headers: { 'content-type': file.type } }),
  translateProject: (id: string) => request<TranslateProjectResponse>('POST', `/api/projects/${id}/translate`),
  deleteCover: (id: string) => request<UploadCoverResponse>('DELETE', `/api/projects/${id}/cover`),
  uploadImage: (id: string, file: File) =>
    request<UploadImageResponse>('POST', `/api/projects/${id}/images`, { raw: file, headers: { 'content-type': file.type } }),
  stats: (id: string, range: StatsRange) =>
    request<ProjectStatsResponse>('GET', `/api/projects/${id}/stats${qs({ range, tz: -new Date().getTimezoneOffset() })}`),
  supporters: (id: string, q: Omit<ListOwnerSupportersQuery, 'format'>) =>
    request<ListOwnerSupportersResponse>('GET', `/api/projects/${id}/supporters${qs({ ...q })}`),
  setRewardSent: (id: string, invoiceId: string, sent: boolean) =>
    request<SetRewardSentResponse>('PUT', `/api/projects/${id}/supporters/${invoiceId}/reward`, { body: { sent } }),

  /** Authenticated CSV download (can't be a plain link because of the bearer header). */
  async downloadSupportersCsv(id: string, q: Omit<ListOwnerSupportersQuery, 'format' | 'cursor' | 'limit'>, filename: string) {
    const token = tokenStore.get()
    const res = await fetch(`/api/projects/${id}/supporters${qs({ ...q, format: 'csv' })}`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    })
    if (!res.ok) throw new ApiError(res.status, 'internal', `HTTP ${res.status}`)
    const url = URL.createObjectURL(await res.blob())
    const a = Object.assign(document.createElement('a'), { href: url, download: filename })
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  },
}
