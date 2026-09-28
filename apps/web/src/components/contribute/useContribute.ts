import type { Invoice, PublicProject } from '@nampu/types'
import { useCallback, useEffect, useRef, useState } from 'react'
import { api, ApiError } from '../../lib/api'

export type FlowState = 'amount' | 'loading' | 'invoice' | 'expired' | 'error' | 'success'

export const PRESETS = [1000, 5000, 10000, 21000, 50000, 100000]

/**
 * Contribute state machine (Invoice Sheet states): amount → loading → invoice → success | expired,
 * with error from loading. Payment is detected via the project's WebSocket (?invoice=<id>) with a
 * GET /api/invoices/:id poll as a fallback (5s while the socket is down, 30s otherwise).
 */
export function useContribute(project: PublicProject) {
  const [state, setState] = useState<FlowState>('amount')
  const [amount, setAmount] = useState(21000)
  const [anon, setAnon] = useState(false)
  const [name, setName] = useState('')
  const [message, setMessage] = useState('')
  const [invoice, setInvoice] = useState<Invoice | null>(null)
  const [error, setError] = useState<ApiError | Error | null>(null)
  const [amountError, setAmountError] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now)
  const reqId = useRef(0)

  const create = useCallback(async () => {
    const id = ++reqId.current
    setState('loading')
    setError(null)
    setAmountError(null)
    try {
      const inv = await api.createInvoice(project.slug, {
        amountSats: amount,
        ...(!anon && name.trim() && { supporterName: name.trim() }),
        ...(message.trim() && { comment: message.trim() }),
      })
      if (id !== reqId.current) return
      setInvoice(inv)
      setState('invoice')
    } catch (e) {
      if (id !== reqId.current) return
      // Amount problems belong on the amount step, not the error screen.
      if (e instanceof ApiError && (e.code === 'amount_out_of_range' || e.code === 'validation_failed')) {
        setAmountError(e.message)
        setState('amount')
        return
      }
      setError(e instanceof Error ? e : new Error(String(e)))
      setState('error')
    }
  }, [project.slug, amount, anon, name, message])

  const reset = useCallback(() => {
    reqId.current++
    setInvoice(null)
    setState('amount')
  }, [])

  // Countdown + expiry.
  useEffect(() => {
    if (state !== 'invoice' || !invoice) return
    const t = setInterval(() => {
      const n = Date.now()
      setNow(n)
      if (n >= invoice.expiresAt) setState('expired')
    }, 1000)
    return () => clearInterval(t)
  }, [state, invoice])

  // Settlement: WebSocket subscription for this invoice + polling fallback.
  useEffect(() => {
    if (state !== 'invoice' || !invoice) return
    let done = false
    const finish = (paid: Invoice | null, status: 'paid' | 'expired') => {
      if (done) return
      done = true
      if (paid) setInvoice(paid)
      setState(status === 'paid' ? 'success' : 'expired')
    }
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${proto}://${location.host}/api/p/${encodeURIComponent(project.slug)}/ws?invoice=${invoice.id}`)
    ws.onmessage = (e) => {
      if (typeof e.data !== 'string' || e.data === 'pong') return
      try {
        const m = JSON.parse(e.data) as { type: string; invoiceId?: string; status?: 'paid' | 'expired' }
        if (m.type === 'invoice' && m.invoiceId === invoice.id && m.status) {
          void api.invoice(invoice.id).then((inv) => finish(inv, m.status!), () => finish(null, m.status!))
        }
      } catch {
        // ignore
      }
    }
    // The WebSocket is the primary signal. Poll every 5s only while it is down; otherwise
    // every 30s as a safety net (each poll is a Worker request against the daily quota).
    let lastPoll = Date.now()
    const poll = setInterval(async () => {
      if (ws.readyState === WebSocket.OPEN && Date.now() - lastPoll < 30_000) return
      lastPoll = Date.now()
      try {
        const inv = await api.invoice(invoice.id)
        if (inv.status !== 'pending') finish(inv, inv.status)
      } catch {
        // transient
      }
    }, 5000)
    return () => {
      done = true
      clearInterval(poll)
      ws.close()
    }
  }, [state, invoice, project.slug])

  const secsLeft = invoice ? Math.max(0, Math.round((invoice.expiresAt - now) / 1000)) : 0
  return {
    state,
    amount,
    setAmount: (n: number) => {
      setAmount(n)
      setAmountError(null)
    },
    anon,
    setAnon,
    name,
    setName,
    message,
    setMessage,
    invoice,
    error,
    amountError,
    secsLeft,
    create,
    reset,
    /** Pending invoice the user might lose by closing. */
    hasLiveInvoice: state === 'invoice',
  }
}

export type Contribute = ReturnType<typeof useContribute>

export const clock = (secs: number) => `${String(Math.floor(secs / 60)).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}`
