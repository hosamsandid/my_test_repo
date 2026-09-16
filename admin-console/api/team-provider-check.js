'use strict';

/*
 * Pure decision core for #2179: block team creation on a platform with no
 * usable model provider, rather than letting it through and 500ing on the
 * new team's first run (`pickDefaultLlmBinding` silently binds `null` when
 * the registry is empty). Kept pure/fs-free (the #651 convention) so both
 * POST /api/teams and POST /api/teams/stream can share one message and one
 * rule without re-deriving it.
 */

const NO_PROVIDER_MESSAGE =
  'No model provider is configured for this platform yet. Ask a Team or System Administrator to add one under "Model Providers" before creating a team.';

// `endpointCount` is the size of the live registry (`listLlmEndpoints().length`)
// at call time. Returns `{ error, code }` to block, or `null` to proceed.
function validateTeamProviderAvailability(endpointCount) {
  if (endpointCount > 0) return null;
  return { error: NO_PROVIDER_MESSAGE, code: 'no_llm_endpoint' };
}

module.exports = { NO_PROVIDER_MESSAGE, validateTeamProviderAvailability };
