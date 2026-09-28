// wrangler refuses to start if assets.directory is missing. Until apps/web exists,
// drop a placeholder index.html so the API worker can run on its own.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const dist = join(dirname(fileURLToPath(import.meta.url)), '../apps/web/dist')
if (!existsSync(join(dist, 'index.html'))) {
  mkdirSync(dist, { recursive: true })
  writeFileSync(
    join(dist, 'index.html'),
    '<!doctype html><html lang="th"><head><meta charset="utf-8"><title>nampu</title></head><body><div id="root"></div></body></html>\n',
  )
  console.log('[ensure-web-dist] wrote placeholder apps/web/dist/index.html')
}
