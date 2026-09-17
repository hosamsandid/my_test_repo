'use strict';

// #2324 (epic #2325): classify the GitHub-integration health of one repository in
// a Working Environment, so the "why are no events arriving?" failure modes are
// visible in the UI instead of only in the orchestrator's poller log.
//
// It is a PURE classifier over three signals the route resolves:
//   - hasToken:      does the env carry a `githubTokenId`?
//   - hasSubscriber: does any enabled agent bound to the env have a github-event
//                    trigger for THIS repo? (polled OR `transport: 'internal'` —
//                    both gate on the repo, so both count.) `null`/undefined =
//                    "not evaluated", which never downgrades a healthy result.
//   - probeStatus:   the HTTP status of a cheap authenticated probe
//                    (GET /repos/{owner}/{repo}) run only when a token exists;
//                    `rateLimited` disambiguates GitHub's overloaded 403.
//
// The live probe + the subscriber scan live in the route; keeping the mapping
// here (mirroring llm-probe-fallback.js) is what makes it unit-testable.

const GH_HEALTH = {
  OK: 'ok',
  NO_TOKEN: 'no-token',
  NO_SUBSCRIBER: 'no-subscriber',
  BAD_CREDENTIALS: 'bad-credentials',
  FORBIDDEN: 'forbidden',
  RATE_LIMITED: 'rate-limited',
  NOT_FOUND: 'not-found',
  UNKNOWN: 'unknown',
};

// Severity ordering for a whole-environment roll-up (worst wins).
const GH_HEALTH_SEVERITY = {
  [GH_HEALTH.BAD_CREDENTIALS]: 5,
  [GH_HEALTH.FORBIDDEN]: 4,
  [GH_HEALTH.NOT_FOUND]: 4,
  [GH_HEALTH.NO_TOKEN]: 3,
  [GH_HEALTH.RATE_LIMITED]: 2,
  [GH_HEALTH.NO_SUBSCRIBER]: 1,
  [GH_HEALTH.UNKNOWN]: 1,
  [GH_HEALTH.OK]: 0,
};

function classifyGithubHealth({ hasToken, hasSubscriber, probeStatus, rateLimited } = {}) {
  if (!hasToken) {
    return {
      status: GH_HEALTH.NO_TOKEN,
      ok: false,
      label: 'No GitHub token',
      detail: 'This repository has no GitHub token, so the event poller, gh CLI, '
        + 'HTTPS pushes and PR/issue actions will not work.',
    };
  }

  switch (probeStatus) {
    case 200:
      // Token is valid. The only remaining problem is nobody listening.
      if (hasSubscriber === false) {
        return {
          status: GH_HEALTH.NO_SUBSCRIBER,
          ok: false,
          label: 'No trigger for this repo',
          detail: 'The token works, but no enabled agent has a github-event trigger '
            + 'bound to this repository, so nothing reacts to its events.',
        };
      }
      return { status: GH_HEALTH.OK, ok: true, label: 'OK', detail: 'Token valid; events are polled.' };
    case 401:
      return {
        status: GH_HEALTH.BAD_CREDENTIALS,
        ok: false,
        label: 'Bad credentials',
        detail: 'GitHub rejected the token (401). It is invalid, expired or revoked — '
          + 'the poller backs off and no events arrive.',
      };
    case 403:
      return rateLimited
        ? { status: GH_HEALTH.RATE_LIMITED, ok: false, label: 'Rate limited', detail: 'GitHub is rate-limiting this token (403); polling resumes when the window resets.' }
        : { status: GH_HEALTH.FORBIDDEN, ok: false, label: 'Forbidden', detail: 'The token is valid but lacks access to this repository (403). Check its scope / repo assignment.' };
    case 404:
      return {
        status: GH_HEALTH.NOT_FOUND,
        ok: false,
        label: 'Repo not found / no access',
        detail: 'GitHub returned 404 — the repository does not exist or the token cannot see it.',
      };
    default:
      return {
        status: GH_HEALTH.UNKNOWN,
        ok: false,
        label: 'Unknown',
        detail: typeof probeStatus === 'number'
          ? `The GitHub probe returned an unexpected status (${probeStatus}).`
          : 'The GitHub probe result is not yet known.',
      };
  }
}

// Roll a per-repo list up into one worst-case status for a compact env badge.
function rollUpGithubHealth(repos) {
  const list = Array.isArray(repos) ? repos : [];
  if (list.length === 0) return { status: GH_HEALTH.OK, ok: true, label: 'No repositories' };
  let worst = list[0];
  for (const r of list) {
    if ((GH_HEALTH_SEVERITY[r.status] ?? 0) > (GH_HEALTH_SEVERITY[worst.status] ?? 0)) worst = r;
  }
  return worst;
}

module.exports = { GH_HEALTH, GH_HEALTH_SEVERITY, classifyGithubHealth, rollUpGithubHealth };
