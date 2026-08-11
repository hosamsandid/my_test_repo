'use strict';

// ─── Network Plan document store (plugin #3, Phase 3, #1563) ─────────────────
//
// The thin fs adapter over the pure plan-doc.js model. One board per scope (the
// manifest declares `scopes: ["team"]`, so a scopeId is a team id and there is
// one board per team); the store keeps the JSON on the generic per-plugin STATE
// volume the platform mounts (`AEE_PLUGIN_STATE_DIR`, §4.8 / broker-config.js) —
// **not** the audit mount, which has its own retention semantics.
//
// Persisting here (rather than in a viewer's localStorage, as the board this
// replaces did) is what makes two browser profiles see the same board and what
// makes the state survive a `podman restart` of the sidecar: the document lives
// on a named volume, the container is cattle.
//
// Writes are atomic (temp file + rename) so a crash mid-write never leaves a
// half-written board. All decisions come from plan-doc.js; this file is I/O.

const fs = require('fs');
const path = require('path');

const {
  newPlanDoc,
  normalizePlanDoc,
  migratePlanDoc,
  applyMutation,
  requiredAutonomy,
} = require('./plan-doc');

// A scopeId is a plugin-scope token subject: `{team|agent}` id. Constrain it to
// a safe path segment so it can never escape the documents dir (defense in depth
// — the orchestrator only ever mints well-formed ids).
const SCOPE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function assertScope(scopeId) {
  if (typeof scopeId !== 'string' || !SCOPE_RE.test(scopeId)) {
    throw new Error(`invalid scopeId: ${String(scopeId)}`);
  }
  return scopeId;
}

class PlanStore {
  constructor({ stateDir, now = () => Date.now() } = {}) {
    if (!stateDir) throw new Error('PlanStore requires a stateDir (AEE_PLUGIN_STATE_DIR)');
    this.stateDir = stateDir;
    this.docsDir = path.join(stateDir, 'documents');
    this.now = now;
  }

  _ensureDir() {
    fs.mkdirSync(this.docsDir, { recursive: true });
  }

  _pathFor(scopeId) {
    return path.join(this.docsDir, `${assertScope(scopeId)}.json`);
  }

  // Load a scope's board, creating an empty one on first touch so `show` always
  // returns a usable document (an empty board, never a 404).
  load(scopeId) {
    assertScope(scopeId);
    let raw;
    try {
      raw = fs.readFileSync(this._pathFor(scopeId), 'utf8');
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        return newPlanDoc({ id: scopeId, teamId: scopeId, now: this.now() });
      }
      throw err;
    }
    let parsed;
    try { parsed = JSON.parse(raw); } catch { parsed = {}; }
    // migrate re-normalizes an older-version stored doc; teamId is pinned to the
    // scope so a hand-edited file can't reassign a board to another team.
    const doc = migratePlanDoc(parsed, { now: this.now() });
    doc.id = scopeId;
    doc.teamId = scopeId;
    return doc;
  }

  _writeAtomic(scopeId, doc) {
    this._ensureDir();
    const file = this._pathFor(scopeId);
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(doc), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  // Persist a full document (used by the console UI PUT and tests). Normalizes
  // and pins the scope so a client can't rewrite id/teamId.
  save(scopeId, input) {
    assertScope(scopeId);
    const doc = normalizePlanDoc(input, { now: this.now() });
    doc.id = scopeId;
    doc.teamId = scopeId;
    doc.updatedAt = this.now();
    this._writeAtomic(scopeId, doc);
    return doc;
  }

  // Import a full document into a scope's board (content migration, #1566). Like
  // `save` it normalizes and pins id/teamId, but it differs in two deliberate
  // ways that make it the right primitive for the round-trip import UI:
  //   • it PRESERVES the imported document's createdAt/updatedAt verbatim, so
  //     `export → import → export` is byte-identical (the concept's round-trip
  //     guarantee) — an import restores a document, it is not an edit that bumps
  //     the clock.
  //   • it PRESERVES the board's current autonomy level rather than taking it
  //     from the imported document — agent autonomy is a governance setting that
  //     only the /admin `set-autonomy` route may change, so importing a document
  //     (even a foreign one) can never silently raise the ladder.
  import(scopeId, input) {
    assertScope(scopeId);
    const current = this.load(scopeId);
    const doc = normalizePlanDoc(input, { now: this.now() });
    doc.id = scopeId;
    doc.teamId = scopeId;
    doc.settings.agentAutonomy = current.settings.agentAutonomy;
    this._writeAtomic(scopeId, doc);
    return doc;
  }

  // Apply one mutation op to a scope's board. `enforceAutonomy` gates agent
  // writes against the board's current level (the server-side defense line);
  // pass false for a human console write (already role-gated by the proxy).
  // Returns { ok, doc } or { ok:false, code, reason } on an autonomy refusal.
  mutate(scopeId, op, { enforceAutonomy = false } = {}) {
    assertScope(scopeId);
    const current = this.load(scopeId);
    if (enforceAutonomy) {
      const need = requiredAutonomy(op && op.type);
      const level = current.settings.agentAutonomy;
      if (level < need) {
        return {
          ok: false,
          code: 'autonomy-forbidden',
          reason: `agent autonomy is ${level}; "${op && op.type}" needs level ${need}`,
        };
      }
    }
    const next = applyMutation(current, op, { now: this.now() });
    this._writeAtomic(scopeId, next);
    return { ok: true, doc: next };
  }

  // Teardown reaps a scope's documents when its grant is revoked / its team is
  // deleted. The SDK guarantees this runs while the token is still valid, before
  // the orchestrator invalidates it (§4.9 teardown ordering). Best-effort +
  // idempotent. Returns the number of documents removed.
  teardown(scopeId) {
    assertScope(scopeId);
    try {
      fs.unlinkSync(this._pathFor(scopeId));
      return 1;
    } catch (err) {
      if (err && err.code === 'ENOENT') return 0;
      throw err;
    }
  }

  // How many documents this scope owns — the count the broker feeds to the SDK's
  // quotaExceeded() (per-scope maxObjects, §4.6). One board per team today, so 0
  // or 1; kept general for when a scope can hold several.
  count(scopeId) {
    assertScope(scopeId);
    return fs.existsSync(this._pathFor(scopeId)) ? 1 : 0;
  }
}

module.exports = { PlanStore, SCOPE_RE, assertScope };
