import type { PublicProject } from '@nampu/types'
import { Button, cx } from '@nampu/ui'
import { useEffect, useState } from 'react'
import { useI18n } from '../lib/i18n'
import { RELAYS } from '../lib/nostr'

export const projectUrl = (slug: string) => `${location.origin}/p/${slug}`

/**
 * Nostr + X share (2c / success). Nostr: with a NIP-07 extension we sign a kind-1 note and
 * publish it to a few relays; without one we copy the text so it can be pasted into any client.
 */
export function ShareButtons({ project, className, size = 'md' }: { project: PublicProject; className?: string; size?: 'md' | 'lg' }) {
  const { t, f } = useI18n()
  const [note, setNote] = useState<string | null>(null)
  useEffect(() => {
    if (!note) return
    const x = setTimeout(() => setNote(null), 2000)
    return () => clearTimeout(x)
  }, [note])
  const url = projectUrl(project.slug)
  const text = f(t.shareText, { title: project.title })

  const nostr = async () => {
    const content = `${text}\n${url}`
    if (window.nostr) {
      try {
        const ev = await window.nostr.signEvent({ kind: 1, created_at: Math.floor(Date.now() / 1000), tags: [['r', url]], content })
        await Promise.any(
          RELAYS.map(
            (r) =>
              new Promise<void>((resolve, reject) => {
                const ws = new WebSocket(r)
                const to = setTimeout(() => (ws.close(), reject(new Error('timeout'))), 4000)
                ws.onopen = () => ws.send(JSON.stringify(['EVENT', ev]))
                ws.onmessage = (m) => {
                  const msg = JSON.parse(String(m.data)) as unknown[]
                  if (msg[0] === 'OK') {
                    clearTimeout(to)
                    ws.close()
                    msg[2] ? resolve() : reject(new Error(String(msg[3])))
                  }
                }
                ws.onerror = () => (clearTimeout(to), reject(new Error('relay error')))
              }),
          ),
        )
        return setNote(t.shared)
      } catch {
        // declined or relays failed → fall back to copying
      }
    }
    await navigator.clipboard.writeText(content)
    setNote(t.linkCopied)
  }

  const h = size === 'lg' ? 'h-11' : undefined
  return (
    <div className={cx('flex gap-2', className)}>
      <Button variant="secondary" icon={note ? 'check' : 'share'} className={cx('flex-1', h)} onClick={() => void nostr()}>
        {note ?? 'Nostr'}
      </Button>
      <a className={cx('btn btn-secondary flex-1', h)} href={`https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`} target="_blank" rel="noreferrer">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ display: 'block' }}>
          <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" />
          <polyline points="16 6 12 2 8 6" />
          <line x1="12" x2="12" y1="2" y2="15" />
        </svg>
        X
      </a>
    </div>
  )
}
