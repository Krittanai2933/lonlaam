import type { LoginResponse } from '@nampu/types'
import { eq } from 'drizzle-orm'
import type { Db } from '../context'
import { creators, sessions } from '../db/schema'
import { encodeNpub } from './bech32'
import { newId, newToken, sha256Hex } from './util'
import { toCreator } from '../serialize'

export const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000

type Identity = { kind: 'nostr'; pubkey: string } | { kind: 'lnurl'; key: string }

/** Finds or creates the creator for a verified login identity, then opens a session. */
export async function loginWith(db: Db, identity: Identity): Promise<LoginResponse> {
  const column = identity.kind === 'nostr' ? creators.nostrPubkey : creators.lnurlAuthKey
  const value = identity.kind === 'nostr' ? identity.pubkey : identity.key
  const now = Date.now()

  let creator = await db.query.creators.findFirst({ where: eq(column, value) })
  let isNew = false
  if (!creator) {
    // ON CONFLICT DO NOTHING + re-read handles two simultaneous first logins.
    await db
      .insert(creators)
      .values({
        id: newId(),
        ...(identity.kind === 'nostr'
          ? { nostrPubkey: identity.pubkey, npub: encodeNpub(identity.pubkey) }
          : { lnurlAuthKey: identity.key }),
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
    creator = await db.query.creators.findFirst({ where: eq(column, value) })
    if (!creator) throw new Error('creator insert failed')
    isNew = true
  }

  const token = newToken()
  await db.insert(sessions).values({
    tokenHash: await sha256Hex(token),
    creatorId: creator.id,
    createdAt: now,
    expiresAt: now + SESSION_TTL_MS,
  })
  return { token, creator: toCreator(creator), isNew }
}
