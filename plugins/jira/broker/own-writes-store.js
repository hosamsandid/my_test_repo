'use strict';

// ─── jira broker: per-scope registry of the broker's OWN Jira writes ────────
//
// The poller sees an agent's own writes come back as events: an issue it
// created is an `issue_created`, a field it set is a `field_changed`, a comment
// it posted is a `comment_added`. Jira cannot tell them apart from a human's —
// every write is made with the Team Admin's API token, so `author` is that
// admin either way (docs/jira-plugin-events-implementation.md §1.3, §1.11). The
// broker is the one party that knows what it wrote, so it records each write
// here and the extractors stamp `origin: agent | human` from it (§2.4) — the
// field a trigger routes on to avoid an agent waking itself.
//
// One file per scope on `AEE_PLUGIN_STATE_DIR`:
//
//   { comments:     { "<issueKey>:c<commentId>": "<iso>" },
//     issues:       { "<issueKey>": "<iso>" },
//     fields:       { "<issueKey>|<fieldRef>": ["<iso>", …] },
//     descriptions: { "<issueKey>": "<iso>" } }
//
// `<fieldRef>` `*` is the wildcard: a write that changes fields without naming
// them (a transition — resolution, transition-screen fields). Any field change
// on that issue near the stamp is then the agent's.
//
// A field write has no id of its own to match (the changelog history id is
// not returned by the write), so it is matched by issue + field + time, and a
// field keeps its last FIELD_STAMPS_MAX stamps — two quick writes to the same
// field are both recognised. Every other section is one stamp per key.
//
// Written BEFORE the broker answers the CLI; the poll that observes the write
// is at least one tick away. Entries expire after RETENTION_MS (reaped on the
// poll sweep) — far longer than any poll gap the horizon gate still delivers
// (24h). Atomic writes (temp file + rename), like the other stores.

const fs = require('fs');
const path = require('path');

const SCOPE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const RETENTION_MS = 7 * 24 * 3600 * 1000;
const SECTIONS = ['comments', 'issues', 'fields', 'descriptions'];
const FIELD_STAMPS_MAX = 20;

function assertScope(scopeId) {
  if (typeof scopeId !== 'string' || !SCOPE_RE.test(scopeId)) {
    throw new Error(`invalid scopeId: ${String(scopeId)}`);
  }
  return scopeId;
}

function emptyDoc() {
  return { comments: {}, issues: {}, fields: {}, descriptions: {} };
}

// The key a field write is recorded under. `fieldRef` is a field id
// (`customfield_10020`) or a display name (`Team`); names are case-folded so
// the changelog's `field` matches however the CLI spelled it.
function fieldKey(issueKey, fieldRef) {
  return `${issueKey}|${String(fieldRef || '').trim().toLowerCase()}`;
}

class OwnWritesStore {
  constructor({ stateDir, retentionMs, now = () => Date.now() } = {}) {
    if (!stateDir) throw new Error('OwnWritesStore requires a stateDir (AEE_PLUGIN_STATE_DIR)');
    this.dir = path.join(stateDir, 'own-writes');
    this.retentionMs = Number.isInteger(retentionMs) && retentionMs > 0 ? retentionMs : RETENTION_MS;
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
        process.stderr.write(`[jira-broker] own-writes-store: read ${this._path(scopeId)} failed (${err.message})\n`);
      }
      return emptyDoc();
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      // Losing the registry only degrades `origin` (an own write may read as
      // `human` → one self-wake); say so rather than fail the poll.
      process.stderr.write(
        `[jira-broker] own-writes-store: ${this._path(scopeId)} is not valid JSON (${err.message}) — starting empty\n`,
      );
      return emptyDoc();
    }
    const doc = emptyDoc();
    for (const s of SECTIONS) {
      if (parsed && parsed[s] && typeof parsed[s] === 'object') doc[s] = { ...parsed[s] };
    }
    return doc;
  }

  _write(scopeId, doc) {
    fs.mkdirSync(this.dir, { recursive: true });
    const file = this._path(scopeId);
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
    try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
  }

  _record(scopeId, section, key) {
    const doc = this._read(scopeId);
    doc[section][key] = new Date(this.now()).toISOString();
    this._write(scopeId, doc);
  }

  recordIssue(scopeId, issueKey) { this._record(scopeId, 'issues', String(issueKey)); }
  recordComment(scopeId, issueKey, commentId) { this._record(scopeId, 'comments', `${issueKey}:c${commentId}`); }
  recordField(scopeId, issueKey, fieldRef) {
    const doc = this._read(scopeId);
    const key = fieldKey(issueKey, fieldRef);
    const stamps = Array.isArray(doc.fields[key]) ? doc.fields[key] : [];
    stamps.push(new Date(this.now()).toISOString());
    doc.fields[key] = stamps.slice(-FIELD_STAMPS_MAX);
    this._write(scopeId, doc);
  }
  recordDescription(scopeId, issueKey) { this._record(scopeId, 'descriptions', String(issueKey)); }

  // The whole registry for one scope — what the poller hands the (pure)
  // origin resolvers in event-extract.js for one poll.
  snapshot(scopeId) {
    return this._read(scopeId);
  }

  // Drop entries past retention, rewriting only if something expired.
  reap(scopeId) {
    const doc = this._read(scopeId);
    const cutoff = this.now() - this.retentionMs;
    let removed = 0;
    const live = (at) => (Date.parse(at) || 0) >= cutoff;
    for (const s of SECTIONS) {
      for (const [k, at] of Object.entries(doc[s])) {
        if (Array.isArray(at)) {
          const kept = at.filter(live);
          removed += at.length - kept.length;
          if (kept.length) doc[s][k] = kept; else delete doc[s][k];
        } else if (!live(at)) { delete doc[s][k]; removed += 1; }
      }
    }
    if (removed) this._write(scopeId, doc);
    return removed;
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

module.exports = { OwnWritesStore, fieldKey, RETENTION_MS, FIELD_STAMPS_MAX };
