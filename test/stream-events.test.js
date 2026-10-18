/**
 * Tests for the wiring between the runtime's event stream and the deltas the
 * client receives.
 *
 * This is the seam that decides whether an answer arrives as it is produced or
 * only once it is finished, and it is where a wrong guess would put JSON
 * syntax, reasoning text, or a duplicated prefix in front of the user.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Backend } from '../lib/backend.js'
import { createStreamState } from '../lib/stream.js'

/** A backend whose activity callback records every delta it is handed. */
function harness({ envelope = false } = {}) {
  const backend = new Backend('http://127.0.0.1:1', 'secret', 1000)
  const deltas = []
  const meta = {
    model: 'opencode/model',
    stream: createStreamState({ envelope }),
    activity: progress => { if (progress.delta) deltas.push(progress.delta) },
  }
  backend.active.set('ses_1', meta)
  return {
    deltas,
    emit: (type, properties) => backend.handleEvent({ type, properties }),
  }
}

test('plain text flows out of the event stream as deltas', () => {
  const { deltas, emit } = harness()
  emit('message.part.delta', { sessionID: 'ses_1', partID: 'p1', field: 'text', delta: 'Hel' })
  emit('message.part.updated', { sessionID: 'ses_1', part: { id: 'p1', type: 'text', text: 'Hello' } })
  emit('message.part.delta', { sessionID: 'ses_1', partID: 'p1', field: 'text', delta: ', world' })
  emit('message.part.updated', { sessionID: 'ses_1', part: { id: 'p1', type: 'text', text: 'Hello, world' } })
  emit('session.status', { sessionID: 'ses_1', status: { type: 'busy' } })
  assert.equal(deltas.join(''), 'Hello, world')
})

test('an envelope model never emits JSON syntax', () => {
  const { deltas, emit } = harness({ envelope: true })
  emit('message.part.delta', { sessionID: 'ses_1', partID: 'p1', field: 'text', delta: '{"content":"La' })
  emit('message.part.delta', { sessionID: 'ses_1', partID: 'p1', field: 'text', delta: ' belle","calls":[]}' })
  assert.equal(deltas.join(''), 'La belle')
  assert.ok(!deltas.join('').includes('{'))
})

test('reasoning is reported as a status, never as answer text', () => {
  const { deltas, emit } = harness()
  emit('message.part.updated', { sessionID: 'ses_1', part: { id: 'r1', type: 'reasoning', text: 'weighing options' } })
  emit('message.part.delta', { sessionID: 'ses_1', partID: 'r1', field: 'reasoning', delta: ' further' })
  assert.deepEqual(deltas, [])
})

test('an event for another session, or none, is ignored', () => {
  const { deltas, emit } = harness()
  emit('message.part.delta', { sessionID: 'ses_other', partID: 'p1', field: 'text', delta: 'x' })
  emit('message.part.delta', { partID: 'p1', field: 'text', delta: 'y' })
  assert.deepEqual(deltas, [])
})
