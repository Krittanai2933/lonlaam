import type { ButtonHTMLAttributes, ComponentProps, CSSProperties, ReactNode } from 'react'
import { useId } from 'react'
import { Icon, type IconName } from './Icon'

export const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(' ')

// ─── Brand ────────────────────────────────────────────────────────────────────

const BRAND_SIZES = {
  nav: { th: 24, en: 17 },
  dialog: { th: 28, en: 18 },
  page: { th: 34, en: 20 },
  hero: { th: 44, en: 26 },
} as const

/** "ล้นหลาม Lonlaam" wordmark: heading face, italic Latin in accent-700. */
export function Brand({ size = 'nav', className }: { size?: keyof typeof BRAND_SIZES; className?: string }) {
  const s = BRAND_SIZES[size]
  return (
    <span className={cx('inline-flex items-baseline gap-2 font-heading', className)}>
      <span style={{ fontSize: s.th, fontWeight: 500, lineHeight: 1.1 }}>ล้นหลาม</span>
      <span className="italic text-accent-700" style={{ fontSize: s.en }}>
        Lonlaam
      </span>
    </span>
  )
}

// ─── Button ───────────────────────────────────────────────────────────────────

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'cta'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  icon?: IconName
  /** Square icon-only button (36×36 unless sized via className). */
  iconOnly?: boolean
  loading?: boolean
  /** Ghost buttons in nav bars use the text color instead of the accent. */
  plain?: boolean
}

export function Button({ variant = 'secondary', icon, iconOnly, loading, plain, className, children, disabled, type = 'button', style, ...rest }: ButtonProps) {
  return (
    <button
      type={type}
      className={cx('btn', `btn-${variant}`, iconOnly && 'btn-icon', className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      style={{ ...(plain && { color: 'var(--color-text)' }), ...(loading && { opacity: 0.8 }), ...style }}
      {...rest}
    >
      {loading ? <Spinner /> : icon && <Icon name={icon} />}
      {children}
    </button>
  )
}

export function Spinner({ size = 12 }: { size?: number }) {
  return (
    <span
      aria-hidden
      className="inline-block animate-np-spin rounded-full"
      style={{ width: size, height: size, border: '1.5px solid currentColor', borderRightColor: 'transparent' }}
    />
  )
}

/** Pulsing accent dot for "waiting" states. */
export function Pulse() {
  return <span aria-hidden className="block size-2 animate-np-pulse rounded-full bg-accent" />
}

// ─── Forms ────────────────────────────────────────────────────────────────────

export interface FieldProps {
  label: ReactNode
  /** Rendered under the control. */
  hint?: ReactNode
  error?: ReactNode
  success?: ReactNode
  /** Right-aligned counter such as "68 / 140". */
  counter?: ReactNode
  className?: string
  style?: CSSProperties
  children: (id: string) => ReactNode
}

/** `.field` wrapper; passes a generated id to the control for the label. */
export function Field({ label, hint, error, success, counter, className, style, children }: FieldProps) {
  const id = useId()
  return (
    <div className={cx('field', className)} style={style}>
      <label htmlFor={id} style={error ? { color: 'var(--color-danger)' } : undefined}>
        {label}
      </label>
      {children(id)}
      {counter !== undefined && <div className="tnum mt-[3px] text-right text-[11px] text-neutral-600">{counter}</div>}
      {error ? (
        <FieldNote tone="danger" icon="alert">
          {error}
        </FieldNote>
      ) : success ? (
        <FieldNote tone="success" icon="check">
          {success}
        </FieldNote>
      ) : (
        hint && <div className="mt-[5px] text-xs text-neutral-600">{hint}</div>
      )}
    </div>
  )
}

function FieldNote({ tone, icon, children }: { tone: 'danger' | 'success'; icon: IconName; children: ReactNode }) {
  return (
    <div role={tone === 'danger' ? 'alert' : 'status'} className={cx('mt-[5px] flex items-center gap-1.5 text-xs', tone === 'danger' ? 'text-danger' : 'text-success')}>
      <Icon name={icon} size={16} />
      {children}
    </div>
  )
}

export type InputProps = ComponentProps<'input'> & { tone?: 'success' | 'danger' }

export function Input({ className, tone, style, ...rest }: InputProps) {
  return (
    <input
      className={cx('input', className)}
      style={{ ...(tone && { borderColor: `var(--color-${tone})` }), ...style }}
      aria-invalid={tone === 'danger' || undefined}
      {...rest}
    />
  )
}

export function Textarea({ className, ...rest }: ComponentProps<'textarea'>) {
  return <textarea className={cx('input', className)} {...rest} />
}

/** Big numeric field with a "sats" suffix (Foundations: sats input). */
export function SatsInput({
  value,
  onChange,
  size = 'lg',
  id,
  disabled,
  placeholder = '0',
  className,
  'aria-label': ariaLabel,
}: {
  value: number | null
  onChange: (v: number | null) => void
  size?: 'md' | 'lg'
  id?: string
  disabled?: boolean
  placeholder?: string
  className?: string
  'aria-label'?: string
}) {
  const big = size === 'lg'
  return (
    <div
      className={cx(
        'flex items-center rounded-md border border-divider focus-within:border-accent',
        big ? 'h-[52px] px-3.5' : 'h-11 px-3',
        disabled && 'opacity-45',
        className,
      )}
    >
      <input
        id={id}
        inputMode="numeric"
        autoComplete="off"
        disabled={disabled}
        aria-label={ariaLabel}
        placeholder={placeholder}
        className={cx('tnum w-full min-w-0 flex-1 bg-transparent outline-none', big ? 'text-[22px] font-medium' : 'text-lg')}
        value={value === null ? '' : value.toLocaleString('en-US')}
        onChange={(e) => {
          const digits = e.target.value.replace(/\D/g, '').slice(0, 16)
          onChange(digits ? Number(digits) : null)
        }}
      />
      <span className={cx('text-neutral-600', !big && 'text-[13px]')}>sats</span>
    </div>
  )
}

// ─── Segmented control ────────────────────────────────────────────────────────

export interface SegOption<T extends string> {
  value: T
  label: ReactNode
  icon?: IconName
  disabled?: boolean
  title?: string
}

/** `.seg` on native radios, so it is keyboard accessible. */
export function Seg<T extends string>({
  options,
  value,
  onChange,
  name,
  full,
  optClassName,
  className,
  'aria-label': ariaLabel,
}: {
  options: SegOption<T>[]
  value: T
  onChange: (v: T) => void
  name?: string
  full?: boolean
  optClassName?: string
  className?: string
  'aria-label'?: string
}) {
  const auto = useId()
  return (
    <div role="radiogroup" aria-label={ariaLabel} className={cx('seg', full && 'flex w-full', className)}>
      {options.map((o) => (
        <label key={o.value} className={cx('seg-opt', full && 'flex-1 justify-center', optClassName)} title={o.title}>
          <input type="radio" name={name ?? auto} value={o.value} checked={value === o.value} disabled={o.disabled} onChange={() => onChange(o.value)} />
          {o.icon && <Icon name={o.icon} />}
          {o.label}
        </label>
      ))}
    </div>
  )
}

// ─── Chips, tags ──────────────────────────────────────────────────────────────

/** Pill used for categories and amount presets; selected = accent tint. */
export function Chip({ selected, className, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { selected?: boolean }) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      className={cx(
        'rounded-full border px-3.5 py-[7px] text-sm transition-colors',
        selected ? 'border-accent bg-accent-100 text-accent-800' : 'border-divider text-fg hover:bg-[color-mix(in_srgb,var(--color-text)_7%,transparent)]',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  )
}

export type TagTone = 'accent' | 'neutral' | 'outline' | 'success' | 'danger' | 'plain'

export function Tag({ tone = 'neutral', icon, className, children }: { tone?: TagTone; icon?: IconName; className?: string; children: ReactNode }) {
  return (
    <span className={cx('tag', tone !== 'plain' && `tag-${tone}`, icon && 'gap-1', className)}>
      {icon && <Icon name={icon} size={12} />}
      {children}
    </span>
  )
}

// ─── Progress ─────────────────────────────────────────────────────────────────

/** 3px glowing blue→accent line on a thin track; optional milestone ticks (Foundations: Progress). */
export function Progress({ value, ticks, className }: { value: number; ticks?: { at: number; reached: boolean }[]; className?: string }) {
  const pct = Math.max(0, Math.min(1, value)) * 100
  return (
    <div className={cx('relative h-[3px] rounded-[2px] bg-neutral-300', className)} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}>
      <div
        className="absolute inset-y-0 left-0 rounded-[2px] bg-linear-to-r from-blue to-accent shadow-glow"
        style={{ width: `${pct}%` }}
      />
      {ticks?.map((t, i) => (
        <div
          key={i}
          className="absolute -top-1 h-[11px] w-px"
          style={{ left: `${Math.min(1, t.at) * 100}%`, background: t.reached ? 'var(--color-accent-700)' : 'var(--color-neutral-500)' }}
        />
      ))}
    </div>
  )
}

// ─── Steps ────────────────────────────────────────────────────────────────────

/** Mobile wizard: thin segment bars, filled up to `current`. */
export function StepBars({ count, current, className }: { count: number; current: number; className?: string }) {
  return (
    <div className={cx('grid gap-1', className)} style={{ gridTemplateColumns: `repeat(${count}, 1fr)` }} aria-hidden>
      {Array.from({ length: count }, (_, i) => (
        <span key={i} className="h-0.5" style={{ background: i <= current ? 'var(--color-accent)' : 'var(--color-neutral-300)' }} />
      ))}
    </div>
  )
}

/** Desktop wizard sidebar: numbered rings, check when done. */
export function StepList({
  steps,
  current,
  onSelect,
}: {
  steps: { title: string; done: boolean }[]
  current: number
  onSelect: (i: number) => void
}) {
  return (
    <ol className="m-0 flex list-none flex-col p-0">
      {steps.map((s, i) => {
        const on = i === current
        return (
          <li key={i}>
            <button
              type="button"
              onClick={() => onSelect(i)}
              aria-current={on ? 'step' : undefined}
              className="grid w-full cursor-pointer grid-cols-[28px_1fr] items-center gap-2.5 border-b border-divider py-2.5 text-left"
              style={{ color: on ? 'var(--color-accent-700)' : 'var(--color-text)' }}
            >
              <span
                className="tnum grid size-6 place-items-center rounded-full border text-xs text-accent-700"
                style={{ borderColor: on || s.done ? 'var(--color-accent)' : 'var(--color-neutral-400)' }}
              >
                {s.done && !on ? <Icon name="check" size={14} /> : i + 1}
              </span>
              <span className="text-sm">{s.title}</span>
            </button>
          </li>
        )
      })}
    </ol>
  )
}

// ─── Misc ─────────────────────────────────────────────────────────────────────

/** Initial in a hairline circle. */
export function Avatar({ name, size = 32, accent, className }: { name: string; size?: number; accent?: boolean; className?: string }) {
  // Skip Thai leading vowels (เ แ โ ใ ไ) so "ไม่ระบุชื่อ" shows ม, not ไ.
  const initial = ([...name.trim()].find((c) => !/[\u0E40-\u0E44]/.test(c)) ?? '?').toUpperCase()
  return (
    <span
      aria-hidden
      className={cx('grid flex-none place-items-center rounded-full border', accent ? 'border-accent text-accent-700' : 'border-divider text-neutral-700', className)}
      style={{ width: size, height: size, fontSize: size >= 32 ? 13 : 12 }}
    >
      {initial}
    </span>
  )
}

/** Tinted notice box — accent (info/lock) or danger (warning). */
export function Notice({ tone = 'accent', icon = 'alert', children, className }: { tone?: 'accent' | 'danger'; icon?: IconName; children: ReactNode; className?: string }) {
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'note'}
      className={cx(
        'flex items-start gap-2 rounded-md border px-3 py-2.5 text-[13px]',
        tone === 'accent' ? 'border-accent-300 bg-accent-100 text-accent-800' : 'border-[color-mix(in_srgb,var(--color-danger)_40%,transparent)] text-danger',
        className,
      )}
    >
      <Icon name={icon} />
      <span>{children}</span>
    </div>
  )
}

/** Horizontal rule with centered label ("หรือวางลิงก์ bunker"). */
export function Divider({ children }: { children?: ReactNode }) {
  return (
    <div className="my-1.5 flex items-center gap-2.5 text-xs text-neutral-600">
      <span className="h-px flex-1 bg-divider" />
      {children}
      <span className="h-px flex-1 bg-divider" />
    </div>
  )
}

/** Hatched placeholder used where a cover image is missing. */
export const hatch = 'repeating-linear-gradient(135deg,var(--color-neutral-200) 0 10px,var(--color-neutral-100) 10px 20px)'
