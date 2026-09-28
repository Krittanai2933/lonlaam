import type { Project, ProjectStatsResponse, StatsRange, Supporter, SupporterFilter } from '@nampu/types'
import { STATS_RANGES } from '@nampu/types'
import { Avatar, BarChart, Brand, Button, cx, Icon, Menu, Notice, Progress, Seg, Tag, type IconName, type MenuItem } from '@nampu/ui'
import { keepPreviousData, useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import { useDeferredValue, useEffect, useState, type ReactNode } from 'react'
import { Link, Navigate, useNavigate, useParams } from 'react-router'
import { api } from '../lib/api'
import { FullPageSpinner, useAuth } from '../lib/auth'
import { ago, fmt, fmtDate } from '../lib/format'
import { useIsDesktop, useNow, useProjectSocket } from '../lib/hooks'
import { useI18n } from '../lib/i18n'
import { useTheme } from '../lib/theme'

/** /dashboard → newest project, or the editor when there are none. */
export function DashboardIndex() {
  const q = useQuery({ queryKey: ['myProjects'], queryFn: api.myProjects })
  if (q.isPending) return <FullPageSpinner />
  const first = q.data?.projects[0]
  return <Navigate to={first ? `/dashboard/${first.id}` : '/projects/new'} replace />
}

export default function DashboardPage() {
  const { id } = useParams() as { id: string }
  const desktop = useIsDesktop()
  const qc = useQueryClient()
  const project = useQuery({ queryKey: ['project', id], queryFn: () => api.project(id) })
  const live = project.data && project.data.status !== 'draft' ? project.data.slug : null

  // New payments arrive over the project's WebSocket; refresh everything derived from them.
  useProjectSocket(live, (m) => {
    if (m.type !== 'payment') return
    void qc.invalidateQueries({ queryKey: ['stats', id] })
    void qc.invalidateQueries({ queryKey: ['supporters', id] })
    qc.setQueryData<Project>(['project', id], (p) => (p ? { ...p, ...m.stats } : p))
  })

  if (project.isPending) return <FullPageSpinner />
  if (project.isError) return <div className="p-10 text-danger">{project.error.message}</div>
  return desktop ? <DesktopDashboard project={project.data} /> : <MobileDashboard project={project.data} />
}

// ─── shared pieces ────────────────────────────────────────────────────────────

function useStats(id: string, range: StatsRange) {
  return useQuery({ queryKey: ['stats', id, range], queryFn: () => api.stats(id, range), placeholderData: keepPreviousData, refetchInterval: 60_000 })
}

function useSupporters(id: string, q: string, filter: SupporterFilter) {
  return useInfiniteQuery({
    queryKey: ['supporters', id, q, filter],
    queryFn: ({ pageParam }) => api.supporters(id, { q, filter, limit: 20, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
  })
}

function useDelta(stats: ProjectStatsResponse | undefined): { text: string; pct?: string; tone: 'success' | 'danger' } | null {
  const { t, f, lang } = useI18n()
  if (!stats) return null
  if (stats.range === 'today') return { text: f(t.deltaToday, { n: stats.backers }), tone: 'success' }
  if (stats.range === 'all') return { text: f(t.since, { date: fmtDate(stats.from, lang) }), tone: 'success' }
  const prev = stats.previous?.totalSats ?? 0
  if (prev === 0) return null
  const pct = Math.round(((stats.totalSats - prev) / prev) * 100)
  const s = `${pct >= 0 ? '+' : ''}${pct}%`
  return { text: f(stats.range === '7d' ? t.deltaWeek : t.deltaMonth, { pct: s }), pct: s, tone: pct >= 0 ? 'success' : 'danger' }
}

const pctOfGoal = (p: Project) => (p.goalSats ? Math.round((p.raisedSats / p.goalSats) * 100) : null)

function StatusBanner({ project }: { project: Project }) {
  const { t } = useI18n()
  if (project.status === 'draft')
    return (
      <Notice className="mb-4">
        {t.draftBanner}{' '}
        <Link to={`/projects/${project.id}/edit?step=4`} className="ml-1">
          {t.publish} →
        </Link>
      </Notice>
    )
  if (project.status === 'closed') return <Notice className="mb-4">{t.closedBanner}</Notice>
  return null
}

function useShare(project: Project) {
  const { t } = useI18n()
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const x = setTimeout(() => setCopied(false), 1800)
    return () => clearTimeout(x)
  }, [copied])
  const url = `${location.origin}/p/${project.slug}`
  const share = async () => {
    if (navigator.share) {
      try {
        await navigator.share({ title: project.title, url })
        return
      } catch {
        // cancelled → fall back to copying
      }
    }
    await navigator.clipboard.writeText(url)
    setCopied(true)
  }
  return { share, label: copied ? t.linkCopied : t.share, disabled: project.status === 'draft' }
}

function useProjectMenu(current: Project): MenuItem[] {
  const { t } = useI18n()
  const { signOut } = useAuth()
  const navigate = useNavigate()
  const list = useQuery({ queryKey: ['myProjects'], queryFn: api.myProjects })
  return [
    ...(list.data?.projects ?? []).map((p) => ({ label: <span className="truncate">{p.title}</span>, current: p.id === current.id, onSelect: () => navigate(`/dashboard/${p.id}`) })),
    { label: <span className="flex items-center gap-2 text-accent-700"><Icon name="plus" size={16} />{t.newProject}</span>, onSelect: () => navigate('/projects/new') },
    { label: <span className="flex items-center gap-2"><Icon name="logout" size={16} />{t.logout}</span>, onSelect: () => void signOut().then(() => navigate('/login')) },
  ]
}

function csvName(p: Project) {
  return `${p.slug}-supporters-${new Date().toISOString().slice(0, 10)}.csv`
}

// ─── 5a · Mobile ──────────────────────────────────────────────────────────────

function MobileDashboard({ project }: { project: Project }) {
  const { t } = useI18n()
  const { theme, toggleTheme } = useTheme()
  const [range, setRange] = useState<StatsRange>('7d')
  const stats = useStats(project.id, range)
  const delta = useDelta(stats.data)
  const supporters = useSupporters(project.id, '', 'all')
  const menu = useProjectMenu(project)
  const s = stats.data
  const goalPct = pctOfGoal(project)

  return (
    <div className="relative min-h-dvh">
      <div className="flex items-center pt-2 pr-3.5 pb-1 pl-5">
        <div className="min-w-0 flex-1">
          <div className="text-xs text-neutral-600">{t.dashboard}</div>
          <div className="truncate font-heading text-[20px] font-semibold">{project.title}</div>
        </div>
        <Button variant="ghost" plain iconOnly icon={theme === 'dark' ? 'sun' : 'moon'} aria-label={t.switchTheme} onClick={toggleTheme} />
        <Menu items={menu} trigger={(p) => <Button variant="ghost" plain iconOnly icon="chevD" aria-label={t.dashboard} {...p} />} />
      </div>

      <div className="px-5 pt-2.5 pb-[90px]">
        <StatusBanner project={project} />
        <Seg<StatsRange>
          full
          aria-label={t.received}
          value={range}
          onChange={setRange}
          options={STATS_RANGES.map((r) => ({ value: r, label: t.ranges[r] }))}
        />
        <div className="mt-[18px]">
          <div className="text-[13px] text-neutral-700">{t.received}</div>
          <div className="flex items-baseline gap-1.5">
            <span className="tnum font-heading text-[44px] leading-[1.1] font-normal">{fmt(s?.totalSats ?? 0)}</span>
            <span className="text-neutral-600">sats</span>
          </div>
          {delta && <div className={cx('tnum text-[13px]', delta.tone === 'danger' ? 'text-danger' : 'text-success')}>{delta.text}</div>}
        </div>
        <BarChart className="mt-3.5" values={s?.buckets.map((b) => b.sats) ?? Array(14).fill(0)} label={t.received} />
        <div className="tnum grid grid-cols-3 border-b border-divider">
          <MobileStat value={fmt(s?.backers ?? 0)} label={t.backers} />
          <MobileStat value={fmt(s?.avgSats ?? 0)} label={t.avg} bordered />
          <MobileStat value={goalPct === null ? '—' : `${goalPct}%`} label={t.ofGoal} bordered />
        </div>

        <div className="mt-5 flex items-baseline justify-between">
          <h6 className="m-0 text-neutral-700">{t.supporters}</h6>
          <Button variant="ghost" icon="download" onClick={() => void api.downloadSupportersCsv(project.id, {}, csvName(project))}>
            CSV
          </Button>
        </div>
        <SupporterList query={supporters} />
      </div>

      <nav className="fixed inset-x-0 bottom-0 grid grid-cols-4 border-t border-divider bg-bg px-2 pt-2 pb-6 text-[11px]">
        <BottomTab icon="dash" label={t.overview} active />
        <BottomTab icon="msg" label={t.updatesNav} disabled title={t.comingSoon} />
        <BottomTab icon="gift" label={t.rewards} disabled title={t.comingSoon} />
        <BottomTab icon="edit" label={t.edit} to={`/projects/${project.id}/edit`} />
      </nav>
    </div>
  )
}

function MobileStat({ value, label, bordered }: { value: string; label: string; bordered?: boolean }) {
  return (
    <div className={cx('py-3', bordered && 'border-l border-divider px-2.5')}>
      <div className="text-lg font-medium">{value}</div>
      <div className="text-xs text-neutral-600">{label}</div>
    </div>
  )
}

function BottomTab({ icon, label, active, disabled, to, title }: { icon: IconName; label: string; active?: boolean; disabled?: boolean; to?: string; title?: string }) {
  const cls = cx('flex flex-col items-center gap-[3px] no-underline', active ? 'text-accent-700' : 'text-neutral-600', disabled && 'opacity-45')
  const inner = (
    <>
      <Icon name={icon} />
      {label}
    </>
  )
  if (to)
    return (
      <Link to={to} className={cls} style={{ color: 'var(--color-neutral-600)' }}>
        {inner}
      </Link>
    )
  return (
    <span className={cls} aria-current={active ? 'page' : undefined} aria-disabled={disabled} title={title}>
      {inner}
    </span>
  )
}

type SupportersQuery = ReturnType<typeof useSupporters>

function SupporterList({ query }: { query: SupportersQuery }) {
  const { t } = useI18n()
  const now = useNow(60_000)
  const rows = query.data?.pages.flatMap((p) => p.supporters) ?? []
  if (query.isPending) return <div className="py-6 text-center text-sm text-neutral-600">…</div>
  if (!rows.length) return <div className="py-6 text-center text-sm text-neutral-600">{t.noSupporters}</div>
  return (
    <>
      {rows.map((s) => (
        <div key={s.invoiceId} className="grid grid-cols-[34px_1fr_auto] items-center gap-2.5 border-b border-divider py-2.5">
          <Avatar name={s.name ?? t.anonymous} />
          <div className="min-w-0">
            <div className="truncate text-sm">{s.name ?? t.anonymous}</div>
            <div className="truncate text-xs text-neutral-600">{s.comment || `Lightning · ${ago(s.paidAt, t.ago, now)}`}</div>
          </div>
          <span className="tnum text-sm font-medium text-accent-700">+{fmt(s.amountSats)}</span>
        </div>
      ))}
      {query.hasNextPage && (
        <Button variant="ghost" className="mt-2 w-full" loading={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
          {t.loadMore}
        </Button>
      )}
    </>
  )
}

// ─── 5b · Desktop ─────────────────────────────────────────────────────────────

function DesktopDashboard({ project }: { project: Project }) {
  const { t, f, lang, toggleLang } = useI18n()
  const { theme, toggleTheme } = useTheme()
  const { creator } = useAuth()
  const all = useStats(project.id, 'all')
  const week = useStats(project.id, '7d')
  const weekDelta = useDelta(week.data)
  const [search, setSearch] = useState('')
  const q = useDeferredValue(search.trim())
  const [filter, setFilter] = useState<SupporterFilter>('all')
  const supporters = useSupporters(project.id, q, filter)
  const menu = useProjectMenu(project)
  const share = useShare(project)
  const allTime = all.data?.allTime

  return (
    <div className="mx-auto max-w-[1280px]">
      <nav className="nav px-10 py-3.5">
        <Link to="/dashboard" className="nav-brand">
          <Brand />
        </Link>
        <a href="/">{t.explore}</a>
        <Link to={`/dashboard/${project.id}`} aria-current="page">
          {t.dashboard}
        </Link>
        <Button variant="ghost" plain icon="globe" onClick={toggleLang}>
          {lang === 'th' ? 'EN' : 'TH'}
        </Button>
        <Button variant="ghost" plain iconOnly icon={theme === 'dark' ? 'sun' : 'moon'} aria-label={t.switchTheme} onClick={toggleTheme} />
        <Menu
          items={menu}
          trigger={(p) => (
            <button type="button" className="cursor-pointer rounded-full" aria-label={creator?.displayName ?? ''} {...p}>
              <Avatar name={creator?.displayName ?? '?'} accent />
            </button>
          )}
        />
      </nav>

      <div className="px-10 pt-7 pb-10">
        <div className="mb-[22px] flex items-end gap-4">
          <div className="flex-1">
            <div className="text-[13px] text-neutral-600">{t.dashboard}</div>
            <h1 className="m-0 text-[36px] font-normal">{project.title}</h1>
          </div>
          <Button variant="secondary" icon="share" onClick={() => void share.share()} disabled={share.disabled}>
            {share.label}
          </Button>
          <Button variant="primary" icon="msg" disabled title={t.comingSoon}>
            {t.postUpdate}
          </Button>
        </div>
        <StatusBanner project={project} />

        <div className="tnum grid grid-cols-[1.4fr_1fr_1fr_1fr] border-y border-divider">
          <div className="py-[18px] pr-5">
            <div className="text-[13px] text-neutral-700">{t.receivedAll}</div>
            <div className="flex items-baseline gap-1.5">
              <span className="font-heading text-[40px] leading-[1.1]">{fmt(allTime?.raisedSats ?? project.raisedSats)}</span>
              <span className="text-neutral-600">sats</span>
            </div>
            <Progress className="mt-2" value={project.goalSats ? project.raisedSats / project.goalSats : 0} />
          </div>
          <Kpi label={t.last7} value={fmt(week.data?.totalSats ?? 0)} sub={weekDelta ? <span className={weekDelta.tone === 'danger' ? 'text-danger' : 'text-success'}>{weekDelta.pct}</span> : null} />
          <Kpi label={t.backers} value={fmt(allTime?.backers ?? project.supporterCount)} sub={<span className="text-neutral-600">{f(t.anonCount, { n: allTime?.anonymous ?? 0 })}</span>} />
          <Kpi label={t.rewardsToSend} value="—" sub={<span className="text-accent-700">{t.comingSoon}</span>} />
        </div>

        <div className="mt-6 mb-2 flex items-center gap-3">
          <h3 className="m-0 flex-1">{t.supporters}</h3>
          <label className="flex h-9 w-60 items-center gap-2 rounded-md border border-divider px-2.5 text-[13px] text-neutral-600 focus-within:border-accent">
            <Icon name="search" />
            <input className="w-full bg-transparent text-fg outline-none placeholder:text-neutral-600" placeholder={t.searchSup} value={search} onChange={(e) => setSearch(e.target.value)} />
          </label>
          <Seg<SupporterFilter | 'reward'>
            aria-label={t.supporters}
            value={filter}
            onChange={(v) => v !== 'reward' && setFilter(v)}
            options={[
              { value: 'all', label: t.all },
              { value: 'reward', label: t.withReward, disabled: true, title: t.comingSoon },
              { value: 'message', label: t.withMsg },
            ]}
          />
          <Button variant="secondary" icon="download" onClick={() => void api.downloadSupportersCsv(project.id, { q, filter }, csvName(project))}>
            CSV
          </Button>
        </div>
        <SupporterTable query={supporters} searching={!!q || filter !== 'all'} />
      </div>
    </div>
  )
}

function Kpi({ label, value, sub }: { label: string; value: string; sub: ReactNode }) {
  return (
    <div className="border-l border-divider px-5 py-[18px]">
      <div className="text-[13px] text-neutral-700">{label}</div>
      <div className="text-[26px] font-medium">{value}</div>
      <div className="text-xs">{sub}</div>
    </div>
  )
}

function SupporterTable({ query, searching }: { query: SupportersQuery; searching: boolean }) {
  const { t } = useI18n()
  const now = useNow(60_000)
  const rows: Supporter[] = query.data?.pages.flatMap((p) => p.supporters) ?? []
  return (
    <>
      <table className="table">
        <thead>
          <tr>
            <th>{t.supporter}</th>
            <th className="text-right">sats</th>
            <th>{t.message}</th>
            <th>{t.reward}</th>
            <th>{t.when}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => (
            <tr key={s.invoiceId}>
              <td>
                <div className="flex items-center gap-2.5">
                  <Avatar name={s.name ?? t.anonymous} size={28} />
                  <div>
                    <div>{s.name ?? t.anonymous}</div>
                    <div className="text-[11px] text-neutral-600">Lightning</div>
                  </div>
                </div>
              </td>
              <td className="tnum text-right font-medium">{fmt(s.amountSats)}</td>
              <td className="max-w-[300px] text-neutral-700 italic">{s.comment || '—'}</td>
              <td>
                <Tag tone="plain">—</Tag>
              </td>
              <td className="text-[13px] whitespace-nowrap text-neutral-600">{ago(s.paidAt, t.ago, now)}</td>
            </tr>
          ))}
          {!query.isPending && rows.length === 0 && (
            <tr>
              <td colSpan={5} className="py-8 text-center text-sm text-neutral-600">
                {searching ? t.noMatches : t.noSupporters}
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {query.hasNextPage && (
        <div className="mt-3 flex justify-center">
          <Button variant="ghost" loading={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
            {t.loadMore}
          </Button>
        </div>
      )}
    </>
  )
}
