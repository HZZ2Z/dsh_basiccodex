/**
 * Core-level session events for pause/resume.
 *
 * `turn/suspend` and `turn/resume` are real append-only Session events: the
 * installed Harness build does not know them, so this module adds them to the
 * vocabulary at load time. A paused turn keeps its ordinary `turn/end{aborted}`
 * (the agent loop still closes the turn), and the extra events make the pause
 * explicit and replayable without changing the core state machine.
 *
 * Log compatibility: events written by this plugin are only readable by a build
 * that has this plugin loaded. That is the same compatibility contract as any
 * future core event type.
 *
 * @module dsh-plugin-session-pause/core-events
 */

import { KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session'

/** Event names added to the installed Session vocabulary. */
export const CORE_EVENT_TYPES = Object.freeze(['turn/suspend', 'turn/resume'])

let installed = false

/** Add the pause/resume event names to the installed vocabulary once. */
export function installCoreEvents() {
  if (installed) return
  installed = true
  for (const type of CORE_EVENT_TYPES) KNOWN_SESSION_EVENT_TYPES.add(type)
}

/**
 * Append one `turn/suspend` event.
 * @param session - exact session being paused.
 * @param marker - open turn/step captured before the stop.
 * @returns the accepted event, or undefined when there was no open turn.
 */
export function appendSuspend(session, marker) {
  if (marker.turn === undefined) return undefined
  return session.append('turn/suspend', {
    turn: marker.turn,
    ...marker.step === undefined ? {} : { step: marker.step },
    reason: { kind: 'user' },
    suspendedAt: Date.now(),
  })
}

/**
 * Append one `turn/resume` event before the continuation turn.
 * @param session - exact session being continued.
 * @param marker - marker consumed by the continuation.
 * @param reason - manual `/continue` or automatic reopen.
 * @returns the accepted event, or undefined when the marker has no turn.
 */
export function appendResume(session, marker, reason) {
  if (marker.turn === undefined) return undefined
  return session.append('turn/resume', {
    turn: marker.turn,
    ...marker.step === undefined ? {} : { step: marker.step },
    reason: { kind: reason },
    resumedAt: Date.now(),
  })
}
