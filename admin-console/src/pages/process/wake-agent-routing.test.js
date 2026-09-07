import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// ─── #2030/#2031 — source-reading drift guard over `RoutingSection.jsx` ─────
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
// #2031 makes the row EDITABLE and moves the note cap out to `wake-edge-view.js`
// (a second editor — the Edit-hand-off dialog — now shares it). The read-only
// tripwire P1 planted here is replaced, not deleted: it becomes the assertion
// that the select really does offer the option, which is the precondition P1's
// guard existed to protect.
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
  assert.ok(!CODE.includes('#2031'), 'the ticket reference lives only in comments');
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
  //
  // #2031: the client copy moved to `wake-edge-view.js`, because the Routing tab
  // is no longer the only editor of this field — the Edit-hand-off dialog edits
  // it too, and a third copy of a cap is how caps drift.
  const api = readFileSync(join(HERE, '..', '..', '..', 'api', 'outcomes.js'), 'utf8');
  const view = readFileSync(join(HERE, 'wake-edge-view.js'), 'utf8');
  const num = (src) => src.match(/WAKE_NOTE_MAX = (\d+)/);
  const mark = (src) => src.match(/WAKE_NOTE_TRUNCATION_MARK = ('[^']*')/);
  assert.ok(num(api) && mark(api), 'outcomes.js declares the cap and the marker');
  assert.ok(num(view) && mark(view), 'wake-edge-view.js declares the client copy of both');
  assert.equal(Number(num(view)[1]), Number(num(api)[1]), 'same cap');
  assert.equal(mark(view)[1], mark(api)[1], 'same truncation marker');
  // Both clamp on CODE POINTS, not UTF-16 code units.
  assert.match(view, /function clampWakeNote\(s\) \{[\s\S]*?Array\.from\(/);
  assert.match(api, /function clampWakeNote\(note\) \{[\s\S]*?Array\.from\(s\)/);
  // The Routing tab must IMPORT it, not re-declare a third copy.
  assert.match(CODE, /import \{[^}]*clampWakeNote[^}]*\} from '\.\/wake-edge-view\.js'/);
  assert.ok(!/const WAKE_NOTE_MAX =/.test(CODE), 'no re-declared local cap');
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

test('#2031: the wakeAgent row is EDITABLE — select option, target picker, note', () => {
  // This replaces P1's read-only tripwire. Its point was that `wakeAgent` in
  // ACTION_TYPES without a matching `<option>` renders a persisted hand-off in
  // a select that does not contain its own value, and the first interaction
  // rewrites it into another action type. P2 supplies the option, so the
  // assertion inverts: the option must now BE there.
  const row = CODE.slice(CODE.indexOf('function ActionRow('), CODE.indexOf('function ModeToggle('));
  assert.ok(row.includes('<option value="wakeAgent"'),
    'the action-type select offers the hand-off option — without it, ACTION_TYPES lies');
  // Every ACTION_TYPES member has an option, which is the invariant that makes
  // the select safe for any persisted value (the general form of P1's bug).
  const types = CODE.match(/const ACTION_TYPES = \[([^\]]*)\]/)[1]
    .split(',').map(s2 => s2.trim().replace(/^'|'$/g, '')).filter(Boolean);
  for (const t of types) {
    assert.ok(row.includes(`<option value="${t}"`), `the select is missing an option for ${t}`);
  }
  // No early return any more: a `wakeAgent` row renders the same select as
  // every other type, plus its two extra fields.
  assert.ok(!row.includes("if (type === 'wakeAgent')"),
    'the P1 read-only early return is gone, not merely bypassed');
  assert.match(row, /type === 'wakeAgent' &&/, 'the extra fields are gated on the type');

  // The target picker offers the same set the server accepts (§4.2: another
  // agent on this team) — consumerCandidates already excludes self and humans.
  assert.match(row, /consumerCandidates\(node, peers\)/);
  // A stale target is still listed, so opening the row cannot silently re-point
  // the hand-off to whichever agent sorts first.
  assert.match(row, /not in this flow/);
  // A fresh hand-off starts target-less; `finalize()` then drops the unfinished
  // row rather than wiring a hand-off nobody chose.
  assert.match(row, /type: 'wakeAgent', to: ''/);
  // The note is clamped on input, with the shared cap as the keystroke stop.
  assert.match(row, /clampWakeNote\(e\.target\.value\)/);
  assert.match(row, /maxLength=\{WAKE_NOTE_MAX\}/);
});

test('#2031: ActionRow is actually GIVEN the node and peers it needs', () => {
  // The picker is only as good as its input: `consumerCandidates(node, peers)`
  // silently yields an empty list if the caller does not thread them, and the
  // row would render a select whose only entry is the placeholder.
  assert.match(CODE, /<ActionRow key=\{i\} action=\{a\} node=\{node\} peers=\{peers\}/);
  assert.match(CODE, /function ActionRow\(\{ action, node, peers = \[\], onChange, onRemove \}\)/);
});
