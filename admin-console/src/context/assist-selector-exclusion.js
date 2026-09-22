// Pure helpers for assist model selector exclusion reasons (#1402).
// Explains why the selector has no providers, enabling differentiated messaging
// in AssistModelSelector.jsx and exclusion badges on the Model Providers page.

export const REASON_ALL_OAUTH = 'all-oauth';
export const REASON_TEAM_SCOPE = 'team-scope';
export const REASON_MIXED = 'mixed';

// Mirror of assistSelectableEndpoint's team-membership check from scope.js
// (oauth check is handled separately in classifyExclusions).
function isSelectableByTeams(ep, userTeamIdSet) {
  const isSystem = ep.scope === 'system';
  const assignedTeamIds = Array.isArray(ep.assignedTeamIds) ? ep.assignedTeamIds : [];
  const teamId = ep.teamId || 'default';
  if (isSystem) return assignedTeamIds.some(t => userTeamIdSet.has(String(t)));
  return userTeamIdSet.has(String(teamId));
}

// Determine why the assist selector returns no providers.
//
// allEndpoints: full endpoint list from GET /api/llm-endpoints (may include the
//   read-only .env entry — that is filtered out)
// userTeamIds: string[] — the caller's team IDs (from user.teams[].teamId)
// isSysAdmin: boolean — sysadmins can always select any provider
//
// Returns { reason, oauthCount, teamScopeCount } or null.
// Null means: no real registered endpoints, or sysadmin (no exclusion applies).
export function classifyExclusions(allEndpoints, userTeamIds, isSysAdmin) {
  const list = Array.isArray(allEndpoints) ? allEndpoints : [];
  const real = list.filter(ep => ep && !ep.readOnly);
  if (real.length === 0) return null;
  if (isSysAdmin) return null;

  const teamIdSet = new Set(Array.isArray(userTeamIds) ? userTeamIds.map(String) : []);
  let oauthCount = 0;
  let teamScopeCount = 0;

  for (const ep of real) {
    if (ep.authType === 'oauth-token') {
      oauthCount++;
    } else if (!isSelectableByTeams(ep, teamIdSet)) {
      teamScopeCount++;
    }
    // If it is selectable (neither oauth nor team-mismatch), classifyExclusions
    // should not be called — but we treat it as zero contribution gracefully.
  }

  if (oauthCount > 0 && teamScopeCount === 0) return { reason: REASON_ALL_OAUTH, oauthCount, teamScopeCount };
  if (oauthCount === 0 && teamScopeCount > 0) return { reason: REASON_TEAM_SCOPE, oauthCount, teamScopeCount };
  if (oauthCount > 0 && teamScopeCount > 0) return { reason: REASON_MIXED, oauthCount, teamScopeCount };
  return null;
}

// Returns { title, detail } for the selector chip tooltip, or null when classification is null.
export function exclusionMessage(classification) {
  if (!classification) return null;

  if (classification.reason === REASON_ALL_OAUTH) {
    return {
      title: 'Registered providers use OAuth subscription tokens, which cannot be selected here.',
      detail: 'Add an API-key provider to use the assist selector.',
    };
  }
  if (classification.reason === REASON_TEAM_SCOPE) {
    return {
      title: 'No providers are assigned to your team.',
      detail: 'A System Admin can add your team to a provider\'s scope on the Model Providers page.',
    };
  }
  // MIXED
  return {
    title: 'No providers are available for your team.',
    detail: 'Some providers use OAuth tokens (cannot be used server-side); others are not assigned to your team. A System Admin can assign a provider on the Model Providers page.',
  };
}

// Determines the assist-exclusion reason for a single endpoint, for the Model
// Providers page badge (AC1: oauth, AC2: team-scope mismatch).
//
// Returns 'oauth' | 'team-scope' | null.
// Null means the endpoint is selectable (or the user is a sysadmin).
export function endpointAssistExclusion(ep, userTeamIds, isSysAdmin) {
  if (!ep || ep.readOnly) return null;
  if (ep.authType === 'oauth-token') return 'oauth';
  if (isSysAdmin) return null;
  const teamIdSet = new Set(Array.isArray(userTeamIds) ? userTeamIds.map(String) : []);
  if (!isSelectableByTeams(ep, teamIdSet)) return 'team-scope';
  return null;
}

// Where each assist-exclusion badge renders on the Model Providers table (#2405).
// The oauth ("Agents only") badge moved next to the "Subscription (OAuth)" label
// in the Base URL cell — the OAuth subscription IS the reason the provider is
// agent-chat-only — while the team-scope ("Not your teams") badge stays by the
// provider name, where it has no natural Base-URL home. Pure so the placement
// rule is unit-tested without mounting ModelRegistry.
export function assistExclusionInBaseUrl(exclusion) {
  return exclusion === 'oauth';
}
export function assistExclusionInName(exclusion) {
  return exclusion === 'team-scope';
}
