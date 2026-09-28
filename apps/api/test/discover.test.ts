import { describe, expect, it } from 'vitest'
import { clampLimit, decodeOffsetCursor, DISCOVER_LIMIT, encodeOffsetCursor, parseDiscoverQuery } from '../src/lib/discover'
import { ApiError } from '../src/lib/errors'
import { likePattern } from '../src/lib/supporters'

describe('discover query', () => {
  it('applies defaults', () => {
    expect(parseDiscoverQuery({})).toEqual({ category: null, sort: 'trending', q: '', limit: 12, offset: 0 })
  })
  it('validates category and sort', () => {
    expect(parseDiscoverQuery({ category: 'edu', sort: 'funded' })).toMatchObject({ category: 'edu', sort: 'funded' })
    expect(() => parseDiscoverQuery({ category: 'food' })).toThrow(ApiError)
    expect(() => parseDiscoverQuery({ sort: 'random' })).toThrow(ApiError)
  })
  it('clamps limit', () => {
    expect(clampLimit('1000', DISCOVER_LIMIT)).toBe(48)
    expect(clampLimit('0', DISCOVER_LIMIT)).toBe(12)
    expect(clampLimit('abc', DISCOVER_LIMIT)).toBe(12)
    expect(clampLimit('3.7', DISCOVER_LIMIT)).toBe(3)
  })
  it('round-trips and validates offset cursors', () => {
    expect(decodeOffsetCursor(encodeOffsetCursor(36))).toBe(36)
    expect(decodeOffsetCursor(undefined)).toBe(0)
    for (const bad of ['-1', 'ZZ', '1.5', 'zzzz']) expect(() => decodeOffsetCursor(bad), bad).toThrow(ApiError)
  })
  it('trims and caps q', () => {
    expect(parseDiscoverQuery({ q: '  lib  ' }).q).toBe('lib')
    expect(parseDiscoverQuery({ q: 'x'.repeat(300) }).q).toHaveLength(100)
  })
})

describe('likePattern', () => {
  it('escapes LIKE wildcards', () => {
    expect(likePattern('50%_a\\b')).toBe('%50\\%\\_a\\\\b%')
  })
})
