# Security Policy

## Threat model & data handling

RegressionLedger is designed to be safe to run on a hook surface that can read
your code and **deny** tool calls. Its guarantees:

- **Local & offline.** It makes **no network calls**, requires **no API keys**,
  and sends nothing anywhere. Everything runs on your machine.
- **No raw secrets stored.** The ledger (`.regressionledger/ledger.json`) holds
  *normalized tokens* (string and number literals are abstracted to `STR`/`NUM`)
  plus a short ~120-char preview of each change and a parsed error signature —
  never your environment, keys, or full files. The ledger is git-ignored by
  default.
- **Fails open.** If the hook hits any internal error it exits cleanly (exit 0,
  empty stdout) and never blocks or corrupts the agent's tool call. A guardrail
  that breaks the thing it protects is worse than no guardrail.
- **Zero dependencies.** No third-party runtime packages, so there is no
  transitive supply-chain surface.

Every claim above is verifiable in `src/` — start with `src/hooks.js`,
`src/ledger.js`, and `src/cli.js` (`cmdHook` is the fail-open boundary).

## Reporting a vulnerability

Please report security issues **privately** via GitHub:

> Repo **Security** tab → **Report a vulnerability** (private advisory).

Do not open a public issue for security problems. We'll acknowledge the report,
investigate, and coordinate a fix and disclosure.

## Supported versions

This project is pre-1.0; security fixes target the latest release on `main`.
