/**
 * The two ceilings around one turn.
 *
 * M3: the `/message` POST is a long poll, so it used to run without any
 * wall-clock limit — a wedged runtime held the client request open forever. It
 * now expires and says why.
 *
 * M4: the 250 ms approval monitor queried the runtime four times a second even
 * though the event stream had already delivered every approval. The listing is
 * now only read while the stream is down, plus once after each reconnect.
 *
 * M10: one upstream response is bounded too. A body past the cap is refused
 * instead of accumulated, and whatever the runtime says about a failure reaches
 * the client as one short line rather than as its error page.
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { after, before, test } from 'node:test'
import { Backend } from '../lib/backend.js'

/** A fake runtime: it can hang, and it counts what was asked of it. */
function startRuntime() {
  const state = { requests: [], permissionQueries: 0, events: [] }
  const server = createServer((req, res) => {
    const route = (req.url ?? '/').split('?')[0]
    state.requests.push(`${req.method} ${route}`)
    const json = (body, status = 200) => {
      const text = JSON.stringify(body)
      res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) })
      res.end(text)
    }
    if (route === '/permission') { state.permissionQueries += 1; return json([]) }
    if (route === '/session' && req.method === 'POST') return json({ id: 's1' })
    // The turn itself: never answered, which is the case under test.
    if (route === '/session/s1/message') return undefined
    if (route === '/huge') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      for (let i = 0; i < 33; i += 1) res.write(Buffer.alloc(1024 * 1024, 0x61))
      return res.end()
    }
    if (route === '/broken') {
      res.writeHead(500, { 'Content-Type': 'text/plain' })
      return res.end(`boom\n${'stack line\n'.repeat(200)}`)
    }
    if (route === '/event') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
      res.write('data: {"type":"server.connected"}\n\n')
      state.events.push(res)
      return undefined
    }
    return json(true)
  })
  return { state, server }
}

let runtime
let base

before(async () => {
  runtime = startRuntime()
  await new Promise(resolve => runtime.server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${runtime.server.address().port}`
})

after(async () => {
  for (const res of runtime.state.events) res.destroy()
  runtime.server.closeAllConnections?.()
  await new Promise(resolve => runtime.server.close(resolve))
})

test('a wedged turn fails on its ceiling and still cleans up the session', { timeout: 20_000 }, async () => {
  process.env.OPENCODE_BRIDGE_MESSAGE_TIMEOUT_MS = '400'
  const backend = new Backend(base, 'secret', undefined, () => {})
  try {
    assert.equal(backend.messageTimeout, 400, 'the environment moves the ceiling')
    const started = Date.now()
    const error = await backend.complete(
      { model: { id: 'opencode/test' }, text: 'hi', system: 'be brief', tools: [], choice: 'auto' },
      undefined,
      {},
    ).then(() => null, failure => failure)
    const elapsed = Date.now() - started
    assert.ok(error, 'a hanging turn must not resolve')
    assert.equal(error.code, 'message_timeout', `expected the turn ceiling, got ${error.code}: ${error.message}`)
    assert.equal(error.status, 504)
    assert.match(error.message, /400 毫秒/)
    assert.match(error.message, /OPENCODE_BRIDGE_MESSAGE_TIMEOUT_MS/)
    assert.ok(elapsed < 15_000, `the turn must end on its ceiling, took ${elapsed} ms`)
    assert.ok(runtime.state.requests.includes('DELETE /session/s1'), 'the session is cleaned up')
  } finally {
    delete process.env.OPENCODE_BRIDGE_MESSAGE_TIMEOUT_MS
  }
})

test('a non-positive ceiling falls back to the default', async () => {
  process.env.OPENCODE_BRIDGE_MESSAGE_TIMEOUT_MS = '0'
  assert.equal(new Backend(base, 'secret', undefined, () => {}).messageTimeout, 300_000)
  process.env.OPENCODE_BRIDGE_MESSAGE_TIMEOUT_MS = 'nonsense'
  assert.equal(new Backend(base, 'secret', undefined, () => {}).messageTimeout, 300_000)
  delete process.env.OPENCODE_BRIDGE_MESSAGE_TIMEOUT_MS
})

test('the connected event stream marks the approval map authoritative', { timeout: 20_000 }, async () => {
  const backend = new Backend(base, 'secret', undefined, () => {})
  assert.equal(backend.eventsLive, false)
  backend.watchEvents()
  const deadline = Date.now() + 5_000
  while (!backend.eventsLive && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(backend.eventsLive, true, 'a 200 on /event must mark the stream live')
  backend.stopEvents()
  assert.equal(backend.eventsLive, false)
  assert.equal(backend.eventsSynced, false)
})

test('the listing is read while the stream is down and once after it returns', async () => {
  const backend = new Backend(base, 'secret', undefined, () => {})
  const before = runtime.state.permissionQueries

  await backend.pendingPermissions('s1', undefined)
  assert.equal(runtime.state.permissionQueries - before, 1, 'no stream yet: read the listing')

  backend.eventsLive = true
  await backend.pendingPermissions('s1', undefined)
  assert.equal(runtime.state.permissionQueries - before, 2, 'the first read after a connect reconciles')

  await backend.pendingPermissions('s1', undefined)
  assert.equal(runtime.state.permissionQueries - before, 2, 'then the map answers and no request is made')

  backend.pendingApprovals.set('p1', { id: 'p1', sessionID: 's1' })
  const pending = await backend.pendingPermissions('s1', undefined)
  assert.deepEqual(pending.map(item => item.id), ['p1'], 'the map is what the monitor iterates')
  assert.equal(runtime.state.permissionQueries - before, 2)

  backend.eventsLive = false
  await backend.pendingPermissions('s1', undefined)
  assert.equal(runtime.state.permissionQueries - before, 3, 'the stream dropped: the listing is the safety net again')
})

test('an upstream response past the cap is refused instead of accumulated', { timeout: 30_000 }, async () => {
  const backend = new Backend(base, 'secret', undefined, () => {})
  const error = await backend.request('/huge').then(() => null, failure => failure)
  assert.ok(error, 'a 33 MB response must not resolve')
  assert.equal(error.code, 'upstream_error')
  assert.equal(error.status, 502)
  assert.match(error.message, /32 MB/)
})

test('an upstream failure reaches the client as one short line', { timeout: 20_000 }, async () => {
  const backend = new Backend(base, 'secret', undefined, () => {})
  const error = await backend.request('/broken').then(() => null, failure => failure)
  assert.ok(error)
  assert.match(error.message, /^OpenCode HTTP 500: boom/)
  assert.ok(!error.message.includes('\n'), 'the body must not travel verbatim')
  assert.ok(error.message.length < 260, `expected a one-line summary, got ${error.message.length} chars`)
})

