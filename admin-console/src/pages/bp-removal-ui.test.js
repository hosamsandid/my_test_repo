import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * bp-removal-ui.test.js — source-reading removal guard for BP removal Phase 3
 * (#1964, epic #1961).
 *
 * Most of what this phase removed lives in JSX that `node --test` cannot render
 * (#651), so the pure-model tests next door can only cover the grouping, the
 * menus and the save shapes. The rest — a role card, a field, an icon, a route,
 * a button — is only assertable as *absence from the source*, which is exactly
 * what a removal guard is for. It is the console-side sibling of Phase 1's
 * `orchestrator/bp-removal-guard.test.js`.
 *
 * The four acceptance criteria it locks:
 *   AC1  no console surface offers `Orchestrator` as a creatable role, and none
 *        of the in-scope surfaces render mission-specific fields, icons,
 *        grouping or vocabulary;
 *   AC2  the rail's grouping handles teams and standalone agents only (the
 *        behavioural half is `agent-chat/agent-list-model.test.js`);
 *   AC3  the hand-over dialog is present, rendered by nothing, and annotated
 *        with its reason and ticket reference;
 *   AC4  no dead `/orchestrator-wizard` route remains.
 *
 * **Comments are stripped before every "this is gone" assertion.** In a removal
 * PR the removal's own explanatory comments are what break the guard: they name
 * the deleted thing on purpose, and an unstripped sweep would flag the prose
 * that documents the removal. The strip is line-oriented for `//` (a URL's `//`
 * is always preceded by `:`, never at the start of a line) — see
 * `strip leaves real code standing` below, without which every `doesNotMatch`
 * here could pass for the wrong reason.
 */

const read = (rel) => readFileSync(
  fileURLToPath(new URL(`./${rel}`, import.meta.url)),
  'utf8',
);

/** Block comments, then whole-line `//` comments. Never a mid-line `//`. */
function strip(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
}

/**
 * Every surface #1964 touched, plus the two route registries the dead wizard
 * was listed in. Read once, comment-stripped once.
 */
const SURFACES = {
  'AgentChat.jsx': strip(read('AgentChat.jsx')),
  'agent-chat/AgentList.jsx': strip(read('agent-chat/AgentList.jsx')),
  'agent-chat/ChatPanel.jsx': strip(read('agent-chat/ChatPanel.jsx')),
  'agent-chat/agent-list-model.js': strip(read('agent-chat/agent-list-model.js')),
  'agent-chat/rail-lifecycle.js': strip(read('agent-chat/rail-lifecycle.js')),
  'agent-lifecycle/AgentCreateForm.jsx': strip(read('agent-lifecycle/AgentCreateForm.jsx')),
  'agent-lifecycle/AgentEditForm.jsx': strip(read('agent-lifecycle/AgentEditForm.jsx')),
  'agent-lifecycle/AgentLifecycleDialogs.jsx': strip(read('agent-lifecycle/AgentLifecycleDialogs.jsx')),
  'agent-lifecycle/agent-lifecycle-menu.js': strip(read('agent-lifecycle/agent-lifecycle-menu.js')),
  'agent-lifecycle/agent-edit-form-model.js': strip(read('agent-lifecycle/agent-edit-form-model.js')),
  'agent-create-submit-state.js': strip(read('agent-create-submit-state.js')),
  'SkillsRegistry.jsx': strip(read('SkillsRegistry.jsx')),
  // Was `teams-ownership.js` until #2085 dissolved the Access page and moved
  // its grouping helper into the Administration page's own pure module.
  'administration-view.js': strip(read('administration-view.js')),
  'pending-queue-view.js': strip(read('pending-queue-view.js')),
  '../App.jsx': strip(read('../App.jsx')),
  '../route-title.js': strip(read('../route-title.js')),
  '../components/breadcrumbs.js': strip(read('../components/breadcrumbs.js')),
};

/* ── the strip itself ───────────────────────────────────────────────── */

test('strip removes prose about the removal but leaves real code standing', () => {
  assert.equal(strip("// role === 'orchestrator'\nconst A = 1;").trim(), 'const A = 1;');
  assert.equal(strip('/* bp-instance */ const A = 1;').trim(), 'const A = 1;');
  // A URL's `//` must survive — it is never at the start of a line.
  assert.match(strip("const u = 'https://x/y';"), /https:\/\/x\/y/);
});

test('every swept surface still contains its own code after the strip', () => {
  // Without this, a strip that ate a file whole would make each `doesNotMatch`
  // below pass for the wrong reason (the Phase-1 lesson from orchestrator.js).
  const signatures = {
    'AgentChat.jsx': /function RailHeaderToggle/,
    'agent-chat/AgentList.jsx': /function iconForRole/,
    'agent-chat/ChatPanel.jsx': /HeaderOverflowMenu/,
    'agent-chat/agent-list-model.js': /export function buildGroups/,
    'agent-chat/rail-lifecycle.js': /export function deleteTargetFor/,
    // Was `function RoleCard` until #2233 removed the role picker outright
    // (the `agent`/`team` choice is gone, not merely relabelled); `hasRepos` is
    // the next-stablest thing this form defines that survives that removal.
    'agent-lifecycle/AgentCreateForm.jsx': /hasRepos/,
    // Was `RoleDetailBanner` until #2026 removed the role callout from this
    // form; the sub-control it defines is a stabler canary than any field.
    'agent-lifecycle/AgentEditForm.jsx': /function PromptModeControl/,
    'agent-lifecycle/AgentLifecycleDialogs.jsx': /export function renderDeleteMessage/,
    'agent-lifecycle/agent-lifecycle-menu.js': /export function deleteDialogCopy/,
    'agent-lifecycle/agent-edit-form-model.js': /export function buildEditSubmit/,
    'agent-create-submit-state.js': /PROMPT_OPTIONAL_ROLES/,
    'SkillsRegistry.jsx': /installableAgents/,
    'administration-view.js': /export function groupAgentsForOwnership/,
    'pending-queue-view.js': /const KIND_LABELS/,
    '../App.jsx': /<Routes>/,
    '../route-title.js': /ROUTE_TITLES/,
    '../components/breadcrumbs.js': /BREADCRUMBS/,
  };
  for (const [name, src] of Object.entries(SURFACES)) {
    assert.match(src, signatures[name], `${name} lost its own code to the strip`);
  }
});

/* ── AC1 / AC2: no BP handling left on any in-scope surface ─────────── */

const GONE = [
  // The two retired roles, however they are spelled in code.
  /'orchestrator'/,
  /"orchestrator"/,
  /'bp-instance'/,
  /"bp-instance"/,
  // Their data shape.
  /parentOrchestratorId/,
  /briefingsPath/,
  /\bbpId\b/,
  /\bbpSlug\b/,
  // Their vocabulary.
  /MissionDirectoryField/,
  /Mission Directory/,
  /Mission Agent/,
  /BriefingPack/,
  /bp-event-batch/,
];

test('AC1/AC2 — no in-scope surface carries BP roles, fields or vocabulary', () => {
  for (const [name, src] of Object.entries(SURFACES)) {
    for (const pattern of GONE) {
      assert.doesNotMatch(src, pattern, `${name} still references ${pattern}`);
    }
  }
});

test('#2233 — the create form offers no role choice at all any more', () => {
  // Superseded by #2233: the create form used to offer exactly `agent`/`team`
  // via a `RoleCard` picker (this test's prior assertion); the picker and its
  // backing catalogue (`agent-lifecycle/agent-form-fields.jsx`) are gone
  // outright, since the action always produces a plain agent now.
  const form = SURFACES['agent-lifecycle/AgentCreateForm.jsx'];
  assert.doesNotMatch(form, /<RoleCard/);
  assert.doesNotMatch(form, /function RoleCard/);
  assert.equal(
    existsSync(fileURLToPath(new URL('./agent-lifecycle/agent-form-fields.jsx', import.meta.url))),
    false,
  );
});

/* ── AC3: the hand-over dialog is stilled, not deleted ──────────────── */

const HANDOFF = 'agent-chat/HandoffDialog.jsx';

test('AC3 — the hand-over dialog is still in the tree', () => {
  assert.ok(
    existsSync(fileURLToPath(new URL(`./${HANDOFF}`, import.meta.url))),
    'epic decision R4 keeps the component so it can be revived rather than rebuilt',
  );
});

test('AC3 — the hand-over dialog is annotated with its reason and ticket', () => {
  // Deliberately read UNSTRIPPED: the annotation IS a comment.
  const raw = read(HANDOFF);
  assert.match(raw, /#1968/, 'the decision ticket must be named');
  assert.match(raw, /STILLED/i, 'the header must say the component is disconnected');
  assert.match(raw, /R4/, 'the epic decision that retained it must be named');
});

test('AC3 — nothing imports or renders the hand-over dialog', () => {
  for (const [name, src] of Object.entries(SURFACES)) {
    assert.doesNotMatch(src, /HandoffDialog/, `${name} still mounts the stilled dialog`);
  }
  // The button that used to mount it is gone from the session toolbar too.
  assert.doesNotMatch(SURFACES['agent-chat/ChatPanel.jsx'], /Hand-off|showHandoff/);
});

/* ── AC4: no dead route ─────────────────────────────────────────────── */

test('AC4 — the /orchestrator-wizard route and its page are gone', () => {
  assert.ok(
    !existsSync(fileURLToPath(new URL('./OrchestratorWizard.jsx', import.meta.url))),
    'the stub page itself must be deleted, not merely unrouted',
  );
  for (const name of ['../App.jsx', '../route-title.js', '../components/breadcrumbs.js']) {
    assert.doesNotMatch(SURFACES[name], /orchestrator-wizard/i, `${name} still lists the dead route`);
    assert.doesNotMatch(SURFACES[name], /OrchestratorWizard/, `${name} still imports the dead page`);
  }
});
