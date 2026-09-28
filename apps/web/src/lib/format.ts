import type { Lang } from './i18n'

/** 3,420,000 — Latin digits with commas in both languages (design uses en-US). */
export const fmt = (n: number) => Math.round(n).toLocaleString('en-US')

/** 3.42M / 412k — card summaries (nampu-kit `short`). */
export function short(n: number): string {
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 1 : 2).replace(/\.?0+$/, '') + 'M'
  if (n >= 1e3) return Math.round(n / 1e3) + 'k'
  return String(n)
}

/** "12 ต.ค. 2026" / "12 Oct 2026" — Gregorian year in Thai too, as in the design. */
export function fmtDate(ms: number, lang: Lang): string {
  return new Intl.DateTimeFormat(lang === 'th' ? 'th-TH-u-ca-gregory' : 'en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).format(ms)
}

type AgoDict = { now: string; m: string; h: string; yesterday: string; d: string }

/** "2 นาที", "1 ชม.", "เมื่อวาน", "3 วัน" — relative, coarse. */
export function ago(ms: number, dict: AgoDict, now = Date.now()): string {
  const s = Math.max(0, (now - ms) / 1000)
  const fill = (t: string, n: number) => t.replace('{n}', String(n))
  if (s < 60) return dict.now
  if (s < 3600) return fill(dict.m, Math.floor(s / 60))
  if (s < 86400) return fill(dict.h, Math.floor(s / 3600))
  if (s < 2 * 86400) return dict.yesterday
  return fill(dict.d, Math.floor(s / 86400))
}

/** Whole days left until `endsAt`, never negative. */
export const daysLeft = (endsAt: number, now = Date.now()) => Math.max(0, Math.ceil((endsAt - now) / 86_400_000))

/** Suggest a slug from a title; Thai-only titles yield '' (the user types one). */
export function slugify(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '')
}
