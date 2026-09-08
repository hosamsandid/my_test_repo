import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SCOPE_LABELS,
  INHERITED_ROW_NOTE,
  repositoryRows,
  agentScopedRows,
  shadowNote,
  availability,
  submitState,
  addDialogLead,
  removeConfirmation,
  attachedNotice,
  detachedNotice,
  emptyStateText,
} from './agent-repos-view.js';

const VIEW = {
  agentId: 'team-x-developer',
  agentName: 'Developer',
  environmentId: 'team-x',
  role: 'team-member',
  materialized: true,
  busy: false,
  canManage: true,
  repositories: [
    {
      url: 'git@github.com:org/app.git',
      dirName: 'app',
      branch: 'main',
      readOnly: false,
      scope: 'environment',
      removable: false,
      shadowed: false,
      facts: null,
    },
    {
      url: 'git@github.com:org/docs.git',
      dirName: 'docs',
      branch: null,
      readOnly: true,
      scope: 'agent',
      removable: true,
      shadowed: false,
      facts: { state: 'clean', clean: true, uncommittedFiles: 0, unpushedCommits: 0, lines: ['The working copy is clean and fully pushed — nothing unsaved would be lost.'] },
    },
  ],
};

// ── rows (AC7 / AC8) ────────────────────────────────────────────────────────

test('AC7: each row carries the scope it is stored at, plus a human label', () => {
  const rows = repositoryRows(VIEW);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].scope, 'environment');
  assert.equal(rows[0].scopeLabel, SCOPE_LABELS.environment);
  assert.equal(rows[1].scope, 'agent');
  assert.equal(rows[1].scopeLabel, SCOPE_LABELS.agent);
  assert.notEqual(rows[0].scopeLabel, rows[1].scopeLabel, 'the two must not read the same');
});

test('AC8: only the agent-scoped row is removable, and the inherited one says where to change it', () => {
  const rows = repositoryRows(VIEW);
  assert.equal(rows[0].removable, false);
  assert.equal(rows[1].removable, true);
  assert.match(INHERITED_ROW_NOTE, /Working Environment/);
});

test('the clone path is rendered in the same form the agent prompt uses', () => {
  assert.equal(repositoryRows(VIEW)[0].clonePath, './app/');
});

test('repositoryRows tolerates a missing or malformed view', () => {
  assert.deepEqual(repositoryRows(null), []);
  assert.deepEqual(repositoryRows({}), []);
  assert.deepEqual(repositoryRows({ repositories: 'nope' }), []);
});

test('agentScopedRows is the list the panel offers actions on', () => {
  assert.deepEqual(agentScopedRows(VIEW).map((r) => r.url), ['git@github.com:org/docs.git']);
});

// ── the environment-caught-up edge case ─────────────────────────────────────

test('a shadowed row explains that removing it leaves the files alone', () => {
  const shadowed = {
    ...VIEW,
    repositories: [{ ...VIEW.repositories[1], shadowed: true, dirName: 'tools' }],
  };
  const row = repositoryRows(shadowed)[0];
  const note = shadowNote(row);
  assert.match(note, /\.\/tools\//);
  assert.match(note, /leaves the working copy in place/);
  assert.equal(shadowNote({ shadowed: false }), null);
  assert.equal(shadowNote(null), null);
});

// ── availability (AC12 / AC16 / AC17) ───────────────────────────────────────

test('an idle, manageable agent may attach and remove', () => {
  assert.deepEqual(availability(VIEW), { canAttach: true, canRemove: true, reason: null });
});

test('AC16: a team record and a stub are refused with a stated reason', () => {
  const team = availability({ ...VIEW, role: 'team' });
  assert.equal(team.canAttach, false);
  assert.match(team.reason, /no container and no workspace/);

  const stub = availability({ ...VIEW, materialized: false });
  assert.equal(stub.canAttach, false);
  assert.match(stub.reason, /Materialize it first/);
});

test('AC12: a chat-only user gets no action, with the reason in the title', () => {
  const readOnly = availability({ ...VIEW, canManage: false });
  assert.equal(readOnly.canAttach, false);
  assert.equal(readOnly.canRemove, false);
  assert.match(readOnly.reason, /permission/);
});

test('AC17: a running session blocks removal only, and says why', () => {
  const busy = availability({ ...VIEW, busy: true });
  assert.equal(busy.canAttach, true);
  assert.equal(busy.canRemove, false);
  assert.match(busy.reason, /only adds a new directory/);
});

test('the team check wins over busy, so a team never reads as merely busy', () => {
  const teamBusy = availability({ ...VIEW, role: 'team', busy: true });
  assert.equal(teamBusy.canAttach, false);
});

test('availability tolerates a missing view', () => {
  assert.deepEqual(availability(undefined), { canAttach: true, canRemove: true, reason: null });
});

// ── add dialog (AC3) ────────────────────────────────────────────────────────

test('AC3: the probe never gates the submit — only an empty URL does', () => {
  assert.equal(submitState({ url: '' }).enabled, false);
  assert.equal(submitState({ url: '   ' }).enabled, false);
  assert.equal(submitState({ url: 'git@github.com:org/x.git' }).enabled, true);
  // …including an unreachable one: the probe result is not an input here.
  assert.equal(submitState({ url: 'git@nope.invalid:x/y.git' }).enabled, true);
  assert.equal(submitState({ url: 'git@github.com:org/x.git' }, { saving: true }).enabled, false);
  assert.match(submitState({ url: '' }).reason, /repository URL/);
});

test('AC10: the lead says the change touches this agent and nothing else', () => {
  const lead = addDialogLead(VIEW);
  assert.match(lead, /Developer's own workspace/);
  assert.match(lead, /team-x/);
  assert.match(lead, /no other agent in it is affected/);
  // Repo-less / env-less agent: still says it, without a dangling id.
  const bare = addDialogLead({ agentName: 'Solo' });
  assert.match(bare, /no other agent in it is affected/);
  assert.doesNotMatch(bare, /\(\)/);
});

// ── remove confirmation (AC9) ───────────────────────────────────────────────

test('AC9: the confirmation says the working copy is deleted and names it', () => {
  const row = agentScopedRows(VIEW)[0];
  const c = removeConfirmation(row);
  assert.match(c.title, /git@github\.com:org\/docs\.git/);
  assert.match(c.lines[0], /working copy at \.\/docs\/ is deleted/);
  assert.match(c.lines[1], /clean and fully pushed/);
  assert.match(c.lines[2], /no other agent is affected/);
  assert.equal(c.destructive, false, 'a clean copy is not a red-button decision');
  assert.equal(c.confirmLabel, 'Delete and remove');
});

test('AC9: dirty work is named concretely and the confirm turns destructive', () => {
  const row = {
    ...agentScopedRows(VIEW)[0],
    facts: {
      state: 'dirty',
      clean: false,
      uncommittedFiles: 4,
      unpushedCommits: 2,
      lines: ['4 uncommitted changes (1 staged, 2 unstaged, 1 untracked) would be lost.', '2 commits have not been pushed and would be lost.'],
    },
  };
  const c = removeConfirmation(row);
  assert.match(c.lines.join(' '), /4 uncommitted changes/);
  assert.match(c.lines.join(' '), /2 commits have not been pushed/);
  assert.equal(c.destructive, true);
});

test('an absent working copy is stated, not warned about', () => {
  const row = { ...agentScopedRows(VIEW)[0], facts: { state: 'absent', clean: true, lines: [] } };
  const c = removeConfirmation(row);
  assert.match(c.lines[0], /no working copy/);
  assert.equal(c.destructive, false);
});

test('a shadowed row is confirmed as an attachment removal, not a deletion', () => {
  const row = { ...agentScopedRows(VIEW)[0], shadowed: true, dirName: 'tools', clonePath: './tools/' };
  const c = removeConfirmation(row);
  assert.match(c.lines[0], /leaves the working copy in place/);
  assert.equal(c.destructive, false);
  assert.equal(c.confirmLabel, 'Remove attachment');
  assert.doesNotMatch(c.lines.join(' '), /is deleted/);
});

test('removeConfirmation tolerates no row', () => {
  assert.deepEqual(removeConfirmation(null), { title: '', lines: [], destructive: false });
});

// ── notices ─────────────────────────────────────────────────────────────────

test('the attach notice names the directory and when the agent learns about it', () => {
  const n = attachedNotice({ dirName: 'docs' });
  assert.match(n, /\.\/docs\//);
  assert.match(n, /next run/);
});

test('the detach notice reports which of the three things actually happened', () => {
  assert.match(detachedNotice({ dirName: 'docs', deleted: true }), /\.\/docs\/ was deleted/);
  assert.match(detachedNotice({ dirName: 'docs', deleted: false }), /no working copy to delete/);
  assert.equal(detachedNotice({ keptReason: 'kept because X' }), 'kept because X');
});

test('the empty state distinguishes "no repositories" from "none of your own"', () => {
  assert.match(emptyStateText({ repositories: [] }), /declares none/);
  assert.match(emptyStateText({ repositories: [VIEW.repositories[0]] }), /comes from its\s+Working Environment/);
});
