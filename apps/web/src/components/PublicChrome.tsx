import { Brand, Button, cx, Icon, type IconName } from '@nampu/ui'
import type { ReactNode } from 'react'
import { Link, useNavigate } from 'react-router'
import { useAuth } from '../lib/auth'
import { useI18n } from '../lib/i18n'
import { useTheme } from '../lib/theme'

/** Desktop nav for public pages (1c / 2c). */
export function PublicNav({ current, search, loginVariant = 'primary' }: { current?: 'explore'; search?: ReactNode; loginVariant?: 'primary' | 'secondary' }) {
  const { t, lang, toggleLang } = useI18n()
  const { theme, toggleTheme } = useTheme()
  const { token } = useAuth()
  return (
    <nav className="nav px-10 py-3.5">
      <Link to="/" className="nav-brand">
        <Brand />
      </Link>
      <Link to="/" aria-current={current === 'explore' ? 'page' : undefined}>
        {t.explore}
      </Link>
      <a href="/#how">{t.how}</a>
      <Link to="/projects/new">{t.start}</Link>
      {search}
      <Button variant="ghost" plain icon="globe" onClick={toggleLang}>
        {lang === 'th' ? 'EN' : 'TH'}
      </Button>
      <Button variant="ghost" plain iconOnly icon={theme === 'dark' ? 'sun' : 'moon'} aria-label={t.switchTheme} onClick={toggleTheme} />
      {token ? (
        <Link to="/dashboard" className={cx('btn', `btn-${loginVariant}`)}>
          <Icon name="dash" />
          {t.dashboard}
        </Link>
      ) : (
        <Link to="/login" className="btn btn-cta">
          {loginVariant === 'primary' && <Icon name="key" />}
          {t.login}
        </Link>
      )}
    </nav>
  )
}

/** Mobile bottom bar on Discover (1a). */
export function MobileTabBar({ onSearch }: { onSearch: () => void }) {
  const { t } = useI18n()
  const { token } = useAuth()
  const navigate = useNavigate()
  const tab = (icon: IconName, label: string, onClick: () => void, active = false) => (
    <button type="button" onClick={onClick} className={cx('flex cursor-pointer flex-col items-center gap-[3px] bg-transparent', active ? 'text-accent-700' : 'text-neutral-600')} aria-current={active ? 'page' : undefined}>
      <Icon name={icon} />
      {label}
    </button>
  )
  return (
    <nav className="fixed inset-x-0 bottom-0 z-20 grid grid-cols-4 border-t border-divider bg-bg px-2 pt-2 pb-6 text-[11px]">
      {tab('compass', t.explore, () => window.scrollTo({ top: 0, behavior: 'smooth' }), true)}
      {tab('search', t.searchShort, onSearch)}
      {tab('plus', t.start, () => navigate('/projects/new'))}
      {tab('user', t.account, () => navigate(token ? '/dashboard' : '/login'))}
    </nav>
  )
}

/** "How it works" (added — the design links to it but has no page). Three hairline-ruled steps. */
export function HowItWorks({ desktop }: { desktop: boolean }) {
  const { t } = useI18n()
  const steps: [IconName, string, string][] = [
    ['wallet', t.how1t, t.how1b],
    ['qr', t.how2t, t.how2b],
    ['zap', t.how3t, t.how3b],
  ]
  return (
    <section id="how" className={cx('scroll-mt-4 border-t border-divider', desktop ? 'px-10 pt-9 pb-12' : 'mt-8 pt-6')}>
      <h2 className={desktop ? 'mb-5 text-[30px] font-medium' : 'mb-3 text-[24px] font-medium'}>{t.howTitle}</h2>
      <ol className={cx('m-0 list-none p-0', desktop ? 'grid grid-cols-3 gap-8' : 'flex flex-col')}>
        {steps.map(([icon, title, body], i) => (
          <li key={i} className={cx('flex flex-col gap-1.5', desktop ? 'border-t-2 border-accent pt-3' : 'border-t border-divider py-3.5')}>
            <div className="flex items-center gap-2 text-accent-700">
              <span className="tnum font-heading text-[20px]">{`0${i + 1}`}</span>
              <Icon name={icon} />
            </div>
            <div className="font-heading text-[19px] font-semibold">{title}</div>
            <p className="m-0 text-sm text-neutral-700">{body}</p>
          </li>
        ))}
      </ol>
    </section>
  )
}
