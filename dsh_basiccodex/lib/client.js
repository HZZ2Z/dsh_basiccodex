/**
 * dsh-basiccodex — browser half.
 *
 * One module entry composes both client halves:
 * - nextstep: after-turn next-message suggestion (ghost text + Tab accept);
 * - pause: original stop button pauses, original send button shows a
 *   play-triangle continue control while the session is paused.
 *
 * The two source bundles keep their own slots/inject surfaces; this entry only
 * calls both factories once and merges their inject arrays.
 */

window.__ModuleLoader__.load({
  id: 'dsh-basiccodex',
  factory: (require) => {
    function loadNextStep(require) {
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
              document.body.classList.add('dsh-nextstep-ghost')
              let cancelled = false
              let observer = null
              /**
               * Resolve the overlay anchor, the composer card, the composer input, and
               * the coordinate base. The ghost must be measured against the anchor, not
               * against its own current rect: the anchor is `position:absolute` at the
               * card top, while the input sits below the card padding and accessory rows.
               * @returns the elements to measure, or null when the composer is absent.
               */
              const targets = () => {
                const node = anchor.current
                if (node === null) return null
                const overlay = node.closest('[data-composer-overlay]')
                const card = overlay?.closest('[data-composer-card]') ?? null
                const input = card?.querySelector('[data-composer-input]') ?? document.querySelector('[data-composer-input]')
                const base = overlay ?? node.parentElement
                if (input === null || base === null) return null
                return { card, input, base }
              }
              const measure = () => {
                if (cancelled) return
                const found = targets()
                if (found === null) return
                const baseRect = found.base.getBoundingClientRect()
                const inputRect = found.input.getBoundingClientRect()
                const style = getComputedStyle(found.input)
                const padLeft = parseFloat(style.paddingLeft) || 14
                const padTop = parseFloat(style.paddingTop) || 4
                setPos({
                  left: inputRect.left - baseRect.left + padLeft,
                  top: inputRect.top - baseRect.top + padTop,
                  maxWidth: Math.max(0, inputRect.width - padLeft - 8),
                })
              }
              measure()
              const found = targets()
              if (found !== null && typeof ResizeObserver !== 'undefined') {
                observer = new ResizeObserver(measure)
                if (found.card !== null) observer.observe(found.card)
                observer.observe(found.input)
              }
              window.addEventListener('resize', measure)
              if (document.fonts?.ready !== undefined) {
                document.fonts.ready.then(measure).catch(() => {})
              }
              return () => {
                cancelled = true
                observer?.disconnect()
                document.body.classList.remove('dsh-nextstep-ghost')
                window.removeEventListener('resize', measure)
              }
            }, [visible, sessionId])
      
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
    }

    function loadPause(require) {
          var module = { exports: {} }
          var exports = module.exports
          Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
          let react = require('react')
          let react_jsx_runtime = require('react/jsx-runtime')
      
          const inject = ['slots', 'sessions']
      
          /** Latest mounted session state, read by the document capture listener. */
          const live = {
            sessionId: undefined,
            paused: false,
            running: false,
          }
      
          /** Run one slash command through the Session Controller client. */
          async function runCommand(ctx, sessionId, line) {
            try {
              const binding = ctx.sessions.binding(sessionId)
              const session = binding === undefined ? undefined : binding.session
              if (session === undefined) return
              const result = await session.command(line)
              if (result !== undefined && result.ok === false) {
                console.warn('[session-pause] command rejected', line, result.error)
              }
            } catch (error) {
              console.warn('[session-pause] command failed', line, error)
            }
          }
      
          /** Resolve the original composer primary button (send or stop). */
          function primaryButton(card) {
            const buttons = [...card.querySelectorAll('button')]
            return buttons.find((button) => {
              const label = button.getAttribute('aria-label') ?? ''
              return /发送|send|停止|stop/iu.test(label)
            }) ?? null
          }
      
          /**
           * Overlay control: tracks the current session and renders a transparent
           * "continue" hit area over the original send button while paused.
           */
          function ContinueOverlay({ ctx, sessionId, useProjection, useInput, useSession }) {
            const projection = useProjection('sessionPause')
            const paused = projection?.paused === true
            const running = useSession((snapshot) => snapshot.running)
            const draft = useInput((state) => state.draft)
            live.sessionId = sessionId
            live.paused = paused
            live.running = running
      
            const anchor = react.useRef(null)
            const [rect, setRect] = react.useState(null)
      
            react.useLayoutEffect(() => {
              if (!paused || draft.length > 0 || sessionId === undefined) {
                setRect(null)
                return undefined
              }
              let cancelled = false
              const measure = () => {
                if (cancelled) return
                const card = document.querySelector('[data-composer-card]')
                const send = card === null ? null : primaryButton(card)
                if (send === null) {
                  setRect(null)
                  return
                }
                const sendRect = send.getBoundingClientRect()
                const sendStyle = getComputedStyle(send)
                setRect({
                  left: sendRect.left,
                  top: sendRect.top,
                  width: sendRect.width,
                  height: sendRect.height,
                  background: sendStyle.backgroundColor,
                  color: sendStyle.color,
                  borderRadius: sendStyle.borderRadius,
                })
              }
              measure()
              const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
              const card = document.querySelector('[data-composer-card]')
              if (observer !== null && card !== null) observer.observe(card)
              window.addEventListener('resize', measure)
              window.addEventListener('scroll', measure, true)
              return () => {
                cancelled = true
                observer?.disconnect()
                window.removeEventListener('resize', measure)
                window.removeEventListener('scroll', measure, true)
              }
            }, [paused, draft, sessionId])
      
            const onContinue = () => {
              if (!paused || sessionId === undefined) return
              void runCommand(ctx, sessionId, '/continue')
            }
      
            return react_jsx_runtime.jsxs(react.Fragment, {
              children: [
                react_jsx_runtime.jsx('span', {
                  ref: anchor,
                  'data-session-pause-tracker': '1',
                  'data-paused': paused ? 'true' : 'false',
                  'data-draft-len': String(draft?.length ?? -1),
                  'data-rect': rect === null ? 'none' : JSON.stringify(rect),
                  'aria-hidden': 'true',
                  style: { position: 'absolute', left: 0, top: 0, width: 0, height: 0, pointerEvents: 'none' },
                }),
                paused && draft.length === 0 && rect !== null
                  ? react_jsx_runtime.jsxs('button', {
                      type: 'button',
                      'aria-label': '继续上次暂停的任务',
                      title: '继续上次暂停的任务',
                      onMouseDown: (event) => event.preventDefault(),
                      onClick: onContinue,
                      style: {
                        position: 'fixed',
                        left: `${rect.left}px`,
                        top: `${rect.top}px`,
                        width: `${rect.width}px`,
                        height: `${rect.height}px`,
                        margin: 0,
                        padding: 0,
                        border: 'none',
                        borderRadius: rect.borderRadius ?? '999px',
                        background: rect.background ?? 'rgb(65, 118, 230)',
                        color: rect.color ?? 'rgb(255, 255, 255)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        cursor: 'pointer',
                        zIndex: 9999,
                        boxShadow: 'none',
                      },
                      children: react_jsx_runtime.jsx('svg', {
                        viewBox: '0 0 16 16',
                        width: 16,
                        height: 16,
                        'aria-hidden': 'true',
                        style: { display: 'block' },
                        children: react_jsx_runtime.jsx('path', {
                          d: 'M5 2.8c0-.8.9-1.3 1.6-.9l7.2 4.6c.6.4.6 1.3 0 1.7l-7.2 4.6c-.7.4-1.6-.1-1.6-.9V2.8Z',
                          fill: 'currentColor',
                        }),
                      }),
                    })
                  : null,
              ],
            })
          }
      
          /**
           * Register the session overlay and the capture-phase stop click.
           * @param ctx - plugin-owned browser context.
           */
          function apply(ctx) {
            ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register({
              name: 'conversation.input.overlay',
              id: 'session-pause',
              order: 60,
            }, (props) => react_jsx_runtime.jsx(ContinueOverlay, { ...props, ctx })))
      
            const onClick = (event) => {
              if (!(event.target instanceof Element)) return
              const button = event.target.closest('button')
              if (button === null) return
              const card = button.closest('[data-composer-card]')
              if (card === null) return
              if (!live.running || live.sessionId === undefined) return
              const label = button.getAttribute('aria-label') ?? ''
              if (!/停止|stop/iu.test(label)) return
              event.preventDefault()
              event.stopPropagation()
              event.stopImmediatePropagation()
              void runCommand(ctx, live.sessionId, '/pause')
            }
            if (typeof document !== 'undefined') document.documentElement.dataset.sessionPause = 'ready'
            document.addEventListener('click', onClick, true)
            ctx.effect(() => () => document.removeEventListener('click', onClick, true))
          }
      
          exports.ContinueOverlay = ContinueOverlay
          exports.apply = apply
          exports.inject = inject
          return module.exports
    }

    const nextstep = loadNextStep(require)
    const pause = loadPause(require)

    function apply(ctx) {
      nextstep.apply(ctx)
      pause.apply(ctx)
    }

    const inject = [...new Set([...(nextstep.inject ?? []), ...(pause.inject ?? [])])]

    return { apply, inject }
  },
})
