'use strict';

// team-conversion.js — pure decision logic for turning ONE standalone agent
// (`role: 'agent'`, no `parentTeamId`) into a team of one, in place (#2052).
//
// The launcher and the one-assistant fast lane have told the user since #1667
// that "a single agent is simply a team of one". Until now nothing backed that
// framing: the only way to get a team was to build a new one and abandon the
// assistant you had been chatting with. This module is the decision half of the
// missing step — `Orchestrator.convertAgentToTeam()` is the thin fs/Matrix/
// respawn wrapper around it, in the same shape `clone-target.js` has for the
// clone/import flows.
//
// ── What the conversion is, mechanically ──────────────────────────────────────
//
// A team record is pure metadata: no Matrix identity, no token, no workspace, no
// container (see `createAgent`'s `role: 'team'` branch). So the conversion never
// has to move the agent: it creates the missing metadata record beside it and
// re-points the agent at it. The agent keeps its id, its Matrix user, its DM
// room, its chat history, its triggers and its Working Environment.
//
// ── The four things that are scoped differently for a member ─────────────────
//
// Re-pointing `parentTeamId` is not free, because four resolutions key on it:
//
//   1. The **effective system prompt**. A member with no own prompt inherits the
//      team's `systemPromptTemplate` (`prompt-modes.js:composeMemberPrompt`).
//      The new team's template is left EMPTY on purpose and the agent's prompt
//      stays its own — so the resolved prompt is byte-identical across the
//      conversion and the user is not handed an inheritance relationship they
//      never asked for. This is written in the platform's **legacy exclusive
//      shape**: a non-empty `systemPrompt` and NO `promptMode` key, which is
//      exactly what `PUT /api/agents/:id` persists for an exclusive member
//      (`api.js`, EXCLUSIVE deletes `promptMode`) and what `resolvePromptMode`
//      reads back as `exclusive`. `updateTeamPrompt` skips exclusive members, so
//      a later team-prompt edit cannot silently rewrite it either. When the
//      prompt only exists as `AGENT-PROMPT.md` on disk the caller passes it in
//      as `promptFallback`, exactly as `importAgent` does. An agent with no
//      prompt at all stays promptless: it then reads as `inherit` over an empty
//      template, which resolves to the same empty string it had before.
//
//   2. The **skill pool**. A skill *grant* is a list of names, but the content
//      is resolved per tier: agent pool → `teams/<agentKnowledgeTeamId>/skills`
//      → global pool (`skill-source.js`). A standalone agent resolves the team
//      tier against its **human tenant** (usually `teams/default`); a member
//      resolves it against its **squad**. Most skills live in the global pool
//      and are unaffected, but a tenant-tier skill would become unreachable —
//      the grant would survive with no content behind it. So the plan names the
//      skills whose content the caller must copy tenant-pool → squad-pool
//      (`skillPoolCopies`), and the caller resolves each tier itself.
//
//   3. The **knowledge scope**. `agentKnowledgeTeamId` flips from the tenant to
//      the new squad id, which re-keys the per-team knowledge config (#570) and
//      through it the KB repo ref + branch. Copying the tenant's overrides onto
//      the new team keeps the agent pointed at the same KB branch, so its
//      existing `knowledge/` checkout stays the right one and its entries stay
//      readable. Nothing is duplicated when the tenant has no overrides — both
//      sides then fall through to the environment's own `knowledgeStore`.
//
//   4. **Plugin scope ids.** At `team` granularity the scope id is the team for
//      a member and the agent's own id for a standalone agent
//      (`plugin-scope.js:resolveScopeId`). Every such grant therefore flips its
//      scope id, and broker resources are labelled `aee.plugin.owner=<scopeId>`
//      with teardown keyed on it — so the plan lists the flips and the caller
//      tears the old scope down BEFORE the new token is minted, rather than
//      orphaning the resources under an id nothing will ever reap.
//
// `agent`-granularity plugin grants, agent-tier (private) skills and context
// mounts are all keyed on the agent's own id, which does not change — they are
// deliberately absent from the plan.
//
// ── Why the grant moves onto the team ────────────────────────────────────────
//
// A member's grant shape is `skillsOverride`/`pluginsOverride` over the team's
// `skills`/`plugins` (`skill-grants.js`, `plugin-grants.js`). The plan writes
// the agent's grant to BOTH: onto the new team (so the second member the user
// adds next inherits the same skills — the whole point of growing) and onto the
// member as an override (so the effective grant is provably unchanged for the
// agent itself, independent of anything later done to the team's list).
//
// Pure: config objects in, a plan object out. No fs, no network, no clock.

const DEFAULT_TEAM_ID = 'default';

// The derived team id is `<agent-id>-team`, not something asked for in the
// dialog: it is predictable, it survives being read back out of a config file,
// and it keeps the confirmation to a single yes/no. The display name is derived
// the same way so the chat-rail group header reads as the user's own agent
// ("Research Assistant Team"), not as an id.
const TEAM_ID_SUFFIX = '-team';
const TEAM_NAME_SUFFIX = ' Team';

// Same shape the console validates agent ids with (api.js AGENT_ID_RE). The
// derived id can only violate it if the agent's own id already did.
const AGENT_ID_RE = /^[a-zA-Z0-9_-]+(\.[a-zA-Z0-9_-]+)*$/;

function deriveTeamId(agentId) {
  return `${String(agentId || '')}${TEAM_ID_SUFFIX}`;
}

function deriveTeamDisplayName(cfg) {
  const base = (cfg && typeof cfg.displayName === 'string' && cfg.displayName.trim())
    ? cfg.displayName.trim()
    : String((cfg && cfg.id) || '');
  return `${base}${TEAM_NAME_SUFFIX}`;
}

// Is this agent convertible? Returns `{ eligible, code, reason }` — one closed
// set of codes, because the answer is consumed in three places (the menu
// predicate, the API refusal and the orchestrator's own re-check) and they must
// agree. AC1: only a materialized standalone agent qualifies.
function assessConversionEligibility(cfg) {
  if (!cfg || typeof cfg !== 'object') {
    return { eligible: false, code: 'not-found', reason: 'the agent does not exist' };
  }
  if (cfg.role === 'team') {
    return { eligible: false, code: 'already-team', reason: 'it is already a team' };
  }
  if (cfg.role === 'team-member' || (typeof cfg.parentTeamId === 'string' && cfg.parentTeamId)) {
    return { eligible: false, code: 'already-member', reason: 'it is already a member of a team' };
  }
  if (cfg.role && cfg.role !== 'agent') {
    return { eligible: false, code: 'unsupported-role', reason: `its role is '${cfg.role}'` };
  }
  if (cfg.ephemeral === true) {
    return { eligible: false, code: 'ephemeral', reason: 'it is an ephemeral agent' };
  }
  if (cfg._provisioning === true || !cfg.token) {
    return {
      eligible: false,
      code: 'stub',
      reason: 'it has not finished provisioning yet (no chat identity)',
    };
  }
  return { eligible: true, code: 'eligible', reason: null };
}

function canConvertToTeam(cfg) {
  return assessConversionEligibility(cfg).eligible;
}

// Build the full conversion plan, or throw with a message the API hands to the
// user verbatim. Throwing (rather than returning a half-plan) is what AC9's "no
// partial state" rests on: every refusal is decided here, before the caller has
// written anything.
//
//   cfg            the standalone agent's config, as loaded from disk
//   teamIdTaken    (id) => bool — does any agent/team already own that id?
//   skills         the agent's resolved effective skill grant (array of names)
//   plugins        its resolved effective plugin grant ([{ id, scopeGranularity }])
//   tenantSkills   names whose CONTENT currently comes from the tenant pool —
//                  the caller resolves the tiers, this module decides what that
//                  means (see `skillPoolCopies`)
//   promptFallback the on-disk AGENT-PROMPT.md text, used only when the config
//                  carries no `systemPrompt` of its own
function planTeamConversion(cfg, {
  teamIdTaken = () => false,
  skills = [],
  plugins = [],
  tenantSkills = [],
  promptFallback = '',
  defaultTeamId = DEFAULT_TEAM_ID,
} = {}) {
  const verdict = assessConversionEligibility(cfg);
  if (!verdict.eligible) {
    throw new Error(`Agent '${(cfg && cfg.id) || '?'}' cannot be converted into a team: ${verdict.reason}`);
  }

  const agentId = cfg.id;
  const teamId = deriveTeamId(agentId);
  if (!AGENT_ID_RE.test(teamId)) {
    throw new Error(`Cannot derive a valid team id from agent '${agentId}'`);
  }
  if (teamIdTaken(teamId)) {
    throw new Error(
      `Cannot convert '${agentId}': the team id '${teamId}' is already taken. `
      + 'Rename or remove that agent first.',
    );
  }

  // AC8 — the new team belongs to the same human tenant as the agent, so the
  // tenant-drift scan (`agent-tenant.js`) has nothing to report.
  const ownerTeamId = cfg.teamId || defaultTeamId;

  // The prompt the agent must still resolve to afterwards (AC4).
  const ownPrompt = (typeof cfg.systemPrompt === 'string' && cfg.systemPrompt.length > 0)
    ? cfg.systemPrompt
    : String(promptFallback || '');

  const grantedSkills = Array.isArray(skills) ? [...skills] : [];
  const grantedPlugins = Array.isArray(plugins) ? plugins.map((p) => ({ ...p })) : [];

  const teamConfig = {
    id: teamId,
    displayName: deriveTeamDisplayName(cfg),
    role: 'team',
    environmentId: cfg.environmentId,
    teamId: ownerTeamId,
    // Deliberately empty — see decision 1 in the header comment.
    systemPromptTemplate: '',
    skills: grantedSkills,
    enabled: true,
    convertedFromAgentId: agentId,
  };
  if (grantedPlugins.length > 0) teamConfig.plugins = grantedPlugins;

  const memberPatch = {
    role: 'team-member',
    parentTeamId: teamId,
    // Token Usage recovers `roleId` by stripping a `<teamId>-` prefix off the
    // member id and falls back to `cfg.role` otherwise. A converted agent keeps
    // its own id, which carries no such prefix, so without this its usage rows
    // would all report the literal role `team-member`. Its own id is the only
    // label that means anything for a team of one.
    roleId: cfg.roleId || agentId,
  };
  // The prompt is only written when there is one — an empty `systemPrompt` key
  // is not the legacy exclusive shape, it is noise that reads as `inherit`
  // anyway (over an empty template, so the resolved prompt is unchanged).
  if (ownPrompt) memberPatch.systemPrompt = ownPrompt;
  if (grantedSkills.length > 0) memberPatch.skillsOverride = grantedSkills;
  if (grantedPlugins.length > 0) memberPatch.pluginsOverride = grantedPlugins;

  // `skills`/`plugins` now live on the team; `promptMode` must go because the
  // legacy exclusive shape is "own prompt, no mode key" and a stale
  // `additional` would compose the agent's prompt onto the team's empty
  // template with a heading it never had. A standalone agent never has a
  // `systemPromptTemplate`, but `importAgent` deletes it defensively on its
  // standalone branch and the mirror case is worth being explicit about.
  const memberUnset = ['skills', 'plugins', 'promptMode', 'systemPromptTemplate'];

  // Only tenant-pool content can go out of reach — global-pool and agent-pool
  // skills resolve identically before and after (decision 2). De-duplicated and
  // narrowed to the actual grant, so a plan never asks for a copy of something
  // the agent was not granted.
  const skillPoolCopies = [...new Set(
    (Array.isArray(tenantSkills) ? tenantSkills : []).filter((n) => grantedSkills.includes(n)),
  )];

  // Team-granularity grants are the only ones whose scope id moves (decision 4).
  const pluginScopeChanges = grantedPlugins
    .filter((p) => (p.scopeGranularity || 'team') === 'team')
    .map((p) => ({ pluginId: p.id, from: agentId, to: teamId }));

  return {
    agentId,
    teamId,
    ownerTeamId,
    teamConfig,
    memberPatch,
    memberUnset,
    skillPoolCopies,
    pluginScopeChanges,
    knowledgeScope: { from: ownerTeamId, to: teamId },
    effectivePrompt: ownPrompt,
  };
}

module.exports = {
  DEFAULT_TEAM_ID,
  TEAM_ID_SUFFIX,
  TEAM_NAME_SUFFIX,
  deriveTeamId,
  deriveTeamDisplayName,
  assessConversionEligibility,
  canConvertToTeam,
  planTeamConversion,
};
