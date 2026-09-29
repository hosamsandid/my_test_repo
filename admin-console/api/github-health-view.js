'use strict';

// #2324 (epic #2325): classify the GitHub-integration health of one repository in
// a Working Environment, so the "why are no events arriving?" failure modes are
// visible in the UI instead of only in the orchestrator's poller log.
//
// It is a PURE classifier over the signals the route resolves:
//   - hasToken:      does the env carry a `githubTokenId`?
//   - probeStatus:   the HTTP status of a cheap authenticated probe
//                    (GET /repos/{owner}/{repo}) run only when a token exists;
//                    `rateLimited` disambiguates GitHub's overloaded 403.
//   - pollerStatus:  #2537 — the poller's OWN row for this repository
//                    (orchestrator/github-repo-status.js), so "events are
//                    polled" is claimed only when the poller really is
//                    listening, and a poller in backoff shows as failing even
//                    when the live probe succeeds. `null`/undefined = the
//                    poller status is unavailable (never guessed).
//   - envId:         the environment asking — to say so when the poller polls
//                    this repo with ANOTHER environment's token.
//
// This replaces the console-side subscriber scan (`envHasRepoSubscriber`),
// which counted triggers the poller ignores and diverged from it (#2537).
// The live probe lives in the route; keeping the mapping here (mirroring
// llm-probe-fallback.js) is what makes it unit-testable.

const GH_HEALTH = {
  OK: 'ok',
  NO_TOKEN: 'no-token',
  NO_SUBSCRIBER: 'no-subscriber',
  BAD_CREDENTIALS: 'bad-credentials',
  FORBIDDEN: 'forbidden',
  RATE_LIMITED: 'rate-limited',
  NOT_FOUND: 'not-found',
  POLL_FAILING: 'poll-failing',
  NOT_POLLED: 'not-polled',
  UNKNOWN: 'unknown',
};

// Severity ordering for a whole-environment roll-up (worst wins).
const GH_HEALTH_SEVERITY = {
  [GH_HEALTH.BAD_CREDENTIALS]: 5,
  [GH_HEALTH.FORBIDDEN]: 4,
  [GH_HEALTH.NOT_FOUND]: 4,
  [GH_HEALTH.POLL_FAILING]: 4,
  [GH_HEALTH.NO_TOKEN]: 3,
  [GH_HEALTH.RATE_LIMITED]: 2,
  [GH_HEALTH.NOT_POLLED]: 2,
  [GH_HEALTH.NO_SUBSCRIBER]: 1,
  [GH_HEALTH.UNKNOWN]: 1,
  [GH_HEALTH.OK]: 0,
};

// A live probe result that on its own proves the token is unusable for this
// repo. 200 or "not run / unreachable" (undefined) prove nothing — then the
// poller's status decides.
function classifyProbe(probeStatus, rateLimited) {
  switch (probeStatus) {
    case 200:
    case undefined:
    case null:
      return null;
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
        detail: `The GitHub probe returned an unexpected status (${probeStatus}).`,
      };
  }
}

function pollErrorText(err) {
  if (!err) return 'the last poll failed';
  if (err.rateLimited) return 'GitHub is rate-limiting the token';
  return err.status ? `HTTP ${err.status}${err.message ? ` — ${err.message}` : ''}` : (err.message || 'network error');
}

function classifyGithubHealth({ hasToken, probeStatus, rateLimited, pollerStatus, envId } = {}) {
  if (!hasToken) {
    return {
      status: GH_HEALTH.NO_TOKEN,
      ok: false,
      label: 'No GitHub token',
      detail: 'This repository has no GitHub token, so the event poller, gh CLI, '
        + 'HTTPS pushes and PR/issue actions will not work.',
    };
  }

  const probeProblem = classifyProbe(probeStatus, rateLimited);
  if (probeProblem) return probeProblem;

  if (!pollerStatus) {
    return {
      status: GH_HEALTH.UNKNOWN,
      ok: false,
      label: 'Unknown',
      detail: probeStatus === 200
        ? 'The token is valid, but the GitHub poller\'s status is not available right now.'
        : 'The GitHub probe result is not yet known.',
    };
  }

  const tokenEnv = pollerStatus.tokenEnvironment;
  const otherEnv = tokenEnv && tokenEnv.id && envId && tokenEnv.id !== envId
    ? ` The poller uses the token of environment '${tokenEnv.name || tokenEnv.id}' for this repository.`
    : '';

  switch (pollerStatus.status) {
    case 'listening':
      return {
        status: GH_HEALTH.OK,
        ok: true,
        label: 'OK',
        detail: (pollerStatus.waitingForFirstPoll ? 'Token valid; waiting for the first poll.' : 'Token valid; events are polled.') + otherEnv,
      };
    case 'failing': {
      const err = pollerStatus.lastError;
      if (err && err.rateLimited) {
        return { status: GH_HEALTH.RATE_LIMITED, ok: false, label: 'Rate limited', detail: `The poller is backing off: ${pollErrorText(err)}.${otherEnv}` };
      }
      return {
        status: GH_HEALTH.POLL_FAILING,
        ok: false,
        label: 'Polling failing',
        detail: `The poller's last attempts failed (${pollErrorText(err)}) and it is backing off — no events arrive until a poll succeeds.${otherEnv}`,
      };
    }
    case 'no-trigger':
      return {
        status: GH_HEALTH.NO_SUBSCRIBER,
        ok: false,
        label: 'No trigger for this repo',
        detail: 'The token works, but no enabled agent has an active GitHub-event trigger '
          + 'for this repository, so it is not polled.',
      };
    case 'no-token':
      return {
        status: GH_HEALTH.NO_TOKEN,
        ok: false,
        label: 'Token unusable',
        detail: 'The poller cannot use the GitHub token for this repository (its id is invalid, or the token file is missing or empty).' + otherEnv,
      };
    default:
      return {
        status: GH_HEALTH.NOT_POLLED,
        ok: false,
        label: 'Not polled',
        detail: 'The GitHub poller does not watch this repository — see the repository status on the GitHub Event Log.',
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
