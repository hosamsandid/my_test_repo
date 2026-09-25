'use strict';

// ─── generic per-scope plugin credential wiring (Jira plan §5, D1) ───────────
//
// The live half of the credential store: which team scopes a plugin is granted
// to, the per-plugin push to the broker, and the three internal HTTP routes.
// Kept in its own module (deps injected) so it adds ~6 lines to orchestrator.js
// rather than ~120 — the same pattern plugin-github-creds.js follows for the
// pure resolution core.
//
// A plugin is in exactly one credential path: `github-issues` declares
// `credentials: []` and keeps its bespoke `pushGithubIssueScopeCredentials`;
// every other installed plugin that declares `credentials[]` (jira) is handled
// here by walking `installedManifests()`.

// `deps`:
//   listAgentIds()                     → string[]
//   loadAgentConfig(id)                → config | null
//   pluginRegistry                     → { installedManifests, readPluginManifest }
//   pluginRuntime                      → { pushScopeCredentials }
//   effectivePlugins(cfg, loadCfg)     → grant list
//   pluginGrantFor(grants, pluginId)   → grant | null
//   resolveScopeId(cfg, granularity)   → scopeId | null
//   credentialStore                    → PluginCredentialStore
//   log(msg)                           → optional
function createPluginCredentialWiring(deps) {
  const {
    listAgentIds, loadAgentConfig, pluginRegistry, pluginRuntime,
    effectivePlugins, pluginGrantFor, resolveScopeId, credentialStore,
    log = () => {},
  } = deps;

  // The team scope ids a plugin is granted to (team granularity → scopeId is the
  // team-agent id). Shared by the push and the routes so "which teams may hold a
  // credential for this plugin" has one answer.
  function grantedTeamScopeIds(pluginId) {
    const scopeIds = new Set();
    let ids = [];
    try { ids = listAgentIds(); } catch { ids = []; }
    for (const id of ids) {
      let cfg = null;
      try { cfg = loadAgentConfig(id); } catch { cfg = null; } // malformed config.json → skip, never 500
      if (!cfg || !cfg.token) continue; // a stub has no running surface
      let grant = null;
      try { grant = pluginGrantFor(effectivePlugins(cfg, loadAgentConfig), pluginId); } catch { grant = null; }
      if (!grant) continue;
      const scopeId = resolveScopeId(cfg, grant.scopeGranularity);
      if (scopeId) scopeIds.add(scopeId);
    }
    return [...scopeIds];
  }

  // Push each installed credential-declaring plugin's per-scope credential map to
  // its broker. Best-effort; never throws.
  async function pushDeclaredScopeCredentials(onlyPluginId = null) {
    let installed;
    try { installed = pluginRegistry.installedManifests(); } catch { return; }
    for (const [pluginId, manifest] of Object.entries(installed || {})) {
      if (onlyPluginId && pluginId !== onlyPluginId) continue;
      if (pluginId === 'github-issues') continue; // bespoke path
      if (!manifest || !Array.isArray(manifest.credentials) || manifest.credentials.length === 0) continue;
      try {
        const scopeIds = grantedTeamScopeIds(pluginId);
        // Every granted scope gets an entry (empty when unconfigured) so the
        // broker can tell "granted, awaiting credential" from "unknown scope"; a
        // fully-revoked plugin still gets an empty push to clear stale scopes.
        const scopes = credentialStore.resolveScopeCredentialMap(pluginId, scopeIds);
        await pluginRuntime.pushScopeCredentials(manifest, scopes);
      } catch (err) {
        log(`[Orchestrator] ${pluginId} credential push failed: ${err.message}`);
      }
    }
  }

  // Handle GET/PUT/DELETE /internal/plugins/:id/credentials[/:scopeId].
  // `sendJson(res, status, obj)` and `readBody(req)` (→ parsed object, rejects on
  // bad JSON) are injected (orchestrator internals). Returns true if it handled
  // the request, false to fall through.
  async function handleCredentialRoute(req, res, { sendJson, readBody }) {
    const m = (req.url || '').split('?')[0]
      .match(/^\/internal\/plugins\/([^/]+)\/credentials(?:\/([^/]+))?$/);
    if (!m) return false;
    const pluginId = decodeURIComponent(m[1]);
    const scopeId = m[2] ? decodeURIComponent(m[2]) : null;

    const entry = pluginRegistry.readPluginManifest(pluginId);
    if (!entry.ok || !entry.manifest) {
      sendJson(res, 404, { error: `Plugin '${pluginId}' is not installed or its manifest is invalid` });
      return true;
    }
    const declared = Array.isArray(entry.manifest.credentials) ? entry.manifest.credentials : [];
    if (declared.length === 0) {
      sendJson(res, 400, { error: `Plugin '${pluginId}' declares no credentials` });
      return true;
    }
    const grantedScopes = grantedTeamScopeIds(pluginId);
    const teamName = (sid) => {
      const c = loadAgentConfig(sid);
      return (c && (c.displayName || c.name)) || sid;
    };

    if (req.method === 'GET' && !scopeId) {
      sendJson(res, 200, {
        pluginId,
        credentials: declared.map((c) => ({ key: c.key, required: c.required === true, description: c.description || null, secret: c.secret !== false })),
        scopes: grantedScopes.map((sid) => ({
          scopeId: sid, teamName: teamName(sid),
          ...credentialStore.meta(pluginId, sid, declared),
        })),
      });
      return true;
    }

    if ((req.method === 'PUT' || req.method === 'DELETE') && scopeId) {
      if (!grantedScopes.includes(scopeId)) {
        sendJson(res, 409, { error: `Plugin '${pluginId}' is not granted to scope '${scopeId}'` });
        return true;
      }
      try {
        if (req.method === 'DELETE') {
          credentialStore.delete(pluginId, scopeId);
          await pushDeclaredScopeCredentials(pluginId);
          sendJson(res, 200, { ok: true, pluginId, scopeId, ...credentialStore.meta(pluginId, scopeId, declared) });
          return true;
        }
        let payload;
        try { payload = await readBody(req); } catch {
          sendJson(res, 400, { error: 'Invalid JSON body' });
          return true;
        }
        const r = credentialStore.write(pluginId, scopeId, payload && payload.values, declared, { setBy: payload && payload.setBy });
        if (!r.ok) { sendJson(res, 400, { error: r.errors.join('; '), errors: r.errors }); return true; }
        await pushDeclaredScopeCredentials(pluginId);
        sendJson(res, 200, { ok: true, pluginId, scopeId, ...r.meta });
        return true;
      } catch (err) {
        sendJson(res, 500, { error: err.message });
        return true;
      }
    }

    sendJson(res, 404, { error: 'not found' });
    return true;
  }

  return { grantedTeamScopeIds, pushDeclaredScopeCredentials, handleCredentialRoute };
}

module.exports = { createPluginCredentialWiring };
