import type { Milestone, Project, ProjectCategory, UpdateProjectRequest } from '@nampu/types'
import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'
import { api, ApiError } from '../../lib/api'

export interface FormState {
  title: string
  slug: string
  summary: string
  body: string
  category: ProjectCategory | null
  goalSats: number | null
  endsAt: number | null
  milestones: Milestone[]
}

export const emptyForm: FormState = { title: '', slug: '', summary: '', body: '', category: null, goalSats: null, endsAt: null, milestones: [] }

export const formFromProject = (p: Project): FormState => ({
  title: p.title,
  slug: p.slug,
  summary: p.summary,
  body: p.body,
  category: p.category,
  goalSats: p.goalSats,
  endsAt: p.endsAt,
  milestones: p.milestones,
})

/** Milestones being edited may be incomplete; only send the valid, sorted ones. */
export const cleanMilestones = (ms: Milestone[]) =>
  ms
    .filter((m) => m.sats > 0 && m.label.trim())
    .map((m) => ({ sats: m.sats, label: m.label.trim() }))
    .sort((a, b) => a.sats - b.sats)
    .filter((m, i, arr) => i === 0 || m.sats !== arr[i - 1]!.sats)

function diff(a: FormState, b: FormState): UpdateProjectRequest {
  const out: UpdateProjectRequest = {}
  if (a.title !== b.title) out.title = b.title
  if (a.slug !== b.slug) out.slug = b.slug
  if (a.summary !== b.summary) out.summary = b.summary
  if (a.body !== b.body) out.body = b.body
  if (a.category !== b.category) out.category = b.category
  if (a.goalSats !== b.goalSats) out.goalSats = b.goalSats
  if (a.endsAt !== b.endsAt) out.endsAt = b.endsAt
  const ma = JSON.stringify(cleanMilestones(a.milestones))
  const mb = JSON.stringify(cleanMilestones(b.milestones))
  if (ma !== mb) out.milestones = cleanMilestones(b.milestones)
  return out
}

export type SaveState = { kind: 'idle' } | { kind: 'dirty' } | { kind: 'saving' } | { kind: 'saved'; at: number } | { kind: 'error'; error: ApiError | Error }

/**
 * Local form + debounced autosave (PATCH only the changed fields) once the project exists.
 * Field errors from the server are returned by path so steps can show them inline.
 */
export function useProjectForm(project: Project | undefined) {
  const qc = useQueryClient()
  const [form, setForm] = useState<FormState>(() => (project ? formFromProject(project) : emptyForm))
  const saved = useRef<FormState>(project ? formFromProject(project) : emptyForm)
  const [save, setSave] = useState<SaveState>(project ? { kind: 'saved', at: project.updatedAt } : { kind: 'idle' })
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const inflight = useRef<Promise<void> | null>(null)
  const loadedId = useRef(project?.id)

  // Adopt the project once it loads (or after creation).
  useEffect(() => {
    if (project && loadedId.current !== project.id) {
      loadedId.current = project.id
      const f = formFromProject(project)
      saved.current = f
      setForm(f)
      setSave({ kind: 'saved', at: project.updatedAt })
    }
  }, [project])

  const flush = useCallback(async (): Promise<boolean> => {
    if (!project) return false
    await inflight.current
    const patch = diff(saved.current, form)
    if (Object.keys(patch).length === 0) return true
    setSave({ kind: 'saving' })
    const snapshot = form
    let ok = false
    inflight.current = (async () => {
      try {
        const updated = await api.updateProject(project.id, patch)
        saved.current = { ...snapshot, milestones: snapshot.milestones }
        qc.setQueryData(['project', project.id], updated)
        void qc.invalidateQueries({ queryKey: ['myProjects'] })
        setFieldErrors({})
        setSave({ kind: 'saved', at: Date.now() })
        ok = true
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e))
        if (e instanceof ApiError) {
          const errs: Record<string, string> = {}
          for (const i of e.issues ?? []) errs[i.path.split('.')[0] ?? ''] = i.message
          if (e.code === 'conflict' && patch.slug) errs.slug = 'slug_taken'
          if (e.code === 'goal_below_raised') errs.goalSats = 'goal_below_raised'
          setFieldErrors(errs)
        }
        setSave({ kind: 'error', error: err })
      }
    })()
    await inflight.current
    inflight.current = null
    return ok
  }, [project, form, qc])

  // Debounced autosave.
  useEffect(() => {
    if (!project) return
    if (Object.keys(diff(saved.current, form)).length === 0) return
    setSave((s) => (s.kind === 'saving' ? s : { kind: 'dirty' }))
    const t = setTimeout(() => void flush(), 1500)
    return () => clearTimeout(t)
  }, [form, project, flush])

  const set = useCallback(<K extends keyof FormState>(key: K, value: FormState[K]) => setForm((f) => ({ ...f, [key]: value })), [])

  return { form, set, setForm, save, flush, fieldErrors, setFieldErrors }
}
