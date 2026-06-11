// Turns a chunk of changed code into a stable "fix intent" fingerprint:
//   - a normalized token stream (whitespace/comments stripped, string & number
//     literals abstracted) so cosmetically-different edits with the same intent
//     collide, while genuinely different edits do not;
//   - a SHA-256 of that stream for O(1) exact-match lookup;
//   - the name of the enclosing symbol the edit lives in.
//
// This is a deterministic, language-aware-ish lexer — NOT a full parser. It is
// intentionally dependency-free (no tree-sitter) so the package installs and
// runs anywhere with zero native builds. See README "Roadmap" for the AST path.

import { extname } from 'node:path';
import { sha256 } from './util.js';

// Multi-character operators, longest first so we match greedily.
const OPERATORS = [
  '>>>=', '...', '===', '!==', '**=', '<<=', '>>=', '&&=', '||=', '??=',
  '>>>', '<=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '::', '->',
  '=>', '++', '--', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '>>',
  '<<', '**', ':=',
].sort((a, b) => b.length - a.length);

const reNumber =
  /(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(?:\d[\d_]*)(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)[a-zA-Z]*/y;
const reIdent = /[A-Za-z_$][A-Za-z0-9_$]*/y;

const HASH_COMMENT = new Set([
  'py', 'rb', 'sh', 'bash', 'zsh', 'fish', 'yml', 'yaml', 'toml', 'r',
  'pl', 'ps1', 'tf', 'dockerfile', 'makefile', 'mk', 'ex', 'exs', 'nim', 'cr', 'jl',
]);
const DASH_COMMENT = new Set(['sql', 'lua', 'hs', 'elm', 'adb', 'ads']);

function commentConfig(ext) {
  if (HASH_COMMENT.has(ext)) return { line: ['#'], block: [], triple: true };
  if (DASH_COMMENT.has(ext)) {
    return { line: ['--'], block: ext === 'lua' ? [['--[[', ']]']] : [], triple: false };
  }
  // Default: C-family + unknown. '#' is left alone (JS private fields, C macros).
  return { line: ['//'], block: [['/*', '*/']], triple: false };
}

const STR = '"STR"';
const NUM = '"NUM"';
const ID = '"ID"';

// Keywords kept verbatim in the STRUCTURAL channel (identifiers are erased
// there, but control flow / declaration words carry real shape information).
const STRUCT_KEYWORDS = new Set([
  // js/ts
  'function', 'return', 'if', 'else', 'for', 'while', 'do', 'switch', 'case',
  'break', 'continue', 'const', 'let', 'var', 'class', 'new', 'try', 'catch',
  'finally', 'throw', 'async', 'await', 'yield', 'import', 'export', 'default',
  'typeof', 'instanceof', 'in', 'of', 'delete', 'void', 'this', 'super',
  'true', 'false', 'null', 'undefined',
  // python
  'def', 'elif', 'except', 'raise', 'lambda', 'pass', 'with', 'as', 'from',
  'not', 'and', 'or', 'is', 'None', 'True', 'False', 'global', 'nonlocal',
  // go / rust / java-ish
  'func', 'fn', 'pub', 'struct', 'enum', 'impl', 'match', 'defer', 'go',
  'chan', 'select', 'static', 'final', 'public', 'private', 'protected',
]);

/**
 * Collapse identifiers in a normalized token stream to an ID sentinel,
 * keeping keywords, operators, punctuation, and the STR/NUM sentinels.
 * The result is the "shape" of the code — renaming variables can't change it.
 */
export function structureTokens(tokens) {
  return tokens.map((t) => {
    if (t === STR || t === NUM) return t;
    if (STRUCT_KEYWORDS.has(t)) return t;
    if (/^[A-Za-z_$]/.test(t)) return ID;
    return t;
  });
}

/**
 * Lex `code` into a normalized token array. String and number literals collapse
 * to the sentinels STR/NUM; identifiers and operators are kept verbatim.
 * With `keepLiterals`, the actual literal lexemes are kept instead — this is
 * the RAW channel: two snippets share it only when they are the same code
 * modulo whitespace and comments, constants included.
 */
export function tokenize(code, ext = '', keepLiterals = false) {
  const cfg = commentConfig(ext);
  const tokens = [];
  const n = code.length;
  let i = 0;

  const startsWith = (s) => code.startsWith(s, i);

  while (i < n) {
    const c = code[i];

    // whitespace
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n' || c === '\f' || c === '\v') {
      i++;
      continue;
    }

    // line comments
    let matchedComment = false;
    for (const lc of cfg.line) {
      if (startsWith(lc)) {
        const nl = code.indexOf('\n', i);
        i = nl === -1 ? n : nl;
        matchedComment = true;
        break;
      }
    }
    if (matchedComment) continue;

    // block comments
    for (const [open, close] of cfg.block) {
      if (startsWith(open)) {
        const end = code.indexOf(close, i + open.length);
        i = end === -1 ? n : end + close.length;
        matchedComment = true;
        break;
      }
    }
    if (matchedComment) continue;

    // triple-quoted strings (python-style)
    if (cfg.triple && (startsWith('"""') || startsWith("'''"))) {
      const q = code.slice(i, i + 3);
      const start = i;
      const end = code.indexOf(q, i + 3);
      i = end === -1 ? n : end + 3;
      tokens.push(keepLiterals ? code.slice(start, i) : STR);
      continue;
    }

    // strings: ' " `  (with escape handling)
    if (c === '"' || c === "'" || c === '`') {
      const start = i;
      i++;
      while (i < n) {
        if (code[i] === '\\') {
          i += 2;
          continue;
        }
        if (code[i] === c) {
          i++;
          break;
        }
        i++;
      }
      tokens.push(keepLiterals ? code.slice(start, i) : STR);
      continue;
    }

    // numbers
    reNumber.lastIndex = i;
    const numMatch = reNumber.exec(code);
    if (numMatch && numMatch.index === i) {
      tokens.push(keepLiterals ? numMatch[0] : NUM);
      i = reNumber.lastIndex;
      continue;
    }

    // identifiers / keywords
    reIdent.lastIndex = i;
    const idMatch = reIdent.exec(code);
    if (idMatch && idMatch.index === i) {
      tokens.push(idMatch[0]);
      i = reIdent.lastIndex;
      continue;
    }

    // operators (multi-char, greedy) then single punctuation
    let op = null;
    for (const candidate of OPERATORS) {
      if (startsWith(candidate)) {
        op = candidate;
        break;
      }
    }
    if (op) {
      tokens.push(op);
      i += op.length;
      continue;
    }

    tokens.push(c);
    i++;
  }

  return tokens;
}

// Declaration patterns for locating the enclosing symbol. Order matters: more
// specific forms first. Each captures the symbol name in group 1.
const DECL_PATTERNS = [
  /^\s*(?:export\s+)?(?:default\s+)?(?:public\s+|private\s+|protected\s+|static\s+|final\s+|async\s+)*function\s*\*?\s*([A-Za-z_$][\w$]*)/,
  /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
  /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/,
  /^\s*def\s+([A-Za-z_$][\w$]*)/, // python / ruby
  /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_$][\w$]*)/, // go
  /^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_$][\w$]*)/, // rust
  // java/c# method. Modifiers are matched once (no nested whitespace
  // quantifier), and the return-type run excludes whitespace to avoid the
  // catastrophic backtracking the old `(?:…|\s)+[\w<>\[\],.\s]+?` form caused
  // on long whitespace runs (ReDoS — found in a security review).
  /^\s*(?:(?:public|private|protected|static|final|synchronized)\s+){1,5}[\w<>\[\],.]+\s+([A-Za-z_$][\w$]*)\s*\([^;{]*\)\s*\{/, // java/c# method
  /^\s*(?:export\s+)?(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/, // bare method() {
  /^\s*([A-Za-z_$][\w$]*)\s*[:=]\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>)/, // obj prop / fn assignment
];

const FILE_SCOPE = '(file scope)';

// Control-flow / keyword "names" that some declaration patterns would otherwise
// capture (e.g. an edit inside `if (x) {`). Never treat these as a symbol.
const NOT_A_SYMBOL = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'do', 'else', 'try',
  'finally', 'with', 'await', 'yield', 'throw', 'case', 'function', 'class',
  'const', 'let', 'var', 'def', 'func', 'fn', 'new',
]);

/**
 * Find the name of the symbol that encloses `anchor` within `fileContent`, by
 * scanning upward from the anchor for the nearest declaration line. Heuristic:
 * returns the nearest *preceding* declaration, which is correct for the common
 * "edit inside a function" case. Returns "(file scope)" when nothing matches.
 */
export function extractSymbol(fileContent, anchor) {
  if (!fileContent) return FILE_SCOPE;
  let idx = anchor ? fileContent.indexOf(anchor) : -1;
  // A Write of the whole file (anchor === fileContent) or an unfound anchor
  // both mean "no specific region" — treat as file scope.
  if (idx === -1 || anchor === fileContent) return FILE_SCOPE;

  const lines = fileContent.split('\n');
  let lineNo = 0;
  let acc = 0;
  for (let l = 0; l < lines.length; l++) {
    acc += lines[l].length + 1; // +1 for the '\n'
    if (acc > idx) {
      lineNo = l;
      break;
    }
  }

  for (let l = lineNo; l >= 0; l--) {
    for (const pat of DECL_PATTERNS) {
      const m = pat.exec(lines[l]);
      if (m && m[1] && !NOT_A_SYMBOL.has(m[1])) return m[1];
    }
  }
  return FILE_SCOPE;
}

/**
 * Compute the full fingerprint of a change.
 *  - intentHash/tokens: the COLLAPSED channel (literals abstracted) — used for
 *    similarity and the ambiguous "same shape, different constants" signal.
 *  - rawHash: the RAW channel (literals intact, whitespace/comments stripped) —
 *    the only channel allowed to HARD-BLOCK, because matching here proves the
 *    retry is byte-equivalent code, not a legitimate parameter change.
 * @param {{filePath:string, changedCode:string, fileContent?:string, anchor?:string}} args
 * @returns {{symbol:string, intentHash:string, rawHash:string, tokens:string[]}}
 */
export function fingerprint({ filePath, changedCode, fileContent, anchor }) {
  const ext = extname(filePath || '').replace('.', '').toLowerCase();
  const tokens = tokenize(changedCode || '', ext);
  const intentHash = sha256(tokens.join(' '));
  const rawHash = sha256(tokenize(changedCode || '', ext, true).join(' '));
  const symbol = extractSymbol(
    fileContent != null ? fileContent : changedCode || '',
    anchor != null ? anchor : changedCode || ''
  );
  return { symbol, intentHash, rawHash, tokens };
}
