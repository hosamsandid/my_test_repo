import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Drift guard for the #1929 Settings-tab wiring.
 *
 * The decisions themselves are covered by `agent-settings-view.test.js` and
 * `agent-lifecycle/agent-edit-form-model.test.js`. What those cannot see is
 * whether anything still *calls* them, or whether the form is still the shared
 * one: `AgentChat.jsx`, `RightRail.jsx`, `AgentSettingsPanel.jsx` and
 * `AgentEditForm.jsx` are JSX, which `node --test` does not load (#651), so
 * a re-implemented form, a dropped prop or a lost tab would leave every pure
 * test green while the feature silently died.
 *
 * #1929 wrote this guard as a *parity* check between two surfaces: the Agents
 * page and the new Settings tab had to render one shared form. #1930 removed
 * the Agents page, so the parity half is gone with it and the remaining claim is
 * the stronger one — the tab is now the ONLY surface, and the shared modules
 * must still be shared modules rather than being folded back into it. The
 * Agents-page absence itself is guarded once, in
 * `pages/agents-page-removal-guard.test.js`.
 *
 * Same spirit (and same helpers) as `rail-lifecycle-wiring.test.js`: these
 * assertions read the sources and check *wiring*, never copy — a reworded hint
 * or label is free to change.
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
const rail = code(read('./RightRail.jsx'));
const panel = code(read('./AgentSettingsPanel.jsx'));
const editForm = code(read('../agent-lifecycle/AgentEditForm.jsx'));
const createForm = code(read('../agent-lifecycle/AgentCreateForm.jsx'));

/* ── AC7: one form, now one surface ──────────────────────────────── */

test('the panel imports the shared edit form instead of defining one', () => {
  assert.match(panel, /import AgentEditForm from '\.\.\/agent-lifecycle\/AgentEditForm\.jsx'/);
  // A second definition anywhere is the failure this whole ticket is about —
  // and with the Agents page gone (#1930) the temptation is the opposite one:
  // inlining the now-single-consumer form back into its only caller.
  assert.doesNotMatch(panel, /function AgentEditForm\s*\(/);
});

test('the form and its sub-controls live in exactly one place', () => {
  for (const symbol of [
    'AgentEditForm', 'PluginGrantSection', 'ContextMountControl',
    'PromptModeControl', 'InheritOrCustom',
  ]) {
    assert.doesNotMatch(
      panel, new RegExp(`function ${symbol}\\s*\\(`),
      `${symbol} must not be redefined in the Settings panel`,
    );
    assert.match(
      editForm, new RegExp(`function ${symbol}\\s*\\(`),
      `${symbol} must be defined in the shared module`,
    );
  }
});

test('the shared field controls are imported back, not re-typed', () => {
  // #1929 asserted this on the Agents page, because the create form that
  // renders these controls was still defined there. #1956 moved that form into
  // `agent-lifecycle/AgentCreateForm.jsx`, so the importer moved with it — the
  // invariant is unchanged (one definition, imported by whoever renders it),
  // only its address is.
  assert.match(createForm, /from '\.\/agent-form-fields\.jsx'/);
  // `MissionDirectoryField` / `repoDirName` left this list with the field
  // itself (#1964) — see the removal guard in `bp-removal-ui.test.js`, which
  // asserts neither is re-typed anywhere rather than merely not duplicated here.
  // `RoleDetailBanner` left it in #2026: the big blue box is gone, and its
  // successor `RoleHelpTip` is rendered by the create form alone (the edit form
  // dropped the read-only Role field and its explanation), so what is asserted
  // here is that the create form imports it instead of re-typing the tip.
  for (const symbol of ['ROLE_INFO', 'RoleHelpTip']) {
    assert.doesNotMatch(
      createForm, new RegExp(`(function|const) ${symbol}\\b\\s*[({=]`),
      `${symbol} must not be redefined in the create form`,
    );
  }
  assert.match(createForm, /<RoleHelpTip role=\{form\.role\}/);
});

/* ── #2026: the settings form's field set and its ordering ───────── */

test('the read-only Role and Working Environment fields are gone', () => {
  // Both were dead weight in an already-created agent: neither is editable
  // here, and the role callout explained a choice this dialog cannot make.
  assert.doesNotMatch(editForm, /Role \(read-only\)/);
  assert.doesNotMatch(editForm, /Working Environment \(read-only\)/);
  // The role explanation went with the field — no import, no invocation.
  assert.doesNotMatch(editForm, /RoleDetailBanner|RoleHelpTip/);
  // …while the fields that stay are still here (so the assertions above cannot
  // pass because the whole form vanished).
  assert.match(editForm, /ID \(read-only\)/);
  assert.match(editForm, /Parent Team \(read-only\)/);
  assert.match(editForm, /label="Display Name \*"/);
});

test('the big-box role banner is not left behind as an orphan', () => {
  const fields = code(read('../agent-lifecycle/agent-form-fields.jsx'));
  assert.doesNotMatch(fields, /RoleDetailBanner/);
  // The compact successor renders the shared InfoTip rather than a second
  // hand-rolled popover, and still reads its copy from the one catalogue.
  assert.match(fields, /import InfoTip from '\.\.\/\.\.\/components\/InfoTip'/);
  assert.match(fields, /export function RoleHelpTip/);
  assert.match(fields, /export const ROLE_INFO/);
});

test('the system prompt renders after Display Name and before Plugins', () => {
  // The prompt is the point of this dialog, so its position is a contract, not
  // a coincidence — and it must stay guarded by its own role check, since both
  // blocks read fields that exist for one role only.
  const at = re => {
    const i = editForm.search(re);
    assert.notEqual(i, -1, `${re} not found in the edit form`);
    return i;
  };
  const displayName = at(/label="Display Name \*"/);
  const teamPrompt = at(/Team Default Prompt/);
  const memberPrompt = at(/<PromptModeControl/);
  const plugins = at(/<PluginGrantSection/);

  for (const [name, pos] of [['team prompt', teamPrompt], ['member prompt', memberPrompt]]) {
    assert.ok(displayName < pos, `${name} must render after Display Name`);
    assert.ok(pos < plugins, `${name} must render before Plugins`);
  }
  // Each block still carries its role guard, immediately before it.
  assert.match(
    editForm.slice(displayName, teamPrompt),
    /agent\.role === 'team' &&\s*\(\s*$/m,
  );
  assert.match(
    editForm.slice(displayName, memberPrompt),
    /agent\.role === 'team-member' &&/,
  );
});

test('the shape logic is the pure module, not inlined in the form again', () => {
  assert.match(editForm, /from '\.\/agent-edit-form-model\.js'/);
  assert.match(editForm, /buildInitialForm\(agent\)/);
  assert.match(editForm, /onSave\(buildEditSubmit\(agent, form\)\)/);
});

/* ── AC9: the chat-only props stay optional ──────────────────────── */

test('every chat-only prop is optional, so the form works without one', () => {
  // #1929 proved this by pointing at a second caller — the Agents page — that
  // passed none of them. #1930 removed that caller, so the claim is asserted
  // where it actually lives: each prop is read defensively in the shared form,
  // which is what let the two surfaces share it in the first place and what
  // keeps a third caller cheap.
  assert.match(editForm, /initialForm = null, onFormChange = null,/);
  assert.match(editForm, /confirmRestart = false, onImmediateApply = null,/);
  // …and each default is actually honoured rather than merely declared.
  assert.match(editForm, /initialForm \|\| buildInitialForm\(agent\)/);
  assert.match(editForm, /if \(onFormChange\) onFormChange\(next\)/);
  assert.match(editForm, /if \(confirmRestart\) setPending\(nextRows\)/);
  assert.match(editForm, /onImmediateApply \?/);
});

/* ── the tab itself ──────────────────────────────────────────────── */

test('the rail registers the tab in BOTH places the tab machinery reads', () => {
  // TAB_KEYS gates the persisted value and openTabRequest; `tabs` is what
  // renders. Adding it to only one makes the tab unreachable or unpersisted.
  assert.match(rail, /const TAB_KEYS = \[[^\]]*'settings'/);
  assert.match(rail, /key: 'settings'/);
  assert.match(rail, /<AgentSettingsPanel/);
});

test('the tab is derived from the pure subject, never from agentId alone', () => {
  assert.match(rail, /settingsSubject\(\{/);
  assert.match(rail, /const showSettings = settings\.visible/);
  assert.match(rail, /agentId=\{settings\.agentId\}/);
});

test('a stale persisted Settings tab falls back like the Outcomes one does', () => {
  assert.match(rail, /if \(!showSettings && tab === 'settings'\) setTab\('sessions'\)/);
});

/* ── #2235: a team subject never reaches the rail at all any more ── */

test('the rail no longer knows about a team subject — that surface moved out of it', () => {
  // #2216 narrowed the rail's tabs for a routed team; #2235 replaced the
  // whole chat+rail split with a dedicated full-width surface for one, so the
  // rail itself goes back to being agent-only. A resurrected `subjectIsTeam`
  // prop here would mean the narrowing logic came back alongside the new
  // surface — two ways to special-case a team instead of one.
  assert.doesNotMatch(rail, /subjectIsTeam/);
  assert.doesNotMatch(agentChat.match(/<RightRail[\s\S]*?\/>/)[0], /subjectIsTeam/);
});

/* ── AC8: role gating parity ─────────────────────────────────────── */

test('the chat feeds the server-shipped canManage into the tab decision', () => {
  assert.match(agentChat, /agentCanManage=\{selectedAgent \? selectedAgent\.canManage !== false : true\}/);
});

/* ── AC5 / AC10: reaching another agent's settings ───────────────── */

test('the rail menus open the tab instead of leaving the chat', () => {
  const host = code(read('./RailLifecycleHost.jsx'));
  assert.match(host, /case 'settings':\s*if \(onOpenSettings\) onOpenSettings\(agent\.id\)/);
  assert.match(host, /case 'edit-team':\s*if \(onOpenSettings && teamId\) onOpenSettings\(teamId\)/);
  // Phase 1's jump to the Agents page is what this replaced.
  assert.doesNotMatch(host, /case 'edit-team':\s*navigate\('\/agents'\)/);
});

test('the chat lifts the settings subject and hands it to both sides', () => {
  assert.match(agentChat, /onOpenSettings=\{handleOpenSettings\}/);
  assert.match(agentChat, /settingsAgentId=\{settingsAgentId\}/);
  assert.match(agentChat, /setRailTabRequest\(\{ tab: 'settings', ts: Date\.now\(\) \}\)/);
});

test('the override clears when the conversation moves on', () => {
  assert.match(agentChat, /useEffect\(\(\) => \{[\s\S]{0,400}setSettingsAgentId\(null\);[\s\S]{0,50}\}, \[agentId\]\)/);
});

// #2214 code-review finding: the team-header row click (#2213) fires
// `onSelect` (routes to the team, changing `agentId`) and
// `onOpenTeamSettings` (sets the override) for the SAME target in one event
// handler — so the reset effect above, written for the pre-#2213 menu-only
// override where opening settings never moved the route, fired right after
// the render that set the override and unconditionally clobbered it back to
// null, and the Settings tab never actually showed. `handleOpenSettings` now
// also stamps a ref with the target it was just called for, and the reset
// effect consumes (and unconditionally clears) that ref before deciding
// whether to null the override.
test('an override set for the SAME target the route is about to become is not immediately clobbered (#2214)', () => {
  assert.match(agentChat, /const explicitSettingsTargetRef = useRef\(null\);/);
  const handler = code(agentChat).match(/const handleOpenSettings = useCallback\(\(id\) => \{[\s\S]*?\}, \[\]\);/)[0];
  assert.match(handler, /explicitSettingsTargetRef\.current = id;/);
  const resetEffect = code(agentChat).match(/useEffect\(\(\) => \{\s*const openedFor = explicitSettingsTargetRef\.current;[\s\S]*?\}, \[agentId\]\);/)[0];
  assert.match(resetEffect, /explicitSettingsTargetRef\.current = null;/);
  assert.match(resetEffect, /if \(openedFor === agentId\) return;/);
  assert.match(resetEffect, /setSettingsAgentId\(null\);/);
});

/* ── AC4: a restart is confirmed and reported ────────────────────── */

test('the chat asks before a re-provision, through one gate', () => {
  assert.match(panel, /confirmRestart/);
  // Every route to a persist goes through one gate, so no button bypasses it.
  assert.match(editForm, /function request\(nextRows\) \{[\s\S]*?if \(confirmRestart\) setPending\(nextRows\)/);
  assert.doesNotMatch(editForm, /onClick=\{\(\) => persist\(rows\)\}/);
  assert.match(panel, /onImmediateApply=\{handleImmediateApply\}/);
  assert.match(panel, /setNotice\(restartNoticeText\(info\)\)/);
});

/* ── AC2 / AC6: the panel's own contract ─────────────────────────── */

test('the panel saves through the ordinary agent PUT', () => {
  assert.match(panel, /apiCall\('PUT', `\/api\/agents\/\$\{encodeURIComponent\(agent\.id\)\}`, body\)/);
  assert.match(panel, /apiCall\('GET', `\/api\/agents\/\$\{encodeURIComponent\(id\)\}`\)/);
});

test('the panel only fetches while its tab is open', () => {
  // Every rail panel stays mounted behind display:none, so an unguarded effect
  // would pull a config on every agent switch for a tab nobody opened.
  assert.match(panel, /if \(!active\) return;/);
});

test('drafts go through the pure store and are dropped on save', () => {
  assert.match(panel, /putDraft\(draftsRef\.current, agent\.id, form\)/);
  assert.match(panel, /initialForm=\{getDraft\(draftsRef\.current, agent\.id\)\}/);
  assert.match(panel, /dropDraft\(draftsRef\.current, agent\.id\)/);
  assert.match(panel, /isFormDirty\(agent, form\)/);
});

test('the form is remounted only after the reload, so it shows what was stored', () => {
  const save = panel.match(/const handleSave[\s\S]*?\}, \[agent, load, onSaved\]\);/);
  assert.ok(save, 'handleSave is still there');
  assert.ok(
    save[0].indexOf('await load(agent.id)') < save[0].indexOf('setFormEpoch'),
    'the epoch bump must follow the reload, or the form rebuilds from the pre-save config',
  );
});
