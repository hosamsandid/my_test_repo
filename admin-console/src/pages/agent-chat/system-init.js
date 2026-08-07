// Pure view-model for the `system_init` session-log row (#980).
//
// Turns a persisted `system_init` event into the small shape LogEvent renders:
// a compact one-line label (collapsed state) plus a key/value detail list
// (expanded state). Kept as a pure, framework-free helper so it can be unit
// tested with `node --test` without rendering React.
//
// Contract with agent-entrypoint.py `_map_stream_json_line`:
//   event.model              — the EFFECTIVE model the CLI reported.
//   event.sessionId          — the Claude session id.
//   event.provenance         — present ONLY on rows written by the #980 runtime.
//     .binding      : 'bound' | 'missing' | 'env-fallback'
//     .providerName : provider display name (null on env-fallback/missing)
//     .authType     : 'api-key' | 'oauth-token' | null
//     .baseUrl      : sanitized endpoint URL (no userinfo/query) or null
//     .requestedModel : model the platform requested via --model, or null
//     .providerId   : opaque endpoint id or null
//
// AC6: a legacy row (no `provenance`) renders exactly as pre-#980 — model +
// session id only. We NEVER substitute the agent's current binding for it.

// Human label for an auth type — reused verbatim from the chat toolbar
// vocabulary (ChatPanel.jsx `authTypeLabel`) so the log and the switcher read
// identically. `null` (no endpoint) → the .env fallback.
export function authTypeLabel(authType) {
  if (!authType) return 'Default (.env)';
  return authType === 'oauth-token' ? 'Subscription' : 'API key';
}

export function buildSystemInitView(event) {
  const model = (event && event.model) || 'unknown';
  const sessionId = (event && event.sessionId) || null;
  const prov = event && event.provenance ? event.provenance : null;

  // Legacy pre-#980 row: no provenance was captured. Render as before and never
  // retrofit the agent's *current* provider (it very likely isn't what ran).
  if (!prov) {
    return {
      legacy: true,
      model,
      requestedModel: null,
      providerText: null,
      sessionId,
      detail: null,
    };
  }

  const requested = prov.requestedModel || null;
  // AC4: only surface the requested model when it differs from the effective
  // one — no redundant noise when they match.
  const requestedModel = requested && requested !== model ? requested : null;

  // AC3 / AC5: the compact provider label reuses the toolbar wording.
  //   bound + name  → "DB · API key"
  //   env-fallback  → "Default (.env)"
  //   missing       → distinct from env-fallback so the two states never blur.
  let providerText;
  if (prov.binding === 'missing') {
    providerText = 'Provider unresolved (.env)';
  } else if (prov.providerName) {
    providerText = `${prov.providerName} · ${authTypeLabel(prov.authType)}`;
  } else {
    providerText = authTypeLabel(prov.authType);
  }

  const providerName =
    prov.providerName ||
    (prov.binding === 'missing' ? 'Unresolved endpoint' : 'Default (.env)');

  const detail = [
    ['Provider', providerName],
    ['Auth', authTypeLabel(prov.authType)],
    ['Endpoint', prov.baseUrl || '—'],
    ['Requested model', requested || '—'],
    ['Effective model', model],
    ['Session', sessionId || '—'],
  ];

  return {
    legacy: false,
    model,
    requestedModel,
    providerText,
    sessionId,
    detail,
  };
}
