// A self-contained, no-Claude-needed simulation of the doom loop RegressionLedger
// breaks. Run it with:  npm run demo
//
// It plays out the exact scenario from the research: an agent re-applying a fix
// that already failed in an earlier session, and shows the hard block firing.

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handlePreToolUse, handlePostToolUse } from '../src/hooks.js';
import { color } from '../src/util.js';

const FIX = 'return res.status(401).json({ ok: false });';

function setup() {
  const cwd = mkdtempSync(join(tmpdir(), 'rl-demo-'));
  mkdirSync(join(cwd, 'src'), { recursive: true });
  const file = join(cwd, 'src', 'auth.js');
  writeFileSync(cwd + '/src/auth.js', `function login(req) {\n  ${FIX}\n}\n`);
  return { cwd, file };
}

const edit = (cwd, file, code, session) => ({
  tool_name: 'Edit',
  cwd,
  session_id: session,
  tool_input: { file_path: file, old_string: 'return next();', new_string: code },
});
const bash = (cwd, text, session) => ({
  tool_name: 'Bash',
  cwd,
  session_id: session,
  tool_input: { command: 'npm test' },
  tool_response: { text },
});

const line = () => console.log(color.gray('─'.repeat(64)));
const step = (n, t) => console.log(`\n${color.bold(color.cyan(`▶ ${n}`))} ${t}`);

const { cwd, file } = setup();

console.log(color.bold('\n  RegressionLedger — doom-loop simulation\n'));
console.log(color.dim('  Scenario: the auth test is red. An agent keeps trying the same patch.'));
line();

step('Session 1', 'Agent applies a fix to login()…');
handlePostToolUse(edit(cwd, file, FIX, 'session-1'));
console.log(`  ${color.dim('edit:')} ${FIX}`);

step('Session 1', 'Runs the tests…');
handlePostToolUse(bash(cwd, 'Tests: 1 failed, 0 passed\nAssertionError: expected 200, got 401', 'session-1'));
console.log(`  ${color.red('✗ FAIL')} ${color.dim('AssertionError: expected 200, got 401')}`);
console.log(color.dim('  → RegressionLedger silently records this fix as FAILED.'));

console.log(color.dim('\n  …context window fills up. New session. The agent has forgotten everything.'));

step('Session 2', 'Agent confidently proposes a fix — the SAME one as before:');
console.log(`  ${color.dim('edit:')} ${FIX}`);

const guarded = handlePreToolUse(edit(cwd, file, FIX, 'session-2'));
line();
if (guarded.json?.hookSpecificOutput?.permissionDecision === 'deny') {
  console.log(`${color.red(color.bold('  ⛔ BLOCKED'))} before it could waste another test cycle:\n`);
  const reason = guarded.json.hookSpecificOutput.permissionDecisionReason;
  console.log(
    reason
      .split('. ')
      .map((s) => '   ' + s.trim())
      .join('.\n')
  );
} else {
  console.log(color.yellow('  (no block — unexpected in this demo)'));
}
line();
console.log(
  color.green('\n  Without RegressionLedger:') +
    color.dim(' the agent re-applies it, tests fail again, credits burn.')
);
console.log(
  color.green('  With RegressionLedger:   ') +
    color.dim(' the loop is cut on the first repeat, with the reason attached.\n')
);
