import test from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'

// `lib/index.js` imports the host-provided `@deepseek-ai/dsh-llm` packages,
// which a plain checkout does not have; the hook stubs them only when normal
// resolution fails. It must be registered before the entry module is loaded.
register(new URL('./host-modules-fallback.mjs', import.meta.url))
const { probeRouteResult } = await import('../lib/index.js')

test('the probe route never waits for the sweep', () => {
  // A sweep that never settles: the reply must still come back whole. If the
  // route went back to awaiting the sweep, this test would get a promise (and
  // would never finish).
  const hanging = new Promise(() => {})
  const reply = probeRouteResult({ started: true, count: 3, task: hanging, done: hanging })
  assert.deepEqual(reply, { started: true, count: 3, pending: true })
})

test('a refused probe passes through unchanged', () => {
  const refused = { started: false, message: '检测正在进行' }
  assert.equal(probeRouteResult(refused), refused)
})
