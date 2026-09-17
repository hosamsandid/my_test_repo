/**
 * agent-settings-view.js — the pure decisions behind Agent Chat's Settings tab
 * (#1929, epic #1925 Phase 2).
 *
 * The tab renders the Agents page's own edit form (`agent-lifecycle/AgentEditForm`),
 * so nothing about *the form* lives here. What the chat has to decide on its own
 * is everything the Agents page never had to ask:
 *
 *   - **Whose** settings am I showing? Usually the agent whose chat is open, but
 *     the rail can point the tab at another agent — a team (whose settings have
 *     no chat of their own, AC5) or a disabled agent (which has no chat at all,
 *     AC10). That override is what makes both reachable without a second surface.
 *   - **May this caller edit?** `/api/matrix/agents` ships `canManage` per entry
 *     (#1928), the same boundary the mutating routes enforce, so the tab can be
 *     hidden rather than offered-then-refused (AC8).
 *   - **What happens to a half-typed edit** when the user switches agent? The
 *     answer here is *preserve it* (AC6): drafts are kept per agent for as long
 *     as the chat page lives, so coming back finds the form as it was left. The
 *     alternative — blocking the switch behind a confirm — would put a modal in
 *     front of a list click, which is the one interaction the rail is for.
 */

/**
 * Which agent the Settings tab is for, and whether the tab exists at all.
 *
 * An explicit override always wins and is always visible: it only ever arrives
 * from a rail menu entry or a team header-row click (#2213), both gated on
 * `canManage` before they set it, and the server re-checks on the PUT
 * regardless. Without one, the tab follows the open chat and disappears for a
 * caller who may not manage that agent.
 *
 * @param {object}  o
 * @param {?string} o.chatAgentId    the agent whose chat is open, or null
 * @param {boolean} o.chatCanManage  `canManage` of that agent (default true — an
 *                                   entry from before #1928 carries no flag and
 *                                   must not lose the tab)
 * @param {?string} o.overrideId     agent the rail pointed the tab at, or null
 * @returns {{agentId: ?string, visible: boolean, override: boolean}}
 */
export function settingsSubject({ chatAgentId = null, chatCanManage = true, overrideId = null } = {}) {
  if (overrideId) {
    return { agentId: overrideId, visible: true, override: overrideId !== chatAgentId };
  }
  if (!chatAgentId || chatCanManage === false) {
    return { agentId: null, visible: false, override: false };
  }
  return { agentId: chatAgentId, visible: true, override: false };
}

/**
 * What a successful Save means for the conversation the user is looking at.
 *
 * Open question 1 is answered with an explicit inline notice rather than
 * silence: on the Agents page "takes effect next run" is abstract, but here the
 * next run is the next message in the thread on screen — so say so. A team's
 * save lands on its members instead, which is a different sentence.
 *
 * @param {object} agent  the saved agent config
 * @returns {string}
 */
export function savedNoticeText(agent) {
  const role = (agent && agent.role) || 'agent';
  if (role === 'team') {
    return 'Saved. The team prompt propagates to every inheriting member; each picks it up on its next run.';
  }
  return 'Saved. Prompt and skill changes take effect on this agent\'s next run — the conversation above is unaffected.';
}

/**
 * What an immediate-apply change did to the live conversation.
 *
 * Context folders re-provision the container, so the run that was in flight is
 * gone and the next message opens a fresh session — the chat must not just say
 * "saved" (AC4).
 *
 * Attaching or removing an agent-scoped repository (#2067) is the OPPOSITE
 * case, and saying otherwise would be worse than saying nothing: the workspace
 * volume is shared with the running container, so the clone lands additively
 * with no respawn (the #1342 Sync-repositories mechanism) and the conversation
 * above is untouched. Only the prompt has to catch up, which it does on the
 * agent's next run.
 *
 * @param {object} info  `{ kind, respawned }` from the applying control
 * @returns {string}
 */
export function restartNoticeText(info) {
  if (info && info.kind === 'agent-repositories') {
    return 'Repositories updated. The workspace changed immediately; the agent is told about it '
      + 'from its next run on. The conversation above is unaffected.';
  }
  // Agent pools (#2271) used to apply immediately through ScalingSection's own
  // Save and reported here as `kind: 'pool'`; #2295 folded Scaling into this
  // form's one batched Save, so it is covered by `savedNoticeText` now, not
  // this immediate-apply path.
  return info && info.respawned
    ? 'Host context folders applied — the agent\'s container was re-provisioned. Any run in progress ended; the next message starts a fresh session.'
    : 'Host context folders saved. They are attached the next time the agent starts.';
}

/* ── Draft preservation (AC6) ─────────────────────────────────────────
   A plain object keyed by agent id, replaced rather than mutated so the
   caller can hold it in a ref and the transitions stay testable. Drafts live
   only as long as the chat page does — a reload is a deliberate fresh start,
   not a silent loss, because nothing on screen claimed the edit was kept. */

/** Record (or replace) the in-progress form state for one agent. */
export function putDraft(store, agentId, form) {
  if (!agentId) return store || {};
  return { ...(store || {}), [agentId]: form };
}

/** The preserved form state for one agent, or null when there is none. */
export function getDraft(store, agentId) {
  if (!store || !agentId) return null;
  return Object.prototype.hasOwnProperty.call(store, agentId) ? store[agentId] : null;
}

/** Forget one agent's draft — after a successful save, or an explicit discard. */
export function dropDraft(store, agentId) {
  if (!store || !agentId || !Object.prototype.hasOwnProperty.call(store, agentId)) {
    return store || {};
  }
  const next = { ...store };
  delete next[agentId];
  return next;
}

/**
 * The banner shown above a form whose draft was carried across an agent switch.
 * Silence would be the "silently lost" failure mode in reverse: the user would
 * be looking at values that are not what the server has and not what they last
 * saw here.
 */
export function unsavedDraftNotice(dirty) {
  return dirty
    ? 'Unsaved changes — kept from earlier in this session. Save them, or discard to go back to the stored configuration.'
    : '';
}
