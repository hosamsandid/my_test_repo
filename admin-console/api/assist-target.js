'use strict';

// Pure decision logic for resolveAssistTarget (#1211) — the server-side
// enforcement of the global assist model selector (concept: docs/assist-model-
// selection-concept.md §4.5). Kept out of the api.js route body so the
// selection/permission logic is unit-testable without a server harness (mirrors
// assist-model-options.js / process-template.js): the api.js wrapper only adds
// the impure bits (getScope, listLlmEndpoints, reading the token off disk,
// the .env fallback material).
//
// The selection the client sends (X-Assist-Model header, or the legacy
// body.llmEndpointId) is a convenience — this module is the authority. A caller
// can never bill an assist call against a provider its teams may not use.

const { assistSelectableEndpoint } = require('./scope');

// Parse the client's selection off the request. Preferred transport is the
// `X-Assist-Model: <endpointId>:<modelId>` header; the legacy `body.llmEndpointId`
// (no model) is still accepted for API compatibility. Split on the FIRST colon
// only — endpoint ids never contain one, model ids never do either, but this is
// robust regardless.
function parseAssistSelection(req) {
  const headers = (req && req.headers) || {};
  const raw = headers['x-assist-model'] || headers['X-Assist-Model'];
  if (typeof raw === 'string' && raw.trim()) {
    const s = raw.trim();
    const idx = s.indexOf(':');
    if (idx === -1) return { endpointId: s, modelId: '' };
    return { endpointId: s.slice(0, idx).trim(), modelId: s.slice(idx + 1).trim() };
  }
  const legacy = req && req.body && req.body.llmEndpointId;
  if (typeof legacy === 'string' && legacy.trim()) return { endpointId: legacy.trim(), modelId: '' };
  return { endpointId: '', modelId: '' };
}

// Resolve a caller's assist selection to a concrete decision. Pure: no I/O, no
// process.env — endpoints are passed in (already the raw index records) and the
// caller materialises token/.env from the returned marker.
//
// Returns exactly one of:
//   { selectionError: { status, code, error } }
//       — a 403 (endpoint not permitted / none permitted) or 400 (unselected
//         while selectable providers exist). Routes MUST surface this and never
//         mask it behind a heuristic fallback.
//   { error: '<message>' }
//       — a resolved-but-misconfigured provider (no base URL / no models). Same
//         shape resolveGenerationTarget used, so fallback routes keep treating
//         it as a soft failure and hard routes as a 400 — unchanged behaviour.
//   { env: true }
//       — no selection AND zero providers registered platform-wide: the
//         bootstrap case, caller fills the target from ANTHROPIC_* (§4.4/5).
//   { endpoint, endpointId, endpointName, baseUrl, model }
//       — a permitted provider + validated model; caller reads the token.
function resolveAssistSelection({ scope, endpoints = [], selection = {}, requireSelection = true } = {}) {
  const all = Array.isArray(endpoints) ? endpoints : [];
  const selectable = all.filter(ep => assistSelectableEndpoint(scope, ep));
  const endpointId = String(selection.endpointId || '').trim();
  const modelId = String(selection.modelId || '').trim();

  if (endpointId) {
    // Look the id up across ALL endpoints so a provider that exists but is
    // outside the caller's teams (or is an oauth-token seat) 403s rather than
    // silently resolving to something else. assistSelectableEndpoint is the gate.
    const ep = all.find(e => e && e.id === endpointId);
    if (!ep || !assistSelectableEndpoint(scope, ep)) {
      return { selectionError: {
        status: 403, code: 'assist-endpoint-not-permitted',
        error: 'That model provider is not available to your teams.',
      } };
    }
    const models = Array.isArray(ep.models) ? ep.models : [];
    // An explicit, valid model wins outright — the hardcoded sonnet-kind
    // preference is dropped when the caller names a model, and only survives as
    // the default-pick heuristic below.
    let model;
    if (modelId && models.some(m => m && m.id === modelId)) {
      model = modelId;
    } else {
      model = ep.defaultModelId
        || (models.find(m => m && m.kind === 'sonnet') || {}).id
        || (models[0] || {}).id
        || null;
    }
    if (!ep.baseUrl) return { error: `LLM endpoint '${ep.id}' has no base URL` };
    if (!model) return { error: `LLM endpoint '${ep.id}' has no models configured` };
    return {
      endpoint: ep, endpointId: ep.id, endpointName: ep.name || ep.id,
      baseUrl: ep.baseUrl, model,
    };
  }

  // No selection.
  if (all.length === 0) return { env: true }; // bootstrap install: .env fallback (§4.4)
  // A caller may opt out of forcing a pick (requireSelection:false) — it then
  // uses the neutral platform .env default, never a specific team's registered
  // key (so opting out can't silently bill someone else's provider). No route
  // opts out today; all nine Family-A routes require a selection.
  if (!requireSelection) return { env: true };
  if (selectable.length > 0) {
    // Providers the caller may bill against exist but none was chosen — do NOT
    // fall back to endpoints[0]; that silent default is the billing bug (§4.5.4).
    return { selectionError: {
      status: 400, code: 'assist-model-not-selected',
      error: 'Select an assist model in Settings → Model before running AI helpers.',
    } };
  }
  // Providers are registered but none is selectable for this caller — fail
  // closed rather than spend on a key the caller's teams may not use.
  return { selectionError: {
    status: 403, code: 'assist-endpoint-not-permitted',
    error: 'None of the registered model providers are available to your teams.',
  } };
}

module.exports = { parseAssistSelection, resolveAssistSelection };
