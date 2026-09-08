import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CREATE_TEAM_LABEL } from './process/create-team-copy.js';
import { buildFlowsRailMenu } from './process/flows-rail-menu.js';

/**
 * Drift guard for the #2053 "design → live team" wiring (AC11, the #651
 * convention).
 *
 * The pure modules beside this one decide the label, the tooltip, the status
 * line, the confirmation and the menu items — but the *wiring* lives in JSX
 * (`ProcessCanvas.jsx`, `Briefings.jsx`, `process/MaterializeDialog.jsx`,
 * `process/LaunchStep.jsx`), which `node --test` cannot load. Without these
 * assertions a dropped prop or a re-inlined string would leave every pure test
 * green while the toolbar quietly went back to two vocabularies, or the rail
 * lost its menu.
 *
 * These read the sources, in the same spirit as `rail-lifecycle-wiring.test.js`.
 * They check wiring and the few strings that ARE the acceptance criteria; a
 * reworded sentence inside a pure module is free to change.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = rel => fs.readFileSync(path.join(HERE, rel), 'utf8');

// Comments are stripped first so a comment *naming* a symbol cannot stand in for
// the call that should be there — every file here carries long explanatory
// comments that mention the old vocabulary on purpose.
function code(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

const canvasRaw = read('ProcessCanvas.jsx');
const canvas = code(canvasRaw);
const briefingsRaw = read('Briefings.jsx');
const briefings = code(briefingsRaw);
const dialog = code(read('process/MaterializeDialog.jsx'));
const launch = code(read('process/LaunchStep.jsx'));
const menuComponent = code(read('../components/RowContextMenu.jsx'));
const hints = code(read('process-toolbar-hints.js'));

// ─── B1: one component, one label, one tooltip source (AC1–AC5) ─────────────

test('AC1/AC5 — no surface spells the label or the old word inline', () => {
  // The label reaches the DOM only through the constant, so the four stations
  // (#2053 D1) cannot be reworded apart again.
  for (const [name, src] of [['ProcessCanvas', canvas], ['Briefings', briefings], ['MaterializeDialog', dialog]]) {
    assert.doesNotMatch(src, /Materialize…|Materialize as team/, `${name} still renders the old label`);
    assert.doesNotMatch(src, /['"]Create team…['"]/, `${name} inlines the label instead of importing it`);
  }
  assert.match(canvas, /CREATE_TEAM_LABEL/);
  assert.match(dialog, /CREATE_TEAM_DIALOG_TITLE/);
});

test('AC2 — ToolbarButton has a variant mechanism and secondary is the default', () => {
  assert.match(canvas, /function ToolbarButton\(\{[^}]*variant = 'secondary'/);
  // The accent styling is conditional on it, so a `secondary` button renders
  // exactly as it did before this ticket.
  assert.match(canvas, /const primary = variant === 'primary';/);
  assert.match(canvas, /primary \? 'var\(--eb-accent-primary\)' : 'var\(--eb-bg-surface\)'/);
});

test('AC1 — exactly one button in the toolbar is primary, and it is the create action', () => {
  // `CreateTeamButton` is the only `variant="primary"` in the file; every other
  // toolbar entry takes the default. A row of accents ranks nothing.
  assert.equal((canvas.match(/variant="primary"/g) || []).length, 1);
  assert.match(canvas, /function CreateTeamButton\([\s\S]{0,400}variant="primary"/);
});

test('AC4 — the import banner renders the same component, not a raw button', () => {
  // Two call sites, one component: the toolbar and the import-preview banner.
  assert.equal((canvas.match(/<CreateTeamButton/g) || []).length, 2);
  // The banner's own hardcoded string and its native `title=` (which skipped
  // the #1999 tooltip migration) are gone.
  assert.doesNotMatch(canvas, /title="Create a real team and its agents from this imported design"/);
});

test('AC4 — both call sites are disabled by the same rule, read from role count', () => {
  // The banner had NO disabled state at all, so an imported bundle with zero
  // roles was clickable there and greyed out two centimetres away.
  assert.match(canvas, /function CreateTeamButton\([\s\S]*?disabled=\{!!hasProposal \|\| !roleCount\}/);
  assert.match(canvas, /<CreateTeamButton[\s\S]{0,200}roleCount=\{draftBundle\?\.roles\?\.length \|\| 0\}/);
  assert.match(canvas, /<CreateTeamButton[\s\S]{0,200}roleCount=\{materializeBundle\?\.roles\?\.length \|\| 0\}/);
});

test('AC4 — the tooltip comes from the shared hints module on both call sites', () => {
  assert.match(canvas, /function CreateTeamButton\([\s\S]*?toolbarTitle\('materialize'/);
  // The copy itself lives in create-team-copy.js and carries the bridge, so the
  // hints module must not re-inline a description of its own.
  assert.match(hints, /materialize: CREATE_TEAM_DESCRIPTION/);
});

test('AC3 — the create action is fenced off and sits ahead of Export', () => {
  assert.match(canvas, /<ToolbarSeparator \/>\s*<CreateTeamButton/);
  // Export is rendered after both scope branches, so "last in the draft group"
  // means the draft fragment ends with the create button.
  assert.match(canvas, /<CreateTeamButton[\s\S]{0,300}\/>\s*<\/>\s*\)\}/);
  assert.match(canvas, /function ToolbarSeparator\([\s\S]{0,300}aria-hidden="true"/);
});

// ─── B2: the draft says its next step (AC6, AC7) ────────────────────────────

test('AC6 — the draft carries a persistent status line, guarded like the live strip', () => {
  assert.match(canvas, /\{isDraft && draftBundle && !imported && !proposal && \(/);
  assert.match(canvas, /draftStatusText\(draftBundle\?\.roles\?\.length \|\| 0\)/);
  // Not a Tooltip: the whole point is that it is readable without hovering.
  assert.doesNotMatch(canvas, /<Tooltip[^>]*draftStatusText/);
});

test('AC6 — the disabled-reason is single-sourced, not restated in the JSX', () => {
  assert.match(hints, /export function draftStatusText/);
  assert.match(hints, /draftStatusLine\(roleCount, NO_ROLES_REASON\)/);
  assert.doesNotMatch(canvas, /Add at least one agent/);
});

test('AC7 — the empty-canvas copy names the sequence in the new vocabulary', () => {
  assert.match(canvas, /function EmptyCanvasState\([\s\S]*?\{CREATE_TEAM_LABEL\}/);
  assert.doesNotMatch(canvas, /then materialize it into a live team/);
});

// ─── B4: the result is confirmed (AC12) ─────────────────────────────────────

test('AC12 — the dialog no longer navigates away the instant the stream completes', () => {
  // It used to call onDone() + navigate() straight out of onComplete, which is
  // why nothing ever said what had happened.
  assert.doesNotMatch(dialog, /onComplete=\{\(\) => \{\s*onDone\?\.\(\);/);
  assert.match(dialog, /onComplete=\{\(result\) => onCreated\?\.\(result\)\}/);
  // The navigation is now an explicit click on the completion action.
  assert.match(dialog, /completionAction=\{\([\s\S]{0,400}navigate\(`\/process\/\$\{encodeURIComponent\(values\.teamId\)\}`\)/);
});

test('AC12 — the notice is derived from the created team, in the shared copy module', () => {
  assert.match(canvas, /createdTeamNotice\(createdTeam, \{ fromImport: !!imported \}\)/);
  assert.match(canvas, /onCreated=\{\(result\) => setCreatedTeam\(result\?\.teamName \|\| null\)\}/);
  assert.match(dialog, /completionNotice=\{createdNotice\}/);
});

test('AC12 — LaunchStep renders the notice inside its result card, additively', () => {
  assert.match(launch, /completionNotice = ''/);
  assert.match(launch, /completionAction = null/);
  assert.match(launch, /\{completionNotice && \(/);
  assert.match(launch, /\{result && completionAction && \(/);
  // Both props are optional, so the Team-Setup wizard — which navigates away on
  // completion and passes neither — is unchanged.
  assert.match(launch, /\{launchResultMessage\(result\)\}/);
});

test('AC13 — the provision-now checkbox reads its copy from the shared module', () => {
  assert.match(launch, /\{PROVISION_NOW_LABEL\} — \{PROVISION_NOW_HINT\}/);
  assert.doesNotMatch(launch, /Materialize agents now/);
});

// ─── B3: the rail context menu (AC8–AC11) ───────────────────────────────────

test('AC8 — all three entry points open the menu on a rail row', () => {
  assert.match(briefings, /onContextMenu=\{onRequestMenu \?/);
  assert.match(briefings, /e\.key === 'ContextMenu' \|\| \(e\.shiftKey && e\.key === 'F10'\)/);
  assert.match(briefings, /<KebabButton/);
});

test('AC8 — both row kinds report a menu request, with their own target shape', () => {
  // Two call sites: the Teams list and the Drafts list. A team row had no
  // per-row affordance at all before this ticket.
  assert.equal((briefings.match(/onRequestMenu=\{\(anchor\) => handleRequestMenu\(/g) || []).length, 2);
  assert.match(briefings, /\{ kind: 'team', id: t\.id, name: t\.displayName \|\| t\.id \}/);
  assert.match(briefings, /\{ kind: 'draft', id: d\.id, name: d\.name, roleCount: d\.roleCount \}/);
  // The draft target carries roleCount because that is what makes the menu's
  // create entry inert on an empty design; dropping it would silently enable it.
  assert.match(buildFlowsRailMenu({ kind: 'draft', name: 'x', roleCount: 0 }).items[0].title, /agent/);
});

test('AC9 — the hover trash icon is gone and delete lives in the menu', () => {
  assert.doesNotMatch(briefingsRaw, /Trash2/);
  assert.doesNotMatch(briefings, /onDelete/);
  // Still the same ConfirmDialog, reached through the menu's own key.
  assert.match(briefings, /if \(key === 'delete'\) \{ setDeleteTarget\(/);
  assert.match(briefings, /onConfirm=\{confirmDeleteDraft\}/);
});

test('AC10 — RowContextMenu is shared, and nothing in it is rail-specific', () => {
  // It lives in components/ and imports only its own pure sibling — a component
  // there reaching back into a pages/ folder is the import direction this tree
  // does not have anywhere else.
  assert.match(menuComponent, /from '\.\/row-context-menu-view\.js'/);
  assert.doesNotMatch(menuComponent, /agent-chat|rail-lifecycle|header-overflow-menu/);
  // The fence is still a flag on the following item, not a pseudo-item (#1938).
  assert.match(menuComponent, /item\.separated/);
  // Both rails render the one component.
  assert.match(briefings, /import RowContextMenu from '\.\.\/components\/RowContextMenu\.jsx'/);
  assert.match(code(read('agent-chat/RailLifecycleHost.jsx')), /from '\.\.\/\.\.\/components\/RowContextMenu\.jsx'/);
});

test('AC11 — the page owns the menu state; the items come from the pure builder', () => {
  assert.match(briefings, /const \[menuRequest, setMenuRequest\] = useState\(null\)/);
  assert.match(briefings, /buildFlowsRailMenu\(menuRequest\?\.target\)/);
  assert.match(briefings, /\{menuRequest && railMenu\.items\.length > 0 && \(/);
  // No item literal in the JSX — the whole point of the pure module.
  assert.doesNotMatch(briefings, /key: 'create-team'/);
});

test('the two canvas actions are handed over as an intent, not re-implemented', () => {
  // A second POST /api/process/drafts with its own error handling is exactly
  // how two front doors diverge; the rail selects the row instead.
  assert.match(briefings, /const intent = intentForMenuKey\(key\);/);
  assert.match(briefings, /selectProc\([\s\S]{0,120}\{ intent \}\)/);
  assert.doesNotMatch(briefings, /sourceTeamId/);
  assert.match(canvas, /if \(pendingIntent === FLOW_INTENTS\.createTeam\) \{/);
  assert.match(canvas, /if \(pendingIntent === FLOW_INTENTS\.editAsDraft\) editAsDraft\(false\)/);
});

test('the intent fires once per request, guarded by the param and not by a ref', () => {
  // A ref would latch after the first use, so choosing the same entry again —
  // or choosing it for the row that is already open, which changes the prop
  // without remounting the scope-keyed panel — would silently do nothing.
  assert.doesNotMatch(canvas, /intentConsumed/);
  assert.match(canvas, /useEffect\(\(\) => \{\s*if \(!pendingIntent\) return;/);
  assert.match(canvas, /if \(onIntentConsumed\) onIntentConsumed\(\)/);
  // Both intents are acted on in that effect, not one there and one in a
  // useState initializer the same-scope case would never re-read.
  assert.match(canvas, /if \(pendingIntent === FLOW_INTENTS\.createTeam\) \{/);
  assert.match(canvas, /const \[materializeOpen, setMaterializeOpen\] = useState\(false\)/);
  assert.match(briefings, /parseFlowIntent\(searchParams\.get\('intent'\)\)/);
  assert.match(briefings, /const clearPendingIntent = useCallback/);
  assert.match(briefings, /onIntentConsumed=\{clearPendingIntent\}/);
});

test('both export buttons on the page go through the shared download helper', () => {
  assert.match(canvas, /downloadBundle\(bundle\)/);
  assert.match(briefings, /downloadBundle\(bundle\)/);
  // The inline filename rule is gone from the canvas, so the two cannot drift.
  assert.doesNotMatch(canvas, /\.process\.json/);
});

test('rename is reachable from the rail and follows the id the server re-derives', () => {
  // The PUT re-derives the storage id from the new name (#581), so assuming the
  // old id would leave the page pointing at a draft that no longer exists.
  assert.match(briefings, /apiCall\('PUT', `\/api\/process\/drafts\/\$\{d\.id\}`/);
  assert.match(briefings, /saved\?\.id && saved\.id !== d\.id/);
  assert.match(briefings, /selectProc\(`draft:\$\{saved\.id\}`, \{ copilot: copilotParam \}\)/);
});

// ─── AC17: the first-time user's path, end to end ───────────────────────────

test('AC17 — nothing on the draft path requires a hover or the old word', () => {
  // Three independent, hover-free signals on an empty draft: the accent-coloured
  // fenced button (position + separator + colour), the inline status line, and
  // the empty-canvas copy naming the sequence. The pure modules assert the copy;
  // this asserts all three are actually mounted on the draft branch.
  assert.match(canvas, /<CreateTeamButton/);
  assert.match(canvas, /draftStatusText\(/);
  assert.match(canvas, /function EmptyCanvasState/);
  // And the label a newcomer reads is the one the launcher promised.
  assert.match(CREATE_TEAM_LABEL, /team/i);
});

// ─── Regressions the review pass found, which no other guard covers ─────────

test('the rail intent honours the proposal rule the rail itself cannot see', () => {
  // The menu gates on roleCount, which it reads off the drafts list — a pending
  // Copilot proposal is panel state. Choosing `Create team…` for the row that is
  // ALREADY open (so the scope-keyed panel does not remount and the proposal
  // survives) would otherwise create a real team from the design UNDERNEATH the
  // one on screen.
  assert.match(canvas, /if \(proposal\) setIntentRefused\(true\)/);
  assert.match(canvas, /else setMaterializeOpen\(true\)/);
  // The refusal is guarded on `proposal`, so it cannot outlive the state it
  // describes — `importError` is cleared only on a scope change, so the sentence
  // would still be on screen after a Discard.
  assert.match(canvas, /\{isDraft && proposal && intentRefused && \(/);
  assert.doesNotMatch(canvas, /setImportError\(PROPOSAL_PENDING_REASON\)/);
});

test('a successful creation clears the import preview on every close path', () => {
  // Before the confirmation existed the dialog closed itself on completion, so
  // Escape-after-success was unreachable; the preview's own `Create team…` would
  // now re-submit the identical bundle into the collision card.
  assert.match(canvas, /if \(createdTeam && imported\) \{/);
  // Clearing `imported` alone is not enough: in `import` scope it is the ONLY
  // source of a graph, so the pane would sit on a permanent "Loading graph…"
  // with no toolbar and no banner. Hand the parent back, like the banner's X.
  assert.match(canvas, /if \(createdTeam && imported\) \{[\s\S]{0,200}if \(isImportPreview && onImportClosed\) onImportClosed\(\)/);
});

test('the confirmation does not promise a draft on the import path', () => {
  assert.match(canvas, /createdTeamNotice\(createdTeam, \{ fromImport: !!imported \}\)/);
});

test('the draft status strip waits for the bundle before stating a reason', () => {
  // Without the guard a six-agent draft reads "add at least one agent" for the
  // duration of the GET — a strip that replaces a hover-only reason must not
  // state a false one.
  assert.match(canvas, /\{isDraft && draftBundle && !imported && !proposal && \(/);
});

test('a rename that does NOT re-key still reaches the open canvas', () => {
  // A case-only rename keeps the slug, so `proc` is unchanged and the canvas
  // keeps its fetched bundle — which it PUTs back on the next edit, silently
  // undoing the rename.
  assert.match(briefings, /setDraftReload\(n => n \+ 1\)/);
  // A REFETCH token, not part of the panel's `key`: a remount would also discard
  // an unapplied Copilot proposal and close the Copilot rail.
  assert.match(briefings, /draftReloadToken=\{draftReload\}/);
  assert.match(briefings, /key=\{proc\}/);
  assert.match(canvas, /\}, \[draftId, draftReloadToken\]\);/);
  // And the re-keying branch, which DOES remount, carries the Copilot panel
  // across the way the canvas's own rename does.
  assert.match(briefings, /selectProc\(`draft:\$\{saved\.id\}`, \{ copilot: copilotParam \}\)/);
});

test('the rename cannot be forked by key-repeat, and the field really gets focus', () => {
  assert.match(briefings, /if \(!d \|\| !name \|\| renameBusy\) return;/);
  // `autoFocus` and a child effect both lose to ConfirmDialog's own focus
  // effect, so the caret would not be in the field and Enter would activate
  // the confirm button with the value unchanged.
  assert.doesNotMatch(briefings, /autoFocus/);
  // Both calls, in this order: `select()` only sets the selection range and does
  // not move focus, so selecting without focusing leaves the Enter reflex on the
  // confirm button — the very bug this is here to fix.
  assert.match(briefings, /renameInputRef\.current\?\.focus\(\);\s*renameInputRef\.current\?\.select\(\);/);
});

test('no user-visible surface still points at the removed toolbar label', () => {
  // The Copilot panel's team-scope card told the very user about to press
  // *Edit as draft* to look for a button that no longer exists.
  const copilot = code(read('process/FlowCopilotPanel.jsx'));
  assert.doesNotMatch(copilot, /Materialize/);
});
