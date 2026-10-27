/**
 * Next-step prediction — Host half.
 *
 * After a turn ends, run ONE auxiliary model call over the session's recent
 * context. The request reuses the route the main conversation logged, so the
 * provider can hit its prefix cache; it appends no surface message, so it never
 * enters the conversation the model sees and never changes the main request's
 * prefix. The suggestion is appended as a log-only plugin record and exposed to
 * the browser through the `nextstep` session projection.
 *
 * The browser half (`./client`) renders the suggestion above the composer and
 * inserts it into the draft on Tab. It never sends the message.
 *
 * Log compatibility: a session log is refused at load time when it contains an
 * event type the installed harness does not know, unless that event carries the
 * envelope's `ignorable: true` marker. `session.append()` cannot set that marker,
 * so writing a custom event type with it makes the whole history unreadable
 * ("contains event type ... unknown to this harness and not marked ignorable").
 * The supported route is a plugin record: a `plugin:`-namespaced type marked
 * `ignorable`, which a reader that does not recognize it retains and skips
 * instead of refusing the log. `appendPluginRecord()` is the only writer that
 * sets that marker, so it is the only append used here.
 */

import { z } from 'zod'
import { appendPluginRecord } from '@deepseek-ai/dsh-session'

/** Plugin-record type: `plugin:` + lowercase slash-separated segments. */
const RECORD_TYPE = 'plugin:nextstep/suggestion'

/**
 * Legacy type written by earlier builds of this plugin. It was appended through
 * `session.append()` without the `ignorable` marker, so a log containing it is
 * refused by the read path. Kept only so the projection still folds a record that
 * a repaired log carries under this name.
 */
const LEGACY_EVENT_TYPE = 'nextstep/suggestion'

const PROJECTION_KEY = 'nextstep'

/** Per-call token usage carried by one suggestion event. */
const usageSchema = z.object({
  inputTokens: z.number().nonnegative(),
  outputTokens: z.number().nonnegative(),
  totalTokens: z.number().nonnegative().optional(),
  cacheReadTokens: z.number().nonnegative().optional(),
  cacheWriteTokens: z.number().nonnegative().optional(),
  reasoningTokens: z.number().nonnegative().optional(),
}).strict()

/** System instruction for the auxiliary prediction request. */
const PREDICTION_SYSTEM = [
  '[NEXT-STEP PREDICTION]',
  'You predict the single sentence the user is most likely to type next,',
  'in the conversation language. Predict the user, not the assistant.',
  '',
  'Rules:',
  '- 2–12 words; shorter is better.',
  '- Output only the sentence: no quotes, no prefix, no Markdown, no explanation.',
  '- Never ask a question, never evaluate, never introduce a new topic.',
  '- If the next step is not obvious or could be unsafe, output nothing.',
].join('\n')

/** User instruction appended after the derived conversation prefix. */
const PREDICTION_INSTRUCTION = 'Predict the user\'s next message. Output only that message.'

export const name = 'nextstep'

/**
 * `llm` runs the auxiliary request; `sessionProjections` exposes the suggestion
 * to the browser. The plugin is dormant when either service is missing.
 */
export const inject = ['llm', 'sessionProjections']

/**
 * Normalize the plugin config row, applying documented defaults.
 * @param raw - config supplied by the bundle patch row.
 * @returns complete config; unknown fields are ignored.
 */
function normalizeConfig(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const finite = (value, fallback, min, max) => typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback
  const text = value => typeof value === 'string' ? value.trim() : ''
  return {
    enabled: source.enabled !== false,
    provider: text(source.provider),
    model: text(source.model),
    contextMessages: Math.floor(finite(source.contextMessages, 12, 1, 50)),
    maxContextChars: Math.floor(finite(source.maxContextChars, 24000, 1000, 200000)),
    maxTokens: Math.floor(finite(source.maxTokens, 512, 32, 4096)),
    temperature: finite(source.temperature, 0, 0, 2),
    timeoutMs: Math.floor(finite(source.timeoutMs, 60000, 2000, 180000)),
    sampleRate: finite(source.sampleRate, 1, 0, 1),
    minTurn: Math.floor(finite(source.minTurn, 1, 0, 1000)),
  }
}

/** Emit a diagnostic without letting a logger failure affect prediction. */
function warn(message) {
  try {
    console.warn(`[nextstep] ${message}`)
  } catch {
    // Logging is best-effort; prediction must not fail because of it.
  }
}

/**
 * Keep the system prompt and the most recent messages under one char budget.
 * @param messages - derived model history.
 * @param config - message and character bounds.
 * @returns request messages, oldest dropped first, leading tool results removed.
 */
function textOnly(messages) {
  const kept = []
  for (const message of messages) {
    if (message.role === 'tool') continue
    const content = (message.content ?? []).filter(block => block.type === 'text')
    if (content.length === 0) continue
    kept.push({ ...message, content })
  }
  return kept
}

function selectMessages(messages, config) {
  const system = messages.filter(message => message.role === 'system')
  const rest = messages.filter(message => message.role !== 'system').slice(-config.contextMessages)
  while (rest.length > 0 && rest[0].role === 'tool') rest.shift()
  const kept = []
  let chars = 0
  for (let index = rest.length - 1; index >= 0; index -= 1) {
    const size = JSON.stringify(rest[index].content ?? '').length
    if (chars + size > config.maxContextChars) break
    chars += size
    kept.unshift(rest[index])
  }
  return [...system, ...kept]
}

/**
 * Normalize the model reply into one draft sentence, or null to clear the bar.
 * @param raw - assembled model text.
 * @returns the suggestion, or null when the reply is empty or unusable.
 */
function sanitize(raw) {
  let text = String(raw ?? '').trim()
  if (text === '') return null
  text = text.split('\n').map(line => line.trim()).filter(line => line !== '')[0] ?? ''
  text = text.replace(/^(?:suggestion|建议|下一句)\s*[:：]\s*/iu, '')
  text = text.replace(/^["'“”‘’「」『』]+|["'“”‘’「」『』]+$/gu, '').trim()
  if (text === '' || text.length > 200) return null
  return text
}

/**
 * Install the suggestion projection and the turn-end trigger.
 * @param ctx - plugin context.
 * @param rawConfig - config row from the bundle patch.
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  if (!config.enabled) return

  /** sessionId -> AbortController of the in-flight prediction. */
  const pending = new Map()

  const abort = sessionId => {
    const controller = pending.get(sessionId)
    if (controller === undefined) return
    pending.delete(sessionId)
    controller.abort()
  }

  /**
   * Append the suggestion as an ignorable plugin record.
   *
   * A log carrying an unknown event type without `ignorable` is refused at load
   * time, which makes the whole session history unreadable. Only a plugin record
   * is both outside `SessionEventMap` and marked ignorable, so a reader that does
   * not know this plugin retains and skips it. `appendPluginRecord()` is the only
   * writer that sets that marker; `session.append()` cannot, so it is never used
   * for this record.
   * @param session - the session whose log receives the record.
   * @param data - suggestion payload.
   * @returns nothing; a failed append must not disturb the conversation.
   */
  const appendSuggestion = (session, data) => {
    try {
      appendPluginRecord(session, RECORD_TYPE, data)
    } catch (error) {
      warn(`suggestion record append failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  ctx.effect(() => ctx.sessionProjections.register({
    key: PROJECTION_KEY,
    stateSchema: z.object({
      text: z.string().nullable(),
      turn: z.number().int().nonnegative(),
      status: z.enum(['idle', 'pending', 'done', 'failed']),
      model: z.string().nullable(),
      usage: usageSchema.nullable(),
      updatedAt: z.number(),
    }).strict(),
    init: () => ({ text: null, turn: 0, status: 'idle', model: null, usage: null, updatedAt: 0 }),
    apply: (state, event) => {
      if (event.type !== RECORD_TYPE && event.type !== LEGACY_EVENT_TYPE) return state
      const data = event.data
      return {
        text: data.text,
        turn: data.turn,
        status: data.status,
        model: data.model ?? null,
        usage: data.usage ?? null,
        updatedAt: data.at,
      }
    },
    stateVersion: 1,
    wire: {
      viewSchema: z.object({
        text: z.string().nullable(),
        turn: z.number().int().nonnegative(),
        status: z.enum(['idle', 'pending', 'done', 'failed']),
        model: z.string().nullable(),
        usage: usageSchema.nullable(),
        updatedAt: z.number(),
      }).strict(),
      view: state => ({
        text: state.text,
        turn: state.turn,
        status: state.status,
        model: state.model,
        usage: state.usage,
        updatedAt: state.updatedAt,
      }),
    },
  }), 'nextstep: suggestion projection')

  ctx.effect(() => {
    const dispose = ctx.on('session/event', (session, event) => {
      if (event.type === 'turn/start') {
        abort(session.id)
        return
      }
      if (event.type !== 'turn/end') return
      if (event.data.turn < config.minTurn) return
      void predict(ctx, session, event.data.turn, config, pending, abort, appendSuggestion)
    })
    return () => {
      dispose()
      for (const controller of pending.values()) controller.abort()
      pending.clear()
    }
  }, 'nextstep: turn events')
}

/**
 * Run one auxiliary prediction request and append its log-only suggestion event.
 * @param ctx - plugin context.
 * @param session - session whose turn just ended.
 * @param turn - finished turn number.
 * @param config - normalized plugin config.
 * @param pending - in-flight controllers by session id.
 * @param abort - abort one session's in-flight prediction.
 * @param appendSuggestion - append the result as an ignorable plugin record.
 */
async function predict(ctx, session, turn, config, pending, abort, appendSuggestion) {
  abort(session.id)
  if (config.sampleRate < 1 && Math.random() >= config.sampleRate) return

  const controller = new AbortController()
  pending.set(session.id, controller)
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(config.timeoutMs)])
  const finish = () => {
    if (pending.get(session.id) === controller) pending.delete(session.id)
  }

  try {
    const header = session.requestHeader()
    const route = config.provider !== '' && config.model !== ''
      ? { provider: config.provider, model: config.model, reasoningEffort: undefined }
      : header?.config
    if (route === undefined) return

    const messages = selectMessages(textOnly(session.deriveMessages()), config)
    if (messages.length === 0) return

    const request = [
      ...messages,
      { role: 'user', content: [{ type: 'text', text: PREDICTION_INSTRUCTION }] },
    ]
    const callConfig = {
      provider: route.provider,
      model: route.model,
      ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
      temperature: config.temperature,
      maxTokens: config.maxTokens,
    }
    const call = await ctx.llm.prepareCall(callConfig, signal)

    let text = ''
    let usage
    let failed = false
    for await (const chunk of call.stream({
      ...call.config,
      messages: request,
      signal,
      sessionId: session.id,
    })) {
      if (chunk.type === 'text-delta') text += chunk.text
      else if (chunk.type === 'usage') usage = chunk.usage
      else if (chunk.type === 'finish' && (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted')) {
        failed = true
        warn(`prediction finish ${chunk.reason.kind}: ${JSON.stringify(chunk.reason.failure)}`)
        break
      }
    }
    if (signal.aborted) return

    appendSuggestion(session, {
      text: failed ? null : sanitize(text),
      turn,
      status: failed ? 'failed' : 'done',
      model: `${route.provider}/${route.model}`,
      ...(usage === undefined ? {} : { usage }),
      at: Date.now(),
    })
  } catch (error) {
    if (signal.aborted) return
    warn(`prediction failed for turn ${turn}: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    finish()
  }
}
