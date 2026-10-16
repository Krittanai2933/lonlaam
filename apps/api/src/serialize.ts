import type { Creator, Invoice, Project, ProjectTranslation, PublicProject, Supporter } from '@nampu/types'
import type { CreatorRow, InvoiceRow, ProjectRow } from './db/schema'
import { sourceText, translationSourceHash } from './lib/translate'
import { msatToSats } from './lib/util'

/** `media` is mediaBase(): the R2 public domain or <origin>/media. */
export const coverUrl = (media: string, key: string | null) => (key ? `${media}/${key}` : null)

// Story images are stored in the markdown as absolute URLs, possibly on an old host
// (workers.dev, <origin>/media). Point them at the current media base on read.
const STORED_MEDIA = /https?:\/\/[^\s/()"'<>]+\/media\/((?:covers|images)\/[\w-]+\/[\w-]+\.(?:jpg|png|webp|gif))/g
export const rewriteMedia = (body: string, media: string) => body.replace(STORED_MEDIA, `${media}/$1`)

export function toCreator(r: CreatorRow): Creator {
  return {
    id: r.id,
    handle: r.handle,
    displayName: r.displayName,
    lightningAddress: r.lightningAddress,
    npub: r.npub,
    logins: { nostr: r.nostrPubkey !== null, lnurl: r.lnurlAuthKey !== null },
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }
}

/** Projects only exist for onboarded creators, so handle/displayName are set in practice. */
export type ProjectCreator = Pick<CreatorRow, 'handle' | 'displayName' | 'npub'>

function toTranslation(r: ProjectRow, media: string): ProjectTranslation | null {
  if (r.titleEn === null) return null
  // Milestones added or removed since the translation keep their original labels until the next one.
  const labels = r.milestonesEn?.length === r.milestones.length ? r.milestonesEn : []
  return {
    lang: 'en',
    by: r.enManual ? 'creator' : 'machine',
    title: r.titleEn,
    summary: r.summaryEn ?? '',
    body: rewriteMedia(r.bodyEn ?? '', media),
    milestones: r.milestones.map((m, i) => ({ sats: m.sats, label: labels[i] || m.label })),
  }
}

export function toProject(r: ProjectRow, creator: ProjectCreator, media: string): Omit<Project, 'translationStale'> {
  return {
    id: r.id,
    slug: r.slug,
    title: r.title,
    summary: r.summary,
    body: rewriteMedia(r.body, media),
    coverUrl: coverUrl(media, r.coverKey),
    category: r.category,
    goalSats: r.goalSats,
    milestones: r.milestones,
    endsAt: r.endsAt,
    raisedSats: msatToSats(r.raisedMsat),
    supporterCount: r.supporterCount,
    status: r.status,
    creator: { handle: creator.handle ?? '', displayName: creator.displayName ?? '', npub: creator.npub },
    publishedAt: r.publishedAt,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    translation: toTranslation(r, media),
  }
}

/** Owner view, including whether the creator's English version predates their last Thai edit. */
export async function toOwnerProject(r: ProjectRow, creator: ProjectCreator, media: string): Promise<Project> {
  const translationStale = r.enManual && r.enSourceHash !== (await translationSourceHash(sourceText(r)))
  return { ...toProject(r, creator, media), translationStale }
}

export function toPublicProject(r: ProjectRow, creator: ProjectCreator, media: string): PublicProject {
  const { updatedAt: _u, status, ...rest } = toProject(r, creator, media)
  if (status === 'draft') throw new Error('draft projects are not public')
  return { ...rest, status }
}

export function toInvoice(r: InvoiceRow): Invoice {
  return {
    id: r.id,
    projectId: r.projectId,
    amountSats: msatToSats(r.amountMsat),
    bolt11: r.bolt11,
    status: r.status,
    createdAt: r.createdAt,
    expiresAt: r.expiresAt,
    paidAt: r.paidAt,
  }
}

export function toSupporter(r: Pick<InvoiceRow, 'id' | 'supporterName' | 'supporterPubkey' | 'comment' | 'amountMsat' | 'paidAt'>): Supporter {
  return {
    invoiceId: r.id,
    name: r.supporterName,
    pubkey: r.supporterPubkey,
    comment: r.comment,
    amountSats: msatToSats(r.amountMsat),
    paidAt: r.paidAt ?? 0,
  }
}
