/**
 * What one turn actually posts to the runtime.
 *
 * A thinking model answers the runtime's JSON-schema format with a 400
 * ("Thinking mode does not support this tool_choice") because that format is a
 * forced tool_choice underneath. Such a model must be asked for the envelope in
 * plain text instead, and the answer must still decode.
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { after, before, test } from 'node:test'
import { Backend } from '../lib/backend.js'

const ENVELOPE = JSON.stringify({ content: 'ok', calls: [] })

function startRuntime() {
  const state = { messages: [], events: [] }
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
        state.messages.push(JSON.parse(Buffer.concat(chunks).toString()))
        json({
          info: { id: 'm1', role: 'assistant', finish: 'stop', tokens: { input: 1, output: 1 } },
          // Plain text, exactly what a thinking model would send.
          parts: [{ type: 'text', text: ENVELOPE }],
        })
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

function turn(structured) {
  return {
    model: { id: 'opencode/test' },
    text: 'hi',
    system: 'be brief',
    tools: [],
    choice: 'auto',
    structured,
  }
}

test('a thinking model is asked for plain text, not a forced format', { timeout: 20_000 }, async () => {
  const backend = new Backend(base, 'secret', undefined, () => {})
  const result = await backend.complete(turn(false), undefined, {})
  const payload = runtime.state.messages.at(-1)
  assert.equal(payload.format, undefined, 'the JSON-schema format is what forces tool_choice')
  assert.match(payload.system, /as plain text/, 'the prompt asks for a plain text envelope')
  assert.doesNotMatch(payload.system, /Use StructuredOutput/)
  assert.equal(result.choices[0].message.content, 'ok', 'a plain text envelope still decodes')
})

test('a non-thinking model still gets the structured format', { timeout: 20_000 }, async () => {
  const backend = new Backend(base, 'secret', undefined, () => {})
  const result = await backend.complete(turn(true), undefined, {})
  const payload = runtime.state.messages.at(-1)
  assert.equal(payload.format?.type, 'json_schema')
  assert.match(payload.system, /Use StructuredOutput/)
  assert.equal(result.choices[0].message.content, 'ok')
})
