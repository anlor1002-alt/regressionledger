// Kept for `npm run demo`; the real implementation ships in the package so
// `npx regressionledger demo` works without cloning. See src/demo.js.

import { runDemo } from '../src/demo.js';

process.exitCode = runDemo();
