'use strict';

// Budget guard for the repo-root CLAUDE.md.
//
// CLAUDE.md is auto-loaded into every agent's context on EVERY run (and into
// Claude Code's context whenever anyone works in this repo). Because cache-read
// re-reads the full prefix at each step of the agentic loop, and there are
// several invocations per work item, every KB here is a RECURRING token cost
// multiplied across every run. The file grew unchecked to ~439 KB (~110k tokens)
// as an append-only, ticket-by-ticket decision log before it was rewritten as a
// lean ~35 KB high-level map — this guard keeps it that way.
//
// The rule the file's own preamble states: it is a MAP. Deep specs belong under
// docs/, ticket-level decision history in git. If CLAUDE.md legitimately needs
// to grow past the budget, move detail out first — raise CLAUDE_MD_BUDGET_BYTES
// only as a deliberate, reviewed decision, never just to turn a red build green.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// Hard ceiling in bytes (~= `wc -c CLAUDE.md`). ~7x smaller than the 439 KB
// append-only log it replaced, with generous headroom over the ~35 KB lean
// rewrite so ordinary map edits don't trip it. ~15k tokens is still a lot of
// fixed prefix; treat approaching it as a signal to prune, not to raise it.
const CLAUDE_MD_BUDGET_BYTES = 60_000;

const CLAUDE_MD = path.join(__dirname, '..', 'CLAUDE.md');

test('repo-root CLAUDE.md stays within its token budget', () => {
  const bytes = fs.statSync(CLAUDE_MD).size;
  assert.ok(
    bytes <= CLAUDE_MD_BUDGET_BYTES,
    `CLAUDE.md is ${bytes} bytes (~${Math.round(bytes / 4)} tokens), over the `
      + `${CLAUDE_MD_BUDGET_BYTES}-byte budget. It is loaded into every agent's `
      + `context on every run, so this is a recurring cost. Move deep detail to `
      + `docs/ and ticket-level history to git rather than raising the budget.`,
  );
});
