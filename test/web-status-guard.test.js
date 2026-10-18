/**
 * Guards on the settings-card routes (report M1/M2).
 *
 * The routes are mounted through `ctx.webServer.register`, which the Host does
 * NOT put behind its browser-authentication wall: without these guards any
 * cross-site page could POST to `/models/probe` and burn quota, and a
 * cloudflared tunnel could read the endpoint. These cases run a real HTTP
 * server so the forged `Host`/`Origin`/`Content-Type` headers are exercised
 * end to end.
 *
 * Run: node --test test/web-status-guard.test.js
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import http from 'node:http'

import {
  BRIDGE_MODEL_PATH,
  BRIDGE_PROBE_PATH,
  BRIDGE_REFRESH_PATH,
  BRIDGE_RESTART_PATH,
  BRIDGE_STATUS_PATH,
} from '../lib/status-paths.js'
import { inspectRequest, registerBridgeStatusRoute } from '../lib/web-status.js'

const PATHS = {
  status: BRIDGE_STATUS_PATH,
  refresh: BRIDGE_REFRESH_PATH,
  probe: BRIDGE_PROBE_PATH,
  restart: BRIDGE_RESTART_PATH,
  model: BRIDGE_MODEL_PATH,
}

/** Mount the routes on a stub context and serve them like the Host does. */
async function startBridge() {
  const routes = []
  const ctx = {
    effect(fn) { const dispose = fn(); return () => { if (typeof dispose === 'function') dispose() } },
    webServer: { register(route) { routes.push(route); return () => {} } },
  }
  registerBridgeStatusRoute(ctx, {
    status: () => ({ ok: true }),
    refresh: async () => ({ count: 12 }),
    probe: async () => ({ started: true, count: 3, done: Promise.resolve({}) }),
    restart: async () => ({ running: true }),
    model: (id) => (id === 'known' ? { id } : undefined),
  })

  const server = http.createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0]
    const route = routes.find(candidate => candidate.path === path)
    if (route === undefined) { res.writeHead(404).end('{}'); return }
    route.handler(req, res)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  return { port, close: () => new Promise(resolve => server.close(resolve)) }
}

/** One request with fully explicit headers, so `Host` can be forged. */
function request(port, { method = 'GET', path = PATHS.status, headers = {}, body = '' }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method, path, headers: { ...headers, Connection: 'close' } },
      res => {
        let text = ''
        res.setEncoding('utf8')
        res.on('data', chunk => { text += chunk })
        res.on('end', () => {
          let parsed
          try { parsed = JSON.parse(text) } catch { parsed = undefined }
          resolve({ status: res.statusCode, body: parsed })
        })
      },
    )
    req.on('error', reject)
    if (body !== '') req.write(body)
    req.end()
  })
}

test('loopback Host and Origin reach the routes', async () => {
  const bridge = await startBridge()
  const host = { host: `127.0.0.1:${bridge.port}` }
  try {
    const read = await request(bridge.port, { headers: host })
    assert.equal(read.status, 200)
    assert.equal(read.body.ok, true)

    const viaLocalhost = await request(bridge.port, { headers: { host: `localhost:${bridge.port}` } })
    assert.equal(viaLocalhost.status, 200)

    // What the settings card and curl send, respectively.
    const fromPage = await request(bridge.port, {
      method: 'POST',
      path: PATHS.refresh,
      headers: { ...host, origin: `http://127.0.0.1:${bridge.port}`, 'content-type': 'application/json' },
      body: '{}',
    })
    assert.equal(fromPage.status, 200)
    assert.equal(fromPage.body.count, 12)

    const fromCurl = await request(bridge.port, {
      method: 'POST',
      path: PATHS.refresh,
      headers: { ...host, 'content-type': 'application/json' },
      body: '{}',
    })
    assert.equal(fromCurl.status, 200)

    const detail = await request(bridge.port, { path: `${PATHS.model}?id=known`, headers: host })
    assert.equal(detail.status, 200)
    assert.equal(detail.body.id, 'known')
  } finally {
    await bridge.close()
  }
})

test('a tunnel Host or a cross-site Origin is refused', async () => {
  const bridge = await startBridge()
  const host = { host: `127.0.0.1:${bridge.port}` }
  try {
    // A cloudflared tunnel delivers loopback socket + public Host header.
    const tunnel = await request(bridge.port, { headers: { host: 'abc.dsh-market.com' } })
    assert.equal(tunnel.status, 403)
    assert.equal(tunnel.body.error, 'host-not-loopback')

    const crossSiteGet = await request(bridge.port, { headers: { ...host, origin: 'http://evil.example' } })
    assert.equal(crossSiteGet.status, 403)
    assert.equal(crossSiteGet.body.error, 'origin-not-trusted')

    const crossSitePost = await request(bridge.port, {
      method: 'POST',
      path: PATHS.probe,
      headers: { ...host, origin: 'http://evil.example', 'content-type': 'application/json' },
      body: '{}',
    })
    assert.equal(crossSitePost.status, 403)

    // Same name, other port: still not this page.
    const otherPort = await request(bridge.port, {
      method: 'POST',
      path: PATHS.restart,
      headers: { ...host, origin: `http://127.0.0.1:${bridge.port + 1}`, 'content-type': 'application/json' },
      body: '{}',
    })
    assert.equal(otherPort.status, 403)
  } finally {
    await bridge.close()
  }
})

test('a write must be JSON, and the method check still comes first', async () => {
  const bridge = await startBridge()
  const host = { host: `127.0.0.1:${bridge.port}` }
  try {
    // The CORS-safelisted type that made the report's live probe work.
    const simple = await request(bridge.port, {
      method: 'POST',
      path: PATHS.refresh,
      headers: { ...host, origin: `http://127.0.0.1:${bridge.port}`, 'content-type': 'text/plain' },
      body: '{"model":"probe-csrf-test"}',
    })
    assert.equal(simple.status, 415)
    assert.equal(simple.body.error, 'content-type-not-json')

    const noType = await request(bridge.port, {
      method: 'POST',
      path: PATHS.refresh,
      headers: host,
      body: '{}',
    })
    assert.equal(noType.status, 415)

    // Wrong method on a route the guard would also refuse: 405 wins.
    const wrongMethod = await request(bridge.port, {
      method: 'PUT',
      headers: { host: 'abc.dsh-market.com' },
      body: '',
    })
    assert.equal(wrongMethod.status, 405)
  } finally {
    await bridge.close()
  }
})

test('a non-loopback socket peer is refused before anything else', () => {
  const denial = inspectRequest({
    method: 'GET',
    headers: { host: '127.0.0.1:19387' },
    socket: { remoteAddress: '10.0.0.7' },
  })
  assert.deepEqual(denial, { status: 403, error: 'address-not-loopback' })

  const allowed = inspectRequest({
    method: 'GET',
    headers: { host: '127.0.0.1:19387' },
    socket: { remoteAddress: '::1' },
  })
  assert.equal(allowed, null)

  // A sandboxed frame's opaque Origin, and a missing Host header.
  assert.deepEqual(
    inspectRequest({ method: 'POST', headers: { host: '127.0.0.1:1', origin: 'null', 'content-type': 'application/json' }, socket: { remoteAddress: '127.0.0.1' } }),
    { status: 403, error: 'origin-not-trusted' },
  )
  assert.deepEqual(
    inspectRequest({ method: 'GET', headers: {}, socket: { remoteAddress: '127.0.0.1' } }),
    { status: 403, error: 'host-not-loopback' },
  )
})
