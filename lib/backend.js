/**
 * The backend: one inference turn against the isolated OpenCode runtime.
 *
 * Responsibilities:
 *  - open a runtime session bound to the approval-gated agent,
 *  - send the external conversation and ask for a JSON envelope,
 *  - intercept every native approval, refusing it and handing the action to the
 *    external client when the offered tool schema can express it,
 *  - validate the envelope before it can become an executed action,
 *  - correct a malformed envelope once before giving up.
 *
 * The permission monitor is not optional. The runtime is configured with
 * `permission: ask` because that policy is what keeps OpenCode Zen's free tier
 * open; the monitor is what makes sure nothing is ever actually approved.
 *
 * @module dsh-opencode-bridge/backend
 */

import { request as httpRequest } from 'node:http'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { BridgeError, decode, completion } from './protocol.js'
import { buildHandoff, handoffInput, rejectFeedback } from './handoff.js'
import { createStreamState } from './stream.js'
export { clientModelID } from './model-id.js'

/** Provider id the runtime exposes its free models under. */
const RUNTIME_PROVIDER = 'opencode'

/** Cap on retained approval payloads, which may embed file content. */
const PERMISSION_SAMPLE_LIMIT = 5

/**
 * Wall-clock ceiling for one inference turn (a single `/message` POST).
 *
 * The turn is a long-poll: the runtime answers only when the model finishes, so
 * there is no useful per-request timeout. Without a ceiling a wedged runtime
 * holds the client connection open until the client itself gives up, and the
 * session is never aborted. Set OPENCODE_BRIDGE_MESSAGE_TIMEOUT_MS (milliseconds)
 * to move it; a non-positive or unparsable value falls back to the default.
 */
export const MESSAGE_TIMEOUT_MS = 300_000

/** Read the turn ceiling from the environment, falling back to the default. */
export function messageTimeoutFromEnv(env = process.env) {
  const parsed = Number(env.OPENCODE_BRIDGE_MESSAGE_TIMEOUT_MS)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : MESSAGE_TIMEOUT_MS
}

/**
 * Cap on one upstream response body.
 *
 * Every answer this runtime gives is a small JSON document, so a body past this
 * is already unusable; the cap exists so a broken runtime cannot fill memory
 * with one response.
 */
export const RESPONSE_LIMIT_BYTES = 32 * 1024 * 1024

/**
 * Collapse an upstream body into one short line.
 *
 * The runtime's error page is the one place a large HTML/stack body would
 * travel from the runtime all the way into a client-facing error message.
 */
function summarize(text) {
  return String(text).replace(/\s+/g, ' ').trim().slice(0, 200)
}

/** Bound long strings inside a retained approval payload. */
export function shrinkPermission(value, limit = 400) {
  if (typeof value === 'string') return value.length > limit ? `${value.slice(0, limit)}…[${value.length} chars]` : value
  if (Array.isArray(value)) return value.map(item => shrinkPermission(item, limit))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, shrinkPermission(item, limit)]))
  }
  return value
}

/** Tools a request may use: none when the client asked for none. */
export function allowedTools(request) {
  if (request.choice === 'none') return []
  return request.forced ? request.tools.filter(t => t.function.name === request.forced) : request.tools
}

/**
 * The free models the runtime advertises.
 *
 * "Free" is decided by the runtime's own catalog: a model counts only when
 * every cost dimension is zero. Anything the runtime cannot price at zero is
 * not offered, so this plugin can never quietly spend the user's credits.
 */
export function freeModels(providers) {
  const provider = providers.all?.find(p => p.id === RUNTIME_PROVIDER)
  if (!provider) throw new Error('运行时未提供 opencode provider')
  return Object.entries(provider.models)
    .filter(([, model]) => {
      const cost = model.cost
      return cost && cost.input === 0 && cost.output === 0
        && (cost.cache?.read ?? 0) === 0 && (cost.cache?.write ?? 0) === 0
        && model.capabilities?.output?.text !== false
        && model.status !== 'deprecated'
    })
    .map(([id, model]) => ({
      id: `${RUNTIME_PROVIDER}/${id}`,
      name: model.name || id,
      context: model.limit?.context,
      input: model.limit?.input,
      images: model.capabilities?.input?.image === true,
      output: model.limit?.output,
      toolcall: model.capabilities?.toolcall === true,
      reasoning: model.capabilities?.reasoning === true,
      variants: model.variants ?? {},
    }))
    .sort((a, b) => a.id.localeCompare(b.id))
}

/** Client-facing model id, re-exported so callers need only one import. */
export class Backend {
  constructor(base, password, timeout, log = () => {}) {
    Object.assign(this, {
      base,
      password,
      timeout,
      messageTimeout: messageTimeoutFromEnv(),
      log,
      active: new Map(),
      events: null,
      // Whether the event stream is connected. While it is, the approval map is
      // authoritative and the monitor loop needs no HTTP request.
      eventsLive: false,
      // Cleared on every (re)connect: the first listing after the stream comes
      // back reconciles approvals raised while it was down.
      eventsSynced: false,
      toolParts: new Map(),
      pendingApprovals: new Map(),
      usageBySession: new Map(),
    })
  }

  headers() {
    return {
      'Content-Type': 'application/json',
      Authorization: `Basic ${Buffer.from(`opencode:${this.password}`).toString('base64')}`,
    }
  }

  /** One JSON request against the runtime. */
  async request(route, method = 'GET', body, signal, timeout = this.timeout) {
    // Kept aside so an expired deadline reports itself as a TimeoutError: the
    // signal machinery rewrites it into a bare AbortError otherwise, and the
    // caller can no longer tell a deadline from a client-side cancellation.
    const deadline = timeout == null ? undefined : AbortSignal.timeout(timeout)
    const requestSignal = deadline === undefined
      ? signal
      : AbortSignal.any([deadline, ...(signal ? [signal] : [])])
    return new Promise((resolve, reject) => {
      const req = httpRequest(this.base + route, {
        method, signal: requestSignal, headers: this.headers(),
      }, response => {
        const chunks = []
        let bytes = 0
        let over = false
        response.on('data', chunk => {
          if (over) return
          bytes += chunk.length
          if (bytes > RESPONSE_LIMIT_BYTES) {
            // This runtime only ever answers with a small JSON document. A body
            // past the cap is not something a caller can use, so reading stops
            // instead of letting one response grow until the process dies.
            over = true
            response.destroy()
            return reject(new BridgeError(`OpenCode 响应超过 ${RESPONSE_LIMIT_BYTES / 1048576} MB`, 502, 'upstream_error'))
          }
          chunks.push(chunk)
        })
        response.on('error', error => { if (!over) reject(error) })
        response.on('end', () => {
          if (over) return
          const text = Buffer.concat(chunks).toString()
          if (response.statusCode < 200 || response.statusCode >= 300) {
            return reject(new BridgeError(
              `OpenCode HTTP ${response.statusCode}: ${summarize(text)}`,
              response.statusCode >= 500 ? 502 : response.statusCode,
              'upstream_error',
            ))
          }
          try { resolve(JSON.parse(text)) }
          catch { reject(new BridgeError('OpenCode 返回了非 JSON 响应', 502, 'upstream_error')) }
        })
      })
      req.on('error', error => reject(deadline?.aborted ? deadline.reason : error))
      req.setTimeout(0)
      req.end(body !== undefined ? JSON.stringify(body) : undefined)
    })
  }

  /**
   * Say why a turn was cut off.
   *
   * `request()` gives the turn a ceiling, so an expired one arrives here as a
   * bare `TimeoutError`; the caller (and the user) deserves the reason and the
   * name of the knob. A client-side abort keeps its own AbortError.
   */
  messageFailure(error) {
    if (error?.name !== 'TimeoutError') return error
    const limit = this.messageTimeout >= 1000
      ? `${Math.round(this.messageTimeout / 1000)} 秒`
      : `${this.messageTimeout} 毫秒`
    return new BridgeError(
      `模型 ${limit}内没有返回，已中断；可用 OPENCODE_BRIDGE_MESSAGE_TIMEOUT_MS 调大上限`,
      504,
      'message_timeout',
    )
  }

  /**
   * Subscribe to the runtime's event stream.
   *
   * One connection serves every in-flight request. It carries two things the
   * request/response path does not: the tool part behind a blocked approval, and
   * the runtime's own upstream retry state.
   */
  watchEvents() {
    if (this.events) return
    const controller = new AbortController()
    this.events = controller
    ;(async () => {
      while (!controller.signal.aborted) {
        try { await this.streamEvents(controller.signal) }
        catch (error) {
          if (controller.signal.aborted) return
          this.log(`Event stream error: ${error.message}`)
        } finally {
          // The approval map stops being authoritative the moment the stream
          // drops, so the next connection reconciles with the HTTP listing.
          this.eventsLive = false
          this.eventsSynced = false
        }
        await delay(1000, undefined, { signal: controller.signal, ref: false }).catch(() => {})
      }
    })().catch(() => {})
  }

  stopEvents() {
    this.events?.abort()
    this.events = null
    this.eventsLive = false
    this.eventsSynced = false
  }

  streamEvents(signal) {
    return new Promise((resolve, reject) => {
      const req = httpRequest(this.base + '/event', {
        method: 'GET', signal, headers: { ...this.headers(), Accept: 'text/event-stream' },
      }, response => {
        if (response.statusCode !== 200) {
          response.resume()
          return reject(new BridgeError(`事件流 HTTP ${response.statusCode}`, 502, 'event_stream_error'))
        }
        this.eventsLive = true
        let buffer = ''
        response.on('data', chunk => {
          buffer += chunk.toString()
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''
          for (const line of lines) {
            if (!line.startsWith('data:')) continue
            try { this.handleEvent(JSON.parse(line.slice(5).trim())) } catch { /* ignore malformed frame */ }
          }
        })
        response.on('error', reject)
        response.on('end', resolve)
      })
      req.on('error', reject)
      req.end()
    })
  }

  handleEvent(wrapper) {
    const event = wrapper?.payload ?? wrapper
    if (['permission.asked', 'permission.updated'].includes(event?.type) && event.properties?.id) {
      this.pendingApprovals.set(event.properties.id, event.properties)
    }
    if (event?.type === 'permission.replied') this.pendingApprovals.delete(event.properties?.requestID)

    // The tool part carries the name and arguments of a call an approval gate
    // blocked. It arrives here before the approval, and the HTTP listing of
    // messages does not include it.
    const part = event?.type === 'message.part.updated' ? event.properties?.part : undefined
    if (part?.type === 'tool' && part.callID) {
      this.toolParts.set(part.callID, { tool: part.tool, input: part.state?.input ?? {} })
      if (this.toolParts.size > 50) this.toolParts.delete(this.toolParts.keys().next().value)
    }

    const info = event?.type === 'message.updated' ? event.properties?.info : undefined
    if (info?.role === 'assistant' && info.tokens && this.usageBySession.has(info.sessionID)) {
      this.usageBySession.set(info.sessionID, info.tokens)
    }

    const sessionID = event?.properties?.sessionID
    const meta = sessionID ? this.active.get(sessionID) : undefined
    if (!meta || typeof meta.activity !== 'function') return
    const progress = { sessionID, model: meta.model, type: event.type, at: Date.now() }
    const status = event.properties?.status
    if (event.type === 'session.status' && status) {
      if (status.type === 'retry' || (status.type === 'busy' && (!meta.stage || meta.stage === 'retry'))) {
        progress.status = status.type === 'busy' ? 'waiting' : 'retry'
      }
      if (status.type === 'retry') {
        Object.assign(progress, { attempt: status.attempt, message: status.message, next: status.next })
      }
    }
    if (event.type === 'session.error') {
      progress.error = event.properties?.error?.data?.message || event.properties?.error?.name || '上游错误'
    }
    // Only the answer's parts may feed delivery. The user message carries the
    // prompt this adapter just sent, and its text is the JSON conversation.
    if (info?.id && info.role) meta.stream?.message(info)
    if (part && ['text', 'reasoning'].includes(part.type) && part.text) {
      progress.content = true
      progress.status = part.type === 'reasoning' ? 'reasoning' : 'receiving'
      meta.stream?.part(part)
    }
    if (event.type === 'message.part.delta' && event.properties?.delta) {
      progress.content = true
      progress.status = 'receiving'
      meta.stream?.delta(event.properties)
    }
    if (meta.stream && (part || event.type === 'message.part.delta')) {
      // Only the part events carry answer text; taking anywhere else would emit
      // a delta out of step with the status it belongs to.
      const fresh = meta.stream.take()
      if (fresh) {
        progress.delta = fresh
        progress.status = 'receiving'
      }
    }
    if (['permission.asked', 'permission.updated'].includes(event.type)) progress.status = 'permission'
    if (progress.status) meta.stage = progress.status
    meta.activity(progress)
  }

  progress(meta, status, extra = {}) {
    meta.stage = status
    meta.activity?.({ sessionID: meta.sessionID, model: meta.model, type: 'bridge.phase', status, ...extra })
  }

  async reject(permission, message, signal) {
    const result = await this.request(
      `/permission/${encodeURIComponent(permission.id)}/reply`,
      'POST', { reply: 'reject', message }, signal, 5000,
    )
    this.pendingApprovals.delete(permission.id)
    return result
  }

  /**
   * Read back the native action behind a blocked call.
   *
   * The name arrives on the event stream; the arguments may still be empty while
   * the part is pending, so a few short waits are worth it before giving up.
   */
  async blockedAction(callID, signal) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const part = this.toolParts.get(callID)
      if (part?.tool) return part
      await delay(120, undefined, { signal, ref: false }).catch(() => {})
    }
    return { failure: '没有事件携带这个 call ID' }
  }

  /**
   * Approvals still waiting in one session.
   *
   * The event stream is authoritative while it is connected: `permission.asked`
   * fills the map and `permission.replied` empties it, so the 250 ms monitor loop
   * costs no HTTP request at all. The runtime's listing is read for as long as the
   * stream is down, and once after each reconnect, because an approval raised
   * while the stream was down never reached the map.
   */
  async pendingPermissions(sessionID, signal) {
    const cached = () => [...this.pendingApprovals.values()].filter(p => p.sessionID === sessionID)
    if (this.eventsLive && this.eventsSynced) return cached()
    let pending
    try {
      pending = await this.request('/permission', 'GET', undefined, signal, 5000)
    } catch (error) {
      if (!signal?.aborted) this.log(`Permission monitor query failed: ${error.code || error.name}: ${error.message}`)
      return cached()
    }
    if (!Array.isArray(pending)) {
      this.log('Permission monitor query failed: non-array response')
      return cached()
    }
    if (this.eventsLive) this.eventsSynced = true
    return pending.filter(p => p.sessionID === sessionID)
  }

  async handoffUsage(sessionID, signal) {
    try {
      const messages = await this.request(
        `/session/${encodeURIComponent(sessionID)}/message?limit=1`, 'GET', undefined, signal, 5000,
      )
      const info = Array.isArray(messages) ? messages.findLast(m => m.info?.role === 'assistant')?.info : undefined
      if (info?.tokens) return info.tokens
    } catch (error) {
      if (!signal?.aborted) this.log(`Usage lookup failed: ${error.code || error.name}`)
    }
    return this.usageBySession.get(sessionID)
  }

  /**
   * Refuse one native approval, or hand the action to the external client.
   *
   * @returns {{handoff: {name: string, arguments: object}}|null}
   */
  async handlePermission(permission, request, signal, rejected, meta) {
    const callID = permission.tool?.callID
    if (callID && rejected.has(callID)) return null
    if (callID) rejected.add(callID)
    meta.nativeAttempts += 1
    // Keep the approval request verbatim: OpenCode's field names differ from the
    // SDK types, so cherry-picking fields silently loses the useful ones.
    if (meta.permissions.length < PERMISSION_SAMPLE_LIMIT) meta.permissions.push(shrinkPermission(permission))

    const action = callID ? await this.blockedAction(callID, signal) : null
    const native = action?.tool ?? (permission.metadata?.command ? 'bash' : null)
    const handoff = native
      ? buildHandoff({ native, input: handoffInput(action, permission), tools: allowedTools(request) })
      : null

    if (handoff) {
      this.progress(meta, 'handoff')
      await this.reject(permission, 'This native action is executed by the external client instead.', signal).catch(() => {})
      return { handoff }
    }

    const reason = !callID
      ? 'the approval request carries no call ID, so it cannot be matched to the external tool list'
      : action
        ? 'its arguments cannot be mapped onto an external tool schema supplied in this request'
        : 'the call could not be read back from the session'
    const label = native || (permission.metadata?.filepath ? `a file operation on ${permission.metadata.filepath}` : permission.permission || 'native tool')
    // A permission may already be gone (session aborted, duplicate reply):
    // never let that failing reply take the whole request down with it.
    await this.reject(permission, rejectFeedback(label, reason), signal).catch(() => {})
    return null
  }

  /** Read the runtime's free-model catalog. */
  async models() {
    const result = freeModels(await this.request('/provider'))
    if (result.length === 0) throw new Error('未找到免费模型，保留现有列表')
    return result
  }

  /**
   * Run one inference turn.
   *
   * @returns {Promise<object>} an OpenAI chat.completion
   */
  async complete(request, signal, meta = {}) {
    meta.steps = 0
    meta.nativeAttempts = 0
    meta.permissions = []
    // Only a streaming request gets an activity callback from the shim, and that
    // callback is the only channel back to the client. Without one there is
    // nothing to stream to, so no state is tracked.
    if (typeof meta.activity === 'function') {
      meta.stream = createStreamState({ envelope: !request.chatOnly })
    }

    const session = await this.request('/session', 'POST', {
      title: 'DSH OpenCode Bridge',
      permission: Object.entries({
        '*': 'ask', question: 'deny', websearch: 'deny', codesearch: 'deny',
        webfetch: 'deny', task: 'deny', plan_enter: 'deny', plan_exit: 'deny', todowrite: 'deny',
      }).map(([permission, action]) => ({ permission, pattern: '*', action })),
    }, signal)

    const route = `/session/${encodeURIComponent(session.id)}`
    meta.sessionID = session.id
    this.usageBySession.set(session.id, undefined)
    if (typeof meta.activity === 'function') this.active.set(session.id, meta)
    this.watchEvents()
    this.progress(meta, 'waiting')

    const guard = new AbortController()
    const rejected = new Set()
    const guardSignal = AbortSignal.any([guard.signal, ...(signal ? [signal] : [])])

    const watch = (async () => {
      while (!guardSignal.aborted) {
        const pending = await this.pendingPermissions(session.id, guardSignal)
        // A failed poll never grants approval: native actions stay waiting.
        for (const permission of pending ?? []) {
          if (request.chatOnly) {
            throw new BridgeError('仅对话模型尝试调用本地工具，已阻止执行', 502, 'native_tool_activity')
          }
          const result = await this.handlePermission(permission, request, guardSignal, rejected, meta)
          if (result?.handoff) return result
        }
        await delay(250, undefined, { signal: guardSignal })
      }
    })()

    let successful = false
    try {
      const tools = allowedTools(request)
      const callsSchema = {
        type: 'array',
        ...(request.parallel ? {} : { maxItems: 1 }),
        ...(request.choice === 'required' || request.forced ? { minItems: 1 } : {}),
        ...(tools.length
          ? {
            items: {
              anyOf: tools.map(({ function: tool }) => ({
                type: 'object',
                properties: {
                  name: { type: 'string', const: tool.name },
                  arguments: tool.parameters || { type: 'object' },
                },
                required: ['name', 'arguments'],
                additionalProperties: false,
              })),
            },
          }
          : { maxItems: 0, items: { type: 'object' } }),
      }

      const payload = {
        model: { providerID: RUNTIME_PROVIDER, modelID: request.model.id.slice(`${RUNTIME_PROVIDER}/`.length) },
        ...(request.variant ? { variant: request.variant } : {}),
        agent: request.chatOnly ? 'buddy-chat' : 'buddy-bridge',
        system: request.chatOnly
          ? request.system
          : `${request.system}\nUse StructuredOutput to return this envelope. All other native tools are forbidden; do not perform the external actions yourself.`,
        ...(request.chatOnly
          ? {}
          : {
            format: {
              type: 'json_schema',
              retryCount: 0,
              schema: {
                type: 'object',
                properties: { content: { type: 'string' }, calls: callsSchema },
                required: ['content', 'calls'],
                additionalProperties: false,
              },
            },
          }),
        parts: [{ type: 'text', text: request.text }, ...(request.images ?? [])],
      }

      // The runtime turns `format` into a forced tool_choice, and some thinking
      // models refuse that upstream: 400 "[invalid_request_error] Thinking mode
      // does not support this tool_choice". No capability flag predicts which
      // ones (every free model advertises reasoning, yet only some refuse), so
      // this reacts to the actual refusal: drop the format once, ask for the
      // envelope in plain text, retry the same turn. decode() accepts plain
      // text and the correction retry below still repairs a malformed answer —
      // a relax must not eat that single correction.
      let relaxed = request.chatOnly
      let corrected = false
      const relaxFormat = error => {
        if (relaxed || payload.format === undefined) return false
        if (!/Thinking mode does not support this tool_choice/i.test(error?.message ?? '')) return false
        relaxed = true
        delete payload.format
        payload.system = `${request.system}\nReturn that envelope as plain text: exactly one JSON object with "content" and "calls", no Markdown fences. All native tools are forbidden; do not perform the external actions yourself.`
        return true
      }

      for (let stride = 0; stride < 4; stride++) {
        meta.steps += 1
        // A correction attempt produces a whole new answer; the client keeps
        // what it was already given, so only that floor carries forward.
        meta.stream?.reset()
        this.progress(meta, corrected ? 'correcting' : 'waiting')
        this.usageBySession.set(session.id, undefined)

        let response
        try {
          response = await Promise.race([
            watch,
            this.request(`${route}/message`, 'POST', payload, signal, this.messageTimeout)
              .catch(error => { throw this.messageFailure(error) }),
          ])
        } catch (error) {
          if (!relaxFormat(error)) throw error
          continue
        }
        this.progress(meta, 'checking')

        let handoff = response?.handoff ?? null
        if (!handoff) {
          // Close the race: an approval raised just before the response landed
          // must still be refused or handed over.
          const late = await this.pendingPermissions(session.id, guardSignal)
          for (const permission of late ?? []) {
            if (request.chatOnly && permission.tool) {
              throw new BridgeError('仅对话模型尝试调用本地工具，已阻止执行', 502, 'native_tool_activity')
            }
            const result = await this.handlePermission(permission, request, guardSignal, rejected, meta)
            if (result?.handoff) { handoff = result.handoff; break }
          }
        }

        // A handed-over action becomes the model's answer; no extra upstream turn.
        if (handoff) {
          await this.request(`${route}/abort`, 'POST', undefined, undefined, 5000).catch(() => {})
          meta.calls = 1
          meta.handoff = handoff.name
          successful = true
          return completion(request.model.id, {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: `call_${randomUUID().replaceAll('-', '')}`,
              type: 'function',
              function: { name: handoff.name, arguments: JSON.stringify(handoff.arguments) },
            }],
          }, await this.handoffUsage(session.id, signal))
        }

        if (response.info?.error && (request.chatOnly || response.info.error.name !== 'StructuredOutputError')) {
          const error = response.info.error
          const failure = new BridgeError(
            error.data?.message || error.message || error.name || '模型请求失败',
            error.data?.statusCode || 502,
            'model_error',
          )
          if (relaxFormat(failure)) continue
          throw failure
        }

        // 'invalid' marks a call whose arguments failed to parse: nothing ran, so
        // it belongs to the format path, not to native activity.
        if (response.parts?.some(p => p.type === 'tool'
          && (request.chatOnly || !['StructuredOutput', 'invalid'].includes(p.tool))
          && !(rejected.has(p.callID) && p.state?.status === 'error'))) {
          throw new BridgeError('检测到意外的本地工具活动，已拒绝该响应', 502, 'native_tool_activity')
        }

        // The envelope arrives one of three ways: the runtime's structured field,
        // a completed StructuredOutput call, or plain text.
        const structuredPart = (response.parts || []).find(
          p => p.type === 'tool' && p.tool === 'StructuredOutput' && p.state?.status === 'completed' && p.state?.input,
        )
        const envelope = response.info?.structured ?? structuredPart?.state?.input
        const text = envelope !== undefined
          ? JSON.stringify(envelope)
          : (response.parts || []).filter(p => p.type === 'text').map(p => p.text).join('')

        let message
        try {
          if (response.info?.finish === 'length') {
            throw new BridgeError('模型输出被截断', 502, 'output_truncated')
          }
          if (!text.trim()) {
            const unparsed = (response.parts || []).find(p => p.type === 'tool' && p.tool === 'invalid')
            if (request.chatOnly) throw new BridgeError('模型没有返回文本', 502, 'empty_response')
            throw new BridgeError(
              unparsed
                ? `模型提交的调用参数不是合法 JSON：${unparsed.state?.input?.error ?? '运行时未给出细节'}`
                : '模型没有返回信封：structured、已完成的 StructuredOutput 调用、文本三者都为空',
              502, 'invalid_model_output',
            )
          }
          message = request.chatOnly ? { role: 'assistant', content: text } : decode(text, request)
        } catch (error) {
          // One bounded correction, only ever on a path that already failed.
          if (request.chatOnly || signal?.aborted
            || !['invalid_model_output', 'invalid_tool_call', 'output_truncated'].includes(error.code)) {
            throw error
          }
          if (!corrected) {
            corrected = true
            const cut = error.code === 'output_truncated'
            payload.parts = [{
              type: 'text',
              text: cut
                ? 'Your previous response was cut off by the output limit before the envelope was complete. Send it again in a much more compact form: content holds the conclusion, calls hold only the essential arguments, and keep reasoning to a minimum.'
                : `Your previous response failed the adapter JSON format check. No external tool has been executed from that response. Return the intended answer or external tool proposal using ${relaxed ? 'plain text' : 'StructuredOutput'} with exactly {"content":"a string, empty if only calling tools","calls":[{"name":"an allowed external tool name","arguments":{}}]}. Both fields are required; use [] when no tools are needed. Do not invoke native tools, repeat external searches, or claim actions have completed. Preserve the external conversation and its existing tool results.`,
            }]
            continue
          }
          throw error
        }

        meta.calls = message.tool_calls?.length ?? 0
        successful = true
        return completion(request.model.id, message, response.info?.tokens)
      }
    } finally {
      guard.abort()
      await watch.catch(() => {})
      this.usageBySession.delete(session.id)
      if (this.usageBySession.size === 0) this.stopEvents()
      for (const [id, permission] of this.pendingApprovals) {
        if (permission.sessionID === session.id) this.pendingApprovals.delete(id)
      }
      if (typeof meta.activity === 'function') {
        meta.activity({ sessionID: session.id, model: meta.model, type: 'request.done' })
        this.active.delete(session.id)
      }
      // Cancellation must stop backend work, not merely disconnect the HTTP request.
      if (!successful) {
        await this.request(`${route}/abort`, 'POST', undefined, undefined, 5000).catch(() => {})
      }
      await this.request(route, 'DELETE', undefined, undefined, 5000)
        .catch(error => this.log(`Session cleanup failed: ${error.code || error.name}`))
    }
  }
}
