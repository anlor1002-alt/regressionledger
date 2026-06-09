# Examples & rollout guide

## Cautious rollout: warn → block

A hard-blocking guardrail earns trust by being right. The safe way to adopt it:

1. **Start in `warn` mode.** Copy [`config.warn.json`](config.warn.json) to
   `.regressionledger/config.json` (or run `rl init --warn`). Now RegressionLedger
   only *injects a warning* when the agent re-applies a previously-failed fix — it
   never denies. Work normally for a few days.
2. **Inspect what it caught.** `rl show` and `rl stats` show the recorded
   failures and what would have been blocked, on *your* codebase.
3. **Flip to `block`.** Once you trust the matches, switch with
   `rl config mode block` (or use [`config.block.json`](config.block.json)).

## Tuning

| Setting | Looser (fewer blocks) | Stricter (more blocks) |
| --- | --- | --- |
| `threshold` | raise toward `0.95` | lower toward `0.85` |
| `crossSymbol` | `false` (require same enclosing symbol) | `true` (match anywhere in the file) |

## Installing the hooks

**As a Claude Code plugin (recommended):**

```text
/plugin marketplace add anlor1002-alt/regressionledger
/plugin install regressionledger@anlor1002-plugins
```

Hooks activate automatically — no `settings.json` editing, no restart.

**Or wire it manually into a project** with `rl init` (writes the hooks into
`./.claude/settings.json`). To preview the exact block it adds:

```bash
rl init --print
```
