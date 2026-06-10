// The test-runner signature registry. Each toolchain declares:
//   commands   — regexes that mark a Bash command as a verification run
//   fail       — regexes that prove the run FAILED
//   failCounts — regexes whose first capture group is a failure count (>0 = fail)
//   pass       — regexes that prove the run PASSED
//   signatures — regexes whose first match line becomes the stored error signature
//
// detectOutcome() checks fail evidence before pass evidence, toolchain by
// toolchain, then falls back to GENERIC. Adding support for a new test runner
// is the canonical first contribution: add a toolchain entry plus a fixture in
// test/fixtures/ and a row in test/outcome-fixtures.test.js.

export const TOOLCHAINS = [
  {
    name: 'jest/vitest',
    commands: [
      /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b/i,
      /\bnpx?\s+(?:jest|vitest)\b/i,
      /\b(?:jest|vitest)\b/i,
    ],
    fail: [/(^|\n)\s*FAIL\s/, /\bTests?:.*?[1-9]\d*\s+failed/i],
    failCounts: [/(\d+)\s+failed\b/i, /(\d+)\s+failing\b/i],
    pass: [/(^|\n)\s*PASS\s/, /\bTests?:.*?\b0 failed/i, /\b[1-9]\d*\s+passed\b/i, /\b[1-9]\d*\s+passing\b/i],
    signatures: [
      /^.*\b(?:AssertionError|TypeError|ReferenceError|SyntaxError|RangeError)\b.*$/m,
      /^.*\bExpected\b.*$/m,
      /^.*●.*$/m,
    ],
  },
  {
    name: 'mocha/ava',
    commands: [/\b(?:mocha|ava)\b/i],
    fail: [],
    failCounts: [/(\d+)\s+failing\b/i],
    pass: [/\b\d+\s+passing\b/i],
    signatures: [/^.*\bAssertionError\b.*$/m, /^\s+\d+\)\s.*$/m],
  },
  {
    name: 'pytest',
    commands: [/\bpytest\b/i, /\bpython\d?\s+-m\s+(?:pytest|unittest)\b/i, /\btox\b|\bnox\b/i],
    fail: [/Traceback \(most recent call last\)/, /=+\s*\d+\s+failed/i, /(^|\n)FAILED\b/],
    failCounts: [/(\d+)\s+failed\b/i, /(\d+)\s+error(?:s)?\s*=/i],
    pass: [/=+\s*\d+\s+passed[^=]*=+/i, /^OK(\s*\(\d+ tests?[^)]*\))?\s*$/m],
    signatures: [
      /^.*\b(?:AssertionError|ValueError|KeyError|AttributeError|TypeError|IndexError)\b.*$/m,
      /^E\s+.*$/m,
    ],
  },
  {
    name: 'go',
    commands: [/\bgo\s+(?:test|build|vet)\b/i],
    fail: [/(^|\n)-+\s*FAIL\b/i, /(^|\n)FAIL\b/],
    failCounts: [],
    pass: [/(^|\n)ok\s+\S+\s+[\d.]+m?s/, /(^|\n)PASS\b/],
    signatures: [/^.*--- FAIL: .*$/m, /^.*\.go:\d+:.*$/m, /^.*panic:.*$/m],
  },
  {
    name: 'cargo',
    commands: [/\bcargo\s+(?:test|build|check|clippy)\b/i],
    // NOTE: deliberately NOT a bare `error:` — passing test runs commonly log
    // lines like "console.error / error: connection retry"; only rustc's
    // coded form proves a failure.
    fail: [/test result:\s*FAILED/i, /(^|\n)error\[E\d+\]:/, /(^|\n)\s*panic(ked at|:)/],
    failCounts: [/(\d+)\s+failed[;,]/i],
    pass: [/test result:\s*ok\b/i, /Compiling.*Finished/s],
    signatures: [/^.*error(\[E\d+\])?:.*$/m, /^.*panicked at.*$/m],
  },
  {
    name: 'tsc',
    commands: [/\btsc\b/i, /\b(?:npm|pnpm|yarn)\s+run\s+(?:typecheck|check)\b/i],
    fail: [/\berror\s+TS\d+\b/i],
    failCounts: [/Found\s+(\d+)\s+errors?/i],
    pass: [/Found 0 errors/i],
    signatures: [/^.*error TS\d+:.*$/m],
  },
  {
    name: 'eslint/lint',
    commands: [/\beslint\b/i, /\b(?:npm|pnpm|yarn)\s+run\s+lint\b/i, /\b(?:ruff|flake8|pylint|mypy)\b/i],
    fail: [/\(\s*[1-9]\d*\s+errors?\b/i],
    failCounts: [/\((\d+)\s+errors?\b/i, /(\d+)\s+errors?\s+found/i],
    pass: [/\b0 problems\b/i, /\(0 errors\b/i, /All checks passed/i, /Success: no issues/i],
    signatures: [/^.*error\s{2,}.*$/m, /^.*:\d+:\d+:?\s+(?:error|E\d+).*$/m],
  },
  {
    name: 'gradle/maven',
    // Gated on test/build goals: "mvn dependency:tree" prints BUILD SUCCESS
    // too, and must not resolve pending attempts as passes.
    commands: [/(?:\b(?:gradle|mvn)\b|\.\/(?:gradlew|mvnw)\b).*\b(?:test|build|verify|check|package)\b/i],
    fail: [/BUILD\s+FAIL(?:ED|URE)/i, /Compilation (?:failed|error)/i],
    failCounts: [/Tests?\s+run:.*?Failures:\s*(\d+)/i],
    pass: [/BUILD\s+SUCCESS(?:FUL)?/i],
    signatures: [/^.*(?:FAILED|error:).*$/m],
  },
  {
    name: 'dotnet',
    commands: [/\bdotnet\s+(?:test|build)\b/i],
    fail: [/Build\s+FAILED/i, /(^|\n)\s*Failed!/],
    failCounts: [/Failed:\s*(\d+)/i, /(\d+)\s+Error\(s\)/i],
    pass: [/Build succeeded/i, /(^|\n)\s*Passed!/],
    signatures: [/^.*error\s+CS\d+.*$/m, /^.*\[FAIL\].*$/m],
  },
  {
    name: 'playwright/cypress',
    commands: [/\bnpx?\s+(?:playwright|cypress)\b/i, /\bplaywright\s+test\b/i],
    fail: [],
    failCounts: [/(\d+)\s+failed\b/i],
    pass: [/\b[1-9]\d*\s+passed\b/i, /All specs passed/i],
    signatures: [/^.*Error:.*$/m, /^\s+\d+\)\s.*$/m],
  },
  {
    name: 'node-test',
    commands: [/\bnode\s+--test\b/i],
    fail: [/(^|\n)#\s*fail\s+[1-9]\d*/],
    failCounts: [],
    pass: [/(^|\n)#\s*fail\s+0\b/],
    signatures: [/^.*\bAssertionError\b.*$/m, /^not ok .*$/m],
  },
  {
    name: 'rspec/phpunit',
    commands: [/\brspec\b/i, /\bphpunit\b/i, /\bbundle\s+exec\s+rspec\b/i],
    fail: [/(^|\n)Failures:/],
    failCounts: [/(\d+)\s+failures?\b/i, /Failures:\s*(\d+)/i],
    pass: [/\b\d+\s+examples?,\s+0\s+failures/i, /OK \(\d+ tests?/i],
    signatures: [/^.*Failure\/Error:.*$/m, /^.*\bExpected\b.*$/m],
  },
  {
    name: 'make/generic-build',
    commands: [/\bmake\s+(?:test|check|build|verify|lint)\b/i, /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?build\b/i],
    fail: [/\bexit code:?\s*[1-9]\d*\b/i, /(^|\n)make: \*\*\*.*Error \d+/],
    failCounts: [],
    pass: [/\bexit code:?\s*0\b/i],
    signatures: [/^.*Error \d+.*$/m, /^.*error:.*$/m],
  },
];

// Cross-toolchain fallbacks, applied when no toolchain produced a verdict.
export const GENERIC = {
  fail: [
    /Traceback \(most recent call last\)/,
    /\bAssertionError\b/,
    /BUILD\s+FAIL(?:ED|URE)/i,
    /\bexit code:?\s*[1-9]\d*\b/i,
  ],
  failCounts: [/(\d+)\s+(?:tests?\s+)?fail(?:ed|ing)\b/i],
  pass: [/\b[1-9]\d*\s+passing\b/i, /\b[1-9]\d*\s+passed\b/i, /\bexit code:?\s*0\b/i, /\b0 problems\b/i],
  signatures: [
    /^.*\b(?:AssertionError|TypeError|ReferenceError|SyntaxError|ValueError|KeyError|NullPointerException)\b.*$/m,
    /^.*\bFAIL\b.*$/m,
    /^.*\berror(?:\[E\d+\])?:.*$/m,
    /^.*\bExpected\b.*$/m,
  ],
};
