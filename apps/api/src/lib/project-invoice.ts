import { type Db, lnurlOptions } from '../context'
import { isUniqueViolation } from '../db/errors'
import { type InvoiceRow, invoices } from '../db/schema'
import { MAX_PENDING } from '../do/project-room'
import { Bolt11Error, decodeBolt11 } from '../lightning/bolt11'
import { fetchPayRequest, requestInvoice } from '../lightning/lnurl'
import { ApiError } from './errors'
import { newId } from './util'

export const roomFor = (env: Env, projectId: string) => env.PROJECT_ROOM.get(env.PROJECT_ROOM.idFromName(projectId))

/**
 * Non-custodial project invoice: issued by the creator's own wallet via LNURL-pay
 * (2 subrequests), stored as pending, and tracked by the project's Durable Object, which
 * polls its LUD-21 verify URL. Used by direct support and by sprinkle payouts.
 */
export async function createProjectInvoice(
  env: Env,
  db: Db,
  projectId: string,
  lightningAddress: string,
  input: { amountSats: number; supporterName?: string | null; supporterPubkey?: string | null; comment?: string | null },
): Promise<InvoiceRow> {
  const opts = lnurlOptions(env)
  const amountMsat = input.amountSats * 1000
  const pay = await fetchPayRequest(lightningAddress, opts)
  if (amountMsat < pay.minSendable || amountMsat > pay.maxSendable) {
    throw new ApiError(
      422,
      'amount_out_of_range',
      `amount must be between ${Math.ceil(pay.minSendable / 1000)} and ${Math.floor(pay.maxSendable / 1000)} sats`,
    )
  }
  const cb = await requestInvoice(pay, amountMsat, input.comment || undefined, opts)

  let decoded
  try {
    decoded = decodeBolt11(cb.pr)
  } catch (e) {
    throw new ApiError(502, 'lnurl_error', `LNURL: wallet returned an invalid invoice (${e instanceof Bolt11Error ? e.message : 'decode failed'})`)
  }
  if (decoded.amountMsat !== amountMsat) throw new ApiError(502, 'lnurl_error', 'LNURL: invoice amount does not match request')
  const now = Date.now()
  const expiresAt = (decoded.timestamp + decoded.expiry) * 1000
  if (expiresAt <= now + 30_000) throw new ApiError(502, 'lnurl_error', 'LNURL: invoice is already expired')

  const id = newId()
  // Register with the DO before the row exists: if the insert then fails, the DO just
  // polls an unknown invoice until expiry and its conditional updates match nothing.
  const tracked = await roomFor(env, projectId).trackInvoice({
    id,
    projectId,
    verifyUrl: cb.verify,
    paymentHash: decoded.paymentHash,
    amountMsat,
    createdAt: now,
    expiresAt,
  })
  if (!tracked.ok) {
    throw new ApiError(429, 'rate_limited', `too many unpaid invoices for this project (max ${MAX_PENDING}); try again shortly`)
  }

  try {
    const [row] = await db
      .insert(invoices)
      .values({
        id,
        projectId,
        amountMsat,
        supporterName: input.supporterName || null,
        supporterPubkey: input.supporterPubkey || null,
        comment: input.comment || null,
        bolt11: cb.pr,
        paymentHash: decoded.paymentHash,
        verifyUrl: cb.verify,
        createdAt: now,
        expiresAt,
      })
      .returning()
    return row!
  } catch (e) {
    if (isUniqueViolation(e)) throw new ApiError(502, 'lnurl_error', 'LNURL: wallet reused a payment hash')
    throw e
  }
}
