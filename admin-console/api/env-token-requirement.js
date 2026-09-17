'use strict';

// #2323 (epic #2325): a repo-backed Working Environment needs a GitHub token, or
// almost none of the GitHub automation works — the poller receives no events (it
// only polls repos in an env with a `githubTokenId`), and `gh`, HTTPS pushes and
// attributed writes (commit/PR/review/push) all fail. Saving a repository WITHOUT
// a token is therefore almost always a mistake, and one that is very hard to
// diagnose after the fact (the repo clones fine, the URL reachability check is
// green — it only tests SSH reachability, not the token — and nothing else says
// why the flow is dead).
//
// So it is blocked at save, UNLESS the caller explicitly acknowledges a
// reference-only / no-automation environment (`acknowledgeNoToken`). That keeps
// the legitimate LLM-only or SSH-clone-for-reference case possible, but makes it
// a deliberate opt-out rather than a silent accident. An env with zero
// repositories needs no token (LLM-only) and is always allowed.
//
// Pure: the caller passes the normalized repositories list, the resolved token id
// and the acknowledgement flag. Returns { ok: true } or { ok: false, status,
// code, error }.
function checkGithubTokenRequirement({ repositories, githubTokenId, acknowledgeNoToken } = {}) {
  const repos = Array.isArray(repositories) ? repositories.filter((r) => r && r.url) : [];
  if (repos.length === 0) return { ok: true };   // LLM-only environment — no repo, no token needed
  if (githubTokenId) return { ok: true };        // has a token — normal case
  if (acknowledgeNoToken === true) return { ok: true }; // explicit reference-only opt-out

  return {
    ok: false,
    status: 409,
    code: 'github_token_required',
    error:
      'This environment has a repository but no GitHub token. Without one the '
      + 'GitHub automation will not work: the event poller receives nothing, and '
      + 'the gh CLI, HTTPS pushes and PR/issue actions all fail. Add a GitHub token, '
      + 'or confirm a reference-only environment (resend with acknowledgeNoToken=true).',
  };
}

module.exports = { checkGithubTokenRequirement };
