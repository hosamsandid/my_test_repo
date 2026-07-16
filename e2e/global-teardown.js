// Playwright global teardown for the AEE E2E suite (#666, docs/e2e-testing-concept.md §5).
//
// Delegates to scripts/stack-down.sh (the same script `make e2e-down` runs):
// `compose -p aee-e2e down -v` plus removal of the orchestrator-spawned agent
// containers/volumes that compose never sees. Skipped when E2E_SKIP_STACK=1
// (the stack is owned by `make e2e-up`, so leave it running for the next run).
const { execFileSync } = require('child_process');
const path = require('path');

module.exports = async () => {
  if (process.env.E2E_SKIP_STACK === '1') {
    console.log('[global-teardown] E2E_SKIP_STACK=1 — leaving the stack running');
    return;
  }
  console.log('[global-teardown] tearing down the aee-e2e stack …');
  execFileSync(path.join(__dirname, 'scripts', 'stack-down.sh'), {
    stdio: 'inherit',
  });
};
