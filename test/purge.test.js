/**
 * N1: deleting what the plugin downloaded, without deleting anything else.
 *
 * The failure this guards is a data directory the user pointed somewhere
 * unintended, so the cases are about restraint: a directory with none of the
 * plugin's subdirectories is refused, foreign files survive a purge, and a
 * junction — the way a delete walks out of the tree and empties something else
 * (measured on 2026-10-14: nine package directories) — is unlinked, never
 * descended into.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { MARKERS, OWNED_ENTRIES, measure, purgeDataDir } from '../lib/purge.js'

/** A throwaway data directory with the plugin's shape plus foreign files. */
function scaffold() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ocb-purge-'))
  const dataDir = path.join(root, 'data')
  fs.mkdirSync(path.join(dataDir, 'runtime'), { recursive: true })
  fs.mkdirSync(path.join(dataDir, 'opencode'), { recursive: true })
  fs.mkdirSync(path.join(dataDir, 'other'), { recursive: true })
  fs.writeFileSync(path.join(dataDir, 'runtime', 'opencode.exe'), 'x'.repeat(1000))
  fs.writeFileSync(path.join(dataDir, 'runtime', '1.19.0'), 'y'.repeat(100))
  fs.writeFileSync(path.join(dataDir, 'opencode', 'state.json'), 'z'.repeat(10))
  fs.writeFileSync(path.join(dataDir, 'opencode.log'), 'log')
  fs.writeFileSync(path.join(dataDir, 'keep.txt'), 'mine')
  fs.writeFileSync(path.join(dataDir, 'other', 'keep-too.txt'), 'mine')
  return { root, dataDir }
}

test('a directory without the plugin markers is refused', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ocb-purge-stray-'))
  fs.writeFileSync(path.join(root, 'notes.txt'), 'do not delete me')
  await assert.rejects(() => purgeDataDir(root), error => {
    assert.equal(error.code, 'not_plugin_dir')
    assert.equal(error.status, 400)
    return true
  })
  assert.equal(fs.existsSync(path.join(root, 'notes.txt')), true)
  assert.deepEqual(MARKERS, ['opencode', 'runtime'])
})

test('a dry run reports the size and deletes nothing', async () => {
  const { root, dataDir } = scaffold()
  const result = await purgeDataDir(dataDir, { dryRun: true })
  assert.equal(result.dryRun, true)
  assert.equal(result.bytes, 1000 + 100 + 10 + 3)
  assert.equal(result.files, 4)
  assert.deepEqual(result.entries.slice().sort(), ['opencode', 'opencode.log', 'runtime'].sort())
  assert.equal(fs.existsSync(path.join(dataDir, 'runtime', 'opencode.exe')), true)
  assert.deepEqual(OWNED_ENTRIES.includes('capture'), true)
  fs.rmSync(root, { recursive: true })
})

test('a purge removes only owned entries and stops the runtime first', async () => {
  const { root, dataDir } = scaffold()
  let stopped = 0
  const result = await purgeDataDir(dataDir, {
    before: async () => {
      stopped += 1
      assert.equal(fs.existsSync(path.join(dataDir, 'runtime', 'opencode.exe')), true, 'must stop before deleting')
    },
  })
  assert.equal(stopped, 1)
  assert.deepEqual(result.removed.slice().sort(), ['opencode', 'opencode.log', 'runtime'].sort())
  assert.equal(fs.existsSync(path.join(dataDir, 'runtime')), false)
  assert.equal(fs.existsSync(path.join(dataDir, 'opencode')), false)
  assert.equal(fs.existsSync(path.join(dataDir, 'opencode.log')), false)
  assert.equal(fs.readFileSync(path.join(dataDir, 'keep.txt'), 'utf8'), 'mine')
  assert.equal(fs.readFileSync(path.join(dataDir, 'other', 'keep-too.txt'), 'utf8'), 'mine')
  fs.rmSync(root, { recursive: true })
})

test('a junction inside the tree is unlinked, and its target survives', async () => {
  const { root, dataDir } = scaffold()
  const outside = path.join(root, 'outside')
  fs.mkdirSync(outside)
  fs.writeFileSync(path.join(outside, 'precious.txt'), 'do not delete me')
  fs.symlinkSync(outside, path.join(dataDir, 'runtime', 'linked'), 'junction')
  assert.equal(measure(path.join(dataDir, 'runtime', 'linked')).bytes, 0, 'links are never measured through')
  const before = await purgeDataDir(dataDir, { dryRun: true })
  assert.equal(before.bytes, 1000 + 100 + 10 + 3, 'the junction contributes no bytes')
  await purgeDataDir(dataDir)
  assert.equal(fs.existsSync(path.join(outside, 'precious.txt')), true)
  assert.equal(fs.readFileSync(path.join(outside, 'precious.txt'), 'utf8'), 'do not delete me')
  assert.equal(fs.existsSync(path.join(dataDir, 'runtime')), false)
  fs.rmSync(root, { recursive: true })
})
