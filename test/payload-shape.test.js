/**
 * What one turn actually posts to the runtime.
 *
 * The runtime turns `format` into a forced tool_choice, and some thinking models
 * refuse that upstream with a 400 ("Thinking mode does not support this
 * tool_choice"). Capability flags cannot predict which models refuse, so the
 * format is kept by default and dropped only after that actual refusal — and the
 * answer must still decode from plain text.
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { after, before, test } from 'node:test'
import { Backend } from '../lib/backend.js'

const ENVELOPE = JSON.stringify({ content: 'ok', calls: [] })
const REFUSAL = 'Upstream request failed: [invalid_request_error] Thinking mode does not support this tool_choice'

function startRuntime() {
  const state = { messages: [], events: [], refuseFormat: false, garbage: 0 }
  const server = createServer((req, res) => {
    const route = (req.url ?? '/').split('?')[0]
    const json = (body, status = 200) => {
      const text = JSON.stringify(body)
      res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) })
      res.end(text)
    }
    if (route === '/permission') return json([])
    if (route === '/session' && req.method === 'POST') return json({ id: 's1' })
    if (route === '/session/s1/message') {
      const chunks = []
      req.on('data', chunk => chunks.push(chunk))
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString())
        state.messages.push(body)
        const info = { id: 'm1', role: 'assistant', finish: 'stop', tokens: { input: 1, output: 1 } }
        if (state.refuseFormat && body.format) {
          return json({ info: { id: 'm1', role: 'assistant', error: { name: 'AI_APICallError', message: REFUSAL } } })
        }
        if (state.garbage > 0) {
          state.garbage -= 1
          return json({ info, parts: [{ type: 'text', text: 'not json' }] })
        }
        // Plain text, exactly what a thinking model sends once the format is gone.
        return json({ info, parts: [{ type: 'text', text: ENVELOPE }] })
      })
      return undefined
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

function turn() {
  return {
    model: { id: 'opencode/test' },
    text: 'hi',
    system: 'be brief',
    tools: [],
    choice: 'auto',
  }
}

function reset(overrides = {}) {
  runtime.state.messages.length = 0
  runtime.state.refuseFormat = false
  runtime.state.garbage = 0
  Object.assign(runtime.state, overrides)
}

test('the JSON-schema format is asked for by default', { timeout: 20_000 }, async () => {
  reset()
  const result = await new Backend(base, 'secret', undefined, () => {}).complete(turn(), undefined, {})
  assert.equal(runtime.state.messages.length, 1)
  assert.equal(runtime.state.messages[0].format?.type, 'json_schema')
  assert.match(runtime.state.messages[0].system, /Use StructuredOutput/)
  assert.equal(result.choices[0].message.content, 'ok')
})

test('a model that refuses the forced tool_choice is retried in plain text', { timeout: 20_000 }, async () => {
  reset({ refuseFormat: true })
  const result = await new Backend(base, 'secret', undefined, () => {}).complete(turn(), undefined, {})
  const [first, second] = runtime.state.messages
  assert.equal(first.format?.type, 'json_schema', 'the first attempt trusts the format')
  assert.equal(second.format, undefined, 'the format is what forces tool_choice, so it goes')
  assert.match(second.system, /as plain text/, 'the prompt asks for a plain text envelope')
  assert.doesNotMatch(second.system, /Use StructuredOutput/)
  assert.equal(result.choices[0].message.content, 'ok', 'a plain text envelope still decodes')
})

test('dropping the format does not use up the single correction retry', { timeout: 20_000 }, async () => {
  reset({ refuseFormat: true, garbage: 1 })
  const result = await new Backend(base, 'secret', undefined, () => {}).complete(turn(), undefined, {})
  assert.equal(runtime.state.messages.length, 3)
  assert.equal(runtime.state.messages[2].format, undefined)
  assert.match(runtime.state.messages[2].parts[0].text, /failed the adapter JSON format check/)
  assert.equal(result.choices[0].message.content, 'ok')
})
