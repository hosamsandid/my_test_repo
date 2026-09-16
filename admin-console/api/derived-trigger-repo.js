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
// A `transport: 'internal'` listener (#1174) is deliberately NOT stamped: it is
// delivered by POST /internal/flow-emit, never by the GitHub poller (which
// excludes internal triggers from its plan), so a `repo` on it is inert — and
// stamping one would churn triggers.json for no behavioural effect. Leaving it
// repo-less is also what keeps the repo-set fan-out (#2322) a true no-op for
// internal channels: when an env gains its first repo, only the poller-delivered
// github-event triggers get a repo, exactly the ones that were silently dead.

function injectDerivedTriggerRepo(triggers, repoFullName) {
  if (!Array.isArray(triggers) || !repoFullName) return triggers;
  return triggers.map(t =>
    (t && t.type === 'github-event' && t.transport !== 'internal' && !t.repo)
      ? { ...t, repo: repoFullName }
      : t,
  );
}

module.exports = { injectDerivedTriggerRepo };
