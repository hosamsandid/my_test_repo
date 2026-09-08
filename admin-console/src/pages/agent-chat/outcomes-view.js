/**
 * Pure view model for the right rail's read-only **Outcomes** tab (#963).
 *
 * The rail is the outputs counterpart of the Triggers tab: Triggers shows what
 * wakes an agent, Outcomes shows what it signals when it is done. Authoring
 * stays in the Flow Editor's Routing tab — this module only decides what to
 * display, so it holds no state and touches no DOM.
 *
 * Three shapes come out of `resolveOutcomeView`, matching the three states an
 * agent can be in:
 *
 *   kind: 'structured' — an authored `outcomes` port (the #827 successor of
 *                        flat `emits`): one row per option with title, when,
 *                        actions and derived consumers.
 *   kind: 'legacy'     — no authored port, but a flat `emits[]` array: one row
 *                        per label, flagged so the panel can show the
 *                        migration hint.
 *   kind: 'empty'      — neither. The panel shows its empty state.
 *
 * `isAuthoredOutcomes` in `admin-console/api/outcomes.js` is the server-side
 * authority for "authored"; `authoredOutcomes` below is its client mirror and
 * must keep the same lenient rule (valid mode + at least one option).
 */

import {
  consumersFor,
  labelConsumers,
  outcomeHandsOffToHuman,
  outcomeHandoffs,
  outcomeHumanReviewers,
} from '../process/outcome-consumers.js';

export const OUTCOME_MODES = ['exactlyOne', 'anyOf'];

// Client mirror of api/outcomes.js `isAuthoredOutcomes` — deliberately lenient:
// a port with a valid mode and at least one option counts, even if an option is
// still half-filled (the server validator is the write-side gate, not this).
export function authoredOutcomes(outcomes) {
  return !!outcomes
    && typeof outcomes === 'object'
    && OUTCOME_MODES.includes(outcomes.mode)
    && Array.isArray(outcomes.options)
    && outcomes.options.length > 0;
}

// Human wording for one action. Mirrors `outcomeActionClause` in
// api/process-template.js so the panel reads like the `## Outcomes` prompt
// block the agent actually receives. Returns `{ type, text, label }` — `label`
// is set only for setLabel, so the caller can render it as a code chip, and
// `type` is carried through so the icon is picked from the action kind rather
// than by sniffing the wording.
//
// `nameOf` (optional) resolves a target agent id to its display name, which a
// direct hand-off needs: the prompt block the agent receives reads `hand off
// directly to **<Target>**`, and the panel showed the raw type string
// `wakeAgent` instead (#2057 AC4). Absent, the id is shown — never the type.
export function describeAction(action, nameOf) {
  const type = action && action.type;
  if (type === 'setLabel') {
    const label = typeof action.label === 'string' ? action.label.trim() : '';
    return { type, text: label ? 'apply label' : 'apply label (none set)', label };
  }
  if (type === 'openPr') return { type, text: 'open a pull request', label: '' };
  if (type === 'openIssue') return { type, text: 'open a GitHub issue', label: '' };
  if (type === 'wakeAgent') {
    const to = typeof action.to === 'string' ? action.to.trim() : '';
    const who = (to && nameOf ? nameOf(to) : '') || to;
    return {
      type,
      text: who ? `hand off directly to ${who}` : 'hand off directly (no target set)',
      label: '',
    };
  }
  if (type === 'none') return { type, text: 'set no signal', label: '' };
  return { type: type || 'none', text: type ? String(type) : 'set no signal', label: '' };
}

// Every action of one option, in port order, with the empty port normalised to
// the terminal 'none' the way the editor and the prompt renderer both do.
export function describeActions(option, nameOf) {
  const actions = Array.isArray(option?.actions) && option.actions.length
    ? option.actions
    : [{ type: 'none' }];
  return actions.map(a => describeAction(a, nameOf));
}

// A row is terminal when it signals nothing at all — a dead end by design, not
// a missing consumer. Kept separate from "no consumers" so the panel can say
// which of the two it is.
function isTerminal(option) {
  const actions = Array.isArray(option?.actions) ? option.actions : [];
  return actions.length === 0 || actions.every(a => !a || a.type === 'none');
}

/**
 * Build the panel's rows.
 *
 * @param agent  the agent's own config as returned by `GET /api/agents/:id`
 *               (`outcomes`, `emits`, `id`).
 * @param peers  flow-graph nodes of the agent's team, as returned by
 *               `GET /api/process/graph?team=<parentTeamId>`. Optional: without
 *               them every row simply reports no consumers (see
 *               `consumersResolved`), which is how the panel degrades when the
 *               team graph is unavailable rather than hiding the outcomes.
 * @param labels the same graph's label registry (`graph.labels`,
 *               [{ name, humanGate, brake }]). Optional; used to mark rows
 *               that hand off to a person via a brake label (#981) so they
 *               never read as "no consumer".
 * @param humans the same graph's human-role registry (`graph.humans`,
 *               [{ id, name, consumes?, emits? }]). Optional; a bound human
 *               reviewer of an opened PR/issue is a consumer (#1001, D4), so
 *               those rows never read as "no consumer" either.
 */
export function resolveOutcomeView(agent, peers, labels, humans) {
  const node = { id: agent?.id };
  const list = Array.isArray(peers) ? peers : [];
  const consumersResolved = list.length > 0;
  // Display name of a peer, for the hand-off action chip. Falls back to the id
  // inside `describeAction`, so an unresolvable target still reads as an agent
  // rather than as the raw action type.
  const nameOf = (id) => {
    const p = list.find(x => x && x.id === id);
    return p ? (p.displayName || p.id) : '';
  };

  if (authoredOutcomes(agent?.outcomes)) {
    const oc = agent.outcomes;
    const rows = oc.options.map((o, i) => ({
      key: o.id || `outcome-${i + 1}`,
      title: (typeof o.title === 'string' && o.title.trim()) ? o.title.trim() : (o.id || `Outcome ${i + 1}`),
      when: (typeof o.when === 'string' && o.when.trim()) ? o.when.trim() : '',
      actions: describeActions(o, nameOf),
      notifyDm: o.notify === 'dm',
      terminal: isTerminal(o),
      consumers: consumersFor(o, node, list),
      // Direct hand-offs (#2057): a consumer named by the action itself, so it
      // is derived separately from the label/channel matching above.
      handoffs: outcomeHandoffs(o, node, list),
      humanHandoff: outcomeHandsOffToHuman(o, labels),
      humanReviewers: outcomeHumanReviewers(o, node, humans),
      // Open-end marker (#1004): 'terminal' | 'external' | null (+ note).
      marker: o.terminal === true ? 'terminal' : (o.external ? 'external' : null),
      markerNote: (o.external && typeof o.external.note === 'string') ? o.external.note : '',
    }));
    return {
      kind: 'structured',
      mode: oc.mode === 'exactlyOne' ? 'exactlyOne' : 'anyOf',
      rows,
      consumersResolved,
    };
  }

  const emits = (Array.isArray(agent?.emits) ? agent.emits : [])
    .filter(e => typeof e === 'string' && e.trim())
    .map(e => e.trim());
  const unique = [...new Set(emits)];
  if (unique.length) {
    return {
      kind: 'legacy',
      mode: 'anyOf',
      rows: unique.map(label => ({
        key: label,
        title: label,
        when: '',
        actions: [describeAction({ type: 'setLabel', label })],
        notifyDm: false,
        terminal: false,
        consumers: labelConsumers(label, node, list),
        handoffs: [], // a flat emit sets a label — it cannot carry a hand-off action
        humanHandoff: outcomeHandsOffToHuman({ actions: [{ type: 'setLabel', label }] }, labels),
        humanReviewers: [], // a flat emit sets a label — there is no artifact to review
        marker: null, markerNote: '', // flat emits carry no open-end markers
      })),
      consumersResolved,
    };
  }

  return { kind: 'empty', mode: 'anyOf', rows: [], consumersResolved };
}

// Lead sentence for the resolved mode — the rail's echo of the prompt block's
// own lead, so an operator reads the same contract the agent was given.
export function modeSummary(mode) {
  return mode === 'exactlyOne'
    ? 'The agent chooses exactly one of these per run.'
    : 'The agent chooses all that apply per run — zero is allowed.';
}

/**
 * Deep link into the Flow Editor's Routing tab for this agent (#963 AC5).
 *
 * `proc` selects the team's flow, `node` the agent, `tab` the inspector tab —
 * a bookmarkable query string rather than router state, so the link survives a
 * cold navigation (the pattern established for `?session=` in #642).
 * Returns null when the agent is not part of a team, which is also when the
 * tab itself stays hidden.
 */
export function flowEditorRoutingHref(agent) {
  const team = agent && typeof agent.parentTeamId === 'string' ? agent.parentTeamId.trim() : '';
  const id = agent && typeof agent.id === 'string' ? agent.id.trim() : '';
  if (!team || !id) return null;
  return `/flows?proc=${encodeURIComponent(team)}&node=${encodeURIComponent(id)}&tab=routing`;
}

// The tab is only meaningful for a team member: outcomes are hand-offs, and a
// standalone agent has no peers to hand off to (#963 AC1).
export function hasTeamContext(agent) {
  return !!(agent && typeof agent.parentTeamId === 'string' && agent.parentTeamId.trim());
}
