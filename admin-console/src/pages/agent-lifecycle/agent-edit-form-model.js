/**
 * agent-edit-form-model.js — the pure state/shape logic behind the agent edit
 * form.
 *
 * These three functions used to be inlined in `AgentEditForm` (Agents.jsx):
 * the initial-values derivation, the `PUT /api/agents/:id` body builder, and
 * the "is anything different from what the server has" question. #1929 hosts
 * the same form a second time — as the Agent Chat right rail's Settings tab —
 * and a second surface makes them worth having on their own:
 *
 *   - the save shape is the contract both surfaces must produce identically
 *     (AC2), and it is testable here without rendering anything (`node --test`
 *     does not load JSX, #651);
 *   - the chat needs `isFormDirty` to decide whether a draft has to survive an
 *     agent switch (AC6), which the Agents page never had to ask.
 *
 * Nothing about the derivation changed in the move.
 */
import { PROMPT_MODES, resolvePromptMode } from '../prompt-mode-view.js';
import { scalingDraftFromPool, scalingSaveDecision } from '../process/scaling-view.js';
import { initialMcpRows } from '../working-env-mcp-view.js';
import { memberMcpSubmitValue, sameMcpRows } from './member-mcp-view.js';

/**
 * Roles whose skills live on the agent construct itself, rather than being
 * inherited from (or overriding) a parent team.
 *
 * `orchestrator` left the set with the role (#1964): a leftover config is not
 * editable through this form any more, and keeping it here would render a skill
 * picker whose grant nothing resolves.
 */
export function hasOwnSkills(role) {
  return role === 'team' || role === 'agent';
}

/**
 * Initial form state for an agent config.
 *
 * `agent.systemPrompt` / `agent.skillsOverride` / `agent.mcpServersOverride`
 * being *absent* is what "inherit from the team" means — an empty array is a
 * deliberate empty override, so the checks are `Array.isArray`, never length.
 *
 * @param {object} agent  the agent config (`GET /api/agents/:id`)
 * @returns {object} form state
 */
export function buildInitialForm(agent) {
  const a = agent || {};
  const isMember = a.role === 'team-member';

  // System-prompt mode (#1511): resolve the three-way mode from the config
  // (explicit `promptMode`, else legacy systemPrompt-presence inference).
  const promptMode = isMember ? resolvePromptMode(a) : PROMPT_MODES.INHERIT;

  // MCP overrides are stored as [{serverId, credentialId|null}, ...] and
  // edited as the picker's form rows (#2289 — they used to be a free-text
  // "serverId:credentialId" per line). An inheriting member starts with no
  // rows; switching to Custom pre-fills them (member-mcp-view.js, D1).
  const mcpRows = initialMcpRows({ mcpServers: a.mcpServersOverride });

  return {
    displayName: a.displayName || '',
    // non-member roles: the agent's own skill grant
    skills: Array.isArray(a.skills) ? a.skills : [],
    // team-only field
    systemPromptTemplate: a.systemPromptTemplate || '',
    // team-member override fields. `promptMode` is one of inherit/additional/
    // exclusive (#1511); `promptOverride` holds the agent-specific text — the
    // addition (additional mode) or the full override (exclusive). One shared
    // text field so switching between additional/exclusive keeps typed text.
    promptMode,
    promptOverride: a.systemPrompt || '',
    inheritSkills: isMember && !Array.isArray(a.skillsOverride),
    skillsOverride: Array.isArray(a.skillsOverride) ? a.skillsOverride : [],
    inheritMcp: isMember && !Array.isArray(a.mcpServersOverride),
    mcpRows,
    // Scaling (#2271, folded into this form's one Save by #2295 AC11/AC12 —
    // ScalingSection is now a controlled draft, not a second Save button).
    // Only a team-member carries `pool`; a blank/disabled draft off-role is
    // harmless (never submitted — see `buildEditSubmit`).
    poolDraft: scalingDraftFromPool(isMember ? a.pool : null),
  };
}

/**
 * The `PUT /api/agents/:id` body for a form state.
 *
 * Role decides which sections are sent at all — a field the role does not have
 * must be absent rather than empty, or the save would clear it server-side.
 * Plugin grants and context mounts are deliberately NOT here: they have their
 * own immediate-apply endpoints (see `PluginGrantSection` / `ContextMountControl`).
 *
 * @param {object} agent  the agent config the form was opened on
 * @param {object} form   current form state
 * @param {object} [opts]
 * @param {?number} opts.parentWipLimit  the parent team's wipLimit, needed to
 *   validate an enabled `poolDraft` (`scalingSaveDecision`'s one gate) —
 *   callers must check `poolSectionError` first and never call this with an
 *   invalid draft (#2295 AC11: Scaling folds into this one Save, so an
 *   invalid Scaling input has to block the save the same way it used to
 *   block ScalingSection's own button).
 * @returns {object} request body
 */
export function buildEditSubmit(agent, form, opts = {}) {
  const a = agent || {};
  // `briefingsPath` is deliberately absent since #1964: the field is gone from
  // the form and #1962 removed it from the config, so sending it would be this
  // surface re-introducing a key nothing reads.
  const submit = {
    displayName: form.displayName,
  };
  if (hasOwnSkills(a.role)) {
    submit.skills = form.skills;
  }
  if (a.role === 'team') {
    submit.systemPromptTemplate = form.systemPromptTemplate;
  }
  if (a.role === 'team-member') {
    // System-prompt mode (#1511). `promptMode` selects one of the three modes;
    // `systemPrompt` carries the agent-specific text (null = inherit → clear
    // the override). The API composes the effective prompt from the two.
    submit.promptMode = form.promptMode;
    submit.systemPrompt = form.promptMode === PROMPT_MODES.INHERIT
      ? null
      : form.promptOverride;
    submit.skillsOverride = form.inheritSkills ? null : form.skillsOverride;
    // MCP override (#2289): null = inherit (the key is cleared), else the
    // picker rows in the {serverId, credentialId} shape the API stores — an
    // empty Custom set stays [] ("no MCP servers"). Blank/duplicate rows are
    // blocked before this is called (memberMcpBlockers).
    submit.mcpServersOverride = memberMcpSubmitValue(form.inheritMcp, form.mcpRows);
    // Scaling (#2271/#2295 AC11) — the section's own component no longer PUTs
    // for itself; its draft folds into this same body. A caller that skipped
    // `poolSectionError` and calls this with an invalid draft gets `pool`
    // omitted rather than a half-formed value (defensive; the real gate is
    // `poolSectionError`, checked before this is ever called).
    const decision = scalingSaveDecision(form.poolDraft, opts.parentWipLimit);
    if (!decision.error) submit.pool = decision.payload;
  }
  return submit;
}

/**
 * Whether the form's Scaling draft may be saved right now, and why not if
 * not — the same gate `ScalingSection`'s own button used to enforce, now
 * checked by the host before it calls `buildEditSubmit` (#2295 AC11: an
 * invalid Scaling input blocks the WHOLE Save, not just its own section).
 *
 * @returns {?string} a reason, or `null` when the draft may be saved.
 */
export function poolSectionError(agent, form, opts = {}) {
  if ((agent && agent.role) !== 'team-member') return null;
  return scalingSaveDecision(form.poolDraft, opts.parentWipLimit).error;
}

function sameList(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

function samePoolDraft(a, b) {
  if (!a || !b) return a === b;
  return a.enabled === b.enabled
    && a.maxInstancesText === b.maxInstancesText
    && a.workspace === b.workspace
    && a.idleText === b.idleText
    && a.hardText === b.hardText
    && a.retainText === b.retainText;
}

/**
 * Does `form` differ from the state the agent's config would produce?
 *
 * Compared field by field (rather than by serialising) so a key-order change or
 * an added field can never read as "clean" by accident: a new key that
 * `buildInitialForm` produces has to be listed here to be watched, and one that
 * is not watched shows up as a missing case in the test rather than as a
 * silently lost draft.
 *
 * Only the batched (Save-button) fields count. Plugin grants and context mounts
 * apply immediately through their own endpoints, so they are never "unsaved".
 *
 * @param {object} agent  the agent config the form was opened on
 * @param {object} form   current form state, or null/undefined for "no draft"
 * @returns {boolean}
 */
export function isFormDirty(agent, form) {
  if (!form) return false;
  const base = buildInitialForm(agent);
  return (
    base.displayName !== form.displayName
    || !sameList(base.skills, form.skills)
    || base.systemPromptTemplate !== form.systemPromptTemplate
    || base.promptMode !== form.promptMode
    || base.promptOverride !== form.promptOverride
    || base.inheritSkills !== form.inheritSkills
    || !sameList(base.skillsOverride, form.skillsOverride)
    || base.inheritMcp !== form.inheritMcp
    // Rows only matter in Custom: in Inherit they are not sent, so a Custom
    // pre-fill left behind by flipping back to Inherit is not a change.
    || (!form.inheritMcp && !sameMcpRows(base.mcpRows, form.mcpRows))
    || !samePoolDraft(base.poolDraft, form.poolDraft)
  );
}
