---
name: "False block (it blocked a good edit)"
about: RegressionLedger denied an edit that was NOT a repeat of a failed fix
title: "[false-block] "
labels: ["false-positive"]
---

**What got blocked**
The block message you saw (`permissionDecisionReason`), or the output of:

```
rl show <file>
```

**The edit it blocked**
The code change you were trying to make (the new content).

**Why it was actually fine**
Why this edit is genuinely different from the earlier failed attempt.

**Environment**
- OS:
- Node version (`node --version`):
- `rl config` output:
- Language/file extension involved:
