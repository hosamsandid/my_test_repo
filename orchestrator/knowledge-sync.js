'use strict';

// Pure helpers for the team Knowledge Base working-copy sync + push (Shared
// Agent Learning, Phase 1). The IO — clone, fetch, rebase, push — lives in
// orchestrator.js; only the decision logic that is worth pinning down lives
// here, so it can be unit-tested without git or a network (repo convention:
// test pure cores only). See docs/knowledge-cli.md §3.

// The single shared branch every team agent appends its KB shard to. It is
// deliberately NOT a protected branch (main/master/develop/trunk), so pushing
// KB updates never fights agent-git-ops PROTECTED_BRANCHES — and the push
// endpoint refuses to touch anything else.
const KNOWLEDGE_BRANCH = 'agent-knowledge';

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

// Guard for the push endpoint: only ever push the one shared KB branch.
function knowledgeBranchAllowed(branch) {
  return branch === KNOWLEDGE_BRANCH;
}

module.exports = {
  KNOWLEDGE_BRANCH,
  MAX_PUSH_RETRIES,
  isRetryablePushError,
  knowledgeBranchAllowed,
};
