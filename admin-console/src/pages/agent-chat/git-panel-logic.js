// git-panel-logic.js — pure, React-free helpers for the Workspace Git panel
// (issue #648). Keeping the enable/disable + messaging rules here lets them be
// unit-tested without a DOM (the admin-console frontend has no installed
// node_modules, so tests import this sibling .js directly).

// Decide which of the three deterministic actions (switch / update / discard)
// are available for the currently selected repo, and — when one is blocked —
// the human-readable reason to show in the panel.
//
// `repoEntry` is one entry of GET /api/agents/:id/workspace/git-status, now
// carrying the branch metadata added in #648 (currentBranch, branches[],
// detached, hasRemote, hasUpstream, dirty). `running` is true when the agent
// has a live session (AC7) — it hard-disables every action first.
export function deriveGitControls({ repoEntry, running } = {}) {
  const repo = repoEntry || null;
  const isRepo = !!repo && !repo.error;
  const dirty = !!(repo && repo.dirty);
  const detached = !!(repo && repo.detached);
  const hasRemote = !!(repo && repo.hasRemote);
  const hasUpstream = !!(repo && repo.hasUpstream);
  const branches = repo && Array.isArray(repo.branches) ? repo.branches : [];
  const currentBranch = repo ? (repo.currentBranch ?? repo.branch ?? null) : null;
  const otherBranches = branches.filter((b) => b !== currentBranch);

  // AC7: a running session pauses everything. This reason wins over all others
  // so the panel explains the single most important blocker.
  const runningReason = running
    ? 'The agent has a running session — git actions are paused until it finishes.'
    : null;

  // Switch (AC2/AC5): a real repo, a clean tree, on a branch, with somewhere
  // else to go.
  let switchReason = runningReason;
  if (!switchReason) {
    if (!isRepo) switchReason = 'Not a git repository.';
    else if (detached) switchReason = 'Detached HEAD — no current branch to switch from.';
    else if (dirty) switchReason = 'Uncommitted changes — discard them or ask the agent to commit first.';
    else if (otherBranches.length === 0) switchReason = 'No other local branch to switch to.';
  }

  // Update (AC3/AC4): clean tree, on a branch, with a remote + upstream.
  let updateReason = runningReason;
  if (!updateReason) {
    if (!isRepo) updateReason = 'Not a git repository.';
    else if (detached) updateReason = 'Detached HEAD — check out a branch to update.';
    else if (!hasRemote) updateReason = 'No remote configured — nothing to update.';
    else if (!hasUpstream) updateReason = 'Current branch has no upstream — nothing to update.';
    else if (dirty) updateReason = 'Uncommitted changes — resolve them before updating.';
  }

  // Discard (AC6): only when there is actually uncommitted work to remove.
  let discardReason = runningReason;
  if (!discardReason) {
    if (!isRepo) discardReason = 'Not a git repository.';
    else if (!dirty) discardReason = 'No uncommitted changes to discard.';
  }

  return {
    isRepo,
    dirty,
    detached,
    hasRemote,
    hasUpstream,
    running: !!running,
    currentBranch,
    branches,
    otherBranches,
    canSwitch: !switchReason,
    canUpdate: !updateReason,
    canDiscard: !discardReason,
    switchReason,
    updateReason,
    discardReason,
  };
}

// The confirm-dialog copy for a destructive discard (AC6): must name the repo
// and state that the change is unrecoverable.
export function discardConfirmMessage(repoPath) {
  const name = !repoPath || repoPath === '.' ? 'the workspace root repository' : repoPath;
  return (
    `This permanently discards ALL uncommitted changes in ${name} — ` +
    'both tracked edits and untracked files. This cannot be undone.'
  );
}

// True when a status entry represents a session count that should block actions.
// Mirrors GET /api/agents/:id/sessions/active semantics: a non-empty array of
// running sessions means the agent is busy.
export function isAgentRunning(sessions) {
  return Array.isArray(sessions) && sessions.length > 0;
}
