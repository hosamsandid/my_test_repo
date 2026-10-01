'use strict';

// Guards the route half of the Edit-as-draft edge-loss fix. The pure modules
// (process-template.js / unified-graph.js) own the port remap + graph derivation
// and are unit-tested there. But two wiring decisions live only in api.js, and
// dropping either silently reintroduces the exact bug — an Edit-as-draft of a
// live team that renders FEWER edges than the team it came from:
//
//  1. `GET /api/process/template` must carry each member's `channels` port into
//     the EXPORTED ROLE (`roleEntries`), not only into the `graphAgents` copy
//     that feeds gate/label derivation. Without it buildProcessTemplate has no
//     `r.channels` to remap, the bundle carries none, and every producer→consumer
//     channel edge (e.g. Developer → Code Reviewer "PR") vanishes from the draft.
//  2. The two materialise paths (`POST /api/teams` + `/api/teams/stream`) must
//     expand the bundle humans' PR/issue consume `from` from a portable role key
//     back to the member id (`${teamId}-`), the inverse of the export's roleKeyOf
//     reduction — else the stored registry keeps role keys while the live graph's
//     producer nodes are member ids and the producer → human-reviewer edge orphans.
//
// api.js cannot be `require`d in a unit test (it boots Express and reaches for
// the orchestrator), so this reads the route source — the same drift-guard
// technique the other `*-wiring.test.js` files use. Each check is a named
// function over an arbitrary source string; the mutation proof at the bottom
// re-runs each check against a sabotaged copy and asserts it fires.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const API_SRC = fs.readFileSync(path.join(__dirname, 'api.js'), 'utf8');

function stripComments(src) {
  return src.replace(/(^|[^:])\/\/[^\n]*/g, '$1').replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Slice one route's body, so a match elsewhere in the 16k-line file can't fool us. */
function route(src, marker) {
  const start = src.indexOf(marker);
  assert.ok(start > 0, `route ${marker} not found — this guard needs re-pointing`);
  const end = src.indexOf('\napp.', start + 1);
  assert.ok(end > start, `could not find the end of route ${marker}`);
  return src.slice(start, end);
}

const TEMPLATE_ROUTE = "app.get('/api/process/template'";
const templateRoute = (src) => stripComments(route(src, TEMPLATE_ROUTE));

const CHECKS = {
  /** The exported ROLE carries the channels port (buildProcessTemplate remaps it). */
  exportedRoleCarriesChannels(src) {
    const r = templateRoute(src);
    // roleEntries.push({ ... channels: cfg.channels ... }) — the push happens
    // before the graphAgents.push comment, so slice to the first graphAgents mention.
    const roleEntriesPush = r.slice(0, r.indexOf('graphAgents.push'));
    assert.match(roleEntriesPush, /Array\.isArray\(cfg\.channels\) && cfg\.channels\.length \? \{ channels: cfg\.channels \}/,
      'roleEntries must carry the channels port so the exported bundle round-trips channel edges');
  },

  /** The exported ROLE carries the pool port (buildProcessTemplate serializes it). */
  exportedRoleCarriesPool(src) {
    const r = templateRoute(src);
    // Same location as channels above: the roleEntries.push, before graphAgents.
    // Without it a pooled role exports as unpooled and a team with autoDispatch +
    // wipLimit re-imports as an invalid bundle (#2579).
    const roleEntriesPush = r.slice(0, r.indexOf('graphAgents.push'));
    assert.match(roleEntriesPush, /cfg\.pool && typeof cfg\.pool === 'object' \? \{ pool: cfg\.pool \}/,
      'roleEntries must carry the pool port so an exported pooled role round-trips (#2579)');
  },

  /** Both materialise paths expand humans consume `from` to member ids. */
  materialiseExpandsHumanConsumes(src) {
    const s = stripComments(src);
    const occurrences = s.match(/remapHumanConsumesFrom\(\s*normalizeHumans\(body\.processTemplate\?\.humans\),\s*\(f\) => `\$\{teamId\}-\$\{f\}`,?\s*\)/g) || [];
    assert.equal(occurrences.length, 2,
      'both POST /api/teams and /api/teams/stream must expand bundle humans consume `from` to member ids');
  },

  /** The remap helper is imported from the pure module, not reimplemented here. */
  remapHelperComesFromThePureModule(src) {
    const req = stripComments(src).match(/const \{[^}]*\} = require\('\.\/process-template'\);/);
    assert.ok(req, "api.js must require ./process-template");
    assert.match(req[0], /remapHumanConsumesFrom/,
      'remapHumanConsumesFrom belongs to process-template.js, where it is unit-tested');
  },
};

for (const [name, check] of Object.entries(CHECKS)) {
  test(`edit-as-draft wiring: ${name}`, () => check(API_SRC));
}

// ── mutation proof ───────────────────────────────────────────────────────────

const MUTATIONS = [
  {
    fires: 'exportedRoleCarriesChannels',
    // Remove only the channels line (the pool line, #2579, now follows it before
    // the closing `});`), so this mutation isolates the channels check.
    apply: (s) => s.replace(
      '      ...(Array.isArray(cfg.channels) && cfg.channels.length ? { channels: cfg.channels } : {}),\n',
      '',
    ),
  },
  {
    fires: 'exportedRoleCarriesPool',
    apply: (s) => s.replace(
      "      ...(cfg.pool && typeof cfg.pool === 'object' ? { pool: cfg.pool } : {}),\n    });",
      '    });',
    ),
  },
  {
    fires: 'materialiseExpandsHumanConsumes',
    // Revert BOTH sites to the old un-remapped form; the count check then reads 0.
    apply: (s) => s.replace(
      /let bundleHumans = remapHumanConsumesFrom\(\s*normalizeHumans\(body\.processTemplate\?\.humans\),\s*\(f\) => `\$\{teamId\}-\$\{f\}`,?\s*\);/g,
      'let bundleHumans = normalizeHumans(body.processTemplate?.humans);',
    ),
  },
  {
    fires: 'remapHelperComesFromThePureModule',
    apply: (s) => s.replace('remapHumanConsumesFrom, normalizeHillClimb', 'normalizeHillClimb'),
  },
];

for (const { fires, apply } of MUTATIONS) {
  test(`mutation proof: breaking ${fires} fires exactly that check`, () => {
    const mutated = apply(API_SRC);
    assert.notEqual(mutated, API_SRC, 'the mutation did not change the source — re-point it');
    assert.throws(() => CHECKS[fires](mutated), assert.AssertionError,
      `${fires} did not catch its own mutation`);
    for (const [name, check] of Object.entries(CHECKS)) {
      if (name === fires) continue;
      assert.doesNotThrow(() => check(mutated),
        `${name} also fired — the checks overlap, so a failure would name the wrong one`);
    }
  });
}
