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
// `orchestrator` left this set with the role (#1964): the export it enabled
// produced a bundle whose only consumer — an import that re-creates the role —
// the platform refuses since #1962.
const EXPORTABLE_ROLES = new Set(['agent', 'team-member', 'team']);
// Converting into a team of one (#2052) is offered to the standalone role
// ALONE: a `team` already is one, a `team-member` already belongs to one, and
// there is no reverse conversion, so a near-miss here is not a cosmetic bug.
// `expert` is the pre-#1961 name the orchestrator normalizes to `agent` on
// startup, listed so a config read before that normalization has landed still
// offers the entry.
const CONVERTIBLE_ROLES = new Set(['agent', 'expert']);

/**
 * The hint on **Share…** for someone who may see the team but not administer it
 * (#2082, #2041 AC9). Deliberately not `NO_RIGHTS_HINT`: the entry stays
 * ENABLED, because the member list is something a Team Member may *read* — what
 * they may not do is change it, and the panel says so again where the controls
 * would be. #2041 AC8 asks for the entry to be disabled with a hint, which
 * cannot be reconciled with AC9's read-only list (a disabled entry opens
 * nothing) — and AC12/P6 retires the Access page's Manage panel as "superseded
 * by the Share dialog", so disabling it here would remove a member's only way
 * to see who else is on their team. The hint is delivered, the read is not.
 */
export const MEMBERS_READ_ONLY_HINT =
  'You can see who has access; only a Team Admin for this team can change it.';

/** The same entry for someone who *can* change the list — what it opens. */
export const MEMBERS_MANAGE_HINT =
  'Add colleagues to this team, change their role, or remove them.';

/** Converting is one-way — the entry says so before it is clicked, not after. */
export const CONVERT_TO_TEAM_HINT =
  'Turn this assistant into a team of one, keeping its prompt, skills, '
  + 'triggers and chat history. Cannot be undone.';

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

  // Enable / Disable / Materialize. The team lock only ever blocks *enabling* a
  // member on the Agents page (the toggle is disabled outright); mirror that
  // here.
  //
  // For a stub the entry is labelled **Materialize** (#1957): the operation is
  // the same `PUT { enabled: true }` the Agents page's *Activate* button sends —
  // deliberately the same key, so there is one code path — but "Enable" reads
  // as flipping a switch on something that exists, and what actually happens
  // is a Matrix user, a workspace seed and the repo clones. The Agents page
  // already says *Activate* for this state; the menu should not be the one
  // surface that understates it.
  items.push({
    key: 'toggle-enabled',
    label: isStub ? 'Materialize' : enabled ? 'Disable' : 'Enable',
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

  // Grow into a team (#2052). Not in the destructive tail and not marked
  // danger: nothing is lost, the agent keeps everything it has. But it IS
  // one-way, so it always opens a confirm (the trailing "…") and carries the
  // hint above rather than leaving "what happens to my assistant?" to the
  // dialog alone.
  if (CONVERTIBLE_ROLES.has(role)) {
    items.push({
      key: 'convert-to-team',
      label: 'Convert into a team…',
      ...gate(isStub, isStub ? 'Materialize the agent before converting it.' : CONVERT_TO_TEAM_HINT),
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
 * @param {boolean}     o.canManageMembers  server's `canManageTeam` — may this
 *                      caller change the MEMBER LIST? Defaults to `canManage`
 *                      because for a `role: 'team'` row the two predicates
 *                      resolve identically today; it is a separate input so a
 *                      change to the agent predicate cannot silently open the
 *                      member list (#2041 §7.1).
 * @param {boolean}     o.busy        a team mutation is in flight
 */
export function buildTeamMenu({
  team, teamId, canManage = true, canManageMembers = canManage, busy = false,
} = {}) {
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
  // Sharing (#2082, #2041 P4): who may open, chat with and administer this
  // team. The one entry in this menu that stays live without rights, because
  // reading the member list is a Team-Member right (D9) — see
  // MEMBERS_READ_ONLY_HINT for why AC8's `disabled` is deliberately not applied.
  items.push({
    key: 'share',
    label: 'Share…',
    disabled: busy,
    title: canManageMembers ? MEMBERS_MANAGE_HINT : MEMBERS_READ_ONLY_HINT,
  });
  items.push({ key: 'export-team', label: 'Export team (ZIP)', disabled: false });
  // Clone team (#2171, epic #2166 A5): a new, independent team with this
  // one's structure — repositories, MCP refs, toolchain, context — and none
  // of its credentials. Ungated like Export team: it reads the source team's
  // structure (never a secret) and creates a wholly separate team, so it
  // needs no more right over the source than any other visible row has.
  items.push({ key: 'clone-team', label: 'Clone team…', disabled: busy });
  items.push({ key: 'open-flow-editor', label: 'Open in Flow Editor', disabled: false });
  items.push({ key: 'delete-team', label: 'Delete team…', danger: true, ...gate(false) });

  return items;
}

/**
 * A disabled agent cannot be chatted with — the DM-room route rejects it with a
 * 409 (`Agent disabled`). With the disabled filter on, such a row is listed but
 * must not open a chat (AC6); the row's own Enable entry is the way forward.
 *
 * A `role: 'team'` agent hosts no chat/session of its own either (#2213) — it
 * has no `dmRoomId`, so selecting it must not attempt to open one against a
 * null room. Its row instead moves the selection onto the team and opens the
 * Settings tab (see `AgentList.jsx`'s `CollapsibleHeader`).
 */
export function isChatOpenable(agent) {
  return !!agent && agent.enabled !== false && agent.role !== 'team';
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
 *
 * A team is the only cascading parent since #1964; a leftover orchestrator
 * config gets the plain single-agent confirm, which is honest — `deleteTargetFor`
 * no longer collects bp-instances, so nothing else would go with it here.
 */
export function deleteDialogCopy(target) {
  const isTeam = target?.role === 'team';
  const count = isTeam ? (target?.children?.length ?? 0) : 0;

  if (!isTeam) {
    return { title: 'Delete agent?', confirmLabel: 'Delete', maxWidth: 440 };
  }

  const title = `Delete team "${target.displayName ?? target.id}"?`;
  if (count === 0) {
    return { title, confirmLabel: 'Delete', maxWidth: 440 };
  }

  return {
    title,
    confirmLabel: `Delete team and ${count} member${count !== 1 ? 's' : ''}`,
    maxWidth: 560,
  };
}

/**
 * Message for a team delete whose cascade could not remove every member (#1960).
 *
 * `DELETE /api/agents/:id` answers 204 with no body when the cascade was clean,
 * so `apiCall` hands us `null` and this returns `null` too — the overwhelmingly
 * common path stays silent. It is only when the server reports residue
 * (`cascadeWarnings`, the `{ id, kind, error }` shape the team fan-out uses)
 * that the caller gets a sentence, because a member left half-deleted is
 * exactly what nobody must be told "all done" about.
 *
 * Names the ids: the whole point of reporting residue is that an operator can
 * go and finish it (the orphan cleanup, or deleting the member on its own).
 */
export function cascadeResidueNotice(response) {
  const warnings = response && Array.isArray(response.cascadeWarnings)
    ? response.cascadeWarnings.filter(w => w && w.id)
    : [];
  if (warnings.length === 0) return null;
  const ids = warnings.map(w => w.id).join(', ');
  const noun = warnings.length === 1 ? 'member' : 'members';
  return `The team was deleted, but ${warnings.length} ${noun} could not be removed: ${ids}. `
    + 'They are left behind as orphaned agents — a System Admin can clear them with the orphan cleanup.';
}
