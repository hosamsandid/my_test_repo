// The pure `expand*` builders in process-template.js (expandGithubChannels /
// expandDataFlowSteps) emit derived `github-event` triggers WITHOUT a `repo`
// field — they only know the process topology, not which repository a live team
// is bound to. At materialise time (`POST /api/teams`) the repo is injected from
// the environment (`out.repo = vars.repoFullName`). The live reconcile path
// (`reconcileTeamGithubChannels` / `reconcileTeamDataFlow`) regenerates the same
// derived triggers on every ports write and MUST do the same injection — the
// GitHub poller's `_buildPollPlan` skips any github-event trigger with no
// `repo` (`if (!t.repo) continue`), so a derived trigger written back without it
// is silently invisible to the poller and its subscriber never fires. This was
// the regression behind #581's id re-key: the rename triggered a reconcile that
// rewrote the developer's channel trigger without a repo, and it stopped
// reacting to `issues.labeled`.
//
// Pure + idempotent: only github-event triggers that lack a `repo` are stamped,
// so a trigger that already carries one (manually authored, or already fixed) is
// left byte-identical and never causes a spurious triggers.json rewrite.
//
function injectDerivedTriggerRepo(triggers, repoFullName) {
  if (!Array.isArray(triggers) || !repoFullName) return triggers;
  return triggers.map(t =>
    (t && t.type === 'github-event' && !t.repo)
      ? { ...t, repo: repoFullName }
      : t,
  );
}

module.exports = { injectDerivedTriggerRepo };
