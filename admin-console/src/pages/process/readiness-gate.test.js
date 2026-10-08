import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import serverPt from '../../../api/process-template.js';
import {
  DEFAULT_FAILURE_LABEL, DEFAULT_TIMEOUT_MINUTES, MAX_TIMEOUT_MINUTES, READINESS_EVENTS, NEW_HANDOFF_READINESS,
  gateable, readinessForm, readinessFormError, readinessFromForm, readinessSummary, newHandoffReadiness, readinessWaitsFor,
  toggleReadiness, readinessChipTag,
} from './readiness-gate.js';
import { upsertChannel, editChannel } from './channel-ops.js';
import { wireLabelHandoff, updateLabelHandoff, wireChannel, updateChannel } from './wiring-engine.js';
import { onBoth } from './test-fakes.js';

// #2795 — the hand-off readiness gate in the Flow editor's dialogs.

const src = (f) => readFileSync(new URL(f, import.meta.url), 'utf8');

test('constants mirror the server rules', () => {
  assert.equal(DEFAULT_FAILURE_LABEL, serverPt.READINESS_DEFAULT_FAILURE_LABEL);
  assert.equal(DEFAULT_TIMEOUT_MINUTES, serverPt.READINESS_DEFAULT_TIMEOUT_MINUTES);
  assert.equal(MAX_TIMEOUT_MINUTES, serverPt.READINESS_MAX_TIMEOUT_MINUTES);
  assert.deepEqual(READINESS_EVENTS, serverPt.READINESS_EVENTS);
});

test('gateable: PR hand-offs only', () => {
  assert.equal(gateable({ artifact: 'pr' }), true);
  assert.equal(gateable({ artifact: 'issue' }), false);
  assert.equal(gateable({ event: 'pull_request.labeled' }), true);
  assert.equal(gateable({ event: 'issues.labeled' }), false);
  assert.equal(gateable({ event: 'pull_request.unlabeled' }), false);
});

test('AC11/AC12: a new hand-off starts gated; an existing one shows exactly what is stored', () => {
  const fresh = readinessForm(null, { isNew: true });
  assert.equal(fresh.ci, true);
  assert.equal(fresh.conflict, true);
  assert.deepEqual(readinessFromForm(fresh), { ci: true, conflict: true });
  assert.deepEqual(readinessFromForm(fresh), NEW_HANDOFF_READINESS);
  // An old hand-off without a gate opens — and saves — ungated.
  const old = readinessForm(undefined);
  assert.equal(old.ci || old.conflict, false);
  assert.equal(readinessFromForm(old), null);
  // A stored gate round-trips unchanged.
  const stored = { ci: true, conflict: false, failureLabel: 'fix-me', timeoutMinutes: 90 };
  assert.deepEqual(readinessFromForm(readinessForm(stored)), stored);
});

test('readinessFromForm: defaults are not written; both off = no gate', () => {
  assert.deepEqual(readinessFromForm({ ci: true, conflict: true, failureLabel: ' revisions-required ', timeoutMinutes: '60' }),
    { ci: true, conflict: true });
  assert.deepEqual(readinessFromForm({ ci: false, conflict: true, failureLabel: '', timeoutMinutes: '' }),
    { ci: false, conflict: true });
  assert.equal(readinessFromForm({ ci: false, conflict: false, failureLabel: 'x', timeoutMinutes: '5' }), null);
});

test('readinessFormError: label, timeout and wake-label rules; off is never an error', () => {
  const on = { ci: true, conflict: true, failureLabel: DEFAULT_FAILURE_LABEL, timeoutMinutes: '60' };
  assert.equal(readinessFormError(on), null);
  assert.match(readinessFormError({ ...on, timeoutMinutes: '0' }), /1 to 10080/);
  assert.match(readinessFormError({ ...on, timeoutMinutes: '10081' }), /1 to 10080/);
  assert.match(readinessFormError({ ...on, timeoutMinutes: '1.5' }), /whole number/);
  assert.match(readinessFormError({ ...on, failureLabel: 'ready' }, { wakeLabel: 'ready' }), /must differ/);
  assert.match(readinessFormError({ ...on, failureLabel: 'a,b' }), /Failure label/);
  assert.equal(readinessFormError({ ...on, ci: false, conflict: false, timeoutMinutes: 'nope' }), null);
});

test('parity: what the dialog saves, the server accepts unchanged', () => {
  const forms = [
    readinessForm(null, { isNew: true }),
    { ci: true, conflict: false, failureLabel: 'fix-me', timeoutMinutes: '15' },
    { ci: false, conflict: true, failureLabel: '', timeoutMinutes: '10080' },
  ];
  for (const f of forms) {
    assert.equal(readinessFormError(f, { wakeLabel: 'ready-for-review' }), null);
    const v = readinessFromForm(f);
    assert.equal(serverPt.readinessError(v, { wakeLabel: 'ready-for-review' }), null);
    assert.deepEqual(serverPt.cleanReadiness(v), v, 'the client already writes the canonical form');
  }
  // …and what the client refuses, the server refuses too.
  for (const [f, wl] of [
    [{ ci: true, conflict: true, failureLabel: 'x', timeoutMinutes: '0' }, ''],
    [{ ci: true, conflict: true, failureLabel: 'go', timeoutMinutes: '60' }, 'go'],
    [{ ci: true, conflict: true, failureLabel: 'x'.repeat(51), timeoutMinutes: '60' }, ''],
  ]) {
    assert.ok(readinessFormError(f, { wakeLabel: wl }));
    const raw = { ci: f.ci, conflict: f.conflict, failureLabel: f.failureLabel, timeoutMinutes: Number(f.timeoutMinutes) };
    assert.ok(serverPt.readinessError(raw, { wakeLabel: wl }));
  }
});

test('readinessSummary names what is held and where failures go', () => {
  assert.equal(readinessSummary(null), '');
  assert.equal(readinessSummary({ ci: false, conflict: false }), '');
  assert.equal(readinessSummary({ ci: true, conflict: true }),
    'Waits for CI and a conflict-free PR (60 min, then needs-human); on failure → revisions-required');
});

test('channel-ops: the gate rides on a PR channel, never an issue one; editing keeps it (#2717)', () => {
  let ch = upsertChannel([], { artifact: 'pr', from: 'dev', label: 'ready-for-review', readiness: { ci: true, conflict: true } });
  assert.deepEqual(ch[0].readiness, { ci: true, conflict: true });
  assert.ok(!('readiness' in upsertChannel([], { artifact: 'issue', from: 'dev', readiness: { ci: true } })[0]));
  // An edit that does not touch the gate keeps it; a label rename too.
  ch = editChannel(ch, 'ready-for-review', { artifact: 'pr', from: 'dev', label: 'review-me', wakePrompt: 'x' });
  assert.equal(ch.length, 1);
  assert.deepEqual(ch[0].readiness, { ci: true, conflict: true });
  // Switching it off (null) drops the key.
  ch = editChannel(ch, 'review-me', { artifact: 'pr', from: 'dev', label: 'review-me', readiness: null });
  assert.ok(!('readiness' in ch[0]));
});

test('wiring engine: PR label listener and PR channel carry the gate; issue hand-offs never do', async () => {
  const state = await onBoth(async (ctx) => {
    await wireLabelHandoff(ctx, { from: 'ba', to: 'dev', label: 'go-pr', target: 'pull_request', prompt: 'x', readinessGate: { ci: true, conflict: true } });
    await wireLabelHandoff(ctx, { from: 'ba', to: 'dev', label: 'go-issue', target: 'issues', prompt: 'x', readinessGate: { ci: true, conflict: true } });
    await wireChannel(ctx, { from: 'ba', to: 'dev', artifact: 'pr', label: 'review', readiness: { ci: true, conflict: false } });
    await wireChannel(ctx, { from: 'ba', to: 'dev', artifact: 'issue', label: 'spec', readiness: { ci: true } });
  });
  const pr = state.roles.dev.triggers.find(t => t.labelFilter === 'go-pr');
  const issue = state.roles.dev.triggers.find(t => t.labelFilter === 'go-issue');
  assert.deepEqual(pr.readinessGate, { ci: true, conflict: true });
  assert.ok(!('readinessGate' in issue));
  const qa = state.roles.dev.channels;
  assert.deepEqual(qa.find(c => c.artifact === 'pr').readiness, { ci: true, conflict: false });
  assert.ok(!('readiness' in qa.find(c => c.artifact === 'issue')));
});

test('wiring engine: updateLabelHandoff sets, keeps and clears the gate', async () => {
  const state = await onBoth(async (ctx) => {
    await wireLabelHandoff(ctx, { from: 'ba', to: 'dev', label: 'go', target: 'pull_request', prompt: 'x' });
    const tid = (await ctx.ops.listTriggers('dev'))[0].id;
    await updateLabelHandoff(ctx, { from: 'ba', to: 'dev', triggerId: tid, label: 'go', newLabel: 'go', target: 'pull_request', prompt: 'x',
      readinessGate: { ci: true, conflict: true, timeoutMinutes: 30 } });
    // Omitted = untouched.
    await updateLabelHandoff(ctx, { from: 'ba', to: 'dev', triggerId: tid, label: 'go', newLabel: 'go', target: 'pull_request', prompt: 'y' });
  });
  assert.deepEqual(state.roles.dev.triggers[0].readinessGate, { ci: true, conflict: true, timeoutMinutes: 30 });

  const off = await onBoth(async (ctx) => {
    await wireLabelHandoff(ctx, { from: 'ba', to: 'dev', label: 'go', target: 'pull_request', prompt: 'x', readinessGate: { ci: true, conflict: true } });
    const tid = (await ctx.ops.listTriggers('dev'))[0].id;
    // Switched off, or the hand-off moved to an issue label: the gate goes.
    await updateLabelHandoff(ctx, { from: 'ba', to: 'dev', triggerId: tid, label: 'go', newLabel: 'go', target: 'issues', prompt: 'x',
      readinessGate: { ci: true, conflict: true } });
  });
  assert.ok(!off.roles.dev.triggers[0].readinessGate);

  const ch = await onBoth(async (ctx) => {
    await wireChannel(ctx, { from: 'ba', to: 'dev', artifact: 'pr', label: 'review', readiness: { ci: true, conflict: true } });
    await updateChannel(ctx, { to: 'dev', prevLabel: 'review', spec: { artifact: 'pr', from: 'ba', label: 'review', wakePrompt: '' } });
  });
  assert.deepEqual(ch.roles.dev.channels[0].readiness, { ci: true, conflict: true }, 'an edit without the gate keeps it');
});

test('source: every PR hand-off dialog offers the gate and passes it to the engine (AC1, AC11)', () => {
  const s = src('./EdgeDialogs.jsx');
  const body = (from, to) => s.slice(s.indexOf(from), s.indexOf(to, s.indexOf(from) + 1));
  const create = body('export function CreateHandoffDialog', 'export function CreateEdgeDialog');
  assert.match(create, /readinessForm\(null, \{ isNew: true, wakeLabel: initialLabel \}\)/);
  assert.match(create, /readinessGate: readinessFromForm\(readiness\)/);
  assert.match(create, /<ReadinessGateFields /);
  const channel = body('export function CreateChannelDialog', 'export function AgentToPersonDialog');
  assert.match(channel, /readinessForm\(null, \{ isNew: true \}\)/);
  assert.match(channel, /readiness: readinessFromForm\(readiness\)/);
  assert.match(channel, /<ReadinessGateFields /);
  const editCh = body('function EditChannelDialog', 'function EditLabelHandoff');
  assert.match(editCh, /readinessForm\(edge\.readiness\)/, 'edit shows the stored state (AC12)');
  assert.match(editCh, /readiness: readinessFromForm\(readiness\)/);
  const editLbl = body('function EditLabelHandoff', 'function RemoveEdgeDialog');
  assert.match(editLbl, /setReadiness\(readinessForm\(t\.readinessGate\)\)/);
  assert.match(editLbl, /readinessGate: gated \? readinessFromForm\(readiness\) : null/);
  // The two toggles + failure label + timeout.
  assert.match(s, /import ReadinessGateFields from '\.\/ReadinessGateFields';/);
  const shared = src('./ReadinessGateFields.jsx');
  const fields = shared.slice(shared.indexOf('export default function ReadinessGateFields'), shared.indexOf('function Field('));
  for (const re of [/Wait for CI/, /Block on merge conflict/, /On failure, set label/, /Timeout \(minutes\)/]) {
    assert.match(fields, re);
  }
});

test('source: the routing inspector keeps the gate when editing and defaults one-click PR wiring to on', () => {
  const s = src('./RoutingSection.jsx');
  assert.match(s, /readiness: editChannel\.readiness, wakePrompt: editChannel\.wakePrompt/);
  assert.match(s, /readinessGate: newHandoffReadiness\(wireSpec\.label\)/);
  assert.match(src('./ReadinessToggles.jsx'), /waits for \{readinessWaitsFor\(value\)\}/, 'the read-only hint wording is shared with Agent Chat (#2912)');
  assert.match(s, /wireSpec\.artifact === 'pr' \? \{ readiness: \{ \.\.\.NEW_HANDOFF_READINESS \} \} : \{\}/);
  // The draft adapter drops a switched-off gate like the live PUT does.
  assert.match(src('./edit-adapters.js'), /if \(t && t\.readinessGate === null\) delete t\.readinessGate;/);
  // The channel edge carries the stored gate to the edit dialog.
  assert.match(src('../../../api/unified-graph.js'), /artifact === 'pr' && ch\.readiness && typeof ch\.readiness === 'object' \? \{ readiness: ch\.readiness \}/);
});

test('a gate whose default failure label is the wake label is refused, and a new hand-off on it starts ungated (review B3)', () => {
  const on = { ci: true, conflict: true, failureLabel: '', timeoutMinutes: '' };
  // Left empty, the failure label is the default — the same as this wake label.
  assert.match(readinessFormError(on, { wakeLabel: DEFAULT_FAILURE_LABEL }), /must differ/);
  assert.match(readinessFormError({ ...on, failureLabel: DEFAULT_FAILURE_LABEL }, { wakeLabel: DEFAULT_FAILURE_LABEL }), /must differ/);
  assert.equal(readinessFormError({ ...on, failureLabel: 'fix-me' }, { wakeLabel: DEFAULT_FAILURE_LABEL }), null);
  assert.equal(readinessFormError({ ...on, ci: false, conflict: false }, { wakeLabel: DEFAULT_FAILURE_LABEL }), null);
  // The server agrees.
  assert.match(serverPt.readinessError({ ci: true }, { wakeLabel: DEFAULT_FAILURE_LABEL }), /must differ/);
  // One-click and dialog defaults: no loop-prone gate on the default failure label.
  assert.equal(newHandoffReadiness(DEFAULT_FAILURE_LABEL), null);
  assert.deepEqual(newHandoffReadiness('ready-for-review'), { ...NEW_HANDOFF_READINESS });
  const fresh = readinessForm(null, { isNew: true, wakeLabel: DEFAULT_FAILURE_LABEL });
  assert.equal(fresh.ci || fresh.conflict, false);
  assert.equal(readinessFormError(fresh, { wakeLabel: DEFAULT_FAILURE_LABEL }), null, 'a brand-new hand-off with all defaults saves');
  assert.equal(readinessForm(null, { isNew: true, wakeLabel: 'ready-for-review' }).ci, true);
  assert.match(src('./EdgeDialogs.jsx'), /readinessForm\(null, \{ isNew: true, wakeLabel: initialLabel \}\)/);
});

test('readinessWaitsFor: the short hint shared by the routing rows and Agent Chat (#2912)', () => {
  assert.equal(readinessWaitsFor({ ci: true, conflict: true }), 'CI + conflict-free');
  assert.equal(readinessWaitsFor({ ci: true, conflict: false }), 'CI');
  assert.equal(readinessWaitsFor({ ci: false, conflict: true }), 'conflict-free');
  assert.equal(readinessWaitsFor({ ci: false, conflict: false }), '');
  assert.equal(readinessWaitsFor(null), '');
  assert.equal(readinessWaitsFor([]), '');
});

// #2913 — the gate's two toggles inline in the Flow editor's Inputs list.

test('toggleReadiness: one toggle switched, failure label and timeout kept, both off clears', () => {
  const stored = { ci: true, conflict: true, failureLabel: 'fix-me', timeoutMinutes: 90 };
  assert.deepEqual(toggleReadiness(stored, 'ci', false), { readiness: { ci: false, conflict: true, failureLabel: 'fix-me', timeoutMinutes: 90 } });
  assert.deepEqual(toggleReadiness({ ci: false, conflict: true }, 'conflict', false), { readiness: null });
  assert.deepEqual(toggleReadiness(undefined, 'ci', true, { wakeLabel: 'ready-for-review' }), { readiness: { ci: true, conflict: false } });
  assert.deepEqual(toggleReadiness(null, 'conflict', true), { readiness: { ci: false, conflict: true } });
  // The dialog's rules apply: the default failure label's own hand-off cannot be gated…
  assert.match(toggleReadiness(null, 'ci', true, { wakeLabel: DEFAULT_FAILURE_LABEL }).error, /must differ/);
  // …but can always be switched off.
  assert.deepEqual(toggleReadiness({ ci: true, conflict: false }, 'ci', false, { wakeLabel: DEFAULT_FAILURE_LABEL }), { readiness: null });
  assert.throws(() => toggleReadiness(null, 'timeout', true), /unknown readiness toggle/);
  // What an inline toggle saves, the dialog would save for the same state.
  const form = { ...readinessForm(stored), ci: false };
  assert.deepEqual(toggleReadiness(stored, 'ci', false).readiness, readinessFromForm(form));
  // …and the server accepts it unchanged.
  const v = toggleReadiness(stored, 'conflict', false).readiness;
  assert.equal(serverPt.readinessError(v, { wakeLabel: 'ready-for-review' }), null);
  assert.deepEqual(serverPt.cleanReadiness(v), v);
});

test('readinessChipTag: the canvas tag of a gated PR hand-off (AC6)', () => {
  assert.equal(readinessChipTag({ ci: true, conflict: true }), '⏳CI+clean');
  assert.equal(readinessChipTag({ ci: true, conflict: false }), '⏳CI');
  assert.equal(readinessChipTag({ ci: false, conflict: true }), '⏳clean');
  assert.equal(readinessChipTag({ ci: false, conflict: false }), '');
  assert.equal(readinessChipTag(null), '');
  assert.equal(readinessChipTag([]), '');
});

test('AC2/AC4: an inline toggle saves through the dialog\'s path and the dialog reads it back (live + draft)', async () => {
  const state = await onBoth(async (ctx) => {
    await wireChannel(ctx, { from: 'ba', to: 'dev', artifact: 'pr', label: 'review', wakePrompt: 'keep me', readiness: { ci: true, conflict: true, failureLabel: 'fix-me' } });
    await wireLabelHandoff(ctx, { from: 'ba', to: 'dev', label: 'go', target: 'pull_request', prompt: 'x' });
    // The routing row's channel toggle: the stored port, one gate switched.
    const ch = { artifact: 'pr', from: 'ba', label: 'review', readiness: { ci: true, conflict: true, failureLabel: 'fix-me' } };
    await updateChannel(ctx, { to: 'dev', prevLabel: 'review', spec: {
      artifact: 'pr', from: 'ba', label: 'review', readiness: toggleReadiness(ch.readiness, 'ci', false, { wakeLabel: 'review' }).readiness,
    } });
    // The routing row's label hand-off toggle: the listener's gate.
    const t = (await ctx.ops.listTriggers('dev')).find(x => x.labelFilter === 'go');
    await ctx.ops.updateTrigger('dev', t.id, { readinessGate: toggleReadiness(t.readinessGate, 'conflict', true, { wakeLabel: 'go' }).readiness });
  });
  const ch = state.roles.dev.channels[0];
  assert.deepEqual(ch.readiness, { ci: false, conflict: true, failureLabel: 'fix-me' });
  assert.equal(ch.wakePrompt, 'keep me', 'fields the toggle does not edit survive');
  // The edge dialog opens on exactly this state.
  assert.deepEqual(readinessForm(ch.readiness), { ci: false, conflict: true, failureLabel: 'fix-me', timeoutMinutes: '60' });
  const t = state.roles.dev.triggers.find(x => x.labelFilter === 'go');
  assert.deepEqual(t.readinessGate, { ci: false, conflict: true });
});

test('source: the Inputs list offers the toggles on PR hand-offs only, read-only without edit ops (AC1, AC3, AC5)', () => {
  const s = src('./RoutingSection.jsx');
  assert.match(s, /import ReadinessToggles from '\.\/ReadinessToggles';/);
  // Channel rows: PR only, saved via the engine like the dialog.
  assert.match(s, /subtitle=\{c\.artifact === 'pr' \? \(\s*<ReadinessToggles value=\{c\.readiness\}/);
  assert.match(s, /onToggle=\{ops\.updateChannel \? \(k, on\) => toggleChannelGate\(key, c, k, on\) : null\}/);
  assert.match(s, /run\(key, \(\) => engineUpdateChannel\(\{ ops \}, \{\s*to: node\.id, prevLabel: c\.label \|\| ''/);
  // Label hand-off listeners: only where the gate applies (PR events).
  assert.match(s, /readiness=\{showsReadinessGate\(t\.type, t\.events\) \? \(\s*<ReadinessToggles value=\{t\.readinessGate\}/);
  assert.match(s, /onToggle=\{ops\.updateTrigger \? \(k, on\) => toggleTriggerGate\(t, k, on\) : null\}/);
  assert.match(s, /ops\.updateTrigger\(node\.id, t\.id, \{ readinessGate: gateNext\(/);
  const tg = src('./ReadinessToggles.jsx');
  for (const re of [/Wait for CI/, /Block on merge conflict/, /no wait/, /if \(!onToggle\)/]) assert.match(tg, re);
});

test('source: the canvas tags gated PR hand-off edges (AC6)', () => {
  const s = src('./flow-graph-render.js');
  assert.match(s, /import \{ readinessChipTag \} from '\.\/readiness-gate';/);
  assert.match(s, /return withReadinessTag\(parts\.join\(' '\), e\.artifact === 'issue' \? null : e\.readiness\);/, 'channel edges');
  assert.match(s, /return withReadinessTag\(claim \? `\$\{base\} \$\{claim\}` : base, e\.readinessGate\);/, 'label edges');
  assert.match(s, /return withReadinessTag\(`◇ \$\{title\}`, e\.readinessGate\);/, 'outcome-keyed label edges');
});
