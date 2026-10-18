/**
 * Incremental delivery of the runtime's answer.
 *
 * The runtime reports an answer as message parts that grow; an OpenAI client
 * wants appended deltas. Two shapes reach this module:
 *
 *  - A chat-only model answers in plain text, so every new character is already
 *    part of the answer.
 *  - A tool-bearing model answers with the adapter's JSON envelope
 *    (`{"content":"...","calls":[...]}`), where only the `content` string is
 *    user-visible. Emitting the envelope would put JSON syntax in front of the
 *    user, so the string is decoded as far as its escapes allow.
 *
 * Delivery must stay strictly monotonic: the client appends whatever it is
 * given and cannot retract it, so this module never hands out a prefix twice.
 * What it withholds (an escape split across two deltas, a rewrite after a
 * retry) is reconciled against the final answer instead of being guessed at.
 *
 * @module dsh-opencode-bridge/stream
 */

/** JSON escapes that stand for exactly one character. */
const SIMPLE_ESCAPES = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' }

/**
 * Index just past the opening quote of the envelope's `content` value, or -1.
 *
 * The envelope's own key comes first, possibly behind a Markdown fence. A later
 * `"content"` could belong to a nested tool argument instead, so the anchored
 * form wins when it is present.
 */
function openContentValue(raw) {
  const head = raw.indexOf('{')
  if (head >= 0) {
    const match = /^\{\s*"content"\s*:\s*"/.exec(raw.slice(head))
    if (match) return head + match[0].length
  }
  const match = /"content"\s*:\s*"/.exec(raw)
  return match ? match.index + match[0].length : -1
}

/**
 * Decode the user-visible part of a JSON envelope, tolerating a partial value.
 *
 * Returns however much could be decoded so far. A trailing escape that is not
 * yet complete stops decoding rather than guessing: a wrong guess would be
 * delivered as part of the answer and could never be taken back.
 */
export function envelopeContent(raw) {
  const start = openContentValue(raw)
  if (start < 0) return ''
  let index = start
  let out = ''
  while (index < raw.length) {
    const char = raw[index]
    if (char === '"') break
    if (char !== '\\') { out += char; index += 1; continue }
    const escape = raw[index + 1]
    if (escape === undefined) break
    if (escape === 'u') {
      const hex = raw.slice(index + 2, index + 6)
      if (hex.length < 4 || !/^[0-9a-fA-F]{4}$/.test(hex)) break
      out += String.fromCharCode(parseInt(hex, 16))
      index += 6
      continue
    }
    if (!(escape in SIMPLE_ESCAPES)) break
    out += SIMPLE_ESCAPES[escape]
    index += 2
  }
  return out
}

/**
 * Track one request's parts and hand out newly visible text.
 *
 * A part's text is kept as a cumulative report plus the deltas seen since that
 * report. Both can describe the same characters — the runtime may report a
 * part whole and also emit the increment that produced it — so a report
 * replaces the deltas instead of adding to them. Trying to detect the overlap
 * by comparing suffixes instead would drop legitimate repetition: the two
 * backslashes of a JSON `\\` escape are identical characters.
 *
 * @param {{envelope?: boolean}} options `envelope: true` for a tool-bearing
 *   model, whose visible text is the envelope's `content` field.
 */
export function createStreamState({ envelope = false } = {}) {
  let parts = new Map()
  let order = []
  /** Everything handed to the client so far; the floor for the next delta. */
  let emitted = ''
  let cachedRaw = null
  let cachedVisible = ''

  const raw = () => order
    .map(id => parts.get(id))
    .filter(part => part && part.type === 'text')
    .map(part => part.report + part.appended)
    .join('')

  const visible = () => {
    const text = raw()
    if (text !== cachedRaw) {
      cachedRaw = text
      cachedVisible = envelope ? envelopeContent(text) : text
    }
    return cachedVisible
  }

  const ensurePart = (id, type) => {
    const known = parts.get(id)
    if (known) return known
    const fresh = { type, report: '', appended: '' }
    parts.set(id, fresh)
    order.push(id)
    return fresh
  }

  return {
    /**
     * A part reported its full text so far. The report is authoritative and
     * replaces the deltas that produced it, so no character is counted twice.
     */
    part(part) {
      const known = ensurePart(part.id ?? part.partID ?? 'main', part.type)
      known.type = part.type
      known.report = typeof part.text === 'string' ? part.text : ''
      known.appended = ''
    },

    /** A delta arrived for a part that may not have been reported whole yet. */
    delta(update) {
      const id = update.partID ?? 'main'
      const type = update.field === 'reasoning' ? 'reasoning' : 'text'
      const known = ensurePart(id, type)
      if (type === 'reasoning') known.type = type
      known.appended += typeof update.delta === 'string' ? update.delta : ''
    },

    /**
     * Start over for a fresh attempt.
     *
     * `emitted` deliberately survives: the client keeps what it was already
     * given, so the new attempt is measured against that floor.
     */
    reset() { parts = new Map(); order = []; cachedRaw = null },

    /** Newly visible text since the previous call; empty when there is none. */
    take() {
      const text = visible()
      if (text === emitted) return ''
      if (text.startsWith(emitted)) {
        const fresh = text.slice(emitted.length)
        emitted = text
        return fresh
      }
      // A rewrite (a retry, or a part corrected in place) invalidates the
      // prefix already on screen. Say nothing rather than duplicate it; the
      // final answer is what reconciles the difference.
      emitted = text
      return ''
    },

    visible,
  }
}
