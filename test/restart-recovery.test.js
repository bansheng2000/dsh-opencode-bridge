/**
 * A failed startup must leave the plugin retryable, not latched shut.
 *
 * `lib/index.js` used to call `shutdown()` — which sets `closed = true` — when the
 * very first start failed. `restart()` throws 「插件已卸载」 once `closed` is set, so
 * one bad boot (a runtime download timeout was enough) turned the settings page's
 * retry button into a permanent error box, leaving a full Harness restart as the
 * only way out.
 *
 * The start is made to fail fast by pointing `dataDir` at a path whose parent is a
 * regular file: `init()`'s first `mkdir` throws before anything is downloaded, so
 * this runs in milliseconds and needs no network.
 *
 *   node --test test/restart-recovery.test.js
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import test from 'node:test'
import { register } from 'node:module'

// The Harness hands plugins @deepseek-ai/dsh-llm and dsh-llm-pi-ai at runtime, so a
// plain checkout has neither installed. This test drives the startup state machine,
// which fails before either is touched, and the fallback only applies when normal
// resolution fails — a real installation is left alone.
register(new URL('./host-modules-fallback.mjs', import.meta.url))
const { apply } = await import('../lib/index.js')

const STATUS_PATH = '/plugins/dsh-opencode-bridge/status'
const RESTART_PATH = '/plugins/dsh-opencode-bridge/runtime/restart'

/** Boot the host entry against a stub context whose data directory cannot exist. */
async function bootFailing() {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bridge-restart-'))
  // A regular file standing where a directory must be, so `mkdir(dataDir)` fails
  // immediately whatever the platform's exact errno is.
  const blocker = path.join(root, 'blocker')
  await fs.promises.writeFile(blocker, 'not a directory')

  const routes = new Map()
  const server = http.createServer((req, res) => {
    const handler = routes.get(new URL(req.url, 'http://127.0.0.1').pathname)
    if (handler === undefined) { res.writeHead(404); res.end('{}'); return }
    void handler(req, res)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`

  const errors = []
  const logger = { info() {}, warn() {}, error: message => errors.push(String(message)) }
  const ctx = {
    logger,
    effect: fn => { const dispose = fn(); return () => { if (typeof dispose === 'function') dispose() } },
    inject: (services, callback) => { if (services.includes('webServer')) callback(ctx) },
    webServer: { register: ({ path: routePath, handler }) => { routes.set(routePath, handler); return () => routes.delete(routePath) } },
    llm: {
      registerAdapter: () => () => {},
      registerConfigurableProviders: () => () => {},
      registerModelDiscovery: () => () => {},
    },
    get: () => undefined,
  }
  apply(ctx, { dataDir: path.join(blocker, 'runtime-home') })

  return {
    errors,
    status: () => fetch(origin + STATUS_PATH).then(response => response.json()),
    restart: () => fetch(origin + RESTART_PATH, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    }),
    close: async () => {
      await new Promise(resolve => server.close(resolve))
      fs.rmSync(root, { recursive: true, force: true })
    },
  }
}

/**
 * Wait for the asynchronous boot to settle, and report which way it settled.
 *
 * `stopped` is the symptom being tested: the pre-fix code ran the full unload path
 * on a failed start, so the page saw a plugin that had been shut down rather than
 * one that failed.
 */
async function settled(app) {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const status = await app.status()
    if (status.phase === 'error' || status.phase === 'stopped') return status
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  return assert.fail('the failed start never settled')
}

test('a failed start is reported as an error, not as an unloaded plugin', async t => {
  const app = await bootFailing()
  t.after(() => app.close())

  const failed = await settled(app)

  assert.equal(
    failed.phase, 'error',
    `a failed start reported "${failed.phase}" instead of "error"`,
  )
  assert.match(String(failed.message), /运行时错误/)
  assert.ok(
    app.errors.some(message => message.includes('启动失败')),
    `the failure was not logged: ${JSON.stringify(app.errors)}`,
  )
  assert.equal(failed.runtimeVersion, undefined)
})

test('the retry route re-runs the start instead of throwing the unload latch', async t => {
  const app = await bootFailing()
  t.after(() => app.close())
  await settled(app)

  const response = await app.restart()
  const body = await response.json()

  // The retry fails again (the directory is still impossible), but with the real
  // reason — the point is that it RUNS, so it works once the cause is gone.
  assert.equal(response.status, 500, `unexpected restart response: ${JSON.stringify(body)}`)
  assert.ok(
    !String(body.error ?? '').includes('插件已卸载'),
    `restart threw the unload latch: ${JSON.stringify(body)}`,
  )
  assert.ok(String(body.error ?? '').length > 0, 'restart reported no reason')

  // ...and it leaves the card on a real state, not stuck on 「正在重启」.
  const after = await app.status()
  assert.equal(after.phase, 'error')
  assert.match(String(after.message), /运行时错误/)
})
