/**
 * Tests for incremental delivery.
 *
 * The client appends whatever this layer hands it and cannot retract it, so the
 * properties worth pinning down are monotonicity and the refusal to guess at a
 * partial escape.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStreamState, envelopeContent } from '../lib/stream.js'
import { completion, sendSSE } from '../lib/protocol.js'

/** Drain every delta the state is willing to hand out. */
function drain(state) {
  const chunks = []
  for (let chunk = state.take(); chunk; chunk = state.take()) chunks.push(chunk)
  return chunks
}

test('plain text: cumulative reports and deltas both become one monotonic stream', () => {
  const state = createStreamState()
  state.part({ id: 'p1', type: 'text', text: 'Hel' })
  assert.equal(state.take(), 'Hel')
  state.part({ id: 'p1', type: 'text', text: 'Hello' })
  assert.equal(state.take(), 'lo')
  state.delta({ partID: 'p1', field: 'text', delta: ', world' })
  assert.equal(state.take(), ', world')
  assert.equal(state.take(), '')
  assert.equal(state.visible(), 'Hello, world')
})

test('plain text: a cumulative report supersedes the deltas that produced it', () => {
  const state = createStreamState()
  state.delta({ partID: 'p1', field: 'text', delta: 'Hel' })
  assert.equal(state.take(), 'Hel')
  state.part({ id: 'p1', type: 'text', text: 'Hello' })
  assert.equal(state.take(), 'lo')
  assert.equal(state.visible(), 'Hello')
})

test('reasoning is never delivered as answer text', () => {
  const state = createStreamState()
  state.part({ id: 'r1', type: 'reasoning', text: 'thinking about it' })
  assert.equal(state.take(), '')
  state.delta({ partID: 'r1', field: 'reasoning', delta: ' more' })
  assert.equal(state.take(), '')
  state.part({ id: 't1', type: 'text', text: 'the answer' })
  assert.equal(state.take(), 'the answer')
})

test('envelope: only the content field is delivered, however the JSON is chunked', () => {
  const answer = '你好\n世界 "quoted" \\ backslash'
  const json = JSON.stringify({ content: answer, calls: [] })
  for (const size of [1, 2, 3, 7, 64]) {
    const state = createStreamState({ envelope: true })
    const delivered = []
    for (let index = 0; index < json.length; index += size) {
      state.delta({ partID: 'p1', field: 'text', delta: json.slice(index, index + size) })
      delivered.push(...drain(state))
    }
    assert.equal(delivered.join(''), answer, `chunk size ${size}`)
    // Nothing that looks like JSON syntax may reach the client.
    assert.ok(!delivered.join('').includes('"content"'), `chunk size ${size}`)
  }
})

test('envelope: an escape split across two deltas is held back, then delivered whole', () => {
  const state = createStreamState({ envelope: true })
  state.delta({ partID: 'p1', field: 'text', delta: '{"content":"a\\u4e' })
  assert.equal(state.take(), 'a')
  state.delta({ partID: 'p1', field: 'text', delta: '2db"}' })
  assert.equal(state.take(), '中b')
  assert.equal(state.visible(), 'a中b')
})

test('envelope: a tool call argument that looks like a content key does not win', () => {
  const json = '{"content":"real answer","calls":[{"name":"write","arguments":{"text":"\\"content\\": \\"fake\\""}}]}'
  assert.equal(envelopeContent(json), 'real answer')
})

test('a retry does not duplicate the prefix already delivered', () => {
  const state = createStreamState({ envelope: true })
  state.delta({ partID: 'p1', field: 'text', delta: '{"content":"first' })
  assert.equal(state.take(), 'first')
  state.reset()
  state.delta({ partID: 'p1', field: 'text', delta: '{"content":"second' })
  assert.equal(state.take(), '')
  assert.equal(state.visible(), 'second')
})

test('envelope: an envelope that has not started yet yields nothing', () => {
  const state = createStreamState({ envelope: true })
  state.delta({ partID: 'p1', field: 'text', delta: '{"cal' })
  assert.equal(state.take(), '')
  assert.equal(state.visible(), '')
})

/** A response object that records what the SSE writer produces. */
function recorder() {
  const writes = []
  return {
    writes,
    write(chunk) { writes.push(chunk) },
    end(chunk) { if (chunk) writes.push(chunk) },
  }
}

/** The content deltas inside an SSE write sequence. */
function contentDeltas(writes) {
  const out = []
  for (const write of writes) {
    for (const line of write.split('\n')) {
      if (!line.startsWith('data: ') || line === 'data: [DONE]') continue
      const payload = JSON.parse(line.slice(6))
      const delta = payload.choices?.[0]?.delta
      if (delta && typeof delta.content === 'string') out.push(delta.content)
    }
  }
  return out
}

test('sendSSE sends only what was not already streamed', () => {
  const res = recorder()
  const result = completion('opencode/model', { role: 'assistant', content: 'Hello, world' }, {})
  sendSSE(res, result, false, true, 'Hello,')
  assert.deepEqual(contentDeltas(res.writes), [' world'])
})

test('sendSSE re-sends the whole answer when the streamed prefix does not match', () => {
  const res = recorder()
  const result = completion('opencode/model', { role: 'assistant', content: 'second' }, {})
  sendSSE(res, result, false, true, 'first')
  assert.deepEqual(contentDeltas(res.writes), ['second'])
})

test('sendSSE is unchanged when nothing was streamed', () => {
  const res = recorder()
  const result = completion('opencode/model', { role: 'assistant', content: 'answer' }, {})
  sendSSE(res, result, false, false, '')
  assert.deepEqual(contentDeltas(res.writes), ['answer'])
  assert.ok(res.writes.join('').includes('"role":"assistant"'))
  assert.ok(res.writes.join('').includes('data: [DONE]'))
})
