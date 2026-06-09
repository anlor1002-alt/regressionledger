# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/), and this project adheres to
[Semantic Versioning](https://semver.org/).

## [Unreleased]

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

[Unreleased]: https://github.com/anlor1002-alt/regressionledger/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/anlor1002-alt/regressionledger/releases/tag/v0.1.0
