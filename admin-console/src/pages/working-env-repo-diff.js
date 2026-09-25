// working-env-repo-diff.js — pure repository-diff classification for the
// Working Environment form (issue #2066).
//
// Repositories declared on a Working Environment are cloned into an agent's
// workspace when the agent is CREATED. #1342 closed the resulting gap with an
// explicit "Sync all agents" button, which #2066 replaces with an offer made at
// SAVE time: the moment the save succeeds is the only moment at which the
// submitted list is authoritative and the diff against the previously persisted
// one is known.
//
// This module answers the two questions that offer needs, and nothing else:
//   1. did the repositories change at all, and how? → classifyRepositoryChanges
//   2. what do we say about it?                     → repositoryChangeNotice
//                                                     (the lead) and
//                                                     repositoryChangeLines
//                                                     (one line per class)
//
// Same null-when-clean shape as mcpChangeNotice (working-env-mcp-view.js) and
// toolchainChangeWarning (toolchain-select-view.js), and for the same reason: a
// notice that is always on screen stops being read.
//
// It deliberately does NOT decide what to do to a workspace. The propagation
// itself reconciles the DECLARED list against the ACTUAL clones on disk
// (orchestrator/repo-sync.js), because that is what stays correct after a
// decline, a partial run or a failure — a remembered save-time diff would not.

// Derive the on-disk directory name a repo URL clones into.
//
// MIRROR of repoDirName() in orchestrator/repo-sync.js — the browser bundle
// cannot require from orchestrator/, so the body is duplicated and pinned by a
// two-sided guard in working-env-repo-diff.test.js, which reads that file.
//
// This is also the IDENTITY the diff keys on, and deliberately not the URL: the
// directory name is the only thing the platform keys on when it decides whether
// a repository is already present, so it is the honest discriminator for "same
// repository, edited" vs "a different repository" (D1b).
export function repoDirName(url) {
  return (String(url || '').split('/').pop() || 'repo').replace(/\.git$/, '');
}

// The fields whose change must reach an existing agent's workspace. `readOnly`
// is deliberately absent: it is enforced through the agent's prompt and a write
// block (#1813), never through the clone, so flipping it changes nothing on
// disk and must not classify an entry as changed or raise an offer.
const WORKSPACE_FIELDS = ['url', 'branch', 'sshKeyId'];

function normalizeEntry(repo) {
  if (!repo || !repo.url) return null;
  const url = String(repo.url);
  return {
    name: repoDirName(url),
    url,
    branch: repo.branch ? String(repo.branch) : '',
    sshKeyId: repo.sshKeyId ? String(repo.sshKeyId) : '',
  };
}

// Index a repository list by derived directory name, in declaration order.
//
// Two repositories whose URLs end in the same segment collide on that name and
// only the FIRST is ever cloned (repoDirName, orchestrator/repo-sync.js) — so
// the loser is reported separately rather than silently folded into the winner,
// which would present it as successfully propagated.
function indexByDirName(repositories) {
  const list = Array.isArray(repositories) ? repositories : [];
  const byName = new Map();
  const collisions = [];
  for (const raw of list) {
    const entry = normalizeEntry(raw);
    if (!entry) continue;
    if (byName.has(entry.name)) {
      collisions.push({ ...entry, occupiedBy: byName.get(entry.name).url });
      continue;
    }
    byName.set(entry.name, entry);
  }
  return { byName, collisions };
}

// Which of the workspace-relevant fields differ between two entries sharing a
// directory name. Returns [] when the entry is unchanged.
export function changedRepoFields(before, after) {
  if (!before || !after) return [];
  return WORKSPACE_FIELDS.filter((field) => (before[field] || '') !== (after[field] || ''));
}

/**
 * Classify the repository diff between what is persisted on the environment and
 * what the form submitted.
 *
 * Keyed on the derived directory name (see repoDirName), which makes the D1b
 * rule fall out of the classification itself rather than needing a special
 * case: a changed URL that still derives the same directory name is one
 * `changed` entry (adjust the remote in place); a changed URL that would derive
 * a DIFFERENT directory name is an `added` entry plus a `removed` one — a fresh
 * clone in its own directory, the old one left alone.
 *
 * A repository added and then removed again before saving never appears: the
 * comparison is between two final lists, not a history of edits.
 *
 * @returns {{
 *   added: Array<object>, changed: Array<object>, removed: Array<object>,
 *   unchanged: Array<object>, collisions: Array<object>, changeCount: number,
 * }}
 */
export function classifyRepositoryChanges(persisted, submitted) {
  const before = indexByDirName(persisted);
  const after = indexByDirName(submitted);

  const added = [];
  const changed = [];
  const removed = [];
  const unchanged = [];

  for (const [name, entry] of after.byName) {
    const prior = before.byName.get(name);
    if (!prior) {
      added.push(entry);
      continue;
    }
    const fields = changedRepoFields(prior, entry);
    if (fields.length === 0) {
      unchanged.push(entry);
      continue;
    }
    changed.push({ ...entry, fields, previous: prior });
  }

  for (const [name, entry] of before.byName) {
    if (!after.byName.has(name)) removed.push(entry);
  }

  // A collision in the SUBMITTED list is a change the user needs to see even
  // when nothing else moved: the second entry will never arrive in any
  // workspace, whatever the propagation does.
  const collisions = after.collisions;

  return {
    added,
    changed,
    removed,
    unchanged,
    collisions,
    changeCount: added.length + changed.length + removed.length,
  };
}

// Is there anything to offer? Removals alone still count — they produce the
// no-pruning warning (AC17), which is the one thing about a removal that has
// never been disclosed anywhere.
export function hasRepositoryChanges(diff) {
  if (!diff) return false;
  return diff.changeCount > 0 || (diff.collisions || []).length > 0;
}

// Only ADDED and CHANGED repositories are propagated; a removal is never acted
// on. So this is what decides whether the accept action has any work to do.
export function propagatableCount(diff) {
  if (!diff) return 0;
  return (diff.added || []).length + (diff.changed || []).length;
}

function nameList(entries) {
  return (entries || []).map((e) => e.name).join(', ');
}

function plural(n, one, many) {
  return n === 1 ? one : many;
}

/**
 * Human wording for one class of the diff, used as the modal's per-class lines.
 * Returned as data rather than markup so the same lines can be asserted in a
 * unit test and rendered by whichever surface asks (AC21's spirit: the surfaces
 * must not disagree about what a given change would do).
 *
 * @returns {Array<{kind: string, tone: 'info'|'warning', text: string}>}
 */
export function repositoryChangeLines(diff) {
  if (!hasRepositoryChanges(diff)) return [];
  const lines = [];

  const added = diff.added || [];
  if (added.length > 0) {
    lines.push({
      kind: 'added',
      tone: 'info',
      text: `${added.length} ${plural(added.length, 'repository', 'repositories')} added `
        + `(${nameList(added)}) — cloned into each agent's workspace; see the per-agent report below.`,
    });
  }

  const changed = diff.changed || [];
  if (changed.length > 0) {
    lines.push({
      kind: 'changed',
      tone: 'info',
      text: `${changed.length} ${plural(changed.length, 'repository', 'repositories')} changed `
        + `(${nameList(changed)}) — adjusted in place, but only where the existing clone is `
        + `clean and fully pushed. Anywhere it is not, that clone is left untouched and reported.`,
    });
  }

  const removed = diff.removed || [];
  if (removed.length > 0) {
    lines.push({
      kind: 'removed',
      tone: 'warning',
      text: `${removed.length} ${plural(removed.length, 'repository', 'repositories')} removed `
        + `(${nameList(removed)}) — nothing is deleted from any agent; existing copies are kept. `
        + `Removing them is a manual step, so no unpushed work can be lost.`,
    });
  }

  const collisions = diff.collisions || [];
  if (collisions.length > 0) {
    lines.push({
      kind: 'collision',
      tone: 'warning',
      text: `${collisions.length} ${plural(collisions.length, 'repository', 'repositories')} `
        + `${plural(collisions.length, 'shares its', 'share their')} folder name with another `
        + `entry (${nameList(collisions)}) and will not arrive — only the first repository with a `
        + `given folder name is cloned. Rename or drop the duplicate.`,
    });
  }

  return lines;
}

/**
 * The one-line lead for the save-time offer, or null when there is nothing to
 * offer — no repository change, or no existing agent to propagate to (AC4: an
 * environment with zero agents never produces an offer or a warning, whatever
 * the diff, because there is no workspace that could be out of date).
 *
 * @returns {string|null}
 */
export function repositoryChangeNotice({ diff = null, agentCount = 0 } = {}) {
  const n = Number(agentCount) || 0;
  if (n <= 0) return null;
  if (!hasRepositoryChanges(diff)) return null;
  const toDo = propagatableCount(diff);
  if (toDo === 0) {
    return `The repository list changed. Nothing needs to be brought up to date — nothing is `
      + `ever deleted from an agent's workspace — but the ${n} existing `
      + `${plural(n, 'agent', 'agents')} still ${plural(n, 'has', 'have')} what was removed.`;
  }
  return `The repository list changed. Bring the ${n} existing ${plural(n, 'agent', 'agents')} `
    + `using this environment up to date?`;
}

// ── D4: the persistent "N agents not up to date" indicator ─────────────────
//
// Derived from the ACTUAL workspace state (GET /api/environments/:id/repo-
// divergence), never from a remembered save-time diff — which is what makes it
// self-healing after a decline, a partial run or a failure, and what makes it
// clear on its own once nothing diverges.

const DIVERGENCE_WORDING = {
  missing: 'not cloned',
  branch: 'on a different branch',
  url: 'pointing at a different address',
  'url-and-branch': 'on a different branch and address',
};

/**
 * The indicator for one environment, or null when there is nothing to show —
 * which is every case the reader should not be nagged about: nothing diverges,
 * the probe failed, or the environment has no agents at all (AC4).
 *
 * A clone that is merely no longer declared never reaches here: the server
 * excludes it, because nothing is ever pruned and it could therefore never be
 * brought up to date (AC20).
 *
 * @param payload GET /api/environments/:id/repo-divergence response
 * @returns {{count: number, label: string, title: string, canManage: boolean}|null}
 */
export function outOfDateIndicator(payload) {
  if (!payload) return null;
  const agents = Array.isArray(payload.agents) ? payload.agents : [];
  const behind = agents.filter((a) => (a.diverged || []).length > 0);
  if (behind.length === 0) return null;

  const detail = behind.map((agent) => {
    const items = (agent.diverged || [])
      .map((d) => `${d.name} (${DIVERGENCE_WORDING[d.kind] || d.kind})`)
      .join(', ');
    return `${agent.displayName || agent.agentId}: ${items}`;
  });

  return {
    count: behind.length,
    label: `${behind.length} ${behind.length === 1 ? 'agent' : 'agents'} not up to date`,
    title: detail.join('\n'),
    canManage: payload.canManage !== false,
  };
}
