'use strict';

// Guards deferred materialization on the STREAMING team-create path (#1955).
//
// `materializeMembers` was wired end-to-end — the non-streaming `POST /api/teams`
// honoured it, the orchestrator wrote stubs for it, the UI offered a checkbox for
// it — except through `POST /api/teams/stream`, which is the endpoint BOTH launch
// surfaces actually submit to. The flag was read nowhere in that handler and its
// member create deliberately omitted it, so the Flow Editor's "Materialize agents
// now" checkbox was inert: every member was fully materialized (Matrix user, repo
// clone, running container) no matter what the operator chose.
//
// api.js cannot be `require`d in a unit test (it boots Express and reaches for the
// orchestrator), so this reads each route's source — the same drift-guard technique
// the src-side `*-wiring.test.js` files use for JSX (#651). Both handlers are
// asserted: the streaming one for the new threading, the non-streaming one because
// AC7 says it must stay unchanged.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const API_SRC = fs.readFileSync(path.join(__dirname, 'api.js'), 'utf8');

/** Slice out one route's body, so a match elsewhere in the 14k-line file can't fool us. */
function route(marker) {
  const start = API_SRC.indexOf(marker);
  assert.ok(start > 0, `route ${marker} not found — this guard needs re-pointing`);
  const end = API_SRC.indexOf('\napp.', start + 1);
  assert.ok(end > start, `could not find the end of route ${marker}`);
  return API_SRC.slice(start, end);
}

/** Comments name the very feature under test, so strip them before asserting. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const streamRoute = () => stripComments(route("app.post('/api/teams/stream'"));
const plainRoute = () => stripComments(route("app.post('/api/teams'"));

test('the streaming handler reads materializeMembers with the same default as the plain one', () => {
  const src = streamRoute();
  assert.match(src, /const materializeMembers = body\.materializeMembers !== false;/);
  // `!== false` (not a truthiness check) is the contract: an omitted flag has to
  // stay materialize-now, which is what the wizard has always relied on (AC2/AC3).
  assert.doesNotMatch(src, /body\.materializeMembers\s*(&&|\?|===\s*true)/);
});

test('the streaming member create threads materialize into buildMemberFromTemplate', () => {
  const src = streamRoute();
  const call = src.slice(src.indexOf('buildMemberFromTemplate('));
  assert.ok(call, 'the streaming route must still build its member body from the template');
  const args = call.slice(0, call.indexOf('});') + 3);
  assert.match(args, /materialize: materializeMembers/);
  // The whole point of the ticket: the flag must not be left to the orchestrator
  // default on the one path both UI surfaces submit to.
  assert.doesNotMatch(args, /materialize: true/);
});

test('the DM pre-create phase is skipped for stub members on the stream path', () => {
  const src = streamRoute();
  assert.match(src, /if \(toCreate\.length > 0 && materializeMembers\) \{/);
  // The step is not announced either — a planned "Prepare agent conversations"
  // that never runs is the same dishonest progress AC4 forbids.
  const planLine = src.split('\n').find(l => l.includes("id: 'dms'") && l.includes('plan.push'));
  assert.ok(planLine, "the dms plan entry must still exist for the materialize-now case");
  assert.match(planLine, /materializeMembers/);
});

test('the stream states the mode it ran in: honest step labels + terminal payload', () => {
  const src = streamRoute();
  // Per-member plan label distinguishes a stub create from a full one (AC4).
  assert.match(src, /Create member \(stub\):/);
  // And the complete event reports the mode, like the non-streaming response.
  const complete = src.slice(src.indexOf("type: 'complete'"));
  assert.match(complete, /materialized: materializeMembers/);
});

test('rollback tears a stub member down through the same audited delete', () => {
  // AC6: nothing extra to undo for a stub (config only), so the guard is that the
  // member rollback is unconditional — it must not have grown a materialize branch
  // that would leave a stub config behind on a failed stub-mode create.
  const src = streamRoute();
  const from = src.indexOf('const rollback = async');
  assert.ok(from > 0, 'the streaming rollback must still exist');
  const rollback = src.slice(from, src.indexOf('\n  try {', from));
  assert.match(rollback, /for \(const memberId of \[\.\.\.created\.members\]\.reverse\(\)\)/);
  assert.match(rollback, /rollbackDelete\(memberId, 'member'\)/);
  assert.doesNotMatch(rollback, /materializeMembers/);
});

test('the non-streaming handler is unchanged (AC7)', () => {
  const src = plainRoute();
  assert.match(src, /const materializeMembers = body\.materializeMembers !== false;/);
  assert.match(src, /materialize: materializeMembers/);
  assert.match(src, /if \(materializeMembers\) \{/); // DM phase gate
  assert.match(src, /materialized: materializeMembers/); // response echo
});
