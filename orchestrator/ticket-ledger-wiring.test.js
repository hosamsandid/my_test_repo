'use strict';

// Source-reading wiring guard for the ticket ledger (#2115).
//
// The pure core is golden-fixture tested; what those tests cannot see is whether
// the endpoint actually calls it, whether the sweep fetches the PR truth the
// whole feature exists for, and whether the console proxy gates the way its
// neighbour does. `orchestrator.js` boots two listeners on require and api.js
// three, so neither can be imported here — the same constraint that made
// `admission-control-wiring.test.js` a source read (#651).
//
// Discipline carried over from #2113/#2114:
//   * every check is a NAMED function taking the source as a parameter, so the
//     mutation proof re-runs the very same check against a sabotaged copy —
//     asserting only that a substitution CHANGED the source proves nothing;
//   * every mutation anchor is asserted to occur EXACTLY ONCE before it is
//     substituted, or the sabotage silently lands in a neighbouring function and
//     the guard passes for the wrong reason.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ORCH = fs.readFileSync(path.join(__dirname, 'orchestrator.js'), 'utf8');
const API = fs.readFileSync(
  path.join(__dirname, '..', 'admin-console', 'api', 'api.js'),
  'utf8',
);
const SWEEP = fs.readFileSync(path.join(__dirname, 'ticket-reconcile-sweep.js'), 'utf8');

// The body of `computeTeamTicketLedger`, brace-matched from its declaration so a
// check cannot accidentally read `computeTeamFlowAnomalies` or the admission
// sweep that neighbours it.
function ledgerFnBody(src) {
  const start = src.indexOf('async function computeTeamTicketLedger(');
  assert.notStrictEqual(start, -1, 'computeTeamTicketLedger is gone');
  // The BODY's opening brace, not the destructured parameter's: the signature is
  // `(teamId, { now = Date.now() } = {}) {`, so a naive first-`{` scan matches the
  // options object and closes 66 characters later — a body that reads as empty
  // and would make every check below vacuously pass.
  const sigEnd = src.indexOf('\n', start);
  const open = src.lastIndexOf('{', sigEnd);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error('unbalanced braces in computeTeamTicketLedger');
}

// The internal route block, from its regex to the `return;` that closes it.
function internalRouteBlock(src) {
  const start = src.indexOf('const ticketLedgerMatch =');
  assert.notStrictEqual(start, -1, 'the /internal/teams/:id/tickets route is gone');
  const end = src.indexOf('\n    }\n', start);
  assert.notStrictEqual(end, -1, 'could not delimit the ticket route block');
  return src.slice(start, end);
}

function proxyRouteBlock(src) {
  const start = src.indexOf("app.get('/api/teams/:teamId/tickets'");
  assert.notStrictEqual(start, -1, 'the /api/teams/:teamId/tickets proxy is gone');
  const end = src.indexOf('\n});', start);
  assert.notStrictEqual(end, -1, 'could not delimit the proxy block');
  return src.slice(start, end);
}

// --- the checks, each one named so the mutation proof can re-run it ----------

const CHECKS = {
  routeCallsTheLedger(src) {
    const block = internalRouteBlock(src);
    assert.ok(
      block.includes('computeTeamTicketLedger(teamId)'),
      'the tickets route must compute the ledger',
    );
  },

  routeIsMaintenanceGated(src) {
    const block = internalRouteBlock(src);
    const maint = block.indexOf('readMaintenanceState()');
    const compute = block.indexOf('computeTeamTicketLedger(teamId)');
    assert.notStrictEqual(maint, -1, 'the tickets route must read maintenance state');
    assert.ok(
      maint < compute,
      'maintenance must be checked BEFORE the sweep — the window has to stay quiet',
    );
    assert.ok(block.includes('maintenance: true'), 'a maintenance response must say so');
  },

  routeRefusesANonTeam(src) {
    const block = internalRouteBlock(src);
    assert.ok(
      block.includes("cfg.role !== 'team'"),
      'the tickets route must 404 for anything that is not an Agent Team',
    );
  },

  routeToleratesAQueryString(src) {
    const block = internalRouteBlock(src);
    assert.ok(
      block.includes('tickets(?:\\?.*)?$'),
      'the route regex must tolerate a query string, like flow-anomalies',
    );
  },

  ledgerPassesTheRawMembers(src) {
    const body = ledgerFnBody(src);
    const call = body.indexOf('buildTicketLedger({');
    assert.notStrictEqual(call, -1, 'the sweep must build the ledger');
    const args = body.slice(call, body.indexOf('});', call));
    assert.ok(
      /^\s*members,\s*$/m.test(args),
      'buildTicketLedger needs the raw members: buildFlowModel drops the gate→consumer ' +
        'edges, and the lane/owner columns are exactly those',
    );
  },

  ledgerFetchesThePrDetail(src) {
    const body = ledgerFnBody(src);
    assert.ok(
      body.includes('_flowGithubGetJson(prSeg, token)'),
      'the sweep must fetch the PR DETAIL form — the list form carries neither ' +
        'mergeable nor mergeable_state, which is why the anomaly sweep never had them',
    );
  },

  ledgerMeasuresHowFarTheBaseMoved(src) {
    const body = ledgerFnBody(src);
    // Both halves, and the assignment rather than the word: `ahead_by` also
    // appears in the comment above the fetch, so a check that only greps the
    // identifier survives the field being dropped.
    assert.ok(body.includes('/compare/'), 'stale-base needs the compare request');
    assert.ok(
      body.includes('extras.baseAheadBy = cmp.ahead_by'),
      'without the measured base-moved half, stale-base degenerates to ci-red',
    );
  },

  ledgerReadsTheBaseTreeOncePerRepo(src) {
    const body = ledgerFnBody(src);
    assert.ok(
      body.includes('git/trees/') && body.includes('recursive=1'),
      'superseded needs the base file index',
    );
    const tree = body.indexOf('git/trees/');
    const prLoop = body.indexOf('for (const listItem of prList');
    assert.ok(
      tree < prLoop,
      'the base tree must be read once per REPO, not once per PR',
    );
  },

  ledgerFailsSoftOnGitHub(src) {
    const body = ledgerFnBody(src);
    assert.ok(
      body.includes('errors.push(`${repo}: issues: ${err.message}`)'),
      'an unreadable repository must be recorded and skipped — a partial GitHub outage ' +
        'must degrade the ledger, never 500 the endpoint',
    );
  },

  ledgerFoldsInTheAnomalies(src) {
    const body = ledgerFnBody(src);
    assert.ok(
      body.includes('computeTeamFlowAnomalies(teamId'),
      'the four shipped anomaly classes fold in as ONE input signal (§4.1)',
    );
    assert.ok(
      body.includes('readEntries(teamId)'),
      'recurrence must reuse the anomaly-history substrate, not a second store',
    );
  },

  proxyValidatesTheTeamId(src) {
    const block = proxyRouteBlock(src);
    assert.ok(block.includes('AGENT_ID_RE.test(teamId)'), 'the proxy must validate the id shape');
  },

  proxyHidesAnInvisibleTeam(src) {
    const block = proxyRouteBlock(src);
    assert.ok(
      block.includes('visibleTeam(scope, teamId)'),
      'the proxy must be team-scoped like flow-anomalies',
    );
    assert.ok(
      block.includes("res.status(404)"),
      'an invisible team must 404, not 403 — existence is what is being hidden',
    );
  },

  proxyTargetsTheInternalRoute(src) {
    const block = proxyRouteBlock(src);
    assert.ok(
      block.includes('/internal/teams/${encodeURIComponent(teamId)}/tickets'),
      'the proxy must call the internal ticket route',
    );
    assert.ok(block.includes('502'), 'an unreachable orchestrator must be a 502');
  },

  sweepNeverGuessesAtMergeability(src) {
    assert.ok(
      src.includes("let mergeable = 'UNKNOWN';"),
      'mergeable must stay three-valued: GitHub answers null while it is still computing, ' +
        'and mapping that either way invents or clears a conflict',
    );
  },

  sweepReportsTruncation(src) {
    assert.ok(
      src.includes('complete: !t.truncated'),
      'a truncated base tree must be reported incomplete, or superseded accuses a healthy PR',
    );
  },
};

// --- the checks must pass against the real source ---------------------------

for (const [name, check] of Object.entries(CHECKS)) {
  test(`wiring: ${name}`, () => {
    check(name.startsWith('proxy') ? API : name.startsWith('sweep') ? SWEEP : ORCH);
  });
}

// --- and each must FAIL against a source where exactly that wire is cut ------
//
// One entry per check. `anchor` must occur exactly once in the file it targets,
// so the substitution cannot land in a neighbouring function.

const MUTATIONS = [
  { check: 'routeCallsTheLedger', src: 'orch',
    anchor: 'const result = await computeTeamTicketLedger(teamId);',
    with: 'const result = { tickets: [] };' },
  { check: 'routeIsMaintenanceGated', src: 'orch',
    anchor: '          const maint = readMaintenanceState();\n          if (maint && maint.active) {\n            return sendJson(res, 200, {\n              teamId, maintenance: true, tickets: [], generatedAt: new Date().toISOString(),\n            });\n          }\n',
    with: '' },
  { check: 'routeRefusesANonTeam', src: 'orch',
    // Anchored through `ticketLedgerMatch`: the role check alone is shared with
    // flow-anomalies and hill-climb and occurs three times.
    anchor: "      const teamId = decodeURIComponent(ticketLedgerMatch[1]);\n      (async () => {\n        try {\n          const cfg = loadAgentConfig(teamId);\n          if (!cfg || cfg.role !== 'team') {\n            return sendJson(res, 404, { error: 'agent team not found' });\n          }\n",
    with: "      const teamId = decodeURIComponent(ticketLedgerMatch[1]);\n      (async () => {\n        try {\n" },
  { check: 'routeToleratesAQueryString', src: 'orch',
    anchor: "req.url.match(/^\\/internal\\/teams\\/([^/]+)\\/tickets(?:\\?.*)?$/)",
    with: "req.url.match(/^\\/internal\\/teams\\/([^/]+)\\/tickets$/)" },
  { check: 'ledgerPassesTheRawMembers', src: 'orch',
    anchor: '    // The raw ports too: `buildFlowModel` drops the gate→consumer edges, and the\n    // ledger\'s lane/owner columns are exactly those.\n    members,\n',
    with: '' },
  { check: 'ledgerFetchesThePrDetail', src: 'orch',
    anchor: '        detail = await _flowGithubGetJson(prSeg, token);',
    with: '        detail = listItem;' },
  { check: 'ledgerMeasuresHowFarTheBaseMoved', src: 'orch',
    anchor: 'if (cmp && typeof cmp.ahead_by === "number") extras.baseAheadBy = cmp.ahead_by;',
    with: '/* dropped */' },
  { check: 'ledgerReadsTheBaseTreeOncePerRepo', src: 'orch',
    anchor: '          `${seg}/git/trees/${encodeURIComponent(defaultBranch)}?recursive=1`,',
    with: '          `${seg}/contents`,' },
  { check: 'ledgerFailsSoftOnGitHub', src: 'orch',
    anchor: '      errors.push(`${repo}: issues: ${err.message}`);\n      continue;',
    with: '      throw err;' },
  { check: 'ledgerFoldsInTheAnomalies', src: 'orch',
    anchor: '    history = require("./anomaly-history").readEntries(teamId);',
    with: '    history = [];' },
  { check: 'proxyValidatesTheTeamId', src: 'api',
    anchor: "app.get('/api/teams/:teamId/tickets', apiLimiter, async (req, res) => {\n  const teamId = req.params.teamId;\n  if (!AGENT_ID_RE.test(teamId)) return res.status(400).json({ error: 'Invalid team id' });",
    with: "app.get('/api/teams/:teamId/tickets', apiLimiter, async (req, res) => {\n  const teamId = req.params.teamId;" },
  { check: 'proxyHidesAnInvisibleTeam', src: 'api',
    anchor: "  if (!visibleTeam(scope, teamId)) return res.status(404).json({ error: 'Team not found' });\n  try {\n    const resp = await fetch(`${ORCH_URL()}/internal/teams/${encodeURIComponent(teamId)}/tickets`);",
    with: "  try {\n    const resp = await fetch(`${ORCH_URL()}/internal/teams/${encodeURIComponent(teamId)}/tickets`);" },
  { check: 'proxyTargetsTheInternalRoute', src: 'api',
    anchor: '`${ORCH_URL()}/internal/teams/${encodeURIComponent(teamId)}/tickets`',
    with: '`${ORCH_URL()}/internal/teams/${encodeURIComponent(teamId)}/flow-anomalies`' },
  { check: 'sweepNeverGuessesAtMergeability', src: 'sweep',
    anchor: "  let mergeable = 'UNKNOWN';",
    with: "  let mergeable = 'MERGEABLE';" },
  { check: 'sweepReportsTruncation', src: 'sweep',
    anchor: '  return { paths, complete: !t.truncated };',
    with: '  return { paths, complete: true };' },
];

test('every check has a mutation that proves it fires', () => {
  assert.deepStrictEqual(
    MUTATIONS.map((m) => m.check).sort(),
    Object.keys(CHECKS).sort(),
    'one mutation per check, no more and no fewer',
  );
});

for (const m of MUTATIONS) {
  test(`mutation: ${m.check} is detected when its wire is cut`, () => {
    const source = m.src === 'api' ? API : m.src === 'sweep' ? SWEEP : ORCH;
    const occurrences = source.split(m.anchor).length - 1;
    assert.strictEqual(
      occurrences, 1,
      `the anchor for ${m.check} must occur EXACTLY once (found ${occurrences}) — ` +
        'otherwise the sabotage lands in a neighbouring function and the guard passes ' +
        'for the wrong reason',
    );
    const sabotaged = source.replace(m.anchor, m.with);
    assert.notStrictEqual(sabotaged, source, 'the mutation must change the source');
    assert.throws(
      () => CHECKS[m.check](sabotaged),
      `${m.check} did not fire on a source with exactly that wire cut — the check is vacuous`,
    );
  });
}

// --- observe-only, asserted rather than assumed -----------------------------

test('the ledger path mutates nothing — #2115 is observe-only', () => {
  const body = ledgerFnBody(ORCH);
  for (const forbidden of ['writeFileSync', 'appendFileSync', 'unlinkSync', 'mkdirSync']) {
    assert.ok(!body.includes(forbidden), `computeTeamTicketLedger must not call ${forbidden}`);
  }
  // A write would have to be an HTTP verb too; the sweep is GET-only.
  assert.ok(!/method:\s*["']POST["']/.test(body), 'the sweep must issue no writes to GitHub');
  const proxy = proxyRouteBlock(API);
  assert.ok(!proxy.includes('audit.record'), 'a read-only proxy records no mutation');
});

test('the pure core is free of I/O', () => {
  const core = fs.readFileSync(path.join(__dirname, 'ticket-reconciler.js'), 'utf8');
  for (const forbidden of ["require('fs')", 'require("fs")', 'require(\'node:fs\')', 'fetch(', 'Date.now()']) {
    assert.ok(!core.includes(forbidden), `ticket-reconciler.js must not contain ${forbidden}`);
  }
});
