'use strict';

// Pure decision core for the Environment Template catalog (#2170, epic #2166
// A4). Replaces the environment-side "global" live-sharing mechanism
// (`global-resource.js` / #2158) with a COPY mechanism: a template is a
// curated environment marked `isTemplate: true` that a team may copy its
// structure from at creation — never a live-shared binding an agent or team
// can be pointed at directly. Model Providers keep #2136's live-global
// behaviour untouched; MCP servers keep their own independent `global`
// toggle (#2158) untouched — this module and its `isTemplate` flag apply to
// Working Environments only.
//
// Mirrors the shape of `resolveGlobalFlag`/`isGlobalEnvironment` in
// `global-resource.js` (same publish-gate discipline: only a System Admin may
// flip the flag, omitting it from a body keeps the current value, only a
// literal boolean `true` publishes) so the two read as one family even though
// they now mean different things — "reachable by every team" vs "a copy
// source no team is ever live-bound to".

// Is `entry` a template right now? Re-reads the flag on every call rather than
// caching a decision elsewhere, matching `isGlobalEnvironment`'s discipline. A
// legacy `global: true` environment (the pre-#2170 live-shared mechanism) is
// also treated as a template on READ — the "global becomes copyable
// templates" migration: the pool of environments an operator had already
// curated as shareable is exactly the pool that becomes the template catalog,
// with no separate migration script. Any SAVE through this feature persists
// `isTemplate` explicitly, so the legacy field is read-compatibility only.
function isTemplateEnvironment(entry) {
  if (!entry) return false;
  if (entry.isTemplate === true) return true;
  return entry.global === true && entry.scope === 'system';
}

// Publish/retract gate for the `isTemplate` flag — System-Admin-only, exactly
// like `resolveGlobalFlag`. Returns `{ isTemplate }` with the resolved value
// to persist, or `{ error, status, code }` to refuse.
function resolveTemplateFlag({ wantTemplate, currentTemplate = false, scopeAll } = {}) {
  const cur = currentTemplate === true;
  if (wantTemplate === undefined || wantTemplate === null) {
    return { isTemplate: cur };
  }
  const want = wantTemplate === true;
  if (want === cur) return { isTemplate: cur };
  if (!scopeAll) {
    return {
      error: 'Only a System Admin may create or retire an environment template',
      status: 403,
      code: 'template-system-admin-only',
    };
  }
  return { isTemplate: want };
}

// The structure a template hands a new environment at team-creation time —
// repositories, MCP server pairings, model provider, toolchain and additional
// context. Deliberately DROPS every credential reference (`sshKeyId` on each
// repository, `credentialId` on each MCP pairing): a template is a copy
// source, never a live-shared binding, so the team that copies it must supply
// its own credentials rather than inherit the curator's. Mirrors the "copies
// its structure, prompts for credentials" rule #2171 (A5, team clone) states
// for its own copy mechanism — the same rule, applied here to templates.
function copyEnvironmentStructure(template) {
  const repositories = Array.isArray(template?.repositories)
    ? template.repositories
      .filter(r => r && typeof r.url === 'string' && r.url.trim())
      .map(r => ({
        url: r.url.trim(),
        branch: typeof r.branch === 'string' && r.branch.trim() ? r.branch.trim() : null,
        sshKeyId: null,
        readOnly: r.readOnly === true,
      }))
    : [];
  const mcpServers = Array.isArray(template?.mcpServers)
    ? template.mcpServers
      .filter(m => m && typeof m.serverId === 'string' && m.serverId.trim())
      .map(m => ({ serverId: m.serverId.trim(), credentialId: null }))
    : [];
  return {
    repositories,
    mcpServers,
    llmEndpointId: template?.llmEndpointId || null,
    defaultModelId: template?.defaultModelId || null,
    toolchainId: template?.toolchainId || null,
    additionalContext: typeof template?.additionalContext === 'string' ? template.additionalContext : '',
  };
}

module.exports = { isTemplateEnvironment, resolveTemplateFlag, copyEnvironmentStructure };
