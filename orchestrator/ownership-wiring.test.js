'use strict';

// Drift guard for the #2077 ownership wiring inside `orchestrator.js`.
//
// The decisions are real unit tests (`ownership-migration.test.js`,
// `credential-resolution.test.js`). What those cannot see is where the
// orchestrator applies them, and every remaining failure mode is a wiring one:
//
//   - a `team-member` given an `ownerId` of its own would become a second
//     source of truth that an owner reassign on the team never updates (D8);
//   - the migration running BEFORE `backfillResourceOwnership` would resolve
//     owners against configs that do not carry a `teamId` yet;
//   - `resolveAttributedGithubToken` not threading `personalCredentialPresent`
//     would put every agent back on the refuse-on-missing path the moment the
//     backfill stamps its owner — i.e. no agent could open a PR (AC7).
//
// `orchestrator.js` boots two HTTP servers on require, so it cannot be loaded in
// a unit test. These assertions read its source instead — the
// `team-conversion-wiring.test.js` technique.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, 'orchestrator.js'), 'utf8');

// Strip LINE comments only. A `/* … */` pass is deliberately absent: run over
// this 712 KB file it swallows ~72 KB of real code, because `/*` also occurs
// inside string literals and regexes here — which would make every
// `doesNotMatch` assertion below silently vacuous. (The `[^:]` guard is what
// keeps a `https://` inside a string from being read as a comment.)
function stripComments(src) {
  return src.replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** Slice out one function/method body by its opening line. */
function region(openingLine, endNeedle) {
  const start = SRC.indexOf(openingLine);
  assert.ok(start > 0, `'${openingLine}' not found — this guard needs re-pointing`);
  const end = SRC.indexOf(endNeedle, start + openingLine.length);
  assert.ok(end > start, `could not find the end of '${openingLine}'`);
  const body = stripComments(SRC.slice(start, end));
  // A truncated region would make the negative assertions pass for free.
  assert.ok(body.length > 200, `region '${openingLine}' came back too short (${body.length}) — re-point this guard`);
  return body;
}

const createAgent = () => region('  async createAgent(', '\n  async addTeamMember(');
const attributedToken = () => region('function resolveAttributedGithubToken(', '\n}');
const migration = () => region('function migrateOwnershipModel(', '\n}\n');

// ── createAgent stamps the owner on both ownable roles, and only those ──────

test('the owner stamp is gated on ownableRole, never written for a member (D8)', () => {
  const src = createAgent();
  assert.match(
    src,
    /const ownerFields = ownershipMigration\.ownableRole\(role\) && extra\.ownerId/,
    'the stamp must be gated on the shared ownableRole predicate, not an inline role list',
  );
  // A member is created by addTeamMember, which is outside this region — assert
  // it never mentions the fields at all, so it cannot start writing one.
  const member = region('  async addTeamMember(', '\n  async ');
  assert.doesNotMatch(member, /ownerId/, 'addTeamMember must not write an ownerId (D8)');
});

test('both the team and the standalone config literal carry the owner fields', () => {
  const src = createAgent();
  // The two literals are distinguishable by the key that follows their teamId.
  const team = src.indexOf('role: "team",\n        environmentId: env.id,');
  assert.ok(team > 0, 'the team config literal moved — re-point this guard');
  assert.match(
    src.slice(team, team + 400),
    /teamId: ownerTeamId,\s*\n\s*\.\.\.ownerFields,/,
    'the team config must spread ownerFields',
  );
  const standalone = src.indexOf('const config = {');
  assert.ok(standalone > 0, 'the standalone config literal moved — re-point this guard');
  assert.match(
    src.slice(standalone, standalone + 400),
    /teamId: ownerTeamId,\s*\n\s*\.\.\.ownerFields,/,
    'the standalone config must spread ownerFields',
  );
});

test('an ownerSource that is not a known source falls back to creator', () => {
  assert.match(
    createAgent(),
    /ownershipMigration\.OWNER_SOURCES\.includes\(extra\.ownerSource\)/,
    'ownerSource must be validated against the shared list, not written verbatim',
  );
});

// ── the internal route accepts the owner, and only from the console ─────────

test('POST /internal/agents accepts ownerId and forwards it as extra', () => {
  const route = region("if (req.method !== 'POST' || req.url !== '/internal/agents')", 'orchestrator.createAgent(');
  assert.match(route, /\bownerId, ownerSource,/, 'ownerId must be in the destructured whitelist');
  assert.match(route, /extra\.ownerId = ownerId\.trim\(\)/);
  assert.match(route, /extra\.ownerSource = ownerSource\.trim\(\)/);
});

// ── the credential switch (AC7 — the regression this whole ticket risks) ────

test('resolveAttributedGithubToken reports credential PRESENCE, not just the entry', () => {
  const src = attributedToken();
  assert.match(
    src,
    /findPersonalCredentialState\(/,
    'must use the state lookup — findPersonalCredential alone cannot tell "owner has none" from "owner\'s is unusable"',
  );
  assert.match(src, /personalCredentialPresent: personal\.present/);
  assert.match(src, /personalCredential: personal\.entry/);
});

// ── the startup pass ────────────────────────────────────────────────────────

test('the migration runs after the teamId backfill it depends on', () => {
  // The raw source is fine here: both needles carry `();`, which no comment in
  // this file does, so a mention in prose cannot satisfy either one.
  const backfill = SRC.indexOf('  backfillResourceOwnership();');
  const migrate = SRC.indexOf('  migrateOwnershipModel();');
  assert.ok(backfill > 0, 'backfillResourceOwnership() call site not found');
  assert.ok(migrate > 0, 'migrateOwnershipModel() is not called at boot');
  assert.ok(
    migrate > backfill,
    'migrateOwnershipModel must run AFTER backfillResourceOwnership — it resolves owners from each config\'s teamId',
  );
});

test('the migration is additive: it never removes or rewrites a membership', () => {
  const src = migration();
  assert.match(src, /teamsStore\.appendMemberships\(repoint\)/);
  // P1 changes no enforcement, so dropping the access-scope grants here would
  // empty every list for every non-admin (see the no-lockout proof).
  assert.doesNotMatch(src, /removeMembership|setMembership/, 'the migration must only append');
});

test('the migration is idempotent by value and never aborts boot', () => {
  const src = migration();
  // Idempotence comes from the planners skipping already-migrated state, so the
  // pass must not gate itself on a marker/version file it could lose.
  assert.doesNotMatch(src, /migrat\w*\.json|writeFileSync/, 'no marker file — idempotence is by value');
  assert.match(src, /planOwnerBackfill/);
  assert.match(src, /planMembershipRepoint/);
  // Every failure path is a warn, never a throw.
  assert.equal((src.match(/console\.warn/g) || []).length >= 3, true, 'each failure path must warn');
  assert.doesNotMatch(src, /\bthrow\b/, 'the migration must never abort boot');
});

test('an unresolvable owner is reported rather than fabricated', () => {
  const src = migration();
  assert.match(src, /unresolved/, 'the unresolved list must be consumed');
  assert.match(src, /has no resolvable owner/, 'and reported in plain language');
});
