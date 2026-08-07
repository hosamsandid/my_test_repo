'use strict';

// ─── Broker SDK: ownership-label scope filter (plugin system Phase 4, #1520) ──
//
// The single enforcement primitive every broker shares (§4.6/§4.9): whatever a
// broker creates for a scope is stamped with an owner label; reads are filtered
// to the caller's scope; lifecycle ops exact-match it. Generalises podman-mcp
// `owner-scope.js` and uses the platform owner-label key `aee.plugin.owner`
// (orchestrator/plugin-scope.js), so the orchestrator's teardown/reconcile
// pass and the broker agree on which resources belong to a scope.
//
// GRANULARITY-AGNOSTIC: a scopeId is an opaque string. The same stamp/filter/
// match holds whether it names a team (many members share it) or a single
// agent (one member) — the broker never branches on which (§4.9). This is what
// makes member-vs-member isolation identical to team-vs-team isolation.
//
// Pure so it's unit-testable in isolation (mirrors scope-token.js).

const OWNER_LABEL_KEY = 'aee.plugin.owner';

// `key=value` fragment for a `--filter label=` / `--label` CLI arg.
function ownerLabelArg(scopeId, labelKey = OWNER_LABEL_KEY) {
  return `${labelKey}=${scopeId}`;
}

// True iff `resource` carries this scope's owner label EXACTLY. An empty/
// non-string scopeId never owns anything (a missing scope must never match the
// unlabelled). Reads the container-shape `.Labels` map (podman/docker inspect).
function isOwned(resource, scopeId, labelKey = OWNER_LABEL_KEY) {
  if (typeof scopeId !== 'string' || scopeId.length === 0) return false;
  return !!(resource && resource.Labels && resource.Labels[labelKey] === scopeId);
}

// Filter a list of resources to those this scope owns.
function filterOwned(resources, scopeId, labelKey = OWNER_LABEL_KEY) {
  return (Array.isArray(resources) ? resources : []).filter((r) => isOwned(r, scopeId, labelKey));
}

// Bind the helpers to one scopeId (and optional label key) so a broker handler
// that has already derived the caller's scope from the token can stamp/filter/
// match without threading scopeId through every call. `labelArg` is the value
// to stamp on create; `owns`/`filter` enforce on read; `owns` is also the
// exact-match used before a lifecycle op (stop/rm/exec) so a caller can never
// name another scope's resource.
function scopeFilter(scopeId, labelKey = OWNER_LABEL_KEY) {
  return {
    scopeId,
    labelKey,
    labelArg: ownerLabelArg(scopeId, labelKey),
    owns: (resource) => isOwned(resource, scopeId, labelKey),
    filter: (resources) => filterOwned(resources, scopeId, labelKey),
  };
}

module.exports = { OWNER_LABEL_KEY, ownerLabelArg, isOwned, filterOwned, scopeFilter };
