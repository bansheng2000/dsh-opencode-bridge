/**
 * The proxy the settings page accepts.
 *
 * The split it pins: a typed-in proxy is used for the downloader always, and for
 * the runtime only when the user says so. That is not symmetry for its own sake —
 * forwarding a proxy into the runtime was measured to hang every completion
 * (2026-10-08, see proxy-env.test.js), while a 57 MB cross-border download goes
 * from ~90 KB/s to >1 MB/s through one. With no proxy typed in, every helper must
 * behave exactly as it did before this field existed.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import z from '@deepseek-ai/schemastery'
import {
  configureProxy, describeProxy, proxyFor, runtimeProxyEnabled, runtimeProxyEnv,
} from '../lib/runtime.js'

const PROXY_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
  'OPENCODE_BRIDGE_RUNTIME_PROXY']

/** Run `fn` with a scrubbed proxy environment, then restore exactly what was there. */
function withEnv(values, fn) {
  const saved = new Map(PROXY_KEYS.map(key => [key, process.env[key]]))
  for (const key of PROXY_KEYS) delete process.env[key]
  Object.assign(process.env, values)
  try {
    return fn()
  } finally {
    for (const key of PROXY_KEYS) {
      const value = saved.get(key)
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

/** Run `fn` with a configuration, then put the module back to its default. */
function withConfig(options, fn) {
  configureProxy(options)
  try {
    return fn()
  } finally {
    configureProxy()
  }
}

test('an unset proxy routes exactly as it did before the field existed', () => {
  withConfig({}, () => withEnv({}, () => {
    assert.equal(proxyFor('https://registry.npmjs.org/'), undefined)
    assert.equal(runtimeProxyEnabled(), false)
    assert.deepEqual(runtimeProxyEnv(), {})
    assert.equal(describeProxy().summary, '直连（默认）')
  }))
})

test('a typed proxy carries the download with no environment involved', () => {
  withConfig({ url: 'http://127.0.0.1:2080' }, () => withEnv({}, () => {
    const proxy = proxyFor('https://registry.npmjs.org/dsh-opencode-bridge')
    assert.equal(proxy.protocol, 'http:')
    assert.equal(proxy.hostname, '127.0.0.1')
    assert.equal(proxy.port, '2080')
  }))
})

test('a bare host:port is read as an http proxy', () => {
  withConfig({ url: '127.0.0.1:2080' }, () => withEnv({}, () => {
    assert.equal(proxyFor('https://github.com/').protocol, 'http:')
  }))
})

test('NO_PROXY still outranks a typed proxy', () => {
  withConfig({ url: 'http://127.0.0.1:2080' }, () => withEnv({ NO_PROXY: '.npmjs.org' }, () => {
    assert.equal(proxyFor('https://registry.npmjs.org/'), undefined)
    assert.equal(proxyFor('https://github.com/').hostname, '127.0.0.1')
  }))
})

test('a typed proxy leaves the runtime direct until it is asked for', () => {
  withConfig({ url: 'http://127.0.0.1:2080' }, () => withEnv({}, () => {
    assert.equal(runtimeProxyEnabled(), false)
    assert.deepEqual(runtimeProxyEnv(), {})
    const described = describeProxy()
    assert.equal(described.enabled, false)
    assert.match(described.summary, /下载经代理 http:\/\/127\.0\.0\.1:2080/)
    assert.match(described.summary, /运行时直连/)
  }))
})

test('asking for it hands the runtime the typed proxy, not the ambient one', () => {
  withConfig({ url: 'http://127.0.0.1:2080', runtime: true }, () => withEnv({
    HTTPS_PROXY: 'http://127.0.0.1:7897',
    HTTP_PROXY: 'http://127.0.0.1:7897',
  }, () => {
    const env = runtimeProxyEnv()
    assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:2080')
    assert.equal(env.https_proxy, 'http://127.0.0.1:2080')
    // ALL_PROXY means SOCKS to some clients; an http proxy must not pose as one.
    assert.equal(env.ALL_PROXY, undefined)
    assert.equal(env.all_proxy, undefined)
    assert.match(env.NO_PROXY, /127\.0\.0\.1/)
  }))
})

test('a proxy that cannot be parsed falls back to direct rather than to the child', () => {
  withConfig({ url: 'http://[', runtime: true }, () => withEnv({}, () => {
    assert.deepEqual(runtimeProxyEnv(), {})
    assert.equal(runtimeProxyEnabled(), true)
    assert.equal(describeProxy().configured, false)
  }))
})

test('credentials stay out of the status line', () => {
  withConfig({ url: 'http://user:secret@127.0.0.1:2080', runtime: true }, () => withEnv({}, () => {
    const described = describeProxy()
    assert.equal(described.host, '127.0.0.1:2080')
    assert.ok(!described.summary.includes('secret'), '凭据不应出现在状态页面上')
  }))
})
/**
 * The settings form hands the plugin volatile wrappers, not values.
 *
 * Volatile is load-bearing twice over: the Harness only renders a settings form
 * for a loader entry whose schema declares volatile fields, and each such field
 * resolves to a frozen `{ get }` wrapper that the loader rewrites in place when
 * the form is saved. If the unwrapping regressed, the form would either not
 * appear at all, or `new URL()` would be handed a wrapper and the route would
 * silently stay direct while the page claimed otherwise.
 */
test('a volatile config field is read through its wrapper', () => {
  const schema = z.object({
    proxyUrl: z.string().volatile(),
    proxyRuntime: z.boolean().default(false).volatile(),
  })
  const config = schema({ proxyUrl: 'http://127.0.0.1:2080', proxyRuntime: true })
  assert.equal(typeof config.proxyUrl.get, 'function', '前提：volatile 字段是包装对象而不是值')
  withConfig({ url: config.proxyUrl, runtime: config.proxyRuntime }, () => withEnv({}, () => {
    assert.equal(proxyFor('https://registry.npmjs.org/').hostname, '127.0.0.1')
    assert.equal(runtimeProxyEnabled(), true)
  }))
})

test('a wrapper re-read after an edit reflects the new value', () => {
  const schema = z.object({
    proxyUrl: z.string().volatile(),
    proxyRuntime: z.boolean().default(false).volatile(),
  })
  const before = schema({ proxyUrl: 'http://127.0.0.1:2080' })
  withConfig({ url: before.proxyUrl, runtime: before.proxyRuntime }, () => withEnv({}, () => {
    assert.match(describeProxy().summary, /下载经代理 http:\/\/127\.0\.0\.1:2080/)
    // What saving the form looks like from here: same shape, new wrapper.
    // `apply` reaches the field through a closure rather than a snapshot, which
    // is the only reason this is not stale by construction.
    const after = schema({ proxyUrl: 'http://127.0.0.1:7897' })
    configureProxy({ url: after.proxyUrl, runtime: after.proxyRuntime })
    assert.equal(proxyFor('https://github.com/').port, '7897')
  }))
})

test('both proxy fields are declared volatile, or the form never renders', () => {
  const source = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.match(source, /proxyUrl: z\.string\(\)\.volatile\(\)/)
  assert.match(source, /proxyRuntime: z\.boolean\(\)\.default\(false\)\.volatile\(\)/)
})
