import assert from 'node:assert/strict'
import { Session, SessionId, SessionLogOffset, pluginRecordOf } from '@deepseek-ai/dsh-session'
import { apply, inject, name } from '../lib/index.js'

const appended = []
const handlers = []
const projections = []
const ctx = {
  effect(fn) {
    return fn()
  },
  on(event, handler) {
    handlers.push({ event, handler })
    return () => {}
  },
  sessionProjections: {
    register(definition) {
      projections.push(definition)
      return () => {}
    },
  },
  llm: {
    async prepareCall(config, signal) {
      assert.equal(config.provider, 'deepseek-official')
      assert.equal(config.model, 'deepseek-flash')
      return {
        config,
        stream(options) {
          assert.equal(options.maxTokens, 512)
          assert.equal(options.temperature, 0)
          assert.equal(options.messages.at(-1).role, 'user')
          assert.match(options.messages.at(-1).content[0].text, /next message/)
          return (async function* () {
            yield { type: 'text-delta', index: 0, text: '  "Run the tests." ' }
            yield { type: 'usage', usage: { inputTokens: 1200, outputTokens: 6, cacheReadTokens: 1024 } }
            yield { type: 'finish', reason: { kind: 'stop' } }
          })()
        },
      }
    },
  },
}

/**
 * A real detached Session, so `appendPluginRecord()` accepts it, plus the two
 * methods the plugin reads. `append()` is disabled to prove the suggestion never
 * takes the unmarked route.
 */
const header = {
  version: 4,
  id: SessionId('session-test-0001'),
  createdAt: Date.now(),
  isSeeded: false,
  delegationDepth: 0,
}
const session = Session.fromRestore(SessionId('session-test-0001'), [], header, SessionLogOffset(0), 'detached')
session.requestHeader = () => ({
  config: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'low' },
})
session.deriveMessages = () => [
  { role: 'system', content: [{ type: 'text', text: 'system prompt' }] },
  { role: 'tool', content: [{ type: 'text', text: 'tool result' }] },
  { role: 'user', content: [{ type: 'text', text: 'fix the bug' }] },
  { role: 'assistant', content: [{ type: 'text', text: 'fixed' }] },
]
/** `session.append()` must never carry the suggestion: it cannot mark it. */
session.append = type => {
  throw new Error(`unexpected session.append("${type}") — the suggestion must use appendPluginRecord`)
}

assert.equal(name, 'nextstep')
assert.deepEqual(inject, ['llm', 'sessionProjections'])

apply(ctx, {})
assert.equal(projections.length, 1)
assert.equal(projections[0].key, 'nextstep')
assert.equal(typeof projections[0].wire.view, 'function')
assert.deepEqual(
  projections[0].init(),
  { text: null, turn: 0, status: 'idle', model: null, usage: null, updatedAt: 0 },
)

const folded = projections[0].apply(projections[0].init(), {
  type: 'plugin:nextstep/suggestion',
  data: { text: 'Run the tests.', turn: 1, status: 'done', model: 'a/b', at: 5 },
})
assert.equal(projections[0].wire.view(folded).text, 'Run the tests.')

// A record restored from a repaired log may still carry the legacy type name.
const legacyFolded = projections[0].apply(projections[0].init(), {
  type: 'nextstep/suggestion',
  data: { text: 'Legacy line.', turn: 2, status: 'done', model: 'a/b', at: 6 },
})
assert.equal(projections[0].wire.view(legacyFolded).text, 'Legacy line.')

// An unrelated event must not disturb the folded suggestion.
const untouched = projections[0].apply(projections[0].init(), {
  type: 'turn/end',
  data: { turn: 3 },
})
assert.equal(projections[0].wire.view(untouched).status, 'idle')

assert.equal(handlers.length, 1)
assert.equal(handlers[0].event, 'session/event')

handlers[0].handler(session, { type: 'turn/end', data: { turn: 1, reason: 'completed' } })
// A fresh Session already holds its own setup events (e.g. `session/end-seed`).
const baseSeq = session.seq
for (let i = 0; i < 50 && session.seq === baseSeq; i += 1) await new Promise(resolve => setTimeout(resolve, 20))

// The suggestion must land as exactly one ignorable plugin record.
assert.equal(session.seq, baseSeq + 1, 'exactly one record must be appended')
const record = session.eventAt(baseSeq)
assert.equal(record.type, 'plugin:nextstep/suggestion')
assert.equal(record.ignorable, true)
assert.notEqual(pluginRecordOf(record), undefined)
assert.equal(record.data.text, 'Run the tests.')
assert.equal(record.data.status, 'done')
assert.equal(record.data.turn, 1)
assert.equal(record.data.usage.cacheReadTokens, 1024)

// The projection must fold the record the plugin actually wrote.
const fromLog = projections[0].apply(projections[0].init(), record)
assert.equal(projections[0].wire.view(fromLog).text, 'Run the tests.')
assert.equal(projections[0].wire.view(fromLog).status, 'done')

console.log('host.test.mjs: ok')
