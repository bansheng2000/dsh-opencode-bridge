/**
 * The DSH version gate, pinned.
 *
 * DSH evaluates a bundle manifest before loading it. When the manifest carries a
 * top-level `engines.dsh`, ONLY that range decides — `@deepseek-ai/dsh-app-boot`
 * `unmetRequirements()` runs `semver.satisfies(runtime, range, {
 * includePrerelease: true })` — and an unmet range skips the whole bundle: the
 * plugin vanishes, its models with it, and the log holds one
 * `requirements … are unmet` line. 0.2.0 kept the range at `<0.2.0`, so on
 * 0.2.1-rc.2 the plugin was skipped exactly this way.
 *
 * The peer ranges are pinned here too: they are what the gate falls back to when
 * `engines.dsh` is absent, and what pnpm reads either way.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import semver from 'semver'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

/** The runtime versions this plugin claims to run on. */
const SUPPORTED = ['0.1.1-rc.1', '0.1.1-rc.3', '0.1.5', '0.2.0-rc.2', '0.2.1-rc.2', '0.2.1', '0.2.9']

/**
 * Versions the range must keep refusing.
 *
 * `0.3.0-0` is in the list on purpose: with `includePrerelease`, a plain
 * `<0.3.0` upper bound would still admit prereleases OF 0.3.0 (they sort below
 * it), i.e. an untested line would load. `-0` is the lowest possible
 * prerelease identifier, so the bound refuses the whole next line.
 */
const REFUSED = ['0.3.0-0', '0.3.0-rc.1', '0.3.0', '0.4.2', '1.0.0']

/** DSH's own test: it never checks a prerelease-free range without includePrerelease. */
const satisfied = (runtime, range) => semver.satisfies(runtime, range, { includePrerelease: true })

test('the manifest declares the range DSH actually reads', () => {
  assert.equal(typeof manifest.engines?.dsh, 'string', 'engines.dsh must be a top-level string')
  assert.ok(manifest.engines.dsh.length > 0)
})

test('every supported runtime version passes engines.dsh', () => {
  for (const runtime of SUPPORTED) {
    assert.equal(satisfied(runtime, manifest.engines.dsh), true, `${runtime} must satisfy ${manifest.engines.dsh}`)
  }
})

test('the next minor line is still refused', () => {
  for (const runtime of REFUSED) {
    assert.equal(satisfied(runtime, manifest.engines.dsh), false, `${runtime} must not satisfy ${manifest.engines.dsh}`)
  }
})

test('the host peers accept the same runtimes', () => {
  for (const name of ['@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-llm-pi-ai', '@deepseek-ai/dsh-settings']) {
    const range = manifest.peerDependencies?.[name]
    assert.equal(typeof range, 'string', `${name} must be declared as a peer`)
    for (const runtime of SUPPORTED) {
      assert.equal(satisfied(runtime, range), true, `${name} ${range} must accept ${runtime}`)
    }
  }
})

