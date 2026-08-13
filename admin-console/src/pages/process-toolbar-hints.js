/**
 * process-toolbar-hints.js — plain-language tooltips for the Flows draft-canvas
 * toolbar buttons (ProcessCanvas.jsx).
 *
 * The draft-editing buttons (Add agent / Add human / Stages / Labels /
 * Materialize) are disabled in two situations that used to be invisible to the
 * user — the button just greyed out with no explanation:
 *
 *   • while a Copilot proposal is on screen, structural editing pauses because
 *     the canvas is previewing the proposal, not the draft underneath;
 *   • Materialize additionally needs at least one agent before it can turn the
 *     design into a real team.
 *
 * A disabled control that never says why is exactly the "not self-explanatory /
 * hard to use" complaint. `toolbarTitle` returns the reason to show as the
 * button's hover title when it is blocked, and the normal descriptive title
 * otherwise, so the tooltip always explains the current state.
 *
 * Pure and React-free so it unit-tests without a DOM (per the #651 convention);
 * ProcessCanvas.jsx only wires the returned string onto each ToolbarButton.
 */

/** Descriptive title shown when an action IS available. */
export const TOOLBAR_TITLES = {
  addAgent: 'Add an agent to this design',
  addHuman: 'Add a named human role to this design',
  stages: 'Group the agents into ordered stages',
  labels: 'Manage the hand-off labels agents react to',
  materialize: 'Create a real team and its agents from this design',
};

/** The draft-editing actions that pause while a Copilot proposal is on screen. */
export const STRUCTURAL_ACTIONS = ['addAgent', 'addHuman', 'stages', 'labels', 'materialize'];

/** Why structural editing is paused while a Copilot proposal is previewing. */
export const PROPOSAL_PENDING_REASON =
  'Accept or discard the Copilot proposal first — the canvas is previewing it, not your draft.';

/** Why Materialize is unavailable on an empty design. */
export const NO_ROLES_REASON =
  'Add at least one agent before you can turn this design into a real team.';

/**
 * The hover title for a draft-canvas toolbar action.
 *
 * @param {string} action  one of the TOOLBAR_TITLES keys
 * @param {{hasProposal?: boolean, roleCount?: number}} [state]
 * @returns {string} the disabled-reason when the action is blocked, otherwise
 *   the action's normal descriptive title. Unknown actions return ''.
 */
export function toolbarTitle(action, state = {}) {
  const hasProposal = !!state.hasProposal;
  const roleCount = Number.isFinite(state.roleCount) ? state.roleCount : 0;
  const base = TOOLBAR_TITLES[action] || '';

  if (!STRUCTURAL_ACTIONS.includes(action)) return base;

  // A pending proposal blocks every structural action.
  if (hasProposal) return PROPOSAL_PENDING_REASON;

  // Materialize has one extra precondition: at least one agent.
  if (action === 'materialize' && roleCount <= 0) return NO_ROLES_REASON;

  return base;
}
