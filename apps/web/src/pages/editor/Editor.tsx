import type { Project } from '@nampu/types'
import { Brand, Button, cx, Notice, ProjectCard, StepBars, StepList } from '@nampu/ui'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'
import { api, ApiError, errorText } from '../../lib/api'
import { FullPageSpinner, useAuth } from '../../lib/auth'
import { ago, daysLeft, short } from '../../lib/format'
import { useIsDesktop, useNow } from '../../lib/hooks'
import { useI18n } from '../../lib/i18n'
import { BasicsStep, GoalStep, PayoutStep, RewardsStep, slugValid, StoryStep, type StepProps } from './steps'
import { cleanMilestones, cleanRewards, hasIncompleteReward, useProjectForm, type FormState, type SaveState } from './useProjectForm'

const STEPS = 5

/** Route wrapper: loads the project for /projects/:id/edit, or starts empty for /projects/new. */
export default function EditorPage() {
  const { id } = useParams()
  const q = useQuery({ queryKey: ['project', id], queryFn: () => api.project(id!), enabled: !!id })
  if (id && q.isPending) return <FullPageSpinner />
  if (id && q.isError) return <div className="p-10 text-danger">{(q.error as Error).message}</div>
  return <Editor key={id ?? 'new'} project={q.data} />
}

function Editor({ project }: { project: Project | undefined }) {
  const { t } = useI18n()
  const { creator } = useAuth()
  const desktop = useIsDesktop()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [params, setParams] = useSearchParams()
  const step = Math.min(STEPS - 1, Math.max(0, Number(params.get('step')) || 0))
  const goTo = useCallback((s: number) => setParams((p) => (p.set('step', String(s)), p), { replace: true }), [setParams])
  const { form, set, save, flush, fieldErrors, setFieldErrors } = useProjectForm(project)
  const [creating, setCreating] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [publishing, setPublishing] = useState(false)

  const ensureProject = useCallback(async (): Promise<Project | null> => {
    if (project) return project
    if (!form.title.trim() || !slugValid(form.slug)) {
      setActionError(t.needTitleSlug)
      return null
    }
    setCreating(true)
    setActionError(null)
    try {
      const p = await api.createProject({
        title: form.title.trim(),
        slug: form.slug,
        summary: form.summary,
        body: form.body,
        category: form.category,
        goalSats: form.goalSats,
        endsAt: form.endsAt,
        milestones: cleanMilestones(form.milestones),
        rewards: cleanRewards(form.rewards),
      })
      qc.setQueryData(['project', p.id], p)
      void qc.invalidateQueries({ queryKey: ['myProjects'] })
      navigate(`/projects/${p.id}/edit?step=${step}`, { replace: true })
      return p
    } catch (e) {
      if (e instanceof ApiError && e.code === 'conflict') setFieldErrors({ slug: 'slug_taken' })
      else setActionError(errorText(e, t))
      return null
    } finally {
      setCreating(false)
    }
  }, [project, form, qc, navigate, step, t, setFieldErrors])

  if (!creator) return null

  const done = doneFlags(form, !!creator.lightningAddress)
  const titles: [string, string][] = [
    [t.s1, t.s1sub],
    [t.s2, t.s2sub],
    [t.s3, t.s3sub],
    [t.s4, t.s4sub],
    [t.s5, t.s5sub],
  ]
  const isDraft = !project || project.status === 'draft'
  // Drafts open the owner-only preview of the full page; live projects open the page itself.
  const previewHref = project ? `/p/${project.slug}${isDraft ? `?preview=${project.id}` : ''}` : undefined

  const next = async () => {
    setActionError(null)
    if (step === 0 && !project) {
      const p = await ensureProject()
      if (!p) return
      navigate(`/projects/${p.id}/edit?step=1`, { replace: true })
      return
    }
    if (step < STEPS - 1) {
      void flush()
      return goTo(step + 1)
    }
    // Last step: publish (draft) or just save (live project).
    if (!project || !(await flush())) return
    if (isDraft) {
      if (!creator.lightningAddress) return setActionError(t.publishNeedsLn)
      setPublishing(true)
      try {
        qc.setQueryData(['project', project.id], await api.updateProject(project.id, { status: 'active' }))
        void qc.invalidateQueries({ queryKey: ['myProjects'] })
        navigate(`/dashboard/${project.id}`)
      } catch (e) {
        setActionError(errorText(e, t))
      } finally {
        setPublishing(false)
      }
    } else navigate(`/dashboard/${project.id}`)
  }

  const setStatus = async (status: 'active' | 'closed') => {
    if (!project) return
    try {
      qc.setQueryData(['project', project.id], await api.updateProject(project.id, { status }))
      void qc.invalidateQueries({ queryKey: ['myProjects'] })
    } catch (e) {
      setActionError(errorText(e, t))
    }
  }

  const stepProps: StepProps = { form, set, project, creator, desktop, fieldErrors, ensureProject, goTo, flush }
  const content = [
    <BasicsStep key="b" {...stepProps} />,
    <StoryStep key="s" {...stepProps} />,
    <GoalStep key="g" {...stepProps} />,
    <RewardsStep key="r" {...stepProps} />,
    <PayoutStep key="p" {...stepProps} doneFlags={done} />,
  ][step]
  const nextLabel = step === STEPS - 1 ? (isDraft ? t.publish : t.saveChanges) : t.next

  const extras = (
    <>
      {actionError && <Notice tone="danger">{actionError}</Notice>}
      {save.kind === 'error' && !Object.keys(fieldErrors).length && <Notice tone="danger">{errorText(save.error, t)}</Notice>}
      {step === STEPS - 1 && project && project.status !== 'draft' && (
        <Button variant="ghost" className="self-start" onClick={() => void setStatus(project.status === 'active' ? 'closed' : 'active')}>
          {project.status === 'active' ? t.closeProject : t.reopenProject}
        </Button>
      )}
    </>
  )

  // ─── 6b · Desktop ─────────────────────────────────────────────────────────
  if (desktop) {
    return (
      <div className="mx-auto max-w-[1280px]">
        <nav className="nav px-10 py-3.5">
          <Link to={project ? `/dashboard/${project.id}` : '/dashboard'} className="nav-brand">
            <Brand />
          </Link>
          <SaveLabel save={save} incomplete={!done[3]} />
          <a
            className={cx('btn btn-secondary', !project && 'pointer-events-none opacity-45')}
            aria-disabled={!project}
            href={previewHref}
            target="_blank"
            rel="noreferrer"
          >
            {t.preview}
          </a>
          <Button variant="primary" onClick={() => (project ? void flush() : void ensureProject())} loading={save.kind === 'saving' || creating}>
            {project ? t.saveChanges : t.createProject}
          </Button>
        </nav>
        <div className="grid grid-cols-[240px_minmax(0,1fr)_320px] gap-10 px-10 pt-8 pb-11">
          <div className="flex flex-col">
            <h6 className="text-neutral-700">{project ? t.editProject : t.createProject}</h6>
            <StepList
              current={step}
              onSelect={(i) => (project || i === 0 ? goTo(i) : setActionError(t.needTitleSlug))}
              steps={titles.map(([title], i) => ({ title, done: done[i]! }))}
            />
          </div>
          <div className="flex flex-col gap-[18px]">
            <div>
              <h2 className="m-0 text-[30px] font-medium">{titles[step]![0]}</h2>
              <p className="m-0 mt-0.5 text-neutral-700">{titles[step]![1]}</p>
            </div>
            {content}
            {extras}
            {(isDraft || step === STEPS - 1) && (
              <div className="mt-2 flex gap-2.5 border-t border-divider pt-4">
                {step > 0 && (
                  <Button variant="secondary" onClick={() => goTo(step - 1)}>
                    {t.back}
                  </Button>
                )}
                <Button variant="cta" className="ml-auto" onClick={() => void next()} loading={creating || publishing}>
                  {nextLabel}
                </Button>
              </div>
            )}
          </div>
          <div>
            <h6 className="text-neutral-700">{t.livePreview}</h6>
            <LivePreview form={form} project={project} />
          </div>
        </div>
      </div>
    )
  }

  // ─── 6a · Mobile ──────────────────────────────────────────────────────────
  return (
    <div className="flex min-h-dvh flex-col">
      <div className="sticky top-0 z-10 bg-bg">
        <div className="flex items-center px-3 py-1.5">
          <Button
            variant="ghost"
            plain
            iconOnly
            icon="chevL"
            aria-label={t.back}
            onClick={() => (step > 0 ? goTo(step - 1) : navigate(project ? `/dashboard/${project.id}` : '/dashboard'))}
          />
          <span className="tnum flex-1 text-center text-[13px] text-neutral-700">{`${t.stepN} ${step + 1} ${t.of} ${STEPS}`}</span>
          {project && (
            <a className="btn btn-ghost text-[13px]" href={previewHref} target="_blank" rel="noreferrer">
              {t.preview}
            </a>
          )}
          <Button variant="ghost" className="text-[13px]" onClick={() => (project ? void flush() : void ensureProject())} loading={save.kind === 'saving' || creating}>
            {t.saveDraft}
          </Button>
        </div>
        <StepBars count={STEPS} current={step} className="px-5" />
      </div>
      <div className="flex flex-1 flex-col gap-4 px-5 pt-[22px] pb-5">
        <h2 className="m-0 text-[26px] font-medium">{titles[step]![0]}</h2>
        <p className="-mt-2 mb-0 text-sm text-neutral-700">{titles[step]![1]}</p>
        {content}
        {extras}
        <div className="text-center text-xs text-neutral-600">
          <SaveLabel save={save} incomplete={!done[3]} />
        </div>
      </div>
      <div className="sticky bottom-0 flex gap-2.5 border-t border-divider bg-bg px-5 pt-3 pb-[26px]">
        {step > 0 && (
          <Button variant="secondary" className="h-12 px-[18px]" onClick={() => goTo(step - 1)}>
            {t.back}
          </Button>
        )}
        <Button variant="cta" className="h-12 flex-1 text-base" onClick={() => void next()} loading={creating || publishing}>
          {nextLabel}
        </Button>
      </div>
    </div>
  )

}

/** `incomplete`: a half-filled reward is kept out of the save, so "saved" would not be true. */
function SaveLabel({ save, incomplete }: { save: SaveState; incomplete: boolean }) {
  const { t, f } = useI18n()
  const now = useNow(20_000)
  if (incomplete && save.kind !== 'saving') return <span className="text-[13px] text-danger">{t.rewardsIncomplete}</span>
  const text =
    save.kind === 'saving'
      ? t.saving
      : save.kind === 'dirty'
        ? t.unsaved
        : save.kind === 'saved'
          ? now - save.at < 60_000
            ? t.savedJustNow
            : f(t.savedAgo, { ago: ago(save.at, t.ago, now) })
          : ''
  return <span className="text-[13px] text-neutral-600">{text}</span>
}

function doneFlags(form: FormState, hasLn: boolean): boolean[] {
  return [
    !!form.title.trim() && slugValid(form.slug) && !!form.summary.trim(),
    form.body.trim().length > 0,
    !!form.goalSats,
    !hasIncompleteReward(form.rewards), // optional, but a half-filled one is not saved
    hasLn,
  ]
}

/** 6b right column: the project card as it will appear, updated live. */
function LivePreview({ form, project }: { form: FormState; project: Project | undefined }) {
  const { t } = useI18n()
  const raised = project?.raisedSats ?? 0
  const goal = form.goalSats
  return (
    <ProjectCard
      title={form.title || t.fTitle}
      summary={form.summary}
      kicker={form.category ? t.cats[form.category] : null}
      coverUrl={project?.coverUrl}
      raisedLabel={short(raised)}
      goalLabel={goal ? short(goal) : null}
      progress={goal ? raised / goal : 0}
      meta={form.endsAt ? `${daysLeft(form.endsAt)} ${t.days}` : goal ? `${Math.round((raised / goal) * 100)}%` : undefined}
    />
  )
}
