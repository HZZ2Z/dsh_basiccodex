# dsh-basiccodex

Codex-like basics for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), packaged as one DSH plugin bundle:

- **Next-message prediction** — after a turn ends, suggest the user's likely next message; **Tab** accepts it into the draft without sending.
- **Session pause / continue** — the original composer Stop button pauses the running turn; the original Send button becomes a blue play-triangle continue control while paused; no automatic continuation.

## Package

The plugin lives in [`dsh_basiccodex/`](./dsh_basiccodex/):

```text
dsh_basiccodex/
  package.json        # dsh-basiccodex
  cordis.patch.yml    # one bundle row, nested nextstep/pause config
  lib/
    index.js          # combined host entry
    nextstep.js       # next-message prediction host
    pause.js          # session pause/continue host
    core-events.js    # turn/suspend / turn/resume
    client.js         # combined browser entry
  test/
  tools/
```

## Install

Add the package as a `link:` dependency of a DSH profile and append it to the profile bundle list:

```json
{
  "dependencies": {
    "dsh-basiccodex": "link:C:/path/to/dsh_basiccodex"
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

The package declares `dsh.bundle.patch` and `dsh.client`, so one row inserts the host half and the web GUI loads the merged browser half.

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

## Tests

```powershell
cd dsh_basiccodex
npm test
```

Expected:

```text
host.test.mjs: ok
session-pause host tests: OK
dsh-basiccodex client smoke: OK
```
