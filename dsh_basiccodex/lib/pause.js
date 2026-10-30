/**
 * Session pause — Host half.
 *
 * `/pause` stops the active turn of the calling session, flushes its durable log,
 * and writes a small recovery marker under `$DSH_HOME/session-pause/`.
 *
 * `/continue` (or the automatic resume path) sends a developer message that asks
 * the model to continue the unfinished work. The marker is consumed once.
 *
 * Design notes
 * - We do NOT patch `dsh-agent-loop`: the stop path still records the ordinary
 *   `turn/end{aborted}` event. The recovery value is the marker plus the
 *   continuation prompt, which is enough to reproduce Codex's user-visible
 *   "pause now, continue later" behavior without touching core.
 * - The marker is written before `agent.cancel()` so a crash between the two steps
 *   still leaves a resumable session.
 * - Auto-continue runs on `agent/created`, i.e. when the GUI reopens a persisted
 *   session and materializes its agent. A short delay lets a user message that
 *   triggered the open win the race; if a user message was appended we skip and
 *   remove the marker instead of injecting a continuation turn.
 *
 * @module dsh-plugin-session-pause
 */

import { mkdir, readFile, readdir, rm } from 'node:fs/promises'
import path from 'node:path'

import { CommandDefinitionId } from '@deepseek-ai/dsh-commands/brand'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { z } from 'zod'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { appendResume, appendSuspend, installCoreEvents } from './core-events.js'

installCoreEvents()

export const name = 'session-pause'

/** Services required before commands and lifecycle listeners can be installed. */
export const inject = ['commands', 'agents', 'sessions', 'sessionProjections']

const MARKER_VERSION = 1
const PAUSE_PROJECTION = 'sessionPause'
const CONTINUE_TEXT = [
  'The Harness paused this session and it was reopened.',
  'Continue the unfinished work from the saved conversation.',
  'Check the current state before repeating actions that may already have completed.',
  'Do not repeat tool calls whose effects are already visible; finish the original request.',
].join(' ')

/**
 * Normalize the bundle patch config row.
 * @param raw - config supplied by the bundle patch.
 * @returns complete config with documented defaults.
 */
function normalizeConfig(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const bool = (value, fallback) => typeof value === 'boolean' ? value : fallback
  const number = (value, fallback, min, max) => typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback
  const text = typeof source.storeSubdir === 'string' ? source.storeSubdir.trim() : ''
  const safeSubdir = text === '' ? 'session-pause' : text.replace(/[^a-zA-Z0-9._-]/gu, '_')
  return {
    autoContinueOnResume: bool(source.autoContinueOnResume, false),
    autoResumeOnStartup: bool(source.autoResumeOnStartup, false),
    continuationDelayMs: Math.floor(number(source.continuationDelayMs, 1500, 0, 60_000)),
    storeSubdir: safeSubdir,
  }
}

/** Log a diagnostic without letting logging failure break pause/continue. */
function warn(ctx, message) {
  try {
    ctx.logger?.warn?.(`[session-pause] ${message}`)
  } catch {
    // Logging is best-effort.
  }
}

/** Encode a session id into one safe file-name segment. */
function markerName(sessionId) {
  return String(sessionId).replace(/[^a-zA-Z0-9._-]/gu, '_') + '.json'
}

/** Resolve one session's marker path. */
function markerPath(config, sessionId) {
  return dshHomePath(config.storeSubdir, markerName(sessionId))
}

/** Read a marker; `undefined` when absent or unreadable. */
async function readMarker(config, sessionId) {
  try {
    const raw = await readFile(markerPath(config, sessionId), 'utf8')
    const marker = JSON.parse(raw)
    if (marker === null || typeof marker !== 'object') return undefined
    if (marker.version !== MARKER_VERSION) return undefined
    if (marker.sessionId !== sessionId) return undefined
    return marker
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    return undefined
  }
}

/** Write a marker atomically; the parent directory is created on demand. */
async function writeMarker(config, marker) {
  const file = markerPath(config, marker.sessionId)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFileAtomic(file, JSON.stringify(marker, null, 2) + '\n', {})
}

/** Remove a marker; absence is success. */
async function removeMarker(config, sessionId) {
  await rm(markerPath(config, sessionId), { force: true })
}

/** List all readable markers in the store. */
async function listMarkers(config) {
  const dir = dshHomePath(config.storeSubdir)
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  const markers = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    try {
      const marker = JSON.parse(await readFile(path.join(dir, entry.name), 'utf8'))
      if (marker !== null && typeof marker === 'object' && marker.version === MARKER_VERSION) markers.push(marker)
    } catch {
      // A damaged marker must not stop the other recoveries.
    }
  }
  return markers
}

/**
 * Find the open turn/step at the tail of a session log.
 * @param session - exact session being paused.
 * @returns the open turn and step numbers, or undefined values when balanced.
 */
function openPosition(session) {
  let turn
  let step
  for (const event of session.snapshotEvents()) {
    switch (event.type) {
      case 'turn/start':
        turn = event.data.turn
        step = undefined
        break
      case 'turn/end':
        turn = undefined
        step = undefined
        break
      case 'step/start':
        step = event.data.step
        break
      case 'step/end':
        step = undefined
        break
      default:
        break
    }
  }
  return { turn, step }
}

/** Build the internal continuation message. */
function continuationMessage(marker) {
  const position = marker.turn === undefined
    ? ''
    : ` The interrupted turn was turn ${marker.turn}${marker.step === undefined ? '' : `, step ${marker.step}`}.`
  return createUserMessage({
    source: { kind: 'session-pause' },
    content: [{ type: 'text', text: `${CONTINUE_TEXT}${position}` }],
  })
}

/** Whether a session is a root session that may be paused. */
function isRootSession(session) {
  return session?.header?.delegationDepth === 0 || session?.header?.delegationDepth === undefined
}

/**
 * Continue a paused session once.
 * @param ctx - plugin context.
 * @param config - normalized config.
 * @param agent - exact live agent to continue.
 * @param baseSeq - session sequence captured when the agent was created.
 * @param auto - true when this continuation came from the automatic path.
 */
async function continuePaused(ctx, config, agent, baseSeq, auto) {
  const session = agent.session
  const sessionId = session?.id
  if (sessionId === undefined) return
  const marker = await readMarker(config, sessionId)
  if (marker === undefined) return
  if (ctx.agents.get(sessionId) !== agent) return
  if (agent.status !== 'idle') {
    await removeMarker(config, sessionId)
    return
  }
  const fromSeq = marker.seqAtPause ?? baseSeq ?? 0
  if (session.snapshotEvents(fromSeq).some((event) => event.type === 'user/message')) {
    await removeMarker(config, sessionId)
    return
  }
  await removeMarker(config, sessionId)
  try {
    appendResume(session, marker, auto ? 'auto' : 'manual')
  } catch (error) {
    warn(ctx, `could not record turn/resume: ${String(error?.message ?? error)}`)
  }
  agent.followup(continuationMessage(marker))
  warn(ctx, `continued ${sessionId}${auto ? ' automatically' : ''}`)
}

/**
 * Install `/pause`, `/continue`, and the automatic resume listeners.
 * @param ctx - plugin context.
 * @param rawConfig - bundle patch config row.
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  const timers = new Set()

  ctx.effect(() => ctx.sessionProjections.register({
    key: PAUSE_PROJECTION,
    stateSchema: z.object({
      paused: z.boolean(),
      turn: z.number().int().nonnegative().nullable(),
      updatedAt: z.number(),
    }).strict(),
    init: () => ({ paused: false, turn: null, updatedAt: 0 }),
    apply: (state, event) => {
      if (event.type === 'turn/suspend') {
        return { paused: true, turn: event.data?.turn ?? null, updatedAt: event.data?.suspendedAt ?? event.time }
      }
      if (event.type === 'turn/resume') {
        return { paused: false, turn: event.data?.turn ?? null, updatedAt: event.data?.resumedAt ?? event.time }
      }
      return state
    },
    stateVersion: 1,
    wire: {
      viewSchema: z.object({
        paused: z.boolean(),
        turn: z.number().int().nonnegative().nullable(),
        updatedAt: z.number(),
      }).strict(),
      view: (state) => ({ paused: state.paused, turn: state.turn, updatedAt: state.updatedAt }),
    },
  }), 'session-pause: projection')

  const pause = async (invocation) => {
    const agent = invocation.agent
    const session = agent?.session
    if (session === undefined) {
      return { kind: 'error', text: 'No active session to pause.' }
    }
    if (!isRootSession(session)) {
      return { kind: 'error', text: 'Subagent sessions cannot be paused.' }
    }
    if (agent.status !== 'running') {
      return { kind: 'error', text: 'No running turn to pause. /pause only works while a turn is running.' }
    }
    const position = openPosition(session)
    try {
      await ctx.sessions.flush(session)
    } catch (error) {
      return { kind: 'error', text: `Could not flush the session log: ${String(error?.message ?? error)}` }
    }
    try {
      await writeMarker(config, {
        version: MARKER_VERSION,
        sessionId: session.id,
        cwd: session.header?.cwd,
        pausedAt: Date.now(),
        seqAtPause: session.seq,
        ...position,
      })
    } catch (error) {
      return { kind: 'error', text: `Could not write the pause marker: ${String(error?.message ?? error)}` }
    }
    try {
      appendSuspend(session, position)
    } catch (error) {
      await removeMarker(config, session.id)
      return { kind: 'error', text: `Could not record turn/suspend: ${String(error?.message ?? error)}` }
    }
    agent.cancel({ kind: 'user' }, { keepInbox: true })
    return {
      kind: 'success',
      text: `Paused${position.turn === undefined ? '' : ` turn ${position.turn}${position.step === undefined ? '' : `, step ${position.step}`}`}. Reopen this session to continue automatically, or type /continue.`,
    }
  }

  const resume = async (invocation) => {
    const agent = invocation.agent
    const session = agent?.session
    if (session === undefined) {
      return { kind: 'error', text: 'No active session to continue.' }
    }
    if (agent.status === 'running') {
      return { kind: 'error', text: 'The current turn is still running; stop it before /continue.' }
    }
    const marker = await readMarker(config, session.id)
    if (marker === undefined) {
      return { kind: 'error', text: 'This session has no pause record. Use /pause while a turn is running first.' }
    }
    await removeMarker(config, session.id)
    try {
      appendResume(session, marker, 'manual')
    } catch (error) {
      warn(ctx, `could not record turn/resume: ${String(error?.message ?? error)}`)
    }
    agent.followup(continuationMessage(marker))
    return { kind: 'success', text: 'Continuing the unfinished work.' }
  }

  ctx.commands.register({
    definitionId: CommandDefinitionId('dsh-plugin-session-pause:pause'),
    name: 'pause',
    description: 'Pause the running turn and continue it after reopening the session',
    handler: pause,
  })

  ctx.commands.register({
    definitionId: CommandDefinitionId('dsh-plugin-session-pause:continue'),
    name: 'continue',
    description: 'Continue the unfinished work saved by /pause',
    handler: resume,
  })

  const disposers = []
  disposers.push(ctx.on('agent/created', ({ agent }) => {
    if (!config.autoContinueOnResume) return
    const sessionId = agent?.session?.id
    if (sessionId === undefined) return
    const baseSeq = agent.session.seq
    const timer = setTimeout(() => {
      timers.delete(timer)
      continuePaused(ctx, config, agent, baseSeq, true).catch((error) => {
        warn(ctx, `automatic continue failed: ${String(error?.message ?? error)}`)
      })
    }, config.continuationDelayMs)
    timers.add(timer)
  }))

  if (config.autoResumeOnStartup) {
    disposers.push(ctx.effect(() => {
      const timer = setTimeout(() => {
        void (async () => {
          try {
            const controller = ctx.get('sessionController')
            if (controller === undefined || typeof controller.resume !== 'function') return
            for (const marker of await listMarkers(config)) {
              try {
                await controller.resume(marker.sessionId)
              } catch (error) {
                warn(ctx, `startup resume failed for ${marker.sessionId}: ${String(error?.message ?? error)}`)
              }
            }
          } catch (error) {
            warn(ctx, `startup recovery failed: ${String(error?.message ?? error)}`)
          }
        })()
      }, Math.max(config.continuationDelayMs, 500))
      return () => clearTimeout(timer)
    }, 'session-pause.startupResume'))
  }

  disposers.push(ctx.effect(() => () => {
    for (const timer of timers) clearTimeout(timer)
    timers.clear()
  }, 'session-pause.timers'))

  return () => {
    for (const dispose of disposers) {
      try { dispose?.() } catch { /* best-effort */ }
    }
  }
}
