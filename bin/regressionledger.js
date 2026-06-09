#!/usr/bin/env node
import { main } from '../src/cli.js';

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code ?? 0;
  })
  .catch((err) => {
    // Top-level safety net. For hook invocations we still exit 0 (fail open);
    // for normal CLI use, surface the error.
    if ((process.argv[2] || '').toLowerCase() === 'hook') {
      process.exitCode = 0;
    } else {
      console.error(err && err.stack ? err.stack : err);
      process.exitCode = 1;
    }
  });
