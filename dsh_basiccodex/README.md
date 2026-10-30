# dsh-basiccodex

Codex-like basics for DeepSeek Harness, merged into one plugin bundle:

| Feature | Host | Browser |
|---|---|---|
| **Next-step prediction** | after a turn ends, one auxiliary model call over the recent context; log-only `nextstep` projection | suggestion above the composer; **Tab** inserts it into the draft without sending |
| **Session pause / continue** | `/pause`, `/continue`, core `turn/suspend` / `turn/resume` events, recovery marker under `$DSH_HOME/session-pause/` | original **Stop** button pauses; original **Send** button shows a blue play-triangle continue control while paused; no automatic continue |

## Install

Add the package as a `link:` dependency of a profile and append it to that profile's bundle list:

```json
{
  "dependencies": {
    "dsh-basiccodex": "link:C:/Users/22516/Desktop/dsh_nextStep/plugin/dsh_basiccodex"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-basiccodex"
      ]
    }
  }
}
```

The package declares both `dsh.bundle.patch` and `dsh.client`, so one row inserts the host half and the web GUI loads the merged browser half.

## Configuration

```yaml
- insert:
    - id: basiccodex
      name: dsh-basiccodex
      config:
        nextstep:
          enabled: true
          provider: ''
          model: ''
          contextMessages: 12
          maxContextChars: 24000
          maxTokens: 512
          temperature: 0
          timeoutMs: 60000
          sampleRate: 1
          minTurn: 1
        pause:
          autoContinueOnResume: false
          autoResumeOnStartup: false
          continuationDelayMs: 1500
          storeSubdir: session-pause
```

`nextstep` is the same config as the former `dsh-plugin-nextstep`; `pause` is the same config as the former `dsh-plugin-session-pause`. Both defaults keep automatic pause continuation off.

## Pause behavior

- While a turn is running, the original composer **Stop** click is captured and routed to `/pause`.
- `/pause` flushes the session log, appends `turn/suspend`, writes a recovery marker, then stops the turn.
- While paused and the draft is empty, the original **Send** position shows a blue circular play-triangle button; clicking it appends `turn/resume` and queues the continuation message.
- While paused and the draft is non-empty, the normal send runs.
- Reopening a session never continues on its own; an explicit click or `/continue` is required.

## Tests

```powershell
cd plugin/dsh_basiccodex
node test/nextstep-host.test.mjs
node test/pause-host.test.mjs
```

## Repository

The package lives in the `dsh_basiccodex` repository under `dsh_basiccodex/`.
The legacy `plugin/` (nextstep) package remains in the repository for history; the session-pause source was merged into this package. Profiles should use `dsh-basiccodex`.
