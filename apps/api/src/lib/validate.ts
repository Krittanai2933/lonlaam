import { sValidator } from '@hono/standard-validator'
import type { StandardSchemaV1 } from '@standard-schema/spec'
import { LIMITS } from '@nampu/types'
import * as v from 'valibot'
import { ApiError } from './errors'

/** JSON-body validator that reports failures in the shared ApiErrorBody shape. */
export const json = <S extends StandardSchemaV1>(schema: S) =>
  sValidator('json', schema, (result) => {
    if (!result.success) {
      throw new ApiError(
        422,
        'validation_failed',
        'request body is invalid',
        result.error.map((i) => ({
          path: (i.path ?? []).map((p) => (typeof p === 'object' ? String(p.key) : String(p))).join('.'),
          message: i.message,
        })),
      )
    }
  })

const trimmed = (min: number, max: number) => v.pipe(v.string(), v.trim(), v.minLength(min), v.maxLength(max))

export const handleSchema = v.pipe(v.string(), v.trim(), v.toLowerCase(), v.minLength(LIMITS.handle.min), v.maxLength(LIMITS.handle.max), v.regex(new RegExp(LIMITS.handle.pattern)))
export const slugSchema = v.pipe(v.string(), v.trim(), v.toLowerCase(), v.minLength(LIMITS.slug.min), v.maxLength(LIMITS.slug.max), v.regex(new RegExp(LIMITS.slug.pattern)))
export const displayNameSchema = trimmed(LIMITS.displayName.min, LIMITS.displayName.max)
export const lightningAddressSchema = v.pipe(v.string(), v.trim(), v.maxLength(320))
export const titleSchema = trimmed(LIMITS.title.min, LIMITS.title.max)
export const summarySchema = trimmed(0, LIMITS.summary.max)
export const bodySchema = v.pipe(v.string(), v.maxLength(LIMITS.body.max))
export const goalSchema = v.nullable(v.pipe(v.number(), v.safeInteger(), v.minValue(LIMITS.goalSats.min), v.maxValue(LIMITS.goalSats.max)))
