'use strict';

// Pure helpers for the repository side of team materialization (#1623).
//
// A Working Environment may legitimately carry ZERO repositories. When it
// does, a team materialized onto it is created "repo-less": nothing is cloned
// and the `{{repoFullName}}`/`{{repoUrl}}` substitution vars resolve to empty
// strings so the member prompts/triggers still substitute cleanly. A
// repo-backed environment (one or more repositories) is unaffected — the first
// repository is the primary, exactly as before.
//
// These are the pure, test-covered pieces of that decision; the surrounding
// credential/rollback wiring lives in the POST /api/teams route handlers.

// Normalize a Working Environment's repository list. Modern records carry a
// `repositories: [...]` array; a legacy single `repository` object is lifted
// into a one-element array (mirrors how the API migrates on read).
function reposFromEnv(env) {
  if (!env) return [];
  if (Array.isArray(env.repositories)) return env.repositories;
  return env.repository ? [env.repository] : [];
}

// The primary repository of an environment (or undefined when repo-less).
function primaryRepo(env) {
  return reposFromEnv(env)[0];
}

// True when the environment has no usable repository, i.e. materialization
// must proceed repo-less.
function isRepoLessEnv(env) {
  return !primaryRepo(env)?.url;
}

// Build the repository substitution vars for a materialized team. `parsed` is
// the result of deriveRepoIdentity(url) for a repo-backed team, or null for a
// repo-less one (all fields empty). `repoUrl` is the raw primary URL (or '').
function repoVars(parsed, repoUrl) {
  return {
    repoFullName: parsed ? `${parsed.org}/${parsed.repo}` : '',
    repoOwner: parsed ? parsed.org : '',
    repoName: parsed ? parsed.repo : '',
    repoUrl: repoUrl || '',
  };
}

module.exports = { reposFromEnv, primaryRepo, isRepoLessEnv, repoVars };
