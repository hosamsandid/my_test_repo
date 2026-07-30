'use strict';

// Model-Provider provenance for the session log (#980).
//
// At spawn time the orchestrator injects a small, NON-SECRET block of
// `AEE_LLM_*` env vars describing how the run is executed: the provider display
// name, its auth type, the (sanitized) endpoint base URL, and the requested
// model. The agent runtime reads these back and stamps them onto the immutable
// `system_init` row of the session log, so a historical session stays
// transparent and auditable even after the endpoint is renamed, re-keyed or
// deleted. This module is the single, pure assembler for that block; it is
// unit-tested in isolation and called from startAgentProcess.
//
// AC8 — this block NEVER carries credential material: no auth token, no
// `authTokenId`, and `baseUrl` is written without userinfo and without a query
// string.

// Strip userinfo (`user:pass@`) and any query/fragment from a base URL so a
// credential embedded in the endpoint URL can never reach the log. Returns ''
// for a falsy/garbage input. Falls back to a manual strip when the value isn't
// a parseable absolute URL.
function sanitizeBaseUrl(raw) {
  if (!raw || typeof raw !== 'string') return '';
  try {
    const u = new URL(raw);
    u.username = '';
    u.password = '';
    u.search = '';
    u.hash = '';
    return u.toString();
  } catch {
    return raw
      .split('#')[0]
      .split('?')[0]
      .replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/]*@/i, '$1');
  }
}

// Assemble the AEE_LLM_* provenance env block for one agent container.
//
//   llm     — the resolved binding from resolveLlmBindingForAgent (or null when
//             no provider is bound / it can't be resolved).
//   config  — the agent config; `modelOverride` wins over the binding's
//             defaultModelId for the requested model, mirroring startAgentProcess.
//   endpointConfigured — true when the env or the agent DID reference an
//             endpoint id (so an unresolvable binding is distinguishable from
//             "no provider configured at all"; AC5).
//
// `AEE_LLM_BINDING` is ALWAYS present on a provisioned agent — it is the
// discriminator the runtime uses to tell a genuine `.env` fallback ("env-fallback")
// from a legacy pre-#980 session row (no provenance at all):
//   'bound'        — a provider resolved; name/auth/baseUrl/model follow.
//   'missing'      — an endpoint was configured but could not be resolved.
//   'env-fallback' — no provider configured; the inherited ANTHROPIC_* from .env run.
function buildLlmProvenanceEnv(llm, config, { endpointConfigured = false } = {}) {
  const requestedModel =
    (config && config.modelOverride) || (llm && llm.defaultModelId) || '';

  const out = {};
  if (llm) {
    out.AEE_LLM_BINDING = 'bound';
    out.AEE_LLM_PROVIDER_ID = llm.endpointId || '';
    out.AEE_LLM_PROVIDER_NAME = llm.name || llm.endpointId || '';
    out.AEE_LLM_AUTH_TYPE = llm.authType === 'oauth-token' ? 'oauth-token' : 'api-key';
    // An oauth-token (subscription) binding talks to api.anthropic.com directly
    // — the orchestrator strips ANTHROPIC_BASE_URL — so there is no proxy base
    // URL to record. api-key bindings record the sanitized endpoint.
    if (llm.authType !== 'oauth-token') {
      const base = sanitizeBaseUrl(llm.baseUrl);
      if (base) out.AEE_LLM_BASE_URL = base;
    }
  } else if (endpointConfigured) {
    out.AEE_LLM_BINDING = 'missing';
  } else {
    out.AEE_LLM_BINDING = 'env-fallback';
  }

  if (requestedModel) out.AEE_LLM_REQUESTED_MODEL = requestedModel;
  return out;
}

module.exports = { buildLlmProvenanceEnv, sanitizeBaseUrl };
