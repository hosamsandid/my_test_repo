/**
 * agent-lifecycle-menu.js — pure descriptors for the agent/team lifecycle
 * actions, shared by the Agents page and the Agent Chat left rail (#1928,
 * epic #1925 Phase 1).
 *
 * The lifecycle actions (enable/disable, clone, export, save-as-template,
 * delete, reset-to-stub; team fan-out, add member, add missing role, export /
 * delete team, open in Flow Editor) used to exist only as JSX on the Agents
 * page, where "which action does this role get, and when is it disabled" was
 * spread across five card components' prop lists. Phase 1 re-surfaces the same
 * actions in the chat, so that decision has to be assertable in one place
 * instead of eyeballed twice — this module holds it as data, and both surfaces
 * render whatever it returns.
 *
 * Dependency-free and unit-tested per the #651 convention (the JSX menus are
 * thin renderers over `buildAgentMenu` / `buildTeamMenu`).
 */

/**
 * Does this agent carry an agent/Matrix token (i.e. has it ever been
 * provisioned)? Accepts both list shapes: `GET /api/agents` ships the raw
 * `token`, while `GET /api/matrix/agents` never ships the token itself and
 * carries a boolean `hasToken` instead.
 */
export function hasToken(agent) {
  if (!agent) return false;
  if (typeof agent.hasToken === 'boolean') return agent.hasToken;
  return !!agent.token;
}

/**
 * Three states: `stub` (never provisioned), `paused` (provisioned but
 * disabled), `active`. Moved here verbatim from Agents.jsx so both surfaces
 * derive the state the same way.
 */
export function agentState(agent) {
  if (!hasToken(agent) && agent?.enabled === false) return 'stub';
  if (agent?.enabled === false) return 'paused';
  return 'active';
}

/** The hint shown on every action a plain Team Member may not perform (AC8). */
export const NO_RIGHTS_HINT =
  'Only a Team Admin for this agent can do this.';

/**
 * The team lock (AC5): a member of a disabled team cannot be enabled on its
 * own — the Agents page renders its toggle disabled with exactly this label.
 */
export const TEAM_LOCKED_HINT = 'Team is disabled — enable the team first';

/** Reset-to-stub is destructive in a way "disable" is not — say so, everywhere. */
export const RESET_TO_STUB_HINT =
  'Reset to stub — wipes the workspace (session history, cloned repos, '
  + 'in-workspace state). Not a pause; use Disable to pause.';

/**
 * Which roles get which per-agent action. Mirrors the Agents page's
 * prop-presence gating (a card only receives `onClone` / `onExtractTemplate` /
 * `onExport` for the roles allowed to use them) — see the role/affordance grid
 * in Agents.jsx: clone and save-as-template are standalone-agent and
 * team-member only, and a `team` row gets the *team* menu instead of this one.
 */
const CLONEABLE_ROLES = new Set(['agent', 'team-member']);
const EXPORTABLE_ROLES = new Set(['agent', 'team-member', 'team', 'orchestrator']);

/**
 * Per-agent context-menu items for one chat row / agent card.
 *
 * @param {object}  o.agent       list entry (`/api/agents` or `/api/matrix/agents`)
 * @param {boolean} o.canManage   may this caller manage the agent (server's
 *                                `canManageAgent`, shipped per entry)? Mutating
 *                                entries are disabled when false (AC8).
 * @param {boolean} o.locked      the agent is a member of a disabled team (AC5)
 * @param {boolean} o.busy        a mutation for this agent is in flight
 * @returns {{key:string,label:string,danger?:boolean,disabled?:boolean,title?:string}[]}
 */
export function buildAgentMenu({ agent, canManage = true, locked = false, busy = false } = {}) {
  if (!agent) return [];
  const role = agent.role || 'agent';
  const state = agentState(agent);
  const isStub = state === 'stub';
  const enabled = state === 'active';

  // A mutating entry is offered but inert when the caller lacks rights, so the
  // menu stays a stable, discoverable list instead of changing shape per user.
  const gate = (extraDisabled, extraTitle) => ({
    disabled: !canManage || busy || !!extraDisabled,
    title: !canManage ? NO_RIGHTS_HINT : (extraTitle || undefined),
  });

  const items = [];

  // Enable / Disable. The team lock only ever blocks *enabling* a member on
  // the Agents page (the toggle is disabled outright); mirror that here.
  items.push({
    key: 'toggle-enabled',
    label: enabled ? 'Disable' : 'Enable',
    ...gate(locked, locked ? TEAM_LOCKED_HINT : undefined),
  });

  // Configuration (#1929). Gated like a mutating entry even though choosing it
  // only opens a surface: the Settings tab is hidden for a caller who may not
  // manage the agent, so an ungated entry would open nothing at all.
  items.push({
    key: 'settings',
    label: 'Settings…',
    ...gate(false, 'Opens this agent\'s configuration in the right rail.'),
  });

  if (CLONEABLE_ROLES.has(role)) {
    items.push({
      key: 'clone',
      label: 'Clone…',
      ...gate(isStub, isStub ? 'Activate the agent before cloning it.' : undefined),
    });
  }

  // Export is a read-only download and is offered to everyone the Agents page
  // offers it to — the export route carries no management check, so gating it
  // here would take away something a Team Member can do today.
  if (EXPORTABLE_ROLES.has(role) && !isStub) {
    items.push({
      key: 'export',
      label: role === 'team' ? 'Export team (ZIP)' : 'Export (ZIP)',
      disabled: false,
    });
  }

  if (CLONEABLE_ROLES.has(role)) {
    items.push({
      key: 'extract-template',
      label: 'Save as template…',
      ...gate(isStub, isStub ? 'Activate the agent before saving it as a template.' : undefined),
    });
  }

  // Destructive tail. Reset-to-stub is never a one-click action (AC4): the
  // caller opens a confirm dialog, and the entry is marked danger so it reads
  // apart from the reversible ones above.
  items.push({
    key: 'reset-to-stub',
    label: 'Reset to stub…',
    danger: true,
    ...gate(isStub, isStub ? 'Already a stub.' : RESET_TO_STUB_HINT),
  });

  items.push({
    key: 'delete',
    label: 'Delete…',
    danger: true,
    ...gate(false),
  });

  return items;
}

/**
 * Team group-header context-menu items.
 *
 * `team` is the team agent row when it is visible in the list, and `null` when
 * only its members are (a disabled team with the disabled filter off, or a team
 * with no chat identity). Without the team row we don't know its enabled state,
 * so the fan-out toggle is omitted rather than guessed — the actions that need
 * only the team id stay available.
 *
 * @param {object}      o.team        the `role: 'team'` list entry, or null
 * @param {string}      o.teamId      the group's team id (always known)
 * @param {boolean}     o.canManage   server's `canManageAgent` for the team
 * @param {boolean}     o.busy        a team mutation is in flight
 */
export function buildTeamMenu({ team, teamId, canManage = true, busy = false } = {}) {
  if (!teamId) return [];
  const gate = (extraDisabled, extraTitle) => ({
    disabled: !canManage || busy || !!extraDisabled,
    title: !canManage ? NO_RIGHTS_HINT : (extraTitle || undefined),
  });

  const items = [];

  if (team) {
    const teamEnabled = team.enabled !== false;
    items.push({
      key: 'toggle-team',
      label: teamEnabled ? 'Disable team…' : 'Enable team…',
      ...gate(false),
    });
  }

  items.push({ key: 'add-member', label: 'Add member', ...gate(false) });

  // No `add-role:*` entries: the missing-role suggestion was retired in #1959
  // (see docs/admin-console.md). Growing a team is **Add member** above, or the
  // Flow editor — both explicit choices rather than an inferred one.

  // Phase 2 (#1929) replaced Phase 1's jump to the Agents page: the team's own
  // edit form now opens in the chat's Settings tab, which is where AC5 wants
  // team settings reachable from. Gated like the mutating entries because that
  // tab is hidden for a caller who may not manage the team.
  items.push({
    key: 'edit-team',
    label: 'Team settings…',
    ...gate(false, 'Opens the team\'s configuration in the right rail.'),
  });
  items.push({ key: 'export-team', label: 'Export team (ZIP)', disabled: false });
  items.push({ key: 'open-flow-editor', label: 'Open in Flow Editor', disabled: false });
  items.push({ key: 'delete-team', label: 'Delete team…', danger: true, ...gate(false) });

  return items;
}

/**
 * A disabled agent cannot be chatted with — the DM-room route rejects it with a
 * 409 (`Agent disabled`). With the disabled filter on, such a row is listed but
 * must not open a chat (AC6); the row's own Enable entry is the way forward.
 */
export function isChatOpenable(agent) {
  return !!agent && agent.enabled !== false;
}

/**
 * Title / confirm label / width for the delete confirm, given the target that
 * `renderDeleteMessage` renders (the agent plus its `children`).
 *
 * These three strings used to be three inline ternaries at the Agents page's
 * `<ConfirmDialog>`. The chat needs the identical confirm — a delete that names
 * "and 6 members" in one surface and just "Delete" in the other would be the
 * same irreversible action wearing two different warnings — so the decision
 * moves next to the message it belongs to.
 */
export function deleteDialogCopy(target) {
  const role = target?.role;
  const parent = role === 'team' ? 'team' : role === 'orchestrator' ? 'orchestrator' : null;
  const count = parent ? (target?.children?.length ?? 0) : 0;

  if (!parent) {
    return { title: 'Delete agent?', confirmLabel: 'Delete', maxWidth: 440 };
  }

  const title = `Delete ${parent} "${target.displayName ?? target.id}"?`;
  if (count === 0) {
    return { title, confirmLabel: 'Delete', maxWidth: 440 };
  }

  const noun = parent === 'team' ? 'member' : 'mission';
  return {
    title,
    confirmLabel: `Delete ${parent} and ${count} ${noun}${count !== 1 ? 's' : ''}`,
    maxWidth: 560,
  };
}
