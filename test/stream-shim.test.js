/**
 * End-to-end check of streamed delivery over a real socket.
 *
 * The unit tests pin the delta arithmetic; this one proves the bytes actually
 * leave the loopback endpoint incrementally and that the final frame does not
 * repeat what the client already has. It runs the real shim against a stub
 * backend, so no runtime is needed.
 *
 * Run: node --test test/stream-shim.test.js
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import http from 'node:http'

import { completion } from '../lib/protocol.js'
import { createShim } from '../lib/shim.js'

const MODEL = {
  id: 'opencode/tiny',
  name: 'Tiny',
  context: 200000,
  input: 160000,
  output: 32000,
  images: false,
  toolcall: true,
  reasoning: true,
  variants: {},
}

/** Start the shim with a backend that reports the given activity then answers. */
async function startShim({ answer, activity }) {
  const shim = await createShim({
    getModels: () => [MODEL],
    complete: async (request, signal, meta) => {
      for (const progress of activity) meta.activity?.({ content: true, status: 'receiving', ...progress })
      return completion(MODEL.id, { role: 'assistant', content: answer }, {})
    },
    logger: {},
  })
  return shim
}

/** One streaming completion request; resolves with the raw SSE text. */
function stream(port, token, body = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model: MODEL.id,
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
      ...body,
    })
    const req = http.request({
      host: '127.0.0.1',
      port,
      method: 'POST',
      path: '/v1/chat/completions',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        Authorization: `Bearer ${token}`,
        Connection: 'close',
      },
    }, res => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', chunk => { text += chunk })
      res.on('end', () => resolve({ status: res.statusCode, text }))
    })
    req.on('error', reject)
    req.end(payload)
  })
}

/** Every delta in an SSE body, in order. */
function deltas(text) {
  const out = []
  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ') || line === 'data: [DONE]') continue
    const payload = JSON.parse(line.slice(6))
    const delta = payload.choices?.[0]?.delta
    if (delta) out.push(delta)
  }
  return out
}

test('the answer leaves the endpoint as it is produced', async () => {
  const shim = await startShim({
    answer: 'Hello',
    activity: [{ delta: 'Hel' }, { delta: 'lo' }],
  })
  try {
    const { status, text } = await stream(new URL(shim.baseUrl()).port, shim.token())
    assert.equal(status, 200)
    const frames = deltas(text)
    assert.deepEqual(frames[0], { role: 'assistant' })
    // The first two content frames are what the backend reported while it was
    // still generating; the final write adds nothing, because 'Hello' is
    // exactly the prefix already sent.
    assert.deepEqual(frames.slice(1).filter(f => f.content !== undefined).map(f => f.content), ['Hel', 'lo'])
    assert.ok(text.includes('data: [DONE]'))
  } finally {
    await shim.close()
  }
})

test('a rewritten answer is re-sent in full rather than truncated', async () => {
  const shim = await startShim({
    answer: 'second',
    activity: [{ delta: 'first' }],
  })
  try {
    const { text } = await stream(new URL(shim.baseUrl()).port, shim.token())
    const content = deltas(text).filter(f => f.content !== undefined).map(f => f.content)
    assert.deepEqual(content, ['first', 'second'])
  } finally {
    await shim.close()
  }
})

test('a non-streaming request still gets one JSON body', async () => {
  const shim = await startShim({ answer: 'Hello there', activity: [] })
  try {
    const port = new URL(shim.baseUrl()).port
    const payload = JSON.stringify({ model: MODEL.id, messages: [{ role: 'user', content: 'hi' }] })
    const body = await new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/v1/chat/completions',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          Authorization: `Bearer ${shim.token()}`,
          Connection: 'close',
        },
      }, res => {
        let text = ''
        res.setEncoding('utf8')
        res.on('data', chunk => { text += chunk })
        res.on('end', () => resolve(JSON.parse(text)))
      })
      req.on('error', reject)
      req.end(payload)
    })
    assert.equal(body.choices[0].message.content, 'Hello there')
  } finally {
    await shim.close()
  }
})
