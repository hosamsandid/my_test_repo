// trigger-repo-status.js — pure view decisions for the repository side of a
// github-event trigger in Agent Chat's Triggers tab (#2528). JSX-free per the
// #651 convention so it is node:test covered.
//
//   - triggerRepoOptions: what the trigger editor's repository picker offers —
//     the agent's Working Environment repositories AND its agent-scoped ones
//     (`agentRepositories`, #2067), which the GitHub poller now polls too.
//   - triggerRepoWarning: the "not listening" notice on a trigger row, taken
//     verbatim from the GitHub Event Log's Repositories status rows
//     (GET /api/github-events/repo-status), so the two surfaces cannot disagree.

import { statusMeta, describeRow } from '../github-repo-status-view.js';
import { SCOPE_LABELS } from './agent-repos-view.js';

// Mirrors orchestrator/github-poller.js — extracts owner/repo from a
// repository URL.
export function parseRepoFullName(url) {
  if (!url) return null;
  const ssh = String(url).match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/);
  if (ssh) return `${ssh[1]}/${ssh[2]}`;
  const https = String(url).match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (https) return `${https[1]}/${https[2]}`;
  return null;
}

// One picker option per `owner/name`: environment repositories first, then the
// agent's own. A repo in both is an environment repo (it is polled with the
// environment's token either way). `currentRepo` — the trigger's saved repo —
// stays selectable when it is in neither list (e.g. detached since), marked so.
export function triggerRepoOptions({ envRepositories = [], agentRepositories = [], currentRepo = '' } = {}) {
  const out = [];
  const seen = new Set();
  const add = (list, scope) => {
    for (const r of Array.isArray(list) ? list : []) {
      const fullName = parseRepoFullName(r && r.url);
      if (!fullName || seen.has(fullName)) continue;
      seen.add(fullName);
      out.push({
        url: r.url,
        fullName,
        scope,
        label: scope === 'agent' ? `${fullName} — ${SCOPE_LABELS.agent.toLowerCase()}` : fullName,
      });
    }
  };
  add(envRepositories, 'environment');
  add(agentRepositories, 'agent');
  const cur = typeof currentRepo === 'string' ? currentRepo.trim() : '';
  if (cur && !seen.has(cur)) {
    out.push({ url: null, fullName: cur, scope: 'unattached', label: `${cur} — not attached to this agent` });
  }
  return out;
}

// The environment's repositories only — a data-flow dependency always lives
// on the team repository, never on an agent-scoped one.
export function environmentRepoOptions(options) {
  return (Array.isArray(options) ? options : []).filter((o) => o.scope === 'environment');
}

// null = no warning. A warning only when the trigger would be polled if its
// repository were listened to, and the status row says it is not: disabled
// triggers already read "Off". Every enabled github-event trigger goes through
// the poller (the internal transport was removed in #2578). A missing row
// (status unavailable, or not visible to the viewer) is no warning — we do not
// guess.
export function triggerRepoWarning(trigger, statusRows, { agentId = null } = {}) {
  if (!trigger || trigger.type !== 'github-event') return null;
  if (trigger.enabled === false) return null;
  const repo = typeof trigger.repo === 'string' ? trigger.repo.trim() : '';
  if (!repo) return null;
  const row = (Array.isArray(statusRows) ? statusRows : []).find((r) => r && r.repo === repo);
  if (!row) return null;
  const meta = statusMeta(row.status);
  if (meta.group !== 'not-listening') return null;
  const { text, links } = describeRow(row, Date.now());
  // "Open <this agent> → Triggers" points at the tab the row is already in.
  const here = agentId ? `/chats/${encodeURIComponent(agentId)}?rail=triggers` : null;
  return { status: row.status, label: meta.label, tone: meta.tone, text, links: links.filter((l) => l.to !== here) };
}
