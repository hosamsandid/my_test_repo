import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Drift guard for the #1928 rail-lifecycle wiring.
 *
 * The decisions themselves are covered by `rail-lifecycle.test.js` and
 * `agent-lifecycle-menu.test.js`. What those cannot see is whether anything
 * still *calls* them: `AgentChat.jsx`, `AgentList.jsx` and `RailLifecycleHost.jsx`
 * are JSX, which `node --test` does not load (#651), so a rename or a dropped
 * prop would leave every pure test green while the rail silently lost its menus.
 *
 * These assertions read the sources instead, in the same spirit as
 * `github-event-log-workitem.test.js` and `non-route-help-wiring.test.js`. They
 * check wiring, never copy — a reworded label is free to change.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = rel => fs.readFileSync(path.join(HERE, rel), 'utf8');

// Comments are stripped first so a comment *naming* a symbol can't stand in for
// the call that should be there.
function code(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

const agentChat = code(read('../AgentChat.jsx'));
const agentList = code(read('./AgentList.jsx'));
const host = code(read('./RailLifecycleHost.jsx'));
const menu = code(read('./RowContextMenu.jsx'));

test('the chat page derives its list URL from the opt-in, never a literal', () => {
  assert.match(agentChat, /useApi\(matrixAgentsUrl\(showDisabled\)\)/);
  // A hard-coded list URL would freeze the chat on the enabled-only payload and
  // make the toggle a no-op that still *looks* live.
  assert.doesNotMatch(agentChat, /useApi\(\s*['"]\/api\/matrix\/agents/);
});

test('the opt-in is persisted per user, not per session', () => {
  assert.match(agentChat, /useState\(loadShowDisabled\)/);
  assert.match(agentChat, /saveShowDisabled\(showDisabled\)/);
});

test('the chat page passes the opt-in and the menu request down to the rail', () => {
  assert.match(agentChat, /showDisabled=\{showDisabled\}/);
  assert.match(agentChat, /onRequestMenu=\{handleRequestMenu\}/);
});

test('a disabled agent is never resolved as the open chat (AC6)', () => {
  assert.match(agentChat, /isChatOpenable\(a\)/);
});

test('the lifecycle host is mounted with the list and a way to refresh it', () => {
  assert.match(agentChat, /<RailLifecycleHost/);
  assert.match(agentChat, /onChanged=\{refetch\}/);
});

test('the rail feeds the opt-in into the pure filter model, not a local filter', () => {
  assert.match(agentList, /filterModel\(orderedGroups, orderedSingles, filter, showDisabled\)/);
});

test('rows and group headers both offer a kebab and a right-click (question 1)', () => {
  // Two KebabButton call sites — the agent row and the group header.
  assert.equal((agentList.match(/<KebabButton/g) || []).length, 2);
  assert.equal((agentList.match(/onContextMenu=/g) || []).length, 2);
});

test('the keyboard route to a menu survives alongside the reorder shortcut (AC9)', () => {
  assert.match(agentList, /e\.key === 'ContextMenu'/);
  assert.match(agentList, /e\.shiftKey && e\.key === 'F10'/);
  // The rail's existing Alt+↑/↓ reorder must still be reachable from the same
  // handler the menu shortcut was added to.
  assert.match(agentList, /aria-keyshortcuts=\{dragEnabled \? 'Alt\+ArrowUp Alt\+ArrowDown'/);
});

test('the host reuses the Agents page dialogs and forms rather than copying them', () => {
  assert.match(host, /from '\.\.\/agent-lifecycle\/AgentLifecycleForms\.jsx'/);
  assert.match(host, /from '\.\.\/agent-lifecycle\/AgentLifecycleDialogs\.jsx'/);
  for (const dialog of [
    'DisableWarningDialog', 'TeamDisableDialog', 'DeactivateWarningDialog',
    'ResetToStubDialog', 'TeamEnableDialog', 'TeamActionResultDialog',
  ]) {
    assert.match(host, new RegExp(`<${dialog}`), `${dialog} must be rendered by the host`);
  }
});

test('destructive actions go through a confirm, never straight to the request (AC4)', () => {
  // Choosing Delete / Reset to stub only ever *opens* a dialog; the DELETE and
  // the deactivate POST live in the confirm handlers.
  assert.match(host, /case 'delete':\s*setDeleteTarget\(/);
  assert.match(host, /case 'reset-to-stub':\s*setDeactivateTarget\(/);
  assert.match(host, /case 'delete-team':\s*if \(team\) setDeleteTarget\(/);
});

test('the team fan-out reports partial failures like the Agents page (AC2)', () => {
  assert.match(host, /summarizeTeamAction\(result, members\)/);
  assert.match(host, /setTeamActionResult\(\{ action, \.\.\.summary \}\)/);
});

test('disabling probes first so a mid-run agent gets the drain/abort dialog', () => {
  assert.match(host, /res\.status === 409 && data\.warning/);
  assert.match(host, /setDisableWarning\(/);
});

test('a create or import lands in the list without a reload (AC3)', () => {
  assert.match(host, /refresh\(\)/);
  assert.match(host, /if \(onChanged\) onChanged\(\)/);
});

// --------------------------------------------------------------------- #1938

test('the row no longer carries its own mark-as-unread affordance (AC1/AC8)', () => {
  // The whole point of #1938: the hover icon is gone, and with it every trace
  // of the prop that fed it. A leftover `onMarkAsUnread` in the rail would mean
  // the action still has two homes.
  assert.doesNotMatch(agentList, /MailOpen/);
  assert.doesNotMatch(agentList, /onMarkAsUnread/);
  assert.doesNotMatch(agentList, /canMarkUnread/);
});

test('the chat hands mark-as-unread to the menu host, not to the list (AC1/AC3)', () => {
  // Same handler as before — the action moved surface, not behaviour.
  assert.match(agentChat, /<AgentList[\s\S]*?\/>/);
  assert.doesNotMatch(agentChat.match(/<AgentList[\s\S]*?\/>/)[0], /onMarkAsUnread/);
  const mount = agentChat.match(/<RailLifecycleHost[\s\S]*?\/>/)[0];
  assert.match(mount, /onMarkAsUnread=\{handleMarkAsUnread\}/);
  // The menu can only tell "already unread" from the chat's own status map.
  assert.match(mount, /statuses=\{agentStatuses\}/);
});

test('the menu entry dispatches to the chat callback and issues no request (AC3/AC6)', () => {
  assert.match(host, /case 'mark-unread':\s*if \(onMarkAsUnread\) onMarkAsUnread\(agent\.id\)/);
  // The row's state has to reach the pure menu builder, or the entry could
  // never be greyed out for an already-unread row (AC4).
  assert.match(host, /railMenuItems\(\{[^}]*activityState[^}]*\}\)/);
});

test('the context menu can fence a group off without a pseudo-item (AC2)', () => {
  // A separator entry in `items` would be an unfocusable hole in the flat list
  // the pure keyboard helpers walk by index.
  assert.match(menu, /item\.separated/);
  assert.doesNotMatch(menu, /item\.kind === 'separator'/);
});

// --------------------------------------------------------------------- #1956

test('the chat portals its two list actions into the Shell page-action slot (AC1)', () => {
  // `/chats` was the one Shell route with an empty page-action slot, which is
  // why these two had to be invented locally as a rail "+" menu. Using the slot
  // is what makes them look and sit like every other page's create actions.
  assert.match(agentChat, /usePageActions\(/);
  const slot = agentChat.match(/const headerActions = usePageActions\([\s\S]*?\n  \);/);
  assert.ok(slot, 'the header content is built in one place');
  assert.match(slot[0], /Import Agent/);
  assert.match(slot[0], /New Agent/);
  // Primary rightmost, secondary to its left (the house convention).
  assert.ok(
    slot[0].indexOf('Import Agent') < slot[0].indexOf('New Agent'),
    'Import Agent sits left of the primary New Agent',
  );
  // A portal that is built but never included in the tree renders nothing.
  assert.match(agentChat, /\{headerActions\}/);
});

test('the rail "+" control and its menu are gone, not merely unrendered (AC2)', () => {
  // AC2 is about there being ONE interactive way to create or import. A left
  // behind button component or a `kind: 'create'` menu request is how the
  // second one grows back.
  assert.doesNotMatch(agentChat, /RailHeaderButton/);
  assert.doesNotMatch(agentChat, /kind: 'create'/);
  assert.doesNotMatch(host, /kind === 'create'/);
  assert.doesNotMatch(host, /'new-agent'/);
  assert.doesNotMatch(host, /'import-agent'/);
  // The rail header row itself stays — it still carries the filter.
  assert.match(agentChat, /<FilterSelect/);
});

test('New Agent hands over to the launcher; Import opens the picker in one click (AC3/AC4)', () => {
  assert.match(agentChat, /navigate\(CREATE_ROUTE\)/);
  // One click: the button opens the file picker directly. The id/team dialog
  // follows a chosen file, exactly as the removed menu entry behaved.
  assert.match(agentChat, /railHostRef\.current\?\.openImportPicker\(\)/);
  assert.match(host, /openImportPicker\(\)\s*\{[\s\S]*?importInputRef\.current\?\.click\(\)/);
  assert.match(host, /useImperativeHandle\(ref,/);
  assert.match(agentChat.match(/<RailLifecycleHost[\s\S]*?\/>/)[0], /ref=\{railHostRef\}/);
  // The import round-trip itself is unchanged and still refreshes the list
  // rather than reloading the page (AC4, and #1928 AC3 before it).
  assert.match(host, /\/api\/agents\/import/);
});

test('both header buttons are disabled with a reason, never hidden (AC6)', () => {
  assert.match(agentChat, /describeAgentCreateAccess\(user\)/);
  const slot = agentChat.match(/const headerActions = usePageActions\([\s\S]*?\n  \);/)[0];
  // Two buttons, two gates: an ungated Import would still fail at the server.
  assert.equal((slot.match(/disabled=\{!createAccess\.allowed\}/g) || []).length, 2);
  assert.equal((slot.match(/title=\{createAccess\.hint \|\| undefined\}/g) || []).length, 2);
  // Hiding them would answer "where did New Agent go?" with silence.
  assert.doesNotMatch(slot, /createAccess\.allowed && </);
});

test('the import success message can tell the user the filter is hiding it (AC4)', () => {
  assert.match(agentChat.match(/<RailLifecycleHost[\s\S]*?\/>/)[0], /listFilter=\{listFilter\}/);
  assert.match(host, /importedAgentFilterNote\(listFilter, data\.agentId, data\.parentTeamId\)/);
});

test('the rail empty state points at the header button instead of competing (AC7)', () => {
  assert.match(agentChat, /emptyStatePointer\(\)/);
  assert.doesNotMatch(agentChat, /emptyStateCta/);
  // A <Link to={...}> in the empty state would be the second call to action the
  // house pattern forbids.
  assert.doesNotMatch(agentChat, /<Link/);
});

// --------------------------------------------------------------------- #1957

test('the rail renders the stub section from the model, never its own split', () => {
  // The split lives in `buildGroups`. A `filter(isStub)` inside the JSX would be
  // a second, untestable definition of what a stub is.
  assert.match(agentList, /<StubSection/);
  assert.match(agentList, /stubSectionLabel\(stubs\.length\)/);
  assert.doesNotMatch(agentList, /\.filter\([^)]*isStub/);
});

test('the stub section is collapsed by default and its rows are not draggable (AC2/AC8)', () => {
  const section = agentList.match(/function StubSection\([\s\S]*?\n\}/)[0];
  assert.match(section, /useState\(true\)/);
  // No drag props: a stub is not part of the persisted member order.
  assert.doesNotMatch(section, /dragScope=/);
  assert.doesNotMatch(section, /drag=\{/);
});

test('a stub row is marked as such rather than reusing the Disabled badge (AC3)', () => {
  // The row's state comes from the shared `agentState`, so the rail and the
  // lifecycle menu cannot disagree about what a stub is.
  assert.match(agentList, /agentState\(agent\) === 'stub'/);
  assert.match(agentList, /'Not initialised'/);
  // Chat-openability is still the one gate on opening a room, so no stub row can
  // request one (AC3).
  assert.match(agentList, /const openable = isChatOpenable\(agent\)/);
});

test('materialize progress reaches the row it was started from (AC5)', () => {
  // The requests live in the host, so the busy set is reported up and passed
  // back down — the rail never owns lifecycle state.
  assert.match(host, /onBusyIdsChange\(busyIds\)/);
  const mount = agentChat.match(/<RailLifecycleHost[\s\S]*?\/>/)[0];
  assert.match(mount, /onBusyIdsChange=\{handleBusyIdsChange\}/);
  assert.match(agentChat.match(/<AgentList[\s\S]*?\/>/)[0], /busyIds=\{railBusyIds\}/);
  assert.match(agentList, /busy=\{busyIds\.has\(agent\.id\)\}/);
});
