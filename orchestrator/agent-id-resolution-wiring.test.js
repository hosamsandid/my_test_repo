'use strict';

// Drift guard for the #2217 quickstart id-collision fix inside `orchestrator.js`.
//
// The suffix-walking decision is a real unit test (`agent-id-resolution.test.js`).
// What that cannot see is where the orchestrator applies it, and every
// remaining failure mode is a wiring one: the reservation write landing AFTER
// an `await` (reopening the exact TOCTOU race #1525/#1791 already closed for
// team members), the route's own collision refusal firing before the
// resolver gets a chance to run, or the id-sequence-exhausted error falling
// through to a bare 500.
//
// `orchestrator.js` boots two HTTP servers on require, so it cannot be loaded
// in a unit test (the `team-conversion-wiring.test.js` / `ownership-wiring.test.js`
// technique — these assertions read its source instead).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, 'orchestrator.js'), 'utf8');

function stripComments(src) {
  return src.replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** Slice out one class method's body, from its opening line to the next `  async `/`  }` sibling. */
function region(openingLine, endNeedle) {
  const start = SRC.indexOf(openingLine);
  assert.ok(start > 0, `'${openingLine}' not found — this guard needs re-pointing`);
  const end = SRC.indexOf(endNeedle, start + openingLine.length);
  assert.ok(end > start, `could not find the end of '${openingLine}'`);
  const body = stripComments(SRC.slice(start, end));
  assert.ok(body.length > 100, `region '${openingLine}' came back too short (${body.length}) — re-point this guard`);
  return body;
}

const reserveMethod = () => region('  resolveAndReserveAgentId(baseId)', '\n  async createAgent(');
const createAgent = () => region('  async createAgent(', '\n  async addTeamMember(');
const route = () => region("if (req.method !== 'POST' || req.url !== '/internal/agents')", '\n      } catch (err) {');

test('the pure resolver is required, not reimplemented inline', () => {
  assert.match(SRC, /require\("\.\/agent-id-resolution"\)/);
  assert.match(SRC, /nextAvailableAgentId\(/);
});

test('isAgentIdTaken folds in all three signals the team-conversion predicate uses', () => {
  const start = SRC.indexOf('function isAgentIdTaken(');
  assert.ok(start > 0, 'isAgentIdTaken not found — this guard needs re-pointing');
  const body = SRC.slice(start, SRC.indexOf('\n}', start));
  assert.match(body, /loadAgentConfig\(id\)/);
  assert.match(body, /agentTeardownRegistry\.has\(id\)/);
  assert.match(body, /fs\.existsSync\(agentDir\(id\)\)/);
});

test('resolveAndReserveAgentId reserves the id SYNCHRONOUSLY — no await before the write', () => {
  const src = reserveMethod();
  assert.doesNotMatch(src, /\bawait\b/, 'a reservation with an await before the write reopens the TOCTOU race it exists to close');
  const resolve = src.indexOf('nextAvailableAgentId(baseId, isAgentIdTaken)');
  const write = src.indexOf('saveAgentConfig(id, placeholder)');
  assert.ok(resolve > 0 && write > resolve, 'the id must be resolved before the reservation is written');
});

test('createAgent resolves+reserves via autoId BEFORE any config is persisted', () => {
  const src = createAgent();
  assert.match(src, /if \(extra\.autoId\) \{\s*\n\s*id = this\.resolveAndReserveAgentId\(id\);/);
  const autoIdCheck = src.indexOf('extra.autoId');
  const firstSave = src.indexOf('saveAgentConfig(');
  assert.ok(autoIdCheck > 0 && firstSave > autoIdCheck, 'autoId must be resolved before createAgent writes any config');
});

test('the route skips its own collision refusal exactly when autoId is set, and forwards it as extra', () => {
  const src = route();
  assert.match(src, /\bautoId,\s*\n\s*\} = JSON\.parse\(body\);/, 'autoId must be in the destructured whitelist');
  assert.match(
    src,
    /if \(!autoId && \(loadAgentConfig\(id\) \|\| agentTeardownRegistry\.has\(id\)\)\) \{/,
    'the 409 refusal must be gated on !autoId — autoId is what makes a collision on the base id NOT a refusal'
  );
  assert.match(src, /if \(autoId\) extra\.autoId = true;/);
});

test('id-sequence-exhausted is a named 409, not a bare 500', () => {
  const start = SRC.indexOf('Internal API create error');
  assert.ok(start > 0, 'the create-route catch block moved — re-point this guard');
  const body = SRC.slice(start, SRC.indexOf("res.end(JSON.stringify({ error: err.message }));", start) + 60);
  assert.match(body, /err\.code === 'id-sequence-exhausted'/);
  const idxExhausted = body.indexOf("err.code === 'id-sequence-exhausted'");
  const idxGenericFallback = body.indexOf('const isUserError');
  assert.ok(idxGenericFallback > idxExhausted, 'the named refusal must be checked before the generic 400/500 fallback');
});

test('the manual-create route names a stable code and a suggestion alongside the refusal (#2218)', () => {
  const src = route();
  assert.match(src, /code: 'id-conflict'/, 'the refusal must carry the same code the clone/import routes use');
  assert.match(src, /suggestFreeAgentId\(id, isAgentIdTaken\)/, 'the suggestion must be resolved by the strict #2217 predicate');
  const conflictIdx = src.indexOf("if (!autoId && (loadAgentConfig(id) || agentTeardownRegistry.has(id))) {");
  const suggestIdx = src.indexOf('suggestFreeAgentId(id, isAgentIdTaken)');
  assert.ok(conflictIdx > 0 && suggestIdx > conflictIdx, 'the suggestion must be computed inside the collision branch, not before it is known to be taken');
});

test('suggestFreeAgentId is imported alongside nextAvailableAgentId', () => {
  assert.match(SRC, /suggestFreeAgentId/);
  assert.match(SRC, /require\("\.\/agent-id-resolution"\)/);
});

test('an id-sequence-exhausted suggestion failure omits the suggestion, never the refusal itself', () => {
  const src = route();
  const tryIdx = src.indexOf('suggestFreeAgentId(id, isAgentIdTaken)');
  const writeHeadIdx = src.indexOf('res.writeHead(409', tryIdx);
  assert.ok(tryIdx > 0 && writeHeadIdx > tryIdx, 'the suggestion call must be wrapped so a failure to compute it cannot suppress the 409 itself');
});
