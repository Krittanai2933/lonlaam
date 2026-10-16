import Anthropic from '@anthropic-ai/sdk'
import { DurableObject } from 'cloudflare:workers'
import { eq } from 'drizzle-orm'
import { getDb } from '../context'
import { projects } from '../db/schema'
import { needsTranslation, type TranslationText, translateToEnglish, translationSourceHash } from '../lib/translate'

/**
 * One instance per project (idFromName(projectId)). Keeps the English translation in
 * projects.*_en in step with the creator's text.
 *
 * The work runs in an alarm rather than waitUntil: a long story can take longer to
 * translate than waitUntil allows, and a failed alarm is retried by the runtime.
 * Edits are debounced, so saving several times in a row costs one translation.
 */

/** Wait this long after the last edit before translating. */
const DEBOUNCE_MS = 20_000
/** Alarm retries (with the runtime's backoff) before giving up on this version of the text. */
const MAX_RETRIES = 3
/** After giving up on a text, leave it alone this long. */
const FAILED_COOLDOWN_MS = 24 * 60 * 60_000

export class ProjectTranslator extends DurableObject<Env> {
  /**
   * `edit`: the creator just saved; (re)start the debounce. Otherwise (a view of a project
   * that has never been translated) only schedule when nothing is scheduled yet, so
   * traffic can't keep pushing the work back.
   */
  async request(projectId: string, edit: boolean): Promise<void> {
    if (!this.env.ANTHROPIC_API_KEY) return
    await this.ctx.storage.put('projectId', projectId)
    if (edit || (await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + (edit ? DEBOUNCE_MS : 0))
  }

  override async alarm(info?: AlarmInvocationInfo): Promise<void> {
    const projectId = await this.ctx.storage.get<string>('projectId')
    const apiKey = this.env.ANTHROPIC_API_KEY
    if (!projectId || !apiKey) return
    const db = getDb(this.env.DB)
    const row = await db.query.projects.findFirst({ where: eq(projects.id, projectId) })
    if (!row || row.status === 'draft') return

    const src: TranslationText = {
      title: row.title,
      summary: row.summary,
      body: row.body,
      milestones: row.milestones.map((m) => m.label),
    }
    const hash = await translationSourceHash(src)
    if (hash === row.enSourceHash) return
    // Don't keep paying for a text that just failed every retry (the next edit changes the
    // hash). Try again after a while in case it was an outage or a bad key since fixed.
    const failed = await this.ctx.storage.get<{ hash: string; at: number }>('failed')
    if (failed?.hash === hash && Date.now() - failed.at < FAILED_COOLDOWN_MS) return

    if (!needsTranslation(src)) {
      await db
        .update(projects)
        .set({ titleEn: null, summaryEn: null, bodyEn: null, milestonesEn: null, enSourceHash: hash })
        .where(eq(projects.id, projectId))
      return
    }

    let out: TranslationText
    try {
      out = await translateToEnglish(apiKey, src)
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e)
      // Bad key, bad request, etc. won't get better by retrying.
      const permanent = e instanceof Anthropic.APIError && e.status !== undefined && e.status < 500 && e.status !== 408 && e.status !== 429
      if (permanent || (info?.retryCount ?? 0) >= MAX_RETRIES) {
        console.error('translate: giving up', { project: projectId, error })
        await this.ctx.storage.put('failed', { hash, at: Date.now() })
        return
      }
      console.warn('translate failed, will retry', { project: projectId, error })
      throw e // the runtime retries the alarm with backoff
    }
    // If the creator edited meanwhile, request() has already scheduled another run that
    // will replace this; the slightly stale translation is better than none until then.
    await db
      .update(projects)
      .set({ titleEn: out.title, summaryEn: out.summary, bodyEn: out.body, milestonesEn: out.milestones, enSourceHash: hash })
      .where(eq(projects.id, projectId))
  }
}
