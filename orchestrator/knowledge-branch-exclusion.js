'use strict';

// Knowledge-base branch exclusion for push triggers (#2602) — a push to a branch
// that any team has declared as its knowledge-base branch on that repository
// never wakes a push subscriber. Built in, always on, not configurable: no
// trigger or team setting opts out (explicit product decision).
//
// Every KB sync is a normal git push to the KB branch (`agent-knowledge` by
// default, `knowledgeStore.repoRef.branch` when configured — #558), so without
// this rule every unfiltered push trigger on the repo wakes on every sync and
// answers `[PASS]`. The poller drops such a push per subscriber as
// `knowledge-branch`, before every other gate (and therefore before the wake
// dedup / burst / throttle layers).
//
// Pure and fs-free. The orchestrator resolves each team's effective knowledge
// env (team overrides overlaid, #570) and hands the poller one
// `knowledgeLocationOf(env)` per team; the poller groups them per repository
// with `knowledgeBranchesByRepo`, so the set always covers EVERY team on the
// platform whose KB lives in that repo (#603: teams sharing a repo share it).

const { knowledgeAutonomyLevel } = require('./knowledge-store');
const { resolveKnowledgeBranch } = require('./knowledge-sync');
const { pushBranch } = require('./branch-filter');

// Where a team's KB is pushed: `{ url, branch }`, or null when the team has no
// git-backed KB it syncs — autonomy 0 (KB off) or no resolvable KB repo. `url`
// is the in-repo team repository or the separate own-repo KB repository.
// `env` is the team's effective knowledge env (normalized knowledgeStore).
function knowledgeLocationOf(env) {
  if (!env || knowledgeAutonomyLevel(env) < 1) return null;
  const ref = env.knowledgeStore && env.knowledgeStore.repoRef;
  const url = ref && typeof ref.url === 'string' ? ref.url.trim() : '';
  if (!url) return null;
  return { url, branch: resolveKnowledgeBranch(env) };
}

// `[{ url, branch }]` → Map<repoFullName, string[]> (sorted, de-duplicated).
// `parseRepo(url)` is the poller's own `owner/name` parser, so a KB repo keys
// exactly like the poll plan; an unparseable url contributes nothing.
function knowledgeBranchesByRepo(locations, parseRepo) {
  const sets = new Map();
  for (const loc of Array.isArray(locations) ? locations : []) {
    if (!loc || typeof loc.branch !== 'string' || !loc.branch) continue;
    const repo = parseRepo(loc.url);
    if (!repo) continue;
    if (!sets.has(repo)) sets.set(repo, new Set());
    sets.get(repo).add(loc.branch);
  }
  const out = new Map();
  for (const [repo, set] of sets) out.set(repo, [...set].sort());
  return out;
}

// Is this push event a push to one of the repo's KB branches? Branch pushes
// only (`refs/heads/<branch>`) — a tag named like the KB branch is not one.
function isKnowledgeBranchPush(ghEvent, branches) {
  if (!Array.isArray(branches) || branches.length === 0) return false;
  const branch = pushBranch(ghEvent);
  return branch !== null && branches.includes(branch);
}

module.exports = {
  knowledgeLocationOf,
  knowledgeBranchesByRepo,
  isKnowledgeBranchPush,
};
