// Pure decision helpers for the global assist model selector (#1212 — the
// console-side half of the assist-model-selection concept, §4.3–§4.5). Kept out
// of the React provider / Shell control so the validation, auto-select and
// header-encoding rules are unit-testable without a DOM (mirrors the pattern of
// flow-copilot-view.js / lint-view.js). The provider (ModelSelectionContext)
// and the transport glue (assist-transport.js) import these.

import { plainModelLabel } from '../components/model-selector-view.js';

// Per-user localStorage key — same per-user shape as `flows.lastSelected.<user>`
// (Briefings.jsx). The stored value is `{ endpointId, modelId }`.
export const STORAGE_PREFIX = 'assistModel';

export function storageKey(username) {
  return username ? `${STORAGE_PREFIX}.${username}` : null;
}

// The two server-side selection error codes (§4.5) the header control reacts to.
export const ASSIST_ERROR_FORBIDDEN = 'assist-endpoint-not-permitted';
export const ASSIST_ERROR_NOT_SELECTED = 'assist-model-not-selected';

export function isAssistSelectionErrorCode(code) {
  return code === ASSIST_ERROR_FORBIDDEN || code === ASSIST_ERROR_NOT_SELECTED;
}

// Pick the model to use for a provider when none (or a stale one) is chosen:
// the provider default, else its first model, else null (no usable model).
function providerDefaultModelId(provider) {
  if (!provider) return null;
  const models = Array.isArray(provider.models) ? provider.models : [];
  if (provider.defaultModelId && models.some(m => m.id === provider.defaultModelId)) {
    return provider.defaultModelId;
  }
  return (models[0] && models[0].id) || provider.defaultModelId || null;
}

// Validate a stored/candidate selection against the live options. Returns a
// normalized `{ endpointId, modelId }` if the provider still exists and is
// selectable, coercing a removed model back to the provider default (§4.4:
// "model removed from the catalog" → provider default); returns null when the
// provider is gone / team unassigned so the caller drops it silently.
export function validateSelection(sel, providers) {
  if (!sel || !sel.endpointId) return null;
  const list = Array.isArray(providers) ? providers : [];
  const provider = list.find(p => p.id === sel.endpointId);
  if (!provider) return null;
  const models = Array.isArray(provider.models) ? provider.models : [];
  const modelId = models.some(m => m.id === sel.modelId)
    ? sel.modelId
    : providerDefaultModelId(provider);
  if (!modelId) return null;
  return { endpointId: provider.id, modelId };
}

// Exactly one selectable provider → auto-select it (§4.3: single-provider users
// are auto-selected and never see the attention state). Returns null when there
// is not exactly one provider, or the one provider has no usable model.
export function autoSelect(providers) {
  const list = Array.isArray(providers) ? providers : [];
  if (list.length !== 1) return null;
  const modelId = providerDefaultModelId(list[0]);
  if (!modelId) return null;
  return { endpointId: list[0].id, modelId };
}

// The `X-Assist-Model` header value (§4.5): "<endpointId>:<modelId>". Returns
// null when nothing is selected, so the transport layer sends no header.
export function selectionHeaderValue(sel) {
  if (!sel || !sel.endpointId || !sel.modelId) return null;
  return `${sel.endpointId}:${sel.modelId}`;
}

// Attention state (§4.3): no selection yet AND ≥ 2 selectable providers — the
// user must pick once. One (auto-selected) or zero providers never attention.
export function needsSelection(sel, providers) {
  if (sel) return false;
  const list = Array.isArray(providers) ? providers : [];
  return list.length >= 2;
}

// The compact label on the header button: "<provider name> · <model name>".
// Falls back to raw ids if the option went missing between render and click.
export function selectionLabel(sel, providers) {
  if (!sel || !sel.endpointId) return null;
  const list = Array.isArray(providers) ? providers : [];
  const provider = list.find(p => p.id === sel.endpointId);
  const providerName = (provider && provider.name) || sel.endpointId;
  const models = (provider && Array.isArray(provider.models)) ? provider.models : [];
  const model = models.find(m => m.id === sel.modelId);
  const modelName = (model && (model.displayName || model.id)) || sel.modelId;
  return `${providerName} · ${modelName}`;
}

// Normalise the assist providers into the shared ModelSelectorPopover group shape
// (#1670). Each provider becomes one group; the header shows no per-provider
// detail rows (only chat does), and model labels are the plain display name / id
// with no family/kind suffix (AC9).
export function assistGroups(providers) {
  const list = Array.isArray(providers) ? providers : [];
  return list.map(p => {
    const models = Array.isArray(p.models) ? p.models : [];
    return {
      id: p.id,
      name: p.name || p.id,
      scope: p.scope === 'system' ? 'system' : 'team',
      details: [],
      defaultModelId: p.defaultModelId || null,
      models: models.map(m => ({
        id: m.id,
        label: plainModelLabel(m),
        isDefault: m.id === p.defaultModelId,
      })),
      emptyText: 'No models configured',
    };
  });
}
