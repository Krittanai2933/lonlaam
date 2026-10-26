import type { LnurlAuthStartResponse, LoginResponse } from '@nampu/types'
import { Brand, Button, CopyButton, Dialog, Divider, Field, Icon, Input, Notice, Pulse, QRCode, Seg } from '@nampu/ui'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { api, errorText } from '../lib/api'
import { isOnboarded, useAuth } from '../lib/auth'
import { useIsDesktop } from '../lib/hooks'
import { useI18n } from '../lib/i18n'
import { BunkerInputError, hasNip07, loginWithBunker, loginWithExtension, startSignerApp } from '../lib/nostr'

type Tab = 'nostr' | 'ln'

/** 4a (mobile, tabs) / 4b (desktop, two-column modal). */
export default function LoginPage() {
  const desktop = useIsDesktop()
  const { t, toggleLang, lang } = useI18n()
  const done = useFinishLogin()
  const navigate = useNavigate()
  const [tab, setTab] = useState<Tab>('nostr')
  const close = () => navigate('/')

  if (desktop) {
    return (
      <div className="min-h-screen bg-bg">
        <Dialog open bare onClose={close} className="grid w-[760px] max-w-full grid-cols-2" labelledBy="login-title">
          <div className="flex flex-col gap-3 border-r border-divider p-8">
            <Brand size="dialog" />
            <div id="login-title" className="dialog-title text-[24px]">
              {t.loginTitle}
            </div>
            <p className="m-0 mb-1.5 text-sm text-neutral-700">{t.loginSub}</p>
            <h6 className="mt-1 mb-0 text-neutral-700">Nostr</h6>
            <NostrPanel desktop onLogin={done} />
            <p className="m-0 mt-auto text-xs text-neutral-600">{t.privacy}</p>
          </div>
          <div className="relative flex flex-col items-center gap-3 p-8">
            <Button variant="ghost" plain iconOnly icon="x" aria-label={t.close} onClick={close} className="absolute top-3 right-3" />
            <h6 className="self-start text-neutral-700">LNURL-auth</h6>
            <LnurlPanel qrSize={230} onLogin={done} desktop />
          </div>
        </Dialog>
      </div>
    )
  }

  return (
    <div className="flex min-h-screen flex-col">
      <div className="flex items-center justify-between px-3 pt-1">
        <Button variant="ghost" plain iconOnly icon="x" aria-label={t.close} onClick={close} />
        <Button variant="ghost" plain icon="globe" onClick={toggleLang}>
          {lang === 'th' ? 'EN' : 'TH'}
        </Button>
      </div>
      <div className="flex flex-1 flex-col px-6 pt-3 pb-6">
        <Brand size="page" />
        <h2 className="mt-3.5 mb-1 text-[24px] font-medium">{t.loginTitle}</h2>
        <p className="m-0 mb-5 text-sm text-neutral-700">{t.loginSub}</p>
        <Seg<Tab>
          full
          optClassName="h-10"
          aria-label={t.loginTitle}
          value={tab}
          onChange={setTab}
          options={[
            { value: 'nostr', label: 'Nostr', icon: 'key' },
            { value: 'ln', label: 'Lightning', icon: 'zap' },
          ]}
        />
        {tab === 'nostr' ? (
          <div className="mt-5 flex flex-col gap-3">
            <NostrPanel onLogin={done} />
          </div>
        ) : (
          <div className="mt-5 flex flex-col items-center gap-3">
            <LnurlPanel qrSize={220} onLogin={done} />
          </div>
        )}
        <p className="m-0 mt-auto pt-4 text-center text-xs text-neutral-600">{t.privacy}</p>
      </div>
    </div>
  )
}

/** After any successful login: new/incomplete accounts go to onboarding. */
function useFinishLogin() {
  const { signIn } = useAuth()
  const navigate = useNavigate()
  const from = (useLocation().state as { from?: string } | null)?.from ?? '/dashboard'
  return useCallback(
    (res: LoginResponse, nostrPubkey?: string) => {
      signIn(res)
      // Supporter pages (monthly sprinkle) work without a creator profile.
      if (!isOnboarded(res.creator) && !from.startsWith('/monthly')) navigate('/welcome', { replace: true, state: { from, nostrPubkey } })
      else navigate(from, { replace: true })
    },
    [signIn, navigate, from],
  )
}

type OnLogin = (res: LoginResponse, nostrPubkey?: string) => void

function NostrPanel({ desktop, onLogin }: { desktop?: boolean; onLogin: OnLogin }) {
  const { t } = useI18n()
  const [busy, setBusy] = useState<'ext' | 'signer' | 'bunker' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [bunker, setBunker] = useState('')
  const [signerUri, setSignerUri] = useState<string | null>(null)
  const abort = useRef<AbortController | null>(null)
  const ext = hasNip07()
  useEffect(() => () => abort.current?.abort(), [])

  const run = async (kind: 'ext' | 'signer' | 'bunker', fn: () => Promise<{ login: LoginResponse; pubkey: string }>) => {
    setBusy(kind)
    setError(null)
    try {
      const { login, pubkey } = await fn()
      onLogin(login, pubkey)
    } catch (e) {
      if ((e as Error).name === 'AbortError') return
      setError(e instanceof BunkerInputError ? t.bunkerInvalid : `${t.loginFailed}: ${errorText(e, t)}`)
    } finally {
      setBusy(null)
      setSignerUri(null)
    }
  }

  const signerApp = () =>
    run('signer', async () => {
      abort.current?.abort()
      abort.current = new AbortController()
      const { uri, done } = await startSignerApp(abort.current.signal)
      setSignerUri(uri)
      window.location.href = uri // opens Amber / nsec.app via the nostrconnect: scheme
      return done
    })

  const connectBunker = () => bunker.trim() && run('bunker', () => loginWithBunker(bunker, (url) => window.open(url, '_blank', 'noopener')))

  return (
    <>
      <Button
        variant="primary"
        className={desktop ? 'h-[46px] justify-between px-3.5' : 'h-[52px] justify-between px-4 text-base'}
        style={desktop ? undefined : { color: 'var(--color-accent)' }}
        disabled={!ext || busy !== null}
        onClick={() => run('ext', loginWithExtension)}
      >
        <span className="flex items-center gap-2">
          <Icon name="key" />
          {t.extension}
        </span>
        <span className="font-body text-[11px] opacity-80">{busy === 'ext' ? '…' : 'NIP-07'}</span>
      </Button>
      {!desktop && (
        <>
          <Button variant="secondary" className="h-[52px] justify-between px-4 text-base" disabled={busy !== null && busy !== 'signer'} onClick={signerApp}>
            <span className="flex items-center gap-2">
              <Icon name="user" />
              {busy === 'signer' ? t.signerWaiting : t.signer}
            </span>
            <span className="font-body text-[11px] opacity-70">NIP-46</span>
          </Button>
          {signerUri && <CopyButton text={signerUri} label={t.copyLink} copiedLabel={t.copied} className="h-10" />}
          <Divider>{t.orBunker}</Divider>
        </>
      )}
      <Field label={t.bunkerLabel}>
        {(id) =>
          desktop ? (
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault()
                void connectBunker()
              }}
            >
              <Input id={id} placeholder="bunker://…" value={bunker} onChange={(e) => setBunker(e.target.value)} />
              <Button type="submit" variant="secondary" className="shrink-0 whitespace-nowrap" loading={busy === 'bunker'} disabled={!bunker.trim()}>
                {t.connect}
              </Button>
            </form>
          ) : (
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault()
                void connectBunker()
              }}
            >
              <Input id={id} className="min-h-11" placeholder={t.bunkerPlaceholderMobile} value={bunker} onChange={(e) => setBunker(e.target.value)} />
              {bunker.trim() && (
                <Button type="submit" variant="secondary" className="h-11 shrink-0 whitespace-nowrap" loading={busy === 'bunker'}>
                  {t.connect}
                </Button>
              )}
            </form>
          )
        }
      </Field>
      {!ext && <Notice tone="danger">{t.noExt}</Notice>}
      {error && <Notice tone="danger">{error}</Notice>}
    </>
  )
}

function LnurlPanel({ qrSize, onLogin, desktop }: { qrSize: number; onLogin: OnLogin; desktop?: boolean }) {
  const { t } = useI18n()
  const [session, setSession] = useState<LnurlAuthStartResponse | null>(null)
  const [state, setState] = useState<'loading' | 'waiting' | 'expired' | 'error'>('loading')

  // Bumping `attempt` starts a fresh challenge; stale responses (StrictMode, retries) are ignored.
  const [attempt, setAttempt] = useState(0)
  const start = useCallback(() => setAttempt((n) => n + 1), [])
  useEffect(() => {
    let live = true
    setState('loading')
    api
      .lnurlStart()
      .then((s) => {
        if (!live) return
        setSession(s)
        setState('waiting')
      })
      .catch(() => live && setState('error'))
    return () => {
      live = false
    }
  }, [attempt])

  useEffect(() => {
    if (state !== 'waiting' || !session) return
    let stop = false
    const tick = async () => {
      if (stop) return
      if (Date.now() > session.expiresAt) return setState('expired')
      try {
        const r = await api.lnurlPoll(session.k1, session.pollToken)
        if (stop) return
        if (r.status === 'ok') return onLogin(r)
        if (r.status === 'expired') return setState('expired')
      } catch {
        // transient; keep polling
      }
      timer = setTimeout(tick, 2000)
    }
    let timer = setTimeout(tick, 2000)
    return () => {
      stop = true
      clearTimeout(timer)
    }
  }, [state, session, onLogin])

  const lnurl = session?.lnurl.toUpperCase() ?? ''
  return (
    <>
      {state === 'waiting' && session ? (
        <QRCode value={lnurl} size={qrSize} label="LNURL-auth QR" />
      ) : (
        <div className="grid place-items-center rounded-[6px] border border-divider text-center" style={{ width: qrSize, height: qrSize }}>
          {state === 'loading' ? (
            <span className="inline-block size-5 animate-np-spin rounded-full border-[1.5px] border-accent border-r-transparent" />
          ) : (
            <div className="flex flex-col items-center gap-2 px-4 text-sm text-neutral-700">
              {state === 'expired' ? t.loginExpired : t.somethingWrong}
              <Button variant="secondary" icon="refresh" onClick={start}>
                {t.retry}
              </Button>
            </div>
          )}
        </div>
      )}
      <div className="flex items-center gap-2 text-sm">
        <Pulse />
        {t.scanWait}
      </div>
      <p className={desktop ? 'm-0 text-center text-[13px] text-neutral-700' : 'm-0 max-w-[300px] text-center text-[13px] text-neutral-700'}>{t.lnHelp}</p>
      {desktop ? (
        <CopyButton text={lnurl} label={t.copyLink} copiedLabel={t.copied} />
      ) : (
        <div className="flex w-full gap-2">
          <CopyButton text={lnurl} label={t.copyLink} copiedLabel={t.copied} className="h-11 flex-1" />
          <a className="btn btn-primary h-11 flex-1" href={`lightning:${lnurl}`} aria-disabled={!session}>
            <Icon name="wallet" />
            {t.openWallet}
          </a>
        </div>
      )}
    </>
  )
}
