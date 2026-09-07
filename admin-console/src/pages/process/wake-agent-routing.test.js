import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// ─── #2030 — source-reading drift guard over `RoutingSection.jsx` ────────────
//
// The Routing tab's `finalize()` is the CLIENT whitelist of the five the
// direct-agent-handoff concept calls out (§4.2): every one of them rebuilds an
// action as `{ type, label? }`, so a missed one drops a `wakeAgent`'s `to` /
// `note` with NO error anywhere — the hand-off edge is simply gone the next
// time anyone saves the Routing tab. The other four live in pure modules and
// are covered by behaviour tests (`admin-console/api/outcomes.test.js`); this
// one is inside JSX the `admin-console-src` job cannot import (#651), so it is
// guarded by reading the source.
//
// Run: node --test admin-console/src/pages/process/wake-agent-routing.test.js

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, 'RoutingSection.jsx'), 'utf8');

// Comments explain the wiring; they must not be able to satisfy an assertion
// about it. Stripped once, then sanity-checked so a future strip bug cannot
// make every test below vacuously green.
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// `finalize` builds and returns objects on several lines, so bound the slice on
// the next top-level declaration rather than on the first `return {`.
function finalizeBody() {
  const start = CODE.indexOf('function finalize(oc)');
  assert.ok(start !== -1, 'finalize() is a top-level function declaration');
  const rest = CODE.slice(start + 1);
  const end = rest.search(/\n(?:function|const|export|module\.exports)\b/);
  return end === -1 ? rest : rest.slice(0, end);
}

test('the comment strip left the module intact', () => {
  assert.ok(CODE.includes('function finalize(oc)'), 'finalize() survived the strip');
  assert.ok(CODE.includes('const ACTION_TYPES'), 'ACTION_TYPES survived the strip');
  assert.ok(!CODE.includes('#2030'), 'the ticket reference lives only in comments');
});

test('wakeAgent is in the client ACTION_TYPES whitelist', () => {
  const m = CODE.match(/const ACTION_TYPES = \[([^\]]*)\]/);
  assert.ok(m, 'ACTION_TYPES is a literal array');
  const types = m[1].split(',').map(s => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
  assert.deepEqual(types, ['setLabel', 'openPr', 'openIssue', 'wakeAgent', 'none']);
});

test('finalize() carries a wakeAgent to and note through Save', () => {
  const mapBody = finalizeBody();
  assert.match(mapBody, /a\.type === 'wakeAgent'/,
    'finalize must branch on wakeAgent — the generic `{ type: a.type }` arm drops to/note');
  assert.match(mapBody, /type: 'wakeAgent'/);
  assert.match(mapBody, /to: String\(a\.to \|\| ''\)\.trim\(\)/);
  assert.match(mapBody, /note/);
});

test('the client note clamp matches the server\'s cap AND its behaviour', () => {
  // Read the server's half out of its own source rather than importing it:
  // `api/` is CommonJS and is copied into a different image, so the two halves
  // can only be compared as text here. Comparing only the NUMBER would let the
  // two truncate differently — a bare slice drops the tail of a hand-authored
  // note on the next Save with nothing to show it happened, and a slice by
  // UTF-16 unit can split a surrogate pair into a byte sequence that is not
  // valid UTF-8 downstream.
  const api = readFileSync(join(HERE, '..', '..', '..', 'api', 'outcomes.js'), 'utf8');
  const num = (src) => src.match(/const WAKE_NOTE_MAX = (\d+)/);
  const mark = (src) => src.match(/const WAKE_NOTE_TRUNCATION_MARK = ('[^']*')/);
  assert.ok(num(api) && mark(api), 'outcomes.js declares the cap and the marker');
  assert.ok(num(CODE) && mark(CODE), 'the Routing tab declares its own copy of both');
  assert.equal(Number(num(CODE)[1]), Number(num(api)[1]), 'same cap');
  assert.equal(mark(CODE)[1], mark(api)[1], 'same truncation marker');
  // Both clamp on CODE POINTS, not UTF-16 code units.
  assert.match(CODE, /function clampWakeNote\(s\) \{[\s\S]*?Array\.from\(s\)/);
  assert.match(api, /function clampWakeNote\(note\) \{[\s\S]*?Array\.from\(s\)/);
  // …and finalize actually uses it rather than an inline slice.
  assert.match(finalizeBody(), /clampWakeNote\(/);
  assert.ok(!/slice\(0, WAKE_NOTE_MAX\)/.test(finalizeBody()),
    'a bare slice would truncate without the marker');
});

test('finalize() drops an incomplete (to-less) wakeAgent row', () => {
  // Mirrors the empty-setLabel rule directly above it, so Save never sends a
  // shape the server rejects as "wakeAgent action needs a to".
  assert.match(finalizeBody(), /\.filter\(a => a\.type !== 'wakeAgent' \|\| a\.to\)/);
});

test('normalize() hydrates a persisted wakeAgent action', () => {
  // `normalize` spreads each action (`{ ...a }`), which is what makes a
  // round-tripped `to`/`note` re-display. A per-field rebuild here would be
  // the same silent-drop bug as in finalize.
  const body = CODE.slice(CODE.indexOf('function normalize(oc)'), CODE.indexOf('function slug('));
  assert.match(body, /o\.actions\.map\(a => \(\{ \.\.\.a \}\)\)/);
});

test('the wakeAgent row is READ-ONLY here — P1 ships no editor for it', () => {
  // The action-type `<select>` deliberately offers no `wakeAgent` option (that
  // is P2's Flow-Editor work). With `wakeAgent` now in ACTION_TYPES, an
  // editable row would render a select with no matching option and silently
  // rewrite a hand-authored hand-off on the first interaction — so ActionRow
  // returns early for it instead.
  const row = CODE.slice(CODE.indexOf('function ActionRow('), CODE.indexOf('function ModeToggle('));
  const guard = row.indexOf("if (type === 'wakeAgent')");
  const select = row.indexOf('<select');
  assert.ok(guard !== -1, 'ActionRow branches on wakeAgent');
  assert.ok(select !== -1, 'ActionRow still renders the editable select for the other types');
  assert.ok(guard < select, 'the wakeAgent branch returns BEFORE the editable select');
  assert.ok(!row.includes('<option value="wakeAgent"'),
    'the select offers no wakeAgent option in P1');
  // The read-only row still shows what the hand-off does, and can be removed.
  assert.match(row, /hand off directly/);
  assert.match(row, /action\.to/);
});
