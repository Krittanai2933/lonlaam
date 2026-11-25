import type { Creator, Project, Reward } from '@nampu/types'
import { LIMITS, PROJECT_CATEGORIES } from '@nampu/types'
import { Button, Chip, cx, Field, Icon, Input, Notice, SatsInput, Tag, Textarea } from '@nampu/ui'
import { useQueryClient } from '@tanstack/react-query'
import { useRef, useState, type ReactNode } from 'react'
import { api, ApiError, errorText } from '../../lib/api'
import { meKey } from '../../lib/auth'
import { fmt, fmtDate, slugify } from '../../lib/format'
import { useI18n } from '../../lib/i18n'
import { EnglishVersion } from './english'
import { newRewardId, type FormState } from './useProjectForm'

export interface StepProps {
  form: FormState
  set: <K extends keyof FormState>(key: K, value: FormState[K]) => void
  project: Project | undefined
  creator: Creator
  desktop: boolean
  fieldErrors: Record<string, string>
  /** Creates the draft if needed and returns it (for uploads before the first save). */
  ensureProject: () => Promise<Project | null>
  goTo: (step: number) => void
  /** Saves pending edits now; false if the save failed. */
  flush: () => Promise<boolean>
}

const SLUG_RE = new RegExp(LIMITS.slug.pattern)
export const slugValid = (s: string) => s.length >= LIMITS.slug.min && SLUG_RE.test(s)

// ─── 1 · Basics ───────────────────────────────────────────────────────────────

export function BasicsStep({ form, set, project, fieldErrors, ensureProject }: StepProps) {
  const { t } = useI18n()
  const qc = useQueryClient()
  const [slugTouched, setSlugTouched] = useState(!!form.slug)
  const [uploading, setUploading] = useState(false)
  const [coverError, setCoverError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const locked = !!project && project.status !== 'draft'
  const slugError = fieldErrors.slug === 'slug_taken' ? t.slugTaken : fieldErrors.slug ? t.slugHint : form.slug && !slugValid(form.slug) ? t.slugHint : null

  const onFile = async (file: File) => {
    setCoverError(null)
    if (file.size > LIMITS.cover.maxBytes) return setCoverError(t.fileTooLarge)
    const p = await ensureProject()
    if (!p) return setCoverError(t.needTitleSlug)
    setUploading(true)
    try {
      qc.setQueryData(['project', p.id], await api.uploadCover(p.id, file))
    } catch (e) {
      setCoverError(e instanceof Error ? e.message : t.somethingWrong)
    } finally {
      setUploading(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Field label={t.fTitle}>
        {(id) => (
          <Input
            id={id}
            className="min-h-11"
            maxLength={LIMITS.title.max}
            value={form.title}
            onChange={(e) => {
              set('title', e.target.value)
              if (!slugTouched && !locked) set('slug', slugify(e.target.value))
            }}
          />
        )}
      </Field>
      <Field label={t.fSlug} hint={locked ? undefined : t.slugHint} error={slugError}>
        {(id) => (
          <div className={cx('flex min-h-11 items-center rounded-md border border-divider pl-2.5 focus-within:border-accent', locked && 'opacity-45')}>
            <span className="text-sm whitespace-nowrap text-neutral-600">{location.host}/p/</span>
            <input
              id={id}
              className="min-h-11 w-full bg-transparent pr-2.5 text-sm outline-none"
              disabled={locked}
              maxLength={LIMITS.slug.max}
              autoCapitalize="none"
              spellCheck={false}
              value={form.slug}
              onChange={(e) => {
                setSlugTouched(true)
                set('slug', e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))
              }}
            />
          </div>
        )}
      </Field>
      <Field label={t.fBlurb} counter={`${form.summary.length} / ${LIMITS.summary.max}`}>
        {(id) => <Textarea id={id} className="min-h-20" maxLength={LIMITS.summary.max} value={form.summary} onChange={(e) => set('summary', e.target.value)} />}
      </Field>
      <div className="field">
        <label>{t.fCat}</label>
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={t.fCat}>
          {PROJECT_CATEGORIES.map((c) => (
            <Chip key={c} selected={form.category === c} role="radio" aria-checked={form.category === c} onClick={() => set('category', form.category === c ? null : c)}>
              {t.cats[c]}
            </Chip>
          ))}
        </div>
      </div>
      <div className="field">
        <label>{t.fCover}</label>
        <input ref={fileRef} type="file" accept={LIMITS.cover.types.join(',')} hidden onChange={(e) => e.target.files?.[0] && void onFile(e.target.files[0])} />
        {project?.coverUrl ? (
          <div className="relative">
            <img src={project.coverUrl} alt="" className="aspect-video w-full rounded-md border border-divider object-cover" />
            <div className="absolute right-2 bottom-2 flex gap-2">
              <Button variant="secondary" className="bg-bg" icon="image" onClick={() => fileRef.current?.click()} loading={uploading}>
                {t.edit}
              </Button>
              <Button
                variant="secondary"
                className="bg-bg"
                iconOnly
                icon="x"
                aria-label={t.removeCover}
                onClick={async () => project && qc.setQueryData(['project', project.id], await api.deleteCover(project.id))}
              />
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="flex aspect-video w-full cursor-pointer flex-col items-center justify-center gap-1.5 rounded-md border border-dashed border-neutral-400 text-[13px] text-neutral-600 hover:border-accent"
          >
            <Icon name="image" />
            {uploading ? t.uploading : t.upload}
          </button>
        )}
        {coverError && <div className="mt-1.5 text-xs text-danger">{coverError}</div>}
      </div>
    </div>
  )
}

// ─── 2 · Story ────────────────────────────────────────────────────────────────

export function StoryStep(props: StepProps) {
  const { form, set, ensureProject } = props
  const { t } = useI18n()
  const ref = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  /** Wrap the selection (or insert at the caret) with Markdown. */
  const wrap = (before: string, after = before, linePrefix = false) => {
    const el = ref.current
    if (!el) return
    const { selectionStart: s, selectionEnd: e, value } = el
    let next: string
    let caret: number
    if (linePrefix) {
      const lineStart = value.lastIndexOf('\n', s - 1) + 1
      next = value.slice(0, lineStart) + before + value.slice(lineStart)
      caret = e + before.length
    } else {
      next = value.slice(0, s) + before + value.slice(s, e) + after + value.slice(e)
      caret = e + before.length
    }
    set('body', next.slice(0, LIMITS.body.max))
    requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(caret, caret)
    })
  }

  const onImage = async (file: File) => {
    setError(null)
    if (file.size > LIMITS.cover.maxBytes) return setError(t.fileTooLarge)
    const p = await ensureProject()
    if (!p) return setError(t.needTitleSlug)
    setUploading(true)
    try {
      const { url } = await api.uploadImage(p.id, file)
      wrap(`\n![](${url})\n`, '')
    } catch (e) {
      setError(e instanceof Error ? e.message : t.somethingWrong)
    } finally {
      setUploading(false)
    }
  }

  const tool = 'h-8 w-8 grid place-items-center rounded-sm hover:bg-[color-mix(in_srgb,var(--color-text)_7%,transparent)] cursor-pointer'
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex gap-0.5 rounded-t-md border border-b-0 border-divider p-1 font-heading text-[15px]" role="toolbar">
        <button type="button" className={cx(tool, 'font-semibold')} aria-label="Bold" onClick={() => wrap('**')}>
          B
        </button>
        <button type="button" className={cx(tool, 'italic')} aria-label="Italic" onClick={() => wrap('*')}>
          I
        </button>
        <button type="button" className={tool} aria-label="Heading" onClick={() => wrap('## ', '', true)}>
          H
        </button>
        <button type="button" className={tool} aria-label="Image" onClick={() => fileRef.current?.click()} disabled={uploading}>
          {uploading ? <span className="inline-block size-3 animate-np-spin rounded-full border-[1.5px] border-current border-r-transparent" /> : <Icon name="image" />}
        </button>
        <input ref={fileRef} type="file" accept={LIMITS.cover.types.join(',')} hidden onChange={(e) => e.target.files?.[0] && void onImage(e.target.files[0])} />
      </div>
      <Textarea
        ref={ref}
        aria-label={t.s2}
        className="-mt-2.5 min-h-[300px] rounded-t-none leading-[1.65]"
        placeholder={t.storyPlaceholder}
        maxLength={LIMITS.body.max}
        value={form.body}
        onChange={(e) => set('body', e.target.value)}
      />
      {error && <div className="text-xs text-danger">{error}</div>}
      <EnglishVersion {...props} />
    </div>
  )
}

// ─── 3 · Goal & timeline ──────────────────────────────────────────────────────

/** Looks like the design's text input ("12 ต.ค. 2026") but opens the native date picker. */
function DateField({ value, onChange, id }: { value: number | null; onChange: (v: number | null) => void; id: string }) {
  const { lang, t } = useI18n()
  const ref = useRef<HTMLInputElement>(null)
  const iso = value ? new Date(value - new Date(value).getTimezoneOffset() * 60_000).toISOString().slice(0, 10) : ''
  const min = new Date(Date.now() + 86_400_000 - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 10)
  return (
    <div className="relative">
      <button
        id={id}
        type="button"
        className="input flex min-h-11 cursor-pointer items-center justify-between text-left"
        onClick={() => (ref.current?.showPicker ? ref.current.showPicker() : ref.current?.focus())}
      >
        <span className={value ? '' : 'text-neutral-500'}>{value ? fmtDate(value, lang) : t.noEnd}</span>
        {value && (
          <span
            role="button"
            tabIndex={0}
            aria-label={t.noEnd}
            className="text-neutral-500"
            onClick={(e) => {
              e.stopPropagation()
              onChange(null)
            }}
          >
            <Icon name="x" size={16} />
          </span>
        )}
      </button>
      <input
        ref={ref}
        type="date"
        tabIndex={-1}
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-0"
        min={min}
        value={iso}
        onChange={(e) => {
          if (!e.target.value) return onChange(null)
          // End of the chosen local day.
          const [y, m, d] = e.target.value.split('-').map(Number)
          onChange(new Date(y!, m! - 1, d!, 23, 59, 59).getTime())
        }}
      />
    </div>
  )
}

export function GoalStep({ form, set, project, desktop, fieldErrors }: StepProps) {
  const { t, f } = useI18n()
  const raised = project?.raisedSats ?? 0
  const published = !!project && project.status !== 'draft'
  const goalError = fieldErrors.goalSats === 'goal_below_raised' || (published && form.goalSats !== null && form.goalSats < raised)
  const ms = form.milestones
  const setMs = (i: number, patch: Partial<(typeof ms)[number]>) => set('milestones', ms.map((m, j) => (j === i ? { ...m, ...patch } : m)))
  const addMs = () => ms.length < LIMITS.milestones.max && set('milestones', [...ms, { sats: 0, label: '' }])
  const removeMs = (i: number) => set('milestones', ms.filter((_, j) => j !== i))

  const header = (
    <div className="flex items-baseline justify-between">
      <h6 className="text-neutral-700">{t.milestones}</h6>
      <Button variant="ghost" icon="plus" onClick={addMs} disabled={ms.length >= LIMITS.milestones.max}>
        {t.add}
      </Button>
    </div>
  )
  const lockNote = published && (
    <div className="field">
      <label>{t.fGoalLocked}</label>
      <Notice>{f(t.lockedNote, { raised: fmt(raised) })}</Notice>
    </div>
  )

  if (desktop) {
    return (
      <div className="flex flex-col gap-[18px]">
        <div className="grid grid-cols-2 gap-4">
          <Field label={t.fGoal} error={goalError ? f(t.lockedNote, { raised: fmt(raised) }) : null}>
            {(id) => <SatsInput id={id} size="md" value={form.goalSats} onChange={(v) => set('goalSats', v)} />}
          </Field>
          <Field label={t.fEnd}>{(id) => <DateField id={id} value={form.endsAt} onChange={(v) => set('endsAt', v)} />}</Field>
        </div>
        {lockNote}
        <div>
          {header}
          <table className="table">
            <thead>
              <tr>
                <th className="w-40">sats</th>
                <th>{t.msDesc}</th>
                <th className="w-[110px]">{t.status}</th>
                <th className="w-9" />
              </tr>
            </thead>
            <tbody>
              {ms.map((m, i) => (
                <tr key={i}>
                  <td className="tnum">
                    <CellInput aria-label="sats" inputMode="numeric" value={m.sats ? fmt(m.sats) : ''} onChange={(v) => setMs(i, { sats: Number(v.replace(/\D/g, '').slice(0, 16)) || 0 })} />
                  </td>
                  <td>
                    <CellInput aria-label={t.msDesc} maxLength={LIMITS.milestones.label.max} value={m.label} onChange={(v) => setMs(i, { label: v })} />
                  </td>
                  <td>
                    <Tag tone={m.sats > 0 && raised >= m.sats ? 'accent' : 'neutral'}>{m.sats > 0 && raised >= m.sats ? t.reached : t.inProgress}</Tag>
                  </td>
                  <td>
                    <button type="button" className="cursor-pointer text-neutral-500 hover:text-fg" aria-label="remove" onClick={() => removeMs(i)}>
                      <Icon name="x" size={16} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <Field label={t.fGoal} error={goalError ? f(t.lockedNote, { raised: fmt(raised) }) : null}>
        {(id) => <SatsInput id={id} value={form.goalSats} onChange={(v) => set('goalSats', v)} className={form.goalSats ? 'border-accent' : undefined} />}
      </Field>
      <Field label={t.fEnd}>{(id) => <DateField id={id} value={form.endsAt} onChange={(v) => set('endsAt', v)} />}</Field>
      {lockNote}
      <div>
        {header}
        {ms.map((m, i) => (
          <div key={i} className="grid grid-cols-[110px_1fr_28px] items-center gap-2 py-1.5">
            <Input className="tnum" inputMode="numeric" aria-label="sats" value={m.sats ? fmt(m.sats) : ''} onChange={(e) => setMs(i, { sats: Number(e.target.value.replace(/\D/g, '').slice(0, 16)) || 0 })} />
            <Input aria-label={t.msDesc} maxLength={LIMITS.milestones.label.max} value={m.label} onChange={(e) => setMs(i, { label: e.target.value })} />
            <button type="button" className="cursor-pointer text-neutral-500 hover:text-fg" aria-label="remove" onClick={() => removeMs(i)}>
              <Icon name="x" />
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

/** Table cell input that reads as plain text until hovered/focused (keeps 6b's table look). */
function CellInput({ value, onChange, ...rest }: { value: string; onChange: (v: string) => void } & Omit<React.ComponentProps<'input'>, 'value' | 'onChange'>) {
  return (
    <input
      className="-mx-1.5 w-full rounded-sm border border-transparent bg-transparent px-1.5 py-0.5 outline-none hover:border-divider focus:border-accent"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      {...rest}
    />
  )
}

// ─── 4 · Rewards ──────────────────────────────────────────────────────────────

export function RewardsStep({ form, set, project, desktop, fieldErrors }: StepProps) {
  const { t, f } = useI18n()
  const rs = form.rewards
  const claimed = new Map(project?.rewards.map((r) => [r.id, r.claimed]))
  const setR = (i: number, patch: Partial<Reward>) => set('rewards', rs.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  const add = () => rs.length < LIMITS.rewards.max && set('rewards', [...rs, { id: newRewardId(), title: '', description: '', minSats: 0, limit: null }])
  const remove = (i: number) => set('rewards', rs.filter((_, j) => j !== i))

  return (
    <div className="flex flex-col gap-3">
      {rs.map((r, i) => {
        const n = claimed.get(r.id) ?? 0
        const minSats = (
          <Field label={t.rewardMin}>
            {(id) => <SatsInput id={id} size="md" value={r.minSats || null} onChange={(v) => setR(i, { minSats: Math.min(v ?? 0, LIMITS.invoiceSats.max) })} />}
          </Field>
        )
        const limit = (
          <Field label={t.rewardLimit}>
            {(id) => (
              <Input
                id={id}
                className="tnum min-h-11"
                inputMode="numeric"
                placeholder={t.noLimit}
                value={r.limit ? fmt(r.limit) : ''}
                onChange={(e) => setR(i, { limit: Math.min(Number(e.target.value.replace(/\D/g, '').slice(0, 6)) || 0, LIMITS.rewards.limit.max) || null })}
              />
            )}
          </Field>
        )
        return (
          <section key={r.id} aria-label={r.title || t.addReward} className="flex flex-col gap-3 rounded-md border border-divider p-4">
            <div className="flex items-start gap-2">
              <Field label={t.rewardName} className="flex-1">
                {(id) => <Input id={id} className="min-h-11" maxLength={LIMITS.rewards.title.max} value={r.title} onChange={(e) => setR(i, { title: e.target.value })} />}
              </Field>
              <Button variant="ghost" plain iconOnly icon="x" className="mt-6" aria-label={t.removeReward} onClick={() => remove(i)} />
            </div>
            <div className={cx('grid gap-3', desktop ? 'grid-cols-[1fr_180px]' : 'grid-cols-2')}>
              {minSats}
              {limit}
            </div>
            <Field label={t.rewardDesc} counter={`${r.description.length} / ${LIMITS.rewards.description.max}`}>
              {(id) => (
                <Textarea id={id} className="min-h-20" maxLength={LIMITS.rewards.description.max} value={r.description} onChange={(e) => setR(i, { description: e.target.value })} />
              )}
            </Field>
            {n > 0 && <div className="tnum text-xs text-neutral-600">{f(t.rewardClaimed, { n: fmt(n) })}</div>}
          </section>
        )
      })}
      {fieldErrors.rewards && <Notice tone="danger">{t.rewardsInvalid}</Notice>}
      <Button variant="secondary" icon="plus" className="h-12 border-dashed" onClick={add} disabled={rs.length >= LIMITS.rewards.max}>
        {t.addReward}
      </Button>
      <p className="m-0 text-[13px] text-neutral-600">{t.rewardsOptional}</p>
    </div>
  )
}

// ─── 5 · Payout & review ──────────────────────────────────────────────────────

// Shape check only; the server validates fully (and allows host:port in dev).
const LN_RE = /^[^@\s]+@[^@\s]+$/

export function PayoutStep({ creator, goTo, doneFlags }: StepProps & { doneFlags: boolean[] }) {
  const { t } = useI18n()
  const qc = useQueryClient()
  const [ln, setLn] = useState(creator.lightningAddress ?? '')
  const [lnState, setLnState] = useState<{ kind: 'idle' | 'checking' | 'ok' } | { kind: 'error'; msg: string }>(creator.lightningAddress ? { kind: 'ok' } : { kind: 'idle' })
  const [npub, setNpub] = useState(creator.npub ?? '')
  const [npubError, setNpubError] = useState<string | null>(null)

  const saveLn = async () => {
    const v = ln.trim().toLowerCase()
    if (v === (creator.lightningAddress ?? '')) return setLnState(v ? { kind: 'ok' } : { kind: 'idle' })
    if (v && !LN_RE.test(v)) return setLnState({ kind: 'error', msg: t.lnFormat })
    setLnState({ kind: 'checking' })
    try {
      qc.setQueryData(meKey, await api.updateMe({ lightningAddress: v || null }))
      setLnState(v ? { kind: 'ok' } : { kind: 'idle' })
    } catch (e) {
      const msg =
        e instanceof ApiError && e.code === 'lnurl_cannot_receive'
          ? t.lnCannotReceive
          : e instanceof ApiError && e.code === 'lnurl_verify_unsupported'
            ? t.lnVerifyUnsupported
            : e instanceof ApiError
              ? errorText(e, t)
              : t.somethingWrong
      setLnState({ kind: 'error', msg })
    }
  }
  const saveNpub = async () => {
    const v = npub.trim()
    if (v === (creator.npub ?? '')) return
    setNpubError(null)
    try {
      qc.setQueryData(meKey, await api.updateMe({ npub: v || null }))
    } catch (e) {
      setNpubError(e instanceof ApiError ? e.message : t.somethingWrong)
    }
  }

  const reviewItems: [string, number][] = [
    [t.s1, 0],
    [t.s2, 1],
    [t.s3, 2],
    [t.s4, 3],
  ]
  return (
    <div className="flex flex-col gap-4">
      <Field
        label="Lightning address"
        error={lnState.kind === 'error' ? lnState.msg : null}
        success={lnState.kind === 'ok' ? t.lnOk : null}
        hint={lnState.kind === 'checking' ? t.lnChecking : undefined}
      >
        {(id) => (
          <Input
            id={id}
            className="min-h-11"
            type="email"
            inputMode="email"
            autoCapitalize="none"
            placeholder="name@getalby.com"
            tone={lnState.kind === 'ok' ? 'success' : lnState.kind === 'error' ? 'danger' : undefined}
            value={ln}
            onChange={(e) => {
              setLn(e.target.value)
              if (lnState.kind !== 'checking') setLnState({ kind: 'idle' })
            }}
            onBlur={() => void saveLn()}
            onKeyDown={(e) => e.key === 'Enter' && void saveLn()}
          />
        )}
      </Field>
      <Field label={t.fNpub} error={npubError}>
        {(id) => (
          <Input
            id={id}
            className="min-h-11"
            autoCapitalize="none"
            spellCheck={false}
            placeholder="npub1…"
            value={npub}
            onChange={(e) => setNpub(e.target.value)}
            onBlur={() => void saveNpub()}
          />
        )}
      </Field>
      <div className="border-t border-divider pt-3">
        <h6 className="text-neutral-700">{t.review}</h6>
        {reviewItems.map(([label, step]) => (
          <ReviewRow key={step} done={doneFlags[step]!} label={label} onEdit={() => goTo(step)} editLabel={t.edit} />
        ))}
      </div>
    </div>
  )
}

function ReviewRow({ done, label, onEdit, editLabel }: { done: boolean; label: ReactNode; onEdit: () => void; editLabel: string }) {
  return (
    <div className="flex justify-between border-b border-divider py-[7px] text-sm">
      <span className={cx('flex items-center gap-2', done ? 'text-success' : 'text-neutral-400')}>
        <Icon name={done ? 'check' : 'alert'} />
        <span className="text-fg">{label}</span>
      </span>
      <a
        href="#"
        className="text-[13px]"
        onClick={(e) => {
          e.preventDefault()
          onEdit()
        }}
      >
        {editLabel}
      </a>
    </div>
  )
}
