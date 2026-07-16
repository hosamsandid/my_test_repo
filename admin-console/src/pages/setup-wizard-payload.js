/* Pure helpers for the Setup Wizard's Model Provider step.
 *
 * Kept free of React/DOM so they can be unit-tested with `node --test`, and so
 * the create-path payload logic mirrors ModelRegistry's EndpointForm.submit()
 * without the two surfaces drifting. The wizard is create-only, so there is no
 * clearToken / stored-token branch here — those only matter when editing.
 */

/** Build the POST /api/llm-endpoints body for the wizard's create path. */
export function buildLlmProviderPayload({ name, authType, baseUrl, authToken, models, complianceAck, oauthFlowId }) {
  const isOauth = authType === 'oauth-token';
  const cleanedModels = (models || [])
    .filter(m => m && m.id && m.id.trim())
    .map(m => ({
      id: m.id.trim(),
      displayName: (m.displayName || m.id).trim(),
      ...(m.kind ? { kind: m.kind } : {}),
    }));
  const payload = {
    name: (name || '').trim(),
    authType: isOauth ? 'oauth-token' : 'api-key',
    // An OAuth (subscription) provider talks directly to api.anthropic.com, so
    // it carries no Base URL — send an empty string so the server clears it.
    baseUrl: isOauth ? '' : (baseUrl || '').trim(),
    models: cleanedModels,
  };
  if (isOauth && complianceAck) payload.complianceAck = true;
  // Token precedence: a manually pasted setup-token wins over a completed login
  // flow (which the server claims on save). The raw token never round-trips.
  const token = (authToken || '').trim();
  if (token) payload.authToken = token;
  else if (isOauth && oauthFlowId) payload.oauthFlowId = oauthFlowId;
  return payload;
}

/** Whether the Model Provider step has enough input to save. */
export function canSaveLlmProvider({ name, authType, baseUrl, authToken, complianceAck, oauthFlowId }) {
  if (!name || !name.trim()) return false;
  if (authType === 'oauth-token') {
    const tokenReady = !!(authToken && authToken.trim()) || !!oauthFlowId;
    return !!complianceAck && tokenReady;
  }
  return !!(baseUrl && baseUrl.trim());
}
