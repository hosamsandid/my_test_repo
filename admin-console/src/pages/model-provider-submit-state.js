// Pure submit-gate helper for the Model Provider form (#1302).
//
// The "Create provider" / "Save changes" button is disabled until every
// requirement for the selected auth type is met. Before #1302 that gate lived
// inline in ModelRegistry.jsx as a single boolean (`canSubmit`) — the button
// went grey with no explanation, and the mandatory single-user OAuth
// confirmation (a checkbox tucked inside an amber informational box) was the
// requirement people missed most, because nothing told them it was unmet.
//
// This module derives the SAME gate plus the list of specific unmet
// requirements from one place, so the disabled button and the "why is this
// disabled" hint can never disagree — the same discipline llm-probe-state.js
// applies to the probe button. Kept pure (no React) so it is unit-tested in
// model-provider-submit-state.test.js.

const trimmed = v => String(v ?? '').trim();

/**
 * Derive whether the provider form can be submitted and, when it cannot, the
 * ordered list of unmet requirements to surface to the user.
 *
 * @param form.name            raw provider-name field
 * @param form.ownershipReady  team-scope ownership is resolved (already folds
 *                             in whether ownership is even being sent)
 * @param form.isOauth         the OAuth (subscription) auth type is selected
 * @param form.requireCompliance  the single-user confirmation is demanded
 *                                 (OAuth create, or api-key→OAuth switch)
 * @param form.complianceOk    the single-user confirmation checkbox is ticked
 * @param form.oauthTokenReady a token is available (stored, completed login,
 *                             or pasted setup-token)
 * @param form.baseUrl         raw Base URL field (api-key path)
 * @returns {{ canSubmit: boolean, reasons: Array<{field: string, message: string}> }}
 */
export function describeSubmitState(form) {
  const {
    name,
    ownershipReady,
    isOauth,
    requireCompliance,
    complianceOk,
    oauthTokenReady,
    baseUrl,
  } = form;

  const reasons = [];

  if (!trimmed(name)) {
    reasons.push({ field: 'name', message: 'Enter a provider name.' });
  }
  if (!ownershipReady) {
    reasons.push({ field: 'ownership', message: 'Choose which team owns this provider.' });
  }
  if (isOauth) {
    if (!oauthTokenReady) {
      reasons.push({
        field: 'oauth-token',
        message: 'Complete the subscription login (or paste a setup token).',
      });
    }
    if (requireCompliance && !complianceOk) {
      reasons.push({
        field: 'compliance',
        message: 'Tick the single-user confirmation.',
      });
    }
  } else if (!trimmed(baseUrl)) {
    reasons.push({ field: 'base-url', message: 'Enter the base URL.' });
  }

  return { canSubmit: reasons.length === 0, reasons };
}
