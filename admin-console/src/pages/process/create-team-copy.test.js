import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CREATE_TEAM_LABEL,
  CREATE_TEAM_DIALOG_TITLE,
  CREATE_TEAM_DESCRIPTION,
  MATERIALIZE_BRIDGE,
  DRAFT_STATUS_LEAD,
  DRAFT_NEXT_STEP,
  OPEN_IN_AGENT_CHAT_LABEL,
  PROVISION_NOW_LABEL,
  PROVISION_NOW_HINT,
  draftStatusLine,
  createdTeamNotice,
  importedBlueprintCounts,
} from './create-team-copy.js';

// ─── The one verb (#2053 D1/D2, AC1/AC5/AC13) ────────────────────────────────

test('AC1 — the label is "Create team…", with the ellipsis that promises a dialog', () => {
  assert.equal(CREATE_TEAM_LABEL, 'Create team…');
  // One ellipsis character, not three dots: the toolbar's other dialog-openers
  // use the same glyph and a lookalike would read as a different button.
  assert.ok(CREATE_TEAM_LABEL.endsWith('…'));
  assert.doesNotMatch(CREATE_TEAM_LABEL, /\.\.\./);
});

test('AC5 — the word Materialize is gone from the label and the dialog title', () => {
  for (const s of [CREATE_TEAM_LABEL, CREATE_TEAM_DIALOG_TITLE]) {
    assert.doesNotMatch(s, /materializ/i, `"${s}" still carries the old word`);
  }
});

test('AC5 — it survives as the tooltip bridge, and only there', () => {
  // The bridge is the whole reason an existing user can still find the button.
  assert.match(CREATE_TEAM_DESCRIPTION, /materializ/i);
  assert.ok(CREATE_TEAM_DESCRIPTION.includes(MATERIALIZE_BRIDGE));
  assert.match(MATERIALIZE_BRIDGE, /^previously called Materialize$/);
  // …and it still says what the action DOES, not only what it used to be
  // called — a tooltip that is nothing but a rename note explains nothing.
  assert.match(CREATE_TEAM_DESCRIPTION, /real team/);
});

test('the dialog title carries no ellipsis — the button already promised the dialog', () => {
  assert.equal(CREATE_TEAM_DIALOG_TITLE, 'Create team');
  assert.doesNotMatch(CREATE_TEAM_DIALOG_TITLE, /…/);
  // One verb across button and title (AC13): the title is the label minus the
  // ellipsis, so the two cannot be reworded apart.
  assert.equal(`${CREATE_TEAM_DIALOG_TITLE}…`, CREATE_TEAM_LABEL);
});

// ─── The draft status line (#2053 B2/AC6) ────────────────────────────────────

test('AC6 — a draft with agents is told the next step, and it names the button', () => {
  const line = draftStatusLine(2, 'BLOCKED');
  assert.ok(line.startsWith(DRAFT_STATUS_LEAD), line);
  assert.ok(line.includes(DRAFT_NEXT_STEP), line);
  // The sentence points at the control by its own label, so a relabel cannot
  // leave the guidance naming a button that no longer exists.
  assert.ok(line.includes(CREATE_TEAM_LABEL), line);
  assert.doesNotMatch(line, /BLOCKED/);
});

test('AC6 — an empty draft reads the disabled-reason INLINE, not on hover', () => {
  const reason = 'Add at least one agent before you can turn this design into a real team.';
  const line = draftStatusLine(0, reason);
  assert.ok(line.startsWith(DRAFT_STATUS_LEAD), line);
  assert.ok(line.includes(reason), line);
});

test('the status line always says something, whatever the caller passes', () => {
  // `roleCount` comes off an optional-chained bundle, so undefined/NaN are the
  // normal loading states rather than programming errors — treated as empty,
  // like `toolbarTitle` treats them.
  for (const bad of [undefined, null, NaN, 'two', {}]) {
    const line = draftStatusLine(bad, 'reason here');
    assert.ok(line.startsWith(DRAFT_STATUS_LEAD), `${String(bad)} → ${line}`);
    assert.ok(line.includes('reason here'));
  }
  // No reason to show and no agents: still a sentence, never an empty strip.
  assert.ok(draftStatusLine(0).includes(DRAFT_NEXT_STEP));
});

// ─── The confirmation (#2053 D5/AC12) ───────────────────────────────────────

test('AC12 — the confirmation names the team and says the draft is now independent', () => {
  const notice = createdTeamNotice('Acme SDLC');
  assert.match(notice, /Acme SDLC/);
  assert.match(notice, /stays a draft/);
  // The point of the sentence: a reader must not think their next edit reaches
  // the team they just created.
  assert.match(notice, /no longer changes/);
});

test('AC12 — a nameless result yields no notice rather than an empty quote', () => {
  for (const bad of [undefined, null, '', '   ', 42]) {
    assert.equal(createdTeamNotice(bad), '', `${String(bad)} should produce nothing`);
  }
  assert.equal(createdTeamNotice('  Trimmed  '), createdTeamNotice('Trimmed'));
});

test('the confirmation offers a way onward, named after its destination (#2521 AC3)', () => {
  assert.equal(OPEN_IN_AGENT_CHAT_LABEL, 'Open in Agent Chat');
  assert.match(OPEN_IN_AGENT_CHAT_LABEL, /Agent Chat/);
});

// ─── The member-level act keeps its own verb (#2053 AC13) ────────────────────

test('AC13 — "provision" is the member act, and it does not reuse the team verb', () => {
  assert.equal(PROVISION_NOW_LABEL, 'Provision agents now');
  assert.doesNotMatch(PROVISION_NOW_LABEL, /create team/i);
  // The checkbox used to be "Materialize agents now", one step away from a
  // button that used "Materialize" for the OTHER act.
  assert.doesNotMatch(PROVISION_NOW_LABEL, /materializ/i);
});

test('AC13 — the hint still points at the Agent-Chat section that kept the old name', () => {
  // #2053 Non-goals leave Agent Chat's *Not materialized yet* / *Materialize*
  // alone, so the reworded checkbox has to quote that section by name or the
  // reader is told to "provision each on demand" with nowhere to do it.
  assert.match(PROVISION_NOW_HINT, /Not materialized yet/);
  assert.match(PROVISION_NOW_HINT, /stubs/);
  assert.match(PROVISION_NOW_HINT, /provision each on demand by enabling it/);
});

test('AC12 — the import path gets its own wording, because there is no draft', () => {
  // The import-preview banner's source is a read-only preview of a FILE, which
  // is discarded when the panel closes. "This design stays a draft" would send
  // that reader looking for a Drafts row that was never created.
  const draft = createdTeamNotice('Acme');
  const imported = createdTeamNotice('Acme', { fromImport: true });
  assert.notEqual(draft, imported);
  assert.match(draft, /stays a draft/);
  assert.doesNotMatch(imported, /stays a draft/);
  assert.match(imported, /not kept/);
  // Both name the team — that half of AC12 does not depend on the source.
  assert.match(imported, /Acme/);
  // An explicit `false` and an absent option must agree.
  assert.equal(createdTeamNotice('Acme', { fromImport: false }), draft);
  assert.equal(createdTeamNotice('Acme', {}), draft);
  // Still nothing to say without a name, on either path.
  assert.equal(createdTeamNotice('', { fromImport: true }), '');
});

// #2737 — the import banner counts what the Create team dialog counts: the
// bundle's agent roles, with human roles named separately.
test('import banner counts agents only, and names human roles apart', () => {
  const roles = n => Array.from({ length: n }, (_, i) => ({ id: `r${i}` }));
  assert.equal(importedBlueprintCounts({ roles: roles(10), humans: roles(3) }), '10 agents · 3 human roles');
  assert.equal(importedBlueprintCounts({ roles: roles(1), humans: roles(1) }), '1 agent · 1 human role');
  assert.equal(importedBlueprintCounts({ roles: roles(4) }), '4 agents');
  assert.equal(importedBlueprintCounts({ roles: roles(4), humans: [] }), '4 agents');
  assert.equal(importedBlueprintCounts(null), '0 agents');
});
