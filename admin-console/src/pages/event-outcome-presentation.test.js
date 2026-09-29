import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  OUTCOME_TONES, NO_MATCH_LABEL, outcomeLabel, outcomeTone, outcomePresentation,
} from './event-outcome-presentation.js';

// #2524: the GitHub Event Log's Outcomes column shows plain text lines instead
// of pill badges. The pure mapping is unit-tested here; the JSX wiring (no
// importable export) is drift-guarded against the page source below, same as
// github-event-log-workitem.test.js.
const src = readFileSync(
  fileURLToPath(new URL('./GithubEventLog.jsx', import.meta.url)),
  'utf8',
);
function block(startMarker, endMarker) {
  const from = src.indexOf(startMarker);
  const to = src.indexOf(endMarker, from);
  assert.notEqual(from, -1, `missing ${startMarker}`);
  assert.notEqual(to, -1, `missing ${endMarker}`);
  return src.slice(from, to);
}
const outcomeBlock = block('/* ── Outcome line (#2524)', '/* ── Work-item cell (#1827)');
const noMatchBlock = block('function NoMatchLine()', '\n}\n');
const columnBlock = block("key: 'outcomes', label: 'Outcomes'", '} },');

test('label wording is unchanged from the pre-#2524 chips', () => {
  assert.equal(outcomeLabel({ status: 'delivered', agentId: 'agent-x' }), 'delivered → agent-x');
  assert.equal(outcomeLabel({ status: 'digest', agentId: 'a', agentName: 'Alpha', wakeLabel: 'ready' }), 'digested (ready) → Alpha');
  assert.equal(
    outcomeLabel({ status: 'dropped', reason: 'wake-already-armed', wakeLabel: 'ready-for-review', agentId: 'agent-studio-2-0-code-reviewer' }),
    'dropped (wake-already-armed) (ready-for-review) → agent-studio-2-0-code-reviewer',
  );
  assert.equal(outcomeLabel({ status: 'dropped', agentId: 'a' }), 'dropped (unknown) → a');
  // null wakeLabel = any-label listener → no suffix (#1846).
  assert.equal(outcomeLabel({ status: 'delivered', agentId: 'a', wakeLabel: null }), 'delivered → a');
  assert.equal(outcomeLabel(null), 'dropped (unknown) → undefined');
});

test('a manually re-fired delivery keeps the "fired again" note (#2525)', () => {
  assert.equal(outcomeLabel({ status: 'delivered', agentId: 'a', wakeLabel: 'ready' }, { refired: true }), 'delivered · fired again (ready) → a');
  assert.equal(outcomePresentation({ status: 'delivered', agentId: 'a' }, { refired: true }).label, 'delivered · fired again → a');
  assert.equal(outcomeLabel({ status: 'dropped', reason: 'throttle', agentId: 'a' }, { refired: true }), 'dropped (throttle) → a');
});

test('AC4: delivered, digested and dropped stay visually distinct (marker shape AND colour)', () => {
  assert.equal(outcomeTone({ status: 'delivered' }), 'delivered');
  assert.equal(outcomeTone({ status: 'digest' }), 'digest');
  assert.equal(outcomeTone({ status: 'throttled' }), 'dropped');
  assert.equal(outcomeTone(undefined), 'dropped');
  const tones = ['delivered', 'digest', 'dropped', 'noMatch'].map(k => OUTCOME_TONES[k]);
  assert.equal(new Set(tones.map(t => t.marker)).size, 4, 'each status has its own marker shape');
  assert.equal(new Set(tones.map(t => t.markerColor)).size, 4, 'each status has its own marker colour');
  // Theme tokens only, so both light and dark theme resolve their own values.
  for (const t of tones) {
    assert.match(t.markerColor, /^var\(--eb-/);
    assert.match(t.textColor, /^var\(--eb-text-/);
  }
  assert.deepEqual(
    outcomePresentation({ status: 'digest', agentId: 'a' }),
    { tone: 'digest', label: 'digested → a', ...OUTCOME_TONES.digest },
  );
});

test('AC8: the no-match indicator is warning-toned plain text', () => {
  assert.equal(NO_MATCH_LABEL, "nobody's listening");
  assert.equal(OUTCOME_TONES.noMatch.markerColor, 'var(--eb-status-warning)');
  assert.match(noMatchBlock, /OUTCOME_TONES\.noMatch/);
  assert.match(noMatchBlock, /title=\{noMatchTooltip\(\)\}/);
});

test('AC1/AC8: no pill border, radius or background in the Outcomes column', () => {
  for (const b of [outcomeBlock, noMatchBlock]) {
    assert.doesNotMatch(b, /borderRadius/);
    assert.doesNotMatch(b, /radius-full/);
    assert.doesNotMatch(b, /status-\w+-bg/);
    assert.doesNotMatch(b, /border: `1px/);
  }
  assert.doesNotMatch(src, /OutcomeChip|NoMatchBadge/);
});

test('AC2/AC3: outcomes stack one per line with spacing', () => {
  assert.match(columnBlock, /<NoMatchLine \/>/);
  assert.match(columnBlock, /<OutcomeLine key=\{i\}/);
  assert.match(columnBlock, /flexDirection: 'column'/);
  assert.match(columnBlock, /gap: 4/);
  assert.doesNotMatch(columnBlock, /flexWrap: 'wrap'/);
});

test('AC5: a delivered session outcome stays a clickable, link-styled button with a hover state', () => {
  assert.match(outcomeBlock, /isSessionOutcome\(outcome\) && correlationId && onOpenSession/);
  assert.match(outcomeBlock, /<button\s+type="button"\s+onClick=\{\(\) => onOpenSession\(outcome\.agentId, correlationId\)\}/);
  assert.match(outcomeBlock, /textDecoration: 'underline'/);
  assert.match(outcomeBlock, /onMouseEnter=\{\(\) => setHover\(true\)\}/);
  assert.match(outcomeBlock, /hover \? 'var\(--eb-accent-hover\)' : 'var\(--eb-accent-primary\)'/);
  // No outline suppression — the global :focus-visible ring stays (keyboard focus).
  assert.doesNotMatch(outcomeBlock, /outline/);
});

test('AC6: each outcome keeps its explanatory hover tooltip', () => {
  assert.match(outcomeBlock, /const explain = refireNote \? `\$\{refireNote\} \$\{outcomeTooltip\(outcome\)\}` : outcomeTooltip\(outcome\)/);
  assert.match(outcomeBlock, /title=\{`\$\{explain\}\\n\\nClick to open the session this event triggered\.`\}/);
  assert.match(outcomeBlock, /title=\{explain \|\| undefined\}/);
});

test('AC7: long unbroken tokens wrap inside the column (#1898)', () => {
  assert.match(outcomeBlock, /overflowWrap: 'anywhere'/);
  assert.match(outcomeBlock, /wordBreak: 'break-word'/);
  assert.match(outcomeBlock, /maxWidth: '100%'/);
  assert.doesNotMatch(outcomeBlock + noMatchBlock, /whiteSpace: 'nowrap'/);
  assert.match(src, /key: 'outcomes', label: 'Outcomes', sortable: false, wrap: true/);
});
