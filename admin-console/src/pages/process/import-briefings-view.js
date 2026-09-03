/**
 * import-briefings-view.js — pure decisions for the Flows page's
 * "Import BriefingPacks" action (#1965, epic #1961 Phase 4).
 *
 * The BriefingPack model is being retired, and importing a pack hierarchy as a
 * flow draft is the one part of it the epic keeps (decision R3): it is the
 * migration path off the model. Until now it was not an action at all — you
 * reached it by selecting an Orchestrator in a "BriefingPack flows" list that
 * this phase removes, and pressing a button floating over that list's graph.
 * With the listing gone the import needs its own front door, and the wording
 * has to say what it is for, because a reader who never used BriefingPacks will
 * otherwise read it as a second, competing flow-import (AC4).
 *
 * Pure and React-free so it unit-tests without a DOM (#651 convention); the
 * dialog in `Briefings.jsx` is a thin renderer over these.
 */

/** The action's own copy. Kept here so it is assertable rather than inline JSX. */
export const IMPORT_BRIEFINGS_COPY = {
  action: 'Import BriefingPacks…',
  // The page-action tooltip. Names the direction of travel — this is how you
  // get OFF the old model, not a way to keep working in it.
  tooltip: 'Migration aid: turn an existing BriefingPack hierarchy into an editable flow draft',
  // Shown while the agent list is still loading — the dialog's picker is built
  // from it, so the action is held rather than opened onto an empty list.
  loading: 'Waiting for the agent list…',
  title: 'Import BriefingPacks as a flow draft',
  lead:
    'Migration aid. BriefingPacks are being retired: this reads a mission directory\'s '
    + 'brief.md files once and turns the hierarchy into an editable flow draft. It is a '
    + 'one-way copy — nothing is written back to the brief.md files, and the draft is '
    + 'yours to edit from then on.',
  agentLabel: 'Agent whose workspace holds the packs',
  pathLabel: 'Mission directory',
  pathHint: 'Relative to the agent\'s workspace root. Leave empty for the root itself. '
    + 'Packs are read from artifacts/briefings inside it.',
  confirm: 'Import as draft',
  busy: 'Importing…',
};

/** Trim + strip leading/trailing slashes from a user-typed relative path. */
export function normalizeMissionPath(path) {
  return String(path == null ? '' : path).trim().replace(/^\/+|\/+$/g, '');
}

/**
 * The mission directory to pre-fill for an agent.
 *
 * A leftover `briefingsPath` on an agent's config is the directory that agent's
 * packs actually live in. The field that used to write it was removed in #1964,
 * but the epic's hard cut leaves existing configs on disk untouched — so the
 * value is still the best guess available, and pre-filling it is what makes the
 * migration a single click for the agents that need it.
 *
 * @param {{briefingsPath?: string}|null} agent
 * @returns {string} a normalized relative path, '' when there is nothing to guess
 */
export function defaultMissionPath(agent) {
  return normalizeMissionPath(agent && agent.briefingsPath);
}

/**
 * The agents offered in the picker, most-likely-first.
 *
 * Any agent may hold a pack tree in its workspace, so the list is not filtered
 * by role — the retired `orchestrator` role is exactly the thing this epic is
 * removing, and filtering on it would hide a workspace whose packs were moved
 * to an ordinary agent. Instead the ones carrying a leftover `briefingsPath`
 * sort first (they are the ones a migration is actually about) and everything
 * else follows alphabetically by display name.
 *
 * @param {Array<Object>|null} agents  the `/api/agents` payload
 * @returns {Array<{id, label, path, likely}>}
 */
export function importCandidates(agents) {
  const rows = (Array.isArray(agents) ? agents : [])
    .filter(a => a && typeof a.id === 'string' && a.id)
    // A `team` agent hosts no workspace of its own — it is a prompt template.
    .filter(a => a.role !== 'team')
    .map(a => {
      const path = defaultMissionPath(a);
      return { id: a.id, label: a.displayName || a.id, path, likely: !!path };
    });
  return rows.sort((x, y) => {
    if (x.likely !== y.likely) return x.likely ? -1 : 1;
    return x.label.localeCompare(y.label) || x.id.localeCompare(y.id);
  });
}

/**
 * Whether the confirm button is live, and why not when it is not.
 *
 * @param {{agentId?: string, busy?: boolean}} state
 * @returns {{disabled: boolean, hint: string|null}}
 */
export function importSubmitState({ agentId, busy } = {}) {
  if (busy) return { disabled: true, hint: IMPORT_BRIEFINGS_COPY.busy };
  if (!agentId) return { disabled: true, hint: 'Pick the agent whose workspace holds the packs.' };
  return { disabled: false, hint: null };
}

/**
 * The request body for `POST /api/process/drafts/import-briefings`.
 *
 * `path` is omitted when empty rather than sent as `''`, so the wire shape says
 * "the agent root" by absence — the same convention the sibling workspace
 * handlers use for their `?path=` query parameter.
 *
 * @returns {{agentId: string, name: string, path?: string}|null} null when
 *   there is no agent to import from (the caller should not have submitted)
 */
export function importRequestBody({ agentId, path, label } = {}) {
  const id = String(agentId || '').trim();
  if (!id) return null;
  const rel = normalizeMissionPath(path);
  const body = { agentId: id, name: `${label || id} (imported BriefingPacks)` };
  if (rel) body.path = rel;
  return body;
}

/** A failed import, phrased for the dialog's inline error line. */
export function importErrorText(err) {
  const msg = (err && (err.message || err)) || 'unknown error';
  return `Import failed: ${msg}`;
}
