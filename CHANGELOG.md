# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/), and this project adheres to
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.7.0] - 2026-06-10

### Added
- **Test-runner signature registry** (`src/signatures.js`) — the pass/fail
  parser is now a per-toolchain registry (jest/vitest, mocha/ava, pytest, go,
  cargo, tsc, eslint/ruff/mypy, gradle/maven, dotnet, playwright/cypress,
  make/generic) backed by 18 real-output fixtures and a table-driven test.
  Adding your runner is now the canonical first PR.
- **`rl doctor --explain "<output>"`** — paste any test/build output and see
  exactly how it's classified and which toolchain pattern decided. Ambiguous
  output is honestly reported as "left pending".
- **`rl why <file>`** — plain-language answer to "what have we tried here?":
  blocking failures with reasons, walls (same error across attempts),
  retirements with receipts, passes, pendings.

### Fixed
- Error-signature extraction now searches all toolchain pools, so a cargo or
  gradle failure caught by a generic "N failed" count still gets its real
  signature (`panicked at…`, `BUILD FAILED`) instead of a placeholder.

## [0.6.0] - 2026-06-10

### Added
- **Paraphrase notes (dual-channel fingerprinting).** A second, structure-only
  fingerprint (identifiers erased, shape kept) runs when the semantic channel
  finds no match. If an edit is ≥95% structurally identical to a recorded
  failure — the classic sign of the same fix with renamed variables — the hook
  never blocks, but injects a note: "this may be the same fix, renamed."
  Zero added false-block risk; the renamed-repeat blind spot becomes visible.
  (Design from the dual-hash discussion with @evil_robot_jas on Moltbook;
  also addresses @nexaagent's miss-rate question.)
- `rl stats` now reports paraphrase-note counts alongside blocks and warns.

## [0.5.0] - 2026-06-10

### Added
- **Reproducible benchmark** (`npm run bench`) — deterministic 310-case corpus:
  120/120 cosmetically-disguised repeat fixes caught, 0/190 false blocks on
  distinct fixes at the default threshold.
- **`rl stats --card`** — a screenshot-able terminal card of blocked-fix counts.
- **LLM Quickstart** README section so coding agents can self-install the tool.
- Published to npm: `npx regressionledger` now works.

## [0.4.0] - 2026-06-10

### Added
- **`rl unblock <file> [hash-prefix]`** — a granular, human-priced override that
  retires recorded failures when the context genuinely changed (new DB, new
  dependency…). Deliberately explicit: the "it's different this time" claim
  costs one human decision instead of agent confidence. (Raised by
  @evil_robot_jas on Moltbook.)

### Changed
- **Retirement now keeps a receipt.** Superseded failures are no longer deleted
  on a later pass — they are marked `retired` with `retiredBy` (`pass` or
  `human`), a timestamp, and `supersededBy` linking to the passing attempt.
  Auditable in `rl show` as ∅ retired. (Design point from @jarvis-snipara:
  outcome-linked invalidation needs its own provenance.)

## [0.3.0] - 2026-06-10

### Added
- **`rl show --by-error`** — clusters failed attempts by error signature across
  files, surfacing "you keep hitting the same wall from different angles".
  Requested by the community (thanks @jarvisforwise on Moltbook) within hours of
  launch.
- **`rl report`** — a shareable artifact: markdown to stdout, or
  `rl report --html [file]` for a self-contained dark-mode HTML report with
  summary stats, blocked-fix counts, error clusters, and per-file attempt
  timelines. No external resources; all content escaped.

## [0.2.0] - 2026-06-10

Trust-the-guardrail release: evaluate precision on your own codebase before
(and after) enabling hard blocks.

### Added
- **`rl doctor`** — verifies the install end-to-end: environment checks plus
  live hook round-trips through a real child process (a first-time edit must be
  allowed; a seeded repeat failure must be denied).
- **`minFailures` config** (default `1`) — require a fix to have failed N times
  before it blocks; `2` gives an extra-cautious rollout.
- **Hit log** — every block (and every would-have-blocked event in `warn`
  mode) is recorded to `.regressionledger/hits.json`; `rl stats` now reports
  blocked / would-have-blocked counts so warn-mode users can audit precision
  before flipping to `block`.
- Block messages now include how many times the fix has failed.

### Infrastructure
- Installable as a **Claude Code plugin** (`/plugin marketplace add
  anlor1002-alt/regressionledger`) — hooks activate automatically.
- CI across Node 18/20/22 × Linux/macOS/Windows; GitHub Pages landing page;
  demo GIF rendered by CI via VHS.

## [0.1.0] - 2026-06-09

First public release.

### Added
- **PreToolUse hook** that hard-blocks (or warns) when the agent re-applies a
  fix that previously failed, with the reason and prior error attached.
- **PostToolUse** recording of every edit, and outcome linkage from the next
  test/build run (npm, jest/vitest/mocha, pytest, go, cargo, tsc, eslint…).
- **Semantic fingerprint**: normalized token stream with string/number literals
  abstracted (but `true` ≠ `false`); SHA-256 exact match + k-gram Jaccard for
  near-duplicates; heuristic enclosing-symbol extraction.
- **Durable JSON ledger** that survives session restarts and context compaction,
  with concurrency-safe (file-locked) writes and a stale-fix retire-on-pass rule.
- **CLI**: `init`, `show`, `list`, `stats`, `config`, `clear`, and the internal
  `hook` entry point.
- **Zero runtime dependencies**; hooks fail open on any error.
- 35 tests (`node:test`) and a no-Claude doom-loop demo (`npm run demo`).

[Unreleased]: https://github.com/anlor1002-alt/regressionledger/compare/v0.7.0...HEAD
[0.7.0]: https://github.com/anlor1002-alt/regressionledger/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/anlor1002-alt/regressionledger/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/anlor1002-alt/regressionledger/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/anlor1002-alt/regressionledger/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/anlor1002-alt/regressionledger/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/anlor1002-alt/regressionledger/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/anlor1002-alt/regressionledger/releases/tag/v0.1.0
