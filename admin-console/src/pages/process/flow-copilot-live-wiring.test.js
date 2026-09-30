import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// ─── #2556 source-reading drift guard ────────────────────────────────────────
//
// The live-team Copilot's decisions are pure and tested in
// flow-copilot-live.test.js. What those tests cannot see is whether the JSX
// still wires them: the confirmation actually gating the writes, the staleness
// check before them, removals starting unticked, the edit-rights probe, and
// every write going through an existing route. Read as source (#651).

const here = dirname(fileURLToPath(import.meta.url));
const src = (rel) => readFileSync(join(here, rel), 'utf8');
const code = (rel) => src(rel)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

const panel = code('./FlowCopilotPanel.jsx');
const dialog = code('./LiveApplyDialog.jsx');
const canvas = code('../ProcessCanvas.jsx');
const provider = code('../../context/FlowCopilotContext.jsx');

test('AC2/AC4 — a live Apply only opens the confirmation; the writes run from its Confirm', () => {
  assert.match(panel, /if \(isTeam\) \{ openLiveConfirm\(\); return; \}/);
  // runLiveApply is reached only from the confirm handler.
  const runs = panel.match(/runLiveApply\(/g) || [];
  assert.equal(runs.length, 1);
  const confirmFn = panel.slice(panel.indexOf('const confirmLiveApply'), panel.indexOf('const regenerate'));
  assert.match(confirmFn, /runLiveApply\(plan, live\.call\)/);
  assert.match(confirmFn, /confirm\.phase !== 'ready'/);
  // Cancel closes the dialog and nothing else — the proposal stays (AC4).
  assert.match(panel, /onCancel=\{\(\) => setConfirm\(null\)\}/);
  assert.match(dialog, /running agents immediately/);
});

test('AC15 — staleness is checked when the dialog opens AND again right before the writes', () => {
  const openFn = panel.slice(panel.indexOf('const openLiveConfirm'), panel.indexOf('const confirmLiveApply'));
  const confirmFn = panel.slice(panel.indexOf('const confirmLiveApply'), panel.indexOf('const regenerate'));
  assert.match(openFn, /isStaleBase\(pending\.baseBundle, current\)/);
  assert.match(confirmFn, /isStaleBase\(pending\.baseBundle, current\)[\s\S]*planLiveApply/);
  assert.match(dialog, /onClick=\{onRegenerate\}/);
  // The provider keeps the bundle the turn was generated from.
  assert.match(provider, /baseBundle: bundle \|\| null/);
});

test('AC14 — removals start unticked and only ticked ones reach the plan', () => {
  assert.match(panel, /selected: new Set\(\)/);
  assert.match(panel, /selectedRemovals: confirm\.selected/);
  assert.match(dialog, /checked=\{selected\.has\(r\.key\)\}/);
});

test('AC7 — the committed card carries the result and a status that never claims a partial success', () => {
  assert.match(panel, /commitPending\(liveResultStatus\(summary\), \{ result: summary\.text \}\)/);
});

test('AC8/AC16 — edit rights come from the shared-history GET; without them there is no composer', () => {
  assert.match(canvas, /apiCall\('GET', `\/api\/teams\/\$\{encodeURIComponent\(scope\)\}\/copilot-history`\)/);
  assert.match(canvas, /e\.status === 403/);
  assert.match(panel, /\{isTeam && canEdit !== true \? \(/);
  assert.match(panel, /const canChat = mode === 'draft' \|\| \(isTeam && canEdit === true\);/);
  // History is written to the team's shared store, not the draft file.
  assert.match(canvas, /apiCall\('PUT', `\/api\/teams\/\$\{encodeURIComponent\(scope\)\}\/copilot-history`/);
});

test('constraint — every live write goes through an existing route (no new write path)', () => {
  const transport = canvas.slice(canvas.indexOf('const liveCopilotTransport'), canvas.indexOf('const proposalDiff'));
  assert.match(transport, /liveOps\.createTrigger\(step\.memberId, step\.body\)/);
  assert.match(transport, /apiCall\(step\.method, step\.url, step\.body\)/);
});

test('AC10/AC9 — Edit as draft stays reachable and the panel says what Extend does not carry back', () => {
  assert.match(panel, /<LiveTeamNotice onEditAsDraft=\{onEditAsDraft\} \/>/);
  assert.match(panel, /only adds roles that don't exist yet/);
});

test('AC13 — the draft path is unchanged: Apply to draft still writes the whole bundle', () => {
  assert.match(panel, /await onApplyBundle\(pending\.bundle, toPersistedMessages\(next\)\)/);
  assert.match(canvas, /onApplyBundle=\{applyCopilotBundle\}/);
});
