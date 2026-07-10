# Memory recalls. RegressionLedger refuses.

The most common question about RegressionLedger: *"How is this different from
a memory MCP / lessons-learned file / loop detector?"* Fair question — here is
the honest answer, including what those tools do better.

## The one-sentence difference

> Advisory memory is text the model **may** ignore; a `PreToolUse` deny is a
> decision it **cannot** ignore — and RegressionLedger only issues that deny
> when a real test run proved this exact fix already failed.

Everything else follows from two design choices: **enforcement** (a hard block
in the tool-call path, not a note in the context) and **outcome linkage**
(every remembered fix carries the verdict of the test/build run that judged
it, not a vibe about what "seemed wrong").

## Capability matrix

| Capability | `CLAUDE.md` notes | Memory layers / memory MCPs | In-session loop detectors | **RegressionLedger** |
| --- | :---: | :---: | :---: | :---: |
| Survives session restarts | ✓ | ✓ | ✗ | ✓ |
| Survives context compaction | ✓ | ✓ | ✗ | ✓ |
| Knows whether a fix **passed or failed** | ✗ | ✗¹ | ✗ | ✓ |
| Matches a retried fix despite cosmetic changes | ✗ | ✗ | ✗² | ✓ |
| Can **refuse** the action (not just advise) | ✗ | ✗ | varies | ✓ |
| Self-retires when the "failed" fix later passes | ✗ | ✗ | ✗ | ✓ |
| Zero dependencies, no server, no API key | ✓ | ✗³ | ✓ | ✓ |
| Auditable receipts (`rl why`, retirement trail) | ✗ | ✗ | ✗ | ✓ |

¹ Memory layers store what the model *chose to write down* — impressions, not
verdicts. Nothing links a remembered "lesson" to the test run that would prove
or disprove it.
² Loop detectors typically hash the exact tool call; rename a variable or
reflow whitespace and the "loop" disappears.
³ Most memory MCPs run a server process; several call embedding APIs.

## What memory tools do better (use both)

RegressionLedger is **not** a memory system, and doesn't try to be:

- It remembers exactly one thing: *fix attempts and their verdicts*. It will
  never store your architecture decisions, conventions, or preferences —
  `CLAUDE.md` and memory MCPs are the right home for those.
- Advisory context is the right tool when the model *should* weigh a lesson
  against new information. A hard block is only right when re-trying is
  provably wasteful — which is why RegressionLedger only hard-blocks on a
  **verbatim** raw-channel match of a fix a test run marked as failed, and
  merely annotates everything softer.

Run a memory layer for wisdom. Run RegressionLedger for the one category of
mistake where "please remember this" demonstrably isn't enough.

## Where RegressionLedger falls short (honesty section)

- It's a lexer, not a parser: a *restructured-but-equivalent* patch can slip
  under the similarity threshold (tree-sitter AST mode is roadmapped, opt-in).
- Attribution is per test run: when one run settles several edits, blame is
  approximate and the block message says so (`batchSize` disclosure).
- v1 ships for Claude Code's hook surface; other harnesses are on the roadmap.

If you can break the matching, please do — the deterministic benchmark
(`npm run bench`) and an issue with your counterexample make the tool better.
