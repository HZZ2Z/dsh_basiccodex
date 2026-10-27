import assert from 'node:assert/strict'

let entry
const styles = []
const listeners = new Map()
const bodyClasses = new Set()

globalThis.window = { __ModuleLoader__: { load: value => { entry = value } }, addEventListener: () => {}, removeEventListener: () => {} }
globalThis.Element = class Element {}
globalThis.document = {
  querySelector: () => null,
  createElement: () => ({ dataset: {}, textContent: '' }),
  head: { appendChild: node => styles.push(node) },
  body: {
    classList: {
      add: name => bodyClasses.add(name),
      remove: name => bodyClasses.delete(name),
    },
  },
  addEventListener: (type, handler) => listeners.set(type, handler),
  removeEventListener: type => listeners.delete(type),
}

const require = specifier => {
  if (specifier === 'react') {
    return {
      useEffect: fn => fn(),
      useLayoutEffect: fn => fn(),
      useRef: () => ({ current: null }),
      useState: initial => [initial, () => {}],
    }
  }
  if (specifier === 'react/jsx-runtime') {
    return { jsx: (type, props) => ({ type, props }) }
  }
  throw new Error(`unexpected require: ${specifier}`)
}

await import('../lib/client.js')
assert.equal(entry.id, 'dsh-plugin-nextstep')
const exported = entry.factory(require)
assert.equal(typeof exported.apply, 'function')
assert.deepEqual(exported.inject, ['slots'])
assert.equal(styles.length, 1)

const registrations = []
const ctx = {
  slots: {
    inject(name, callback) {
      assert.equal(name, 'conversation.input.overlay')
      callback()
      return () => {}
    },
    register(options, component) {
      registrations.push({ options, component })
      return () => {}
    },
  },
}
exported.apply(ctx)
assert.equal(registrations.length, 1)
assert.equal(registrations[0].options.name, 'conversation.input.overlay')
assert.equal(registrations[0].options.id, 'nextstep')

const component = registrations[0].component
const inserted = []
const suggestion = { text: 'Run the tests.', turn: 1, status: 'done', model: 'a/b', usage: null, updatedAt: 1 }
const inputActions = {
  captureInsertion: () => ({ start: 0, end: 0, draftRev: 1 }),
  insertText: (text, span) => { inserted.push({ text, span }); return true },
}
const baseProps = {
  useProjection: key => { assert.equal(key, 'nextstep'); return suggestion },
  useSession: selector => selector({ running: false }),
  inputActions,
  sessionId: 'session-1',
}

const rendered = component({
  ...baseProps,
  useInput: selector => selector({ draft: '', phase: 'plain' }),
})
assert.equal(rendered.type, 'span')
assert.equal(rendered.props.className, 'nextstep_ghost')
assert.equal(rendered.props.children, 'Run the tests.')
assert.equal(bodyClasses.has('dsh-nextstep-ghost'), true)

const tabEvent = {
  key: 'Tab',
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  target: new globalThis.Element(),
  preventDefault() {},
  stopPropagation() {},
}
const originalClosest = globalThis.Element.prototype.closest
globalThis.Element.prototype.closest = () => ({})
listeners.get('keydown')(tabEvent)
globalThis.Element.prototype.closest = originalClosest
assert.deepEqual(inserted, [{ text: 'Run the tests.', span: { start: 0, end: 0, draftRev: 1 } }])

const hidden = component({
  ...baseProps,
  useInput: selector => selector({ draft: 'typing', phase: 'plain' }),
})
assert.equal(hidden, null)

console.log('client.test.mjs: ok')
