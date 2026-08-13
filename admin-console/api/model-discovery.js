// model-discovery.js — pure helpers for normalizing the model list returned by
// an endpoint's discovery probe (`GET /v1/models` / LiteLLM `/model/info`).
//
// #1717: besides id/displayName/kind, capture the provider-reported context
// window into a `contextWindow` field so the Agent-Chat header can show a real
// limit instead of a hardcoded 200K. Providers expose it under a few shapes:
//   - LiteLLM: `{ id, model_info: { max_input_tokens, ... } }`
//   - some proxies flatten it: `{ id, max_input_tokens }`
//   - OpenAI-ish alternatives: `context_window` / `context_length`
// We read the input window (what the fill indicator compares used-input tokens
// against), never the output cap. Nothing is guessed: a provider that reports
// no window yields a model with no `contextWindow`, and the UI omits the limit.

'use strict';

// Candidate field paths for the max input context window, in priority order.
// `max_input_tokens` (LiteLLM's own name for the input window) wins over the
// more ambiguous `max_tokens` / `context_length`.
function readContextWindow(entry) {
  if (!entry || typeof entry !== 'object') return undefined;
  const info = (entry.model_info && typeof entry.model_info === 'object') ? entry.model_info : {};
  const candidates = [
    info.max_input_tokens,
    entry.max_input_tokens,
    info.context_window,
    entry.context_window,
    info.context_length,
    entry.context_length,
  ];
  for (const c of candidates) {
    const n = typeof c === 'number' ? c : (typeof c === 'string' && c.trim() !== '' ? Number(c) : NaN);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return undefined;
}

function kindForId(id) {
  const lower = String(id).toLowerCase();
  if (lower.includes('opus')) return 'opus';
  if (lower.includes('sonnet')) return 'sonnet';
  if (lower.includes('haiku')) return 'haiku';
  return undefined;
}

// Map one raw discovery entry (string id or object) to our normalized shape, or
// null when it carries no usable id.
function normalizeDiscoveredModel(entry) {
  const id = typeof entry === 'string' ? entry : entry?.id;
  if (!id || typeof id !== 'string') return null;
  const kind = kindForId(id);
  const contextWindow = readContextWindow(entry);
  return {
    id,
    displayName: id,
    ...(kind ? { kind } : {}),
    ...(contextWindow ? { contextWindow } : {}),
  };
}

// Normalize a raw discovery body's model array (already unwrapped from
// `{ data: [...] }` / bare array by the caller) into our model list.
function normalizeDiscoveredModels(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeDiscoveredModel).filter(Boolean);
}

module.exports = { readContextWindow, normalizeDiscoveredModel, normalizeDiscoveredModels };
