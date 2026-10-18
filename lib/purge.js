/**
 * Delete the files this plugin downloaded.
 *
 * Uninstalling the plugin itself is the Harness's job (设置 → 插件 → 卸载). What
 * nothing else removes is what the plugin left on disk: the managed runtime
 * (~170 MB), the state directory the runtime keeps beside it, and the logs —
 * ~250 MB on this machine. This module is that second half.
 *
 * It is written for the worst case, a `dataDir` the user pointed somewhere
 * unintended: only names this plugin owns are touched, and a link — a symlink or
 * a Windows directory junction — is unlinked rather than followed, so a delete
 * can never walk out of the tree into something else. (Deleting through a
 * junction is a measured failure mode: on 2026-10-14 an `fs.rmSync` on a
 * directory holding junctions emptied nine package directories elsewhere.)
 *
 * @module dsh-opencode-bridge/purge
 */

import fs from 'node:fs'
import path from 'node:path'
import { BridgeError } from './protocol.js'

/** The only names inside a data directory this plugin may delete. */
export const OWNED_ENTRIES = ['runtime', 'opencode', 'capture', 'opencode.log', 'opencode.log.previous']

/**
 * Subdirectories that prove a directory is this plugin's own.
 *
 * A configured `dataDir` is arbitrary, so refusing to delete anything else is
 * what keeps this from being a "delete a path the user typed" button.
 */
export const MARKERS = ['opencode', 'runtime']

/** Whether a path exists, counting links that point nowhere. */
function exists(target) {
  try { fs.lstatSync(target); return true } catch { return false }
}

/**
 * Sum what a path holds without following a link out of the tree.
 *
 * @param {string} target
 * @returns {{bytes: number, files: number}}
 */
export function measure(target) {
  let stat
  try { stat = fs.lstatSync(target) } catch { return { bytes: 0, files: 0 } }
  if (stat.isSymbolicLink()) return { bytes: 0, files: 0 }
  if (!stat.isDirectory()) return { bytes: stat.size, files: 1 }
  let bytes = 0
  let files = 0
  for (const child of fs.readdirSync(target)) {
    const result = measure(path.join(target, child))
    bytes += result.bytes
    files += result.files
  }
  return { bytes, files }
}

/**
 * Remove one path, unlinking links instead of descending through them.
 *
 * `lstatSync` is what makes this safe: a symlink or junction is not a directory
 * here, so it is unlinked and its target is never visited.
 */
function remove(target) {
  let stat
  try { stat = fs.lstatSync(target) } catch { return false }
  if (!stat.isDirectory()) {
    fs.unlinkSync(target)
    return true
  }
  for (const child of fs.readdirSync(target)) remove(path.join(target, child))
  fs.rmdirSync(target)
  return true
}

/**
 * Measure, or delete, this plugin's own files in `dataDir`.
 *
 * Either way the answer carries the size, so the page can say what it is about
 * to remove and what it removed. Nothing is deleted unless the directory carries
 * one of `MARKERS`.
 *
 * @param {string} dataDir
 * @param {{dryRun?: boolean, before?: () => Promise<void>}} [options] `before` runs
 *   after the directory is accepted and before anything is removed: the runtime
 *   must be stopped first, or Windows refuses to delete a running executable.
 * @returns {Promise<{dryRun: boolean, bytes: number, files: number, entries?: string[], removed?: string[]}>}
 */
export async function purgeDataDir(dataDir, options = {}) {
  const dryRun = options.dryRun === true
  if (!MARKERS.some(marker => exists(path.join(dataDir, marker)))) {
    throw new BridgeError(`${dataDir} 里没有本插件的内容，已拒绝删除`, 400, 'not_plugin_dir')
  }

  const targets = OWNED_ENTRIES
    .map(entry => path.join(dataDir, entry))
    .filter(exists)

  let bytes = 0
  let files = 0
  for (const target of targets) {
    const size = measure(target)
    bytes += size.bytes
    files += size.files
  }

  if (dryRun) return { dryRun: true, bytes, files, entries: targets.map(target => path.basename(target)) }

  await options.before?.()
  const removed = []
  for (const target of targets) {
    if (remove(target)) removed.push(path.basename(target))
  }
  return { dryRun: false, bytes, files, removed }
}
