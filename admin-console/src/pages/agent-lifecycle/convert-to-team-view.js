/**
 * convert-to-team-view.js — the copy and the derived identity for the
 * "Convert into a team" confirmation (#2052).
 *
 * The conversion turns one standalone assistant into a team of one, in place.
 * It is not destructive — the agent keeps its id, its chat history, its prompt,
 * its skills and its triggers — but it is **one-way**, so AC2 asks for a
 * confirmation that names what will happen rather than a generic "Are you
 * sure?". Naming it means naming the team that is about to appear in the chat
 * rail and in the Flows list, which is why the id/name derivation is mirrored
 * here: the dialog shows the user the same id the orchestrator will mint.
 *
 * That mirror is a real risk, so it is guarded rather than trusted —
 * `convert-to-team-derivation.test.js` reads `orchestrator/team-conversion.js`
 * and fails if the two suffixes ever diverge.
 *
 * Dependency-free and unit-tested per the #651 convention; the dialog JSX in
 * `AgentLifecycleDialogs.jsx` renders whatever this returns.
 */

/** Must equal `TEAM_ID_SUFFIX` in orchestrator/team-conversion.js. */
export const TEAM_ID_SUFFIX = '-team';
/** Must equal `TEAM_NAME_SUFFIX` in orchestrator/team-conversion.js. */
export const TEAM_NAME_SUFFIX = ' Team';

/** The team id the conversion will derive — shown, never sent. */
export function previewTeamId(agent) {
  const id = agent && agent.id ? String(agent.id) : '';
  return id ? `${id}${TEAM_ID_SUFFIX}` : '';
}

/** The team display name the conversion will derive (the chat-rail group header). */
export function previewTeamName(agent) {
  if (!agent) return '';
  const base = typeof agent.displayName === 'string' && agent.displayName.trim()
    ? agent.displayName.trim()
    : String(agent.id || '');
  return base ? `${base}${TEAM_NAME_SUFFIX}` : '';
}

/**
 * Title / confirm label / width for the confirm, in the shape
 * `deleteDialogCopy` established.
 */
export function convertDialogCopy(agent) {
  const name = (agent && (agent.displayName || agent.id)) || 'this assistant';
  return {
    title: `Convert "${name}" into a team?`,
    confirmLabel: 'Convert into a team',
    maxWidth: 560,
  };
}

/**
 * What the user is agreeing to, as lines the dialog renders in order.
 *
 * Deliberately concrete on both halves — what is kept and what changes — because
 * the two questions a user actually has here are "do I lose my chat history?"
 * (no) and "can I go back?" (no). The restart is stated because it is
 * observable: the agent's container is recreated, so a long-running turn would
 * be interrupted, and the agent comes back by itself.
 */
export function convertConsequences(agent) {
  return [
    // No markdown here: the dialog body is plain React text, so backticks
    // around the id would be shown literally rather than rendered as code.
    `${(agent && (agent.displayName || agent.id)) || 'This assistant'} becomes the only member of a `
    + `new team called "${previewTeamName(agent)}", with the id ${previewTeamId(agent)}.`,
    'It keeps its id, its chat room and history, its system prompt, its skills, '
    + 'its triggers and its environment.',
    'It moves from the "Single agents" section of the chat list into its own team '
    + 'group, and the new team appears in Flows as a one-node flow you can wire up.',
    'The agent restarts to pick up its new team scope, and comes back on its own.',
    'This cannot be undone — there is no convert-back. Deleting the team afterwards '
    + 'deletes the agent with it.',
  ];
}

/**
 * The busy refusal (`409 { warning: true, busy, activeTriggers }`), turned into
 * a sentence plus the follow-up question.
 *
 * Same two-phase contract disable/enable use: the server refuses first and the
 * user decides, because converting mid-turn truncates whatever the agent is
 * saying. Returns null for a non-warning response so the caller can branch on it.
 */
export function convertBusyNotice(response) {
  if (!response || response.warning !== true) return null;
  const triggers = Array.isArray(response.activeTriggers) ? response.activeTriggers.filter(Boolean) : [];
  const parts = [];
  if (response.busy) parts.push('is working on a message right now');
  if (triggers.length > 0) {
    parts.push(`has ${triggers.length} active trigger run${triggers.length !== 1 ? 's' : ''} `
      + `(${triggers.join(', ')})`);
  }
  const what = parts.length > 0 ? parts.join(' and ') : 'is busy';
  return `This assistant ${what}. Converting now restarts it and cuts that run short.`;
}

/**
 * Post-conversion confirmation for the success toast — names the team so the
 * user can find it, and reports anything that only half-worked.
 *
 * The warnings are surfaced rather than swallowed: a skill whose content could
 * not be copied into the new team's pool is exactly the failure mode AC5 is
 * about, and it is silent from the chat rail otherwise.
 */
export function convertResultNotice(response) {
  if (!response || !response.teamId) return null;
  const base = `Converted into the team "${response.teamName || response.teamId}". `
    + 'Add a second member whenever you are ready.';
  const warnings = Array.isArray(response.warnings) ? response.warnings.filter(Boolean) : [];
  if (warnings.length === 0) return base;
  return `${base} Some steps reported a problem: ${warnings.join('; ')}`;
}
