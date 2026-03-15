// CJS entry point for GitHub Actions node20 runtime.
// The runner loads the main file via require(), so this
// must be CommonJS. It dynamically imports the ESM module,
// which executes main() as a side effect on load.

import('./src/run.mjs').catch((err) => {
  console.error(`Fatal error: ${err.message}`);
  process.exit(1);
});
