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
 * one: `AgentChat.jsx`, `RightRail.jsx`, `AgentSettingsPanel.jsx`, `Agents.jsx`
 * and `AgentEditForm.jsx` are JSX, which `node --test` does not load (#651), so
 * a re-implemented form, a dropped prop or a lost tab would leave every pure
 * test green while the feature silently died.
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
const agentsPage = code(read('../Agents.jsx'));
const editForm = code(read('../agent-lifecycle/AgentEditForm.jsx'));

/* ── AC7: one form, two surfaces ─────────────────────────────────── */

test('both surfaces import the same edit form instead of defining one', () => {
  assert.match(agentsPage, /import AgentEditForm from '\.\/agent-lifecycle\/AgentEditForm\.jsx'/);
  assert.match(panel, /import AgentEditForm from '\.\.\/agent-lifecycle\/AgentEditForm\.jsx'/);
  // A second definition anywhere is the failure this whole ticket is about.
  assert.doesNotMatch(agentsPage, /function AgentEditForm\s*\(/);
  assert.doesNotMatch(panel, /function AgentEditForm\s*\(/);
});

test('the form and its sub-controls live in exactly one place', () => {
  for (const symbol of [
    'AgentEditForm', 'PluginGrantSection', 'ContextMountControl',
    'PromptModeControl', 'InheritOrCustom',
  ]) {
    assert.doesNotMatch(
      agentsPage, new RegExp(`function ${symbol}\\s*\\(`),
      `${symbol} must not be redefined on the Agents page`,
    );
    assert.match(
      editForm, new RegExp(`function ${symbol}\\s*\\(`),
      `${symbol} must be defined in the shared module`,
    );
  }
});

test('the shared field controls are imported back, not re-typed', () => {
  // The create form still renders these, so the move only works if it imports
  // the same ones the edit form does.
  assert.match(agentsPage, /from '\.\/agent-lifecycle\/agent-form-fields\.jsx'/);
  for (const symbol of ['ROLE_INFO', 'RoleDetailBanner', 'MissionDirectoryField', 'repoDirName']) {
    assert.doesNotMatch(
      agentsPage, new RegExp(`(function|const) ${symbol}\\b\\s*[({=]`),
      `${symbol} must not be redefined on the Agents page`,
    );
  }
});

test('the shape logic is the pure module, not inlined in the form again', () => {
  assert.match(editForm, /from '\.\/agent-edit-form-model\.js'/);
  assert.match(editForm, /buildInitialForm\(agent\)/);
  assert.match(editForm, /onSave\(buildEditSubmit\(agent, form\)\)/);
});

/* ── AC9: the Agents page keeps its behaviour ────────────────────── */

test('the Agents page passes none of the chat-only props (no regression)', () => {
  const call = agentsPage.match(/<AgentEditForm[\s\S]*?\/>/);
  assert.ok(call, 'the Agents page still renders the form');
  for (const prop of ['initialForm', 'onFormChange', 'confirmRestart', 'onImmediateApply']) {
    assert.doesNotMatch(call[0], new RegExp(prop), `${prop} must stay off the Agents page call`);
  }
  // Its Cancel button closes the side panel, so onCancel must still be given.
  assert.match(call[0], /onCancel=\{closePanel\}/);
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
  assert.match(agentChat, /useEffect\(\(\) => \{ setSettingsAgentId\(null\); \}, \[agentId\]\)/);
});

/* ── AC4: a restart is confirmed and reported ────────────────────── */

test('the chat asks before a re-provision; the Agents page still does not', () => {
  assert.match(panel, /confirmRestart/);
  // Every route to a persist goes through one gate, so no button bypasses it.
  assert.match(editForm, /function request\(nextRows\) \{[\s\S]*?if \(confirmRestart\) setPending\(nextRows\)/);
  assert.doesNotMatch(editForm, /onClick=\{\(\) => persist\(rows\)\}/);
  assert.match(panel, /onImmediateApply=\{handleImmediateApply\}/);
  assert.match(panel, /setNotice\(restartNoticeText\(info\)\)/);
});

/* ── AC2 / AC6: the panel's own contract ─────────────────────────── */

test('the panel saves through the same PUT the Agents page uses', () => {
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
