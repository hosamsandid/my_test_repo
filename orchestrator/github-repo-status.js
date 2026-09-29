'use strict';

// ============================================================
// GitHub repository status (#2537)
// ------------------------------------------------------------
// For every repository the platform knows about, "are its GitHub events being
// received right now — and if not, why not?". Shown above the GitHub Event
// Log's event table and behind each Working Environment's GitHub integration
// banner.
//
// Pure: a function of the SAME inputs the poller's tick reads
// (GitHubPoller._readPlanInputs), the poll plan `computePollPlan` builds from
// them, and the poller's per-repo runtime state. It never re-derives "is this
// repo polled" — that answer is `plan.has(repo)` — so the view and the poller
// cannot disagree. It only explains the repos the plan left out.
//
// The repository set is the union of
//   1. every Working Environment's `repositories`,
//   2. every agent's `agentRepositories` (#2067 — never polled today, #2528),
//   3. the `repo` of every github-event trigger, on any agent, enabled or not,
// one row per `owner/name` (or per raw URL/name when it can't be parsed).
//
// Status (row.status) and its summary group (row.group):
//   listening           listening      in the plan, not in backoff
//   failing             failing        in the plan, last poll(s) failed
//   no-token            not-listening  no usable GitHub token
//   no-trigger          not-listening  token ok, no counted subscriber
//   not-in-environment  not-listening  only in agentRepositories / a trigger
//   unsupported         not-listening  unparseable URL / unsupported host
// ============================================================

const { pollerSubscribes, parseRepoFullName, isValidTokenId } = require('./github-poller');

const STATUS = {
  LISTENING: 'listening',
  FAILING: 'failing',
  NO_TOKEN: 'no-token',
  NO_TRIGGER: 'no-trigger',
  NOT_IN_ENVIRONMENT: 'not-in-environment',
  UNSUPPORTED: 'unsupported',
};

const GROUP_OF = {
  [STATUS.LISTENING]: 'listening',
  [STATUS.FAILING]: 'failing',
  [STATUS.NO_TOKEN]: 'not-listening',
  [STATUS.NO_TRIGGER]: 'not-listening',
  [STATUS.NOT_IN_ENVIRONMENT]: 'not-listening',
  [STATUS.UNSUPPORTED]: 'not-listening',
};

// A trigger's `repo` must be `owner/name` to ever match the plan's key.
const TRIGGER_REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

// Best-effort host of a repo URL, for the "unsupported host" reason.
function repoHost(url) {
  const s = String(url || '').trim();
  let m = s.match(/^[^@\s/]+@([^:/\s]+):/);
  if (m) return m[1];
  m = s.match(/^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?([^/:\s]+)/i);
  return m ? m[1] : null;
}

function agentName(agent) {
  const c = agent?.config || {};
  return c.displayName || c.name || agent.id;
}

// Why a github-event trigger for this repo does NOT count as a subscriber.
// null = it counts (mirrors computePollPlan: enabled agent + pollerSubscribes).
function ignoredReason(agent, t) {
  if (agent?.config?.enabled === false) return 'agent-disabled';
  if (t.enabled === false) return 'trigger-disabled';
  if (t.transport === 'internal') return 'internal';
  if (!Array.isArray(t.events) || t.events.length === 0) return 'no-events';
  return pollerSubscribes(t) ? null : 'invalid';
}

function buildRepoStatusView({
  environments = [],
  agents = [],
  allowNonGithubHost = false,
  plan = new Map(),
  state = {},
  firstTickDone = false,
  tokenReadable = () => false,
  now = Date.now(),
} = {}) {
  const rows = new Map();
  const row = (key) => {
    let r = rows.get(key);
    if (!r) {
      r = { repo: key, parsed: true, host: null, environments: [], agentRepositoryAgents: [], triggers: [], related: new Set() };
      rows.set(key, r);
    }
    return r;
  };
  // Resolve a repo URL to its row key; unparseable ones get their own row.
  const keyForUrl = (url) => {
    const fullName = parseRepoFullName(url, { allowNonGithubHost });
    if (fullName) return { key: fullName, parsed: true };
    return { key: String(url).trim(), parsed: false };
  };

  // Agents bound to each environment — they "use" it (visibility, AC9).
  const envAgents = new Map();
  const envTeam = new Map();
  for (const a of agents) {
    const envId = a?.config?.environmentId;
    if (!envId) continue;
    if (!envAgents.has(envId)) envAgents.set(envId, []);
    envAgents.get(envId).push(a.id);
    if (a.config.role === 'team' && !envTeam.has(envId)) envTeam.set(envId, a.id);
  }

  const tokenStateOf = (tokenId) => {
    if (!tokenId) return 'none';
    if (!isValidTokenId(tokenId)) return 'invalid-id';
    return tokenReadable(tokenId) ? 'ok' : 'unreadable';
  };

  // 1. Working Environment repositories.
  for (const env of environments) {
    if (!env) continue;
    const repos = Array.isArray(env.repositories) ? env.repositories : [];
    for (const r of repos) {
      if (!r || typeof r.url !== 'string' || !r.url.trim()) continue;
      const { key, parsed } = keyForUrl(r.url);
      const target = row(key);
      if (!parsed) { target.parsed = false; target.host = repoHost(r.url); }
      if (target.environments.some((e) => e.id === env.id)) continue;
      target.environments.push({
        id: env.id,
        name: env.name || env.id,
        tokenId: env.githubTokenId || null,
        tokenState: tokenStateOf(env.githubTokenId),
        teamId: envTeam.get(env.id) || null,
      });
      for (const id of envAgents.get(env.id) || []) target.related.add(id);
    }
  }

  // 2. Agent-scoped repositories, 3. github-event trigger repos.
  for (const a of agents) {
    if (!a || !a.id) continue;
    const list = Array.isArray(a.config?.agentRepositories) ? a.config.agentRepositories : [];
    for (const r of list) {
      if (!r || typeof r.url !== 'string' || !r.url.trim()) continue;
      const { key, parsed } = keyForUrl(r.url);
      const target = row(key);
      if (!parsed) { target.parsed = false; target.host = repoHost(r.url); }
      if (!target.agentRepositoryAgents.some((x) => x.id === a.id)) {
        target.agentRepositoryAgents.push({ id: a.id, name: agentName(a) });
      }
      target.related.add(a.id);
    }
    for (const t of Array.isArray(a.triggers) ? a.triggers : []) {
      if (!t || t.type !== 'github-event' || typeof t.repo !== 'string' || !t.repo.trim()) continue;
      const repo = t.repo.trim();
      const target = row(repo);
      if (!TRIGGER_REPO_RE.test(repo)) target.parsed = false;
      const reason = ignoredReason(a, t);
      target.triggers.push({
        agentId: a.id,
        agentName: agentName(a),
        triggerId: t.id || null,
        triggerName: t.description || t.name || null,
        events: Array.isArray(t.events) ? t.events.filter((e) => typeof e === 'string') : [],
        counted: reason === null && repo === t.repo,
        ignoredReason: reason === null && repo !== t.repo ? 'invalid' : reason,
      });
      target.related.add(a.id);
    }
  }

  const out = [];
  for (const r of rows.values()) {
    const st = (r.parsed && state && state[r.repo]) || {};
    const entry = r.parsed ? plan.get(r.repo) : null;
    let status;
    let tokenEnvironment = null;
    let waitingForFirstPoll = false;

    if (entry) {
      tokenEnvironment = r.environments.find((e) => e.id === entry.envId)
        || { id: entry.envId || null, name: entry.envId || null, tokenId: entry.tokenId, tokenState: tokenStateOf(entry.tokenId), teamId: null };
      if (tokenEnvironment.tokenState !== 'ok') {
        // _pollRepo returns early without counting a failure — never Listening.
        status = STATUS.NO_TOKEN;
      } else if ((st.consecutiveFailures || 0) > 0) {
        status = STATUS.FAILING;
      } else {
        status = STATUS.LISTENING;
        waitingForFirstPoll = !firstTickDone || !st.lastPolledAt;
      }
    } else if (!r.parsed) {
      status = STATUS.UNSUPPORTED;
    } else if (r.environments.length === 0) {
      status = STATUS.NOT_IN_ENVIRONMENT;
    } else if (!r.environments.some((e) => e.tokenId && isValidTokenId(e.tokenId))) {
      status = STATUS.NO_TOKEN;
    } else {
      status = STATUS.NO_TRIGGER;
      const first = r.environments.find((e) => e.tokenId && isValidTokenId(e.tokenId));
      tokenEnvironment = first || null;
    }

    const failing = status === STATUS.FAILING;
    out.push({
      repo: r.repo,
      status,
      group: GROUP_OF[status],
      waitingForFirstPoll,
      host: status === STATUS.UNSUPPORTED ? r.host : null,
      tokenEnvironment: tokenEnvironment
        ? { id: tokenEnvironment.id, name: tokenEnvironment.name, tokenId: tokenEnvironment.tokenId, tokenState: tokenEnvironment.tokenState, teamId: tokenEnvironment.teamId }
        : null,
      environments: r.environments,
      agentRepositoryAgents: r.agentRepositoryAgents,
      triggers: r.triggers,
      lastPolledAt: st.lastPolledAt || null,
      lastEventAt: st.lastEventAt || null,
      lastError: st.lastError || null,
      lastErrorAt: st.lastErrorAt || null,
      failingSince: failing ? (st.failingSince || st.lastErrorAt || null) : null,
      consecutiveFailures: failing ? st.consecutiveFailures : 0,
      nextRetryAt: failing && st.skipUntil && new Date(st.skipUntil).getTime() > now ? st.skipUntil : null,
      relatedAgentIds: [...r.related].sort(),
    });
  }
  out.sort((a, b) => a.repo.localeCompare(b.repo));
  return out;
}

module.exports = { STATUS, GROUP_OF, buildRepoStatusView, repoHost };
