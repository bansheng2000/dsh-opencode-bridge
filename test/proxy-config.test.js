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
import {
  configureProxy, describeProxy, proxyFor, runtimeProxyEnabled, runtimeProxyEnv,
} from '../lib/runtime.js'

const PROXY_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
  'OPENCODE_XDBRIDGE_RUNTIME_PROXY']

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
    const proxy = proxyFor('https://registry.npmjs.org/dsh-opencode-xdbridge')
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
