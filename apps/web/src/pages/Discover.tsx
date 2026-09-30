import type { DiscoverSort, ProjectCategory, ProjectSummary } from '@nampu/types'
import { DISCOVER_SORTS, PROJECT_CATEGORIES } from '@nampu/types'
import { Button, Chip, cx, Icon, Menu, Plate, Progress, ProjectCard, ProjectRow, Tabs } from '@nampu/ui'
import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { useDeferredValue, useRef, useState } from 'react'
import { Link } from 'react-router'
import { HowItWorks, MobileTabBar, PublicNav, SupportLonlaam } from '../components/PublicChrome'
import { api } from '../lib/api'
import { daysLeft, fmt, short } from '../lib/format'
import { useIsDesktop } from '../lib/hooks'
import { useI18n } from '../lib/i18n'
import { useTheme } from '../lib/theme'

type Cat = ProjectCategory | 'all'

const pct = (p: ProjectSummary) => (p.goalSats ? Math.round((p.raisedSats / p.goalSats) * 100) : null)
const progress = (p: ProjectSummary) => (p.goalSats ? p.raisedSats / p.goalSats : 0)

function useProjectList(cat: Cat, sort: DiscoverSort, q: string) {
  return useInfiniteQuery({
    queryKey: ['discover', cat, sort, q],
    queryFn: ({ pageParam }) => api.projects({ category: cat === 'all' ? undefined : cat, sort, q: q || undefined, limit: 12, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  })
}

/** Top 3 by sats this week (hero list on desktop, "trending" tag everywhere). */
export function useTrending() {
  return useQuery({ queryKey: ['discover', 'trending-top'], queryFn: () => api.projects({ sort: 'trending', limit: 3 }), staleTime: 60_000, select: (r) => r.projects.filter((p) => p.weekSats > 0) })
}

export default function DiscoverPage() {
  const desktop = useIsDesktop()
  const [cat, setCat] = useState<Cat>('all')
  const [sort, setSort] = useState<DiscoverSort>('trending')
  const [search, setSearch] = useState('')
  const q = useDeferredValue(search.trim())
  const list = useProjectList(cat, sort, q)
  const props = { cat, setCat, sort, setSort, search, setSearch, q, list }
  return desktop ? <DesktopDiscover {...props} /> : <MobileDiscover {...props} />
}

interface ViewProps {
  cat: Cat
  setCat: (c: Cat) => void
  sort: DiscoverSort
  setSort: (s: DiscoverSort) => void
  search: string
  setSearch: (s: string) => void
  q: string
  list: ReturnType<typeof useProjectList>
}

function useCats() {
  const { t } = useI18n()
  return (['all', ...PROJECT_CATEGORIES] as Cat[]).map((c) => ({ value: c, label: c === 'all' ? t.catAll : t.cats[c] }))
}

function Empty({ q }: { q: string }) {
  const { t } = useI18n()
  return <p className="py-5 text-neutral-600">{q ? t.emptySearch : t.emptyCat}</p>
}

function LoadMore({ list }: { list: ViewProps['list'] }) {
  const { t } = useI18n()
  if (!list.hasNextPage) return null
  return (
    <div className="mt-4 flex justify-center">
      <Button variant="ghost" loading={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
        {t.loadMore}
      </Button>
    </div>
  )
}

// ─── 1a · Mobile ──────────────────────────────────────────────────────────────

function MobileDiscover({ cat, setCat, search, setSearch, q, list }: ViewProps) {
  const { t, lang, toggleLang } = useI18n()
  const { theme, toggleTheme } = useTheme()
  const cats = useCats()
  const searchRef = useRef<HTMLInputElement>(null)
  const items = list.data?.pages.flatMap((p) => p.projects) ?? []
  const [featured, ...rest] = items

  return (
    <div className="min-h-dvh">
      <div className="flex items-center gap-0.5 pt-1.5 pr-3.5 pb-1.5 pl-5">
        <span className="mr-auto font-heading text-[24px] font-medium">ล้นหลาม</span>
        <Button variant="ghost" plain className="text-[13px]" onClick={toggleLang}>
          {lang === 'th' ? 'EN' : 'TH'}
        </Button>
        <Button variant="ghost" plain iconOnly icon={theme === 'dark' ? 'sun' : 'moon'} aria-label={t.switchTheme} onClick={toggleTheme} />
      </div>
      <div className="px-5 pb-[90px]">
        <h1 className="mt-2.5 mb-3.5 text-[30px] leading-[1.25] font-normal">{t.heroTitle}</h1>
        <label className="flex h-11 items-center gap-2 rounded-md border border-divider px-3 text-sm text-neutral-600 focus-within:border-accent">
          <Icon name="search" />
          <input ref={searchRef} type="search" className="w-full bg-transparent text-fg outline-none placeholder:text-neutral-600" placeholder={t.searchProjects} value={search} onChange={(e) => setSearch(e.target.value)} />
        </label>
        <div className="-mx-5 mt-3.5 flex gap-2 overflow-x-auto px-5 pb-0.5" role="radiogroup" aria-label={t.fCat}>
          {cats.map((c) => (
            <Chip key={c.value} role="radio" aria-checked={cat === c.value} selected={cat === c.value} className="h-9 flex-none py-0" onClick={() => setCat(c.value)}>
              {c.label}
            </Chip>
          ))}
        </div>

        {list.isPending ? (
          <div className="mt-5 aspect-[16/10] animate-pulse rounded-sm bg-neutral-200" />
        ) : featured ? (
          <Link to={`/p/${featured.slug}`} className="mt-5 block text-fg no-underline hover:text-fg">
            <div className="mb-2 flex items-center gap-1.5 text-xs tracking-[0.08em] text-accent-700 uppercase">
              <Icon name="trending" />
              {t.trending}
            </div>
            <Plate src={featured.coverUrl} />
            <div className="mt-3 mb-1 font-heading text-[22px] leading-[1.3] font-semibold">{featured.title}</div>
            {featured.summary && <p className="m-0 mb-2.5 text-sm text-neutral-700">{featured.summary}</p>}
            <Progress value={progress(featured)} />
            <div className="tnum mt-1.5 flex justify-between text-[13px]">
              <span>
                <b className="font-semibold">{short(featured.raisedSats)}</b>
                {featured.goalSats ? ` / ${short(featured.goalSats)}` : ''} sats
              </span>
              <span className="text-neutral-600">{`${fmt(featured.supporterCount)} ${t.backers}`}</span>
            </div>
          </Link>
        ) : (
          <Empty q={q} />
        )}

        <div className="mt-6">
          {rest.map((p) => (
            <Link key={p.id} to={`/p/${p.slug}`} className="block text-fg no-underline hover:text-fg">
              <ProjectRow
                title={p.title}
                kicker={p.category ? t.cats[p.category] : null}
                coverUrl={p.coverUrl}
                progress={progress(p)}
                left={`${short(p.raisedSats)} sats${pct(p) !== null ? ` · ${pct(p)}%` : ''}`}
                right={p.endsAt ? `${daysLeft(p.endsAt)} ${t.daysShort}` : undefined}
              />
            </Link>
          ))}
          <LoadMore list={list} />
        </div>
        <HowItWorks desktop={false} />
        <SupportLonlaam desktop={false} />
      </div>
      <MobileTabBar
        onSearch={() => {
          window.scrollTo({ top: 0, behavior: 'smooth' })
          searchRef.current?.focus()
        }}
      />
    </div>
  )
}

// ─── 1c · Desktop ─────────────────────────────────────────────────────────────

function DesktopDiscover({ cat, setCat, sort, setSort, search, setSearch, q, list }: ViewProps) {
  const { t } = useI18n()
  const cats = useCats()
  const trending = useTrending()
  const items = list.data?.pages.flatMap((p) => p.projects) ?? []

  return (
    <div className="mx-auto max-w-[1280px]">
      <PublicNav
        current="explore"
        search={
          <label className="flex h-9 w-[220px] items-center gap-2 rounded-md border border-divider px-2.5 text-[13px] text-neutral-600 focus-within:border-accent">
            <Icon name="search" />
            <input type="search" className="w-full bg-transparent text-fg outline-none placeholder:text-neutral-600" placeholder={t.searchProjects} value={search} onChange={(e) => setSearch(e.target.value)} />
          </label>
        }
      />
      <div className="grid grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] gap-14 border-b border-divider px-10 pt-11 pb-9">
        <div>
          <h1 className="m-0 mb-3.5 max-w-[620px] text-[52px] leading-[1.15] font-normal">{t.heroTitle}</h1>
          <p className="m-0 mb-6 max-w-[560px] text-lg text-neutral-700">{t.heroSub}</p>
          <div className="flex gap-2.5">
            <Link to="/projects/new" className="btn btn-cta h-11 px-5 text-[15px]">
              <Icon name="plus" />
              {t.start}
            </Link>
            <a href="#how" className="btn btn-secondary h-11 px-5 text-[15px]">
              {t.how}
            </a>
          </div>
        </div>
        <div>
          <h6 className="flex items-center gap-1.5 text-neutral-700">
            <Icon name="trending" />
            {t.trendingWeek}
          </h6>
          {(trending.data ?? []).map((p, i) => (
            <Link key={p.id} to={`/p/${p.slug}`} className="grid grid-cols-[50px_minmax(0,1fr)_auto] items-center gap-3 border-b border-divider py-3 text-fg no-underline hover:text-fg">
              <span className="tnum font-heading text-[40px] leading-[0.9] text-transparent" style={{ WebkitTextStroke: '1px var(--color-accent)' }}>{`0${i + 1}`}</span>
              <div>
                <div className="font-heading text-lg leading-[1.3] font-semibold">{p.title}</div>
                <div className="tnum text-xs text-neutral-700">{`${short(p.raisedSats)} sats · ${fmt(p.supporterCount)} ${t.backers}`}</div>
              </div>
              <span className="tnum font-medium">{pct(p) !== null ? `${pct(p)}%` : ''}</span>
            </Link>
          ))}
          {trending.data && trending.data.length === 0 && <p className="py-3 text-sm text-neutral-600">{t.emptyCat}</p>}
        </div>
      </div>

      <div className="px-10 pt-6 pb-11">
        <Tabs<Cat>
          className="mb-6"
          gap={22}
          size={15}
          aria-label={t.fCat}
          items={cats}
          value={cat}
          onChange={setCat}
          trailing={
            <Menu
              items={DISCOVER_SORTS.map((s) => ({ label: t.sorts[s], current: s === sort, onSelect: () => setSort(s) }))}
              trigger={(p) => (
                <button type="button" aria-haspopup="menu" className="btn btn-secondary h-9 gap-1.5 px-3 font-body text-[13px] font-normal whitespace-nowrap" {...p}>
                  <Icon name="sliders" />
                  {t.sortBy.replace('{sort}', t.sorts[sort])}
                  <Icon name="chevD" size={14} />
                </button>
              )}
            />
          }
        />
        {list.isPending ? (
          <div className="grid grid-cols-3 gap-7">
            {Array.from({ length: 3 }, (_, i) => (
              <div key={i} className="card animate-pulse p-0">
                <div className="aspect-[16/10] bg-neutral-200" />
                <div className="h-24" />
              </div>
            ))}
          </div>
        ) : items.length ? (
          <div className="grid grid-cols-3 gap-7">
            {items.map((p) => (
              <Link key={p.id} to={`/p/${p.slug}`} className="text-fg no-underline hover:text-fg">
                <ProjectCard
                  className={cx('h-full transition-[box-shadow,border-color] hover:border-accent-400 hover:shadow-md')}
                  title={p.title}
                  summary={p.summary}
                  kicker={p.category ? t.cats[p.category] : null}
                  coverUrl={p.coverUrl}
                  raisedLabel={short(p.raisedSats)}
                  goalLabel={p.goalSats ? short(p.goalSats) : null}
                  progress={progress(p)}
                  meta={p.endsAt ? `${daysLeft(p.endsAt)} ${t.daysShort}` : pct(p) !== null ? `${pct(p)}%` : undefined}
                />
              </Link>
            ))}
          </div>
        ) : (
          <Empty q={q} />
        )}
        <LoadMore list={list} />
      </div>
      <HowItWorks desktop />
      <SupportLonlaam desktop />
    </div>
  )
}
