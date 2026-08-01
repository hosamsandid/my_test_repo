// GitHub API base seam for the admin-console API (#710, §6.1).
//
// The wizard's repo-probe / coordinator-workflow endpoints build GitHub REST
// URLs against a hardcoded `https://api.github.com`. This mirrors the
// orchestrator seam (orchestrator/github-api-base.js): read `GITHUB_API_BASE`
// (default `https://api.github.com`) so the E2E stack can retarget these calls
// at the in-stack `fake-github` service. These call sites use the global
// `fetch`, which handles http and https transparently, so unlike the poller
// only the origin string is needed here.
//
// Absent env ⇒ byte-identical production behaviour. Pure + fs-free for
// `node --test`.
const DEFAULT_GITHUB_API_BASE = 'https://api.github.com';

// Configured API base origin, trailing slash stripped. Read at call time so
// tests can flip the env per-case.
function githubApiBase(env = process.env) {
  const raw = (env && env.GITHUB_API_BASE) || DEFAULT_GITHUB_API_BASE;
  return String(raw).replace(/\/+$/, '');
}

module.exports = { githubApiBase, DEFAULT_GITHUB_API_BASE };
