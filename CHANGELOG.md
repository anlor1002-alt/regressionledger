# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/), and this project adheres to
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.11.0] - 2026-07-10

Launch-day polish: see it, trust it, and leave cleanly.

### Added
- **`rl demo`** — the doom-loop simulation now ships in the package, so
  `npx regressionledger demo` shows the hard block end-to-end in ~30 seconds
  with nothing installed and nothing touched (sandboxed temp dir, real hook
  code paths, self-cleaning). `npm run demo` still works and now shares the
  same implementation.
- **`rl uninstall [--purge]`** — the symmetric exit. Removes exactly the hook
  entries `rl init` added (other hooks, permissions, and settings are never
  touched; events that only held our hooks are dropped cleanly), refuses to
  rewrite an unparseable `settings.json` (same safety rule as `init`), and
  `--purge` also deletes the `.regressionledger/` data directory.
- **`docs/COMPARISON.md`** — "memory recalls, RegressionLedger refuses": an
  honest capability matrix versus memory MCPs, `CLAUDE.md` notes, and
  in-session loop detectors, including what memory tools do *better* and where
  this tool falls short. Linked from the README's FAQ and "How it's different".

### Changed
- README leads with the zero-risk `npx regressionledger demo` and documents
  the escape hatch next to the install instructions.

## [0.10.2] - 2026-06-11

A 46-agent fuzz/review pass reproduced findings against HEAD. Most of its HIGH
findings were already fixed in 0.10.0/0.10.1 (it ran on a 0.9.0 checkout) and
were re-confirmed fixed here; these four genuinely reproduced on HEAD and are
now closed, each with an adversarial test.

### Fixed
- **Cross-toolchain misclassification (false FAIL).** `explainOutcome` applied
  every toolchain's fail patterns to every run, so a passing pytest log
  containing a jest-style "FAIL" banner — or "Retrying 1 failed attempt" prose
  — was recorded as a failure (then a wrongful future block). Classification is
  now **scoped to the runner's own patterns** via the command (the hook passes
  it); an unrecognized signal under a known runner stays pending. pytest's
  loose `N failed` counter is gone (the `==== N failed ====` summary in `fail`
  already covers real failures).
- **`loadHits` crash on a corrupt hits.json.** A valid-JSON-but-not-array
  `hits.json` (e.g. `{}`) crashed `rl stats` / `rl report`. It now coerces to
  `[]`.
- **Markdown report injection.** `rl report` (markdown) embedded ledger
  previews/signatures verbatim; pasted into a PR, a crafted preview could
  inject headings or break code fences. Markdown output now neutralizes
  newlines, backticks, and pipes (the HTML renderer already escaped).

## [0.10.1] - 2026-06-11

Security-review release. An independent security pass (separate from the
correctness gate) flagged five issues; HIGH-1 was already mitigated in 0.10.0
(import neutralization + labeling). The rest are fixed here.

### Security / Fixed
- **HIGH-2 — `rl init` can no longer clobber `settings.json`.** A file that
  existed but failed to parse was previously swallowed (returned `{}`) and then
  overwritten, destroying the user's hooks/permissions/env — contradicting the
  README's "merging, not clobbering". `init` now parses first; an unparseable
  file is backed up to `settings.json.broken-<ts>.bak` and init aborts with a
  clear message instead of writing.
- **MED-3 — ReDoS in the enclosing-symbol regex.** The Java/C# method pattern
  had a nested whitespace quantifier that backtracked super-linearly on long
  whitespace runs (and ran on every edit). Rewritten with bounded, non-nested
  quantifiers; a 5000-space input now resolves in <1ms.
- **MED-4 — CI supply chain pinned.** The demo workflow (which has
  `contents: write`) installed `ttyd` `latest` and `vhs@latest`; both are now
  pinned to explicit versions.
- **LOW-5 — `recordHit` is now throw-proof.** It runs just before a deny is
  returned; a throw there would bubble to the CLI's fail-open catch and
  silently drop the block. Its I/O is now fully swallowed — telemetry must
  never cost a block.

## [0.10.0] - 2026-06-11

The gate-review release. The same community reviewer came back harder — every
finding below shipped with a repro, and they retracted two of their own
accusations when their repros failed. That bar is now codified in
CONTRIBUTING.md ("Release gate — four adversarial questions").

### Fixed
- **P0 — proven-good code is never second-guessed.** Code with a recorded PASS
  (raw channel) previously still received "expect the same failure" notes,
  because old sibling-variant failures collapsed-matched it. Acquittal check
  now silences ALL channels (collapsed and structural) for code that has
  passed.
- **P1 — `minFailures` counts only THIS exact code.** `failCount` previously
  mixed raw-exact and shape-similar failures, so `5000` failing once plus
  `7000` failing once could arm a "failed 2 times" hard block against `5000`.
  The hard-block gate now counts raw-channel failures exclusively.
- **P1 — the ledger lock can no longer be stolen from a live holder.** Lock
  staleness was mtime-based (>10s), so a slow-but-alive writer could have its
  lock stolen mid-write, and its release could then unlink the thief's lock —
  a cascade. Locks now record `{pid, token}`: stealing requires a DEAD holder,
  release only removes a lock carrying our own token, and waiters facing a
  live holder wait 15s before the documented proceed-unlocked last resort.
- **P3 — eviction is by value, not position.** The cap previously kept the
  newest entries regardless of kind, so churn could silently evict still-
  blocking failures. Pass/retired/pending entries are now evicted first.

### Security
- **P2 — imported ledger text is neutralized and labeled.** `rl import` is a
  cross-machine channel; imported `errorSignature`/`preview` previously flowed
  verbatim into briefings and block messages. They are now structurally
  neutralized (control chars stripped, newline structure flattened) at import
  AND at render, and tagged `[imported verdict]` wherever shown. Honest
  framing: this is structural neutralization — content remains data, labeled
  as such; treat shared ledgers like you treat dependencies.

## [0.9.0] - 2026-06-10

The "right to retry" release. A community member cloned the repo, stress-tested
the fingerprint design, and found the flaw our own benchmark was structurally
blind to: collapsing literals meant `timeout: 5000` → `timeout: 30000` shared a
fingerprint — so the tool **hard-blocked legitimate parameter changes** with
"change strategy", actively steering agents away from correct fixes. Worse, the
benchmark's disguise list *defined* literal changes as matches, making its
"0 false blocks" circular. They proposed the fix we shipped. Thank you.

### Changed
- **Hard blocks now require a raw-channel match** (literals intact; only
  whitespace/comments stripped) — i.e., the retry is *the same code, constants
  included*. Changing a constant/string is never denied.
- **Collapsed-only matches** (same shape, different literals) get an advisory
  note and one hearing: "if changing that value IS your hypothesis, proceed —
  this variant gets its own verdict." A variant that fails earns its own
  record; *its* verbatim repeat then hard-blocks.
- **Retire-on-pass is raw-keyed**: the variant that passed does not acquit the
  variant that failed.
- **Batch attribution is disclosed**: when one test run fails N edits at once,
  each record carries `batchSize` and block messages admit the attribution is
  approximate, with an `rl unblock` pointer.
- **Benchmark rewritten in three honest categories**: cosmetic re-applies
  hard-matched 60/60; literal variants routed to note-not-block 40/40 with
  0 wrongly blocked; distinct fixes 0/190 on either channel.
- Legacy ledger entries (no `rawHash`) soft-degrade to advisory notes; newly
  recorded failures regain hard blocks.

## [0.8.1] - 2026-06-10

Hardening release: every fix below came from an independent adversarial review
of v0.6–v0.8, each finding verified by execution before fixing. 9 new
regression tests.

### Fixed
- **Thrash escalation** now evaluates the wall for the signature *just hit* —
  previously one old, larger wall silenced every new wall forever.
- **`rl import` hardened**: strict type validation, field truncation
  (preview/signature), `maxLedger` cap enforcement, and clean errors on
  non-export files. A hostile or hand-edited import can no longer grow an
  unbounded ledger or inject unbounded text into deny messages.
- **Malformed ledger entries can no longer silently disable the guardrail**:
  non-array `tokens` or non-string `intentHash` previously threw inside the
  hook (caught as fail-open ⇒ blocking and briefing silently dead for that
  file). All read paths now guard types.
- **Misclassification regressions from the v0.7.0 registry rewrite**: bare
  `error:` prose in passing runs no longer records a FAIL (rustc form
  `error[E…]:` still does); `mvn dependency:tree` / `gradle --version` no
  longer count as verification runs; prose "ok …"/"200 OK"/"0 passed" no
  longer count as passes; explicit toolchain pass evidence now outranks
  generic fail substrings.
- Restored runners lost in the rewrite: **rspec, phpunit**; added
  **`node --test`** (TAP summary) as a recognized runner.
- Structural channel: minimum shape floor raised 8→15 tokens (guard-clause
  idioms no longer produce misleading paraphrase notes); token cap (3000)
  keeps whole-file Writes from adding seconds of synchronous latency.
- Session briefing: survives malformed entries, fences ledger text as
  historical data, and caps length accounting for JSON escaping.

## [0.8.0] - 2026-06-10

The "Sixth Sense" release — capabilities no other agent tool ships.

### Added
- **Session briefing (SessionStart hook).** Every session start — including
  right after context compaction wipes the agent's memory — injects a compact
  "what already failed here" brief: dead ends per file with error signatures,
  plus walls. Failures get blocked before they're re-conceived, not just
  re-applied. Silent when the ledger is empty.
- **Thrash escalation.** When 3+ *distinct* failed approaches share one error
  signature, the post-test hook escalates: stop editing, state root-cause
  hypotheses, verify one, then fix. Catches the doom loop that identical-fix
  blocking can't.
- **Herd immunity: `rl export` / `rl import`.** Share settled verdicts between
  machines and teammates. Imported failures block locally and stay attributed
  via `importedFrom`. Pendings and duplicates never travel.

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

[Unreleased]: https://github.com/anlor1002-alt/regressionledger/compare/v0.10.2...HEAD
[0.10.2]: https://github.com/anlor1002-alt/regressionledger/compare/v0.10.1...v0.10.2
[0.10.1]: https://github.com/anlor1002-alt/regressionledger/compare/v0.10.0...v0.10.1
[0.10.0]: https://github.com/anlor1002-alt/regressionledger/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/anlor1002-alt/regressionledger/compare/v0.8.1...v0.9.0
[0.8.1]: https://github.com/anlor1002-alt/regressionledger/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/anlor1002-alt/regressionledger/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/anlor1002-alt/regressionledger/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/anlor1002-alt/regressionledger/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/anlor1002-alt/regressionledger/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/anlor1002-alt/regressionledger/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/anlor1002-alt/regressionledger/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/anlor1002-alt/regressionledger/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/anlor1002-alt/regressionledger/releases/tag/v0.1.0
