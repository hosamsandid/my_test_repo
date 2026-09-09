'use strict';

// Pure builder for GET /api/assist/model-options (#1210) — the server foundation
// for the global assist model selector (concept: docs/assist-model-selection-
// concept.md §4.2). Kept out of the api.js route so the selection-visibility +
// masking logic is unit-testable without a server harness (mirrors the pattern
// of process-template.js / port-suggestion.js). The route is a thin wrapper:
// getScope(req) → buildAssistModelOptions(scope, listLlmEndpoints(), …) → res.json.

const { assistSelectableEndpoint } = require('./scope');

// Mask an endpoint down to exactly what the assist selector needs. Deliberately
// narrow: never authTokenId or token material, and no baseUrl internals — only
// what the picker renders (id, name, scope, model catalog, default model).
function maskAssistProvider(ep) {
  const scope = ep.scope === 'system' ? 'system' : 'team';
  const models = Array.isArray(ep.models) ? ep.models : [];
  return {
    id: ep.id,
    name: ep.name || ep.id,
    scope,
    // #2136: a global provider is badged in the assist selector like the chat
    // picker; access is what the flag opens, not any secret.
    global: ep.global === true,
    models,
    defaultModelId: ep.defaultModelId || models[0]?.id || null,
  };
}

// Build the options payload for a session:
//   providers          — endpoints the caller may select, filtered by
//                         assistSelectableEndpoint, masked.
//   envFallbackActive  — true ONLY when zero providers are registered
//                         platform-wide AND ANTHROPIC_BASE_URL is set. This is
//                         the bootstrap case (§4.4): the selector then renders a
//                         read-only "Built-in (.env)" chip instead of a picker.
//                         Note the count is over ALL registered endpoints, not
//                         just the caller-visible ones — a user who simply can't
//                         see any provider is NOT in the env-fallback state.
//   exclusionHint      — null when providers is non-empty or envFallbackActive or
//                         no providers are registered. When providers is empty AND
//                         providers ARE registered, indicates WHY:
//                         'all-oauth-token' — every registered provider uses
//                           oauth-token authType (absolute exclusion, no user
//                           action can unlock them).
//                         'no-team-overlap' — non-oauth providers exist but none
//                           overlap the caller's team membership.
function buildAssistModelOptions(scope, endpoints = [], { envBaseUrl = '' } = {}) {
  const list = Array.isArray(endpoints) ? endpoints : [];
  const providers = list
    .filter(ep => assistSelectableEndpoint(scope, ep))
    .map(maskAssistProvider);
  const envFallbackActive = list.length === 0 && Boolean(String(envBaseUrl || '').trim());

  let exclusionHint = null;
  if (providers.length === 0 && !envFallbackActive && list.length > 0) {
    const nonOauth = list.filter(ep => ep.authType !== 'oauth-token');
    exclusionHint = nonOauth.length === 0 ? 'all-oauth-token' : 'no-team-overlap';
  }

  return { providers, envFallbackActive, exclusionHint };
}

module.exports = { buildAssistModelOptions, maskAssistProvider };
