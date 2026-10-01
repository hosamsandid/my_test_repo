/**
 * create-team-copy.js — the one vocabulary for "turn a design into a live team"
 * (#2053).
 *
 * The act had four names one click apart: the canvas toolbar said
 * **Materialize…**, the import banner said **Materialize as team…**, the panel
 * they both opened was titled **Materialize as team**, and the button inside it
 * that actually does the work says **Create team**. A first-time user arriving
 * from `/create` — which promises "a team of agents" — had no way to know that
 * *Materialize* was the destination, and the word appeared in the empty-canvas
 * copy before the button it names was ever usable.
 *
 * #2053 D1 settles on **Create team…** because it makes one word carry the whole
 * chain: `/create` promises a team → the button says *Create team…* → the
 * dialog's submit button already said *Create team* → a team appears in the
 * list. D2 drops *Materialize* from the button and the dialog title; it survives
 * only as a bridge in the tooltip (for users who learned the old word) and one
 * sentence in `help-topics/flows.md`.
 *
 * Every surface that names the act reads its string from here — the toolbar
 * button, the import-preview banner, the Flows rail context menu, the dialog
 * title and the post-creation confirmation — so the four vocabularies cannot
 * come back one surface at a time.
 *
 * **The member-level sense of the word is a different act and keeps its own
 * verb.** Creating a team creates its members as *stubs* by default; taking one
 * stub to a running agent with a cloned repository is **provisioning**
 * (`PROVISION_NOW_LABEL` below). Agent Chat's *Not materialized yet* section and
 * its *Materialize* entry are deliberately NOT renamed (#2053 Non-goals) — they
 * are a different surface, so this module quotes that section by name rather
 * than re-using its verb.
 *
 * Pure and React-free so it unit-tests without a DOM (per the #651 convention).
 */

/** The label on every control that turns a design into a live team. */
export const CREATE_TEAM_LABEL = 'Create team…';

/**
 * The dialog's own title. No ellipsis: the ellipsis on the button promises "this
 * opens something", and the something is here.
 */
export const CREATE_TEAM_DIALOG_TITLE = 'Create team';

/**
 * The bridge for users who learned the old word (D2). It lives in the tooltip
 * and nowhere else in the UI — a button carrying two names is the confusion this
 * ticket removes.
 */
export const MATERIALIZE_BRIDGE = 'previously called Materialize';

/** What the action does, plus the bridge. Used as the tooltip on every surface. */
export const CREATE_TEAM_DESCRIPTION =
  `Create a real team and its agents from this design (${MATERIALIZE_BRIDGE})`;

/**
 * Lead of the persistent draft status line (#2053 B2). A live team already gets
 * a warning strip spelling out its consequences; the draft — the mode that
 * actually needs guidance — had only a hover tooltip.
 */
export const DRAFT_STATUS_LEAD = 'Draft — nothing runs yet.';

/** The next step, once the draft has something to create a team from. */
export const DRAFT_NEXT_STEP =
  `Add the agents and humans you need, then use ${CREATE_TEAM_LABEL} to make it real.`;

/**
 * The persistent draft status line.
 *
 * @param {number} roleCount agents in the draft
 * @param {string} [blockedReason] the disabled-reason for the create action,
 *   surfaced INLINE rather than hover-only (AC6) when the draft has no agents
 * @returns {string} one sentence pair; never empty
 */
export function draftStatusLine(roleCount, blockedReason) {
  const n = Number.isFinite(roleCount) ? roleCount : 0;
  if (n <= 0 && blockedReason) return `${DRAFT_STATUS_LEAD} ${blockedReason}`;
  return `${DRAFT_STATUS_LEAD} ${DRAFT_NEXT_STEP}`;
}

/**
 * The confirmation shown after a team was created (#2053 D5 / AC12).
 *
 * Before this ticket the dialog closed and navigated away the instant the stream
 * completed, so nothing said what had happened: the draft row stayed in
 * **Drafts** looking untouched next to a new **Teams** row, and a user could not
 * tell whether it had worked or whether pressing the button again was safe.
 *
 * The durable draft → team link is explicitly out of scope, so this names the
 * team and states the one thing a reader would otherwise get wrong — that the
 * design they are looking at is no longer connected to the thing they created.
 *
 * Two wordings, because the two entry points start from different things: the
 * draft toolbar's source IS a draft that stays in the list, while the
 * import-preview banner's source is a read-only preview of a file which is
 * discarded when the panel closes. Telling an importing user their "design stays
 * a draft" sends them looking for a Drafts row that was never created.
 *
 * @param {string} teamName
 * @param {{fromImport?: boolean}} [opts]
 * @returns {string} '' when there is no name to talk about
 */
export function createdTeamNotice(teamName, { fromImport = false } = {}) {
  const name = typeof teamName === 'string' ? teamName.trim() : '';
  if (!name) return '';
  if (fromImport) {
    return `The imported file was a one-off preview — it is not kept. Team “${name}” is `
      + 'now the live copy; use Export on its canvas if you want the bundle again.';
  }
  return `This design stays a draft — editing it from now on no longer changes team “${name}”.`;
}

/**
 * The import-preview banner's member count (#2737), e.g. `10 agents · 3 human
 * roles`. It used to print `graph.nodes.length`, which counts the synthesized
 * `kind: 'human'` nodes too, so the banner said 13 agents where the Create team
 * dialog — and the result — said 10. Both now read the same source: the
 * bundle's `roles` are the agents (what the dialog counts and what gets
 * created), its `humans` are declarative and only named when there are any.
 */
export function importedBlueprintCounts(bundle) {
  const agents = Array.isArray(bundle?.roles) ? bundle.roles.length : 0;
  const humans = Array.isArray(bundle?.humans) ? bundle.humans.length : 0;
  const agentText = `${agents} ${agents === 1 ? 'agent' : 'agents'}`;
  if (!humans) return agentText;
  return `${agentText} · ${humans} ${humans === 1 ? 'human role' : 'human roles'}`;
}

/**
 * The action that closes the confirmation and opens what was created — in
 * Agent Chat, on the team's first agent (#2521), since talking to the new
 * agents is what comes next. It used to read "Open team" and lead back to the
 * canvas the user was already on; the label now names the destination.
 */
export const OPEN_IN_AGENT_CHAT_LABEL = 'Open in Agent Chat';

/**
 * The member-level act, which is NOT team creation: cloning the repository and
 * starting the container for each member. Named separately (AC13) because
 * "Materialize agents now" used to mean this one step away from a button that
 * used "Materialize" for the other thing.
 */
export const PROVISION_NOW_LABEL = 'Provision agents now';

/** The full checkbox copy for the launch step's provision-now toggle. */
export const PROVISION_NOW_HINT =
  'clones the repo for every member immediately. Leave off to create them as stubs '
  + '(shown in the team, nothing cloned) and provision each on demand by enabling it — '
  + 'Agent Chat lists them under “Not materialized yet”.';

export default CREATE_TEAM_LABEL;
