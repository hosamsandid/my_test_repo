'use strict';

// Source-reading drift guard (the #651 convention) for how the first-boot
// System-Admin seeding is wired into `orchestrator.js` (#2059).
//
// `orchestrator.js` cannot be required from a test — it boots the Matrix client
// and two HTTP servers on import — so the ORDER of its startup steps, which is
// where the remaining risk in this feature lives, is asserted over its source.
// The decisions themselves are unit-tested in `initial-admin-seed.test.js` and
// `teams-store.test.js`; this file only pins that they are actually called, in
// the one order that makes the login path safe.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, 'orchestrator.js'), 'utf8');

// Index of `needle`, asserted present. Returning a bare indexOf would make
// every ordering assertion below trivially true via `-1 < anything`.
function at(needle, from = 0) {
  const i = SRC.indexOf(needle, from);
  assert.ok(i > -1, `orchestrator.js must contain ${JSON.stringify(needle)}`);
  return i;
}

test('the seed runs before the internal API accepts a login verification', () => {
  // This is the whole start-order argument: `POST /internal/admin/users/verify`
  // is the only way a login is checked, and it cannot be served before :4002
  // listens. Seeding first therefore means no login is ever verified against an
  // unseeded store from inside the orchestrator.
  const bootstrapCall = at('  bootstrapTeams();');
  const listen = at("internalApi.listen(4002");
  assert.ok(bootstrapCall < listen, 'bootstrapTeams() must run before internalApi.listen(4002)');

  // And it is called from main(), not lazily on first use.
  const mainStart = at('async function main() {');
  assert.ok(bootstrapCall > mainStart, 'the call sits inside main()');
});

test('bootstrapTeams seeds via the zero-users-gated primitive, not the promote-on-boot one', () => {
  const body = SRC.slice(at('function bootstrapTeams() {'), at('function backfillResourceOwnership'));

  assert.match(body, /teamsStore\.seedInitialSystemAdmin\(seed\)/,
    'the seed goes through seedInitialSystemAdmin, which owns the zero-users gate');
  assert.doesNotMatch(body, /ensureSystemAdmin/,
    'the pre-#2059 unconditional promote-from-env must not survive: it would re-grant '
    + 'System Admin on every boot, so the configured value would still be live config');
  assert.match(body, /resolveInitialAdminSeed\(process\.env\)/,
    'the input decision comes from the pure module');
  assert.doesNotMatch(body, /process\.env\.(ADMIN_PASSWORD|BOOTSTRAP_SYSTEM_ADMIN)/,
    'no env var is read inline here — resolveInitialAdminSeed is the single source');
});

test('the seeding is audited, after the record exists', () => {
  const body = SRC.slice(at('function bootstrapTeams() {'), at('function backfillResourceOwnership'));
  const seedCall = body.indexOf('seedInitialSystemAdmin');
  const auditCall = body.indexOf('recordSeedAudit');
  assert.ok(seedCall > -1 && auditCall > -1, 'both calls are present');
  assert.ok(seedCall < auditCall, 'the audit entry is written after the seed, so it can name the record');

  // A warm stack seeds nothing, and must therefore audit nothing.
  const earlyReturn = body.indexOf('if (!user) return;');
  assert.ok(earlyReturn > -1 && earlyReturn < auditCall,
    'a null result (warm stack) returns before the audit write');
});

test('the orchestrator writes to the same audit directory the console reads', () => {
  assert.match(SRC, /const AUDIT_DIR = process\.env\.AUDIT_DIR \|\| "\/workspace\/audit";/);
  const consoleAudit = fs.readFileSync(
    path.join(__dirname, '..', 'admin-console', 'api', 'audit.js'), 'utf8',
  );
  assert.match(consoleAudit, /const AUDIT_DIR = process\.env\.AUDIT_DIR \|\| '\/workspace\/audit';/,
    'both containers must resolve the audit trail to the same path and honour the same override');
});
