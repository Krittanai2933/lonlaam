import { describe, expect, it } from 'vitest'
import { checkTranslation, needsTranslation, type TranslationText, translationSourceHash } from '../src/lib/translate'

const text = (over: Partial<TranslationText> = {}): TranslationText => ({ title: '', summary: '', body: '', milestones: [], ...over })

describe('needsTranslation', () => {
  it('translates Thai, including Thai with some English terms', () => {
    expect(needsTranslation(text({ title: 'ห้องสมุดชุมชน', body: 'เราจะซื้อหนังสือ Bitcoin และ Lightning ให้เด็กๆ' }))).toBe(true)
  })
  it('skips English and empty text', () => {
    expect(needsTranslation(text({ title: 'Community library', body: 'We will buy books. ขอบคุณ' }))).toBe(false)
    expect(needsTranslation(text())).toBe(false)
  })
  it('ignores URLs when weighing languages', () => {
    const img = '![](https://media.lonlaam.com/images/abcdefghij/abcdefghijkl.jpg)'
    expect(needsTranslation(text({ title: 'ห้องสมุด', body: `${img}\n${img}\n${img}` }))).toBe(true)
  })
})

describe('translationSourceHash', () => {
  it('changes with any translated field', async () => {
    const base = text({ title: 'ก', summary: 'ข', body: 'ค', milestones: ['ง'] })
    const h = await translationSourceHash(base)
    expect(await translationSourceHash({ ...base })).toBe(h)
    for (const over of [{ title: 'x' }, { summary: 'x' }, { body: 'x' }, { milestones: ['x'] }, { milestones: ['ง', 'x'] }]) {
      expect(await translationSourceHash({ ...base, ...over })).not.toBe(h)
    }
  })
})

describe('checkTranslation', () => {
  const src = text({ title: 'ก', summary: 'ข', body: 'ดู [เว็บ](https://example.com/a) ![รูป](https://media.lonlaam.com/images/p1/x.png)', milestones: ['ง', 'จ'] })
  const ok = text({ title: 'A', summary: 'B', body: 'See [site](https://example.com/a) ![photo](https://media.lonlaam.com/images/p1/x.png)', milestones: ['D', 'E'] })
  it('accepts a complete translation', () => {
    expect(() => checkTranslation(src, ok)).not.toThrow()
  })
  it('rejects dropped milestones, URLs or fields', () => {
    expect(() => checkTranslation(src, { ...ok, milestones: ['D'] })).toThrow(/milestones/)
    expect(() => checkTranslation(src, { ...ok, body: 'See [site](https://example.com/a)' })).toThrow(/URL/)
    expect(() => checkTranslation(src, { ...ok, summary: ' ' })).toThrow(/summary/)
  })
  it('allows empty output for empty input', () => {
    expect(() => checkTranslation(text({ title: 'ก' }), text({ title: 'A' }))).not.toThrow()
  })
})
