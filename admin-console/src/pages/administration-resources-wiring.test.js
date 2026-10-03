import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Source-reading drift guard for Administration → Resources and the user forms
// (#2695, #651). The option lists, owner names, counts and email rule are
// unit-tested in administration-view.test.js / environment-ownership-view.test.js
// / users-view.test.js; what cannot be tested there is that the JSX actually
// uses them. Each failure is silent: pointed back at the legacy access-scope
// list, the picker offers only "Default Team" and quietly shows it for an
// Agent-Team-owned environment; a raw `ownerId` renders a UUID for a person.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const USERS = fs.readFileSync(path.join(HERE, 'Users.jsx'), 'utf8');
const OWNERSHIP = fs.readFileSync(path.join(HERE, '..', 'components', 'EnvironmentOwnership.jsx'), 'utf8');

function code(src) {
  return src
    .split('\n')
    .filter(l => !/^\s*\/\//.test(l) && !/^\s*import\s/.test(l))
    .join('\n')
    .replace(/\s+/g, ' ');
}

const CHECKS = {
  // Ownership options are Agent Teams, through the pure helper, and reach the
  // environment editor.
  'team-options-sourced-from-agent-teams'({ users }) {
    return users.includes("useApi('/api/agents')")
      && users.includes('useMemo(() => agentTeamOwnerOptions(agents), [agents])')
      && users.includes('teams={teamList}');
  },
  // The legacy access-scope collection is not fetched on this page at all.
  'legacy-team-collection-not-fetched'({ users }) {
    return !/useApi\(\s*'\/api\/admin\/teams'/.test(users);
  },
  // Agent rows are read-only: no per-agent select writing a teamId.
  'agent-rows-read-only'({ users }) {
    return !users.includes('<TeamSelect') && !users.includes('{ teamId });')
      && users.includes('<OwnershipNote agent={team} />');
  },
  // Personal-resource owner resolves to a name in the row and the confirmation.
  'owner-name-resolved-in-row'({ users }) {
    return users.includes('owner {ownerLabel(r.ownerId, userNames)}');
  },
  'owner-name-resolved-in-confirm'({ users }) {
    return users.includes('owned by ${ownerLabel(confirm.ownerId, userNames)}?');
  },
  'owner-index-from-user-records'({ users }) {
    return users.includes("useApi('/api/admin/users')")
      && users.includes('useMemo(() => userNameIndex(users), [users])')
      && users.includes('<PersonalResourcesSection onError={setActionError} userNames={userNames} />');
  },
  // The section heading counts agents through the helper.
  'agents-heading-from-helper'({ users }) {
    return users.includes('title={agentsSectionTitle({ agentTeams, standaloneAgents })}');
  },
  // Both user forms validate the email.
  'email-validated-on-create'({ users }) {
    return users.includes("validateUserForm({ subject, displayName, email }, 'create')");
  },
  'email-validated-on-edit'({ users }) {
    return users.includes("validateUserForm({ subject: user.subject, displayName, email }, 'edit')");
  },
  // The select renders its current value as an option; the shared list keeps
  // every assigned team visible.
  'select-renders-current-value'({ ownership }) {
    return ownership.includes('teamOptionsWithCurrent(teamOptions, own.teamId)')
      && ownership.includes('{selectOptions.map(t => (');
  },
  'assigned-list-keeps-unknown-ids'({ ownership }) {
    return ownership.includes('teamOptionsWithAssigned(teams, own.assignedTeamIds)')
      && ownership.includes('{assignableTeams.map(t => (');
  },
  // The environment editor's copy talks about environments.
  'copy-not-credential'({ ownership }) {
    return !/credential/i.test(ownership);
  },
};

function runCheck(users, ownership) {
  const ctx = { users: code(users), ownership: code(ownership) };
  for (const [name, fn] of Object.entries(CHECKS)) {
    if (!fn(ctx)) return name;
  }
  return null;
}

test('#2695: Resources tab and user forms are wired to the pure helpers', () => {
  assert.equal(runCheck(USERS, OWNERSHIP), null);
});

const MUTATIONS = [
  ['team-options-sourced-from-agent-teams', 'users', 'agentTeamOwnerOptions(agents), [agents]', '(agents ?? []), [agents]'],
  ['legacy-team-collection-not-fetched', 'users', "  const { data: users } = useApi('/api/admin/users');\n  const [actionError", "  const { data: users } = useApi('/api/admin/users');\n  useApi('/api/admin/teams');\n  const [actionError"],
  ['agent-rows-read-only', 'users', '<OwnershipNote agent={team} />', '<TeamSelect value={team.teamId} />'],
  ['owner-name-resolved-in-row', 'users', 'owner {ownerLabel(r.ownerId, userNames)}', "owner {r.ownerId || 'unknown'}"],
  ['owner-name-resolved-in-confirm', 'users', 'owned by ${ownerLabel(confirm.ownerId, userNames)}?', "owned by ${confirm.ownerId || 'unknown'}?"],
  ['owner-index-from-user-records', 'users', 'onError={setActionError} userNames={userNames} />', 'onError={setActionError} />'],
  ['agents-heading-from-helper', 'users', 'title={agentsSectionTitle({ agentTeams, standaloneAgents })}', 'title={`Agents (${agentTeams.length + standaloneAgents.length})`}'],
  ['email-validated-on-create', 'users', "validateUserForm({ subject, displayName, email }, 'create')", "validateUserForm({ subject, displayName }, 'create')"],
  ['email-validated-on-edit', 'users', "validateUserForm({ subject: user.subject, displayName, email }, 'edit')", "validateUserForm({ subject: user.subject, displayName }, 'edit')"],
  ['select-renders-current-value', 'ownership', '{selectOptions.map(t => (', '{teamOptions.map(t => ('],
  ['assigned-list-keeps-unknown-ids', 'ownership', '{assignableTeams.map(t => (', '{teams.map(t => ('],
  ['copy-not-credential', 'ownership', 'use this environment. System-scoped', 'use this credential. System-scoped'],
];

test('#2695: every wiring check is proven by a mutation that makes exactly it fire', () => {
  const fired = new Set();
  for (const [expected, file, find, replace] of MUTATIONS) {
    const src = file === 'users' ? USERS : OWNERSHIP;
    const hits = src.split(find).length - 1;
    assert.equal(hits, 1, `mutation anchor for ${expected} matches ${hits}x (must be exactly 1): ${find.slice(0, 60)}`);
    const mutated = src.replace(find, replace);
    const result = file === 'users' ? runCheck(mutated, OWNERSHIP) : runCheck(USERS, mutated);
    assert.equal(result, expected, `mutation for ${expected} fired ${result}`);
    fired.add(expected);
  }
  assert.deepEqual(Object.keys(CHECKS).filter(k => !fired.has(k)), []);
});
