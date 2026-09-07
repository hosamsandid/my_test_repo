import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  WAKE_EDGE_COLOR, WAKE_EDGE_LEGEND, WAKE_GLYPH,
  wakeChipText, wakeEdgeIsAmbiguous,
} from './wake-edge-view.js';

const RENDER = new URL('./flow-graph-render.js', import.meta.url);
// Comments quote the neighbouring colours and the `⇥` glyph they must not
// reuse, so a raw read would satisfy every assertion below from prose alone.
const renderSource = () => readFileSync(RENDER, 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|\s)\/\/.*$/gm, '$1');

const nameOf = (id) => ({ rev: 'Reviewer', docs: 'Doc Sync' }[id] || id);
const titleOf = (from, oc) => ({ 'dev|approved': 'Approved', 'dev|second-look': 'Second look' }[`${from}|${oc}`] || oc);

// ── the chip ────────────────────────────────────────────────────────────────

test('a lone hand-off chip is the short `↪ <Target>` form', () => {
  const e = { on: 'wake', from: 'dev', to: 'rev', outcome: 'approved' };
  assert.equal(wakeChipText(e, nameOf, titleOf, false), '↪ Reviewer');
});

test('the chip falls back to the target id when it has no display name', () => {
  const e = { on: 'wake', from: 'dev', to: 'unnamed', outcome: 'o' };
  assert.equal(wakeChipText(e, nameOf, titleOf, false), '↪ unnamed');
  // Never a dangling glyph: a chip reading just "↪" would say nothing at all.
  assert.equal(wakeChipText({ on: 'wake', from: 'dev' }, nameOf, titleOf, false), '↪');
});

test('two hand-offs to ONE target are disambiguated by the outcome title', () => {
  // Both edges are drawn (edgeId keys them on the outcome), so two identical
  // `↪ Reviewer` chips would be unreadable at exactly the wrong moment.
  const a = { on: 'wake', from: 'dev', to: 'rev', outcome: 'approved' };
  const b = { on: 'wake', from: 'dev', to: 'rev', outcome: 'second-look' };
  assert.equal(wakeChipText(a, nameOf, titleOf, true), '↪ Reviewer · Approved');
  assert.equal(wakeChipText(b, nameOf, titleOf, true), '↪ Reviewer · Second look');
  assert.notEqual(wakeChipText(a, nameOf, titleOf, true), wakeChipText(b, nameOf, titleOf, true));
});

test('an unresolvable outcome title degrades to the short form, never a trailing separator', () => {
  const e = { on: 'wake', from: 'dev', to: 'rev', outcome: 'gone' };
  assert.equal(wakeChipText(e, nameOf, () => '', true), '↪ Reviewer');
});

// ── ambiguity is counted over the DRAWN edges ───────────────────────────────

test('ambiguity counts drawn wake edges for the same (from, to) pair', () => {
  const edges = [
    { on: 'wake', from: 'dev', to: 'rev', outcome: 'approved' },
    { on: 'wake', from: 'dev', to: 'rev', outcome: 'second-look' },
    { on: 'wake', from: 'dev', to: 'docs', outcome: 'shipped' },
    { on: 'label', from: 'dev', to: 'rev', label: 'ready' },
  ];
  assert.equal(wakeEdgeIsAmbiguous(edges, edges[0]), true);
  assert.equal(wakeEdgeIsAmbiguous(edges, edges[1]), true);
  // One hand-off to docs → short form, even though dev hands off twice overall.
  assert.equal(wakeEdgeIsAmbiguous(edges, edges[2]), false);
  // A label edge between the same pair is a different mechanism, not a sibling.
  assert.equal(wakeEdgeIsAmbiguous([edges[0], edges[3]], edges[0]), false);
});

test('ambiguity reads the drawn set, so a WITHHELD hand-off cannot make a sibling ambiguous', () => {
  // process-graph withholds an unknown-target / self-wake edge. Reading the
  // producer's outcomes instead would count those and disambiguate a chip whose
  // canvas has only one line — the reason this takes `edges`, not a node.
  const drawn = [{ on: 'wake', from: 'dev', to: 'rev', outcome: 'approved' }];
  assert.equal(wakeEdgeIsAmbiguous(drawn, drawn[0]), false);
});

test('ambiguity guards a missing endpoint and a non-array edge set', () => {
  assert.equal(wakeEdgeIsAmbiguous([], { on: 'wake', from: 'dev' }), false);
  assert.equal(wakeEdgeIsAmbiguous(undefined, { on: 'wake', from: 'dev', to: 'rev' }), false);
  assert.equal(wakeEdgeIsAmbiguous([null, undefined], { on: 'wake', from: 'dev', to: 'rev' }), false);
});

// ── the visual language (concept §10) ───────────────────────────────────────

test('the glyph is NOT the claim marker `⇥`', () => {
  // Concept §10 proposes `⇥`; it is already CLAIM_MARKER in
  // src/pages/agent-chat/trigger-summary.js and is rendered on THIS canvas as
  // the `⇥ wip` badge of a claiming label listener. One glyph, two meanings, one
  // screen — the deviation is the point, so pin it.
  const claim = readFileSync(new URL('../agent-chat/trigger-summary.js', import.meta.url), 'utf8');
  assert.match(claim, /CLAIM_MARKER\s*=\s*'⇥'/, 'the claim marker is still ⇥');
  assert.notEqual(WAKE_GLYPH, '⇥');
  assert.equal(WAKE_GLYPH, '↪');
});

test('the hue is none of the neighbouring edge families', () => {
  // §10's distinctness table, as an assertion rather than a comment.
  const taken = {
    label: '#3b82f6', outcome: '#eab308', artifact: '#22c55e', dependency: '#ef4444',
    gate: '#dc2626', handoff: '#e11d48', review: '#f59e0b', event: '#f97316',
    timer: '#0ea5e9', webhook: '#eab308', loop: '#d946ef', pr: '#8b5cf6', issue: '#14b8a6',
  };
  for (const [name, hex] of Object.entries(taken)) {
    assert.notEqual(WAKE_EDGE_COLOR, hex, `the wake hue must not collide with ${name}`);
  }
  assert.equal(WAKE_EDGE_COLOR, '#6366f1');
});

// ── drift guards over the renderer (#651: it is DOM code, not importable) ────

test('the renderer registers a `wake` style that is SOLID', () => {
  const src = renderSource();
  assert.match(src, /wake:\s*\{\s*color:\s*WAKE_EDGE_COLOR,\s*label:\s*WAKE_EDGE_LEGEND\s*\}/,
    'EDGE_STYLES.wake reads its hue/legend from the pure module');
  // No `dashed` on the entry: dotted/dashed already means "internal transport of
  // a label", and a direct hand-off carries no label to transport.
  assert.doesNotMatch(src, /wake:\s*\{[^}]*dashed/, 'the wake style must stay solid');
  assert.equal(WAKE_EDGE_LEGEND, 'direct hand-off');
});

test('a wake edge is admitted for drawing and listed in the FIXED legend key list', () => {
  const src = renderSource();
  const extra = src.match(/const EXTRA = new Set\(\[([^\]]*)\]\)/);
  assert.ok(extra, 'the EXTRA admission set is still there');
  assert.match(extra[1], /'wake'/, "an `on` missing from EXTRA never gets a line");

  const keys = src.match(/const keys = \[([^\]]*)\]/);
  assert.ok(keys, 'the legend key list is still a fixed array');
  assert.match(keys[1], /'wake'/, 'the legend is not derived — an unlisted edge draws no key');
  // Next to `label`: the two agent→agent hand-off mechanisms read as a pair.
  const order = keys[1].split(',').map(s => s.trim().replace(/'/g, ''));
  assert.equal(order[order.indexOf('label') + 1], 'wake');
});

test('the wake branch is evaluated BEFORE the amber outcome-keyed branch', () => {
  // A wake edge always carries an `outcome` (edgeId keys on it), so an
  // isOutcome-first colour/text chain would render every direct hand-off as a
  // generic ◇ switch edge. Assert the precedence in both expressions.
  const src = renderSource();
  const colour = src.match(/color: isGithub \? GH_COLOR\[artifact\][\s\S]{0,240}?,\n\s*width:/);
  assert.ok(colour, 'the agent→agent colour chain is still there');
  assert.ok(colour[0].indexOf('isWake') < colour[0].indexOf('isOutcome'),
    'isWake must be tested before isOutcome in the colour chain');

  const text = src.match(/labelText: isGithub \? channelChipText\(e\)[\s\S]{0,320}?\n\s*chip:/);
  assert.ok(text, 'the agent→agent labelText chain is still there');
  assert.ok(text[0].indexOf('isWake') < text[0].indexOf('isOutcome'),
    'isWake must be tested before isOutcome in the labelText chain');
});

test('a wake edge draws a filled chip and carries its note into the click payload', () => {
  const src = renderSource();
  assert.match(src, /chip: isGithub \|\| isWake/,
    'the chip is a filled pill — the `↪ <Target>` text is the whole edge content');
  // The dialog edits the note in place and there is no trigger behind a wake
  // edge to re-read it from, so losing it here loses it entirely.
  assert.match(src, /\.\.\.\(e\.note \? \{ note: e\.note \} : \{\}\)/);
});

test('the renderer resolves a target name from `title`, not `displayName`', () => {
  // A `state.byId` entry is a *briefing* object, built in setData as
  // `{ id, title: n.displayName || n.id, … }` — the unified node's
  // `displayName` does not survive into it. Reading `displayName` there falls
  // through to the raw id on EVERY chip and never reports anything, so the whole
  // `↪ <Target>` affordance silently degrades to `↪ acme-code-reviewer`.
  const src = renderSource();
  assert.match(src, /state\.briefings = nodes\.map\(n => \(\{\s*id: n\.id,\s*title: n\.displayName \|\| n\.id/,
    'the byId entry still puts the name on `title`');
  const fn = src.match(/function nodeDisplayName\(id\) \{[\s\S]*?\n {2}\}/);
  assert.ok(fn, 'nodeDisplayName is still a named function');
  assert.match(fn[0], /n\.title \|\| n\.id/);
  assert.doesNotMatch(fn[0], /n\.displayName/,
    'reading displayName off a byId entry always yields undefined');
});
