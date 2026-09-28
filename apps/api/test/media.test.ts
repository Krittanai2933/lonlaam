import { describe, expect, it } from 'vitest'
import { mediaBase } from '../src/context'
import { coverUrl, rewriteMedia } from '../src/serialize'

const env = (vars: Partial<Record<'PUBLIC_ORIGIN' | 'MEDIA_ORIGIN', string>>) => ({ PUBLIC_ORIGIN: '', MEDIA_ORIGIN: '', ...vars }) as unknown as Env

describe('mediaBase', () => {
  it('uses the R2 public domain when MEDIA_ORIGIN is set', () => {
    expect(mediaBase(env({ PUBLIC_ORIGIN: 'https://lonlaam.com', MEDIA_ORIGIN: 'https://media.lonlaam.com' }), 'https://lonlaam.com/api/p/x')).toBe(
      'https://media.lonlaam.com',
    )
  })

  it('falls back to the Worker /media route (local dev)', () => {
    expect(mediaBase(env({}), 'http://localhost:8787/api/p/x')).toBe('http://localhost:8787/media')
  })
})

describe('coverUrl', () => {
  it('joins the base and the R2 key', () => {
    expect(coverUrl('https://media.lonlaam.com', 'covers/p1/abc.jpg')).toBe('https://media.lonlaam.com/covers/p1/abc.jpg')
    expect(coverUrl('https://media.lonlaam.com', null)).toBeNull()
  })
})

describe('rewriteMedia', () => {
  const media = 'https://media.lonlaam.com'

  it('points stored story images on any old host at the media base', () => {
    const body = [
      '![a](https://nampu.np99r7skf9.workers.dev/media/images/p1/aaa.png)',
      '<img src="https://lonlaam.com/media/images/p1/bbb.webp">',
      '![c](http://localhost:8787/media/covers/p1/ccc.jpg "title")',
    ].join('\n')
    expect(rewriteMedia(body, media)).toBe(
      [
        '![a](https://media.lonlaam.com/images/p1/aaa.png)',
        '<img src="https://media.lonlaam.com/images/p1/bbb.webp">',
        '![c](https://media.lonlaam.com/covers/p1/ccc.jpg "title")',
      ].join('\n'),
    )
  })

  it('leaves other URLs and non-media paths alone', () => {
    const body = 'see https://example.com/media/docs/x.pdf and https://lonlaam.com/p/slug and https://lonlaam.com/media/images/p1/x.svg'
    expect(rewriteMedia(body, media)).toBe(body)
  })

  it('is idempotent', () => {
    const once = rewriteMedia('![a](https://lonlaam.com/media/images/p1/a.gif)', media)
    expect(rewriteMedia(once, media)).toBe(once)
  })
})
