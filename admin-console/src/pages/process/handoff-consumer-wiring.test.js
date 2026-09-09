import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// ─── #2057 direct-hand-off consumer-summary wiring guard ─────────────────────
//
// The derivation and the wording are pure and unit-tested
// (`outcome-consumers.test.js`), but four of this ticket's acceptance criteria
// are facts about the two JSX surfaces, which the `admin-console-src` job cannot
// render (#651). Each of them fails SILENTLY if it rots — the panel keeps
// rendering, it just says the wrong thing again:
//
//   • AC5 — `wakeAgent` falling out of `ACTION_ICONS` again puts the `Ban` icon
//     (this panel's glyph for *set no signal*) on the one action that always
//     wakes someone.
//   • AC1/AC13 — either surface deriving or wording the statement locally
//     instead of through the shared pure module is how the two drifted apart in
//     the first place; #963 extracted `outcome-consumers.js` precisely so they
//     could not.
//   • AC12 — a hand-off row dropping out of `noConsumerYet` again re-offers
//     `mark terminal` / `mark external…`, i.e. offers to declare an outcome
//     with a consumer an open end.
//   • AC9/D2 — a `✕` appearing on the hand-off statement would sit next to one
//     with different commit semantics (that one unwires a listener and applies
//     immediately; this has no listener and is save-gated content).
//
// Source-text guard, not a render test.

const here = dirname(fileURLToPath(import.meta.url));

// Comments are stripped first: this ticket's own comments name the very symbols
// being checked, and would otherwise satisfy the matchers they merely explain.
function sourceOf(rel) {
  return readFileSync(join(here, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
}

const routing = sourceOf('./RoutingSection.jsx');
const outcomesPanel = sourceOf('../agent-chat/OutcomesPanel.jsx');

// Assert the index BEFORE returning it: a bare `indexOf` makes an ordering
// assertion vacuous, since `-1 < x` is trivially true.
function at(src, needle) {
  const i = src.indexOf(needle);
  assert.ok(i > 0, `expected to find ${JSON.stringify(needle)} — this guard needs re-pointing`);
  return i;
}

test('the stripped sources are still the components, not holes', () => {
  // A runaway comment strip would make every assertion below vacuously pass.
  assert.ok(routing.length > 20000, 'RoutingSection.jsx stripped to nothing');
  assert.ok(outcomesPanel.length > 5000, 'OutcomesPanel.jsx stripped to nothing');
  assert.match(routing, /function OutcomeRow\(/);
  assert.match(outcomesPanel, /function ConsumerSummary\(/);
});

test('#2057 AC5: the hand-off action chip is a turning arrow, never the Ban icon', () => {
  const icons = outcomesPanel.slice(
    at(outcomesPanel, 'const ACTION_ICONS'),
    at(outcomesPanel, 'const ACTION_ICONS') + 200,
  );
  assert.match(icons, /wakeAgent:\s*CornerDownRight/);
  assert.doesNotMatch(icons, /wakeAgent:\s*Ban/);
  // `none` keeps Ban — that IS "set no signal", and it is what made the shared
  // fallback wrong for a hand-off.
  assert.match(icons, /none:\s*Ban/);
  assert.match(outcomesPanel, /CornerDownRight/);
  assert.match(outcomesPanel, /from 'lucide-react'/);
});

test('#2057 AC13: both surfaces take the statement from the shared pure module', () => {
  for (const [name, src] of [['RoutingSection.jsx', routing], ['OutcomesPanel.jsx', outcomesPanel]]) {
    assert.match(src, /handoffStatement/, `${name} must not word the statement itself`);
    assert.match(src, /outcome-consumers\.js/, `${name} must import from the shared module`);
  }
  // The Agent-Chat surface reads the row's derived list; the editor derives it
  // beside its own wiring state.
  assert.match(routing, /outcomeHandoffs\(option, node, peers\)/);
  assert.match(outcomesPanel, /row\.handoffs/);
});

test('#2057 AC1: the no-consumer warning only fires when BOTH halves are empty', () => {
  // The warning must live behind the combined guard, not behind the label /
  // marker / person chain alone — that fall-through is the reported defect.
  const guard = at(outcomesPanel, '!signal && !handoffs.length');
  const warning = at(outcomesPanel, 'no consumer — nothing reacts');
  assert.ok(guard < warning, 'the warning must sit inside the combined empty check');
});

test('#2057 AC12: a hand-off row is not offered mark terminal / mark external', () => {
  const declStart = at(routing, 'const noConsumerYet');
  const decl = routing.slice(declStart, routing.indexOf(';', declStart));
  assert.ok(decl.length > 40, 'the noConsumerYet declaration was not captured');
  assert.match(decl, /!handoffs\.length/);
  // The CTAs themselves are still gated on that one flag. `mark terminal` also
  // appears on the outputs row further up the file, so the search starts at the
  // gate rather than at the top.
  const gate = at(routing, '{noConsumerYet && (');
  const ctas = routing.indexOf('mark terminal', gate);
  assert.ok(ctas > gate && ctas - gate < 600,
    'the mark-terminal / mark-external CTAs must stay behind noConsumerYet');
  assert.ok(routing.indexOf('mark external', gate) > gate);
});

test('#2057 AC9/D2: the hand-off statement carries no inline removal affordance', () => {
  const start = at(routing, '{!isNone && handoffs.map(h => (');
  const block = routing.slice(start, start + 400);
  assert.doesNotMatch(block, /unwire\(/, 'a hand-off has no listener to unwire');
  assert.doesNotMatch(block, /<X /, 'no ✕ on the hand-off statement');
  // The existing label/channel chip keeps its own ✕ — unchanged (AC9).
  assert.match(routing, /title=\{`Stop waking \$\{w\.name\}`\}/);
});
