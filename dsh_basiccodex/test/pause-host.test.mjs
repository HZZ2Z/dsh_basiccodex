/**
 * Host-half tests for dsh-plugin-session-pause.
 *
 * The test composes a fake cordis context with the exact services the plugin
 * injects, then drives the two commands and the agent/created recovery path.
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const home = await mkdtemp(path.join(os.tmpdir(), 'dsh-session-pause-'))
process.env.DSH_HOME = home

const { apply } = await import('../lib/pause.js')

/** Minimal cordis-like context used by the host half. */
function createContext() {
  const commands = new Map()
  const listeners = new Map()
  const disposers = []
  const flushes = []
  const agents = new Map()
  const projections = []
  let sessionController

  const ctx = {
    logger: { warn: () => {} },
    commands: {
      register(definition) {
        commands.set(definition.name, definition)
        return () => commands.delete(definition.name)
      },
    },
    sessionProjections: {
      register(definition) {
        projections.push(definition)
        return () => {}
      },
    },
    sessions: {
      async flush(session) {
        flushes.push(session.id)
        return true
      },
    },
    agents: {
      get(id) {
        return agents.get(id)
      },
    },
    get(service) {
      if (service === 'sessionController') return sessionController
      return undefined
    },
    on(event, handler) {
      const handlers = listeners.get(event) ?? []
      handlers.push(handler)
      listeners.set(event, handlers)
      const dispose = () => {
        const current = listeners.get(event) ?? []
        listeners.set(event, current.filter((entry) => entry !== handler))
      }
      disposers.push(dispose)
      return dispose
    },
    effect(callback) {
      const dispose = callback()
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose
    },
    emit(event, payload) {
      for (const handler of listeners.get(event) ?? []) handler(payload)
    },
    dispose() {
      for (const dispose of disposers.splice(0)) {
        try { dispose() } catch {}
      }
    },
  }

  return { ctx, commands, flushes, agents, projections, listeners, setSessionController: (value) => { sessionController = value } }
}

/** Build a fake session with one open turn and step. */
function createSession() {
  const events = [
    { type: 'turn/start', seq: 0, time: Date.now(), data: { turn: 1 } },
    { type: 'step/start', seq: 1, time: Date.now(), data: { turn: 1, step: 1 } },
  ]
  const session = {
    id: 'session-pause-test-0001',
    header: { cwd: path.join(home, 'workspace'), delegationDepth: 0 },
    events,
    get seq() { return this.events.length },
    append(type, data) {
      const event = { type, seq: this.events.length, time: Date.now(), data }
      this.events.push(event)
      return event
    },
    snapshotEvents(from = 0) { return this.events.slice(from) },
  }
  return session
}

/** Build a fake agent over a session. */
function createAgent(session) {
  return {
    id: session.id,
    session,
    status: 'running',
    cancels: [],
    followups: [],
    cancel(cause, options) {
      this.cancels.push({ cause, options })
      this.status = 'idle'
    },
    followup(message) {
      this.followups.push(message)
      this.status = 'running'
    },
  }
}

const markerFile = (sessionId) => path.join(home, 'session-pause', `${sessionId}.json`)

const h = createContext()
const session = createSession()
const agent = createAgent(session)
h.agents.set(session.id, agent)
apply(h.ctx, { continuationDelayMs: 20, autoContinueOnResume: true, autoResumeOnStartup: false })

assert.deepEqual([...h.commands.keys()].sort(), ['continue', 'pause'])

// The pause projection folds the two core events into the client-visible state.
assert.equal(h.projections.length, 1)
assert.equal(h.projections[0].key, 'sessionPause')
assert.equal(h.projections[0].apply({ paused: false, turn: null, updatedAt: 0 }, { type: 'turn/suspend', time: 1, data: { turn: 1, suspendedAt: 1 } }).paused, true)
assert.equal(h.projections[0].apply({ paused: true, turn: 1, updatedAt: 1 }, { type: 'turn/resume', time: 2, data: { turn: 1, resumedAt: 2 } }).paused, false)

// /pause stops the running turn, flushes the log, and writes the marker.
const pause = h.commands.get('pause')
const pauseResult = await pause.handler({ agent, rawInput: '', attachments: [] })
assert.equal(pauseResult.kind, 'success')
assert.deepEqual(h.flushes, [session.id])
assert.equal(agent.cancels.length, 1)
assert.deepEqual(agent.cancels[0].cause, { kind: 'user' })
assert.deepEqual(agent.cancels[0].options, { keepInbox: true })
assert.equal(session.events.filter((event) => event.type === 'turn/suspend').length, 1)
assert.equal(session.events.find((event) => event.type === 'turn/suspend').data.turn, 1)
const marker = JSON.parse(await readFile(markerFile(session.id), 'utf8'))
assert.equal(marker.sessionId, session.id)
assert.equal(marker.turn, 1)
assert.equal(marker.step, 1)
assert.equal(marker.version, 1)

// /continue consumes the marker and queues the developer continuation message.
const resume = h.commands.get('continue')
const resumeResult = await resume.handler({ agent, rawInput: '', attachments: [] })
assert.equal(resumeResult.kind, 'success')
assert.equal(agent.followups.length, 1)
assert.equal(agent.followups[0].role, 'user')
const continuedText = agent.followups[0].content.map((block) => block.text).join(' ')
assert.match(continuedText, /Continue the unfinished work/)
assert.match(continuedText, /turn 1/)
assert.equal(session.events.filter((event) => event.type === 'turn/resume').length, 1)
await assert.rejects(readFile(markerFile(session.id)), { code: 'ENOENT' })

// /continue without a marker is an error.
agent.status = 'idle'
const missingResult = await resume.handler({ agent, rawInput: '', attachments: [] })
assert.equal(missingResult.kind, 'error')

// /pause while idle is an error.
agent.status = 'idle'
const idlePause = await pause.handler({ agent, rawInput: '', attachments: [] })
assert.equal(idlePause.kind, 'error')

// Automatic continuation: reopening the session creates the agent and the marker
// is consumed after the delay.
agent.status = 'running'
await pause.handler({ agent, rawInput: '', attachments: [] })
assert.equal(agent.followups.length, 1)
agent.status = 'idle'
h.ctx.emit('agent/created', { agent, source: 'resume' })
await new Promise((resolve) => setTimeout(resolve, 80))
assert.equal(agent.followups.length, 2)
assert.equal(session.events.filter((event) => event.type === 'turn/resume').length, 2)
await assert.rejects(readFile(markerFile(session.id)), { code: 'ENOENT' })

// Automatic continuation is skipped when the user already appended a message.
agent.status = 'running'
await pause.handler({ agent, rawInput: '', attachments: [] })
agent.status = 'idle'
session.events.push({ type: 'user/message', seq: session.events.length, time: Date.now(), data: {} })
h.ctx.emit('agent/created', { agent, source: 'resume' })
await new Promise((resolve) => setTimeout(resolve, 80))
assert.equal(agent.followups.length, 2)
await assert.rejects(readFile(markerFile(session.id)), { code: 'ENOENT' })

h.ctx.dispose()

// Startup recovery calls sessionController.resume for every marker when enabled.
{
  const startup = createContext()
  const startupSession = createSession()
  startupSession.id = 'session-startup-test-0001'
  const startupAgent = createAgent(startupSession)
  startup.agents.set(startupSession.id, startupAgent)
  const resumed = []
  startup.setSessionController({ async resume(sessionId) { resumed.push(sessionId) } })
  apply(startup.ctx, { continuationDelayMs: 20, autoContinueOnResume: false, autoResumeOnStartup: true })
  startupAgent.status = 'running'
  await startup.commands.get('pause').handler({ agent: startupAgent, rawInput: '', attachments: [] })
  startupAgent.status = 'idle'
  await new Promise((resolve) => setTimeout(resolve, 700))
  assert.deepEqual(resumed, [startupSession.id])
  startup.ctx.dispose()
}

await rm(home, { recursive: true, force: true })
console.log('session-pause host tests: OK')
