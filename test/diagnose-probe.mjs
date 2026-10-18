/**
 * Probe every free model and report the exact failure for each.
 *
 * Reproduces what the settings page's "检测全部" does, but prints the raw error
 * instead of only the status badge — which is what we need to tell a genuinely
 * unusable model apart from a bug in the probe itself.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { findRuntime, startBackend } from '../lib/runtime.js'
import { BridgeCatalog, classifyFailure } from '../lib/catalog.js'
import { prepare } from '../lib/protocol.js'
import { probeBody, probeModel, formatUnsupported, PROBE_ATTEMPT_TIMEOUT_MS } from '../lib/probe.js'

// Reuse the live install's runtime binary so this does not re-download.
const home = process.env.DSH_HOME ?? path.join(process.env.USERPROFILE ?? '', '.dsh')
const LIVE = process.env.OPENCODE_BRIDGE_LIVE_DIR ?? path.join(home, 'opencode-bridge')
const dataDir = process.env.OPENCODE_BRIDGE_DIAG_DIR ?? path.join(os.tmpdir(), '_ocb-diag')
fs.rmSync(dataDir, { recursive: true, force: true })
fs.mkdirSync(path.join(dataDir, 'runtime'), { recursive: true })

const seeded = path.join(LIVE, 'runtime')
for (const entry of fs.existsSync(seeded) ? fs.readdirSync(seeded) : []) {
  if (!fs.statSync(path.join(seeded, entry)).isDirectory()) continue
  fs.cpSync(path.join(seeded, entry), path.join(dataDir, 'runtime', entry), { recursive: true })
  console.log(`reused the seeded runtime ${entry}`)
}

const logStream = fs.createWriteStream(path.join(dataDir, 'diag.log'), { flags: 'a' })
const binary = await findRuntime(dataDir, m => console.log(`[runtime] ${m}`))
const runtime = await startBackend(binary, dataDir, logStream)
const backend = runtime.backend

const catalog = new BridgeCatalog()
catalog.replace(await backend.models())
const models = catalog.all()
console.log(`\nfree models: ${models.length}\n`)

const results = []
for (const model of models) {
  const started = Date.now()
  let verdict
  try {
    // Exercise the real probe path, including its own per-attempt deadline, so
    // this report reflects what the settings page actually does.
    await probeModel({
      complete: (token, signal) => backend.complete(
        prepare(probeBody(model, token), catalog.all()),
        signal,
        { probe: true },
      ),
    })
    verdict = { ok: true, note: '工具调用正常' }
  } catch (error) {
    if (error.code === 'no_action') verdict = { ok: true, chatOnly: true, note: '只回文本，无动作' }
    else if (formatUnsupported(error)) verdict = { ok: true, chatOnly: true, note: `格式不支持：${error.message}` }
    else verdict = { ok: false, code: error.code, status: error.status, note: error.message }
  }
  const ms = Date.now() - started
  results.push({ model, verdict, ms })
  const mark = verdict.ok ? (verdict.chatOnly ? 'CHAT' : ' OK ') : 'FAIL'
  console.log(`[${mark}] ${model.id}`)
  console.log(`       ${verdict.note}`)
  if (!verdict.ok) console.log(`       code=${verdict.code} status=${verdict.status} category=${classifyFailure(verdict.note, verdict.status)}`)
  console.log(`       ${ms} ms`)
}

const failed = results.filter(r => !r.verdict.ok)
console.log(`\n${results.length} probed, ${results.length - failed.length} usable, ${failed.length} failed`)
if (failed.length) {
  console.log('\nfailure codes:')
  const byCode = {}
  for (const r of failed) byCode[r.verdict.code] = (byCode[r.verdict.code] ?? 0) + 1
  for (const [code, n] of Object.entries(byCode)) console.log(`  ${code}: ${n}`)
}

await runtime.stop()
logStream.end()
