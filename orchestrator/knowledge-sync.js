'use strict';

// Pure helpers for the team Knowledge Base working-copy sync + push (Shared
// Agent Learning, Phase 1). The IO — clone, fetch, rebase, push — lives in
// orchestrator.js; only the decision logic that is worth pinning down lives
// here, so it can be unit-tested without git or a network (repo convention:
// test pure cores only). See docs/knowledge-cli.md §3.

// The DEFAULT branch every team agent appends its KB shard to when a team has
// not configured its own. It is deliberately NOT a protected branch
// (main/master/develop/trunk), so pushing KB updates on the default never fights
// agent-git-ops PROTECTED_BRANCHES. Per #558 the branch is now configurable per
// team via env.knowledgeStore.repoRef.branch — see resolveKnowledgeBranch.
const KNOWLEDGE_BRANCH = 'agent-knowledge';

// Well-known protected branches. Used only to raise a NON-BLOCKING warning in
// the UI when an operator points the KB at one of these (#558 AC-3): agents push
// knowledge directly and frequently, so a protected branch may reject those
// pushes — but the operator is free to make that informed choice.
const PROTECTED_BRANCHES = ['main', 'master', 'develop', 'trunk'];

// A push to the shared branch can lose the fast-forward race when another agent
// pushed between our fetch and our push. That is recoverable: fetch + rebase our
// (own-shard-only) commits on top and push again. Any other failure (auth,
// no such repo, rejected hook) is not worth retrying.
const MAX_PUSH_RETRIES = 3;

// Does git's stderr indicate a lost fast-forward race (retryable)?
function isRetryablePushError(text) {
  const s = String(text || '').toLowerCase();
  return (
    s.includes('non-fast-forward') ||
    s.includes('fetch first') ||
    s.includes('rejected') && s.includes('behind') ||
    s.includes('tip of your current branch is behind')
  );
}

// The branch a team's KB lives on: the configured one
// (env.knowledgeStore.repoRef.branch) or the default. Pure — reads only the
// normalized-or-raw env shape, so both the orchestrator (git ops, CLI env
// injection) and the tests can resolve the same branch every code path uses.
function resolveKnowledgeBranch(env) {
  const ref = env && env.knowledgeStore && env.knowledgeStore.repoRef;
  const b = ref && typeof ref.branch === 'string' ? ref.branch.trim() : '';
  return b || KNOWLEDGE_BRANCH;
}

// Is `branch` a well-known protected branch? (case-insensitive). Advisory only —
// never blocks; the UI uses it to warn.
function isProtectedBranch(branch) {
  return PROTECTED_BRANCHES.includes(String(branch || '').trim().toLowerCase());
}

// Guard for the push endpoint: only ever push the team's configured KB branch.
// `allowed` defaults to the hard-coded branch so unconfigured teams behave
// exactly as before; callers on a configured team pass the resolved branch so
// the guard follows the configuration instead of hard-rejecting it (#558 AC-3).
function knowledgeBranchAllowed(branch, allowed = KNOWLEDGE_BRANCH) {
  return typeof branch === 'string' && branch !== '' && branch === allowed;
}

module.exports = {
  KNOWLEDGE_BRANCH,
  PROTECTED_BRANCHES,
  MAX_PUSH_RETRIES,
  isRetryablePushError,
  knowledgeBranchAllowed,
  resolveKnowledgeBranch,
  isProtectedBranch,
};
