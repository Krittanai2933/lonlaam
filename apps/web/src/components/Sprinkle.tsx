import type { Sprinkle, SprinkleConfigResponse } from '@nampu/types'
import { LIMITS, SPRINKLE, sprinkleShare } from '@nampu/types'
import { Button, Chip, CopyButton, cx, Dialog, Icon, Input, Notice, Pulse, QRCode, Spinner, Switch } from '@nampu/ui'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import { api, ApiError, errorText } from '../lib/api'
import { fmt } from '../lib/format'
import { useI18n } from '../lib/i18n'
import { clock } from './contribute/useContribute'

const PRESETS = [210, 1000, 2100, 5000, 21000]
/** Delay between card flips in the reveal. */
const REVEAL_MS = 750
/** Cards shown before "show more". */
const VISIBLE_CARDS = 6

const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

/**
 * "Sprinkle": one payment to the platform wallet, split evenly across randomly picked open
 * projects by the server (SprinkleRoom). A slim banner on Discover opens the flow in a modal
 * (desktop) or bottom sheet (mobile). State lives here, not in the modal, so closing it never
 * loses a pending invoice or a draw in progress. Hidden when the server has no wallet.
 */
export function SprinkleSection({ desktop }: { desktop: boolean }) {
  const { t } = useI18n()
  const config = useQuery({ queryKey: ['sprinkle-config'], queryFn: api.sprinkleConfig, staleTime: 60_000 })
  const flow = useSprinkle(config.data)
  const [open, setOpen] = useState(false)

  if (!config.data?.enabled || config.data.eligibleProjects < 1) return null

  const s = flow.sprinkle
  const cta = s?.status === 'pending' ? t.sprResumePay : s?.status === 'distributing' ? t.sprResume : t.sprGo
  const close = () => {
    setOpen(false)
    // A finished or abandoned draw starts fresh next time.
    if (s && (s.status === 'done' || s.status === 'expired')) flow.reset()
  }
  const body = <SprinkleBody flow={flow} desktop={desktop} onClose={close} />

  const card = (icon: 'gift' | 'refresh', title: string, text: string, action: ReactNode) => (
    <div className={cx('flex items-center gap-3.5 rounded-md border border-accent-300 bg-[color-mix(in_srgb,var(--color-accent-100)_55%,transparent)]', desktop ? 'px-5 py-4' : 'flex-wrap px-4 py-3.5')}>
      <div className="grid size-11 flex-none place-items-center rounded-full border border-accent-300 text-accent-700">
        <Icon name={icon} size={22} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="font-heading text-lg leading-[1.3] font-semibold">{title}</div>
        <div className="text-sm text-neutral-700">{text}</div>
      </div>
      {action}
    </div>
  )

  // Two side by side (stacked on mobile): one payment now, or the same every month (/monthly).
  return (
    <section id="sprinkle" className={cx('grid gap-3', desktop ? 'grid-cols-2 px-10 pb-10' : 'mt-7')}>
      {card(
        'gift',
        t.sprTitle,
        t.sprBody,
        <Button variant="cta" icon={s?.status === 'distributing' ? undefined : 'gift'} className={cx('h-11 flex-none px-5', !desktop && 'w-full')} onClick={() => setOpen(true)}>
          {s?.status === 'distributing' && <Spinner size={14} />}
          {cta}
        </Button>,
      )}
      {card(
        'refresh',
        t.moTitle,
        t.moCardBody,
        <Link to="/monthly" className={cx('btn btn-cta h-11 flex-none px-5', !desktop && 'w-full')}>
          <Icon name="refresh" />
          {t.moCardGo}
        </Link>,
      )}
      {open &&
        (desktop ? (
          <Dialog open bare onClose={close} className="w-[460px] max-w-full">
            {body}
          </Dialog>
        ) : (
          <Sheet onClose={close}>{body}</Sheet>
        ))}
    </section>
  )
}

// ─── State ────────────────────────────────────────────────────────────────────

function useSprinkle(config: SprinkleConfigResponse | undefined) {
  const { t } = useI18n()
  const [amount, setAmount] = useState(1000)
  const [count, setCount] = useState(3)
  // On by default: sats go to projects that still need them first.
  const [excludeFunded, setExcludeFunded] = useState(true)
  const maxProjects = Math.min(SPRINKLE.projects.max, (excludeFunded ? config?.eligibleUnfunded : config?.eligibleProjects) ?? 0)
  const [name, setName] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sprinkle, setSprinkle] = useState<Sprinkle | null>(null)
  const [now, setNow] = useState(Date.now)

  // Poll while waiting for payment or forwarding; tick the countdown.
  const liveId = sprinkle && (sprinkle.status === 'pending' || sprinkle.status === 'distributing') ? sprinkle.id : null
  useEffect(() => {
    if (!liveId) return
    let cancelled = false
    const tick = setInterval(() => setNow(Date.now()), 1000)
    const poll = setInterval(async () => {
      try {
        const next = await api.sprinkle(liveId)
        if (!cancelled) setSprinkle(next)
      } catch {
        // transient; try again next tick
      }
    }, 2000)
    return () => {
      cancelled = true
      clearInterval(tick)
      clearInterval(poll)
    }
  }, [liveId])

  const projects = Math.max(1, Math.min(count, maxProjects))
  const create = async () => {
    setBusy(true)
    setError(null)
    try {
      const s = await api.createSprinkle({
        amountSats: amount,
        projectCount: projects,
        excludeFunded,
        ...(name.trim() && { supporterName: name.trim() }),
        ...(message.trim() && { comment: message.trim() }),
      })
      setSprinkle(s)
      setNow(Date.now())
    } catch (e) {
      setError(e instanceof ApiError ? errorText(e, t) : t.somethingWrong)
    } finally {
      setBusy(false)
    }
  }

  return {
    maxProjects,
    excludeFunded,
    setExcludeFunded,
    amount,
    setAmount,
    projects,
    setCount,
    name,
    setName,
    message,
    setMessage,
    busy,
    error,
    sprinkle,
    now,
    create,
    reset: () => {
      setSprinkle(null)
      setError(null)
    },
  }
}

type Flow = ReturnType<typeof useSprinkle>

// ─── Containers ───────────────────────────────────────────────────────────────

export function Sheet({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = prev
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])
  return (
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-[color-mix(in_srgb,var(--color-neutral-900)_55%,transparent)]" onClick={onClose} />
      <div role="dialog" aria-modal="true" className="absolute inset-x-0 bottom-0 max-h-[92dvh] overflow-y-auto rounded-t-[14px] bg-surface px-5 pt-2.5 pb-6 shadow-lg">
        <div className="mx-auto mb-2.5 h-1 w-9 rounded-[2px] bg-neutral-400" />
        {children}
      </div>
    </div>
  )
}

function SprinkleBody({ flow, desktop, onClose }: { flow: Flow; desktop: boolean; onClose: () => void }) {
  const { t } = useI18n()
  const s = flow.sprinkle
  return (
    <div className={cx('flex flex-col gap-4', desktop && 'p-7')}>
      <div className="flex items-center gap-2.5">
        <Icon name="gift" size={22} className="text-accent-700" />
        <div className="dialog-title m-0 flex-1 text-[22px]">{t.sprTitle}</div>
        <Button variant="ghost" plain iconOnly icon="x" aria-label={t.close} className="-mr-2" onClick={onClose} />
      </div>
      {!s ? <Form flow={flow} desktop={desktop} /> : s.status === 'pending' || s.status === 'expired' ? <Pay flow={flow} s={s} desktop={desktop} /> : <Reveal s={s} onAgain={flow.reset} onClose={onClose} />}
    </div>
  )
}

// ─── Steps ────────────────────────────────────────────────────────────────────

function Form({ flow: f, desktop }: { flow: Flow; desktop: boolean }) {
  const { t } = useI18n()
  const each = sprinkleShare(f.amount, f.projects)
  const amountOk = f.amount >= SPRINKLE.amountSats.min && f.amount <= SPRINKLE.amountSats.max
  const tooSmall = amountOk && each < SPRINKLE.minSatsPerProject
  return (
    <div className="flex flex-col gap-3.5">
      <p className="m-0 -mt-1.5 text-sm text-neutral-700">{t.sprBody}</p>
      <div className={cx('flex items-baseline gap-2 border-b border-accent pb-1', !desktop && 'justify-center')}>
        <input
          inputMode="numeric"
          aria-label="sats"
          className={cx('tnum w-full min-w-0 bg-transparent text-[36px] leading-[1.1] font-medium outline-none', !desktop && 'text-center')}
          value={f.amount ? fmt(f.amount) : ''}
          onChange={(e) => f.setAmount(Number(e.target.value.replace(/\D/g, '').slice(0, 6)) || 0)}
        />
        <span className="text-neutral-600">sats</span>
      </div>
      <div className="flex flex-wrap gap-2">
        {PRESETS.map((v) => (
          <Chip key={v} selected={f.amount === v} aria-pressed={f.amount === v} className="tnum h-9 py-0" onClick={() => f.setAmount(v)}>
            {fmt(v)}
          </Chip>
        ))}
      </div>
      <Switch className="-my-1" icon="target" label={t.sprExcludeFunded} checked={f.excludeFunded} onChange={f.setExcludeFunded} />
      {f.maxProjects < 1 && <Notice>{t.sprNoneUnfunded}</Notice>}
      <div>
        <div className="mb-1.5 text-[13px] text-neutral-700">{t.sprProjects}</div>
        <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={t.sprProjects}>
          {Array.from({ length: f.maxProjects }, (_, i) => i + 1).map((n) => (
            <Chip key={n} role="radio" aria-checked={f.projects === n} selected={f.projects === n} className="tnum h-9 w-10 justify-center px-0 py-0" onClick={() => f.setCount(n)}>
              {n}
            </Chip>
          ))}
        </div>
      </div>
      <div className="tnum text-sm text-neutral-700">
        {amountOk ? (
          tooSmall ? (
            <span className="text-danger">{t.sprTooSmall.replace('{min}', String(SPRINKLE.minSatsPerProject))}</span>
          ) : (
            t.sprEach.replace('{sats}', fmt(each))
          )
        ) : (
          `${fmt(SPRINKLE.amountSats.min)}–${fmt(SPRINKLE.amountSats.max)} sats`
        )}
      </div>
      <Input className="min-h-11" aria-label={t.namePh} placeholder={t.namePh} maxLength={LIMITS.supporterName.max} value={f.name} onChange={(e) => f.setName(e.target.value)} />
      <Input className="min-h-11" aria-label={t.msgPh} placeholder={t.msgPh} maxLength={LIMITS.comment.max} value={f.message} onChange={(e) => f.setMessage(e.target.value)} />
      {f.error && <Notice tone="danger">{f.error}</Notice>}
      <Button variant="cta" icon="gift" className="h-12 text-base" loading={f.busy} disabled={!amountOk || tooSmall || f.busy || f.maxProjects < 1} onClick={() => void f.create()}>
        {t.sprGo}
      </Button>
      <p className="m-0 text-xs text-neutral-600">{t.sprCustodial.replace('{fee}', String(SPRINKLE.feeReservePercent))}</p>
    </div>
  )
}

function Pay({ flow, s, desktop }: { flow: Flow; s: Sprinkle; desktop: boolean }) {
  const { t } = useI18n()
  const secsLeft = Math.max(0, Math.round((s.expiresAt - flow.now) / 1000))
  const expired = s.status === 'expired' || secsLeft === 0
  return (
    <div className="flex flex-col items-center gap-3">
      <div className="tnum text-[26px] leading-[1.1] font-medium">
        {fmt(s.amountSats)} <span className="text-sm font-normal text-neutral-600">sats</span>
      </div>
      <div className="-mt-1.5 text-[13px] text-neutral-600">{`${t.sprEach.replace('{sats}', fmt(s.perProjectSats))} × ${s.projectCount}`}</div>
      <QRCode
        value={s.bolt11}
        size={desktop ? 240 : 236}
        logo
        dim={expired}
        label="Lightning invoice QR"
        overlay={expired && <span className="rounded-[3px] border border-[#d92f40] bg-white px-3 py-1.5 text-sm text-[#d92f40]">{t.expiredTag}</span>}
      />
      {expired ? (
        <>
          <div className="max-w-[300px] text-center text-sm text-neutral-700">{t.expiredBody}</div>
          <Button variant="cta" icon="refresh" className="h-12 w-full text-base" loading={flow.busy} onClick={() => void flow.create()}>
            {t.newInvoice}
          </Button>
        </>
      ) : (
        <>
          <div className="flex items-center gap-2 text-sm" role="status">
            <Pulse />
            <span>{t.waiting}</span>
            <span className="tnum text-neutral-600">{`· ${t.expiresIn} ${clock(secsLeft)}`}</span>
          </div>
          <div className="flex w-full gap-2">
            <CopyButton text={s.bolt11} label={t.copy} copiedLabel={t.copied} className="h-11 flex-1" />
            {!desktop && (
              <a className="btn btn-cta h-11 flex-1" href={`lightning:${s.bolt11}`}>
                <Icon name="wallet" />
                {t.openLnWallet}
              </a>
            )}
          </div>
        </>
      )}
      <Button variant="ghost" onClick={flow.reset}>
        {t.changeAmount}
      </Button>
    </div>
  )
}

/**
 * Face-down cards, one per project, flipped one at a time as payouts land: the first after a
 * short pause, then every REVEAL_MS. Failed payouts are replaced server-side and never shown.
 */
export function Reveal({ s, onAgain, onClose }: { s: Sprinkle; onAgain?: () => void; onClose: () => void }) {
  const { t } = useI18n()
  const paid = s.payouts.filter((p) => p.status === 'paid')
  const [shown, setShown] = useState(() => (reducedMotion() ? paid.length : 0))
  useEffect(() => {
    if (shown >= paid.length) return
    if (reducedMotion()) return setShown(paid.length)
    const timer = setTimeout(() => setShown((n) => n + 1), shown === 0 ? 500 : REVEAL_MS)
    return () => clearTimeout(timer)
  }, [shown, paid.length])

  const finished = s.status === 'done' && shown >= paid.length
  // Cards past the first few keep flipping in the background; "show more" reveals them.
  const [expanded, setExpanded] = useState(false)
  const hidden = expanded ? 0 : Math.max(0, s.projectCount - VISIBLE_CARDS)
  return (
    <div className="flex flex-col gap-3.5" role="status">
      <div className="flex items-center gap-2.5">
        {finished ? (
          <div className="grid size-9 flex-none place-items-center rounded-full border-[1.5px] border-success text-success">
            <Icon name="check" size={18} />
          </div>
        ) : (
          <Spinner size={20} />
        )}
        <div className="font-heading text-lg leading-[1.3] font-medium">{finished ? t.sprDone.replace('{n}', String(paid.length)) : t.sprDistributing}</div>
      </div>
      <div className={cx('grid gap-2.5', s.projectCount > 1 ? 'grid-cols-2' : 'grid-cols-1')}>
        {Array.from({ length: s.projectCount - hidden }, (_, i) => {
          const p = i < shown ? paid[i] : undefined
          // Slots that will never fill (draw ended short) stay face down, dimmed.
          const empty = s.status === 'done' && i >= paid.length
          return (
            <div key={i} className={cx('np-flip np-deal h-[96px]', p && 'is-open', empty && 'opacity-40')} style={{ animationDelay: `${i * 60}ms` }}>
              <div className="np-flip-inner">
                <div className="np-flip-face grid place-items-center rounded-md border border-dashed border-accent-400 bg-[color-mix(in_srgb,var(--color-accent-100)_45%,transparent)] text-accent-700">
                  {empty ? <span className="text-xl">–</span> : <span className={cx('font-heading text-[30px] leading-none', i === shown && !finished && 'animate-np-pulse')}>?</span>}
                </div>
                {p && (
                  <Link to={`/p/${p.slug}`} onClick={onClose} className="np-flip-face np-flip-front flex flex-col justify-between rounded-md border border-accent bg-surface p-3 text-fg no-underline hover:text-fg">
                    <span className="line-clamp-2 text-sm leading-[1.35] font-medium">{p.title}</span>
                    <span className="tnum flex items-center gap-1 text-[13px] text-accent-700">
                      <Icon name="zap" size={13} />
                      {fmt(p.amountSats)} sats
                    </span>
                  </Link>
                )}
              </div>
            </div>
          )
        })}
      </div>
      {s.projectCount > VISIBLE_CARDS && (
        <Button variant="ghost" icon={expanded ? undefined : 'chevD'} className="self-center" onClick={() => setExpanded((v) => !v)}>
          {expanded ? t.sprLess : t.sprMore.replace('{n}', String(hidden))}
        </Button>
      )}
      {finished && paid.length < s.projectCount && <Notice>{t.sprShort}</Notice>}
      {finished && (
        <div className="flex gap-2">
          {onAgain && (
            <Button variant="secondary" icon="gift" className="h-11 flex-1" onClick={onAgain}>
              {t.sprAgain}
            </Button>
          )}
          <Button variant="primary" className="h-11 flex-1" onClick={onClose}>
            {t.close}
          </Button>
        </div>
      )}
    </div>
  )
}
