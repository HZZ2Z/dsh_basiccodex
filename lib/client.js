/**
 * Next-step prediction — browser half.
 *
 * Shows the Host-generated suggestion as inline ghost text inside the composer:
 * an absolutely positioned span aligned with the editor's first text line, plus the
 * placeholder is hidden while the ghost is visible. Tab inserts the suggestion
 * through the official `InputActions.captureInsertion()` / `insertText()` pair; it
 * never sends.
 *
 * The ghost hides while the draft is non-empty, while a turn is running, and after
 * acceptance.
 */

window.__ModuleLoader__.load({
  id: 'dsh-plugin-nextstep',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    let react = require('react')
    let react_jsx_runtime = require('react/jsx-runtime')

    const css = [
      '.nextstep_ghost{position:absolute;z-index:1;pointer-events:none;',
      'color:var(--dsw-alias-label-caption,#9ca3af);font:inherit;',
      'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;',
      'opacity:.9;}',
      'body.dsh-nextstep-ghost [data-composer-input] + [class*="placeholder"]{visibility:hidden;}',
    ].join('')

    const tagId = 'dsh-plugin-nextstep/NextStepGhost.module.css'
    if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-plugin-nextstep'
      tag.dataset.pluginCss = tagId
      tag.textContent = css
      document.head.appendChild(tag)
    }

    /**
     * Composer overlay entry: inline ghost text aligned with the editor's first
     * line, plus the Tab acceptance handler.
     * @param props - standard session props: projection, input, session, actions.
     * @returns the ghost span, or null while it should stay hidden.
     */
    function NextStepGhost({ useProjection, useInput, useSession, inputActions, sessionId }) {
      const suggestion = useProjection('nextstep')
      const draft = useInput(state => state.draft)
      const phase = useInput(state => state.phase)
      const running = useSession(snapshot => snapshot.running)
      const text = suggestion === undefined || suggestion === null ? null : suggestion.text
      const status = suggestion === undefined || suggestion === null ? 'idle' : suggestion.status
      const visible = text !== null && text !== '' && status === 'done'
        && draft.length === 0 && phase === 'plain' && !running
      const anchor = react.useRef(null)
      const [pos, setPos] = react.useState(null)

      react.useLayoutEffect(() => {
        if (!visible) {
          setPos(null)
          return undefined
        }
        const measure = () => {
          const node = anchor.current
          if (node === null) return
          const input = document.querySelector('[data-composer-input]')
          if (input === null) return
          const anchorRect = node.getBoundingClientRect()
          const inputRect = input.getBoundingClientRect()
          const style = getComputedStyle(input)
          const padLeft = parseFloat(style.paddingLeft) || 14
          const padTop = parseFloat(style.paddingTop) || 4
          setPos({
            left: inputRect.left - anchorRect.left + padLeft,
            top: inputRect.top - anchorRect.top + padTop,
            maxWidth: Math.max(0, inputRect.width - padLeft - 8),
          })
        }
        measure()
        document.body.classList.add('dsh-nextstep-ghost')
        window.addEventListener('resize', measure)
        return () => {
          document.body.classList.remove('dsh-nextstep-ghost')
          window.removeEventListener('resize', measure)
        }
      }, [visible, text, sessionId])

      react.useEffect(() => {
        if (!visible) return undefined
        const accept = event => {
          if (event.key !== 'Tab' || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
          const target = event.target
          if (!(target instanceof Element) || target.closest('[data-composer-input]') === null) return
          event.preventDefault()
          event.stopPropagation()
          const span = inputActions.captureInsertion()
          inputActions.insertText(text, span)
        }
        document.addEventListener('keydown', accept, true)
        return () => document.removeEventListener('keydown', accept, true)
      }, [visible, text, inputActions])

      if (!visible) return null

      const jsx = react_jsx_runtime.jsx
      return jsx('span', {
        ref: anchor,
        className: 'nextstep_ghost',
        style: {
          left: pos === null ? 0 : pos.left,
          top: pos === null ? 0 : pos.top,
          maxWidth: pos === null ? '100%' : pos.maxWidth,
        },
        children: text,
      })
    }

    const inject = ['slots']

    /**
     * Register the inline ghost entry inside the composer card.
     * @param ctx - plugin-owned browser context.
     */
    function apply(ctx) {
      ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register({
        name: 'conversation.input.overlay',
        id: 'nextstep',
        order: 20,
      }, NextStepGhost))
    }

    exports.NextStepGhost = NextStepGhost
    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})

//# sourceMappingURL=client.js.map
