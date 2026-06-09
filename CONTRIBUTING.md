# Contributing to RegressionLedger

Thanks for helping break the doom loop. The codebase is small, dependency-free,
and deliberately easy to reason about.

## Getting started

```bash
git clone https://github.com/your-handle/regressionledger
cd regressionledger
npm test        # runs node:test — no install step, no dependencies
npm run demo    # the doom-loop simulation
```

There is no build. It's plain ESM that runs on Node ≥ 18.

## Layout

```
bin/regressionledger.js   CLI entry (also the hook entry: `rl hook <event>`)
src/
  fingerprint.js   tokenizer + normalizer + enclosing-symbol extraction
  similarity.js    k-gram shingles + Jaccard
  outcome.js       detect test/build commands and parse pass/fail + signature
  ledger.js        the JSON attempt store and its queries
  hooks.js         PreToolUse / PostToolUse logic (the glue)
  install.js       `rl init` — merges hooks into .claude/settings.json
  cli.js           command dispatch + `rl show` rendering
test/              one *.test.js per module
demo/simulate.js   no-Claude-needed walkthrough
```

## Great first PRs

- **Add a language to the tokenizer.** `src/fingerprint.js` maps file extensions
  to comment styles (`HASH_COMMENT`, `DASH_COMMENT`) and has `DECL_PATTERNS` for
  finding the enclosing symbol. Add your language and a test in
  `test/fingerprint.test.js`.
- **Teach the outcome parser a new test runner.** `src/outcome.js` holds
  `VERIFY_PATTERNS` (is this a verification command?) and the fail/pass markers.
  Add patterns + a case in `test/outcome.test.js`.
- **Tune similarity.** If you find a real-world false positive or false negative,
  capture it as a test first, then adjust `similarity.js` / the threshold.

## Ground rules

- **Stay dependency-free.** The zero-install promise is a feature. If something
  truly needs a dependency, open an issue to discuss before adding it.
- **Hooks must fail open.** A guardrail that crashes the agent is worse than no
  guardrail. Any new hook path must be wrapped so an internal error never breaks
  the tool call (`rl hook` already does this at the top level).
- **Add a test for every behavior change.** `npm test` must stay green.
- **Keep stdout clean in hook mode.** Only the JSON response may go to stdout;
  everything else goes to stderr behind `RL_DEBUG`.

## Reporting bugs

Include the smallest edit + test output that reproduces a wrong block (or a
missed one). The fingerprint and outcome parser are heuristic by design, and
concrete cases are the best way to improve them.
