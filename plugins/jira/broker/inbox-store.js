'use strict';

// ─── jira broker: per-scope event inbox ─────────────────────────────────────
//
// The queue of status-change events delivered (a wake was fired) but not yet
// consumed by the agent it woke (`consumeIds` — by event id, never the whole
// team queue). It is the source of truth for "what happened" — the
// agent pulls it with `aee-jira inbox` after a wake, rather than trusting a
// prompt that may be stale by the time the run starts (docs/jira-plugin-plan.md
// §4A). The wake itself carries only a summary + the triggering event; the
// inbox is where the full, ordered payload lives.
//
// One inbox per scope on `AEE_PLUGIN_STATE_DIR`. Bounded two ways:
//   • TTL   — entries older than `ttlSeconds` (manifest `quota.ttlSeconds`, or a
//             7-day default) are reaped on every append and on the poll sweep.
//   • count — capped at `maxObjects` (manifest `quota.maxObjects`); appending
//             past the cap drops the OLDEST unconsumed entry (a ring), because
//             an inbox that refuses new events once full is worse than one that
//             loses the oldest. **This is what `quota.maxObjects` counts** — the
//             SDK deliberately does not know what an "object" is for a plugin
//             (a watch config is operator configuration, not counted).
//
// Atomic writes (temp file + rename). Pure list math is trivial and inline.

const fs = require('fs');
const path = require('path');

const SCOPE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const DEFAULT_TTL_SECONDS = 7 * 24 * 3600;
const DEFAULT_MAX_OBJECTS = 500;

function assertScope(scopeId) {
  if (typeof scopeId !== 'string' || !SCOPE_RE.test(scopeId)) {
    throw new Error(`invalid scopeId: ${String(scopeId)}`);
  }
  return scopeId;
}

class InboxStore {
  constructor({ stateDir, ttlSeconds, maxObjects, now = () => Date.now() } = {}) {
    if (!stateDir) throw new Error('InboxStore requires a stateDir (AEE_PLUGIN_STATE_DIR)');
    this.dir = path.join(stateDir, 'inbox');
    this.ttlMs = (Number.isInteger(ttlSeconds) && ttlSeconds > 0 ? ttlSeconds : DEFAULT_TTL_SECONDS) * 1000;
    this.max = Number.isInteger(maxObjects) && maxObjects > 0 ? maxObjects : DEFAULT_MAX_OBJECTS;
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
      if (!err || err.code !== 'ENOENT') {
        process.stderr.write(`[jira-broker] inbox-store: read ${this._path(scopeId)} failed (${err.message})\n`);
      }
      return [];
    }
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : (Array.isArray(parsed.entries) ? parsed.entries : []);
    } catch (err) {
      // Degrading to [] silently would drop every unconsumed event with no
      // trace — say so.
      process.stderr.write(
        `[jira-broker] inbox-store: ${this._path(scopeId)} is not valid JSON (${err.message}) — dropping its contents\n`,
      );
      return [];
    }
  }

  _write(scopeId, entries) {
    fs.mkdirSync(this.dir, { recursive: true });
    const file = this._path(scopeId);
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify({ entries }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
    // `mode:` on writeFileSync is subject to umask; re-assert 0600 (the inbox
    // holds Jira issue summaries).
    try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
  }

  _fresh(entries) {
    const cutoff = this.now() - this.ttlMs;
    return entries.filter((e) => e && (Date.parse(e.receivedAt) || 0) >= cutoff);
  }

  // Append one delivered event. Reaps TTL-expired entries first, then trims the
  // oldest if the cap is exceeded. `event` is the shaped status-change event;
  // `meta` carries the wake context (triggerId / digest flag).
  append(scopeId, event, meta = {}) {
    assertScope(scopeId);
    let entries = this._fresh(this._read(scopeId));
    entries.push({ receivedAt: new Date(this.now()).toISOString(), ...meta, event });
    if (entries.length > this.max) entries = entries.slice(entries.length - this.max);
    this._write(scopeId, entries);
    return entries.length;
  }

  // List unconsumed entries (freshest last, insertion order). TTL-filtered but
  // not written back — a plain read stays a read.
  list(scopeId) {
    return this._fresh(this._read(scopeId));
  }

  // Drain BY ID: remove exactly the entries whose `event.id` is in `ids` and
  // return them (inbox order) plus the ids that were not there (already
  // drained, TTL-reaped, or mistyped — reported, never an error, so a re-run
  // of the same wake is idempotent). This is `aee-jira inbox --consume <id>…`.
  //
  // There is deliberately no whole-inbox drain: the inbox is per SCOPE (team)
  // and several agents share it, each woken for its own subset (the
  // orchestrator's payloadFilter/projection decide which). An agent may only
  // ever drain the ids its own wake named — a team-wide drain would take a
  // teammate's events with it.
  consumeIds(scopeId, ids) {
    assertScope(scopeId);
    const wanted = new Set((Array.isArray(ids) ? ids : []).filter((id) => typeof id === 'string' && id));
    if (wanted.size === 0) return { entries: [], missing: [] };
    const fresh = this._fresh(this._read(scopeId));
    const removed = [];
    const kept = [];
    for (const e of fresh) {
      const id = e && e.event && typeof e.event.id === 'string' ? e.event.id : null;
      if (id && wanted.has(id)) removed.push(e); else kept.push(e);
    }
    this._write(scopeId, kept);
    const found = new Set(removed.map((e) => e.event.id));
    return { entries: removed, missing: [...wanted].filter((id) => !found.has(id)) };
  }

  count(scopeId) {
    return this._fresh(this._read(scopeId)).length;
  }

  // Sweep TTL across one scope (called from the poll tick), rewriting only if
  // something was actually reaped.
  reap(scopeId) {
    assertScope(scopeId);
    const all = this._read(scopeId);
    const fresh = this._fresh(all);
    if (fresh.length !== all.length) this._write(scopeId, fresh);
    return all.length - fresh.length;
  }

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

module.exports = { InboxStore, SCOPE_RE, assertScope, DEFAULT_TTL_SECONDS, DEFAULT_MAX_OBJECTS };
