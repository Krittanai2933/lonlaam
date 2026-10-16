import { LIMITS } from '@nampu/types'
import { Button, Field, Input, Notice, Textarea } from '@nampu/ui'
import { useState } from 'react'
import { api, ApiError, errorText } from '../../lib/api'
import { fmt } from '../../lib/format'
import { useI18n } from '../../lib/i18n'
import type { StepProps } from './steps'
import { cleanMilestones, englishForm } from './useProjectForm'

/**
 * Optional English version of the project. Without one, English readers get the automatic
 * translation; with one, they get the creator's text and the automatic one never replaces it.
 */
export function EnglishVersion({ form, set, project, ensureProject, flush }: StepProps) {
  const { t } = useI18n()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const en = form.en
  const milestones = cleanMilestones(form.milestones)

  /** The automatic translation of the saved Thai text, as a starting point. False if it failed. */
  const autoTranslate = async (): Promise<boolean> => {
    setError(null)
    const p = await ensureProject()
    if (!p) return (setError(t.needTitleSlug), false)
    // It translates the saved text, so save pending edits first (a failed save shows its own error).
    if (!(await flush())) return false
    setLoading(true)
    try {
      set('en', englishForm(await api.translateProject(p.id), milestones))
      return true
    } catch (e) {
      setError(e instanceof ApiError && e.code === 'translation_unavailable' ? t.enAutoFailed : errorText(e, t))
      return false
    } finally {
      setLoading(false)
    }
  }

  const writeMyself = async () => {
    // Start from the translation readers see now when there is one, else ask for a fresh one,
    // else start empty.
    const tr = project?.translation
    if (tr) set('en', englishForm({ ...tr, milestones: tr.milestones.map((m) => m.label) }, project.milestones))
    else if (!(await autoTranslate())) set('en', { title: '', summary: '', body: '', milestones: {} })
  }

  const backToAuto = () => {
    if (window.confirm(t.enBackToAutoConfirm)) set('en', null)
  }

  const setEn = (patch: Partial<NonNullable<typeof en>>) => en && set('en', { ...en, ...patch })

  return (
    <section className="mt-4 flex flex-col gap-3 border-t border-divider pt-5">
      <div>
        <h3 className="m-0 text-[20px]">{t.enTitle}</h3>
        <p className="m-0 mt-0.5 text-sm text-neutral-700">{en ? t.enManualNote : t.enAutoNote}</p>
      </div>
      {error && <Notice tone="danger">{error}</Notice>}
      {!en ? (
        <Button variant="secondary" className="self-start" icon="edit" loading={loading} onClick={() => void writeMyself()}>
          {t.enWriteMyself}
        </Button>
      ) : (
        <>
          {project?.translationStale && <Notice>{t.enStale}</Notice>}
          <Field label={`${t.fTitle} (English)`}>
            {(id) => <Input id={id} lang="en" className="min-h-11" maxLength={LIMITS.translation.title} value={en.title} onChange={(e) => setEn({ title: e.target.value })} />}
          </Field>
          <Field label={`${t.fBlurb} (English)`} counter={`${en.summary.length} / ${LIMITS.translation.summary}`}>
            {(id) => <Textarea id={id} lang="en" className="min-h-20" maxLength={LIMITS.translation.summary} value={en.summary} onChange={(e) => setEn({ summary: e.target.value })} />}
          </Field>
          <Field label={`${t.s2} (English)`}>
            {(id) => (
              <Textarea id={id} lang="en" className="min-h-[220px] leading-[1.65]" maxLength={LIMITS.translation.body} value={en.body} onChange={(e) => setEn({ body: e.target.value })} />
            )}
          </Field>
          {milestones.length > 0 && (
            <div className="field">
              <label>{`${t.milestones} (English)`}</label>
              {milestones.map((m) => (
                <div key={m.sats} className="grid grid-cols-[110px_1fr] items-center gap-2 py-1">
                  <span className="tnum text-[13px] text-neutral-700">{fmt(m.sats)} sats</span>
                  <Input
                    lang="en"
                    aria-label={`${t.msDesc} ${fmt(m.sats)} sats`}
                    placeholder={m.label}
                    maxLength={LIMITS.translation.label}
                    value={en.milestones[m.sats] ?? ''}
                    onChange={(e) => setEn({ milestones: { ...en.milestones, [m.sats]: e.target.value } })}
                  />
                </div>
              ))}
            </div>
          )}
          <div className="flex flex-wrap gap-2.5">
            <Button variant="secondary" loading={loading} onClick={() => window.confirm(t.enRetranslateConfirm) && void autoTranslate()}>
              {t.enRetranslate}
            </Button>
            <Button variant="ghost" onClick={backToAuto}>
              {t.enBackToAuto}
            </Button>
          </div>
        </>
      )}
    </section>
  )
}
