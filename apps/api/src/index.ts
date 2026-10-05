import type { HealthResponse } from '@nampu/types'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { type AppEnv, getDb } from './context'
import { canonicalHost } from './lib/canonical'
import { ApiError } from './lib/errors'
import { authRoutes } from './routes/auth'
import { discoverRoutes } from './routes/discover'
import { meRoutes } from './routes/me'
import { projectRoutes } from './routes/projects'
import { publicRoutes } from './routes/public'
import { sprinkleRoutes } from './routes/sprinkles'
import { webRoutes } from './routes/web'

export { ProjectRoom } from './do/project-room'
export { SprinkleRoom } from './do/sprinkle-room'

const api = new Hono<AppEnv>()
  .get('/health', (c) => c.json({ ok: true, time: Date.now() } satisfies HealthResponse))
  .route('/auth', authRoutes)
  .route('/me', meRoutes)
  // Public GET /api/projects must be registered before the owner routes (which require auth).
  .route('/projects', discoverRoutes)
  .route('/projects', projectRoutes)
  .route('/', publicRoutes)
  .route('/sprinkles', sprinkleRoutes)

const app = new Hono<AppEnv>()
  .use(canonicalHost)
  .use(async (c, next) => {
    c.set('db', getDb(c.env.DB))
    await next()
  })
  .route('/api', api)
  .route('/', webRoutes)

app.notFound((c) =>
  c.req.path.startsWith('/api/')
    ? c.json(new ApiError(404, 'not_found', 'route not found').toBody(), 404)
    : c.env.ASSETS.fetch(c.req.raw),
)

app.onError((err, c) => {
  if (err instanceof ApiError) return c.json(err.toBody(), err.status)
  // e.g. malformed JSON body from the validator
  if (err instanceof HTTPException && err.status < 500) {
    return c.json(new ApiError(err.status, 'bad_request', err.message || 'bad request').toBody(), err.status)
  }
  console.error('unhandled', err)
  return c.json(new ApiError(500, 'internal', 'internal error').toBody(), 500)
})

export default app
