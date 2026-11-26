import type { GetProjectResponse, GetPublicProjectResponse, ListSupportersResponse, ProjectStats, PublicProject, Supporter, WsRewardsMessage } from '@nampu/types'
import { PUBLIC_PAGE } from '@nampu/types'
import { Avatar, Brand, Button, cx, Icon, Plate, Progress, Tag, Tabs } from '@nampu/ui'
import { type InfiniteData, type QueryClient, useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import { createContext, useContext, useId, useLayoutEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'
import { ContributeFlow } from '../components/contribute/Contribute'
import { Markdown } from '../components/Markdown'
import { SupporterAvatar, SupporterChip, SupporterName, useSupporterIdentity } from '../components/supporter'
import { PublicNav } from '../components/PublicChrome'
import { projectUrl, ShareButtons } from '../components/share'
import { api, ApiError } from '../lib/api'
import { FullPageSpinner } from '../lib/auth'
import { ago, daysLeft, fmt } from '../lib/format'
import { useIsDesktop, useNow, useProjectSocket } from '../lib/hooks'
import { useI18n } from '../lib/i18n'
import { localized } from '../lib/translation'
import { useTrending } from './Discover'

type Tab = 'story' | 'supporters'

/** `/p/:slug?preview=<id>`: the owner's view of their own project, drafts included. */
const PreviewCtx = createContext<string | null>(null)

/** Shapes the owner's copy like the public response; drafts have no supporters yet. */
function asPreview(p: GetProjectResponse): GetPublicProjectResponse {
  const { updatedAt: _u, ...rest } = p
  return { ...rest, status: p.status === 'closed' ? 'closed' : 'active', supporters: { supporters: [], nextCursor: null }, leaders: [] }
}

export default function ProjectPage() {
  const { slug } = useParams() as { slug: string }
  const desktop = useIsDesktop()
  const qc = useQueryClient()
  const previewId = useSearchParams()[0].get('preview')
  const project = useQuery({
    queryKey: previewId ? ['preview', previewId] : ['public', slug],
    queryFn: () => (previewId ? api.project(previewId).then(asPreview) : api.publicProject(slug)),
    retry: (n, e) => !(e instanceof ApiError && (e.status === 404 || e.status === 401)) && n < 2,
  })
  /** Open contribute flow; `reward` = opened from that reward card. */
  const [contributing, setContributing] = useState<{ reward: string | null } | null>(null)
  const { lang } = useI18n()
  const [showOriginal, setShowOriginal] = useState(false)

  // Live totals + activity while the page is open, applied locally: a refetch here would
  // cost every open viewer two requests per payment.
  useProjectSocket(project.data && !previewId ? slug : null, (m) => {
    if (m.type === 'payment') applyPayment(qc, slug, m.supporter, m.stats)
    if (m.type === 'rewards') applyRewards(qc, slug, m.rewards)
  })

  if (project.isPending) return <FullPageSpinner />
  if (project.isError) return <NotFound />
  const translatable = lang === 'en' && project.data.translation !== null
  const p = showOriginal ? project.data : localized(project.data, lang)
  const View = desktop ? DesktopProject : MobileProject
  const translation = translatable ? { original: showOriginal, byCreator: project.data.translation?.by === 'creator', toggle: () => setShowOriginal((v) => !v) } : null
  if (previewId)
    return (
      <PreviewCtx.Provider value={previewId}>
        <TranslationCtx.Provider value={translation}>
          <PreviewBar />
          <View project={p} onContribute={() => {}} />
        </TranslationCtx.Provider>
      </PreviewCtx.Provider>
    )
  return (
    <TranslationCtx.Provider value={translation}>
      <View project={p} onContribute={(reward) => setContributing({ reward: reward ?? null })} />
      <ContributeFlow project={p} open={!!contributing} rewardId={contributing?.reward} onClose={() => setContributing(null)} desktop={desktop} />
    </TranslationCtx.Provider>
  )
}

/** Set when the page shows (or can show) the English machine translation. */
const TranslationCtx = createContext<{ original: boolean; byCreator: boolean; toggle: () => void } | null>(null)

function TranslationNote({ className }: { className?: string }) {
  const { t } = useI18n()
  const tr = useContext(TranslationCtx)
  if (!tr) return null
  return (
    <div className={cx('flex flex-wrap items-center gap-x-2 text-xs text-neutral-600', className)}>
      {!tr.original && !tr.byCreator && <span>{t.machineTranslated}</span>}
      <button type="button" className="cursor-pointer text-accent-700 underline underline-offset-2" onClick={tr.toggle}>
        {tr.original ? t.showTranslation : t.showOriginal}
      </button>
    </div>
  )
}

function PreviewBar() {
  const { t } = useI18n()
  return <div className="sticky top-0 z-20 bg-accent-700 px-4 py-2 text-center text-[13px] text-white">{t.previewBanner}</div>
}

function NotFound() {
  const { t } = useI18n()
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-4 px-6 text-center">
      <Brand size="page" />
      <p className="m-0 text-neutral-700">{t.projectNotFound}</p>
      <Link to="/" className="btn btn-secondary">
        {t.backHome}
      </Link>
    </div>
  )
}

// ─── shared ───────────────────────────────────────────────────────────────────

const isOpen = (p: PublicProject) => p.status === 'active' && (!p.endsAt || p.endsAt > Date.now())
const pctOf = (p: PublicProject) => (p.goalSats ? Math.round((p.raisedSats / p.goalSats) * 100) : null)

function useIsTrending(p: PublicProject) {
  const tr = useTrending()
  return !!tr.data?.some((x) => x.id === p.id)
}

// Both lists start from the data embedded in GET /api/p/:slug and are then kept current by
// the WebSocket, so they never refetch on their own; only "load more" hits the network.
// A preview keeps its own cache entries, seeded empty, so nothing hits the public API.
const embedded = (qc: QueryClient, slug: string, previewId: string | null) =>
  qc.getQueryData<GetPublicProjectResponse>(previewId ? ['preview', previewId] : ['public', slug])

function useActivity(slug: string) {
  const qc = useQueryClient()
  const previewId = useContext(PreviewCtx)
  return useInfiniteQuery({
    queryKey: previewId ? ['preview-supporters', previewId] : ['public-supporters', slug],
    queryFn: ({ pageParam }) => api.publicSupporters(slug, pageParam, PUBLIC_PAGE.supporters),
    initialPageParam: undefined as string | undefined,
    initialData: () => {
      const p = embedded(qc, slug, previewId)
      return p && { pages: [p.supporters], pageParams: [undefined] }
    },
    getNextPageParam: (l) => l.nextCursor ?? undefined,
    staleTime: Infinity,
  })
}

function useLeaders(slug: string) {
  const qc = useQueryClient()
  const previewId = useContext(PreviewCtx)
  return useQuery({
    queryKey: previewId ? ['preview-leaderboard', previewId] : ['leaderboard', slug],
    queryFn: () => api.leaderboard(slug, PUBLIC_PAGE.leaders).then((r) => r.leaders),
    initialData: () => embedded(qc, slug, previewId)?.leaders,
    staleTime: Infinity,
  })
}

function applyPayment(qc: QueryClient, slug: string, s: Supporter, stats: ProjectStats) {
  // The embedded copies are updated too: a list that is not mounted yet (e.g. the supporters
  // tab on mobile) is seeded from them later.
  qc.setQueryData<GetPublicProjectResponse>(['public', slug], (p) =>
    p && { ...p, ...stats, supporters: withSupporter(p.supporters, s), leaders: withLeader(p.leaders, s) },
  )
  qc.setQueryData<InfiniteData<ListSupportersResponse, string | undefined>>(['public-supporters', slug], (d) => {
    const first = d?.pages[0]
    return d && first && { ...d, pages: [withSupporter(first, s), ...d.pages.slice(1)] }
  })
  qc.setQueryData<Supporter[]>(['leaderboard', slug], (l) => l && withLeader(l, s))
}

function applyRewards(qc: QueryClient, slug: string, counts: WsRewardsMessage['rewards']) {
  const byId = new Map(counts.map((c) => [c.id, c]))
  qc.setQueryData<GetPublicProjectResponse>(['public', slug], (p) =>
    p && { ...p, rewards: p.rewards.map((r) => ({ ...r, ...byId.get(r.id) })) },
  )
}

const withSupporter = (page: ListSupportersResponse, s: Supporter): ListSupportersResponse =>
  page.supporters.some((x) => x.invoiceId === s.invoiceId) ? page : { ...page, supporters: [s, ...page.supporters] }

const withLeader = (leaders: Supporter[], s: Supporter) =>
  leaders.some((x) => x.invoiceId === s.invoiceId)
    ? leaders
    : [...leaders, s].sort((a, b) => b.amountSats - a.amountSats || b.paidAt - a.paidAt).slice(0, PUBLIC_PAGE.leaders)

function Tags({ p }: { p: PublicProject }) {
  const { t } = useI18n()
  const trending = useIsTrending(p)
  if (!p.category && !trending) return null
  return (
    <div className="flex gap-2">
      {p.category && <Tag tone="accent">{t.cats[p.category]}</Tag>}
      {trending && <Tag tone="outline">{t.trending}</Tag>}
    </div>
  )
}

function ContributeButton({ p, onClick, className }: { p: PublicProject; onClick: () => void; className?: string }) {
  const { t } = useI18n()
  const preview = useContext(PreviewCtx) !== null
  const open = isOpen(p) && !preview
  return (
    <Button variant="cta" icon={open ? 'zap' : undefined} className={className} disabled={!open} onClick={onClick}>
      {open ? t.contribute : preview ? t.previewNoPay : t.projectClosed}
    </Button>
  )
}

function RewardList({ p, onPick, className }: { p: PublicProject; onPick: (rewardId: string) => void; className?: string }) {
  const { t, f } = useI18n()
  const preview = useContext(PreviewCtx) !== null
  if (!p.rewards.length) return null
  const open = isOpen(p) && !preview
  return (
    <div className={className}>
      <h6 className="text-neutral-700">{t.rewards}</h6>
      <div className="flex flex-col gap-2">
        {p.rewards.map((r) => {
          const left = r.limit === null ? null : Math.max(0, r.limit - r.claimed)
          const pickable = open && left !== 0
          const counts = [f(r.backers === 1 ? t.rewardBackersOne : t.rewardBackers, { n: fmt(r.backers) }), left === null ? null : left === 0 ? t.soldOut : f(t.rewardLeft, { n: fmt(left) })]
          // The card is one big target; the title button stretches over it so "More" can sit inside.
          return (
            <article key={r.id} aria-label={r.title} className={cx('relative flex flex-col gap-1 rounded-md border border-divider p-3.5', pickable && 'hover:border-accent')}>
              {r.image && <img src={r.image} alt="" loading="lazy" className="-mx-3.5 -mt-3.5 mb-2 aspect-[4/3] w-[calc(100%+1.75rem)] max-w-none rounded-t-md object-cover" />}
              <span className="tnum text-[13px] text-accent-700">{f(t.rewardFrom, { sats: fmt(r.minSats) })}</span>
              <button
                type="button"
                disabled={!pickable}
                onClick={() => onPick(r.id)}
                className="cursor-pointer text-left text-[15px] font-medium after:absolute after:inset-0 after:rounded-md after:content-[''] disabled:cursor-default"
              >
                {r.title}
              </button>
              {r.description && <ClampedText text={r.description} />}
              <span className="tnum text-xs text-neutral-600">{counts.filter(Boolean).join(' · ')}</span>
            </article>
          )
        })}
      </div>
    </div>
  )
}

/** Up to three lines, with a toggle when the text is longer. */
function ClampedText({ text }: { text: string }) {
  const { t } = useI18n()
  const ref = useRef<HTMLSpanElement>(null)
  const id = useId()
  const [expanded, setExpanded] = useState(false)
  const [overflows, setOverflows] = useState(false)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || expanded) return
    const measure = () => setOverflows(el.scrollHeight > el.clientHeight + 1)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [text, expanded])
  return (
    <>
      <span id={id} ref={ref} className={cx('text-sm whitespace-pre-line text-neutral-700', !expanded && 'line-clamp-3')}>
        {text}
      </span>
      {(overflows || expanded) && (
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={id}
          className="relative z-[1] cursor-pointer self-start text-[13px] text-accent-700 underline underline-offset-2"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? t.readLess : t.readMore}
        </button>
      )}
    </>
  )
}

function milestoneTicks(p: PublicProject) {
  if (!p.goalSats) return undefined
  return p.milestones.filter((m) => m.sats < p.goalSats!).map((m) => ({ at: m.sats / p.goalSats!, reached: p.raisedSats >= m.sats }))
}

function MilestoneList({ p }: { p: PublicProject }) {
  const { t } = useI18n()
  if (!p.milestones.length) return null
  return (
    <>
      <h3 className="mb-2.5 text-[20px]">{t.milestones}</h3>
      {p.milestones.map((m, i) => {
        const done = p.raisedSats >= m.sats
        return (
          <div key={i} className="grid grid-cols-[22px_1fr_auto] items-start gap-2.5 border-t border-divider py-2.5">
            <span className="mt-0.5 grid size-[18px] place-items-center rounded-full border text-accent-700" style={{ borderColor: done ? 'var(--color-accent)' : 'var(--color-neutral-400)' }}>
              {done && <Icon name="check" size={12} />}
            </span>
            <span className="text-sm">{m.label}</span>
            <span className="tnum text-[13px] text-neutral-700">{fmt(m.sats)}</span>
          </div>
        )
      })}
    </>
  )
}

function Leaderboard({ slug, compact }: { slug: string; compact?: boolean }) {
  const { t } = useI18n()
  const leaders = useLeaders(slug)
  if (!leaders.data?.length) return null
  return (
    <div>
      <h6 className="text-neutral-700">{t.leaderboard}</h6>
      {leaders.data.map((l, i) =>
        compact ? (
          <div key={l.invoiceId} className="grid grid-cols-[26px_1fr_auto] gap-2.5 border-b border-divider py-2 text-sm">
            <span className="tnum font-heading text-lg text-accent-700">{i + 1}</span>
            <span className="min-w-0">
              <SupporterChip s={l} />
            </span>
            <span className="tnum font-medium">{fmt(l.amountSats)}</span>
          </div>
        ) : (
          <div key={l.invoiceId} className="grid grid-cols-[24px_30px_1fr_auto] items-center gap-2.5 border-b border-divider py-[9px]">
            <span className="tnum font-heading text-lg text-accent-700">{i + 1}</span>
            <SupporterAvatar s={l} size={28} />
            <span className="truncate text-sm">
              <SupporterName s={l} />
            </span>
            <span className="tnum text-sm font-medium">{fmt(l.amountSats)}</span>
          </div>
        ),
      )}
    </div>
  )
}

/** The reward a supporter chose, as the page shows it now (p is already localized); its name when they paid once it is gone. */
const rewardTitle = (p: PublicProject, s: Supporter): string | null =>
  s.reward && (p.rewards.find((r) => r.id === s.reward!.id)?.title ?? s.reward.title)

function RewardTag({ title }: { title: string }) {
  return (
    <Tag tone="outline" icon="gift" className="ml-1.5 max-w-[180px] truncate align-middle">
      {title}
    </Tag>
  )
}

function ActivityRow({ p, s, compact, now }: { p: PublicProject; s: Supporter; compact?: boolean; now: number }) {
  const { t, f } = useI18n()
  const { name: who, picture } = useSupporterIdentity(s)
  const reward = rewardTitle(p, s)
  return (
    <div className="flex gap-2.5 border-b border-divider py-2 text-sm">
      {picture ? (
        <Avatar name={who} src={picture} size={20} className="mt-px" />
      ) : (
        <span className="mt-[3px] text-accent">
          <Icon name="zap" />
        </span>
      )}
      {compact ? (
        <span className="flex-1">
          {who} <span className="tnum text-accent-700">+{fmt(s.amountSats)}</span>
          {reward && <RewardTag title={reward} />}
        </span>
      ) : (
        <div className="flex-1">
          <div>
            <b className="font-semibold">{who}</b> <span className="tnum">{f(t.sent, { amount: fmt(s.amountSats) })}</span>
            {reward && <RewardTag title={reward} />}
          </div>
          {s.comment && <div className="text-neutral-700 italic">“{s.comment}”</div>}
        </div>
      )}
      <span className="text-xs whitespace-nowrap text-neutral-600">{ago(s.paidAt, t.ago, now)}</span>
    </div>
  )
}

function Activity({ p, compact, limit }: { p: PublicProject; compact?: boolean; limit?: number }) {
  const slug = p.slug
  const { t } = useI18n()
  const now = useNow(60_000)
  const q = useActivity(slug)
  const rows = (q.data?.pages.flatMap((p) => p.supporters) ?? []).slice(0, limit)
  return (
    <div>
      <h6 className="mt-0 text-neutral-700">{t.activity}</h6>
      {rows.map((s) => (
        <ActivityRow key={s.invoiceId} p={p} s={s} compact={compact} now={now} />
      ))}
      {!q.isPending && rows.length === 0 && <p className="py-3 text-sm text-neutral-600">{t.noActivity}</p>}
      {!limit && q.hasNextPage && (
        <Button variant="ghost" className="mt-2" loading={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
          {t.loadMore}
        </Button>
      )}
    </div>
  )
}

async function shareNative(p: PublicProject) {
  const url = projectUrl(p.slug)
  if (navigator.share) {
    try {
      return await navigator.share({ title: p.title, url })
    } catch {
      // cancelled
    }
  }
  await navigator.clipboard.writeText(url)
}

// ─── 2a · Mobile ──────────────────────────────────────────────────────────────

function MobileProject({ project: p, onContribute }: { project: PublicProject; onContribute: (rewardId?: string) => void }) {
  const { t } = useI18n()
  const navigate = useNavigate()
  const [tab, setTab] = useState<Tab>('story')
  const pct = pctOf(p)
  return (
    <div className="min-h-dvh">
      <div className="flex items-center justify-between px-3 py-1">
        <Button variant="ghost" plain iconOnly icon="chevL" aria-label={t.back} onClick={() => (history.length > 1 ? navigate(-1) : navigate('/'))} />
        <Button variant="ghost" plain iconOnly icon="share" aria-label={t.share} onClick={() => void shareNative(p)} />
      </div>
      <div className="px-5 pb-[100px]">
        <Plate src={p.coverUrl} />
        <div className="mt-4 mb-2">
          <Tags p={p} />
        </div>
        <h1 className="m-0 mb-1.5 text-[28px] leading-[1.25] font-medium">{p.title}</h1>
        <TranslationNote className="mb-2" />
        <div className="flex items-center gap-2 text-[13px] text-neutral-700">
          <Avatar name={p.creator.displayName} size={24} accent />
          {`${t.by} ${p.creator.displayName}`}
        </div>
        <div className="mt-5 mb-1 flex items-baseline gap-1.5">
          <span className="tnum text-[30px] leading-[1.1] font-medium">{fmt(p.raisedSats)}</span>
          <span className="text-sm text-neutral-600">sats</span>
        </div>
        {p.goalSats && <div className="tnum mb-2.5 text-[13px] text-neutral-700">{`${t.ofGoalSats} ${fmt(p.goalSats)} sats`}</div>}
        <Progress value={p.goalSats ? p.raisedSats / p.goalSats : 0} ticks={milestoneTicks(p)} />
        <div className="tnum mt-4 grid grid-cols-3 border-y border-divider">
          <Stat value={pct === null ? '—' : `${pct}%`} label={t.funded} />
          <Stat value={fmt(p.supporterCount)} label={t.backers} bordered />
          <Stat value={p.endsAt ? String(daysLeft(p.endsAt)) : '—'} label={t.daysLeft} bordered />
        </div>
        <RewardList p={p} onPick={onContribute} className="mt-4" />
        <Tabs<Tab>
          className="mt-[18px]"
          aria-label={p.title}
          value={tab}
          onChange={setTab}
          items={[
            { value: 'story', label: t.story },
            { value: 'supporters', label: t.supporters },
          ]}
        />
        {tab === 'story' ? (
          <div className="pt-4">
            <Markdown source={p.body} />
            <div className="mt-5">
              <MilestoneList p={p} />
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-[22px] pt-3.5">
            <Leaderboard slug={p.slug} />
            <Activity p={p} />
          </div>
        )}
      </div>
      <div className="fixed inset-x-0 bottom-0 z-20 flex gap-2.5 border-t border-divider bg-bg px-5 pt-3 pb-[26px]">
        <Button variant="secondary" iconOnly icon="share" className="size-12" aria-label={t.share} onClick={() => void shareNative(p)} />
        <ContributeButton p={p} onClick={() => onContribute()} className="h-12 flex-1 text-base" />
      </div>
    </div>
  )
}

function Stat({ value, label, bordered }: { value: string; label: string; bordered?: boolean }) {
  return (
    <div className={bordered ? 'border-l border-divider px-3 py-2.5' : 'py-2.5'}>
      <div className="text-lg font-medium">{value}</div>
      <div className="text-xs text-neutral-600">{label}</div>
    </div>
  )
}

// ─── 2c · Desktop ─────────────────────────────────────────────────────────────

function DesktopProject({ project: p, onContribute }: { project: PublicProject; onContribute: (rewardId?: string) => void }) {
  const { t } = useI18n()
  const [tab, setTab] = useState<Tab>('story')
  const pct = pctOf(p)
  return (
    <div className="mx-auto max-w-[1280px]">
      <PublicNav loginVariant="secondary" />
      <div className="grid grid-cols-[minmax(0,1fr)_380px] gap-12 px-10 pt-8">
        <div>
          <div className="mb-2.5">
            <Tags p={p} />
          </div>
          <h1 className="m-0 mb-2 text-[40px] leading-[1.2] font-normal">{p.title}</h1>
          <TranslationNote className="mb-3" />
          {p.summary && <p className="m-0 mb-5 max-w-[640px] text-[17px] text-neutral-700">{p.summary}</p>}
          <Plate src={p.coverUrl} ratio="16/9" />
        </div>
        <aside className="sticky top-5 mt-10 self-start rounded-md border border-divider p-6">
          <div className="flex items-baseline gap-1.5">
            <span className="tnum text-[34px] leading-[1.1] font-medium">{fmt(p.raisedSats)}</span>
            <span className="text-neutral-600">sats</span>
          </div>
          <div className="tnum mt-0.5 mb-3 text-[13px] text-neutral-700">
            {p.goalSats ? `${t.ofGoalSats} ${fmt(p.goalSats)} sats · ${pct}%` : `${t.by} ${p.creator.displayName}`}
          </div>
          <Progress value={p.goalSats ? p.raisedSats / p.goalSats : 0} ticks={milestoneTicks(p)} />
          <div className="tnum my-4 grid grid-cols-2 border-y border-divider">
            <div className="py-2.5">
              <div className="text-[20px] font-medium">{fmt(p.supporterCount)}</div>
              <div className="text-xs text-neutral-600">{t.backers}</div>
            </div>
            <div className="border-l border-divider px-3.5 py-2.5">
              <div className="text-[20px] font-medium">{p.endsAt ? daysLeft(p.endsAt) : '—'}</div>
              <div className="text-xs text-neutral-600">{t.daysLeft}</div>
            </div>
          </div>
          <ContributeButton p={p} onClick={() => onContribute()} className="h-12 w-full text-base" />
          <ShareButtons project={p} className="mt-2.5" />
          <RewardList p={p} onPick={onContribute} className="mt-5" />
          <div className="mt-5 flex items-center gap-1.5 text-xs text-neutral-600">
            <Icon name="eyeOff" />
            {t.anonNote}
          </div>
        </aside>
      </div>
      <div className="grid grid-cols-[minmax(0,1fr)_380px] gap-12 px-10 pt-7 pb-10">
        <div>
          <Tabs<Tab>
            className="mb-5"
            gap={26}
            size={15}
            aria-label={p.title}
            value={tab}
            onChange={setTab}
            items={[
              { value: 'story', label: t.story },
              { value: 'supporters', label: `${t.supporters} (${fmt(p.supporterCount)})` },
            ]}
          />
          {tab === 'story' ? (
            <>
              <Markdown source={p.body} style={{ columns: p.body.length > 600 ? 2 : 1, columnGap: 32 }} />
              {p.milestones.length > 0 && (
                <>
                  <h3 className="mt-[18px]">{t.milestones}</h3>
                  <div className="grid grid-cols-3 gap-4">
                    {p.milestones.map((m, i) => (
                      <div key={i} className="border-t-2 pt-2.5" style={{ borderColor: p.raisedSats >= m.sats ? 'var(--color-accent)' : 'var(--color-neutral-400)' }}>
                        <div className="tnum text-[13px] text-accent-700">{fmt(m.sats)} sats</div>
                        <div className="text-sm">{m.label}</div>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </>
          ) : (
            <Activity p={p} />
          )}
        </div>
        <div className="flex flex-col gap-7">
          <Leaderboard slug={p.slug} compact />
          <Activity p={p} compact limit={5} />
        </div>
      </div>
    </div>
  )
}
