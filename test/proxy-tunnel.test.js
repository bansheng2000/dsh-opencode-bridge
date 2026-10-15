/**
 * The CONNECT tunnel a proxied download actually rides.
 *
 * Not a mock: a real `node:http` server answers the CONNECT and the headers it
 * received are asserted. The bug this pins is quiet — the request was built as
 * `{ Host, ...(credentials ? { headers: { 'Proxy-Authorization' } } : {}) }`, so
 * the second `headers` key replaced the first and every credentialed proxy lost
 * its Host line, which some of them reject outright.
 */

import http from 'node:http'
import test from 'node:test'
import assert from 'node:assert/strict'
import { tunnelledSocket } from '../lib/runtime.js'

/** A one-shot CONNECT proxy that records the headers and completes the tunnel. */
async function fakeProxy() {
  const seen = []
  const server = http.createServer()
  server.on('connect', (req, socket) => {
    seen.push(req.headers)
    socket.end('HTTP/1.1 200 Connection Established\r\n\r\n')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { server, seen, port: server.address().port }
}

test('a credentialed CONNECT keeps its Host line', async () => {
  const { server, seen, port } = await fakeProxy()
  try {
    const socket = await tunnelledSocket(new URL(`http://user:pass@127.0.0.1:${port}`), 'registry.npmjs.org', 443, 3000)
    socket.destroy()
    assert.equal(seen.length, 1)
    assert.equal(seen[0].host, 'registry.npmjs.org:443')
    assert.equal(seen[0]['proxy-authorization'],
      `Basic ${Buffer.from('user:pass').toString('base64')}`)
  } finally { server.close() }
})

test('an anonymous CONNECT still sends Host and no credentials', async () => {
  const { server, seen, port } = await fakeProxy()
  try {
    const socket = await tunnelledSocket(new URL(`http://127.0.0.1:${port}`), 'github.com', 443, 3000)
    socket.destroy()
    assert.equal(seen[0].host, 'github.com:443')
    assert.equal(seen[0]['proxy-authorization'], undefined)
  } finally { server.close() }
})

test('a proxy that refuses the tunnel throws instead of returning a dead socket', async () => {
  const server = http.createServer()
  server.on('connect', (req, socket) => { socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n') })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    await assert.rejects(
      tunnelledSocket(new URL(`http://127.0.0.1:${server.address().port}`), 'example.com', 443, 3000),
      /CONNECT 失败：HTTP 502/)
  } finally { server.close() }
})
