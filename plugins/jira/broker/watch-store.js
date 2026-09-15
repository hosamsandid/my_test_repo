'use strict';

// ─── jira broker: per-scope watch config + poll cursor ───────────────────────
//
// One config document per scope (the manifest declares `scopes: ["team"]`, so a
// scopeId is a team id and there is one watch config per team) on the generic
// per-plugin STATE volume (`AEE_PLUGIN_STATE_DIR`, §4.8 / broker-config.js) —
// **not** the audit mount, which has its own retention semantics.
//
// This replaces #1539's `env.jiraProjects[]` on the Working Environment *and*
// the `jira-event` trigger's project/status fields (docs/jira-plugin-plan.md
// §3, §6.2). The config is edited by a Team Admin in the plugin's `/admin` UI
// route (Phase 4); for the Phase-0 spike it is seeded through the broker's
// `PUT /internal/spike-config` endpoint or the `JIRA_SPIKE_CONFIG` env var.
//
// A watch is:
//   { projectKey, statusFilters?: string[], jql?, wake: { agentIds? | "all-granted" } }
//
// `statusFilters` is a SET of target statuses — the watch fires on a transition
// into any of them (an empty / absent set = fire on any status change). A legacy
// singular `statusFilter` string is migrated to a one-element `statusFilters` on
// read, so a config written before multi-status support keeps working.
//
// The poll cursor is kept beside the config, sub-keyed by
// `<siteUrl>::<projectKey>` (the per-site scoping from #1539: a Jira project key
// is only unique per site, so the same key on two sites must never be
// conflated). It carries the seen-id set, lastPolledAt, the failure/backoff
// state and a short ring of recent poll errors (watch-health.js) surfaced on the
// `/watches` route.
//
// Writes are atomic (temp file + rename). Decisions that are pure live in
// event-extract.js / event-cursor.js; this file is I/O.

const fs = require('fs');
const path = require('path');

// A scopeId is a plugin-scope token subject. Constrain it to a safe path
// segment (defense in depth — the orchestrator only ever mints well-formed ids).
const SCOPE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function assertScope(scopeId) {
  if (typeof scopeId !== 'string' || !SCOPE_RE.test(scopeId)) {
    throw new Error(`invalid scopeId: ${String(scopeId)}`);
  }
  return scopeId;
}

function emptyConfig(scopeId) {
  return { scopeId, watches: [], doorbell: null, cursors: {}, setBy: null, setAt: null };
}

// Normalise one watch entry; drop anything without a projectKey.
function normalizeWatch(w) {
  if (!w || typeof w !== 'object') return null;
  const projectKey = typeof w.projectKey === 'string' ? w.projectKey.trim() : '';
  if (!projectKey) return null;
  const out = { projectKey };
  // `statusFilters` (a set) is canonical; a legacy singular `statusFilter`
  // string is folded into it so an older config keeps working. Trimmed,
  // de-duplicated, order preserved; an all-blank set collapses to "no filter"
  // (the key is omitted).
  const rawFilters = Array.isArray(w.statusFilters)
    ? w.statusFilters
    : (typeof w.statusFilter === 'string' ? [w.statusFilter] : []);
  const statusFilters = [];
  for (const s of rawFilters) {
    if (typeof s !== 'string') continue;
    const t = s.trim();
    if (t && !statusFilters.includes(t)) statusFilters.push(t);
  }
  if (statusFilters.length) out.statusFilters = statusFilters;
  if (typeof w.jql === 'string' && w.jql.trim()) out.jql = w.jql.trim();
  const wake = w.wake && typeof w.wake === 'object' ? w.wake : {};
  if (Array.isArray(wake.agentIds) && wake.agentIds.length) {
    out.wake = { agentIds: wake.agentIds.map(String).filter(Boolean) };
  } else {
    out.wake = { agentIds: 'all-granted' };
  }
  return out;
}

class WatchStore {
  constructor({ stateDir, now = () => new Date().toISOString() } = {}) {
    if (!stateDir) throw new Error('WatchStore requires a stateDir (AEE_PLUGIN_STATE_DIR)');
    this.dir = path.join(stateDir, 'watches');
    this.now = now;
  }

  _path(scopeId) {
    return path.join(this.dir, `${assertScope(scopeId)}.json`);
  }

  _read(scopeId) {
    assertScope(scopeId);
    let raw;
    try {
      raw = fs.readFileSync(this._path(scopeId), 'utf8');
    } catch (err) {
      if (err && err.code === 'ENOENT') return emptyConfig(scopeId);
      throw err;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      // A corrupt file would otherwise degrade SILENTLY to an empty config —
      // losing the watch list AND the poll cursors, so the next poll
      // re-baselines and drops whatever changed meanwhile. Make it loud.
      process.stderr.write(
        `[jira-broker] watch-store: ${this._path(scopeId)} is not valid JSON (${err.message}) — `
        + 'treating as empty; watches and cursors for this scope are lost until reconfigured\n',
      );
      parsed = {};
    }
    const cfg = emptyConfig(scopeId);
    cfg.watches = Array.isArray(parsed.watches) ? parsed.watches.map(normalizeWatch).filter(Boolean) : [];
    cfg.doorbell = parsed.doorbell && parsed.doorbell.url ? { url: String(parsed.doorbell.url), secret: parsed.doorbell.secret ? String(parsed.doorbell.secret) : null } : null;
    cfg.cursors = parsed.cursors && typeof parsed.cursors === 'object' ? parsed.cursors : {};
    cfg.setBy = parsed.setBy ? String(parsed.setBy) : null;
    cfg.setAt = parsed.setAt ? String(parsed.setAt) : null;
    return cfg;
  }

  _writeAtomic(scopeId, cfg) {
    fs.mkdirSync(this.dir, { recursive: true });
    const file = this._path(scopeId);
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
    // `mode:` on writeFileSync is subject to umask; re-assert 0600 (the file
    // holds the poll cursor and, for a doorbell, a secret).
    try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
  }

  // The full config for a scope (an empty one on first touch, never a 404).
  loadConfig(scopeId) {
    return this._read(scopeId);
  }

  // Replace a scope's watch list + doorbell target, recording who set it and
  // when (a Jira token carries a named human's site-wide permissions — §D2).
  // `setBy` is the console viewer's subject (or "spike" for the Phase-0 seam).
  // The cursor map is preserved so re-saving the config never re-baselines.
  setConfig(scopeId, { watches, doorbell, setBy } = {}) {
    assertScope(scopeId);
    const cfg = this._read(scopeId);
    if (watches !== undefined) cfg.watches = (Array.isArray(watches) ? watches : []).map(normalizeWatch).filter(Boolean);
    if (doorbell !== undefined) {
      cfg.doorbell = doorbell && doorbell.url
        ? { url: String(doorbell.url), secret: doorbell.secret ? String(doorbell.secret) : null }
        : null;
    }
    cfg.setBy = setBy ? String(setBy) : cfg.setBy;
    cfg.setAt = this.now();
    this._writeAtomic(scopeId, cfg);
    return cfg;
  }

  // Every scope that has a watch config on disk — the poll plan iterates these.
  listScopes() {
    let names;
    try { names = fs.readdirSync(this.dir); } catch { return []; }
    return names.filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5)).filter((s) => SCOPE_RE.test(s));
  }

  // ── poll cursor (per <siteUrl>::<projectKey>) ─────────────────────────────

  getCursor(scopeId, projectRef) {
    const cfg = this._read(scopeId);
    return cfg.cursors[projectRef] || null;
  }

  saveCursor(scopeId, projectRef, cursor) {
    assertScope(scopeId);
    const cfg = this._read(scopeId);
    cfg.cursors[projectRef] = cursor;
    this._writeAtomic(scopeId, cfg);
    return cfg.cursors[projectRef];
  }

  // Teardown reaps a scope's config when its grant is revoked / its team is
  // deleted (§4.9, runs while the token is still valid). Best-effort + idempotent.
  teardown(scopeId) {
    assertScope(scopeId);
    try {
      fs.unlinkSync(this._path(scopeId));
      return 1;
    } catch (err) {
      if (err && err.code === 'ENOENT') return 0;
      throw err;
    }
  }
}

module.exports = { WatchStore, SCOPE_RE, assertScope, normalizeWatch };
