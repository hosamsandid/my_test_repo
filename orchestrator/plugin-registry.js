'use strict';

// ─── plugin registry reader (plugin system Phase 7, #1547) ───────────────────
//
// The operator registry is `/workspace/plugins/<id>/` — `plugin.json` plus the
// CLI script(s) under `bin/` (docs/plugin-system-concept.md §4.1). A plugin is
// INSTALLED iff its directory is present here; installing grants nothing to any
// agent, it only makes the plugin available to grant and starts its sidecar.
//
// The admin-console owns the install move (`/pool/plugins/<id>` → here, the
// same two-volume copy as skill promote-to-global) and validates before
// writing. This module is the ORCHESTRATOR's read side, and it re-validates:
// a registry directory can also be placed by hand, and the sidecar path is the
// one that hands out privileges, so it never trusts an unvalidated manifest.
//
// Everything here is fs-over-an-injectable-base-dir, so it unit-tests against a
// tmpdir without a container runtime — the discipline the pure planners
// (plugin-sidecar.js, plugin-sync.js) set for the decidable half.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { validatePluginManifest } = require('./plugin-manifest');
const { defaultGranularity } = require('./plugin-manifest');

const REGISTRY_DIR = process.env.PLUGIN_REGISTRY_DIR || '/workspace/plugins';
const POOL_PLUGINS_DIR = process.env.POOL_PLUGINS_DIR || '/template-workspace/plugins';
const MANIFEST_FILE = 'plugin.json';

// Signing secret for every plugin's scope tokens. One secret serves all plugins
// — cross-plugin reuse is precluded by the pluginId inside the token payload
// (plugin-scope-token.js) — and it lives beside the registry it belongs to,
// mode 0600, the `_keys/` convention used by environments and mcp-credentials.
const SECRET_FILE = '_secret';
const SECRET_MODE = 0o600;

// Entries starting with `_` are platform state (the signing secret), never a
// plugin id — the validator's ID_RE would reject them anyway, but skipping them
// keeps "unreadable plugin" errors honest.
function isPluginDirName(name) {
  return typeof name === 'string' && name.length > 0 && !name.startsWith('_') && !name.startsWith('.');
}

// Installed plugin ids, sorted. A missing registry dir is an empty registry,
// not an error — the stack boots fine with no plugin installed.
function listPluginIds(dir = REGISTRY_DIR) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && isPluginDirName(e.name))
    .map((e) => e.name)
    .sort();
}

// Read + validate one plugin's manifest.
// Returns { id, ok, errors, manifest, dir } — never throws.
function readPluginManifest(id, dir = REGISTRY_DIR) {
  // A registry id is a single directory name. Callers validate (listing via
  // isPluginDirName, HTTP routes via PLUGIN_ID_RE), but re-check here with
  // `path.basename` — the sanitizer CodeQL js/path-injection recognises at the
  // join site — so a `../x` or `a/b` id never names a path outside the registry.
  if (!isPluginDirName(id) || path.basename(id) !== id) {
    return { id, ok: false, errors: ['invalid plugin id'], manifest: null, dir: null };
  }
  const pluginDir = path.join(dir, path.basename(id));
  const manifestPath = path.join(pluginDir, MANIFEST_FILE);
  let raw;
  try {
    raw = fs.readFileSync(manifestPath, 'utf8');
  } catch (err) {
    return { id, ok: false, errors: [`cannot read ${MANIFEST_FILE}: ${err.message}`], manifest: null, dir: pluginDir };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { id, ok: false, errors: [`invalid JSON in ${MANIFEST_FILE}: ${err.message}`], manifest: null, dir: pluginDir };
  }
  const result = validatePluginManifest(parsed);
  // The directory name is the id the platform keys everything on (container
  // name, grant entries, token payload). A manifest claiming a different id
  // would silently split that identity, so it is refused rather than adopted.
  if (result.ok && result.manifest.id !== id) {
    return {
      id,
      ok: false,
      errors: [`manifest id "${result.manifest.id}" does not match registry directory "${id}"`],
      manifest: null,
      dir: pluginDir,
    };
  }
  return { id, ok: result.ok, errors: result.errors, manifest: result.manifest, dir: pluginDir };
}

// Every installed plugin, valid or not — the install/registry UI needs to show
// a broken one WITH its errors rather than hide it.
function listPlugins(dir = REGISTRY_DIR) {
  return listPluginIds(dir).map((id) => readPluginManifest(id, dir));
}

// { <id>: manifest } for the VALID installed plugins only — what the sidecar,
// seed and prompt paths consume. An invalid manifest is simply not installed as
// far as those paths are concerned (fail-closed: no sidecar, no privileges).
function installedManifests(dir = REGISTRY_DIR) {
  const out = {};
  for (const entry of listPlugins(dir)) {
    if (entry.ok) out[entry.id] = entry.manifest;
  }
  return out;
}

// Absolute path of a plugin's CLI facade in the registry. The manifest's
// `cli.entrypoint` is validated registry-relative (no "..", not absolute), and
// the resolved path is re-checked to stay under the plugin's own directory —
// the containment discipline of context-browse.js, applied to a file the
// orchestrator is about to copy into an agent workspace.
function cliEntrypointPath(manifest, dir = REGISTRY_DIR) {
  if (!manifest || !manifest.cli || !manifest.cli.entrypoint) return null;
  const pluginDir = path.resolve(dir, manifest.id);
  const resolved = path.resolve(pluginDir, manifest.cli.entrypoint);
  if (resolved !== pluginDir && !resolved.startsWith(pluginDir + path.sep)) return null;
  return resolved;
}

// The display data plugin-prompt.js expects for one granted plugin. Built from
// the manifest + the grant's granularity — never from the agent's config file
// contents (§4.7).
function promptDisplayFor(manifest, scopeGranularity) {
  if (!manifest) return null;
  const entry = {
    id: manifest.id,
    name: manifest.name,
    cliName: manifest.cli && manifest.cli.name,
    scopeGranularity: scopeGranularity || defaultGranularity(manifest),
  };
  if (manifest.promptLine) entry.promptLine = manifest.promptLine;
  return entry;
}

// Read the shared signing secret, generating it on first use. Mode 0600 on
// create AND re-asserted on read, so a secret restored from a loose backup does
// not stay world-readable.
function readOrCreateSigningSecret(dir = REGISTRY_DIR) {
  const file = path.join(dir, SECRET_FILE);
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing) {
      try { fs.chmodSync(file, SECRET_MODE); } catch { /* best effort */ }
      return existing;
    }
  } catch { /* fall through to create */ }
  const secret = crypto.randomBytes(32).toString('base64url');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, `${secret}\n`, { mode: SECRET_MODE });
  try { fs.chmodSync(file, SECRET_MODE); } catch { /* best effort */ }
  return secret;
}

module.exports = {
  REGISTRY_DIR,
  POOL_PLUGINS_DIR,
  MANIFEST_FILE,
  SECRET_FILE,
  SECRET_MODE,
  isPluginDirName,
  listPluginIds,
  readPluginManifest,
  listPlugins,
  installedManifests,
  cliEntrypointPath,
  promptDisplayFor,
  readOrCreateSigningSecret,
};
