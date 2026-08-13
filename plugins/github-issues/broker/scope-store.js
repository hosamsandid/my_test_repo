'use strict';

// ─── github-issues broker: per-scope state (plugin, issue #1633) ─────────────
//
// Two kinds of server-side state, both keyed on the opaque scopeId (a team):
//
//   1. Credentials + repository list — held ONLY in memory, pushed per-scope by
//      the orchestrator (PUT /internal/scope-credentials) from the team's bound
//      Working Environment: `{ token, repos: [{ fullName, defaultBranch }] }`.
//      The token never touches disk here and is never returned to a caller —
//      the broker selects it internally when calling GitHub. `tokenForRepo`
//      doubles as the authorization guard: a repo not in the scope's env yields
//      no token, so a viewer cannot act on a repository outside their team's
//      scope (the issue's "authorization mismatch" edge case).
//
//   2. Last-used selection per (scope, user) — persisted on the plugin state
//      volume (AEE_PLUGIN_STATE_DIR) so the operator's team/repo choice is
//      remembered across sessions and browsers (AC5). One tiny JSON per pair;
//      atomic temp-file+rename writes, filename components sanitised. Mirrors
//      netzplan-broker/plan-store.js.

const fs = require('fs');
const path = require('path');

// Filename-safe token for a scopeId / user sub. Anything outside the set is
// collapsed so a crafted id can never escape the prefs directory.
const SAFE_RE = /[^A-Za-z0-9._-]+/g;
function safeName(s) {
  return String(s == null ? '' : s).replace(SAFE_RE, '_').slice(0, 200) || '_';
}

// Normalise one pushed repo entry to { fullName, defaultBranch }.
function normRepo(r) {
  if (!r) return null;
  const fullName = typeof r === 'string' ? r : String(r.fullName || r.full_name || '');
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(fullName)) return null;
  const defaultBranch = r && r.defaultBranch ? String(r.defaultBranch) : (r && r.branch ? String(r.branch) : null);
  return { fullName, defaultBranch };
}

class ScopeStore {
  constructor({ stateDir } = {}) {
    this.stateDir = stateDir || null;
    // scopeId -> { token, repos: [{fullName, defaultBranch}], updatedAt }
    this.creds = new Map();
  }

  prefsDir() {
    return this.stateDir ? path.join(this.stateDir, 'prefs') : null;
  }

  // Replace the whole credential map from a pushed `{ scopeId: {token, repos} }`.
  // Absent/blank token or empty repo list is still stored (the UI shows the
  // "no token" / "no repos" empty states from it) — an entry simply has no
  // usable token then.
  setCredentials(scopesObj) {
    const next = new Map();
    const src = scopesObj && typeof scopesObj === 'object' ? scopesObj : {};
    for (const [scopeId, entry] of Object.entries(src)) {
      if (!scopeId || !entry || typeof entry !== 'object') continue;
      const repos = Array.isArray(entry.repos) ? entry.repos.map(normRepo).filter(Boolean) : [];
      next.set(String(scopeId), {
        token: typeof entry.token === 'string' ? entry.token : '',
        repos,
        // Flow labels (#1642): the gate/outcome labels the team's flow uses,
        // suggested ahead of the repo's raw label list. `labelAgents` is the
        // per-repo label→agent trigger preview (`{ [repo]: { [label]: [name] } }`,
        // '' = an any-label listener). Both are pushed by the orchestrator; kept
        // as plain data (never a token) and served on the /labels response.
        flowLabels: Array.isArray(entry.flowLabels)
          ? entry.flowLabels.filter((l) => typeof l === 'string' && l)
          : [],
        labelAgents: (entry.labelAgents && typeof entry.labelAgents === 'object' && !Array.isArray(entry.labelAgents))
          ? entry.labelAgents
          : {},
        // Per-label usage classification (#1730): `{ [label]: 'humanGate' |
        // 'agentEmitted' }`, so the UI can colour-code the workflow-trigger
        // buttons. Team-level (not per-repo), like flowLabels; a label absent
        // here degrades to a neutral button treatment.
        labelUsage: (entry.labelUsage && typeof entry.labelUsage === 'object' && !Array.isArray(entry.labelUsage))
          ? entry.labelUsage
          : {},
        updatedAt: entry.updatedAt || null,
      });
    }
    this.creds = next;
    return this.creds.size;
  }

  credsFor(scopeId) {
    return this.creds.get(String(scopeId)) || null;
  }

  // Repositories visible to a scope, WITHOUT the token. `hasToken` tells the UI
  // whether a GitHub token is bound (drives the "configure a token" message).
  reposFor(scopeId) {
    const entry = this.credsFor(scopeId);
    if (!entry) return { repos: [], hasToken: false, known: false };
    return {
      repos: entry.repos.map((r) => ({ fullName: r.fullName, defaultBranch: r.defaultBranch })),
      hasToken: !!entry.token,
      known: true,
    };
  }

  // The token to use for one repo in a scope — or null if the repo is not in the
  // scope's environment (authorization guard) or no token is bound.
  tokenForRepo(scopeId, repoFullName) {
    const entry = this.credsFor(scopeId);
    if (!entry || !entry.token) return null;
    return entry.repos.some((r) => r.fullName === repoFullName) ? entry.token : null;
  }

  // ── last-used selection (persisted per scope+user) ─────────────────────────
  prefPath(scopeId, userSub) {
    const dir = this.prefsDir();
    if (!dir) return null;
    return path.join(dir, `${safeName(scopeId)}__${safeName(userSub)}.json`);
  }

  loadPref(scopeId, userSub) {
    const p = this.prefPath(scopeId, userSub);
    if (!p) return null;
    try {
      const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
      return raw && typeof raw === 'object' ? raw : null;
    } catch {
      return null;
    }
  }

  savePref(scopeId, userSub, pref) {
    const p = this.prefPath(scopeId, userSub);
    if (!p) return null;
    const dir = path.dirname(p);
    fs.mkdirSync(dir, { recursive: true });
    const doc = {
      repo: pref && pref.repo ? String(pref.repo) : null,
      state: pref && pref.state ? String(pref.state) : null,
      updatedAt: pref && pref.updatedAt ? pref.updatedAt : null,
    };
    const tmp = `${p}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(doc), { mode: 0o600 });
    fs.renameSync(tmp, p);
    return doc;
  }

  // The user's globally most-recently-used selection across a set of authorized
  // scopes (#1650). Each scope keeps its own `{repo, state, updatedAt}` pref;
  // this picks the ONE whose `updatedAt` is latest so reopening restores the
  // project the user actually used last — not whichever scope happens to sort
  // first (the AC2 defect). A pref with no `repo` is ignored (never usefully
  // restorable). Ties / missing timestamps fall back to `scopeIds` order, so a
  // single-scope user and pre-#1650 prefs (no `updatedAt`) behave as before.
  // Authorization is unaffected: the named repo is re-checked by `tokenForRepo`
  // on the actual list call, so a stale/out-of-scope repo can never grant access.
  pickLastUsed(scopeIds, userSub) {
    let best = null;
    let bestMs = -1;
    for (const scopeId of Array.isArray(scopeIds) ? scopeIds : []) {
      const pref = this.loadPref(scopeId, userSub);
      if (!pref || !pref.repo) continue;
      const ms = Date.parse(pref.updatedAt) || 0;
      if (ms > bestMs) {
        bestMs = ms;
        best = { team: String(scopeId), repo: String(pref.repo), state: pref.state || 'open' };
      }
    }
    return best;
  }

  // Count persisted pref objects for a scope (quota accounting on the UI path).
  count(scopeId) {
    const dir = this.prefsDir();
    if (!dir) return 0;
    const prefix = `${safeName(scopeId)}__`;
    try {
      return fs.readdirSync(dir).filter((f) => f.startsWith(prefix) && f.endsWith('.json')).length;
    } catch {
      return 0;
    }
  }

  // Reap everything owned by a scope: drop its in-memory creds and delete its
  // persisted prefs. Called by the teardown endpoint on team/agent deletion.
  teardown(scopeId) {
    let removed = 0;
    this.creds.delete(String(scopeId));
    const dir = this.prefsDir();
    if (dir) {
      const prefix = `${safeName(scopeId)}__`;
      try {
        for (const f of fs.readdirSync(dir)) {
          if (f.startsWith(prefix) && f.endsWith('.json')) {
            try { fs.unlinkSync(path.join(dir, f)); removed += 1; } catch { /* best-effort */ }
          }
        }
      } catch { /* nothing to reap */ }
    }
    return removed;
  }
}

module.exports = { ScopeStore, safeName, normRepo };
