/**
 * process-toolbar-hints.js — plain-language tooltips for the Flow-Editor
 * toolbar: the flow header row (ProcessCanvas.jsx) and the Flows page-action
 * bar (Briefings.jsx).
 *
 * Two jobs, one module.
 *
 * 1. **Disabled-reasons.** The draft-editing buttons (Add agent / Add human /
 *    Stages / Labels / Create team…) and Export are disabled in situations that
 *    used to be invisible to the user — the button just greyed out with no
 *    explanation:
 *
 *      • while a Copilot proposal is on screen, structural editing pauses
 *        because the canvas is previewing the proposal, not the draft
 *        underneath (and Export would write the wrong bundle);
 *      • Create team… additionally needs at least one agent before it can turn
 *        the design into a real team;
 *      • Export is also unavailable while an imported blueprint is previewing.
 *
 *    A disabled control that never says why is exactly the "not
 *    self-explanatory / hard to use" complaint. `toolbarTitle` returns the
 *    reason when the action is blocked, and the normal descriptive title
 *    otherwise, so the tooltip always explains the current state.
 *
 * 2. **The copy itself** (#1999). Every button in the header row and the
 *    page-action bar now carries a tooltip, so all of that copy lives here
 *    rather than as inline strings scattered through the JSX — that is what
 *    makes "no button is left unexplained" a checkable assertion instead of a
 *    visual sweep. `ProcessCanvas.jsx` / `Briefings.jsx` only wire the returned
 *    string into the shared `Tooltip`.
 *
 * Pure and React-free so it unit-tests without a DOM (per the #651 convention).
 */

import {
  CREATE_TEAM_DESCRIPTION,
  DRAFT_STATUS_LEAD,
  DRAFT_NEXT_STEP,
  draftStatusLine,
} from './process/create-team-copy.js';

/** Descriptive title shown when an action IS available. */
export const TOOLBAR_TITLES = {
  // Shared by the draft and the live-team scope, hence "the flow" rather than
  // "this design" — the same button sits on both.
  addAgent: 'Add an agent to the flow',
  addHuman: 'Add a human role to the flow',
  stages: 'Organize the flow into stages',
  labels: 'Manage the labels agents use to hand off work',
  // The action key stays `materialize` even though the button now reads
  // *Create team…* (#2053): it is an internal action id the canvas and the
  // #1984 drift guard both address by name, and renaming it would be churn with
  // no user-visible effect. The COPY is single-sourced from
  // `process/create-team-copy.js`, which is what AC13's one-vocabulary rule is
  // actually about, and it carries the *Materialize* bridge for users who
  // learned the old word (D2).
  materialize: CREATE_TEAM_DESCRIPTION,
  copilot: 'Ask the AI copilot to help build or edit this flow',
  export: 'Export this flow as a JSON file',
  // Kept from the pre-#1999 native title: it names the one thing a reader
  // actually needs reassuring about — the live team is not touched yet.
  editAsDraft:
    'Make an editable copy of this team you can revise before applying — the live team is untouched until you create a team from the copy',
  anomalies: 'Review stalled hand-offs and other flow problems detected in this live team',
  improvements: 'Deterministic run metrics for this team over the measurement window',
  parallelism: "How many tickets this flow works on at once, and how they're kept from clashing",
};

/**
 * Titles for the header-row controls that are not action buttons: the mode pill
 * and the draft-title rename control.
 */
export const STATUS_TITLES = {
  modeLive: 'You are editing a live team — changes apply to running agents immediately.',
  modeDraft: "You're editing a draft — nothing is applied until you create a team from it",
  renameDraft: 'Rename this flow',
};

/** Titles for the three Flows page-action-bar buttons (Briefings.jsx). */
export const PAGE_ACTION_TITLES = {
  import: 'Import a flow from a JSON file',
  importBusy: 'Reading the selected JSON file…',
  describe: 'Generate a flow from a natural-language description',
  newFlow: 'Create a new, empty flow',
};

/** The draft-editing actions that pause while a Copilot proposal is on screen. */
export const STRUCTURAL_ACTIONS = ['addAgent', 'addHuman', 'stages', 'labels', 'materialize'];

/**
 * Actions blocked whenever the canvas shows something other than the editable
 * bundle — a Copilot proposal or an imported blueprint.
 */
export const PREVIEW_BLOCKED_ACTIONS = ['export'];

/** Why structural editing is paused while a Copilot proposal is previewing. */
export const PROPOSAL_PENDING_REASON =
  'Accept or discard the Copilot proposal first — the canvas is previewing it, not your draft.';

/** Why Create team… is unavailable on an empty design. */
export const NO_ROLES_REASON =
  'Add at least one agent before you can turn this design into a real team.';

/** Why Export is unavailable while an imported blueprint is previewing. */
export const IMPORTED_PREVIEW_REASON =
  'Continue the imported blueprint as a draft first — there is nothing of your own to export yet.';

/**
 * The hover title for a Flow-Editor toolbar action.
 *
 * @param {string} action  one of the TOOLBAR_TITLES keys
 * @param {{hasProposal?: boolean, roleCount?: number, imported?: boolean}} [state]
 * @returns {string} the disabled-reason when the action is blocked, otherwise
 *   the action's normal descriptive title. Unknown actions return ''.
 */
export function toolbarTitle(action, state = {}) {
  const hasProposal = !!state.hasProposal;
  const imported = !!state.imported;
  const roleCount = Number.isFinite(state.roleCount) ? state.roleCount : 0;
  const base = TOOLBAR_TITLES[action] || '';

  if (PREVIEW_BLOCKED_ACTIONS.includes(action)) {
    // Same precedence as the structural actions: a proposal is the more recent
    // thing the user did, so name it first.
    if (hasProposal) return PROPOSAL_PENDING_REASON;
    if (imported) return IMPORTED_PREVIEW_REASON;
    return base;
  }

  if (!STRUCTURAL_ACTIONS.includes(action)) return base;

  // A pending proposal blocks every structural action.
  if (hasProposal) return PROPOSAL_PENDING_REASON;

  // Create team… has one extra precondition: at least one agent.
  if (action === 'materialize' && roleCount <= 0) return NO_ROLES_REASON;

  return base;
}

/**
 * The persistent draft status line (#2053 B2 / AC6).
 *
 * The live-team canvas has had a warning strip spelling out its consequences
 * since #1125, while the draft — the mode that actually needs guidance — carried
 * its one explanatory sentence only in the mode pill's tooltip, and the reason
 * the create action is greyed out on a fresh draft was reachable ONLY on hover.
 * Both now read inline.
 *
 * Thin wrapper over `draftStatusLine` so the disabled-reason stays owned by this
 * module (it is the same string the tooltip uses) while the sentence structure
 * stays with the rest of the create-team vocabulary.
 *
 * @param {number} roleCount agents in the open draft
 * @returns {string} never empty
 */
export function draftStatusText(roleCount) {
  return draftStatusLine(roleCount, NO_ROLES_REASON);
}

export { DRAFT_STATUS_LEAD, DRAFT_NEXT_STEP };
