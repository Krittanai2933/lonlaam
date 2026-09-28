import type { WsServerMessage } from '@nampu/types'
import { WS_PING } from '@nampu/types'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'

/** Desktop layouts (6b/5b/4b) from 1024px; mobile (6a/5a/4a) below. */
export function useIsDesktop() {
  return useMediaQuery('(min-width: 1024px)')
}

export function useMediaQuery(q: string) {
  return useSyncExternalStore(
    (cb) => {
      const m = window.matchMedia(q)
      m.addEventListener('change', cb)
      return () => m.removeEventListener('change', cb)
    },
    () => window.matchMedia(q).matches,
    () => false,
  )
}

/** Re-render every `ms` (for "2 นาทีที่แล้ว" labels). */
export function useNow(ms = 30_000) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(t)
  }, [ms])
  return now
}

/** Live project events (Durable Object WebSocket). Reconnects with backoff; pings every 25s. */
export function useProjectSocket(slug: string | null, onMessage: (m: WsServerMessage) => void) {
  const cb = useRef(onMessage)
  cb.current = onMessage
  useEffect(() => {
    if (!slug) return
    let ws: WebSocket | null = null
    let closed = false
    let retry = 0
    let ping: ReturnType<typeof setInterval> | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws'
      ws = new WebSocket(`${proto}://${location.host}/api/p/${encodeURIComponent(slug)}/ws`)
      ws.onopen = () => {
        retry = 0
        ping = setInterval(() => ws?.readyState === WebSocket.OPEN && ws.send(WS_PING), 25_000)
      }
      ws.onmessage = (e) => {
        if (typeof e.data !== 'string' || e.data === 'pong') return
        try {
          cb.current(JSON.parse(e.data) as WsServerMessage)
        } catch {
          // ignore malformed frames
        }
      }
      ws.onclose = () => {
        clearInterval(ping)
        if (!closed) timer = setTimeout(connect, Math.min(30_000, 1000 * 2 ** retry++))
      }
    }
    connect()
    return () => {
      closed = true
      clearTimeout(timer)
      clearInterval(ping)
      ws?.close()
    }
  }, [slug])
}
