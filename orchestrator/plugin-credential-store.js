'use strict';

// ─── generic per-scope plugin credential store (Jira plan §5, D1) ────────────
//
// The manifest's `credentials: [{ key, description?, required? }]` field was
// validated-then-ignored: nothing provisioned it. This is the store that makes
// it real — one credential document per (pluginId, scopeId) on
// `/workspace/plugins/_credentials/<pluginId>/<scopeId>.json` (mode 0600),
// following the `_`-prefixed platform-state convention `plugin-registry.js`
// already uses for `_secret` (and environments/mcp-credentials use for `_keys`).
//
// A scopeId is a plugin-scope token subject — for `scopes: ["team"]` plugins
// (jira) that is a team id, so there is one credential document per team the
// plugin is granted to. A **Team Admin** sets their own team's values (D2); the
// document records who set it and when, because a vendor API token carries that
// named human's permissions.
//
// Raw values are NEVER returned to a caller after they are written — only a
// per-key `{ set, preview }` and the `setBy`/`setAt` metadata (the same
// fingerprint-only discipline as SSH keys / GitHub tokens). The one place the
// raw values leave this module is `resolveScopeCredentialMap`, which the
// orchestrator uses to push them straight to the broker sidecar server-side.
//
// Pure decisions (key validation, metadata shaping, preview) are separate from
// the fs adapter so they unit-test in isolation.

const fs = require('fs');
const path = require('path');

const DEFAULT_DIR = process.env.PLUGIN_CREDENTIALS_DIR
  || path.join(process.env.PLUGIN_REGISTRY_DIR || '/workspace/plugins', '_credentials');

// pluginId: the registry slug (validator ID_RE). scopeId: a token subject.
const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const SCOPE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function assertIds(pluginId, scopeId) {
  if (!PLUGIN_ID_RE.test(String(pluginId || ''))) throw new Error(`invalid pluginId: ${String(pluginId)}`);
  if (scopeId !== undefined && !SCOPE_ID_RE.test(String(scopeId || ''))) throw new Error(`invalid scopeId: ${String(scopeId)}`);
}

// ── pure: shape a submitted values object against a manifest's credentials ────
// `manifestCredentials` is `[{ key, required? }]`. Returns { ok, errors, set,
// clear }:
//   • set   — trimmed non-blank values for declared keys (what to store)
//   • clear — declared keys explicitly submitted blank (what to remove)
//   • errors — TYPE violations only (a non-string value). A missing required
//     key is NOT an error — the store keeps an incomplete credential and the
//     broker simply gets no usable value until it is completed. Completeness is
//     surfaced by `credentialMeta().complete` for the UI to warn on.
// Unknown keys are silently dropped.
function shapeCredentialValues(manifestCredentials, submitted) {
  const declared = new Set(
    (Array.isArray(manifestCredentials) ? manifestCredentials : [])
      .map((c) => (c && typeof c.key === 'string' ? c.key : null))
      .filter(Boolean),
  );
  const errors = [];
  const set = {};
  const clear = [];
  const src = submitted && typeof submitted === 'object' ? submitted : {};
  for (const [k, v] of Object.entries(src)) {
    if (!declared.has(k)) continue;
    if (typeof v !== 'string') { errors.push(`${k} must be a string`); continue; }
    const trimmed = v.trim();
    if (trimmed) set[k] = trimmed;
    else clear.push(k);
  }
  return { ok: errors.length === 0, errors, set, clear };
}

// pure: a non-reversible preview of a stored value — enough to recognise "is
// this the token I think it is" without disclosing it. Short values are fully
// masked.
function previewValue(v) {
  const s = String(v == null ? '' : v);
  if (s.length <= 8) return '••••';
  return `${s.slice(0, 2)}…${s.slice(-4)}`;
}

// pure: the caller-facing metadata for one stored document (never raw values).
function credentialMeta(entry, manifestCredentials) {
  const declared = (Array.isArray(manifestCredentials) ? manifestCredentials : [])
    .filter((c) => c && typeof c.key === 'string');
  const stored = (entry && entry.values && typeof entry.values === 'object') ? entry.values : {};
  const keys = {};
  for (const c of declared) {
    const v = stored[c.key];
    keys[c.key] = {
      set: typeof v === 'string' && v.length > 0,
      required: c.required === true,
      description: typeof c.description === 'string' ? c.description : undefined,
      preview: typeof v === 'string' && v.length > 0 ? previewValue(v) : null,
    };
  }
  const requiredKeys = declared.filter((c) => c.required === true).map((c) => c.key);
  const missingRequired = requiredKeys.filter((k) => !keys[k] || !keys[k].set);
  return {
    keys,
    complete: missingRequired.length === 0,
    missingRequired,
    setBy: (entry && entry.setBy) || null,
    setAt: (entry && entry.setAt) || null,
  };
}

// ── fs adapter ──────────────────────────────────────────────────────────────
class PluginCredentialStore {
  constructor({ dir = DEFAULT_DIR, now = () => new Date().toISOString() } = {}) {
    this.dir = dir;
    this.now = now;
  }

  _path(pluginId, scopeId) {
    assertIds(pluginId, scopeId);
    return path.join(this.dir, pluginId, `${scopeId}.json`);
  }

  // Raw stored document `{ values, setBy, setAt }` or null. INTERNAL — a route
  // must return credentialMeta(), never this.
  read(pluginId, scopeId) {
    let raw;
    try {
      raw = fs.readFileSync(this._path(pluginId, scopeId), 'utf8');
    } catch (err) {
      if (err && err.code === 'ENOENT') return null;
      throw err;
    }
    try {
      const parsed = JSON.parse(raw);
      return {
        values: parsed && typeof parsed.values === 'object' && parsed.values ? parsed.values : {},
        setBy: parsed && parsed.setBy ? String(parsed.setBy) : null,
        setAt: parsed && parsed.setAt ? String(parsed.setAt) : null,
      };
    } catch {
      return { values: {}, setBy: null, setAt: null };
    }
  }

  meta(pluginId, scopeId, manifestCredentials) {
    return credentialMeta(this.read(pluginId, scopeId), manifestCredentials);
  }

  // Merge `submitted` into the stored values, stamp setBy/setAt, write 0600.
  // An incomplete result is still written (see `shapeCredentialValues`); the
  // returned `meta.complete` tells the UI whether every required key is set.
  // Returns { ok, errors, meta } — `ok:false` only for a TYPE violation.
  write(pluginId, scopeId, submitted, manifestCredentials, { setBy } = {}) {
    assertIds(pluginId, scopeId);
    const existing = this.read(pluginId, scopeId) || { values: {} };
    const { ok, errors, set, clear } = shapeCredentialValues(manifestCredentials, submitted);
    if (!ok) return { ok: false, errors, meta: credentialMeta(existing, manifestCredentials) };

    const merged = { ...(existing.values || {}) };
    for (const k of clear) delete merged[k];
    Object.assign(merged, set);

    const doc = { values: merged, setBy: setBy ? String(setBy) : (existing.setBy || null), setAt: this.now() };
    const file = this._path(pluginId, scopeId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
    try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
    return { ok: true, errors: [], meta: credentialMeta(doc, manifestCredentials) };
  }

  delete(pluginId, scopeId) {
    assertIds(pluginId, scopeId);
    try {
      fs.unlinkSync(this._path(pluginId, scopeId));
      return true;
    } catch (err) {
      if (err && err.code === 'ENOENT') return false;
      throw err;
    }
  }

  // The raw `{ scopeId: values }` map for a set of scope ids — the ONLY raw-value
  // exit, used by the orchestrator to push straight to the broker. Every scope
  // id gets an entry (empty object when unset) so the broker can tell "granted
  // but not configured" from "unknown scope".
  resolveScopeCredentialMap(pluginId, scopeIds) {
    assertIds(pluginId);
    const out = {};
    for (const scopeId of Array.isArray(scopeIds) ? scopeIds : []) {
      if (!SCOPE_ID_RE.test(String(scopeId || ''))) continue;
      const entry = this.read(pluginId, scopeId);
      out[scopeId] = entry && entry.values ? { ...entry.values } : {};
    }
    return out;
  }

  // Reap every document for a plugin (uninstall) or one scope (grant revoke /
  // team delete). Best-effort, idempotent. Returns the count removed.
  teardownPlugin(pluginId) {
    assertIds(pluginId);
    let names;
    try { names = fs.readdirSync(path.join(this.dir, pluginId)); } catch { return 0; }
    let n = 0;
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      try { fs.unlinkSync(path.join(this.dir, pluginId, name)); n += 1; } catch { /* ignore */ }
    }
    try { fs.rmdirSync(path.join(this.dir, pluginId)); } catch { /* non-empty or gone */ }
    return n;
  }
}

module.exports = {
  PluginCredentialStore,
  shapeCredentialValues,
  credentialMeta,
  previewValue,
  PLUGIN_ID_RE,
  SCOPE_ID_RE,
  DEFAULT_DIR,
};
