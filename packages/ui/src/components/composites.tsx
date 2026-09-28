import type { ReactNode } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { encode } from 'uqr'
import { Icon } from './Icon'
import { Button, cx, hatch, Progress } from './primitives'

// ─── Project card ─────────────────────────────────────────────────────────────

export interface ProjectCardProps {
  title: string
  summary?: string
  kicker?: string | null
  coverUrl?: string | null
  raisedLabel: string
  goalLabel?: string | null
  progress: number
  /** Right side of the stats row, e.g. "18 วัน" or "68%". */
  meta?: ReactNode
  size?: 'sm' | 'md'
  className?: string
}

/** Bordered, unfilled card with a 16:10 cover (Foundations: Project card / 6b live preview). */
export function ProjectCard({ title, summary, kicker, coverUrl, raisedLabel, goalLabel, progress, meta, size = 'md', className }: ProjectCardProps) {
  const md = size === 'md'
  return (
    <article className={cx('card overflow-hidden p-0', className)}>
      {coverUrl ? (
        <img src={coverUrl} alt="" className="aspect-[16/10] w-full border-b border-divider object-cover" />
      ) : (
        <div className="aspect-[16/10] border-b border-divider" style={{ background: hatch }} />
      )}
      <div className={cx('flex flex-col', md ? 'gap-[7px] px-4 pt-3.5 pb-4' : 'gap-2 px-3.5 pt-3 pb-3.5')}>
        {kicker && <div className="card-kicker text-accent-700">{kicker}</div>}
        <div className="card-title" style={{ fontSize: md ? 20 : 17 }}>
          {title}
        </div>
        {summary && (
          <p className="card-body" style={{ fontSize: 14 }}>
            {summary}
          </p>
        )}
        <Progress value={progress} className="mt-1" />
        <div className="tnum flex justify-between text-[13px]">
          <span>
            <b className="font-semibold">{raisedLabel}</b>
            {goalLabel ? ` / ${goalLabel}` : ''} sats
          </span>
          {meta && <span className="text-neutral-600">{meta}</span>}
        </div>
      </div>
    </article>
  )
}

// ─── Bar chart ────────────────────────────────────────────────────────────────

/** Outlined bars on a baseline; the last bar is filled (dashboard 5a). */
export function BarChart({ values, height = 90, className, label }: { values: number[]; height?: number; className?: string; label?: string }) {
  const max = Math.max(1, ...values)
  return (
    <div role="img" aria-label={label} className={cx('flex items-end gap-1 border-b border-divider', className)} style={{ height }}>
      {values.map((v, i) => (
        <span
          key={i}
          className="flex-1 rounded-t-[1px] border border-b-0 border-accent"
          style={{
            height: `${Math.max(4, (v / max) * 100)}%`,
            background: i === values.length - 1 ? 'var(--color-accent)' : 'var(--color-accent-100)',
          }}
        />
      ))}
    </div>
  )
}

// ─── QR ───────────────────────────────────────────────────────────────────────

/**
 * Real QR on a white plate (always dark-on-white so wallets can scan it in dark mode).
 * `logo` puts the ⚡ badge in the middle (ECC raised to H so it still scans);
 * `dim` + `overlay` are for the expired state.
 */
export function QRCode({
  value,
  size = 220,
  className,
  label,
  logo,
  dim,
  overlay,
}: {
  value: string
  size?: number
  className?: string
  label?: string
  logo?: boolean
  dim?: boolean
  overlay?: ReactNode
}) {
  const path = useMemo(() => {
    // Bech32 payloads (lnurl…, lnbc…) are case-insensitive: uppercase packs denser (alphanumeric mode).
    const v = /^(lnurl|lnbc|lntb|lnbcrt)/i.test(value) ? value.toUpperCase() : value
    const { size: n, data } = encode(v, { ecc: logo ? 'H' : 'M', border: 0 })
    let d = ''
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (data[y]![x]) d += `M${x} ${y}h1v1h-1z`
    return { n, d }
  }, [value, logo])
  return (
    <div
      role="img"
      aria-label={label}
      className={cx('relative rounded-[6px] border border-divider bg-white p-2.5 text-[#0b0f19]', className)}
      style={{ width: size, height: size }}
    >
      <svg viewBox={`-2 -2 ${path.n + 4} ${path.n + 4}`} width="100%" height="100%" shapeRendering="crispEdges" style={{ display: 'block', opacity: dim ? 0.35 : 1 }}>
        <path fill="currentColor" d={path.d} />
      </svg>
      {logo && (
        <div className="absolute top-1/2 left-1/2 grid size-10 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border border-[#bfe0f3] bg-white text-[#0077b6]" style={{ opacity: dim ? 0.35 : 1 }}>
          <Icon name="zap" />
        </div>
      )}
      {overlay && <div className="absolute inset-0 grid place-items-center rounded-[6px] bg-white/70">{overlay}</div>}
    </div>
  )
}

// ─── Dialog / sheet ───────────────────────────────────────────────────────────

function useEscape(open: boolean, onClose?: () => void) {
  useEffect(() => {
    if (!open || !onClose) return
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [open, onClose])
}

export function Dialog({
  open,
  onClose,
  title,
  children,
  actions,
  className,
  bare,
  labelledBy,
}: {
  open: boolean
  onClose?: () => void
  title?: ReactNode
  children: ReactNode
  actions?: ReactNode
  className?: string
  /** Skip the default padding/gap (for custom layouts such as two-column modals). */
  bare?: boolean
  labelledBy?: string
}) {
  useEscape(open, onClose)
  if (!open) return null
  return (
    <div className="dialog-backdrop z-50" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div role="dialog" aria-modal="true" aria-labelledby={labelledBy} className={cx('dialog', bare && 'gap-0 p-0', className)}>
        {title && <div className="dialog-title">{title}</div>}
        {children}
        {actions && <div className="dialog-actions">{actions}</div>}
      </div>
    </div>
  )
}

/** Mobile bottom sheet (Foundations: Modal · bottom sheet). */
export function BottomSheet({ open, onClose, title, children }: { open: boolean; onClose: () => void; title?: ReactNode; children: ReactNode }) {
  useEscape(open, onClose)
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-[color-mix(in_srgb,var(--color-neutral-900)_50%,transparent)]" onClick={onClose} />
      <div role="dialog" aria-modal="true" className="absolute inset-x-0 bottom-0 flex flex-col gap-2.5 rounded-t-xl bg-surface px-4 pt-2.5 pb-[18px] shadow-lg">
        <div className="mx-auto mb-1 h-1 w-9 rounded-[2px] bg-neutral-400" />
        {title && <div className="font-heading text-[19px] font-semibold">{title}</div>}
        {children}
      </div>
    </div>
  )
}

// ─── Dropdown menu ────────────────────────────────────────────────────────────

export interface MenuItem {
  label: ReactNode
  onSelect: () => void
  current?: boolean
}

/** Minimal popover menu anchored to its trigger. */
export function Menu({ trigger, items, align = 'right' }: { trigger: (props: { onClick: () => void; 'aria-expanded': boolean }) => ReactNode; items: MenuItem[]; align?: 'left' | 'right' }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const h = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false)
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [open])
  useEscape(open, () => setOpen(false))
  return (
    <div ref={ref} className="relative">
      {trigger({ onClick: () => setOpen((o) => !o), 'aria-expanded': open })}
      {open && (
        <div role="menu" className={cx('absolute top-full z-40 mt-1 min-w-56 rounded-md border border-divider bg-surface py-1 shadow-md', align === 'right' ? 'right-0' : 'left-0')}>
          {items.map((it, i) => (
            <button
              key={i}
              role="menuitem"
              type="button"
              className={cx('flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-[color-mix(in_srgb,var(--color-text)_7%,transparent)]', it.current && 'text-accent-700')}
              onClick={() => {
                setOpen(false)
                it.onSelect()
              }}
            >
              {it.label}
              {it.current && <Icon name="check" size={16} />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Copy button ──────────────────────────────────────────────────────────────

export function CopyButton({ text, label, copiedLabel, className, variant = 'secondary' }: { text: string; label: ReactNode; copiedLabel: ReactNode; className?: string; variant?: 'primary' | 'secondary' }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1800)
    return () => clearTimeout(t)
  }, [copied])
  return (
    <Button
      variant={variant}
      icon={copied ? 'check' : 'copy'}
      className={className}
      onClick={async () => {
        await navigator.clipboard.writeText(text)
        setCopied(true)
      }}
    >
      {copied ? copiedLabel : label}
    </Button>
  )
}
