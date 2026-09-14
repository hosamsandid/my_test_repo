// Pure label builder for a provider <option> in the Model provider select (#2255).
//
// TeamEnvironmentPanel.jsx and EnvironmentTemplates.jsx both rendered the same
// `{ep.name} ({ep.baseUrl})` expression. An oauth-token (subscription seat)
// provider is stored with baseUrl: '' by design — the orchestrator talks to
// Anthropic directly and strips ANTHROPIC_BASE_URL for that auth type (see
// CLAUDE.md "Model Provider auth types") — so that expression rendered a bare
// empty bracket pair, e.g. "Claude Enterprise ()".
//
// Fix: when baseUrl is absent, fall back to the auth type in the same bracket
// position instead of leaving it blank. The two auth-type strings reuse the
// vocabulary already shown elsewhere (chat-model-selector.js authTypeLabel,
// system-init.js authTypeLabel) — 'Subscription' / 'API key' — but not that
// helper's null-authType branch ('Default (.env)'), which describes a
// different concept (no endpoint bound at all, i.e. the separate
// "— inherit from .env —" option). A stored provider record with no authType
// is a legacy api-key record, so it reads as 'API key' here.
export function providerOptionDetail(ep) {
  if (ep && ep.baseUrl) return ep.baseUrl;
  return ep && ep.authType === 'oauth-token' ? 'Subscription' : 'API key';
}

export function providerOptionLabel(ep) {
  const name = (ep && (ep.name || ep.id)) || '';
  return `${name} (${providerOptionDetail(ep)})`;
}
