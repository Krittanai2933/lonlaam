import { drizzle } from 'drizzle-orm/d1'
import * as schema from './db/schema'
import type { CreatorRow } from './db/schema'
import type { LnurlOptions } from './lightning/lnurl'

export type Db = ReturnType<typeof getDb>
export const getDb = (d1: D1Database) => drizzle(d1, { schema })

export interface AppEnv {
  Bindings: Env
  Variables: {
    db: Db
    creator: CreatorRow
    /** SHA-256 of the current bearer token (for logout). */
    sessionHash: string
  }
}

export const lnurlOptions = (env: Env): LnurlOptions => ({ allowInsecure: env.ALLOW_INSECURE_LNURL === 'true' })

export const publicOrigin = (env: Env, requestUrl: string) => env.PUBLIC_ORIGIN || new URL(requestUrl).origin
