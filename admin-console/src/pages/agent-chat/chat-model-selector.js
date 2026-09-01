// Pure decision logic for the Agent-Chat runtime model/provider selector (#1670).
// The selector now shares the header's popover component (ModelSelectorPopover),
// but keeps all of its own behaviour: switching the provider (respawns the agent
// container, so it requires a confirmation) vs switching the model (live), reset
// to the environment default, the override indicator, and the disabled/read-only
// reasons. This module holds the surface-specific decisions so the JSX wrapper
// (ChatModelSelector.jsx) stays a thin renderer and everything is unit-tested in
// the admin-console-src CI job (JSX stays uncovered per #651).

import { plainModelLabel } from '../../components/model-selector-view.js';
import { resolveContextWindowTokens } from './context-window.js';
import { selectorWindowLabel } from './session-info.js';

// The chat popover's clarifying hint (#1670 decision 4 / AC10) — makes clear this
// controls the model/provider the agent RUNS on, not the assist billing model,
// so the now-identical-looking header and chat selectors are not confused.
export const CHAT_HINT = 'Sets the model & provider this agent runs on (not AI-helper billing).';

// Human label for a provider's auth type, shown as a per-group detail row.
export function authTypeLabel(authType) {
  if (!authType) return 'Default (.env)';
  return authType === 'oauth-token' ? 'Subscription' : 'API key';
}

// The curated provider set as shared popover groups. Each provider carries its
// System/Team scope badge (AC3), auth-type + endpoint detail rows (AC4 "provider
// details remain visible per group"), and plain model labels (no kind suffix, AC9).
// Each model row also carries a `meta` caption — its context window, e.g.
// "1M context" (#1718) — resolved from the model's `contextWindow` field (the
// known-Claude-family fallback in resolveContextWindowTokens keeps it consistent
// with the header fill indicator); null/omitted when the window is unknown so a
// row never shows a guessed size.
export function buildChatGroups(options) {
  const endpoints = (options && Array.isArray(options.endpoints)) ? options.endpoints : [];
  return endpoints.map(ep => {
    const models = Array.isArray(ep.models) ? ep.models : [];
    const details = [{ label: 'Auth', value: authTypeLabel(ep.authType) }];
    if (ep.baseUrl) details.push({ label: 'Endpoint', value: ep.baseUrl });
    return {
      id: ep.id,
      name: ep.name || ep.id,
      scope: ep.scope === 'system' ? 'system' : 'team',
      details,
      defaultModelId: ep.defaultModelId || null,
      models: models.map(m => {
        const meta = selectorWindowLabel(resolveContextWindowTokens(m));
        return {
          id: m.id,
          label: plainModelLabel(m),
          isDefault: m.id === ep.defaultModelId,
          ...(meta ? { meta } : {}),
        };
      }),
      emptyText: 'No models in this provider’s catalogue.',
    };
  });
}

// The currently-effective provider+model (drives the checkmark). The effective
// endpoint is resolved server-side into options.endpointId (override wins over
// the env binding); the effective model is the agent override, else the default.
export function chatSelection(options) {
  if (!options) return null;
  return {
    endpointId: options.endpointId || null,
    modelId: options.override || options.defaultModelId || null,
  };
}

// Can THIS caller change the provider/model at all? (AC6/AC7 — a viewer sees the
// binding read-only.) canSwitch is the server's canManageAgent verdict.
export function chatSelectable(options) {
  return !!(options && options.canSwitch) && ((options.endpoints || []).length > 0);
}

// The effective model's display label for the closed trigger button (#1704).
// The effective model is the per-agent override, else the environment default
// (mirrors chatSelection). Resolved against the current provider's catalogue
// (options.models) so it reflects the display name; falls back to the raw id
// when the catalogue lists it under no name. Returns null — so the caller omits
// the model segment rather than rendering an empty "· " — whenever there is no
// catalogue (no provider bound / empty catalogue) or no effective model.
export function effectiveModelLabel(options) {
  const models = (options && Array.isArray(options.models)) ? options.models : [];
  if (models.length === 0) return null;
  const modelId = (options && (options.override || options.defaultModelId)) || null;
  if (!modelId) return null;
  const model = models.find(m => m.id === modelId);
  return plainModelLabel(model) || modelId;
}

// Trigger button view model: label, tone (override → accent) and the override
// dot. The label shows the effective model alongside the provider as
// "<model> · <provider>" — model name FIRST (#1845), so the model (the segment
// the user most needs) is identifiable even when width is tight, and the trailing
// provider is what truncates. `labelParts` ({ lead, tail }) drives the two-span
// trigger where the leading model never truncates and the trailing provider
// ellipsises (AC4); it is null in degraded states (no provider bound, empty
// catalogue) so the button renders the single value with no dangling "· " (AC6).
export function chatTrigger(options) {
  const hasEndpoint = !!(options && options.endpointId);
  const overridden = !!(options && (options.endpointOverride || options.override));
  const provider = hasEndpoint
    ? (options.endpointName || options.endpointId)
    : 'Default (.env)';
  const modelLabel = hasEndpoint ? effectiveModelLabel(options) : null;
  const label = modelLabel ? `${modelLabel} · ${provider}` : provider;
  const labelParts = modelLabel ? { lead: modelLabel, tail: provider } : null;
  return {
    label,
    labelParts,
    tone: overridden ? 'override' : 'default',
    showOverrideDot: overridden,
    hasEndpoint,
    title: hasEndpoint ? `Model provider: ${label}` : 'No model provider bound',
  };
}

// The read-only / disabled reason shown in the popover (AC6 — no silent dead
// control). Null when the selector is fully interactive.
export function chatNotice(options) {
  if (!options) return null;
  if (!options.canSwitch) {
    return (options.endpoints || []).length
      ? 'You do not have permission to change this agent’s model or provider.'
      : 'No model providers are available for this team.';
  }
  if (!options.endpointId) {
    return 'No model provider is bound to this environment — set one in Working Environments.';
  }
  if (!(options.models || []).length) {
    return `Provider “${options.endpointName || options.endpointId}” has no models in its catalogue.`;
  }
  return null;
}

// Decide what a model click means. Selecting a model under the CURRENT provider
// is a live model change; under a DIFFERENT provider it is a provider switch that
// restarts the container and must be confirmed first (AC4). Clicking a provider's
// own default model clears any override rather than pinning it.
export function resolveChatSelectAction(options, groupId, modelId) {
  const current = (options && options.endpointId) || null;
  if (groupId === current) {
    const clearsOverride = modelId === ((options && options.defaultModelId) || null);
    return { kind: 'model', modelId: clearsOverride ? null : modelId };
  }
  const group = ((options && options.endpoints) || []).find(e => e.id === groupId) || null;
  const groupDefault = (group && group.defaultModelId) || null;
  const setModel = (modelId && modelId !== groupDefault) ? modelId : null;
  return {
    kind: 'provider',
    endpointId: groupId,
    modelId: setModel,
    needsConfirm: true,
    providerName: (group && (group.name || group.id)) || groupId,
  };
}

// "Reset to environment default": clear the per-agent overrides. A provider
// override is cleared through the provider endpoint (which respawns and prunes an
// incompatible model pin); a lone model override is cleared through the model
// endpoint (no respawn). Returns { kind: 'none' } when there is nothing to reset.
export function chatResetAction(options) {
  if (options && options.endpointOverride) return { kind: 'provider' };
  if (options && options.override) return { kind: 'model' };
  return { kind: 'none' };
}
