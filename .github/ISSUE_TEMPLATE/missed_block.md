---
name: "Missed block (it should have blocked)"
about: A previously-failed fix was re-applied and RegressionLedger did not stop it
title: "[missed-block] "
labels: ["false-negative"]
---

**The repeated fix**
The change that was applied more than once after failing.

**How it failed the first time**
The test/build command that ran and its (paraphrased) output.

**What `rl show <file>` shows**
Paste the relevant attempt history.

**Environment**
- OS:
- Node version (`node --version`):
- Test runner / build command used:
- `rl config` output:
