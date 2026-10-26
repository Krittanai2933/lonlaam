import type { MonthlyConfigResponse, MonthlyCycle, MonthlyPlan, PutMonthlyRequest, Sprinkle } from '@nampu/types'
import { LIMITS, MONTHLY, monthlyDistributable, SPRINKLE } from '@nampu/types'
import { Brand, Button, Chip, CopyButton, cx, Dialog, Field, Icon, Input, Notice, Pulse, QRCode, Spinner, Switch, Tag, type TagTone } from '@nampu/ui'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { clock } from '../components/contribute/useContribute'
import { PublicNav } from '../components/PublicChrome'
import { Reveal, Sheet } from '../components/Sprinkle'
import { api, ApiError, errorText } from '../lib/api'
import { fmt, fmtDate } from '../lib/format'
import { useIsDesktop } from '../lib/hooks'
import { useI18n } from '../lib/i18n'

const PRESETS = [1000, 2100, 5000, 10_000, 21_000]
const TIPS = [0, 2, 5, 10]
const monthlyKey = ['monthly'] as const

const STATUS_TONE: Record<MonthlyCycle['status'], TagTone> = { charging: 'accent', needs_payment: 'danger', paid: 'success', missed: 'neutral' }

/**
 * Monthly sprinkle (added — no design): the supporter's plan, its months, and paying a month
 * by hand when the automatic payment from their wallet didn't go through. Same visual language
 * as the Sprinkle modal; logged-in only, but no creator onboarding.
 */
export default function MonthlyPage() {
  const desktop = useIsDesktop()
  const { t } = useI18n()
  const navigate = useNavigate()
  const config = useQuery({ queryKey: ['monthly-config'], queryFn: api.monthlyConfig, staleTime: 60_000 })
  // Poll while a month is being paid from the wallet.
  const monthly = useQuery({
    queryKey: monthlyKey,
    queryFn: api.monthly,
    refetchInterval: (q) => (q.state.data?.cycles.some((c) => c.status === 'charging') ? 3000 : false),
  })
  const [params, setParams] = useSearchParams()
  const emailFlash = params.get('email')
  const [open, setOpen] = useState<MonthlyCycle | null>(null)

  const plan = monthly.data?.plan ?? null
  const cycles = monthly.data?.cycles ?? []
  let content: ReactNode
  if (config.isPending || monthly.isPending) content = <Spinner size={20} />
  else if (monthly.isError) content = <Notice tone="danger">{errorText(monthly.error, t)}</Notice>
  else if (!config.data?.enabled) content = <Notice>{t.moUnavailable}</Notice>
  else
    content = (
      <>
        {plan && <Status plan={plan} cycles={cycles} onOpen={setOpen} />}
        <PlanForm key={plan?.createdAt ?? 'new'} plan={plan} config={config.data} />
        {plan && cycles.length > 0 && <History cycles={cycles} onOpen={setOpen} />}
        {plan && <Cancel />}
      </>
    )

  return (
    <div className="min-h-screen bg-bg">
      {desktop ? (
        <PublicNav />
      ) : (
        <div className="flex items-center justify-between px-3 pt-1">
          <Button variant="ghost" plain iconOnly icon="chevL" aria-label={t.back} onClick={() => navigate('/')} />
          <Link to="/" className="nav-brand">
            <Brand />
          </Link>
          <span className="w-10" />
        </div>
      )}
      <main className="mx-auto flex w-full max-w-[600px] flex-col gap-6 px-4 pt-6 pb-16 lg:pt-10">
        <header className="flex flex-col gap-1.5">
          <h1 className="m-0 flex items-center gap-2 text-[26px] font-medium lg:text-[32px]">
            <Icon name="refresh" size={24} className="text-accent-700" />
            {t.moTitle}
          </h1>
          <p className="m-0 text-neutral-700">{t.moBody}</p>
        </header>
        {emailFlash && (
          <Notice tone={emailFlash === 'verified' ? 'accent' : 'danger'} icon={emailFlash === 'verified' ? 'check' : 'alert'}>
            <span className="flex items-center justify-between gap-2">
              {emailFlash === 'verified' ? t.moEmailJustVerified : t.moEmailInvalid}
              <Button variant="ghost" plain iconOnly icon="x" aria-label={t.close} onClick={() => setParams({}, { replace: true })} />
            </span>
          </Notice>
        )}
        {content}
      </main>
      {open && <MonthDialog cycle={open} desktop={desktop} onClose={() => setOpen(null)} />}
    </div>
  )
}

// ─── Plan status ──────────────────────────────────────────────────────────────

function Status({ plan, cycles, onOpen }: { plan: MonthlyPlan; cycles: MonthlyCycle[]; onOpen: (c: MonthlyCycle) => void }) {
  const { t, f, lang } = useI18n()
  const qc = useQueryClient()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const active = plan.status === 'active'
  const charging = cycles.some((c) => c.status === 'charging')

  const toggle = async () => {
    setBusy(true)
    setError(null)
    try {
      qc.setQueryData(monthlyKey, await api.putMonthly({ amountSats: plan.amountSats, projectsMin: plan.projectsMin, projectsMax: plan.projectsMax, status: active ? 'paused' : 'active' }))
    } catch (e) {
      setError(errorText(e, t))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="flex flex-col gap-3 rounded-md border border-accent-300 bg-[color-mix(in_srgb,var(--color-accent-100)_40%,transparent)] p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="tnum text-[24px] leading-[1.2] font-medium">
            {fmt(plan.amountSats)} <span className="text-sm font-normal text-neutral-600">{`sats ${t.moPerMonth}`}</span>
          </div>
          <div className="text-sm text-neutral-700">{active ? f(t.moNext, { date: fmtDate(plan.nextChargeAt, lang) }) : t.moPaused}</div>
        </div>
        <Tag tone={active ? 'success' : 'neutral'}>{active ? t.moActive : t.moPaused}</Tag>
      </div>
      {charging && (
        <div className="flex items-center gap-2 text-sm" role="status">
          <Spinner size={14} />
          {t.moStatus.charging}…
        </div>
      )}
      {cycles
        .filter((c) => c.status === 'needs_payment')
        .map((c) => (
          <Notice key={c.id} tone="danger">
            <span className="flex flex-col gap-2">
              {f(t.moNeedsPay, { date: fmtDate(c.dueAt, lang), reason: c.reason ? t.moReason[c.reason] : '', days: MONTHLY.payWithinDays })}
              <Button variant="cta" icon="zap" className="h-10 self-start" onClick={() => onOpen(c)}>
                {t.moPayNow} · {fmt(c.amountSats)} sats
              </Button>
            </span>
          </Notice>
        ))}
      {error && <Notice tone="danger">{error}</Notice>}
      <Button variant="secondary" className="h-10 self-start" loading={busy} onClick={() => void toggle()}>
        {active ? t.moPause : t.moResume}
      </Button>
    </section>
  )
}

// ─── Plan form ────────────────────────────────────────────────────────────────

function PlanForm({ plan, config }: { plan: MonthlyPlan | null; config: MonthlyConfigResponse }) {
  const { t, f } = useI18n()
  const qc = useQueryClient()
  const [amount, setAmount] = useState(plan?.amountSats ?? 2100)
  const [min, setMin] = useState(plan?.projectsMin ?? 1)
  const [max, setMax] = useState(plan?.projectsMax ?? 3)
  // On by default, as for one-off sprinkles: sats go to projects that still need them first.
  const [excludeFunded, setExcludeFunded] = useState(plan?.excludeFunded ?? true)
  const [tip, setTip] = useState(plan?.tipPercent ?? 0)
  const [name, setName] = useState(plan?.supporterName ?? '')
  const [message, setMessage] = useState(plan?.comment ?? '')
  const [wallet, setWallet] = useState<'keep' | 'edit' | 'remove'>(plan?.wallet ? 'keep' : 'edit')
  const [nwc, setNwc] = useState('')
  const [email, setEmail] = useState(plan?.email ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const dist = monthlyDistributable(amount, tip)
  const tipSats = Math.floor((amount * tip) / 100)
  const amountOk = amount >= MONTHLY.amountSats.min && amount <= MONTHLY.amountSats.max
  const tooSmall = amountOk && dist < min * SPRINKLE.minSatsPerProject
  const emailValue = email.trim().toLowerCase()
  const emailChanged = emailValue !== (plan?.email ?? '')
  const range = min === max ? String(min) : `${min}–${max}`

  const save = async (resendEmail = false) => {
    setBusy(true)
    setError(null)
    setSaved(false)
    try {
      const body: PutMonthlyRequest = {
        amountSats: amount,
        projectsMin: min,
        projectsMax: max,
        excludeFunded,
        tipPercent: tip,
        supporterName: name.trim() || null,
        comment: message.trim() || null,
      }
      if (config.autoPay && wallet === 'edit' && nwc.trim()) body.nwcUrl = nwc.trim()
      if (wallet === 'remove') body.nwcUrl = null
      if (emailChanged || resendEmail) body.email = emailValue || null
      const res = await api.putMonthly(body)
      qc.setQueryData(monthlyKey, res)
      setNwc('')
      setWallet(res.plan?.wallet ? 'keep' : 'edit')
      setSaved(true)
    } catch (e) {
      setError(e instanceof ApiError ? errorText(e, t) : t.somethingWrong)
    } finally {
      setBusy(false)
    }
  }

  const setRange = (lo: number, hi: number) => {
    setMin(lo)
    setMax(hi)
  }

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault()
        void save()
      }}
    >
      <Field label={t.moAmount}>
        {(id) => (
          <div className="flex items-baseline gap-2 border-b border-accent pb-1">
            <input
              id={id}
              inputMode="numeric"
              className="tnum w-full min-w-0 bg-transparent text-[32px] leading-[1.1] font-medium outline-none"
              value={amount ? fmt(amount) : ''}
              onChange={(e) => setAmount(Number(e.target.value.replace(/\D/g, '').slice(0, 6)) || 0)}
            />
            <span className="whitespace-nowrap text-neutral-600">{`sats ${t.moPerMonth}`}</span>
          </div>
        )}
      </Field>
      <div className="-mt-1 flex flex-wrap gap-2">
        {PRESETS.map((v) => (
          <Chip key={v} selected={amount === v} aria-pressed={amount === v} className="tnum h-9 py-0" onClick={() => setAmount(v)}>
            {fmt(v)}
          </Chip>
        ))}
      </div>

      <div>
        <div className="mb-1.5 text-[13px] text-neutral-700">{t.moProjects}</div>
        <div className="flex gap-3">
          <Stepper label={t.moFrom} value={min} onChange={(v) => setRange(v, Math.max(v, max))} />
          <Stepper label={t.moTo} value={max} onChange={(v) => setRange(Math.min(min, v), v)} />
        </div>
      </div>
      <Switch className="-my-1" icon="target" label={t.sprExcludeFunded} checked={excludeFunded} onChange={setExcludeFunded} />

      <div>
        <div className="mb-1.5 text-[13px] text-neutral-700">{t.moTip}</div>
        <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={t.moTip}>
          {TIPS.map((p) => (
            <Chip key={p} role="radio" aria-checked={tip === p} selected={tip === p} className="tnum h-9 py-0" onClick={() => setTip(p)}>
              {p === 0 ? t.moTipNone : `${p}%`}
            </Chip>
          ))}
        </div>
      </div>

      <div className="tnum text-sm text-neutral-700">
        {!amountOk ? (
          `${fmt(MONTHLY.amountSats.min)}–${fmt(MONTHLY.amountSats.max)} sats`
        ) : tooSmall ? (
          <span className="text-danger">{t.sprTooSmall.replace('{min}', String(SPRINKLE.minSatsPerProject))}</span>
        ) : (
          f(tip ? t.moBreakdown : t.moBreakdownNoTip, { dist: fmt(dist), range, tip: fmt(tipSats), fee: fmt(amount - dist - tipSats) })
        )}
      </div>

      <Input className="min-h-11" aria-label={t.namePh} placeholder={t.namePh} maxLength={LIMITS.supporterName.max} value={name} onChange={(e) => setName(e.target.value)} />
      <Input className="min-h-11" aria-label={t.msgPh} placeholder={t.msgPh} maxLength={LIMITS.comment.max} value={message} onChange={(e) => setMessage(e.target.value)} />

      <WalletField config={config} plan={plan} mode={wallet} setMode={setWallet} value={nwc} onChange={setNwc} budget={Math.ceil(amount * 1.02)} />

      {(config.email || plan?.email) && (
        <Field label={t.moEmail} hint={t.moEmailHelp}>
          {(id) => (
            <div className="flex flex-col gap-1.5">
              <Input id={id} type="email" autoComplete="email" className="min-h-11" maxLength={MONTHLY.email.max} value={email} onChange={(e) => setEmail(e.target.value)} />
              {plan?.email && !emailChanged && (
                <div className="flex items-center gap-2 text-[13px] text-neutral-700">
                  {plan.emailVerified ? (
                    <Tag tone="success" icon="check">
                      {t.moEmailVerified}
                    </Tag>
                  ) : (
                    <>
                      <span>{f(t.moEmailPending, { email: plan.email })}</span>
                      <Button variant="ghost" plain className="h-auto p-0 text-[13px]" disabled={busy} onClick={() => void save(true)}>
                        {t.moEmailResend}
                      </Button>
                    </>
                  )}
                </div>
              )}
            </div>
          )}
        </Field>
      )}

      {error && <Notice tone="danger">{error}</Notice>}
      <Button type="submit" variant="cta" icon={plan ? 'check' : 'refresh'} className="h-12 text-base" loading={busy} disabled={!amountOk || tooSmall || busy}>
        {plan ? t.moSave : t.moStart}
      </Button>
      {saved && (
        <div className="-mt-2 text-center text-sm text-success" role="status">
          {t.moSaved}
        </div>
      )}
      <p className="m-0 text-xs text-neutral-600">
        {!plan && `${f(t.moStartNote, { day: new Date().getUTCDate() })} `}
        {t.sprCustodial.replace('{fee}', String(SPRINKLE.feeReservePercent))}
      </p>
    </form>
  )
}

function Stepper({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  const lo = SPRINKLE.projects.min
  const hi = SPRINKLE.projects.max
  const btn = 'grid h-full w-11 cursor-pointer place-items-center bg-transparent text-lg text-fg disabled:cursor-default disabled:opacity-35'
  return (
    <div className="flex flex-1 flex-col gap-1">
      <div className="text-xs text-neutral-600">{label}</div>
      <div className="flex h-11 items-center rounded-md border border-divider" role="group" aria-label={label}>
        <button type="button" className={btn} aria-label={`${label} −1`} disabled={value <= lo} onClick={() => onChange(value - 1)}>
          −
        </button>
        <span className="tnum flex-1 text-center font-medium" aria-live="polite">
          {value}
        </span>
        <button type="button" className={btn} aria-label={`${label} +1`} disabled={value >= hi} onClick={() => onChange(value + 1)}>
          +
        </button>
      </div>
    </div>
  )
}

function WalletField({
  config,
  plan,
  mode,
  setMode,
  value,
  onChange,
  budget,
}: {
  config: MonthlyConfigResponse
  plan: MonthlyPlan | null
  mode: 'keep' | 'edit' | 'remove'
  setMode: (m: 'keep' | 'edit' | 'remove') => void
  value: string
  onChange: (v: string) => void
  budget: number
}) {
  const { t, f } = useI18n()
  if (!config.autoPay && !plan?.wallet) return <Notice>{t.moAutoOff}</Notice>
  if (mode === 'keep' && plan?.wallet) {
    return (
      <div className="flex flex-wrap items-center gap-2 rounded-md border border-divider px-3 py-2.5">
        <Icon name="wallet" className="text-accent-700" />
        {/* Too narrow for both: the buttons wrap below rather than breaking the label. */}
        <span className="min-w-0 flex-1 basis-48 text-sm [overflow-wrap:anywhere]">{f(t.moWalletConnected, { wallet: plan.wallet })}</span>
        {config.autoPay && (
          <Button variant="ghost" className="h-9" onClick={() => setMode('edit')}>
            {t.moWalletChange}
          </Button>
        )}
        <Button variant="ghost" className="h-9 text-danger" onClick={() => setMode('remove')}>
          {t.moWalletRemove}
        </Button>
      </div>
    )
  }
  if (mode === 'remove') {
    return (
      <Notice>
        <span className="flex flex-wrap items-center justify-between gap-2">
          {t.moWalletRemoved}
          <Button variant="ghost" plain className="h-auto p-0" onClick={() => setMode('keep')}>
            {t.cancelKeep}
          </Button>
        </span>
      </Notice>
    )
  }
  return (
    <Field label={t.moWallet} hint={`${f(t.moWalletHelp, { budget: fmt(budget) })}${plan?.wallet ? '' : ` ${t.moWalletNone}`}`}>
      {(id) => (
        <div className="flex gap-2">
          <Input
              id={id}
              className="min-h-11 font-mono text-[13px]"
              placeholder="nostr+walletconnect://…"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              value={value}
              onChange={(e) => onChange(e.target.value)}
            />
          {plan?.wallet && (
            <Button variant="ghost" className="h-11 shrink-0" onClick={() => setMode('keep')}>
              {t.cancelKeep}
            </Button>
          )}
        </div>
      )}
    </Field>
  )
}

// ─── History ──────────────────────────────────────────────────────────────────

function History({ cycles, onOpen }: { cycles: MonthlyCycle[]; onOpen: (c: MonthlyCycle) => void }) {
  const { t, lang } = useI18n()
  return (
    <section>
      <h2 className="mb-2 text-[20px] font-medium">{t.moHistory}</h2>
      <ul className="m-0 list-none border-t border-divider p-0">
        {cycles.map((c) => (
          <li key={c.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-divider py-3">
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">{fmtDate(c.dueAt, lang)}</div>
              {c.reason && c.status !== 'paid' && <div className="text-xs text-neutral-600">{t.moReason[c.reason]}</div>}
            </div>
            <span className="tnum text-sm">{fmt(c.amountSats)} sats</span>
            <Tag tone={STATUS_TONE[c.status]}>{t.moStatus[c.status]}</Tag>
            {c.status === 'paid' && c.sprinkleId && (
              <Button variant="ghost" className="h-9" onClick={() => onOpen(c)}>
                {t.moSeeDraw}
              </Button>
            )}
            {c.status === 'needs_payment' && (
              <Button variant="cta" className="h-9" onClick={() => onOpen(c)}>
                {t.moPayNow}
              </Button>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}

function Cancel() {
  const { t } = useI18n()
  const qc = useQueryClient()
  const [busy, setBusy] = useState(false)
  return (
    <Button
      variant="ghost"
      className="self-start text-danger"
      loading={busy}
      onClick={async () => {
        if (!window.confirm(t.moCancelConfirm)) return
        setBusy(true)
        try {
          await api.deleteMonthly()
          qc.setQueryData(monthlyKey, { plan: null, cycles: [] })
        } finally {
          setBusy(false)
        }
      }}
    >
      {t.moCancel}
    </Button>
  )
}

// ─── Paying a month / seeing where it went ─────────────────────────────────────

function MonthDialog({ cycle, desktop, onClose }: { cycle: MonthlyCycle; desktop: boolean; onClose: () => void }) {
  const { t } = useI18n()
  const qc = useQueryClient()
  const [s, setS] = useState<Sprinkle | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [now, setNow] = useState(Date.now)

  // A month waiting for payment gets (or reuses) an invoice; a paid one shows its sprinkle.
  const load = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      setS(cycle.status === 'needs_payment' ? await api.payMonthlyCycle(cycle.id) : await api.sprinkle(cycle.sprinkleId!))
      setNow(Date.now())
    } catch (e) {
      setError(errorText(e, t))
    } finally {
      setBusy(false)
    }
  }, [cycle, t])
  useEffect(() => {
    void load()
  }, [load])

  const liveId = s && (s.status === 'pending' || s.status === 'distributing') ? s.id : null
  useEffect(() => {
    if (!liveId) return
    let cancelled = false
    const tick = setInterval(() => setNow(Date.now()), 1000)
    const poll = setInterval(async () => {
      try {
        const next = await api.sprinkle(liveId)
        if (!cancelled) setS(next)
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

  const close = () => {
    void qc.invalidateQueries({ queryKey: monthlyKey })
    onClose()
  }
  const body = (
    <div className={cx('flex flex-col gap-4', desktop && 'p-7')}>
      <div className="flex items-center gap-2.5">
        <Icon name="gift" size={22} className="text-accent-700" />
        <div className="dialog-title m-0 flex-1 text-[22px]">{t.moTitle}</div>
        <Button variant="ghost" plain iconOnly icon="x" aria-label={t.close} className="-mr-2" onClick={close} />
      </div>
      {error ? (
        <Notice tone="danger">{error}</Notice>
      ) : !s ? (
        <div className="grid min-h-40 place-items-center">
          <Spinner size={20} />
        </div>
      ) : s.status === 'pending' || s.status === 'expired' ? (
        <PayInvoice s={s} now={now} desktop={desktop} busy={busy} onRenew={() => void load()} />
      ) : (
        <Reveal s={s} onClose={close} />
      )}
    </div>
  )
  return desktop ? (
    <Dialog open bare onClose={close} className="w-[460px] max-w-full">
      {body}
    </Dialog>
  ) : (
    <Sheet onClose={close}>{body}</Sheet>
  )
}

function PayInvoice({ s, now, desktop, busy, onRenew }: { s: Sprinkle; now: number; desktop: boolean; busy: boolean; onRenew: () => void }) {
  const { t } = useI18n()
  const secsLeft = Math.max(0, Math.round((s.expiresAt - now) / 1000))
  const expired = s.status === 'expired' || secsLeft === 0
  return (
    <div className="flex flex-col items-center gap-3">
      <div className="tnum text-[26px] leading-[1.1] font-medium">
        {fmt(s.amountSats)} <span className="text-sm font-normal text-neutral-600">sats</span>
      </div>
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
          <Button variant="cta" icon="refresh" className="h-12 w-full text-base" loading={busy} onClick={onRenew}>
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
    </div>
  )
}
