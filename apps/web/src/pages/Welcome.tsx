import { LIMITS } from '@nampu/types'
import { Brand, Button, Field, Input, Notice } from '@nampu/ui'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { api, ApiError } from '../lib/api'
import { meKey, useAuth } from '../lib/auth'
import { slugify } from '../lib/format'
import { useI18n } from '../lib/i18n'
import { fetchProfile } from '../lib/nostr'

const HANDLE_RE = new RegExp(LIMITS.handle.pattern)

/**
 * Onboarding after the first login (added: the design only mentions it in its
 * "next" notes). Same composition as the Login screen: brand, title, fields, one CTA.
 */
export default function WelcomePage() {
  const { t } = useI18n()
  const { creator } = useAuth()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const state = useLocation().state as { from?: string; nostrPubkey?: string } | null
  const [displayName, setDisplayName] = useState(creator?.displayName ?? '')
  const [handle, setHandle] = useState(creator?.handle ?? '')
  const [handleEdited, setHandleEdited] = useState(!!creator?.handle)
  const [prefilled, setPrefilled] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [handleError, setHandleError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Prefill from the Nostr kind-0 profile when we know the pubkey.
  useEffect(() => {
    if (!state?.nostrPubkey || creator?.displayName) return
    let live = true
    void fetchProfile(state.nostrPubkey).then((p) => {
      if (!live || !p) return
      const name = (p.display_name || p.displayName || p.name || '').trim().slice(0, LIMITS.displayName.max)
      if (!name) return
      setDisplayName((d) => d || name)
      setHandle((h) => h || slugify(p.name || name).slice(0, LIMITS.handle.max))
      setPrefilled(true)
    })
    return () => {
      live = false
    }
  }, [state?.nostrPubkey, creator?.displayName])

  const handleOk = handle.length >= LIMITS.handle.min && HANDLE_RE.test(handle)
  const canSubmit = displayName.trim().length >= LIMITS.displayName.min && handleOk

  const submit = async () => {
    setBusy(true)
    setError(null)
    setHandleError(null)
    try {
      const me = await api.updateMe({ displayName: displayName.trim(), handle })
      qc.setQueryData(meKey, me)
      navigate(state?.from && state.from !== '/welcome' ? state.from : '/dashboard', { replace: true })
    } catch (e) {
      if (e instanceof ApiError && e.code === 'conflict') setHandleError(t.handleTaken)
      else setError(e instanceof Error ? e.message : t.somethingWrong)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-screen justify-center px-6 pt-12 pb-6 lg:items-center lg:pt-6">
      <form
        className="flex w-full max-w-[400px] flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault()
          if (canSubmit) void submit()
        }}
      >
        <Brand size="page" />
        <div>
          <h2 className="mt-1.5 mb-1 text-[24px] font-medium">{t.welcomeTitle}</h2>
          <p className="m-0 text-sm text-neutral-700">{t.welcomeSub}</p>
        </div>
        {prefilled && <div className="text-xs text-neutral-600">{t.prefilled}</div>}
        <Field label={t.fDisplayName}>
          {(id) => (
            <Input
              id={id}
              className="min-h-11"
              autoFocus
              maxLength={LIMITS.displayName.max}
              value={displayName}
              onChange={(e) => {
                setDisplayName(e.target.value)
                if (!handleEdited) setHandle(slugify(e.target.value).slice(0, LIMITS.handle.max))
              }}
            />
          )}
        </Field>
        <Field label={t.fHandle} hint={t.handleHint} error={handleError ?? (handle && !handleOk ? t.handleHint : null)}>
          {(id) => (
            <div className="flex min-h-11 items-center rounded-md border border-divider pl-2.5 focus-within:border-accent">
              <span className="text-sm text-neutral-600">@</span>
              <input
                id={id}
                className="tnum min-h-11 w-full bg-transparent pr-2.5 pl-0.5 text-sm outline-none"
                maxLength={LIMITS.handle.max}
                autoCapitalize="none"
                spellCheck={false}
                value={handle}
                onChange={(e) => {
                  setHandleEdited(true)
                  setHandle(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))
                }}
              />
            </div>
          )}
        </Field>
        {error && <Notice tone="danger">{error}</Notice>}
        <Button type="submit" variant="cta" className="mt-2 h-12 text-base" disabled={!canSubmit} loading={busy}>
          {t.continue}
        </Button>
      </form>
    </div>
  )
}
