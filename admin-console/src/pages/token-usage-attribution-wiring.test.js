import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Source-reading drift guard for the cost-attribution surfaces on the Token
// Usage page (#2137, #651).
//
// Every decision is unit-tested in the pure `token-usage-view.test.js`. What
// cannot be tested there is that `TokenUsage.jsx` actually renders through
// those helpers, and that the user directory is fetched only for the one
// grouping that needs it — the JSX is uncovered by convention, so these are
// assertions over its source, each proven non-vacuous by a mutation that makes
// exactly it fire.
//
// Both properties fail SILENTLY: printing the raw key shows an admin a column
// of UUIDs (and the literal word `unknown` where a person's name belongs), and
// an unconditional directory fetch adds a request to every visit of a page
// whose other five groupings have no use for it.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(HERE, 'TokenUsage.jsx'), 'utf8');

const CHECKS = {
  // The two machine-valued groupings are named through the pure helpers, so the
  // table and the unit tests cannot disagree about what `unknown` reads as.
  'group-key-rendered-through-the-pure-helpers'(src) {
    return /userGroupCell\(v, userNames\)/.test(src)
      && /providerTierCell\(v\)/.test(src)
      && /\{ key: 'key', label: groupLabel, render: renderGroupKey \}/.test(src);
  },

  // The OPEN directory, never `/api/admin/users`: that route returns the whole
  // record (subject, systemAdmin, githubHandle) and is narrowed to shared
  // teams, so a colleague on another team would come back unnameable. Checked
  // BEFORE the conditional below, because pointing the fetch at the wrong route
  // breaks both and the more specific complaint is the useful one.
  'directory-is-the-open-projection'(src) {
    return src.includes('/api/users/directory') && !src.includes('/api/admin/users');
  },

  // Fetched only for `groupBy === 'user'`. `useApi(null)` is the supported skip
  // (see hooks/useApi.js), so the other groupings issue no request at all.
  'directory-fetched-only-for-the-user-grouping'(src) {
    return /useApi\(groupBy === 'user' \? '\/api\/users\/directory' : null\)/.test(src);
  },
};

function runCheck(src) {
  for (const [name, fn] of Object.entries(CHECKS)) {
    let ok = false;
    try { ok = fn(src); } catch { return name; }
    if (!ok) return name;
  }
  return null;
}

test('#2137: the Token Usage attribution wiring is intact', () => {
  assert.equal(runCheck(SRC), null);
});

const MUTATIONS = [
  // Back to printing the raw key: a column of account UUIDs, and the literal
  // string `unknown` where a person's name belongs.
  ['group-key-rendered-through-the-pure-helpers',
    "{ key: 'key', label: groupLabel, render: renderGroupKey },",
    "{ key: 'key', label: groupLabel, render: (v) => v || '—' },"],
  // A request on every visit, for five groupings that never read it.
  ['directory-fetched-only-for-the-user-grouping',
    "useApi(groupBy === 'user' ? '/api/users/directory' : null)",
    "useApi('/api/users/directory')"],
  // The wrong endpoint: full user records, narrowed to shared teams.
  ['directory-is-the-open-projection',
    "'/api/users/directory'", "'/api/admin/users'"],
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
  assert.deepEqual([...Object.keys(CHECKS)].filter((k) => !fired.has(k)), []);
});
