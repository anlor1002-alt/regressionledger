// Public, programmatic surface — handy for tests and for embedding the engine
// in other tools.
export { tokenize, extractSymbol, fingerprint } from './fingerprint.js';
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
  summarize,
  DEFAULT_CONFIG,
} from './ledger.js';
export { handlePreToolUse, handlePostToolUse, extractEdits } from './hooks.js';
export { init, buildHookConfig, binPath } from './install.js';
