/**
 * dsh-basiccodex — one DSH plugin bundle for the Codex-like basics.
 *
 * Host half composition:
 * - `nextstep.js`  — next-message prediction (after a turn ends)
 * - `pause.js`     — session pause/continue (`/pause`, `/continue`, original
 *                    stop/send button reuse, core `turn/suspend` / `turn/resume`)
 *
 * The two halves keep their own configs; this entry only merges their inject
 * surface and applies both to the same Cordis context.
 *
 * @module dsh-basiccodex
 */

import { apply as applyNextStep, inject as injectNextStep } from './nextstep.js'
import { apply as applyPause, inject as injectPause } from './pause.js'

export const name = 'basiccodex'

/** Union of both halves' required services. */
export const inject = Object.freeze([...new Set([...injectNextStep, ...injectPause])])

/**
 * Apply both feature halves.
 * @param ctx - plugin context.
 * @param rawConfig - bundle patch config: `{ nextstep, pause }`.
 * @returns a disposer that tears down both halves.
 */
export function apply(ctx, rawConfig) {
  const config = rawConfig !== null && typeof rawConfig === 'object' ? rawConfig : {}
  const nextstep = config.nextstep !== null && typeof config.nextstep === 'object' ? config.nextstep : config
  const pause = config.pause !== null && typeof config.pause === 'object' ? config.pause : config
  const disposers = [
    applyNextStep(ctx, nextstep),
    applyPause(ctx, pause),
  ]
  return () => {
    for (const dispose of disposers) {
      try { dispose?.() } catch { /* best-effort teardown */ }
    }
  }
}
