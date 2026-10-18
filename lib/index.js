/**
 * Host-side plugin entry.
 *
 * Starts a managed, isolated OpenCode runtime, exposes it through a loopback
 * OpenAI-compatible endpoint, and registers that endpoint as the
 * `opencode-bridge` model provider in the Harness LLM seam. It also mounts the
 * same-origin routes backing this plugin's settings page.
 *
 * Startup is asynchronous on purpose. Preparing the runtime can mean a one-time
 * ~60 MB download, and blocking `apply()` on that would stall the whole Harness
 * boot. The provider is therefore registered once the runtime is healthy; until
 * then the picker simply does not offer it, and the settings page reports the
 * startup state.
 *
 * @module dsh-opencode-bridge
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { Writable } from 'node:stream'
import path from 'node:path'
import z from '@deepseek-ai/schemastery'
import { dataDirectory } from './platform.js'
import { configureProxy, describeProxy, findRuntime, startBackend } from './runtime.js'
import { createShim } from './shim.js'
import { clientModelID } from './model-id.js'
import { BridgeCatalog, classifyFailure } from './catalog.js'
import { createBridgeAdapter, BRIDGE_PROVIDER, BRIDGE_DISPLAY_NAME } from './adapter.js'
import { prepare } from './protocol.js'
import { PROBE_ATTEMPT_TIMEOUT_MS, probeBody, probeModel, formatUnsupported } from './probe.js'
import { registerBridgeStatusRoute } from './web-status.js'
import { purgeDataDir } from './purge.js'

/** Stable Cordis plugin name. */
export const name = 'llm-opencode-bridge'

/** The model registry must exist before a provider can register. */
export const inject = ['llm']

/** Settings namespace reserved for this plugin. */
export const BRIDGE_SETTINGS_NS = 'opencode-bridge'

/**
 * Plugin configuration schema.
 *
 * Declared so the host can validate and surface these fields, and so a bad
 * value is reported at configuration time rather than at runtime.
 */
export const Config = z.object({
  dataDir: z.string().description('存放受管 OpenCode 运行时、日志与状态的目录（默认在 DSH home 下）'),
  binaryPath: z.string().description('使用已有的 OpenCode 可执行文件，而不是下载官方版本'),
  runtimeVersion: z.string().description('固定使用某个 OpenCode 版本'),
  autoRefresh: z.boolean().default(true).description('启动后稍晚重新读取一次免费模型清单'),
  // These two are the only fields declared `volatile`, and that is what puts
  // them in an editable form at all — the Harness only renders settings for
  // volatile fields (设置 → 插件 → 已安装 → dsh-opencode-bridge → 组件
  // llm-opencode-bridge → 配置). `apply` reads them live through `syncProxy`.
  proxyUrl: z.string().volatile()
    .description('出站 HTTP 代理地址，如 http://127.0.0.1:2080（也接受裸 host:port）；留空则沿用环境变量 HTTPS_PROXY/HTTP_PROXY。回环地址恒直连'),
  proxyRuntime: z.boolean().default(false).volatile()
    .description('把代理也交给受管 OpenCode 运行时。默认关：实测转发会让每次 completion 挂住，只有运行时确实没有直连出口时才打开'),
})

/** Default config values, documented in one place. */
export const DEFAULTS = {
  autoRefresh: true,
  proxyRuntime: false,
}

/** How long to wait before the post-startup roster refresh. */
const REFRESH_DELAY_MS = 15_000

/** Cap on the managed runtime's log file. */
export const LOG_ROTATE_BYTES = 5 * 1024 * 1024

/**
 * A log sink that rotates itself once it passes the cap.
 *
 * Trimming only at startup left a long-running Harness growing `opencode.log`
 * without bound — the child writes its whole lifetime of logs into one stream.
 * Rotation happens between writes, so the file is closed before it is renamed
 * (Windows refuses to rename an open file) and no chunk is written to a closed
 * stream.
 *
 * @param {string} file log path
 * @param {number} cap rotate after this many bytes have been written to one file
 * @param {number} startBytes bytes already in `file`, so an existing log counts
 */
export function createRollingLog(file, cap = LOG_ROTATE_BYTES, startBytes = 0) {
  const previous = `${file}.previous`
  const open = () => new Promise((resolve, reject) => {
    const stream = fs.createWriteStream(file, { flags: 'a', mode: 0o600 })
    stream.once('open', () => resolve(stream))
    stream.once('error', reject)
  })

  let target
  let bytes = startBytes

  const roll = async () => {
    bytes = 0
    const stale = target
    target = undefined
    // Close before renaming: Windows refuses to rename an open file. A file
    // left behind by an earlier run has no stream here and is renamed as-is.
    if (stale !== undefined) await new Promise(resolve => stale.end(resolve))
    await fsp.rename(file, previous).catch(() => {})
    target = await open()
  }

  return new Writable({
    async write(chunk, _encoding, callback) {
      try {
        bytes += chunk.length
        if (bytes > cap) await roll()
        if (target === undefined) target = await open()
        target.write(chunk)
        callback()
      } catch (error) { callback(error) }
    },
    async final(callback) {
      try {
        await new Promise(resolve => (target === undefined ? resolve() : target.end(resolve)))
        callback()
      } catch (error) { callback(error) }
    },
  })
}

/**
 * Open the managed runtime's log, trimming an oversized leftover first.
 *
 * The size is read before opening so a log left large by a previous run rotates
 * on the first write of this one, rather than only after another 5 MB.
 */
export async function openLogStream(dataDir) {
  const file = path.join(dataDir, 'opencode.log')
  let startBytes = 0
  try {
    const stat = await fsp.stat(file)
    startBytes = stat.size
    if (startBytes > LOG_ROTATE_BYTES) {
      await fsp.rename(file, `${file}.previous`)
      startBytes = 0
    }
  } catch { /* no existing log */ }
  return createRollingLog(file, LOG_ROTATE_BYTES, startBytes)
}

/**
 * Shape the probe route's reply.
 *
 * A sweep takes tens of seconds per model, so the route must NOT wait for it.
 * Waiting kept the HTTP response open for the whole run — worst case
 * models × 2 × PROBE_ATTEMPT_TIMEOUT_MS — while the settings page already polls
 * `status` every 5 s for `probe.running/current/pending`. Nothing is lost by
 * answering early: every result still lands in the catalog, which the status
 * document carries.
 *
 * @param {{started: boolean, count?: number}} started result of the probe starter
 * @returns {object} the JSON body the route sends, never a promise
 */
export const probeRouteResult = started => (
  started.started === false ? started : { started: true, count: started.count, pending: true }
)

/**
 * Cordis plugin entry.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Config} config
 */
export function apply(ctx, config = {}) {
  const logger = ctx.logger ?? console
  // `proxyUrl` and `proxyRuntime` are volatile, so this snapshot holds wrappers
  // rather than values. They are read live through `syncProxy` and must not be
  // read from `settings`.
  const settings = { ...DEFAULTS, ...config }
  const dataDir = dataDirectory(settings)

  // Both proxy consumers (the downloader and the child environment) read this,
  // so it is set before anything can start a runtime. Called again before every
  // download and runtime start, since the fields stay editable while running.
  const syncProxy = () => configureProxy({ url: config.proxyUrl, runtime: config.proxyRuntime })
  syncProxy()

  const catalog = new BridgeCatalog()
  let runtime
  let shim
  let backend
  let logStream
  let closed = false
  let phase = 'starting'
  let message = '正在启动隔离模型服务'
  /** In-flight requests, keyed by session, for the page's activity line. */
  const activities = new Map()
  let probeState = { running: false, current: undefined, pending: [] }
  /**
   * Whether the provider was registered.
   *
   * Registering twice for the same provider is refused by the host, so a start
   * that is retried after a failure must not repeat it.
   */
  let registered = false

  /**
   * Release the runtime-side resources of one start attempt, without latching
   * the plugin shut.
   *
   * `closed` is the latch for a real unload, so a FAILED start must not set it:
   * doing that made the settings page's retry button throw 「插件已卸载」
   * forever after a single bad boot (a download timeout was enough), leaving a
   * full Harness restart as the only way out.
   */
  const releaseRuntime = async () => {
    await shim?.close().catch(() => {})
    await runtime?.stop().catch(() => {})
    shim = undefined
    runtime = undefined
    backend = undefined
  }

  /** Release everything this plugin owns, once. */
  const shutdown = async () => {
    if (closed) return
    closed = true
    phase = 'stopped'
    await releaseRuntime()
    logStream?.end()
  }

  // Register teardown before any resource exists, so a failure part-way through
  // still releases whatever was already created.
  ctx.effect(() => shutdown)

  /**
   * Read the free-model catalog from the runtime.
   *
   * A failure keeps the previous list rather than emptying the picker: an
   * unreadable catalog is not a verdict on any model.
   */
  const refresh = async () => {
    if (backend === undefined) throw new Error('运行时尚未就绪')
    const models = await backend.models()
    catalog.replace(models)
    logger.info?.(`dsh-opencode-bridge: ${models.length} 个免费模型可用`)
    return { count: models.length }
  }

  /**
   * Run a detection sweep, one model at a time.
   *
   * Sequential on purpose: probing in parallel would compete for the same
   * upstream quota and make every measurement slower and noisier.
   */
  const probe = async (modelId) => {
    if (backend === undefined) throw new Error('运行时尚未就绪')
    if (probeState.running) return { started: false, message: '检测正在进行' }

    const selected = modelId ? catalog.all().filter(model => model.id === modelId) : catalog.all()
    if (selected.length === 0) throw new Error('模型不在当前目录中')

    probeState = { running: true, current: undefined, pending: selected.map(model => model.id) }
    let ok = 0
    let failed = 0

    // Detached from the HTTP request: a sweep takes tens of seconds per model,
    // so the route returns immediately and the page follows `probe` progress.
    const task = (async () => {
      try {
        for (const model of selected) {
          if (closed) break
          probeState = { running: true, current: model.id, pending: probeState.pending.filter(id => id !== model.id) }
          const started = Date.now()
          try {
            if (model.supportsTools === false) {
              throw Object.assign(new Error('运行时未声明该模型支持工具调用'), { code: 'invalid_tool_call', status: 502 })
            }
            await probeModel({
              // `complete` takes a PREPARED request, so the probe body goes
              // through the same `prepare` the real request path uses. Running
              // detection through the real translator is the point: it measures
              // the model on the path actual traffic takes.
              //
              // Validation runs against `all()`, NOT `visible()`: `visible()`
              // hides models already marked unusable, so probing against it
              // made every failed model permanently unprobeable — `prepare`
              // rejected it as model_not_found and the badge could never
              // recover.
              //
              // Each attempt gets its own deadline (owned by `probeModel`), so
              // a slow first try cannot starve the retry.
              complete: (token, signal) => backend.complete(
                prepare(probeBody(model, token), catalog.all()),
                signal,
                { probe: true },
              ),
            })
            catalog.record(model.id, { ok: true, source: 'probe', durationMs: Date.now() - started })
            ok += 1
          } catch (cause) {
            const error = cause
            if (!closed && error.code === 'no_action') {
              // A text-only reply says the model works, just not for tool use:
              // publish it as chat-only instead of withdrawing it.
              catalog.record(model.id, {
                ok: true, source: 'probe', chatOnly: true, durationMs: Date.now() - started,
                error: '探测时只返回文本、未产生动作；已按仅对话发布',
              })
              ok += 1
            } else if (!closed && formatUnsupported(error)) {
              catalog.record(model.id, {
                ok: true, source: 'probe', chatOnly: true, durationMs: Date.now() - started,
                error: `工具转换不兼容：${error.message}`,
              })
              ok += 1
            } else if (!closed) {
              catalog.record(model.id, {
                ok: false, source: 'probe', durationMs: Date.now() - started,
                category: classifyFailure(error.message, error.status),
                error: error.name === 'TimeoutError' ? '模型探测超时' : error.message,
              })
              failed += 1
            }
          }
        }
      } finally {
        probeState = { running: false, current: undefined, pending: [] }
      }
    })()

    return { started: true, count: selected.length, task, done: task.then(() => ({ ok, failed })) }
  }

  /**
   * Restart the managed runtime, keeping the shim and provider in place.
   *
   * Only the OpenCode process is replaced: the shim's `complete` reads the
   * `backend` variable at call time and the adapter reads `shim.baseUrl()` per
   * model list, so neither needs re-registering. Re-registering would also fail
   * with DUPLICATE_ADAPTER.
   */
  const restart = async () => {
    if (closed) throw new Error('插件已卸载')
    logger.info?.('dsh-opencode-bridge: 正在重启运行时')
    phase = 'starting'
    message = '正在重启 OpenCode 运行时'
    // A proxy typed in since boot applies to the runtime started below.
    syncProxy()

    // A start that died before the loopback endpoint existed has nothing worth
    // keeping, so the whole start is retried; otherwise only the OpenCode
    // process is replaced and the shim — hence the registered endpoint — stays.
    if (shim === undefined || !registered) {
      await releaseRuntime()
      return start()
    }

    await runtime?.stop().catch(() => {})
    runtime = undefined
    backend = undefined

    await fsp.mkdir(dataDir, { recursive: true, mode: 0o700 })
    const binary = await findRuntime(dataDir, text => {
      message = text
      logger.info?.(`dsh-opencode-bridge: ${text}`)
    }, {
      ...(settings.binaryPath ? { candidates: [settings.binaryPath] } : {}),
      ...(settings.runtimeVersion ? { version: settings.runtimeVersion } : {}),
    })
    runtime = await startBackend(binary, dataDir, logStream)
    backend = runtime.backend
    if (closed) { await runtime.stop().catch(() => {}); return {} }

    await refresh().catch(error => {
      logger.warn?.(`dsh-opencode-bridge: 重启后读取模型失败：${error.message}`)
    })
    phase = 'ready'
    message = `运行中 · ${catalog.all().length} 个免费模型`
    return { count: catalog.all().length, runtimeVersion: runtime.version }
  }

  /** Build the status document the settings page renders. */
  const status = () => {
    // The page reports the route the proxy fields currently ask for, so an edit
    // is reflected without a reload.
    syncProxy()
    return {
      phase,
      message,
      runtimeVersion: runtime?.version,
      endpoint: shim?.baseUrl(),
      dataDir,
      provider: BRIDGE_PROVIDER,
      models: catalog.describeAll(),
      probe: probeState,
      // Which route the runtime's own upstream calls take. Surfaced because a
      // proxied network that the runtime did not inherit is indistinguishable from
      // an upstream outage on the page otherwise.
      proxy: describeProxy(),
      activity: [...activities.values()].map(entry => ({
        model: entry.model,
        status: entry.status,
        waitedMs: Date.now() - entry.startedAt,
        ...(entry.attempt !== undefined ? { attempt: entry.attempt } : {}),
        ...(entry.error !== undefined ? { error: entry.error } : {}),
      })),
      metrics: catalog.metrics(),
    }
  }

  /**
   * Bridge the runtime's progress events into the activity map.
   *
   * A slow or retrying upstream otherwise produces no visible state at all, so
   * the page would show a bare "request in flight" with no detail.
   */
  const noteActivity = progress => {
    if (!progress?.sessionID) return
    if (progress.type === 'request.done') { activities.delete(progress.sessionID); return }
    const entry = activities.get(progress.sessionID) ?? { sessionID: progress.sessionID, startedAt: Date.now(), status: 'waiting' }
    Object.assign(entry, {
      model: progress.model ?? entry.model,
      status: progress.status ?? entry.status,
      ...(progress.attempt !== undefined ? { attempt: progress.attempt } : {}),
      ...(progress.error !== undefined ? { error: progress.error } : {}),
    })
    activities.set(progress.sessionID, entry)
  }

  /** Record a real request's outcome against the catalog. */
  const onResult = (modelId, ok, error, statusCode) => {
    if (!modelId) return
    catalog.record(modelId, {
      ok,
      source: 'request',
      ...(ok ? {} : { category: classifyFailure(error ?? '', statusCode), error: error ?? '请求失败' }),
    })
  }

  /** Start (or restart) the runtime and register the provider. */
  const init = async () => {
    if (closed) return
    await fsp.mkdir(dataDir, { recursive: true, mode: 0o700 })
    if (logStream === undefined) logStream = await openLogStream(dataDir)
    if (closed) return

    phase = 'starting'
    message = '正在准备 OpenCode 运行时'

    // A proxy typed in since boot applies to the download that follows.
    syncProxy()

    // 1. A real OpenCode binary. Required, not incidental: OpenCode Zen only
    //    serves its free tier to traffic from a genuine OpenCode runtime.
    const binary = await findRuntime(dataDir, text => {
      message = text
      logger.info?.(`dsh-opencode-bridge: ${text}`)
    }, {
      ...(settings.binaryPath ? { candidates: [settings.binaryPath] } : {}),
      ...(settings.runtimeVersion ? { version: settings.runtimeVersion } : {}),
    })
    if (closed) return

    // 2. The isolated runtime: its own XDG root, a fresh server secret, and the
    //    approval-gated agents that keep the free tier reachable.
    runtime = await startBackend(binary, dataDir, logStream)
    backend = runtime.backend
    if (closed) return
    logger.info?.(`dsh-opencode-bridge: OpenCode ${runtime.version} 运行时已就绪`)

    // 3. The loopback endpoint pi-ai will talk to.
    shim = await createShim({
      complete: (request, signal, meta) => backend.complete(request, signal, meta),
      getModels: () => catalog.visible(),
      refresh,
      logger,
      // Lets a `capture-requests` marker file in the data directory switch on
      // request capture without needing to relaunch the Harness with an env var.
      dataDir,
    })
    if (closed) return
    logger.info?.(`dsh-opencode-bridge: 本地端点 ${shim.baseUrl()}`)

    // 4. Seed the catalog before registering, so the provider is never empty.
    await refresh().catch(error => {
      logger.warn?.(`dsh-opencode-bridge: 免费模型读取失败，稍后重试：${error.message}`)
    })
    if (closed) return

    phase = 'ready'
    message = `运行中 · ${catalog.all().length} 个免费模型`

    // 5. Re-read the roster once startup settles: the first reading can race
    //    upstream catalog propagation.
    if (settings.autoRefresh && !closed) {
      const timer = setTimeout(() => { void refresh().catch(() => {}) }, REFRESH_DELAY_MS)
      timer.unref?.()
    }
    return { count: catalog.all().length }
  }

  /** Register the provider once the runtime is healthy. */
  const register = () => {
    if (closed) return
    const bridge = createBridgeAdapter({ shim, catalog, ctx })
    const releaseAdapter = ctx.llm.registerAdapter([BRIDGE_PROVIDER], bridge.adapter)
    const releaseDirectory = ctx.llm.registerConfigurableProviders([{
      provider: BRIDGE_PROVIDER,
      displayName: BRIDGE_DISPLAY_NAME,
      settingsNs: BRIDGE_SETTINGS_NS,
      settingsPath: [],
      declared: false,
    }])
    // Answering discovery from the live catalog is what makes a newly available
    // free model appear without restarting the host.
    const releaseDiscovery = ctx.llm.registerModelDiscovery(BRIDGE_SETTINGS_NS, async request => {
      if (request?.provider !== undefined && request.provider !== BRIDGE_PROVIDER) return []
      return catalog.visible().map(model => ({
        id: model.id,
        name: clientModelID(model),
        contextWindow: model.contextWindow,
        maxTokens: model.maxOutputTokens,
        inputModalities: model.supportsImages ? ['text', 'image'] : ['text'],
      }))
    })

    ctx.effect(() => () => {
      try { releaseDiscovery() } catch { /* already released */ }
      try { releaseDirectory() } catch { /* already released */ }
      try { releaseAdapter() } catch { /* already released */ }
    })
    logger.info?.(`dsh-opencode-bridge: provider "${BRIDGE_PROVIDER}" 已注册，${catalog.visible().length} 个模型`)
  }

  /**
   * Start the runtime and publish the provider.
   *
   * Separated from `init` because a failed start is retryable: `init` re-creates
   * whatever is missing (the shim included), while the provider is registered at
   * most once.
   *
   * The failure state is owned here rather than by the caller, so a retry that
   * fails again (the page's 「重启」 button) reports the new reason instead of
   * leaving the card stuck on 「正在重启」. Resources built by the attempt are
   * released and the error is re-thrown for the route to answer with.
   */
  const start = async () => {
    try {
      await init()
      if (closed) return {}
      if (!registered) { register(); registered = true }
      return { count: catalog.all().length, runtimeVersion: runtime?.version }
    } catch (error) {
      phase = 'error'
      message = `运行时错误：${error?.message ?? error}`
      logger.error?.(`dsh-opencode-bridge: 启动失败：${error?.message ?? error}`)
      // Release only what this attempt built: the plugin stays startable, so the
      // settings page's retry button can call `restart` and try again.
      await releaseRuntime()
      throw error
    }
  }

  // The settings page's routes. `webServer` is optional: a headless profile
  // simply never mounts them and the provider still serves models.
  ctx.inject(['webServer'], webCtx => {
    registerBridgeStatusRoute(webCtx, {
      status,
      refresh: async modelId => {
        if (modelId) return { count: (await refresh(), catalog.all().length) }
        return refresh()
      },
      probe: async modelId => {
        const started = await probe(modelId)
        if (started.started === false) return started
        // Nothing awaits the sweep any more, so a failure inside it must not
        // surface as an unhandled rejection. Per-model failures are recorded in
        // the catalog and reach the page through the status document.
        void started.done.catch(error => {
          logger.warn?.(`检测任务意外结束：${error?.message ?? error}`)
        })
        return probeRouteResult(started)
      },
      restart,
      model: modelId => catalog.describe(modelId),
      // Delete the runtime, state, log and captures this plugin downloaded.
      // The runtime has to stop first: Windows refuses to delete a running
      // executable, and a half-deleted runtime directory is worse than none.
      // The catalog is left alone — restart re-reads it — so the page says what
      // happened instead of silently emptying the model list.
      purge: async dryRun => {
        const result = await purgeDataDir(dataDir, { dryRun, before: releaseRuntime })
        if (!dryRun && result.removed.length > 0) {
          phase = 'stopped'
          message = `本机运行时数据已清除（${(result.bytes / 1048576).toFixed(1)} MB），点「重启」会重新下载`
        }
        return result
      },
    })
  })

  // Deliberately not awaited: the download must never hold up Harness boot.
  void (async () => {
    try {
      await start()
    } catch {
      // `start` already recorded the failure state and released its resources.
      // Nothing to do here: the settings page offers a retry.
    }
  })()
}

export { BRIDGE_PROVIDER, BRIDGE_DISPLAY_NAME }
export { dataDirectory, dshHome, runtimePackage } from './platform.js'
export { configureProxy, describeProxy, findRuntime, proxyFor, startBackend, nativePermissions, isolatedAgents } from './runtime.js'
export { Backend, freeModels } from './backend.js'
export { clientModelID } from './model-id.js'
export { BridgeCatalog, classifyFailure } from './catalog.js'
export { createShim } from './shim.js'
export { createBridgeAdapter } from './adapter.js'
export { prepare, decode, completion, BridgeError } from './protocol.js'
export { registerBridgeStatusRoute } from './web-status.js'
export { probeBody, probeModel, judgeProbe } from './probe.js'
export { OWNED_ENTRIES, MARKERS, measure, purgeDataDir } from './purge.js'
