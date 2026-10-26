/**
 * Transactional email through Resend's HTTP API (one subrequest, no SDK so the bundle stays
 * Workers-native). Off unless RESEND_API_KEY is set; EMAIL_FROM must be on a domain verified
 * in Resend. RESEND_API_URL only exists for local dev, where the mock wallet captures mail.
 */

export const emailEnabled = (env: Env) => !!env.RESEND_API_KEY && !!env.EMAIL_FROM

/** Canonical origin for links in background jobs (no request to take it from). */
export const siteOrigin = (env: Env) => env.PUBLIC_ORIGIN || 'http://localhost:5173'

/** Returns whether the provider accepted it; never throws. */
export async function sendEmail(env: Env, msg: { to: string; subject: string; text: string }): Promise<boolean> {
  if (!emailEnabled(env)) return false
  try {
    const res = await fetch(env.RESEND_API_URL || 'https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: env.EMAIL_FROM, to: [msg.to], subject: msg.subject, text: msg.text }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) console.error('email: send failed', { status: res.status, body: (await res.text()).slice(0, 300) })
    return res.ok
  } catch (e) {
    console.error('email: send failed', e instanceof Error ? e.message : e)
    return false
  }
}
