import type { ReactNode } from 'react'
import { Icon, type IconName } from './Icon'
import { cx, hatch, Progress } from './primitives'

// ─── Switch ───────────────────────────────────────────────────────────────────

/** 40×24 toggle from the invoice sheet ("ไม่แสดงชื่อของฉัน"). */
export function Switch({ checked, onChange, label, icon, className }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; icon?: IconName; className?: string }) {
  return (
    <label className={cx('flex cursor-pointer items-center gap-2.5 py-1.5', className)}>
      {icon && (
        <span className="text-neutral-700">
          <Icon name={icon} />
        </span>
      )}
      <span className="flex-1 text-sm">{label}</span>
      <input type="checkbox" role="switch" className="peer sr-only" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span
        aria-hidden
        className="relative h-6 w-10 flex-none rounded-xl border transition-colors peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent"
        style={{ borderColor: checked ? 'var(--color-accent)' : 'var(--color-divider)', background: checked ? 'var(--color-accent-100)' : 'transparent' }}
      >
        <span
          className="absolute top-[3px] size-4 rounded-full transition-[left]"
          style={{ left: checked ? 20 : 3, background: checked ? 'var(--color-accent)' : 'var(--color-neutral-400)' }}
        />
      </span>
    </label>
  )
}

// ─── Underline tabs ───────────────────────────────────────────────────────────

export interface TabItem<T extends string> {
  value: T
  label: ReactNode
}

/** Text tabs with a 2px accent underline (project page 2a/2c, Discover 1c categories). */
export function Tabs<T extends string>({
  items,
  value,
  onChange,
  gap = 18,
  size = 14,
  className,
  trailing,
  'aria-label': ariaLabel,
}: {
  items: TabItem<T>[]
  value: T
  onChange: (v: T) => void
  gap?: number
  size?: number
  className?: string
  trailing?: ReactNode
  'aria-label'?: string
}) {
  // `trailing` (e.g. a sort menu) sits outside the scrolling tab strip: overflow-x-auto
  // would otherwise clip its dropdown and focus ring.
  const strip = (
    <div className={cx('flex items-center overflow-x-auto', trailing ? 'min-w-0 flex-1' : cx('border-b border-divider', className))} style={{ gap }} role="tablist" aria-label={ariaLabel}>
      {items.map((it) => {
        const on = it.value === value
        return (
          <button
            key={it.value}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={() => onChange(it.value)}
            className={cx('cursor-pointer border-0 border-b-2 bg-transparent py-2.5 whitespace-nowrap', !trailing && '-mb-px')}
            style={{ fontSize: size, color: on ? 'var(--color-accent-700)' : 'var(--color-neutral-700)', borderBottomColor: on ? 'var(--color-accent)' : 'transparent' }}
          >
            {it.label}
          </button>
        )
      })}
    </div>
  )
  if (!trailing) return strip
  return (
    // The strip's -mb-px (instead of the tabs') lays the active underline over the divider
    // without the tabs overflowing the scroller.
    <div className={cx('flex items-end gap-4 border-b border-divider', className)}>
      <div className="-mb-px flex min-w-0 flex-1">{strip}</div>
      <div className="flex-none self-center">{trailing}</div>
    </div>
  )
}

// ─── Discover list row (1a) ───────────────────────────────────────────────────

export function ProjectRow({
  title,
  kicker,
  coverUrl,
  progress,
  left,
  right,
}: {
  title: string
  kicker?: string | null
  coverUrl?: string | null
  progress: number
  left: ReactNode
  right?: ReactNode
}) {
  return (
    <div className="grid grid-cols-[84px_minmax(0,1fr)] gap-3.5 border-t border-divider py-3.5">
      {coverUrl ? (
        <img src={coverUrl} alt="" className="aspect-square w-full rounded-md border border-divider object-cover" />
      ) : (
        <div className="grid aspect-square place-items-center rounded-md border border-divider bg-neutral-200 text-neutral-500">
          <Icon name="image" />
        </div>
      )}
      <div className="flex flex-col gap-[5px]">
        {kicker && <div className="text-[11px] tracking-[0.08em] text-accent-700 uppercase">{kicker}</div>}
        <div className="font-heading text-[17px] leading-[1.3] font-semibold">{title}</div>
        <Progress value={progress} className="mt-0.5" />
        <div className="tnum flex justify-between text-xs text-neutral-700">
          <span>{left}</span>
          {right && <span>{right}</span>}
        </div>
      </div>
    </div>
  )
}

/** Cover with the DS `.plate` mat, or the hatched placeholder. */
export function Plate({ src, ratio = '16/10', className, label }: { src?: string | null; ratio?: string; className?: string; label?: string }) {
  return src ? (
    <img src={src} alt={label ?? ''} className={cx('plate w-full object-cover', className)} style={{ aspectRatio: ratio }} />
  ) : (
    <div className={cx('plate grid w-full place-items-center text-xs text-neutral-600', className)} style={{ aspectRatio: ratio, background: hatch }} aria-hidden>
      {label}
    </div>
  )
}
