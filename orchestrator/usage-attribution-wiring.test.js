'use strict';

// Source-reading drift guard for the cost-attribution wiring (#2137, #651).
//
// Every judgement is unit-tested in the pure `usage-attribution.test.js`. What
// cannot be tested there is that `enrichUsageRecord` actually calls it, in the
// right place, and that the raw Matrix id does not survive into the persisted
// record — `orchestrator.js` boots two HTTP listeners on require, so it cannot
// be imported here. These are therefore assertions over its source, written as
// a dict of NAMED predicates so each one can be proven non-vacuous by a
// mutation that makes exactly it fire.
//
// Every property guarded here fails SILENTLY: a missing `delete` leaves raw
// chat identities in a store with no retention, a conditional overwrite lets an
// agent self-assert who its spend is charged to, and an enrichment that runs
// after the append writes an unattributed record while every unit test passes.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, 'orchestrator.js'), 'utf8');

// A bounded slice between two anchors. `maxSpan` is not decoration: an end
// anchor matching far past the intended block silently swallows unrelated code
// and turns an "X is not in here" assertion into a vacuous pass.
function slice(src, startAnchor, endAnchor, maxSpan) {
  const a = src.indexOf(startAnchor);
  assert.notEqual(a, -1, `start anchor not found: ${startAnchor}`);
  const b = src.indexOf(endAnchor, a + startAnchor.length);
  assert.notEqual(b, -1, `end anchor not found after start: ${endAnchor}`);
  const span = b - a;
  assert.ok(span <= maxSpan, `slice ${startAnchor} → ${endAnchor} is ${span} chars, expected ≤ ${maxSpan}`);
  return src.slice(a, b);
}

function enrichBody(src) {
  return slice(src, 'function enrichUsageRecord(agentId, record)', '\n// Apply every environment normalization', 3200);
}

// ── the named checks ────────────────────────────────────────────────────────

const CHECKS = {
  // The record persists the resolved account id, never the raw Matrix id it was
  // resolved FROM. The usage store has no retention by design (usage-log.js), so
  // a `requestedBy` left on the record accumulates raw chat identities forever —
  // including those of deleted humans.
  'raw-matrix-id-is-dropped'(src) {
    const body = enrichBody(src);
    return /const requestedBy = out\.requestedBy;/.test(body)
      && /delete out\.requestedBy;/.test(body)
      && body.indexOf('const requestedBy = out.requestedBy;') < body.indexOf('delete out.requestedBy;');
  },

  // `attribution` and `providerTier` are UNCONDITIONAL, unlike teamId/roleId/
  // provider which are only backfilled when null. The agent cannot resolve
  // either one, so a value arriving in the body is self-asserted — a
  // `if (out.attribution == null)` guard would let an agent charge its spend to
  // any account it names.
  'attribution-and-tier-are-not-conditionally-backfilled'(src) {
    const body = enrichBody(src);
    return /\n  out\.attribution = usageAttribution\.resolveUsageAttribution\(/.test(body)
      && /\n  out\.providerTier = usageAttribution\.providerTierOf\(/.test(body)
      && !/out\.attribution == null/.test(body)
      && !/out\.providerTier == null/.test(body);
  },

  // The tier is resolved from the record's OWN provider field — after the
  // provider backfill above it, so a record that left `provider` null still gets
  // its tier from the config-resolved endpoint rather than reading as unknown.
  'tier-is-resolved-after-the-provider-backfill'(src) {
    const body = enrichBody(src);
    const backfill = body.indexOf('out.provider = cfg.llmEndpointOverride');
    const tier = body.indexOf('out.providerTier = usageAttribution.providerTierOf(');
    return backfill !== -1 && tier !== -1 && backfill < tier
      // Exactly one assignment, or "after" is a claim about whichever copy the
      // search happened to find first.
      && body.split('out.providerTier =').length - 1 === 1;
  },

  // The autonomous-run owner is the SAME answer credential resolution gives, so
  // a triggered run's cost and its attributed commits cannot point at two
  // different people. Re-deriving it from the config here would be a second
  // source of truth that a team-member's one-hop parent lookup would break.
  'owner-comes-from-the-shared-resolver'(src) {
    const body = enrichBody(src);
    return /credentialResolution\.resolveAgentOwnerId\(cfg,/.test(body)
      && !/cfg\.ownerId \|\|/.test(body);
  },

  // Neither read may throw: usage ingest is best-effort telemetry and must not
  // fail because the users index or the endpoint index is unreadable. Both are
  // wrapped, and both degrade to a value the pure module treats as "unknown"
  // rather than to a guess.
  'unreadable-stores-degrade-instead-of-throwing'(src) {
    const body = enrichBody(src);
    return /try \{ users = teamsStore\.listUsers\(\); \} catch \{ users = \[\]; \}/.test(body)
      && /try \{ endpointIndex = JSON\.parse\(fs\.readFileSync\(LLM_ENDPOINTS_INDEX, "utf8"\)\); \} catch \{ endpointIndex = null; \}/.test(body);
  },

  // #2585: the pool-instance → main-agent link is stamped from the
  // orchestrator's own config, unconditionally — an instance is reaped later, so
  // ingest is the only point it is still known, and a body-supplied `poolOf`
  // must not let an agent book its spend onto another agent's row.
  'pool-of-is-stamped-unconditionally-from-config'(src) {
    const body = enrichBody(src);
    return /\n  out\.poolOf = cfg\.poolInstance && /.test(body)
      && !/out\.poolOf == null/.test(body);
  },

  // The enrichment must run BEFORE the append, or the store holds an
  // unattributed record and nothing ever revisits it.
  'ingest-enriches-before-appending'(src) {
    const body = slice(src, 'const usageIngestMatch =', '// ── Read: agent-facing read-only usage summary', 2200);
    return /usageLog\.record\(enrichUsageRecord\(id, rec\)\)/.test(body);
  },
};

function runCheck(src) {
  for (const [name, fn] of Object.entries(CHECKS)) {
    let ok = false;
    try {
      ok = fn(src);
    } catch {
      return name; // a slice that no longer resolves IS the drift
    }
    if (!ok) return name;
  }
  return null;
}

test('#2137: the attribution wiring is intact', () => {
  assert.equal(runCheck(SRC), null);
});

// Each entry: [check it must fire, unique source to find, replacement].
const MUTATIONS = [
  // The raw Matrix id survives into the persisted record.
  ['raw-matrix-id-is-dropped',
    '  const requestedBy = out.requestedBy;\n  delete out.requestedBy;',
    '  const requestedBy = out.requestedBy;'],
  // An agent may now self-assert who its spend is charged to.
  ['attribution-and-tier-are-not-conditionally-backfilled',
    '  out.attribution = usageAttribution.resolveUsageAttribution({ requestedBy, users, ownerId });',
    '  if (out.attribution == null) out.attribution = usageAttribution.resolveUsageAttribution({ requestedBy, users, ownerId });'],
  // The tier is read before the provider backfill, so a record that left
  // `provider` null reads as an unknown tier forever.
  ['tier-is-resolved-after-the-provider-backfill',
    '  if (out.provider == null) {\n    const env = cfg.environmentId ? loadEnvironment(cfg.environmentId) : null;',
    '  out.providerTier = usageAttribution.providerTierOf(null, out.provider);\n  if (out.provider == null) {\n    const env = cfg.environmentId ? loadEnvironment(cfg.environmentId) : null;'],
  // A second, differently-behaving owner rule — a team-member would now resolve
  // to nothing instead of to its parent Agent Team's owner.
  ['owner-comes-from-the-shared-resolver',
    '    ownerId = credentialResolution.resolveAgentOwnerId(cfg, (id) => {\n      try { return loadAgentConfig(id); } catch { return null; }\n    });',
    '    ownerId = cfg.ownerId || null;'],
  // An unreadable users index now takes the whole ingest down with it.
  ['unreadable-stores-degrade-instead-of-throwing',
    '  try { users = teamsStore.listUsers(); } catch { users = []; }',
    '  users = teamsStore.listUsers();'],
  // A self-asserted `poolOf` in the body now survives.
  ['pool-of-is-stamped-unconditionally-from-config',
    '  out.poolOf = cfg.poolInstance && ',
    '  if (out.poolOf == null) out.poolOf = cfg.poolInstance && '],
  // The record is appended raw; the enrichment is dropped.
  ['ingest-enriches-before-appending',
    'usageLog.record(enrichUsageRecord(id, rec));',
    'usageLog.record(rec);'],
];

test('#2137: every wiring check is proven by a mutation that makes exactly it fire', () => {
  const fired = new Set();
  for (const [expected, find, replace] of MUTATIONS) {
    const hits = SRC.split(find).length - 1;
    assert.equal(hits, 1, `mutation anchor for ${expected} matches ${hits}x (must be exactly 1): ${find.slice(0, 60)}`);
    const mutated = SRC.replace(find, replace);
    assert.notEqual(mutated, SRC, `mutation for ${expected} did not change the source`);
    assert.equal(runCheck(mutated), expected, `mutation for ${expected} fired the wrong check`);
    fired.add(expected);
  }
  // No check may be untested — a guard nothing can falsify guards nothing.
  assert.deepEqual([...Object.keys(CHECKS)].filter((k) => !fired.has(k)), []);
});
