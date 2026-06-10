// Public, programmatic surface — handy for tests and for embedding the engine
// in other tools.
export { tokenize, extractSymbol, fingerprint, structureTokens } from './fingerprint.js';
export { tokenSimilarity, shingles, jaccard } from './similarity.js';
export { isVerificationCommand, detectOutcome } from './outcome.js';
export {
  resolveRoot,
  getPaths,
  loadConfig,
  saveConfig,
  loadLedger,
  saveLedger,
  addAttempt,
  resolvePending,
  findSimilarFailure,
  recordHit,
  loadHits,
  unblockAttempts,
  summarize,
  DEFAULT_CONFIG,
} from './ledger.js';
export { handlePreToolUse, handlePostToolUse, handleSessionStart, extractEdits } from './hooks.js';
export { buildBriefing, detectThrashWall } from './briefing.js';
export { init, buildHookConfig, binPath } from './install.js';
export { runDoctor } from './doctor.js';
export { groupByError, buildReportData, renderMarkdown, renderHtml } from './report.js';
