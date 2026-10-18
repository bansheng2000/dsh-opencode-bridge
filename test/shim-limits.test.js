/**
 * Bound and redaction checks for the loopback endpoint.
 *
 * The body cap must stay above what the adapter itself accepts (an image budget
 * in the tens of megabytes, base64-inflated), and request capture must not put
 * conversation pixels on disk or grow without bound.
 *
 * @module dsh-opencode-bridge/test/shim-limits
 */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createShim } from '../lib/shim.js'

const model = { id: 'opencode/test', name: 'Test', contextWindow: 128_000, maxOutputTokens: 4096, images: true }
const captureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocb-capture-'))
process.env.OPENCODE_BRIDGE_CAPTURE = captureDir

let shim
let calls = 0

before(async () => {
  shim = await createShim({
    complete: async () => {
      calls += 1
      return { id: 'cmpl-1', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }
    },
    getModels: () => [model],
  })
})

after(async () => {
  await shim?.close().catch(() => {})
  delete process.env.OPENCODE_BRIDGE_CAPTURE
  fs.rmSync(captureDir, { recursive: true, force: true })
})

/** One chat request the way pi-ai sends it. */
async function chat(body) {
  const response = await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${shim.token()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: response.status, text: await response.text() }
}

const captureFiles = () => fs.readdirSync(captureDir).filter(name => name.endsWith('.json'))

const captures = () => captureFiles()
  .map(name => fs.readFileSync(path.join(captureDir, name), 'utf8'))
  .join('\n')

test('a body the adapter itself accepts is not refused here', { timeout: 60_000 }, async () => {
  // 9 MB of conversation: over the old 8 MB cap, well under the image budget's
  // base64-inflated shape.
  const text = '你好'.repeat(3 * 1024 * 1024)
  const before = calls
  const result = await chat({ model: model.id, messages: [{ role: 'user', content: text }] })
  assert.equal(result.status, 200, result.text.slice(0, 200))
  assert.equal(calls, before + 1)
})

test('a body past the cap is refused and the limit names itself', { timeout: 60_000 }, async () => {
  let result
  try {
    result = await chat({ model: model.id, messages: [{ role: 'user', content: 'x'.repeat(40 * 1024 * 1024) }] })
  } catch (error) {
    assert.fail(`请求体上限应回 413 而不是断连：${error.message}`)
  }
  assert.equal(result.status, 413, result.text.slice(0, 200))
  assert.match(result.text, /32 MB/)
})

test('captures keep the shape of an image, not its pixels', { timeout: 30_000 }, async () => {
  const base64 = Buffer.from('not-really-a-png-but-well-formed-base64').toString('base64')
  const result = await chat({
    model: model.id,
    messages: [{ role: 'user', content: [
      { type: 'text', text: 'what is in this image' },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${base64}` } },
    ] }],
  })
  assert.equal(result.status, 200, result.text.slice(0, 200))
  const text = captures()
  assert.ok(text.includes('what is in this image'), 'the conversation itself is still captured')
  assert.ok(!text.includes(base64), 'the base64 payload must not be written to disk')
  assert.ok(text.includes('redacted image/png'), 'the redaction marker replaces it')
})

test('a capture directory keeps only the newest records', { timeout: 30_000 }, async () => {
  for (let i = 0; i < 40; i += 1) {
    fs.writeFileSync(path.join(captureDir, `${String(i).padStart(3, '0')}-rejected.json`), '{}')
  }
  await chat({ model: model.id, messages: [{ role: 'user', content: 'one more' }] })
  const kept = captureFiles().length
  assert.ok(kept <= 20, `expected at most 20 records, kept ${kept}`)
  assert.ok(captures().includes('one more'), 'the newest record survives the prune')
})
