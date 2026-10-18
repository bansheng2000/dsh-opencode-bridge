/**
 * The managed runtime's log must not grow without bound.
 *
 * Rotation used to happen only when the plugin started, so a Harness left running
 * for weeks kept appending to the same file. The sink now rotates itself, between
 * writes, and counts what a previous run had already left behind.
 */

import { register } from 'node:module'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// The plugin entry imports host-provided packages; the hook stands in for them.
register(new URL('./host-modules-fallback.mjs', import.meta.url))
const { LOG_ROTATE_BYTES, openLogStream } = await import('../lib/index.js')

const MB = 1024 * 1024
const chunk = Buffer.alloc(MB, 0x61)

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ocb-log-'))
}

function size(file) {
  try { return fs.statSync(file).size } catch { return -1 }
}

/** Write a stream to completion. */
const finish = stream => new Promise(resolve => stream.end(resolve))

test('the log rotates while it is being written', async () => {
  const dir = tempDir()
  const file = path.join(dir, 'opencode.log')
  const log = await openLogStream(dir)

  for (let i = 0; i < 6; i += 1) log.write(chunk)
  await finish(log)

  assert.ok(size(file) > 0 && size(file) < LOG_ROTATE_BYTES, `current log is ${size(file)} bytes`)
  assert.equal(size(`${file}.previous`), 5 * MB, 'the first 5 MB moved aside')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('an oversized leftover rotates on the first write', async () => {
  const dir = tempDir()
  const file = path.join(dir, 'opencode.log')
  fs.writeFileSync(file, Buffer.alloc(6 * MB, 0x61))

  const log = await openLogStream(dir)
  log.write('hello')
  await finish(log)

  assert.ok(size(file) < LOG_ROTATE_BYTES, 'the fresh log starts empty')
  assert.equal(size(`${file}.previous`), 6 * MB)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('what a previous run left behind counts toward the cap', async () => {
  const dir = tempDir()
  const file = path.join(dir, 'opencode.log')
  fs.writeFileSync(file, Buffer.alloc(LOG_ROTATE_BYTES - 100 * 1024, 0x61))

  const log = await openLogStream(dir)
  log.write(Buffer.alloc(200 * 1024, 0x62))
  await finish(log)

  assert.equal(size(`${file}.previous`), LOG_ROTATE_BYTES - 100 * 1024)
  assert.equal(size(file), 200 * 1024)
  fs.rmSync(dir, { recursive: true, force: true })
})
