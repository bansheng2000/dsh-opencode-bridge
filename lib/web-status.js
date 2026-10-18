/**
 * Same-origin HTTP routes backing the OpenCode XD Bridge settings card.
 *
 * These answer same-machine browser requests only and never carry the runtime's
 * server secret. Reads are GET; every action is an explicit POST.
 *
 * Every route passes `inspectRequest` first: the `Host` header and the socket
 * peer must be loopback (this is what stops a cloudflared tunnel from reaching
 * the card's actions), an `Origin` that is present must be loopback and match
 * `Host`, and a write must be `application/json` — a cross-site page cannot set
 * that type without a preflight, and this plugin answers no preflight. This is
 * not authentication: a local process can forge every one of these headers.
 *
 * Mounted on the Host's `webServer` through `ctx.inject(['webServer'], …)` so
 * startup order cannot make the registration disappear. `webServer` is an
 * optional service: a headless profile simply never mounts these routes and the
 * provider keeps serving models regardless.
 *
 * @module dsh-opencode-bridge/web-status
 */

import {
  BRIDGE_MODEL_PATH,
  BRIDGE_PROBE_PATH,
  BRIDGE_PURGE_PATH,
  BRIDGE_REFRESH_PATH,
  BRIDGE_RESTART_PATH,
  BRIDGE_STATUS_PATH,
} from './status-paths.js'

/** Cap on the request body this plugin will parse. */
const BODY_LIMIT = 64 * 1024

function json(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  })
  res.end(text)
}

/** One-line message safe to return to the browser. */
function safeMessage(error) {
  const text = error instanceof Error ? error.message : String(error)
  return text.length > 500 ? `${text.slice(0, 500)}…` : text
}

/** Hostnames that mean "this machine". */
function loopbackHostname(hostname) {
  const name = String(hostname).toLowerCase().replace(/^\[|\]$/g, '')
  return name === 'localhost' || name === '::1' || name === '0:0:0:0:0:0:0:1' || /^127\./.test(name)
}

/** Parse a `Host` header (host or host:port) without trusting it. */
function parseHostHeader(value) {
  if (typeof value !== 'string' || value === '') return undefined
  try { return new URL(`http://${value}`) } catch { return undefined }
}

/**
 * Decide whether a request may reach a route, and how to refuse it when not.
 *
 * @param {import('node:http').IncomingMessage} req
 * @returns {{ status: number, error: string } | null} null when the request may proceed
 */
export function inspectRequest(req) {
  const host = parseHostHeader(req.headers.host)
  if (host === undefined || !loopbackHostname(host.hostname)) return { status: 403, error: 'host-not-loopback' }
  if (!loopbackHostname(req.socket?.remoteAddress ?? '')) return { status: 403, error: 'address-not-loopback' }

  const origin = req.headers.origin
  if (origin !== undefined && origin !== '') {
    let parsed
    try { parsed = new URL(origin) } catch { parsed = undefined }
    // Same-origin POSTs carry Origin too, so an absent one (curl, the host
    // itself) stays allowed; a present one must be this very page.
    if (parsed === undefined || !loopbackHostname(parsed.hostname) || parsed.host !== host.host) {
      return { status: 403, error: 'origin-not-trusted' }
    }
  }

  const method = String(req.method ?? 'GET').toUpperCase()
  if (method !== 'GET' && method !== 'HEAD') {
    const type = String(req.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase()
    if (type !== 'application/json') return { status: 415, error: 'content-type-not-json' }
  }
  return null
}

/** Read and parse a bounded JSON body. */
async function readJson(req) {
  const chunks = []
  let bytes = 0
  for await (const chunk of req) {
    bytes += chunk.length
    if (bytes > BODY_LIMIT) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  if (bytes === 0) return {}
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  catch { throw new Error('请求体不是合法 JSON') }
}

/**
 * Mount every route this plugin owns.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx a context where `webServer` is present
 * @param {object} deps the live plugin state
 * @param {() => object} deps.status current status document
 * @param {(modelId?: string) => Promise<object>} deps.refresh re-read the roster
 * @param {(modelId?: string) => Promise<object>} deps.probe run a detection sweep
 * @param {() => Promise<object>} deps.restart restart the managed runtime
 * @param {(modelId: string) => object|undefined} deps.model one model's detail
 * @param {(dryRun: boolean) => Promise<object>} deps.purge delete the downloaded runtime and state
 */
export function registerBridgeStatusRoute(ctx, deps) {
  ctx.effect(() => {
    const disposers = []

    /** Wrap a handler with the shared guards. */
    const route = (path, method, handler) => {
      disposers.push(ctx.webServer.register({
        kind: 'exact',
        path,
        handler: async (req, res) => {
          if (req.method !== method) return json(res, 405, { error: 'method not allowed' })
          const denial = inspectRequest(req)
          if (denial !== null) return json(res, denial.status, { error: denial.error })
          try {
            await handler(req, res)
          } catch (error) {
            const status = Number(error?.status)
            json(res, status >= 400 && status < 500 ? status : 500, { error: safeMessage(error) })
          }
        },
      }))
    }

    route(BRIDGE_STATUS_PATH, 'GET', async (req, res) => {
      json(res, 200, deps.status())
    })

    // Re-read the free-model roster. Separate from the probe: this only asks the
    // runtime what it offers, and is the way back from a failed startup read.
    route(BRIDGE_REFRESH_PATH, 'POST', async (req, res) => {
      const body = await readJson(req)
      const result = await deps.refresh(typeof body.model === 'string' ? body.model : undefined)
      json(res, 200, { ok: true, ...result })
    })

    // Run a real detection sweep. Takes tens of seconds per model, so it runs
    // in the background and the card polls the status document for progress.
    route(BRIDGE_PROBE_PATH, 'POST', async (req, res) => {
      const body = await readJson(req)
      const result = await deps.probe(typeof body.model === 'string' ? body.model : undefined)
      json(res, 200, { ok: true, ...result })
    })

    route(BRIDGE_RESTART_PATH, 'POST', async (req, res) => {
      const result = await deps.restart()
      json(res, 200, { ok: true, ...result })
    })

    // Delete what this plugin downloaded: the managed runtime, the state it
    // keeps, the log and any captures. Uninstalling the plugin itself is the
    // Harness's job (设置 → 插件 → 卸载); this removes the ~250 MB nothing else
    // cleans up. Phased on purpose: `{dryRun: true}` only reports the size, so
    // the card can ask before one stray click removes a quarter of a gigabyte.
    route(BRIDGE_PURGE_PATH, 'POST', async (req, res) => {
      const body = await readJson(req)
      const result = await deps.purge(body.dryRun === true)
      json(res, 200, { ok: true, ...result })
    })

    route(BRIDGE_MODEL_PATH, 'GET', async (req, res) => {
      const id = new URL(req.url ?? '/', 'http://localhost').searchParams.get('id')
      if (!id) return json(res, 400, { error: 'missing id' })
      const model = deps.model(id)
      if (model === undefined) return json(res, 404, { error: 'unknown model' })
      json(res, 200, model)
    })

    return () => {
      for (const dispose of disposers) {
        try { dispose() } catch { /* already released */ }
      }
    }
  })
}
