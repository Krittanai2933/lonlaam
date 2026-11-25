import type { Milestone, ProjectTranslation, RewardText } from '@nampu/types'
import type { Lang } from './i18n'

interface Translatable {
  title: string
  summary: string
  translation: (Pick<ProjectTranslation, 'title' | 'summary'> & Partial<Pick<ProjectTranslation, 'body' | 'milestones' | 'rewards'>>) | null
}

/** The project with its creator text swapped for the English machine translation, when the UI is in English and one exists. */
export function localized<T extends Translatable & { body?: string; milestones?: Milestone[]; rewards?: (RewardText & { id: string })[] }>(p: T, lang: Lang): T {
  const tr = p.translation
  if (lang !== 'en' || !tr) return p
  return {
    ...p,
    title: tr.title,
    summary: tr.summary,
    ...(tr.body !== undefined && { body: tr.body }),
    ...(tr.milestones !== undefined && { milestones: tr.milestones }),
    ...(tr.rewards !== undefined && p.rewards && { rewards: p.rewards.map((r) => ({ ...r, ...tr.rewards!.find((x) => x.id === r.id) })) }),
  }
}
