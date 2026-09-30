// Pure view helpers for the repository status area on the GitHub Event Log's
// "Processed events" tab (#2537). React-free so they unit-test with
// `node --test` (the JSX in GithubRepoStatus.jsx is only parse-checked).
//
// Input rows come from GET /api/github-events/repo-status — the GitHub
// poller's own per-repository status (orchestrator/github-repo-status.js),
// already cut down to what the viewer may see. This module only turns each
// row into words: a status label, a plain-language reason naming the concrete
// cause, the fix link(s), and the subscriber counts.

import { relativeWhen } from '../components/format-when.js';

// Same visual language as the outcome column (#2524): plain text with a small
// status marker, no pill badges. `tone` picks the marker colour only — the
// text itself stays in the primary/secondary text tokens (light-theme
// warning/success are too low-contrast for body text).
export const STATUS_META = {
  listening: { label: 'Listening', group: 'listening', tone: 'success' },
  failing: { label: 'Failing', group: 'failing', tone: 'error' },
  'no-token': { label: 'Not listening — no token', group: 'not-listening', tone: 'warning' },
  // Often intentional (AC7): a neutral marker, not a warning.
  'no-trigger': { label: 'Not listening — no trigger', group: 'not-listening', tone: 'neutral' },
  // #2528: agent-scoped repositories are polled too — this status now only
  // means "named by a trigger, but no environment or agent has it attached".
  'not-in-environment': { label: 'Not listening — repository not attached', group: 'not-listening', tone: 'warning' },
  unsupported: { label: 'Not listening — unsupported repository', group: 'not-listening', tone: 'warning' },
};

export const GROUPS = [
  { key: 'listening', label: 'listening' },
  { key: 'failing', label: 'failing' },
  { key: 'not-listening', label: 'not listening' },
];

export function statusMeta(status) {
  return STATUS_META[status] || { label: String(status || 'Unknown'), group: 'not-listening', tone: 'neutral' };
}

export function groupOf(row) {
  return (row && row.group) || statusMeta(row && row.status).group;
}

// Counts per summary group (AC6).
export function summarize(rows) {
  const out = { listening: 0, failing: 0, 'not-listening': 0, total: 0 };
  for (const r of Array.isArray(rows) ? rows : []) {
    const g = groupOf(r);
    if (g in out) out[g] += 1;
    out.total += 1;
  }
  return out;
}

// "4 repositories listening · 1 failing · 2 not listening" — zero groups other
// than "listening" are left out so a healthy stack reads as one short clause.
export function summaryParts(counts) {
  const c = counts || {};
  const n = c.listening || 0;
  const parts = [{ group: 'listening', text: `${n} ${n === 1 ? 'repository' : 'repositories'} listening`, count: n }];
  if (c.failing) parts.push({ group: 'failing', text: `${c.failing} failing`, count: c.failing });
  if (c['not-listening']) parts.push({ group: 'not-listening', text: `${c['not-listening']} not listening`, count: c['not-listening'] });
  return parts;
}

// AC6: expanded by default when something is Failing, collapsed otherwise.
export function defaultExpanded(rows) {
  return summarize(rows).failing > 0;
}

export function filterByGroup(rows, group) {
  const list = Array.isArray(rows) ? rows : [];
  return group ? list.filter((r) => groupOf(r) === group) : list;
}

// Worst first, then by name: failing → not listening → listening.
const GROUP_ORDER = { failing: 0, 'not-listening': 1, listening: 2 };
export function sortRows(rows) {
  return [...(Array.isArray(rows) ? rows : [])].sort((a, b) =>
    (GROUP_ORDER[groupOf(a)] ?? 3) - (GROUP_ORDER[groupOf(b)] ?? 3)
    || String(a.repo).localeCompare(String(b.repo)));
}

export const IGNORED_REASON_LABEL = {
  'agent-disabled': 'agent disabled',
  'trigger-disabled': 'trigger disabled',
  'no-events': 'no events selected',
  invalid: 'invalid trigger',
};

// Subscribers: counted triggers + distinct agents, and the ignored ones grouped
// by why (edge case: "1 trigger ignored — agent disabled").
export function subscriberCounts(row) {
  const triggers = Array.isArray(row && row.triggers) ? row.triggers : [];
  const counted = triggers.filter((t) => t.counted);
  const agents = new Set(counted.map((t) => t.agentId));
  const ignored = new Map();
  for (const t of triggers) {
    if (t.counted) continue;
    const key = t.ignoredReason || 'invalid';
    ignored.set(key, (ignored.get(key) || 0) + 1);
  }
  return {
    triggers: counted.length,
    agents: agents.size,
    ignored: [...ignored.entries()].map(([reason, count]) => ({ reason, count, label: IGNORED_REASON_LABEL[reason] || reason })),
  };
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

export function subscriberSummary(row) {
  const c = subscriberCounts(row);
  let text = `${plural(c.triggers, 'trigger', 'triggers')} on ${plural(c.agents, 'agent', 'agents')}`;
  for (const i of c.ignored) text += ` · ${plural(i.count, 'trigger', 'triggers')} ignored — ${i.label}`;
  return text;
}

// A short future phrase for the next retry: "in 4 min", "in 30 s", "now".
export function inWhen(iso, nowMs) {
  const ms = typeof iso === 'string' ? Date.parse(iso) : NaN;
  if (Number.isNaN(ms) || typeof nowMs !== 'number') return '';
  const delta = ms - nowMs;
  if (delta <= 0) return 'now';
  if (delta < 60_000) return `in ${Math.max(1, Math.round(delta / 1000))} s`;
  return `in ${Math.round(delta / 60_000)} min`;
}

const ago = (iso, nowMs) => relativeWhen(iso, nowMs) || '';

function clock(iso) {
  const ms = typeof iso === 'string' ? Date.parse(iso) : NaN;
  if (Number.isNaN(ms)) return '';
  return new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

export function errorText(err) {
  if (!err) return 'The last poll failed';
  if (err.rateLimited) return `Rate limited by GitHub${err.status ? ` (${err.status})` : ''}`;
  if (err.status) return `${err.message || 'HTTP error'} (${err.status})`;
  return `Network error: ${err.message || 'no response'}`;
}

// Fix-it destinations (AC4). Environment settings live on the team's
// configuration surface (`?tab=repositories`), an agent's triggers on its
// right-rail Triggers tab (`?rail=triggers`), tokens on the GitHub Tokens page.
export function environmentLink(env) {
  if (!env || !env.teamId) return null;
  return { label: `Open ${env.name || env.id} → Repositories`, to: `/chats/${encodeURIComponent(env.teamId)}?tab=repositories` };
}
export function agentTriggersLink(agentId, agentName) {
  if (!agentId) return null;
  return { label: `Open ${agentName || agentId} → Triggers`, to: `/chats/${encodeURIComponent(agentId)}?rail=triggers` };
}
export const TOKENS_LINK = { label: 'Open GitHub Tokens', to: '/github-tokens' };

const envName = (e) => (e && (e.name || e.id)) || 'an environment';
const quoted = (list) => list.map((x) => `“${x}”`).join(', ');

// Other environments that list the repo with a token of their own — for the
// "the token in use is broken, but another environment has one" edge case.
function otherTokenEnvs(row) {
  const used = row.tokenEnvironment && row.tokenEnvironment.id;
  return (row.environments || []).filter((e) => e.id !== used && e.tokenState === 'ok');
}

// The plain-language reason + fix links for one row (AC2/AC4/AC5).
export function describeRow(row, nowMs) {
  const r = row || {};
  const links = [];
  const push = (l) => { if (l && !links.some((x) => x.to === l.to)) links.push(l); };
  const tokenEnv = r.tokenEnvironment;
  let text;

  switch (r.status) {
    case 'listening': {
      if (r.waitingForFirstPoll) text = `Waiting for first poll · ${subscriberSummary(r)}`;
      else text = `Polled ${ago(r.lastPolledAt, nowMs) || 'recently'} · ${subscriberSummary(r)}`;
      break;
    }
    case 'failing': {
      const since = r.failingSince ? ` since ${clock(r.failingSince)}` : '';
      const retry = r.nextRetryAt ? ` · next retry ${inWhen(r.nextRetryAt, nowMs)}` : ' · retrying on the next poll';
      const count = r.consecutiveFailures ? ` · ${plural(r.consecutiveFailures, 'failed attempt', 'failed attempts')}` : '';
      text = `${errorText(r.lastError)}${since}${count}${retry}`;
      const others = otherTokenEnvs(r);
      if (others.length) {
        text += `. ${quoted(others.map(envName))} also ${others.length === 1 ? 'has' : 'have'} a token for this repository, but the poller uses the first environment's (${envName(tokenEnv)})`;
        others.forEach((e) => push(environmentLink(e)));
      }
      push(TOKENS_LINK);
      push(environmentLink(tokenEnv));
      break;
    }
    case 'no-token': {
      if (tokenEnv && tokenEnv.tokenState && tokenEnv.tokenState !== 'ok') {
        text = tokenEnv.hidden
          ? 'The GitHub token the poller would use is missing or empty'
          : `The GitHub token of environment ${quoted([envName(tokenEnv)])} is missing or empty (id “${tokenEnv.tokenId}”)`;
        push(TOKENS_LINK);
        push(environmentLink(tokenEnv));
      } else {
        // #2528: an agent-scoped repository is polled with its agent's
        // environment's token — those environments count here too.
        const envs = [...(r.environments || [])];
        const envless = [];
        for (const a of r.agentRepositoryAgents || []) {
          if (!a.environment) envless.push(a.name || a.id);
          else if (!envs.some((e) => e.id === a.environment.id)) envs.push(a.environment);
        }
        const invalid = envs.filter((e) => e.tokenState === 'invalid-id');
        const none = envs.filter((e) => e.tokenState === 'none');
        const bits = [];
        if (none.length) bits.push(`${none.length === 1 ? 'Environment' : 'Environments'} ${quoted(none.map(envName))} ${none.length === 1 ? 'has' : 'have'} no GitHub token`);
        if (invalid.length) bits.push(`${quoted(invalid.map(envName))} ${invalid.length === 1 ? 'has' : 'have'} an invalid GitHub token id`);
        if (envless.length) bits.push(`${envless.length === 1 ? 'Agent' : 'Agents'} ${quoted(envless)} ${envless.length === 1 ? 'is' : 'are'} not bound to an environment to take a GitHub token from`);
        text = bits.length ? bits.join('; ') : 'No environment you can see that lists this repository has a GitHub token';
        envs.forEach((e) => push(environmentLink(e)));
      }
      break;
    }
    case 'no-trigger': {
      text = 'No active GitHub trigger subscribes to this repository';
      const c = subscriberCounts(r);
      for (const i of c.ignored) text += ` · ${plural(i.count, 'trigger', 'triggers')} ignored — ${i.label}`;
      for (const t of r.triggers || []) push(agentTriggersLink(t.agentId, t.agentName));
      break;
    }
    case 'not-in-environment': {
      // #2528: agent-scoped repositories are polled, so this is a repository
      // only a trigger names (e.g. it was detached from the agent since).
      const triggerOwners = [...new Set((r.triggers || []).map((t) => t.agentName || t.agentId))];
      if (triggerOwners.length) {
        text = `Only named by a trigger of ${quoted(triggerOwners)} — no environment or agent has this repository attached`;
      } else {
        text = 'No environment or agent has this repository attached';
      }
      (r.triggers || []).forEach((t) => push(agentTriggersLink(t.agentId, t.agentName)));
      break;
    }
    case 'unsupported': {
      if (r.host) text = `Host “${r.host}” is not supported by the poller`;
      else if ((r.triggers || []).length && !(r.environments || []).length && !(r.agentRepositoryAgents || []).length) {
        text = `“${r.repo}” is not an owner/name repository — check the trigger's repository`;
      } else text = 'This repository URL cannot be read as a GitHub repository';
      (r.environments || []).forEach((e) => push(environmentLink(e)));
      (r.triggers || []).forEach((t) => push(agentTriggersLink(t.agentId, t.agentName)));
      break;
    }
    default:
      text = 'Status unknown';
  }
  return { text, links };
}

// The token column: the environment whose token the poller uses (never the
// token value — the id at most), plus the other environments that list it.
export function tokenSourceText(row) {
  const e = row && row.tokenEnvironment;
  let text = '—';
  if (e && e.hidden) text = 'Another team’s environment';
  else if (e) text = envName(e);
  const others = ((row && row.environments) || []).filter((x) => !e || x.id !== e.id);
  const hidden = (row && row.hiddenEnvironmentCount) || 0;
  const also = others.length + (e && e.hidden ? Math.max(0, hidden - 1) : hidden);
  return also > 0 ? `${text} (+${also} other ${also === 1 ? 'environment' : 'environments'})` : text;
}
