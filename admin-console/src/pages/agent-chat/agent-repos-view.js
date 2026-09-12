// agent-repos-view.js — pure view decisions for agent-scoped repositories
// (#2067), shared by BOTH surfaces the feature is offered on: the Agent Chat
// Workspace view (D1) and the agent's Settings tab (D7).
//
// AC20 says both surfaces read and write the same data and enforce the same
// authorization, and that neither can reach a state the other cannot. The way
// that stays true is that both render one panel over this one module — so a row
// badge, a disabled reason or a confirmation sentence exists exactly once.
// Kept JSX-free per the #651 convention so it can be node:test covered.
//
// The server is the authority for every refusal (orchestrator/agent-repositories.js
// re-checks all of it): what lives here is what the reader is shown BEFORE they
// press anything.

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export const SCOPE_LABELS = {
  environment: 'From Environment',
  agent: 'This agent only',
};

// One display row per resolved repository. `scope` comes from the server, never
// inferred from the URL: AC7 (an agent-scoped repository is visually
// distinguishable) and AC8 (an inherited one cannot be edited or removed here)
// are both properties of where the entry is stored, which the client cannot see.
export function repositoryRows(view) {
  const list = view && Array.isArray(view.repositories) ? view.repositories : [];
  return list.map((r) => ({
    url: r.url,
    dirName: r.dirName,
    branch: r.branch || null,
    readOnly: r.readOnly === true,
    scope: r.scope,
    scopeLabel: SCOPE_LABELS[r.scope] || r.scope,
    removable: r.removable === true,
    shadowed: r.shadowed === true,
    facts: r.facts || null,
    // The clone path, in the form the agent's own prompt uses, so a human
    // reading both sees the same string.
    clonePath: `./${r.dirName}/`,
  }));
}

export function agentScopedRows(view) {
  return repositoryRows(view).filter((r) => r.scope === 'agent');
}

// The one-line note under an inherited row. AC8 is a refusal the reader meets
// before trying, not an error afterwards.
export const INHERITED_ROW_NOTE =
  'Shared by every agent in this environment — change it there, not here.';

// A shadowed row is the environment-caught-up edge case: the directory is now
// the environment's, so this attachment no longer owns the files. Removing it
// is still allowed (and drops only the attachment), which is exactly what has
// to be said, because "Remove" otherwise reads as "delete that directory".
export function shadowNote(row) {
  if (!row || !row.shadowed) return null;
  return `The environment now also declares ${row.clonePath}, so it owns those files. `
    + 'Removing this attachment leaves the working copy in place.';
}

// ---------------------------------------------------------------------------
// Availability (AC12 / AC16 / AC17)
// ---------------------------------------------------------------------------

// Mirrors `attachAvailability` in orchestrator/agent-repositories.js — same
// four states, same order, so the button the client disables is the one the
// server would refuse. Duplicated rather than imported because the orchestrator
// module is CommonJS in another container; the parity is asserted by the
// wiring test, which reads both sources.
export function availability(view) {
  const v = view && typeof view === 'object' ? view : {};
  if (v.role === 'team') {
    return {
      canAttach: false,
      canRemove: false,
      reason: 'A team record has no container and no workspace of its own — attach the repository '
        + 'to one of its members instead.',
    };
  }
  if (v.materialized === false) {
    return {
      canAttach: false,
      canRemove: false,
      reason: 'This agent has not been materialized yet, so it has no workspace to clone into. '
        + 'Materialize it first.',
    };
  }
  if (v.canManage === false) {
    return { canAttach: false, canRemove: false, reason: 'You do not have permission to manage this agent.' };
  }
  if (v.busy === true) {
    return {
      canAttach: true,
      canRemove: false,
      reason: 'This agent is running a session. Attaching is safe — it only adds a new directory — '
        + 'but removing a repository deletes files it may be using, so wait until the run ends.',
    };
  }
  return { canAttach: true, canRemove: true, reason: null };
}

// ---------------------------------------------------------------------------
// Add dialog
// ---------------------------------------------------------------------------

// AC3: the probe is advisory on the environment form and stays advisory here —
// an unreachable URL is a warning, not a gate. What DOES gate the submit is an
// empty URL and an in-flight request, nothing else.
export function submitState(row, { saving = false } = {}) {
  const url = String((row && row.url) || '').trim();
  if (saving) return { enabled: false, reason: 'Cloning…' };
  if (!url) return { enabled: false, reason: 'Enter the repository URL.' };
  return { enabled: true, reason: null };
}

export const ADD_DIALOG_TITLE = 'Add a repository to this agent';

// Said before the confirm, because it is the one thing about this form a
// reader familiar with the environment form would get wrong: the repository
// lands on THIS agent and on no other (D3/AC10).
export function addDialogLead(view) {
  const name = (view && view.agentName) || 'this agent';
  const envPart = view && view.environmentId
    ? ` Its environment (${view.environmentId}) is not changed, and no other agent in it is affected.`
    : ' Its environment is not changed, and no other agent in it is affected.';
  return `The repository is cloned into ${name}'s own workspace.${envPart}`;
}

// ---------------------------------------------------------------------------
// Remove confirmation (AC9)
// ---------------------------------------------------------------------------

// AC9: the confirmation says the working copy is deleted, and names uncommitted
// changes and unpushed commits CONCRETELY when there are any — a generic "you
// may lose work" is what trains people to click through. When the copy is clean
// it says that too, so silence never has to be interpreted.
//
// `facts` is the server's `removalFacts` output, carried on the row so the
// dialog needs no second round-trip (the state has to be read before the dialog
// is shown, which is why it rides along with the list).
export function removeConfirmation(row) {
  if (!row) return { title: '', lines: [], destructive: false };
  const facts = row.facts || { state: 'absent', lines: [] };
  const lines = [];

  if (row.shadowed) {
    // Nothing is deleted in this branch — see shadowNote.
    lines.push(shadowNote(row));
  } else if (facts.state === 'absent') {
    lines.push(`There is no working copy at ${row.clonePath} — only the attachment is removed.`);
  } else {
    lines.push(`The working copy at ${row.clonePath} is deleted from this agent's workspace.`);
    for (const line of facts.lines || []) lines.push(line);
  }

  lines.push('The environment is not changed, and no other agent is affected.');

  return {
    title: `Remove ${row.url}?`,
    lines,
    // Only a real deletion of losable work gets the danger treatment; dressing
    // up a clean removal in red is how a red button stops meaning anything.
    destructive: !row.shadowed && facts.state !== 'absent' && facts.clean !== true,
    confirmLabel: row.shadowed ? 'Remove attachment' : 'Delete and remove',
  };
}

// ---------------------------------------------------------------------------
// Result notices
// ---------------------------------------------------------------------------

export function attachedNotice(result) {
  const dirName = (result && result.dirName) || 'the repository';
  return `Cloned to ./${dirName}/. The agent is told about it from its next run on.`;
}

export function detachedNotice(result) {
  if (result && result.keptReason) return result.keptReason;
  if (result && result.deleted === false) {
    return 'The attachment was removed; there was no working copy to delete.';
  }
  const dirName = (result && result.dirName) || 'the repository';
  return `Removed, and ./${dirName}/ was deleted from the workspace.`;
}

// Empty state. Deliberately not a second call-to-action next to the button that
// is already on screen (the `emptyStatePointer` call #1956 made for the rail).
export function emptyStateText(view) {
  const rows = repositoryRows(view);
  if (rows.length === 0) {
    return 'This agent has no repositories. Its environment declares none, and nothing '
      + 'is attached to the agent itself.';
  }
  return 'Nothing is attached to this agent on its own — every repository above comes from its '
    + 'environment.';
}
