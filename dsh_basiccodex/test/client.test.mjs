// Combined client bundle smoke test: one loader entry must register both overlay
// slots (nextstep ghost + pause continue control) and merge their inject arrays.
import assert from 'node:assert/strict'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pkg = new URL('..', import.meta.url)
const react = {
  useState: (value) => [value, () => {}],
  useEffect: () => {},
  useLayoutEffect: () => {},
  useRef: () => ({ current: null }),
  createElement: (type, props) => ({ type, props }),
  Fragment: Symbol('Fragment'),
}
const jsxRuntime = {
  jsx: (type, props) => ({ type, props }),
  jsxs: (type, props) => ({ type, props }),
  Fragment: react.Fragment,
}
const documentStub = {
  documentElement: { dataset: {} },
  addEventListener: () => {},
  removeEventListener: () => {},
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: () => ({ dataset: {}, textContent: '', setAttribute: () => {} }),
  head: { appendChild: () => {} },
}
globalThis.document = documentStub
globalThis.window = {
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => {},
}
globalThis.Element = class {}
globalThis.ResizeObserver = class { observe() {} disconnect() {} }

let loaded = null
globalThis.window.__ModuleLoader__ = { load(entry) { loaded = entry } }
const requireStub = (name) => {
  if (name === 'react') return react
  if (name === 'react/jsx-runtime') return jsxRuntime
  throw new Error(`unexpected require: ${name}`)
}

await import(pathToFileURL(fileURLToPath(new URL('lib/client.js', pkg))).href)
assert.ok(loaded !== null, 'client loader must register one entry')
const exports = loaded.factory(requireStub)
const registered = []
const ctx = {
  slots: {
    inject: (_name, fn) => { fn() },
    register: (definition, component) => { registered.push({ definition, component }); return () => {} },
  },
  sessions: { binding: () => undefined },
  effect: (fn) => fn(),
}
exports.apply(ctx)
assert.deepEqual(exports.inject, ['slots', 'sessions'])
assert.deepEqual(registered.map((entry) => entry.definition.name + ':' + entry.definition.id), [
  'conversation.input.overlay:nextstep',
  'conversation.input.overlay:session-pause',
])
console.log('dsh-basiccodex client smoke: OK')
