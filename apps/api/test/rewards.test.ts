import type { Reward } from '@nampu/types'
import { LIMITS } from '@nampu/types'
import * as v from 'valibot'
import { describe, expect, it } from 'vitest'
import { ApiError } from '../src/lib/errors'
import { chooseReward, rewardsSchema, toPublicRewards } from '../src/lib/rewards'
import type { ProjectRow } from '../src/db/schema'
import { toOwnerSupporter, toPublicProject, toSupporter } from '../src/serialize'

const claims = (o: Record<string, number>) => new Map(Object.entries(o).map(([id, n]) => [id, { claimed: n, backers: n }]))
const reward = (over: Partial<Reward> = {}): Reward => ({ id: 'a1', title: 'Postcard', description: '', minSats: 1000, limit: null, ...over })

describe('rewardsSchema', () => {
  const parse = (input: unknown) => v.safeParse(rewardsSchema, input)

  it('trims text and sorts by minSats, keeping the order of equal tiers', () => {
    const r = parse([
      reward({ id: 'big', minSats: 5000, title: '  T-shirt ' }),
      reward({ id: 'x', minSats: 1000 }),
      reward({ id: 'y', minSats: 1000, limit: 3 }),
    ])
    expect(r.success).toBe(true)
    expect(r.output).toMatchObject([{ id: 'x' }, { id: 'y', limit: 3 }, { id: 'big', title: 'T-shirt' }])
  })

  it('rejects malformed ids and duplicate ids', () => {
    expect(parse([reward({ id: 'Has-Caps' })]).success).toBe(false)
    expect(parse([reward({ id: '' })]).success).toBe(false)
    expect(parse([reward({ id: 'a'.repeat(17) })]).success).toBe(false)
    expect(parse([reward({ id: 'same' }), reward({ id: 'same', minSats: 2000 })]).success).toBe(false)
  })

  it('keeps minSats within what one invoice can be, and limit positive', () => {
    expect(parse([reward({ minSats: 0 })]).success).toBe(false)
    expect(parse([reward({ minSats: LIMITS.invoiceSats.max + 1 })]).success).toBe(false)
    expect(parse([reward({ minSats: 1.5 })]).success).toBe(false)
    expect(parse([reward({ limit: 0 })]).success).toBe(false)
    expect(parse([reward({ limit: LIMITS.rewards.limit.max + 1 })]).success).toBe(false)
  })

  it('needs a title and caps the text and the count', () => {
    expect(parse([reward({ title: '   ' })]).success).toBe(false)
    expect(parse([reward({ title: 'x'.repeat(LIMITS.rewards.title.max + 1) })]).success).toBe(false)
    expect(parse([reward({ description: 'x'.repeat(LIMITS.rewards.description.max + 1) })]).success).toBe(false)
    const many = Array.from({ length: LIMITS.rewards.max + 1 }, (_, i) => reward({ id: `r${i}` }))
    expect(parse(many).success).toBe(false)
    expect(parse(many.slice(1)).success).toBe(true)
  })
})

describe('chooseReward', () => {
  const rewards = [reward({ id: 'card', minSats: 1000 }), reward({ id: 'shirt', title: 'T-shirt', minSats: 5000, limit: 2 })]
  const fail = (fn: () => unknown) => {
    try {
      fn()
    } catch (e) {
      if (e instanceof ApiError) return { status: e.status, code: e.code, paths: e.issues?.map((i) => i.path) }
      throw e
    }
    throw new Error('expected an ApiError')
  }

  it('returns the reward with the trimmed contact', () => {
    expect(chooseReward(rewards, undefined, { rewardId: 'card', amountSats: 1000, contact: '  me@example.com ' })).toMatchObject({
      id: 'card',
      title: 'Postcard',
      contact: 'me@example.com',
    })
  })

  it('refuses a reward that is not offered (any more)', () => {
    expect(fail(() => chooseReward(rewards, undefined, { rewardId: 'gone', amountSats: 9000, contact: 'x' }))).toMatchObject({ status: 409, code: 'reward_unavailable' })
  })

  it('needs at least the minimum amount', () => {
    expect(fail(() => chooseReward(rewards, undefined, { rewardId: 'shirt', amountSats: 4999, contact: 'x' }))).toEqual({
      status: 422,
      code: 'validation_failed',
      paths: ['amountSats'],
    })
  })

  it('needs a contact', () => {
    for (const contact of [undefined, '', '   ']) {
      expect(fail(() => chooseReward(rewards, undefined, { rewardId: 'card', amountSats: 1000, contact }))).toEqual({
        status: 422,
        code: 'validation_failed',
        paths: ['contact'],
      })
    }
  })

  it('refuses a limited reward once its claims reach the limit', () => {
    const input = { rewardId: 'shirt', amountSats: 5000, contact: 'x' }
    expect(chooseReward(rewards, claims({ shirt: 1 }), input).id).toBe('shirt')
    expect(fail(() => chooseReward(rewards, claims({ shirt: 2 }), input))).toMatchObject({ status: 409, code: 'reward_unavailable' })
    // Unlimited rewards ignore claims.
    expect(chooseReward(rewards, claims({ card: 10_000 }), { ...input, rewardId: 'card' }).id).toBe('card')
  })
})

describe('reward serialization', () => {
  it('adds claim counts to public rewards', () => {
    const rs = toPublicRewards([reward({ id: 'a' }), reward({ id: 'b' })], new Map([['b', { claimed: 3, backers: 2 }]]))
    expect(rs.map((r) => [r.claimed, r.backers])).toEqual([
      [0, 0],
      [3, 2],
    ])
    expect(toPublicRewards([reward()], undefined)[0]).toMatchObject({ claimed: 0, backers: 0 })
  })

  it('shows the contact to the owner only', () => {
    const row = {
      id: 'inv1',
      supporterName: 'Kaew',
      supporterPubkey: null,
      comment: null,
      amountMsat: 5_000_000,
      paidAt: 1,
      rewardId: 'shirt',
      rewardTitle: 'T-shirt',
      contact: 'kaew@example.com',
      rewardSentAt: null,
    }
    expect(toSupporter(row).reward).toEqual({ id: 'shirt', title: 'T-shirt' })
    expect(JSON.stringify(toSupporter(row))).not.toContain('kaew@example.com')
    expect(toOwnerSupporter(row).reward).toEqual({ id: 'shirt', title: 'T-shirt', contact: 'kaew@example.com', sentAt: null })
    expect(toOwnerSupporter({ ...row, rewardId: null, rewardTitle: null, contact: null }).reward).toBeNull()
  })
})

describe('reward translation', () => {
  const row = {
    title: 'ห้องสมุด',
    summary: '',
    body: '',
    milestones: [],
    rewards: [reward({ id: 'a', title: 'โปสการ์ด', description: 'ส่งจากดอย' }), reward({ id: 'b', title: 'เสื้อ', description: 'ไซส์ M' })],
    titleEn: 'Library',
    summaryEn: '',
    bodyEn: '',
    milestonesEn: [],
    rewardsEn: { a: { title: 'Postcard', description: '' }, gone: { title: 'Old', description: 'x' } },
    enManual: false,
  } as unknown as ProjectRow
  it('uses the English text by id and falls back to the original', () => {
    const p = toPublicProject({ ...row, status: 'active' } as ProjectRow, { handle: 'h', displayName: 'H', npub: null }, 'https://m', undefined)
    expect(p.translation!.rewards).toEqual([
      { id: 'a', title: 'Postcard', description: 'ส่งจากดอย' },
      { id: 'b', title: 'เสื้อ', description: 'ไซส์ M' },
    ])
  })
})
