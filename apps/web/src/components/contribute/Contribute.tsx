import type { PublicProject } from '@nampu/types'
import { LIMITS } from '@nampu/types'
import { Button, cx, Dialog, Icon, Input, Notice, Pulse, QRCode, Spinner, Switch } from '@nampu/ui'
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { ApiError, errorText } from '../../lib/api'
import { fmt, fmtDate } from '../../lib/format'
import { useI18n } from '../../lib/i18n'
import { fetchProfile, hasNip07, profileName, shortNpub, signSupporterProof } from '../../lib/nostr'
import { ShareButtons } from '../share'
import { clock, PRESETS, useContribute, type Contribute } from './useContribute'

/**
 * Entry point: bottom sheet on mobile (3a + Invoice Sheet), two-column modal on desktop (3c).
 * Closing while an invoice is live asks first (Foundations: Modal "ยกเลิกการสนับสนุน?").
 */
export function ContributeFlow({
  project,
  open,
  onClose,
  desktop,
  rewardId,
}: {
  project: PublicProject
  open: boolean
  onClose: () => void
  desktop: boolean
  /** Opened from a reward card: preselect it. */
  rewardId?: string | null
}) {
  const c = useContribute(project)
  const [confirm, setConfirm] = useState(false)
  const { pickReward } = c
  // On opening only: pickReward changes with every live count update, which must not undo the
  // supporter's own pick.
  useEffect(() => {
    if (open && rewardId) pickReward(rewardId)
  }, [open, rewardId])
  const { t } = useI18n()
  const close = () => (c.hasLiveInvoice ? setConfirm(true) : done())
  const done = () => {
    setConfirm(false)
    c.leave()
    onClose()
  }
  if (!open) return null
  return (
    <>
      {desktop ? <DesktopModal project={project} c={c} onClose={close} /> : <MobileSheet project={project} c={c} onClose={close} />}
      <Dialog
        open={confirm}
        onClose={() => setConfirm(false)}
        title={t.cancelTitle}
        actions={
          <>
            <Button variant="secondary" onClick={() => setConfirm(false)}>
              {t.cancelKeep}
            </Button>
            <Button variant="primary" onClick={done}>
              {t.cancelConfirm}
            </Button>
          </>
        }
      >
        <div className="dialog-body">{t.cancelBody}</div>
      </Dialog>
    </>
  )
}

// ─── Mobile: bottom sheet ─────────────────────────────────────────────────────

function MobileSheet({ project, c, onClose }: { project: PublicProject; c: Contribute; onClose: () => void }) {
  const { t } = useI18n()
  const canBack = c.state === 'invoice' || c.state === 'expired' || c.state === 'error'
  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [])
  return (
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-[color-mix(in_srgb,var(--color-neutral-900)_55%,transparent)]" onClick={onClose} />
      <div role="dialog" aria-modal="true" aria-label={t.contribute} className="absolute inset-x-0 bottom-0 flex max-h-[92dvh] flex-col gap-3.5 overflow-y-auto rounded-t-[14px] bg-surface px-5 pt-2.5 pb-6 shadow-lg">
        <div className="mx-auto h-1 w-9 flex-none rounded-[2px] bg-neutral-400" />
        <div className="flex items-center gap-2.5">
          {canBack && <Button variant="ghost" plain iconOnly icon="chevL" aria-label={t.changeAmount} className="-ml-2" onClick={c.reset} />}
          <div className="min-w-0 flex-1">
            <div className="text-xs text-neutral-600">{t.supporting}</div>
            <div className="truncate font-heading text-lg leading-[1.3] font-semibold">{project.title}</div>
          </div>
          <Button variant="ghost" plain iconOnly icon="x" aria-label={t.close} onClick={onClose} />
        </div>
        {c.state === 'amount' && <AmountForm c={c} />}
        {c.state === 'loading' && <Loading />}
        {(c.state === 'invoice' || c.state === 'expired') && <PayPanel c={c} qrSize={236} />}
        {c.state === 'error' && <ErrorPanel c={c} />}
        {c.state === 'success' && <SuccessPanel project={project} c={c} onBack={onClose} />}
      </div>
    </div>
  )
}

// ─── Desktop: two-column modal ────────────────────────────────────────────────

function DesktopModal({ project, c, onClose }: { project: PublicProject; c: Contribute; onClose: () => void }) {
  const { t } = useI18n()
  const editing = c.state === 'amount' || c.state === 'loading'
  return (
    <Dialog open bare onClose={onClose} className="max-h-full w-[780px] max-w-full flex-row overflow-hidden">
      <div className="flex w-1/2 flex-col gap-3.5 overflow-y-auto border-r border-divider p-7">
        <div className="text-xs text-neutral-600">{t.supporting}</div>
        <div className="dialog-title -mt-2.5 text-[24px]">{project.title}</div>
        {editing ? (
          <AmountForm c={c} desktop />
        ) : (
          <>
            <div className="flex items-baseline gap-1.5 border-b border-accent pb-1.5">
              <span className="tnum text-[36px] font-medium">{fmt(c.amount)}</span>
              <span className="text-neutral-600">sats</span>
              {c.state !== 'success' && (
                <Button variant="ghost" icon="edit" className="ml-auto" onClick={c.reset}>
                  {t.edit}
                </Button>
              )}
            </div>
            {c.anon ? (
              <div className="flex items-center gap-2 text-[13px] text-neutral-700">
                <Icon name="eyeOff" />
                {t.anonToggle}
              </div>
            ) : (
              c.name.trim() && <div className="text-[13px] text-neutral-700">{`${t.shownAs}: ${c.name.trim()}`}</div>
            )}
            {c.reward && (
              <div className="flex items-center gap-2 text-[13px] text-neutral-700">
                <Icon name="gift" />
                {c.reward.title}
              </div>
            )}
            {c.message.trim() && <div className="border-l border-divider pl-3 text-sm text-neutral-700 italic">“{c.message.trim()}”</div>}
          </>
        )}
        <p className="m-0 mt-auto text-xs text-neutral-600">{t.nonCustodial}</p>
      </div>
      <div className="relative flex w-1/2 flex-col items-center gap-3 p-7">
        <Button variant="ghost" plain iconOnly icon="x" aria-label={t.close} onClick={onClose} className="absolute top-2.5 right-2.5" />
        {c.state === 'amount' && (
          <>
            <div className="grid size-[240px] place-items-center rounded-[6px] border border-dashed border-neutral-400 text-neutral-500">
              <Icon name="qr" size={40} />
            </div>
            <p className="m-0 max-w-[260px] text-center text-[13px] text-neutral-600">{t.scanToPay}</p>
          </>
        )}
        {c.state === 'loading' && <Loading />}
        {(c.state === 'invoice' || c.state === 'expired') && <PayPanel c={c} qrSize={240} desktop />}
        {c.state === 'error' && <ErrorPanel c={c} />}
        {c.state === 'success' && <SuccessPanel project={project} c={c} onBack={onClose} />}
      </div>
    </Dialog>
  )
}

// ─── Panels ───────────────────────────────────────────────────────────────────

function AmountForm({ c, desktop }: { c: Contribute; desktop?: boolean }) {
  const { t } = useI18n()
  const [custom, setCustom] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const [nostrBusy, setNostrBusy] = useState(false)

  const useNostrName = async () => {
    if (!window.nostr) return
    setNostrBusy(true)
    try {
      const pk = await window.nostr.getPublicKey()
      const [p, proof] = await Promise.all([fetchProfile(pk), signSupporterProof(c.slug).catch(() => null)])
      const n = profileName(p) || (await shortNpub(pk))
      c.setNostrName(n.slice(0, LIMITS.supporterName.max), proof)
    } catch {
      // user declined
    } finally {
      setNostrBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-3.5">
      <div className={cx('flex items-baseline justify-center gap-2 border-b border-accent pt-2.5 pb-1', desktop && 'justify-start')}>
        {custom ? (
          <input
            ref={inputRef}
            autoFocus
            inputMode="numeric"
            aria-label={t.customAmount}
            className="tnum w-full min-w-0 bg-transparent text-center text-[40px] leading-[1.1] font-medium outline-none"
            value={c.amount ? fmt(c.amount) : ''}
            onChange={(e) => c.setAmount(Number(e.target.value.replace(/\D/g, '').slice(0, 9)) || 0)}
            onBlur={() => setCustom(false)}
          />
        ) : (
          <button type="button" className="tnum cursor-text bg-transparent text-[40px] leading-[1.1] font-medium" aria-label={t.customAmount} onClick={() => setCustom(true)}>
            {fmt(c.amount)}
          </button>
        )}
        <span className="text-neutral-600">sats</span>
      </div>
      <div className="grid grid-cols-3 gap-2">
        {PRESETS.map((v, i) => {
          const on = c.amount === v
          return (
            <button
              key={v}
              type="button"
              aria-pressed={on}
              onClick={() => c.setAmount(v)}
              className="tnum flex h-[52px] cursor-pointer flex-col items-center justify-center rounded-md border leading-[1.2]"
              style={{ background: on ? 'var(--color-accent-100)' : 'transparent', borderColor: on ? 'var(--color-accent)' : 'var(--color-divider)', color: on ? 'var(--color-accent-800)' : 'var(--color-text)' }}
            >
              <span className="text-[15px] font-medium">{fmt(v)}</span>
              {t.presetNotes[i] && <span className="text-[11px] text-neutral-600">{t.presetNotes[i]}</span>}
            </button>
          )
        })}
      </div>
      {c.amountError && <Notice tone="danger">{c.amountError === 'reward_unavailable' ? t.rewardUnavailable : c.amountError}</Notice>}
      {c.rewards.length > 0 && <RewardPicker c={c} />}
      <Switch className="border-t border-divider" icon="eyeOff" label={t.anonToggle} checked={c.anon} onChange={c.setAnon} />
      {!c.anon && (
        <div className="relative">
          <Input className="min-h-11" aria-label={t.namePh} placeholder={t.namePh} maxLength={LIMITS.supporterName.max} value={c.name} onChange={(e) => c.setName(e.target.value)} />
          {hasNip07() && !c.name && (
            <Button variant="ghost" className="absolute top-1/2 right-1 -translate-y-1/2 text-[13px]" loading={nostrBusy} onClick={useNostrName}>
              {t.fromNostr}
            </Button>
          )}
        </div>
      )}
      <Input className="min-h-11" aria-label={t.msgPh} placeholder={t.msgPh} maxLength={LIMITS.comment.max} value={c.message} onChange={(e) => c.setMessage(e.target.value)} />
      <Button variant="cta" icon="zap" className="h-12 text-base" disabled={!c.canCreate || c.state === 'loading'} onClick={() => void c.create()}>
        {t.createInvoice}
      </Button>
    </div>
  )
}

function RewardPicker({ c }: { c: Contribute }) {
  const { t, f } = useI18n()
  const name = useId()
  const option = (id: string | null, title: string, sub: ReactNode, disabled = false) => {
    const on = (c.reward?.id ?? null) === id
    return (
      <label
        key={id ?? ''}
        className={cx('flex cursor-pointer items-start gap-2.5 rounded-md border px-3 py-2.5', disabled && 'cursor-not-allowed opacity-45')}
        style={{ borderColor: on ? 'var(--color-accent)' : 'var(--color-divider)', background: on ? 'var(--color-accent-100)' : 'transparent' }}
      >
        <input type="radio" name={name} className="mt-1 accent-[var(--color-accent)]" checked={on} disabled={disabled} onChange={() => c.pickReward(id)} />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">{title}</span>
          {sub && <span className="tnum block text-xs text-neutral-600">{sub}</span>}
        </span>
      </label>
    )
  }
  return (
    <div role="radiogroup" aria-label={t.rewardPick} className="flex flex-col gap-2 border-t border-divider pt-3">
      <div className="text-[13px] text-neutral-700">{t.rewardPick}</div>
      {option(null, t.noReward, null)}
      {c.rewards.map((r) => {
        const left = r.limit === null ? null : Math.max(0, r.limit - r.claimed)
        const sub = [f(t.rewardFrom, { sats: fmt(r.minSats) }), left === null ? null : left === 0 ? t.soldOut : f(t.rewardLeft, { n: fmt(left) })]
        return option(r.id, r.title, sub.filter(Boolean).join(' · '), left === 0 && c.reward?.id !== r.id)
      })}
      {c.reward && (
        <>
          {c.amount < c.reward.minSats && <div className="text-xs text-danger">{f(t.rewardNeedsMore, { sats: fmt(c.reward.minSats) })}</div>}
          <Input
            className="min-h-11"
            aria-label={t.contactPh}
            placeholder={t.contactPh}
            maxLength={LIMITS.rewards.contact.max}
            value={c.contact}
            onChange={(e) => c.setContact(e.target.value)}
          />
          <div className="-mt-1 text-xs text-neutral-600">{t.contactNote}</div>
        </>
      )}
    </div>
  )
}

function Loading() {
  const { t } = useI18n()
  return (
    <div className="flex w-full flex-col items-center gap-3.5 pt-1.5 pb-2.5" aria-busy="true">
      <div className="grid size-[220px] place-items-center rounded-[6px] bg-neutral-200 text-accent">
        <Spinner size={28} />
      </div>
      <div className="text-[15px]">{t.creating}</div>
      <div className="h-2.5 w-[70%] rounded-[2px] bg-neutral-200" />
      <div className="h-12 w-full rounded-md border border-divider opacity-50" />
    </div>
  )
}

function PayPanel({ c, qrSize, desktop }: { c: Contribute; qrSize: number; desktop?: boolean }) {
  const { t } = useI18n()
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const x = setTimeout(() => setCopied(false), 1800)
    return () => clearTimeout(x)
  }, [copied])
  if (!c.invoice) return null
  const expired = c.state === 'expired'
  const bolt11 = c.invoice.bolt11
  const copy = async () => {
    await navigator.clipboard.writeText(bolt11)
    setCopied(true)
  }
  return (
    <div className="relative flex w-full flex-col items-center gap-3">
      {!desktop && (
        <div className="tnum text-[26px] leading-[1.1] font-medium">
          {fmt(c.invoice.amountSats)} <span className="text-sm font-normal text-neutral-600">sats</span>
        </div>
      )}
      <QRCode
        value={bolt11}
        size={qrSize}
        logo
        dim={expired}
        label="Lightning invoice QR"
        overlay={expired && <span className="rounded-[3px] border border-[#d92f40] bg-white px-3 py-1.5 text-sm text-[#d92f40]">{t.expiredTag}</span>}
      />
      {expired ? (
        <div className="max-w-[300px] text-center text-sm text-neutral-700">{t.expiredBody}</div>
      ) : (
        <div className="flex items-center gap-2 text-sm" role="status">
          <Pulse />
          <span>{t.waiting}</span>
          <span className="tnum text-neutral-600">{`· ${t.expiresIn} ${clock(c.secsLeft)}`}</span>
        </div>
      )}
      <div className={cx('flex w-full items-center gap-2 rounded-md border border-divider py-1 pr-1 pl-3', expired && 'opacity-35')}>
        <code className="tnum flex-1 truncate text-xs text-neutral-700">{bolt11}</code>
        <Button variant={copied ? 'secondary' : 'primary'} icon={copied ? 'check' : 'copy'} className="h-9 min-w-[104px]" disabled={expired} onClick={() => void copy()}>
          {copied ? t.copied : t.copy}
        </Button>
      </div>
      {expired ? (
        <Button variant="cta" icon="refresh" className="h-12 w-full text-base" onClick={() => void c.create()}>
          {t.newInvoice}
        </Button>
      ) : desktop ? (
        <p className="m-0 text-center text-xs text-neutral-600">{t.scanDesk}</p>
      ) : (
        <a className="btn btn-cta h-12 w-full text-base" href={`lightning:${bolt11}`}>
          <Icon name="wallet" />
          {t.openLnWallet}
        </a>
      )}
      {copied && (
        <div className="absolute top-16 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-md bg-fg px-3.5 py-2 text-[13px] whitespace-nowrap text-bg shadow-md" role="status">
          <Icon name="check" />
          {t.copiedToast}
        </div>
      )}
    </div>
  )
}

function ErrorPanel({ c }: { c: Contribute }) {
  const { t } = useI18n()
  const code = c.error instanceof ApiError ? `${c.error.code} · ${c.error.status}` : 'network'
  return (
    <div className="flex w-full flex-col items-center gap-3 pt-3.5 pb-1 text-center">
      <div className="grid size-16 place-items-center rounded-full border border-danger text-danger">
        <Icon name="alert" size={32} style={{ strokeWidth: 1.3 }} />
      </div>
      <div className="font-heading text-[22px] font-semibold">{t.errTitle}</div>
      <p className="m-0 max-w-[300px] text-sm text-neutral-700">{c.error instanceof ApiError && c.error.code !== 'lnurl_error' && c.error.code !== 'lnurl_cannot_receive' ? errorText(c.error, t) : t.errBody}</p>
      <code className="text-[11px] text-neutral-600">{code}</code>
      <Button variant="cta" icon="refresh" className="h-12 w-full text-base" onClick={() => void c.create()}>
        {t.retry}
      </Button>
      <Button variant="ghost" onClick={c.reset}>
        {t.changeAmount}
      </Button>
    </div>
  )
}

function SuccessPanel({ project, c, onBack }: { project: PublicProject; c: Contribute; onBack: () => void }) {
  const { t, lang } = useI18n()
  const paidAt = c.invoice?.paidAt ?? Date.now()
  const time = `${fmtDate(paidAt, lang)} · ${new Date(paidAt).toLocaleTimeString(lang === 'th' ? 'th-TH' : 'en-GB', { hour: '2-digit', minute: '2-digit' })}`
  return (
    <div className="flex w-full flex-col items-center gap-2.5 pt-2.5 text-center" role="status">
      <div className="grid size-[72px] place-items-center rounded-full border-[1.5px] border-success text-success">
        <Icon name="check" size={32} style={{ strokeWidth: 1.3 }} />
      </div>
      <div className="font-heading text-[26px] font-medium">{t.thanks}</div>
      <div className="text-sm text-neutral-700">{t.creatorReceived}</div>
      <div className="tnum mt-1.5 w-full border-t border-divider text-left text-sm">
        <Row label={t.amountL} value={<span className="font-medium">{fmt(c.invoice?.amountSats ?? c.amount)} sats</span>} />
        <Row label={t.shownAs} value={c.anon || !c.name.trim() ? t.anonymous : c.name.trim()} />
        {c.reward && <Row label={t.reward} value={c.reward.title} />}
        <Row label={t.timeL} value={time} />
      </div>
      <ShareButtons project={project} className="mt-1.5 w-full" size="lg" />
      <Button variant="ghost" onClick={onBack}>
        {t.backToProject}
      </Button>
    </div>
  )
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between border-b border-divider py-[9px]">
      <span className="text-neutral-600">{label}</span>
      <span>{value}</span>
    </div>
  )
}
