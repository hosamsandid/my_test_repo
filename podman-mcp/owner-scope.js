'use strict';

// The single enforcement primitive: every container the service creates is
// stamped with this label; every read/lifecycle op is filtered to the
// caller's scope. Pure so it's unit-testable in isolation.
const OWNER_LABEL_KEY = 'aee.mcp-owner';

function ownerLabelArg(scopeId) {
  return `${OWNER_LABEL_KEY}=${scopeId}`;
}

function isOwned(container, scopeId) {
  if (typeof scopeId !== 'string' || scopeId.length === 0) return false;
  return !!(container && container.Labels && container.Labels[OWNER_LABEL_KEY] === scopeId);
}

function filterOwned(containers, scopeId) {
  return (Array.isArray(containers) ? containers : []).filter((c) => isOwned(c, scopeId));
}

module.exports = { OWNER_LABEL_KEY, ownerLabelArg, isOwned, filterOwned };
