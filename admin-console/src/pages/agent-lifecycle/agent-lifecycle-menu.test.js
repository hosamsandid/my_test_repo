import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  hasToken,
  agentState,
  buildAgentMenu,
  buildTeamMenu,
  isChatOpenable,
  NO_RIGHTS_HINT,
  TEAM_LOCKED_HINT,
} from './agent-lifecycle-menu.js';

const keys = (items) => items.map(i => i.key);
const byKey = (items, key) => items.find(i => i.key === key);

/* ── hasToken / agentState ──────────────────────────────────────────── */

test('hasToken reads the raw token from /api/agents entries', () => {
  assert.equal(hasToken({ token: 'syt_abc' }), true);
  assert.equal(hasToken({ token: null }), false);
  assert.equal(hasToken({}), false);
  assert.equal(hasToken(null), false);
});

test('hasToken prefers the boolean flag from /api/matrix/agents entries', () => {
  // The chat list never ships the token itself — only whether there is one.
  assert.equal(hasToken({ hasToken: true }), true);
  assert.equal(hasToken({ hasToken: false, token: 'leaked' }), false);
});

test('agentState distinguishes stub / paused / active', () => {
  assert.equal(agentState({ token: null, enabled: false }), 'stub');
  assert.equal(agentState({ token: 'x', enabled: false }), 'paused');
  assert.equal(agentState({ token: 'x', enabled: true }), 'active');
  // A chat-list row is always token-bearing, so "disabled" reads as paused —
  // never as a stub just because the token field is absent.
  assert.equal(agentState({ hasToken: true, enabled: false }), 'paused');
});

/* ── buildAgentMenu ─────────────────────────────────────────────────── */

test('a standalone agent offers the full AC1 action set', () => {
  const items = buildAgentMenu({ agent: { id: 'a', role: 'agent', hasToken: true, enabled: true } });
  assert.deepEqual(keys(items), [
    'toggle-enabled', 'settings', 'clone', 'export', 'extract-template', 'reset-to-stub', 'delete',
  ]);
  assert.ok(items.every(i => !i.disabled));
});

test('the enable/disable label follows the current state', () => {
  const on = buildAgentMenu({ agent: { role: 'agent', hasToken: true, enabled: true } });
  const off = buildAgentMenu({ agent: { role: 'agent', hasToken: true, enabled: false } });
  assert.equal(byKey(on, 'toggle-enabled').label, 'Disable');
  assert.equal(byKey(off, 'toggle-enabled').label, 'Enable');
});

test('destructive actions are flagged danger, reversible ones are not', () => {
  const items = buildAgentMenu({ agent: { role: 'agent', hasToken: true, enabled: true } });
  assert.equal(byKey(items, 'reset-to-stub').danger, true);
  assert.equal(byKey(items, 'delete').danger, true);
  assert.ok(!byKey(items, 'toggle-enabled').danger);
  assert.ok(!byKey(items, 'clone').danger);
});

test('reset-to-stub carries the wipe warning, not a bare label', () => {
  const items = buildAgentMenu({ agent: { role: 'agent', hasToken: true, enabled: true } });
  const reset = byKey(items, 'reset-to-stub');
  // The label ends in an ellipsis: it opens a confirm, it never acts directly (AC4).
  assert.match(reset.label, /…$/);
  assert.match(reset.title, /wipes the workspace/);
});

test('a bp-instance gets no clone / save-as-template entry (edge case)', () => {
  const items = buildAgentMenu({ agent: { role: 'bp-instance', hasToken: true, enabled: true } });
  assert.deepEqual(keys(items), ['toggle-enabled', 'settings', 'reset-to-stub', 'delete']);
});

test('an orchestrator may be exported but not cloned or templated', () => {
  const items = buildAgentMenu({ agent: { role: 'orchestrator', hasToken: true, enabled: true } });
  assert.deepEqual(keys(items), ['toggle-enabled', 'settings', 'export', 'reset-to-stub', 'delete']);
});

test('a stub is not exportable and its clone/template/reset entries are inert', () => {
  const items = buildAgentMenu({ agent: { role: 'agent', token: null, enabled: false } });
  assert.ok(!keys(items).includes('export'));
  assert.equal(byKey(items, 'clone').disabled, true);
  assert.equal(byKey(items, 'extract-template').disabled, true);
  assert.equal(byKey(items, 'reset-to-stub').disabled, true);
  // Enabling (activating) a stub stays available.
  assert.equal(byKey(items, 'toggle-enabled').disabled, false);
});

test('AC5 — a member of a disabled team cannot be toggled, and says why', () => {
  const items = buildAgentMenu({
    agent: { role: 'team-member', hasToken: true, enabled: false },
    locked: true,
  });
  const toggle = byKey(items, 'toggle-enabled');
  assert.equal(toggle.disabled, true);
  assert.equal(toggle.title, TEAM_LOCKED_HINT);
  // The lock is specific to enabling — the rest of the menu still works.
  assert.equal(byKey(items, 'delete').disabled, false);
});

test('AC8 — without management rights every mutating entry is inert with a hint', () => {
  const items = buildAgentMenu({
    agent: { role: 'agent', hasToken: true, enabled: true },
    canManage: false,
  });
  for (const key of ['toggle-enabled', 'settings', 'clone', 'extract-template', 'reset-to-stub', 'delete']) {
    assert.equal(byKey(items, key).disabled, true, `${key} should be inert`);
    assert.equal(byKey(items, key).title, NO_RIGHTS_HINT, `${key} should explain why`);
  }
  // Export is not a mutation and carries no server-side management check, so
  // gating it would remove something a plain Team Member can do on /agents.
  assert.equal(byKey(items, 'export').disabled, false);
});

test('an in-flight mutation makes the menu inert without changing its shape', () => {
  const idle = buildAgentMenu({ agent: { role: 'agent', hasToken: true, enabled: true } });
  const busy = buildAgentMenu({ agent: { role: 'agent', hasToken: true, enabled: true }, busy: true });
  assert.deepEqual(keys(busy), keys(idle));
  assert.equal(byKey(busy, 'toggle-enabled').disabled, true);
  assert.equal(byKey(busy, 'delete').disabled, true);
});

test('buildAgentMenu tolerates a missing agent', () => {
  assert.deepEqual(buildAgentMenu({}), []);
  assert.deepEqual(buildAgentMenu(), []);
});

/* ── buildTeamMenu ──────────────────────────────────────────────────── */

test('a visible team header offers the full AC2 action set', () => {
  const items = buildTeamMenu({
    teamId: 't1',
    team: { id: 't1', role: 'team', enabled: true },
  });
  assert.deepEqual(keys(items), [
    'toggle-team', 'add-member', 'edit-team', 'export-team', 'open-flow-editor', 'delete-team',
  ]);
});

test('the team toggle label follows the team state', () => {
  const on = buildTeamMenu({ teamId: 't', team: { enabled: true } });
  const off = buildTeamMenu({ teamId: 't', team: { enabled: false } });
  assert.equal(byKey(on, 'toggle-team').label, 'Disable team…');
  assert.equal(byKey(off, 'toggle-team').label, 'Enable team…');
});

test('without a visible team row the fan-out toggle is omitted, not guessed', () => {
  // Happens for a disabled team while the disabled filter is off: only its
  // members are listed, so the team's own enabled state is unknown here.
  const items = buildTeamMenu({ teamId: 't1', team: null });
  assert.ok(!keys(items).includes('toggle-team'));
  assert.deepEqual(keys(items), [
    'add-member', 'edit-team', 'export-team', 'open-flow-editor', 'delete-team',
  ]);
});

test('missing loop-closing roles each become their own entry', () => {
  const items = buildTeamMenu({
    teamId: 't1',
    team: { enabled: true },
    missingRoles: [{ id: 'reviewer', displayName: 'Code Reviewer' }, { id: 'qs' }],
  });
  assert.ok(keys(items).includes('add-role:reviewer'));
  assert.ok(keys(items).includes('add-role:qs'));
  assert.equal(byKey(items, 'add-role:reviewer').label, 'Add Code Reviewer role');
  // No displayName → fall back to the id rather than render "Add undefined role".
  assert.equal(byKey(items, 'add-role:qs').label, 'Add qs role');
});

test('AC8 — team mutations are inert without rights; navigation stays live', () => {
  const items = buildTeamMenu({ teamId: 't1', team: { enabled: true }, canManage: false });
  for (const key of ['toggle-team', 'add-member', 'delete-team']) {
    assert.equal(byKey(items, key).disabled, true, `${key} should be inert`);
    assert.equal(byKey(items, key).title, NO_RIGHTS_HINT);
  }
  // `edit-team` joined the gated set in #1929: it no longer navigates to a
  // page that re-applies its own rules, it opens the chat's Settings tab —
  // which is hidden for exactly this caller, so a live entry would open nothing.
  assert.equal(byKey(items, 'edit-team').disabled, true, 'edit-team should be inert');
  assert.equal(byKey(items, 'edit-team').title, NO_RIGHTS_HINT);
  for (const key of ['export-team', 'open-flow-editor']) {
    assert.equal(byKey(items, key).disabled, false, `${key} should stay live`);
  }
});

test('delete team is the only destructive team entry', () => {
  const items = buildTeamMenu({ teamId: 't1', team: { enabled: true } });
  assert.deepEqual(items.filter(i => i.danger).map(i => i.key), ['delete-team']);
});

test('buildTeamMenu tolerates a missing team id', () => {
  assert.deepEqual(buildTeamMenu({ team: { enabled: true } }), []);
  assert.deepEqual(buildTeamMenu(), []);
});

/* ── isChatOpenable ─────────────────────────────────────────────────── */

test('AC6 — a disabled agent is not chat-openable', () => {
  assert.equal(isChatOpenable({ enabled: true }), true);
  assert.equal(isChatOpenable({}), true);         // absent flag = enabled
  assert.equal(isChatOpenable({ enabled: false }), false);
  assert.equal(isChatOpenable(null), false);
});
