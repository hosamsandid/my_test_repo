import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SHOW_DISABLED_KEY,
  loadShowDisabled,
  saveShowDisabled,
  clampMenuPosition,
  teamOptions,
  existingIds,
  deleteTargetFor,
  isTeamLocked,
  importedAgentFilterNote,
  railMenuItems,
  matrixAgentsUrl,
  mergeAgentConfigs,
  canMarkUnread,
  withChatDialogLabels,
} from './rail-lifecycle.js';
import {
  NO_RIGHTS_HINT, TEAM_LOCKED_HINT, MEMBERS_MANAGE_HINT, MEMBERS_READ_ONLY_HINT,
  buildAgentMenu, buildTeamMenu,
} from '../agent-lifecycle/agent-lifecycle-menu.js';

/** One menu entry by key — `undefined` reads as a failed assertion, not a crash. */
const byKey = (items, key) => items.find(i => i.key === key) || {};

function fakeStorage(initial = {}) {
  const map = { ...initial };
  return {
    getItem: k => (Object.prototype.hasOwnProperty.call(map, k) ? map[k] : null),
    setItem: (k, v) => { map[k] = String(v); },
    _map: map,
  };
}

test('showDisabled defaults to off and round-trips through storage', () => {
  const s = fakeStorage();
  assert.equal(loadShowDisabled(s), false);

  saveShowDisabled(true, s);
  assert.equal(s._map[SHOW_DISABLED_KEY], 'true');
  assert.equal(loadShowDisabled(s), true);

  saveShowDisabled(false, s);
  assert.equal(loadShowDisabled(s), false);
});

test('showDisabled treats any non-"true" value as off', () => {
  assert.equal(loadShowDisabled(fakeStorage({ [SHOW_DISABLED_KEY]: 'yes' })), false);
  assert.equal(loadShowDisabled(fakeStorage({ [SHOW_DISABLED_KEY]: '' })), false);
});

test('showDisabled survives a throwing storage (privacy mode)', () => {
  const boom = {
    getItem() { throw new Error('denied'); },
    setItem() { throw new Error('denied'); },
  };
  assert.equal(loadShowDisabled(boom), false);
  assert.doesNotThrow(() => saveShowDisabled(true, boom));
});

// #1928 AC6: the opt-in is the *only* thing that lets a paused agent into the
// list, so `includeDisabled` must be absent when it is off — not present and
// set to `0`. (#1957 added a second widening that is not a preference; the
// stub-specific test below pins the two apart.)
test('matrixAgentsUrl widens the list only when the opt-in is on', () => {
  assert.equal(matrixAgentsUrl(false), '/api/matrix/agents?includeStubs=1');
  assert.equal(matrixAgentsUrl(undefined), '/api/matrix/agents?includeStubs=1');
  assert.equal(matrixAgentsUrl(true), '/api/matrix/agents?includeDisabled=1&includeStubs=1');
});

test('#1957 — stubs are always requested, the disabled opt-in stays a choice', () => {
  // A not-yet-materialized member is not a paused agent someone chose to hide:
  // without this the chat cannot show a deferred-materialization team at all,
  // which is the bug. `includeDisabled` remains driven purely by the preference.
  for (const on of [false, true]) {
    assert.ok(matrixAgentsUrl(on).includes('includeStubs=1'));
    assert.equal(matrixAgentsUrl(on).includes('includeDisabled=1'), on);
  }
});

test('mergeAgentConfigs prefers the fuller config but keeps the chat verdict', () => {
  const chat = [{ id: 'a', displayName: 'A', canManage: false, enabled: true }];
  const configs = [{ id: 'a', displayName: 'A', role: 'team', labels: [{ name: 'ready' }] }];
  const merged = mergeAgentConfigs(chat, configs);

  assert.equal(merged.length, 1);
  // The config side carries the record the menus need...
  assert.equal(merged[0].role, 'team');
  assert.deepEqual(merged[0].labels, [{ name: 'ready' }]);
  // ...but only the chat payload knows whether this caller may manage it.
  assert.equal(merged[0].canManage, false);
});

test('mergeAgentConfigs keeps rows either side is missing', () => {
  const chat = [{ id: 'only-chat', canManage: true }];
  const configs = [{ id: 'only-config', role: 'agent' }];
  const ids = mergeAgentConfigs(chat, configs).map(a => a.id).sort();

  // A visible chat row with no readable config must not vanish — dropping it
  // would leave a row on screen with no menu behind it.
  assert.deepEqual(ids, ['only-chat', 'only-config']);
});

test('mergeAgentConfigs degrades to the chat list before the configs land', () => {
  const chat = [{ id: 'a' }, { id: 'b' }];
  assert.deepEqual(mergeAgentConfigs(chat, null), chat);
  assert.deepEqual(mergeAgentConfigs(chat, []), chat);
  assert.deepEqual(mergeAgentConfigs(null, null), []);
});

test('clampMenuPosition prefers below-right of the pointer', () => {
  const pos = clampMenuPosition({
    x: 100, y: 100, width: 180, height: 200,
    viewportWidth: 1000, viewportHeight: 800,
  });
  assert.deepEqual(pos, { left: 100, top: 100 });
});

test('clampMenuPosition flips instead of overlapping the edge', () => {
  const pos = clampMenuPosition({
    x: 950, y: 780, width: 180, height: 200,
    viewportWidth: 1000, viewportHeight: 800,
  });
  assert.deepEqual(pos, { left: 770, top: 580 });
  // Fully inside the viewport after the flip.
  assert.ok(pos.left >= 8 && pos.left + 180 <= 1000);
  assert.ok(pos.top >= 8 && pos.top + 200 <= 800);
});

test('clampMenuPosition keeps a menu larger than the viewport on screen', () => {
  const pos = clampMenuPosition({
    x: 10, y: 10, width: 400, height: 900,
    viewportWidth: 300, viewportHeight: 500,
  });
  assert.equal(pos.left, 8);
  assert.equal(pos.top, 8);
});

const AGENTS = [
  { id: 'solo', role: 'agent', displayName: 'Solo' },
  { id: 'zeta', role: 'team', displayName: 'Zeta Team', enabled: true },
  { id: 'alpha', role: 'team', displayName: 'Alpha Team', enabled: false },
  { id: 'alpha-dev', role: 'team-member', parentTeamId: 'alpha', displayName: 'Dev' },
  { id: 'alpha-qa', role: 'team-member', parentTeamId: 'alpha', displayName: 'QA' },
  { id: 'zeta-dev', role: 'team-member', parentTeamId: 'zeta', displayName: 'Z Dev' },
  // Leftover BriefingPack configs (#1964): no longer creatable, but still on
  // disk on an upgraded installation — they keep the removal guards honest.
  { id: 'orch', role: 'orchestrator', displayName: 'Orch' },
  { id: 'bp1', role: 'bp-instance', parentOrchestratorId: 'orch', displayName: 'BP 1' },
];

test('teamOptions lists only team constructs, sorted by display name', () => {
  assert.deepEqual(teamOptions(AGENTS), [
    { id: 'alpha', displayName: 'Alpha Team' },
    { id: 'zeta', displayName: 'Zeta Team' },
  ]);
  assert.deepEqual(teamOptions(null), []);
});

test('existingIds collects every id in the list', () => {
  const ids = existingIds(AGENTS);
  assert.ok(ids.has('solo'));
  assert.ok(ids.has('alpha-dev'));
  assert.equal(ids.size, AGENTS.length);
});

test('deleteTargetFor attaches a team\'s members', () => {
  const team = deleteTargetFor(AGENTS[2], AGENTS);
  assert.deepEqual(team.children.map(c => c.id), ['alpha-dev', 'alpha-qa']);

  // #1964: a leftover orchestrator config collects no children any more, so its
  // confirm is the plain single-agent one — the cascade wording it used to get
  // named a fan-out the console can no longer perform.
  assert.deepEqual(deleteTargetFor(AGENTS[6], AGENTS).children, []);

  // A leaf agent carries no children, so the confirm shows the plain message.
  assert.deepEqual(deleteTargetFor(AGENTS[0], AGENTS).children, []);
  assert.equal(deleteTargetFor(null, AGENTS), null);
});

test('isTeamLocked is true only for a member of a listed, disabled team', () => {
  const dev = AGENTS[3];
  assert.equal(isTeamLocked(dev, AGENTS), true);
  assert.equal(isTeamLocked(AGENTS[5], AGENTS), false);       // team enabled
  assert.equal(isTeamLocked(AGENTS[1], AGENTS), false);       // the team row itself
  assert.equal(isTeamLocked(AGENTS[0], AGENTS), false);       // standalone agent
  // Team absent from the payload (opt-in off): no lock is guessed from absence.
  assert.equal(isTeamLocked(dev, AGENTS.filter(a => a.id !== 'alpha')), false);
});

// --------------------------------------------------------------------- #1956

test('the rail no longer builds a create menu — the header owns those actions', async () => {
  // #1956 AC2: neither create nor import may be reachable from two interactive
  // places, so the "+" menu is gone rather than merely unrendered. Asserted on
  // the module's exports (a leftover builder would be the first step back).
  const mod = await import('./rail-lifecycle.js');
  assert.equal(mod.buildCreateMenu, undefined);
  assert.deepEqual(railMenuItems({ target: { kind: 'create' }, agents: AGENTS }), { items: [], label: '' });
});

test('importedAgentFilterNote stays silent when the new agent is visible (AC4)', () => {
  assert.equal(importedAgentFilterNote({ kind: 'all' }, 'zeta', undefined), null);
  assert.equal(importedAgentFilterNote(undefined, 'zeta', undefined), null);
  // Filtered to the very agent that just landed.
  assert.equal(importedAgentFilterNote({ kind: 'agent', id: 'zeta' }, 'zeta', undefined), null);
  // Filtered to the team it was imported into.
  assert.equal(importedAgentFilterNote({ kind: 'team', id: 'alpha' }, 'zeta', 'alpha'), null);
  // An unknown filter kind is reported visible — a wrong "hidden" note next to
  // an agent the user can see would be worse than no note. Since #1964 the
  // retired `orchestrator` kind is exactly such an unknown.
  assert.equal(importedAgentFilterNote({ kind: 'something-new' }, 'zeta', undefined), null);
  assert.equal(importedAgentFilterNote({ kind: 'orchestrator', id: 'omega' }, 'zeta', 'alpha'), null);
});

test('importedAgentFilterNote reports an import the filter swallows (AC4)', () => {
  const other = importedAgentFilterNote({ kind: 'agent', id: 'dev' }, 'zeta', undefined);
  assert.ok(other && /filter/i.test(other), 'names the filter as the reason');
  assert.ok(importedAgentFilterNote({ kind: 'team', id: 'alpha' }, 'zeta', undefined));
  assert.ok(importedAgentFilterNote({ kind: 'team', id: 'alpha' }, 'zeta', 'beta'));
});

test('railMenuItems routes each target kind to its own menu', () => {
  const solo = railMenuItems({ target: { kind: 'agent', agent: AGENTS[0] }, agents: AGENTS });
  assert.equal(solo.label, 'Actions for Solo');
  assert.deepEqual(solo.items.map(i => i.key), [
    // The chat-only view action leads (#1938 D1), then the lifecycle group,
    // then the chat-only help entry that closes the menu (#1972).
    'mark-unread',
    'toggle-enabled', 'settings', 'clone', 'export', 'extract-template',
    'reset-to-stub', 'delete',
    'help',
  ]);
  // Both chat-only entries are fenced off from the lifecycle group between them.
  assert.deepEqual(solo.items.filter(i => i.separated).map(i => i.key), ['toggle-enabled', 'help']);

  const team = railMenuItems({
    target: { kind: 'team', group: { id: 'zeta', displayName: 'Zeta Team', header: AGENTS[1] } },
    agents: AGENTS,
  });
  assert.equal(team.label, 'Team actions for Zeta Team');
  assert.deepEqual(team.items.map(i => i.key), [
    'toggle-team', 'add-member', 'share', 'export-team', 'clone-team', 'open-flow-editor',
    'delete-team', 'help',
  ]);
});

test('the help entry is on every row menu, always usable, and never mutates (#1972)', () => {
  // The row menu is one of the surfaces the epic gives a "?", and a menu cannot
  // host a button — so the affordance is an entry. It is the one entry that is
  // never disabled by a lock, a busy run or a missing permission.
  const targets = [
    { kind: 'agent', agent: { ...AGENTS[0], canManage: false } },
    { kind: 'agent', agent: AGENTS[3] }, // team-locked member
    { kind: 'team', group: { id: 'zeta', displayName: 'Zeta Team', header: AGENTS[1] } },
  ];
  for (const target of targets) {
    const { items } = railMenuItems({ target, agents: AGENTS, busyIds: new Set(['solo', 'zeta']) });
    const help = items[items.length - 1];
    assert.equal(help.key, 'help', 'the help entry is always last');
    assert.equal(help.disabled, false);
    assert.equal(help.separated, true);
  }
  // …and NOT on the rail-header create menu, which is not a row.
  const create = railMenuItems({ target: { kind: 'create' }, agents: AGENTS });
  assert.ok(!create.items.some(i => i.key === 'help'));
});

test('railMenuItems degrades to an empty menu rather than guessing a target', () => {
  assert.deepEqual(railMenuItems(), { items: [], label: '' });
  assert.deepEqual(railMenuItems({ target: null }), { items: [], label: '' });
  assert.deepEqual(railMenuItems({ target: { kind: 'agent' } }), { items: [], label: '' });
  assert.deepEqual(railMenuItems({ target: { kind: 'team', group: {} } }), { items: [], label: '' });
  assert.deepEqual(railMenuItems({ target: { kind: 'nonsense' } }), { items: [], label: '' });
});

test('railMenuItems carries the team lock onto a member\'s Enable entry (AC5)', () => {
  // `alpha` is disabled, so its member may not be enabled on its own.
  const { items } = railMenuItems({ target: { kind: 'agent', agent: AGENTS[3] }, agents: AGENTS });
  const toggle = items.find(i => i.key === 'toggle-enabled');
  assert.equal(toggle.disabled, true);
  assert.equal(toggle.title, TEAM_LOCKED_HINT);
});

test('railMenuItems disables mutating entries for a caller without rights (AC8)', () => {
  const agent = { ...AGENTS[0], canManage: false };
  const { items } = railMenuItems({ target: { kind: 'agent', agent }, agents: [agent] });
  const byKey = Object.fromEntries(items.map(i => [i.key, i]));
  assert.equal(byKey.delete.disabled, true);
  assert.equal(byKey.delete.title, NO_RIGHTS_HINT);
  // Export is a read-only download the server does not gate — leaving it usable
  // keeps something a Team Member can do today.
  assert.equal(byKey.export.disabled, false);
});

test('railMenuItems treats an absent canManage as permitted (older payload)', () => {
  const { items } = railMenuItems({ target: { kind: 'agent', agent: AGENTS[0] }, agents: AGENTS });
  assert.equal(items.find(i => i.key === 'delete').disabled, false);
});

test('railMenuItems disables every mutating entry while a mutation is in flight', () => {
  const { items } = railMenuItems({
    target: { kind: 'agent', agent: AGENTS[0] },
    agents: AGENTS,
    busyIds: new Set(['solo']),
  });
  assert.equal(items.find(i => i.key === 'toggle-enabled').disabled, true);
  assert.equal(items.find(i => i.key === 'delete').disabled, true);
});

test('mark-unread is offered for a readable chat and inert everywhere else (#1938)', () => {
  const agent = AGENTS[0];
  assert.equal(canMarkUnread(agent, 'idle'), true);
  assert.equal(canMarkUnread(agent, 'busy'), true);
  // Nothing to do: the row already reads as unread.
  assert.equal(canMarkUnread(agent, 'unread'), false);
  // Not a readable chat — by state…
  for (const state of ['disabled', 'offline', 'problem']) {
    assert.equal(canMarkUnread(agent, state), false, state);
  }
  // …or because the agent itself is disabled / a stub, whatever the poll says.
  assert.equal(canMarkUnread({ ...agent, enabled: false }, 'idle'), false);
  assert.equal(canMarkUnread(null, 'idle'), false);
  // An absent state is the ordinary case, not a reason to withhold the action.
  assert.equal(canMarkUnread(agent), true);
});

test('mark-unread stays in the list when it does not apply, greyed out and hint-less (D2)', () => {
  const unread = railMenuItems({
    target: { kind: 'agent', agent: AGENTS[0] }, agents: AGENTS, activityState: 'unread',
  }).items.find(i => i.key === 'mark-unread');
  assert.equal(unread.disabled, true);
  // D2 is explicit: greyed out with *no* explanation. A title would render as a
  // tooltip on the menu item.
  assert.equal(unread.title, undefined);
  assert.equal(unread.label, 'Mark as unread');

  const idle = railMenuItems({
    target: { kind: 'agent', agent: AGENTS[0] }, agents: AGENTS, activityState: 'idle',
  }).items.find(i => i.key === 'mark-unread');
  assert.equal(idle.disabled, false);
});

test('mark-unread never depends on canManage — it mutates nothing (#1938 AC6)', () => {
  const agent = { ...AGENTS[0], canManage: false };
  const { items } = railMenuItems({
    target: { kind: 'agent', agent }, agents: [agent], activityState: 'idle',
  });
  const markUnread = items.find(i => i.key === 'mark-unread');
  assert.equal(markUnread.disabled, false);
  // …and a mutation in flight is equally none of its business.
  const busy = railMenuItems({
    target: { kind: 'agent', agent: AGENTS[0] }, agents: AGENTS, busyIds: new Set(['solo']),
  }).items.find(i => i.key === 'mark-unread');
  assert.equal(busy.disabled, false);
});

test('the shared team menu never grows the chat-only view action', () => {
  // `buildAgentMenu` is rendered by the Agents page too, which has no unread
  // concept — the entry must live in this rail-only layer, not in that
  // descriptor, and a team group's menu has no row to mark.
  const { items } = railMenuItems({
    target: { kind: 'team', group: { id: 'zeta', displayName: 'Zeta Team', header: AGENTS[1] } },
    agents: AGENTS,
  });
  assert.equal(items.some(i => i.key === 'mark-unread'), false);
  assert.deepEqual(
    buildAgentMenu({ agent: AGENTS[0] }).filter(i => i.key === 'mark-unread'), [],
  );
});

test('railMenuItems omits the fan-out toggle for a header-less team group', () => {
  // The disabled team is invisible with the opt-in off, so its enabled state is
  // unknown — the toggle is omitted rather than guessed, the id-only actions stay.
  const { items } = railMenuItems({
    target: { kind: 'team', group: { id: 'ghost', displayName: 'Ghost' } },
    agents: [],
  });
  assert.equal(items.some(i => i.key === 'toggle-team'), false);
  assert.ok(items.some(i => i.key === 'delete-team'));
  // Share needs only the team id, so it survives here — and with no header row
  // to read a predicate off, it must read as permitted rather than as refused.
  assert.equal(byKey(items, 'share').title, MEMBERS_MANAGE_HINT);
});

test('#2082 — the rail reads canManageTeam off the team row, not canManage', () => {
  // The chat payload ships an explicit `canManageTeam` on `role: "team"` rows.
  // The two coincide today, so the point of the field is that a change to
  // `canManageAgent` cannot silently open the member list (#2041 §7.1).
  const header = { id: 'zeta', role: 'team', enabled: true, displayName: 'Zeta Team' };
  const readOnly = railMenuItems({
    target: { kind: 'team', group: { id: 'zeta', header: { ...header, canManage: true, canManageTeam: false } } },
    agents: [],
  });
  assert.equal(byKey(readOnly.items, 'share').title, MEMBERS_READ_ONLY_HINT);
  assert.equal(byKey(readOnly.items, 'share').disabled, false, 'still openable — the list is readable');
  // …while the rest of the menu keeps following `canManage`.
  assert.equal(byKey(readOnly.items, 'delete-team').disabled, false);

  const manageable = railMenuItems({
    target: { kind: 'team', group: { id: 'zeta', header: { ...header, canManage: false, canManageTeam: true } } },
    agents: [],
  });
  assert.equal(byKey(manageable.items, 'share').title, MEMBERS_MANAGE_HINT);
  assert.equal(byKey(manageable.items, 'delete-team').disabled, true, 'the agent gate is untouched');
});

test('#2082 — a payload with no canManageTeam field falls back to canManage', () => {
  // A response cached from before the field existed must not read as "refused".
  const header = { id: 'zeta', role: 'team', enabled: true, canManage: true };
  const { items } = railMenuItems({
    target: { kind: 'team', group: { id: 'zeta', header } },
    agents: [],
  });
  assert.equal(byKey(items, 'share').title, MEMBERS_MANAGE_HINT);
});

test('#1959 — the rail team menu appends no add-role entry', () => {
  // The missing-role suggestion is gone, and with it the only menu key that ever
  // carried an argument — every key the host dispatches on is now a bare action.
  const { items } = railMenuItems({
    target: { kind: 'team', group: { id: 'zeta', displayName: 'Zeta Team', header: AGENTS[1] } },
    agents: AGENTS,
    missingRoles: [{ id: 'merger', displayName: 'Merger' }],
  });
  const keys = items.map(i => i.key);
  assert.ok(!keys.some(k => k.startsWith('add-role')));
  assert.ok(!keys.some(k => k.includes(':')), 'no menu key carries an argument');
  assert.ok(keys.includes('add-member'));
});

/* ── not-materialized members (#1957) ────────────────────────────────── */

const STUB_MEMBER = {
  id: 'zeta-arch', role: 'team-member', parentTeamId: 'zeta',
  displayName: 'Architect', enabled: false, hasToken: false,
};

test('#1957 — a stub row offers Materialize, and no chat-only view action', () => {
  const { items, label } = railMenuItems({
    target: { kind: 'agent', agent: STUB_MEMBER },
    agents: [...AGENTS, STUB_MEMBER],
  });
  const toggle = items.find(i => i.key === 'toggle-enabled');
  assert.equal(toggle.label, 'Materialize');
  assert.equal(toggle.disabled, false);
  assert.equal(label, 'Actions for Architect');
  // A stub has no chat to mark as read, so the view action is present-but-inert
  // exactly as it is for any other unopenable row.
  assert.equal(items.find(i => i.key === 'mark-unread').disabled, true);
});

test('#1957 AC6 — a stub in a disabled team gets the enable-the-team-first state', () => {
  // `alpha` is the disabled team in the fixture; the lock is derived from the
  // list, so it is the same one a paused member of that team gets.
  const stub = { ...STUB_MEMBER, id: 'alpha-arch', parentTeamId: 'alpha' };
  const { items } = railMenuItems({
    target: { kind: 'agent', agent: stub },
    agents: [...AGENTS, stub],
  });
  const toggle = items.find(i => i.key === 'toggle-enabled');
  assert.equal(toggle.disabled, true);
  assert.equal(toggle.title, TEAM_LOCKED_HINT);
});

test('#1957 AC5 — a materialize in flight makes the row\'s own entry inert', () => {
  const { items } = railMenuItems({
    target: { kind: 'agent', agent: STUB_MEMBER },
    agents: [...AGENTS, STUB_MEMBER],
    busyIds: new Set([STUB_MEMBER.id]),
  });
  assert.equal(items.find(i => i.key === 'toggle-enabled').disabled, true);
});

test('#1957 AC7 — a caller who may not manage the stub gets no working Materialize', () => {
  const stub = { ...STUB_MEMBER, canManage: false };
  const { items } = railMenuItems({
    target: { kind: 'agent', agent: stub },
    agents: [stub],
  });
  const toggle = items.find(i => i.key === 'toggle-enabled');
  assert.equal(toggle.disabled, true);
  assert.equal(toggle.title, NO_RIGHTS_HINT);
});

/* ── deferred materialization of a new member (#1958) ────────────────── */

test('#1958 AC1 — the rail promises the dialog it now opens', () => {
  const { items } = railMenuItems({
    target: { kind: 'team', group: { id: 'zeta', displayName: 'Zeta Team', header: AGENTS[1] } },
    agents: AGENTS,
  });
  const add = items.find(i => i.key === 'add-member');
  assert.equal(add.label, 'Add member…');
  // The key is the contract with the host's switch — only the wording moved.
  assert.equal(add.disabled, false);
});

test('#1958 — the shared descriptor keeps the Agents page honest', () => {
  // That page's Add member is still a bare materializing POST, so the ellipsis
  // must NOT have been pushed down into buildTeamMenu: it would promise a
  // dialog that surface does not have.
  const shared = buildTeamMenu({ team: AGENTS[1], teamId: 'zeta', canManage: true });
  assert.equal(shared.find(i => i.key === 'add-member').label, 'Add member');
});

test('#1958 — withChatDialogLabels is idempotent and touches nothing else', () => {
  const once = withChatDialogLabels([
    { key: 'add-member', label: 'Add member' },
    { key: 'delete-team', label: 'Delete team…' },
    { key: 'export-team', label: 'Export team' },
  ]);
  assert.deepEqual(once.map(i => i.label), ['Add member…', 'Delete team…', 'Export team']);
  assert.deepEqual(withChatDialogLabels(once), once, 're-running must not add a second ellipsis');
  assert.deepEqual(withChatDialogLabels([]), []);
  assert.deepEqual(withChatDialogLabels(undefined), []);
});

test('#1958 — the relabel preserves the gating the entry arrived with', () => {
  // A busy team and an unmanageable team must still yield an inert entry: the
  // map has to copy the descriptor, not rebuild it.
  const busy = railMenuItems({
    target: { kind: 'team', group: { id: 'zeta', displayName: 'Zeta Team', header: AGENTS[1] } },
    agents: AGENTS,
    busyIds: new Set(['zeta']),
  }).items.find(i => i.key === 'add-member');
  assert.equal(busy.label, 'Add member…');
  assert.equal(busy.disabled, true);

  const noRights = railMenuItems({
    target: {
      kind: 'team',
      group: { id: 'zeta', displayName: 'Zeta Team', header: { ...AGENTS[1], canManage: false } },
    },
    agents: AGENTS,
  }).items.find(i => i.key === 'add-member');
  assert.equal(noRights.disabled, true);
  assert.equal(noRights.title, NO_RIGHTS_HINT);
});
