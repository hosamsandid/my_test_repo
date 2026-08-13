// Pure submit-gate helper for the "Create Agent" form (Agents.jsx).
//
// Before this module the gate lived inline in AgentCreateForm as a single
// boolean (`canSubmit`): the "Create Agent" button just went grey with no
// explanation of which required field was still empty. That is the exact
// "the platform isn't self-explanatory" complaint — a user new to the console
// stares at a disabled button and can't tell what it wants.
//
// This derives the SAME gate PLUS the ordered list of specific unmet
// requirements from one place, so the disabled button and the "why is this
// disabled" hint can never disagree — the same discipline
// model-provider-submit-state.js applies to the Model Provider form (#1302).
// Kept pure (no React) so it is unit-tested in agent-create-submit-state.test.js.

const trimmed = v => String(v ?? '').trim();

// Roles that do NOT need a default system prompt up front: an orchestrator
// runs briefing-supplied missions, and a team stores an optional template that
// each member can override later. Kept in sync with AgentCreateForm.
const PROMPT_OPTIONAL_ROLES = new Set(['orchestrator', 'team']);

/**
 * Derive whether the create-agent form can be submitted and, when it cannot,
 * the ordered list of unmet requirements to surface to the user. The order
 * follows the form top-to-bottom (Display Name → ID → Working Environment →
 * System Prompt) so the hint reads like a checklist of the visible fields.
 *
 * @param form.displayName    raw Display Name field
 * @param form.id             raw ID field (auto-derived from the name)
 * @param form.environmentId  selected Working Environment id
 * @param form.role           selected role ('agent' | 'team' | 'orchestrator' | …)
 * @param form.systemPrompt   raw System Prompt field
 * @returns {{ canSubmit: boolean, reasons: Array<{field: string, message: string}> }}
 */
export function describeAgentSubmitState(form = {}) {
  const { displayName, id, environmentId, role, systemPrompt } = form;

  const reasons = [];

  if (!trimmed(displayName)) {
    reasons.push({ field: 'displayName', message: 'Enter a display name.' });
  }
  if (!trimmed(id)) {
    reasons.push({ field: 'id', message: 'Enter an ID (auto-derived from the display name).' });
  }
  if (!trimmed(environmentId)) {
    reasons.push({ field: 'environmentId', message: 'Choose a Working Environment.' });
  }
  if (!PROMPT_OPTIONAL_ROLES.has(role) && !trimmed(systemPrompt)) {
    reasons.push({ field: 'systemPrompt', message: 'Write the system prompt.' });
  }

  return { canSubmit: reasons.length === 0, reasons };
}
