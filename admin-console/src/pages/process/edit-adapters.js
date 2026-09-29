// edit-adapters.js — write-target abstraction for the Process Canvas editing UI
// (Process Canvas v2, #345).
//
// The same dialogs/inspector edit either a LIVE agent (writes through to the
// running agent via the HTTP API) or a DRAFT bundle (mutates an in-memory
// process-template bundle and persists it via the drafts API). Both expose the
// same surface so the UI doesn't branch on mode.

import { apiCall } from '../../hooks/useApi';
import { PROMPT_MODES } from '../prompt-mode-view.js';
import { wouldCreateCycle } from './hierarchy-utils';
import { upsertChannel, removeChannelFrom } from './channel-ops';
import {
  stagesAfterAdd, stagesAfterRename, stagesAfterRemove, stagesAfterReorder, membersToCascade,
} from './stage-list-ops';
import { labelsAfterSet } from './label-registry-ops';
import {
  humansAfterUpsert, humansAfterRemove,
  humanAfterConsumeAdd, humanAfterConsumeRemove, humanAfterEmitAdd, humanAfterEmitRemove,
} from './humans-registry-ops';
import { parseGitHubUrl } from '../../components/repository-url-view.js';

// owner/repo from a repository URL, for a canvas-created github-event trigger.
// Delegates to the shared `parseGitHubUrl` (#2345) rather than keep a partial
// regex copy of it — one parser now recognizes every github.com URL form
// (git@, ssh://, https with optional www., bare github.com), and the fullName
// is scheme-independent (`<org>/<repo>`), which is exactly what the poller
// matches on.
function parseRepoFullName(url) {
  const parsed = parseGitHubUrl(url);
  return parsed ? `${parsed.org}/${parsed.repo}` : null;
}

// The repo a canvas-created github-event trigger should poll: the first
// parsable repository of the agent's working environment. The connect dialogs
// deliberately have no repo input (the repo is unknown while modelling), and
// the poller skips triggers without one — so the live adapter fills it in.
async function resolveAgentRepo(roleId) {
  try {
    const a = await apiCall('GET', `/api/agents/${roleId}`);
    if (!a || !a.environmentId) return null;
    const env = await apiCall('GET', `/api/environments/${a.environmentId}`);
    const repos = Array.isArray(env?.repositories) ? env.repositories
      : (env?.repository ? [env.repository] : []);
    for (const r of repos) {
      const full = parseRepoFullName(r && r.url);
      if (full) return full;
    }
  } catch { /* best-effort — the trigger is still created, repo can be set later */ }
  return null;
}
// An artifact port's match key: its logical name when set, else its path (#382).
const artKey = (a) => (typeof a === 'string' ? a : (a && (a.name || a.path))) || '';
// Set/clear an artifact's human audience (#981); string-shaped legacy ports are
// lifted to objects so the flag has somewhere to live.
const setAudienceOn = (a, audience) => {
  const base = typeof a === 'string' ? { path: a } : { ...a };
  if (audience === 'human') base.audience = 'human'; else delete base.audience;
  return base;
};
// Set/clear an artifact output's open-end marker (#1004): `marker` is
// `{terminal: true}`, `{external: {note?}}` or null. Terminal XOR external.
const setMarkerOn = (a, marker) => {
  const base = typeof a === 'string' ? { path: a } : { ...a };
  delete base.terminal; delete base.external;
  if (marker && marker.terminal === true) base.terminal = true;
  else if (marker && marker.external && typeof marker.external === 'object') {
    base.external = {
      ...(typeof marker.external.note === 'string' && marker.external.note.trim()
        ? { note: marker.external.note.trim() } : {}),
    };
  }
  return base;
};
// Read the current data-flow port block off a live agent's config as a plain
// {inputs, outputs, dependsOn} shape (read-modify-write helper). The PUT replaces
// the whole `dataFlow` block, matching how a draft persists the whole bundle.
async function liveDataFlow(roleId) {
  const a = await apiCall('GET', `/api/agents/${roleId}`);
  const df = (a && typeof a.dataFlow === 'object' && a.dataFlow) || {};
  return {
    inputs: Array.isArray(df.inputs) ? df.inputs.slice() : [],
    outputs: Array.isArray(df.outputs) ? df.outputs.slice() : [],
    dependsOn: Array.isArray(df.dependsOn) ? df.dependsOn.slice() : [],
  };
}

// Cascade a live stage rename/remove to every member whose per-agent `stage`
// equals `oldName` (#674, AC4). `newStage=''` clears it (remove → inherit/none).
// Best-effort + sequential (AC8): a failed member write is swallowed so the
// rest still apply; a stranded reference renders as inherit/none in the picker.
async function cascadeMemberStage(teamId, oldName, newStage) {
  if (!oldName) return;
  let members = [];
  try {
    const all = await apiCall('GET', '/api/agents');
    members = membersToCascade(all, teamId, oldName);
  } catch { return; /* can't enumerate — leave refs to self-heal in the picker */ }
  for (const m of members) {
    try { await apiCall('PUT', `/api/agents/${m.id}`, { stage: newStage || '' }); }
    catch { /* best-effort: dangling ref self-heals to inherit/none */ }
  }
}

// Live mode — every op is an HTTP call against the running agent. Its surface is
// shape-compatible with makeDraftOps: the editing UI never branches on mode.
// Edge ops write only the declarative ports (dataFlow / parentMemberId / stage);
// the backend re-derives the functional push triggers from those ports.
export const liveOps = {
  mode: 'live',
  listTriggers: (roleId) => apiCall('GET', `/api/agents/${roleId}/triggers`),
  createTrigger: async (roleId, body) => {
    let b = body;
    if (b && b.type === 'github-event' && !b.repo) {
      const repo = await resolveAgentRepo(roleId);
      if (repo) b = { ...b, repo };
    }
    return apiCall('POST', `/api/agents/${roleId}/triggers`, b);
  },
  updateTrigger: (roleId, tid, body) => apiCall('PUT', `/api/agents/${roleId}/triggers/${tid}`, body),
  deleteTrigger: (roleId, tid) => apiCall('DELETE', `/api/agents/${roleId}/triggers/${tid}`),
  // Trigger-level `emits` was removed (#783) — label hand-offs live on the agent
  // level (setRoleEmits below), so there is no per-trigger setEmits any more.
  // Display name (#692) — safe on a live agent: it is display-only and does not
  // change the agent id (that is immutable once materialized). Shape-compatible
  // with makeDraftOps.renameRole so the shared inspector never branches on mode.
  renameRole: (roleId, displayName) => apiCall('PUT', `/api/agents/${roleId}`, { displayName }),
  // Structured OUTCOMES port (#827) — the successor to flat `emits`. Shape-compatible
  // with makeDraftOps.getRoleOutcomes/setRoleOutcomes so the phase-3 UI never
  // branches on mode. Writing a non-empty port CLEARS `emits` server-side
  // (PUT /api/agents/:id), so the two never coexist.
  getRoleOutcomes: async (roleId) => {
    const a = await apiCall('GET', `/api/agents/${roleId}`);
    return a && typeof a.outcomes === 'object' && a.outcomes ? a.outcomes : null;
  },
  setRoleOutcomes: (roleId, outcomes) => apiCall('PUT', `/api/agents/${roleId}`, { outcomes: outcomes || null }),

  // ── unified edges (#367): dependency + data-flow + hierarchy + stage ──
  // Dependency A→B means "B depends on A" (A upstream), stored on B.dataFlow.dependsOn.
  addDependency: async (roleId, dependsOnId) => {
    if (!dependsOnId || dependsOnId === roleId) return;
    const df = await liveDataFlow(roleId);
    if (!df.dependsOn.includes(dependsOnId)) df.dependsOn.push(dependsOnId);
    await apiCall('PUT', `/api/agents/${roleId}`, { dataFlow: df });
  },
  removeDependency: async (roleId, dependsOnId) => {
    const df = await liveDataFlow(roleId);
    df.dependsOn = df.dependsOn.filter(d => d !== dependsOnId);
    await apiCall('PUT', `/api/agents/${roleId}`, { dataFlow: df });
  },
  // Data flow: a producer's output artifact matches a consumer's input artifact
  // by logical `name` (or `path` when unnamed). `hint` is the informative path.
  addArtifact: async (roleId, { direction, name, hint, path, description }) => {
    const nm = String(name || '').trim();
    const h = String(hint || '').trim();
    const p = String(path || '').trim();
    const key = nm || p;               // a hint alone is not a match key
    if (!key) return;
    const port = {
      ...(nm ? { name: nm } : {}), ...(h ? { hint: h } : {}),
      ...(p ? { path: p } : {}), ...(description ? { description } : {}),
    };
    const df = await liveDataFlow(roleId);
    const k = direction === 'output' ? 'outputs' : 'inputs';
    if (!df[k].some(a => artKey(a) === key)) df[k].push(port);
    await apiCall('PUT', `/api/agents/${roleId}`, { dataFlow: df });
  },
  removeArtifact: async (roleId, { direction, name, path }) => {
    const key = String(name || path || '').trim();
    if (!key) return;
    const df = await liveDataFlow(roleId);
    const k = direction === 'output' ? 'outputs' : 'inputs';
    df[k] = df[k].filter(a => artKey(a) !== key);
    await apiCall('PUT', `/api/agents/${roleId}`, { dataFlow: df });
  },
  // Artifact audience (#981): declare that a PERSON consumes this output —
  // clears the unconsumed-output lint and draws the delivery edge to @human.
  setArtifactAudience: async (roleId, { name, path, audience }) => {
    const key = String(name || path || '').trim();
    if (!key) return;
    const df = await liveDataFlow(roleId);
    df.outputs = df.outputs.map(a => (artKey(a) === key
      ? setAudienceOn(a, audience) : a));
    await apiCall('PUT', `/api/agents/${roleId}`, { dataFlow: df });
  },
  // Open-end marker on an output artifact (#1004): `marker` is
  // `{terminal: true}`, `{external: {note?}}` or null (unmark).
  setArtifactMarker: async (roleId, { name, path, marker }) => {
    const key = String(name || path || '').trim();
    if (!key) return;
    const df = await liveDataFlow(roleId);
    df.outputs = df.outputs.map(a => (artKey(a) === key ? setMarkerOn(a, marker) : a));
    await apiCall('PUT', `/api/agents/${roleId}`, { dataFlow: df });
  },
  // Parent-child hierarchy (#377) — child gets parentMemberId; cleared with falsy.
  setParent: (roleId, parentId) =>
    apiCall('PUT', `/api/agents/${roleId}`, { parentMemberId: parentId || null }),
  // Process stage band — empty clears (inherits from parent).
  setStage: (roleId, stage) => apiCall('PUT', `/api/agents/${roleId}`, { stage: stage || '' }),
  // Live agent prompt (#2295) — batched into the Details Save instead of the
  // live prompt editor's own "Save prompt" button. Two write paths, driven by
  // one call: a team-member's prompt lives on the agent config itself
  // (PUT /api/agents/:id), a non-member's in its prompt file
  // (PUT /api/agents/:id/prompt) — never both for the same agent.
  setLivePrompt: (roleId, { role, promptMode, text }) => (
    role === 'member'
      ? apiCall('PUT', `/api/agents/${roleId}`, {
        promptMode,
        systemPrompt: promptMode === PROMPT_MODES.INHERIT ? null : text,
      })
      : apiCall('PUT', `/api/agents/${roleId}/prompt`, { content: text })
  ),
  // Agent pools (#2271/#2295) — batched into the host's single Save instead
  // of ScalingSection's own. `pool` is the already-built PUT body
  // (`scalingSaveDecision`'s payload — `null` clears it).
  setPool: (roleId, pool) => apiCall('PUT', `/api/agents/${roleId}`, { pool }),

  // ── stages (live, #674): the ordered list drives the layered-DAG layout. It
  // lives on the TEAM agent config (role 'team'); members carry a per-agent
  // `stage`. These ops take the teamId as the first arg (bound by ProcessCanvas
  // into a name-only wrapper for StageManager, so its contract is unchanged)
  // and mirror makeDraftOps' semantics. rename/remove cascade to members via a
  // BEST-EFFORT sequential loop (AC8): a per-member write failure is swallowed
  // so the remaining members still update — a stranded `stage` reference simply
  // renders as inherit/none in the dropdown (self-healing, display-only, no
  // respawn — see AC6/AC8). Reorder never touches a member's stage (AC edge).
  listStages: async (teamId) => {
    const a = await apiCall('GET', `/api/agents/${teamId}`);
    return Array.isArray(a?.stages) ? a.stages.slice() : [];
  },
  addStage: async (teamId, name) => {
    const cur = await liveOps.listStages(teamId);
    const next = stagesAfterAdd(cur, name);
    if (next.length === cur.length) return; // no-op (blank or already present)
    await apiCall('PUT', `/api/agents/${teamId}`, { stages: next });
  },
  renameStage: async (teamId, oldName, newName) => {
    const cur = await liveOps.listStages(teamId);
    const next = stagesAfterRename(cur, oldName, newName);
    await apiCall('PUT', `/api/agents/${teamId}`, { stages: next });
    await cascadeMemberStage(teamId, oldName, String(newName || '').trim());
  },
  removeStage: async (teamId, name) => {
    const cur = await liveOps.listStages(teamId);
    await apiCall('PUT', `/api/agents/${teamId}`, { stages: stagesAfterRemove(cur, name) });
    await cascadeMemberStage(teamId, name, '');
  },
  reorderStages: async (teamId, names) => {
    const cur = await liveOps.listStages(teamId);
    await apiCall('PUT', `/api/agents/${teamId}`, { stages: stagesAfterReorder(cur, names) });
  },

  // ── label registry (#981): gate/brake flags, TEAM-agent only ──
  // Same binding pattern as the stage ops: teamId first, ProcessCanvas wraps.
  listLabels: async (teamId) => {
    const a = await apiCall('GET', `/api/agents/${teamId}`);
    return Array.isArray(a?.labels) ? a.labels.slice() : [];
  },
  setLabelFlags: async (teamId, name, flags) => {
    const cur = await liveOps.listLabels(teamId);
    await apiCall('PUT', `/api/agents/${teamId}`, { labels: labelsAfterSet(cur, name, flags) });
  },

  // ── named human roles (#987): first-class human flow nodes, TEAM-agent only ──
  // Same binding pattern as stages/labels: teamId first, ProcessCanvas wraps.
  // Purely declarative — the PUT touches only the team config's `humans[]`, no
  // trigger/reconcile side-effect (AC9).
  listHumans: async (teamId) => {
    const a = await apiCall('GET', `/api/agents/${teamId}`);
    return Array.isArray(a?.humans) ? a.humans.slice() : [];
  },
  upsertHuman: async (teamId, human) => {
    const cur = await liveOps.listHumans(teamId);
    await apiCall('PUT', `/api/agents/${teamId}`, { humans: humansAfterUpsert(cur, human) });
  },
  removeHuman: async (teamId, id) => {
    const cur = await liveOps.listHumans(teamId);
    await apiCall('PUT', `/api/agents/${teamId}`, { humans: humansAfterRemove(cur, id) });
  },
  // Wiring helpers (#987): read the human off the team registry, mutate its
  // consumes/emits, PUT the whole registry back. `humanId` is the ROLE id (the
  // registry lives on the team agent = teamId), not an agent config of its own.
  getHuman: async (teamId, id) => {
    const cur = await liveOps.listHumans(teamId);
    return cur.find(h => h && h.id === id) || null;
  },
  wireHumanConsume: async (teamId, id, entry) => {
    const cur = await liveOps.listHumans(teamId);
    const human = cur.find(h => h && h.id === id) || { id, name: id };
    await apiCall('PUT', `/api/agents/${teamId}`, { humans: humansAfterUpsert(cur, humanAfterConsumeAdd(human, entry)) });
  },
  unwireHumanConsume: async (teamId, id, entry) => {
    const cur = await liveOps.listHumans(teamId);
    const human = cur.find(h => h && h.id === id);
    if (!human) return;
    await apiCall('PUT', `/api/agents/${teamId}`, { humans: humansAfterUpsert(cur, humanAfterConsumeRemove(human, entry)) });
  },
  addHumanEmit: async (teamId, id, label) => {
    const cur = await liveOps.listHumans(teamId);
    const human = cur.find(h => h && h.id === id) || { id, name: id };
    await apiCall('PUT', `/api/agents/${teamId}`, { humans: humansAfterUpsert(cur, humanAfterEmitAdd(human, label)) });
  },
  removeHumanEmit: async (teamId, id, label) => {
    const cur = await liveOps.listHumans(teamId);
    const human = cur.find(h => h && h.id === id);
    if (!human) return;
    await apiCall('PUT', `/api/agents/${teamId}`, { humans: humansAfterUpsert(cur, humanAfterEmitRemove(human, label)) });
  },

  // ── GitHub artifact ports (#380): consumed channels ──
  // `github.produces*` became a pure projection of openPr/openIssue outcome
  // actions (#1003) — no UI write path exists any more; the badge, tiles and
  // prompt blocks read the server-side projection (`outcomesToGithub`).
  getRoleGithub: async (roleId) => {
    const a = await apiCall('GET', `/api/agents/${roleId}`);
    return (a && a.github) || {};
  },
  // Channels live on the *consumer*; the backend re-derives the github-event
  // triggers from them (reconcileTeamGithubChannels). Upsert keyed on (artifact, from).
  addChannel: async (roleId, { artifact, from, label, gate, wakePrompt, autoClaim }) => {
    if (!from || from === roleId) return;
    const a = await apiCall('GET', `/api/agents/${roleId}`);
    // `autoClaim` (#958) rides along so the claim opt-out survives the live port
    // write — otherwise the reconciler re-stamps the claim.
    const channels = upsertChannel(Array.isArray(a?.channels) ? a.channels : [], { artifact, from, label, gate, wakePrompt, autoClaim });
    await apiCall('PUT', `/api/agents/${roleId}`, { channels });
  },
  updateChannel: async (roleId, spec) => liveOps.addChannel(roleId, spec),
  removeChannel: async (roleId, { artifact, from, label }) => {
    const a = await apiCall('GET', `/api/agents/${roleId}`);
    const channels = removeChannelFrom(Array.isArray(a?.channels) ? a.channels : [], { artifact, from, label });
    await apiCall('PUT', `/api/agents/${roleId}`, { channels });
  },
};

const clone = (x) => JSON.parse(JSON.stringify(x));
const uid = () => `t${Date.now()}${Math.floor(Math.random() * 1000)}`;

// A third write-target adapter used to live here: it edited a `brief.md`'s body
// and front matter in place through bp-explorer's raw endpoints. #1965 (epic
// #1961 Phase 4) removed it with the flow editor's BriefingPack source — the
// pack hierarchy is now only ever READ, as a one-way import into a draft
// (`POST /api/process/drafts/import-briefings`), so nothing writes back to a
// `brief.md` any more.

function slugRole(name, taken) {
  let base = String(name || 'role').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'role';
  let id = base, n = 2;
  while (taken.has(id)) { id = `${base}-${n++}`; }
  return id;
}

// Map a raw role TEMPLATE (from GET /api/agent-templates/:id) into a draft
// bundle role (#586). The bundle role shape mirrors the template almost 1:1 —
// both express triggers with `promptTemplate` — so this is a verbatim field
// copy that deliberately KEEPS `{{vars}}` raw (E2): a draft has no team/repo
// bound yet, so substitution is deferred to materialise time (parity with the
// wizard path). `id`/`displayName` come from the user's (possibly edited) input.
function templateToDraftRole(t, { id, displayName }) {
  const role = {
    id,
    displayName: displayName || t.displayName || id,
    role: 'team-member',
    sessionPolicy: t.sessionPolicy === 'per-invocation' ? 'per-invocation' : 'persistent',
    systemPrompt: t.promptTemplate || '',
    triggers: (Array.isArray(t.triggers) ? t.triggers : []).map(tr => ({
      id: tr.id,
      type: tr.type,
      enabled: tr.enabled !== false,
      ...(tr.events ? { events: tr.events } : {}),
      ...(tr.labelFilter ? { labelFilter: tr.labelFilter } : {}),
      // Claim (#958) — carried so edit-as-draft round-trips it instead of
      // dropping it and re-deriving a possibly-opted-out claim on re-materialise.
      ...(tr.claim ? { claim: tr.claim } : {}),
      ...(tr.cron ? { cron: tr.cron } : {}),
      ...(tr.at ? { at: tr.at } : {}),
      ...(Array.isArray(tr.emits) ? { emits: tr.emits } : {}),
      ...(tr.dataFlow ? { dataFlow: tr.dataFlow } : {}),
      ...(tr.channel ? { channel: tr.channel } : {}),
      ...(tr.description ? { description: tr.description } : {}),
      // Bundle triggers store the prompt under `promptTemplate` (see
      // templateToCustomRoles) — the template already uses that key.
      promptTemplate: tr.promptTemplate || '',
      ...(tr.preCheckScript ? { preCheckScript: tr.preCheckScript } : {}),
      ...(tr.preCheckEnv ? { preCheckEnv: tr.preCheckEnv } : {}),
    })),
  };
  // Declarative ports — carried verbatim so the draft graph renders the
  // template's wiring and materialise reproduces it (parity with the wizard).
  if (Array.isArray(t.inputs) && t.inputs.length) role.inputs = t.inputs;
  if (Array.isArray(t.outputs) && t.outputs.length) role.outputs = t.outputs;
  if (Array.isArray(t.dependsOn) && t.dependsOn.length) role.dependsOn = t.dependsOn;
  if (typeof t.parent === 'string' && t.parent) role.parent = t.parent;
  if (typeof t.stage === 'string' && t.stage) role.stage = t.stage;
  if (Array.isArray(t.emits) && t.emits.length) role.emits = t.emits;
  // Structured OUTCOMES port (#827) — carried verbatim like the other ports.
  if (t.outcomes && typeof t.outcomes === 'object'
    && Array.isArray(t.outcomes.options) && t.outcomes.options.length) role.outcomes = t.outcomes;
  if (t.github && (t.github.producesPr || t.github.producesIssue)) role.github = t.github;
  if (Array.isArray(t.channels) && t.channels.length) role.channels = t.channels;
  return role;
}

/**
 * Draft mode — every op mutates the bundle and persists it.
 * @param {() => object} getBundle  returns the *current* bundle (use a ref to avoid staleness)
 * @param {(next:object) => Promise<void>} persist  PUTs the bundle and updates state
 */
export function makeDraftOps(getBundle, persist) {
  const role = (b, id) => (b.roles || []).find(r => r.id === id);

  return {
    mode: 'draft',

    // ── the draft itself ──
    // Rename the whole process (the bundle's top-level `name`). The backend
    // re-derives the draft's storage id from the new name (#581); the caller
    // (persistDraft) follows the re-keyed id.
    renameDraft: async (name) => {
      const trimmed = String(name || '').trim();
      if (!trimmed) return;
      const b = clone(getBundle());
      if (b.name === trimmed) return;
      b.name = trimmed;
      await persist(b);
    },

    // ── triggers (shape-compatible with the live API) ──
    listTriggers: async (roleId) => {
      const r = role(getBundle(), roleId);
      return r ? (r.triggers || []).slice() : [];
    },
    createTrigger: async (roleId, body) => {
      const b = clone(getBundle());
      const r = role(b, roleId);
      if (!r) throw new Error(`role ${roleId} not found`);
      r.triggers = r.triggers || [];
      const t = { enabled: true, ...body };
      if (!t.id) t.id = uid(); // callers may pass id: undefined — never persist that
      r.triggers.push(t);
      await persist(b);
      return t;
    },
    updateTrigger: async (roleId, tid, patch) => {
      const b = clone(getBundle());
      const t = (role(b, roleId)?.triggers || []).find(x => x.id === tid);
      if (t) Object.assign(t, patch);
      await persist(b);
    },
    deleteTrigger: async (roleId, tid) => {
      const b = clone(getBundle());
      const r = role(b, roleId);
      if (r) r.triggers = (r.triggers || []).filter(x => x.id !== tid);
      await persist(b);
    },
    // Trigger-level `emits` was removed (#783) — label hand-offs now live
    // in the structured OUTCOMES port (#831).

    // Structured OUTCOMES port (#827) — the same
    // surface as liveOps so the shared inspector never branches on mode. A
    // non-empty port supersedes `emits` (mirrors the PUT clear-emits rule).
    getRoleOutcomes: async (roleId) => {
      const r = role(getBundle(), roleId);
      return r && typeof r.outcomes === 'object' && r.outcomes ? clone(r.outcomes) : null;
    },
    setRoleOutcomes: async (roleId, outcomes) => {
      const b = clone(getBundle());
      const r = role(b, roleId);
      if (r) {
        const authored = outcomes && typeof outcomes === 'object'
          && Array.isArray(outcomes.options) && outcomes.options.length;
        if (authored) { r.outcomes = outcomes; delete r.emits; }
        else delete r.outcomes;
      }
      await persist(b);
    },

    // ── roles (draft-only; no live equivalent) ──
    // Free-form OR template-based (#586). When `template` (a full role template
    // fetched from GET /api/agent-templates/:id) is supplied, its prompt,
    // session policy, triggers and declarative ports are copied into the bundle
    // role VERBATIM — `{{vars}}` (repoFullName/agentId/readyLabel/…) are kept
    // RAW (E2), resolved per-member only at materialise time (the same point the
    // wizard resolves them). The user-edited `displayName` still drives identity
    // (AC-6): the id is slugged from it and uniqueness-resolved within the
    // bundle (AC-7).
    addRole: async ({ displayName, systemPrompt, sessionPolicy, github, template }) => {
      const b = clone(getBundle());
      b.roles = b.roles || [];
      const id = slugRole(displayName, new Set(b.roles.map(r => r.id)));
      if (template && typeof template === 'object') {
        b.roles.push(templateToDraftRole(template, { id, displayName }));
      } else {
        b.roles.push({
          id, displayName: displayName || id, role: 'team-member',
          sessionPolicy: sessionPolicy || 'persistent',
          // A PR-reviewer role (#380) is a plain per-invocation agent that consumes a
          // PR channel — the caller wires the channel after creation.
          ...(github && (github.producesPr || github.producesIssue) ? { github } : {}),
          systemPrompt: systemPrompt || '', triggers: [],
        });
      }
      await persist(b);
      return id;
    },
    patchRole: async (roleId, patch) => {
      const b = clone(getBundle());
      const r = role(b, roleId);
      if (r) Object.assign(r, patch);
      await persist(b);
    },
    renameRole: async (roleId, displayName) => {
      const b = clone(getBundle());
      const r = role(b, roleId);
      if (r) r.displayName = displayName;
      await persist(b);
    },
    // Change a role's *id* (draft-only). The id is a plain bundle key here, so a
    // rename is safe as long as every reference to it is rewired: dependency
    // edges (dependsOn), parent links, and PR-review routing (reviewsPrFrom /
    // onApprove / onChangesRequested). Enforces the slug charset + uniqueness.
    renameRoleId: async (roleId, rawId) => {
      const b = clone(getBundle());
      const r = role(b, roleId);
      if (!r) throw new Error(`role ${roleId} not found`);
      const newId = String(rawId || '').trim().toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
      if (!newId) throw new Error('id must contain a letter or digit');
      if (newId === roleId) return newId;
      if ((b.roles || []).some(x => x.id === newId)) throw new Error(`id "${newId}" is already taken`);
      r.id = newId;
      for (const x of b.roles || []) {
        if (Array.isArray(x.dependsOn)) x.dependsOn = x.dependsOn.map(d => (d === roleId ? newId : d));
        if (x.parent === roleId) x.parent = newId;
        // Rewire GitHub-channel producer references (#380).
        if (Array.isArray(x.channels)) {
          for (const c of x.channels) if (c.from === roleId) c.from = newId;
        }
      }
      await persist(b);
      return newId;
    },
    setPrompt: async (roleId, systemPrompt) => {
      const b = clone(getBundle());
      const r = role(b, roleId);
      if (r) r.systemPrompt = systemPrompt;
      await persist(b);
    },
    setStage: async (roleId, stage) => {
      const b = clone(getBundle());
      const r = role(b, roleId);
      if (r) { if (stage) r.stage = stage; else delete r.stage; }
      await persist(b);
    },

    // ── stages (draft-only): the ordered list that drives the layout ──
    listStages: () => (getBundle().stages || []).slice(),
    addStage: async (name) => {
      const b = clone(getBundle());
      const s = String(name || '').trim();
      if (!s) return;
      b.stages = Array.isArray(b.stages) ? b.stages : [];
      if (!b.stages.includes(s)) b.stages.push(s);
      await persist(b);
    },
    renameStage: async (oldName, newName) => {
      const b = clone(getBundle());
      const s = String(newName || '').trim();
      if (!s) return;
      b.stages = (b.stages || []).map(x => (x === oldName ? s : x));
      // keep the list unique after a rename that collides
      b.stages = b.stages.filter((x, i) => b.stages.indexOf(x) === i);
      for (const r of b.roles || []) if (r.stage === oldName) r.stage = s;
      await persist(b);
    },
    removeStage: async (name) => {
      const b = clone(getBundle());
      b.stages = (b.stages || []).filter(x => x !== name);
      for (const r of b.roles || []) if (r.stage === name) delete r.stage;
      await persist(b);
    },
    reorderStages: async (names) => {
      const b = clone(getBundle());
      // Trust the caller's order but keep only stages that still exist.
      const existing = new Set(b.stages || []);
      b.stages = (names || []).filter(n => existing.has(n));
      await persist(b);
    },
    // ── label registry (#981): gate/brake flags on the bundle ──
    listLabels: () => (getBundle().labels || []).slice(),
    setLabelFlags: async (name, flags) => {
      const b = clone(getBundle());
      const next = labelsAfterSet(b.labels, name, flags);
      if (next.length) b.labels = next; else delete b.labels;
      await persist(b);
    },
    // ── named human roles (#987): first-class human flow nodes on the bundle ──
    listHumans: () => (getBundle().humans || []).slice(),
    upsertHuman: async (human) => {
      const b = clone(getBundle());
      const next = humansAfterUpsert(b.humans, human);
      if (next.length) b.humans = next; else delete b.humans;
      await persist(b);
    },
    removeHuman: async (id) => {
      const b = clone(getBundle());
      const next = humansAfterRemove(b.humans, id);
      if (next.length) b.humans = next; else delete b.humans;
      await persist(b);
    },
    getHuman: (id) => ((getBundle().humans || []).find(h => h && h.id === id) || null),
    wireHumanConsume: async (id, entry) => {
      const b = clone(getBundle());
      const human = (b.humans || []).find(h => h && h.id === id) || { id, name: id };
      b.humans = humansAfterUpsert(b.humans, humanAfterConsumeAdd(human, entry));
      await persist(b);
    },
    unwireHumanConsume: async (id, entry) => {
      const b = clone(getBundle());
      const human = (b.humans || []).find(h => h && h.id === id);
      if (!human) return;
      const next = humansAfterUpsert(b.humans, humanAfterConsumeRemove(human, entry));
      if (next.length) b.humans = next; else delete b.humans;
      await persist(b);
    },
    addHumanEmit: async (id, label) => {
      const b = clone(getBundle());
      const human = (b.humans || []).find(h => h && h.id === id) || { id, name: id };
      b.humans = humansAfterUpsert(b.humans, humanAfterEmitAdd(human, label));
      await persist(b);
    },
    removeHumanEmit: async (id, label) => {
      const b = clone(getBundle());
      const human = (b.humans || []).find(h => h && h.id === id);
      if (!human) return;
      b.humans = humansAfterUpsert(b.humans, humanAfterEmitRemove(human, label));
      await persist(b);
    },
    // Parent-child hierarchy (#378). setParent(child, parent) makes `parent` the
    // grouping node of `child`; clear with a falsy parentId. Self-parenting and
    // direct cycles (parent already a descendant) are rejected.
    setParent: async (roleId, parentId) => {
      const b = clone(getBundle());
      const r = role(b, roleId);
      if (!r) throw new Error(`role ${roleId} not found`);
      if (parentId && parentId !== roleId) {
        if (wouldCreateCycle(b.roles, roleId, parentId)) {
          throw new Error('that would create a parent cycle');
        }
        r.parent = parentId;
      } else {
        delete r.parent;
      }
      await persist(b);
    },
    deleteRole: async (roleId) => {
      const b = clone(getBundle());
      b.roles = (b.roles || []).filter(r => r.id !== roleId);
      // Drop references to the removed role so no edge/parent dangles.
      for (const r of b.roles) {
        if (Array.isArray(r.dependsOn)) r.dependsOn = r.dependsOn.filter(d => d !== roleId);
        if (r.parent === roleId) delete r.parent; // orphaned children become roots
        // Drop GitHub channels that consumed the removed producer (#380).
        if (Array.isArray(r.channels)) {
          r.channels = r.channels.filter(c => c.from !== roleId);
          if (!r.channels.length) delete r.channels;
        }
      }
      await persist(b);
    },

    // ── unified edges (#367): BP dependency + data-flow, draft-only ──
    // Dependency A→B means "B depends on A" (A upstream), stored on B.dependsOn.
    addDependency: async (roleId, dependsOnId) => {
      const b = clone(getBundle());
      const r = role(b, roleId);
      if (!r) throw new Error(`role ${roleId} not found`);
      r.dependsOn = Array.isArray(r.dependsOn) ? r.dependsOn : [];
      if (dependsOnId && dependsOnId !== roleId && !r.dependsOn.includes(dependsOnId)) {
        r.dependsOn.push(dependsOnId);
      }
      await persist(b);
    },
    removeDependency: async (roleId, dependsOnId) => {
      const b = clone(getBundle());
      const r = role(b, roleId);
      if (r) r.dependsOn = (r.dependsOn || []).filter(d => d !== dependsOnId);
      await persist(b);
    },
    // Data flow: a producer's output artifact matches a consumer's input by
    // logical `name` (or `path` when unnamed); `hint` is the informative path.
    addArtifact: async (roleId, { direction, name, hint, path, description }) => {
      const b = clone(getBundle());
      const r = role(b, roleId);
      if (!r) throw new Error(`role ${roleId} not found`);
      const k = direction === 'output' ? 'outputs' : 'inputs';
      r[k] = Array.isArray(r[k]) ? r[k] : [];
      const nm = String(name || '').trim();
      const h = String(hint || '').trim();
      const p = String(path || '').trim();
      const key = nm || p;
      if (key && !r[k].some(a => artKey(a) === key)) {
        r[k].push({
          ...(nm ? { name: nm } : {}), ...(h ? { hint: h } : {}),
          ...(p ? { path: p } : {}), ...(description ? { description } : {}),
        });
      }
      await persist(b);
    },
    removeArtifact: async (roleId, { direction, name, path }) => {
      const b = clone(getBundle());
      const r = role(b, roleId);
      if (r) {
        const k = direction === 'output' ? 'outputs' : 'inputs';
        const key = String(name || path || '').trim();
        r[k] = (r[k] || []).filter(a => artKey(a) !== key);
      }
      await persist(b);
    },
    // Artifact audience (#981) — see liveOps.setArtifactAudience.
    setArtifactAudience: async (roleId, { name, path, audience }) => {
      const b = clone(getBundle());
      const r = role(b, roleId);
      const key = String(name || path || '').trim();
      if (r && key) {
        r.outputs = (r.outputs || []).map(a => (artKey(a) === key
          ? setAudienceOn(a, audience) : a));
      }
      await persist(b);
    },
    // Open-end marker on an output (#1004) — see liveOps.setArtifactMarker.
    setArtifactMarker: async (roleId, { name, path, marker }) => {
      const b = clone(getBundle());
      const r = role(b, roleId);
      const key = String(name || path || '').trim();
      if (r && key) {
        r.outputs = (r.outputs || []).map(a => (artKey(a) === key ? setMarkerOn(a, marker) : a));
      }
      await persist(b);
    },

    // ── GitHub artifact ports (#380): consumed channels ──
    // `github.produces*` is a projection of outcome actions (#1003) — no write op.
    getRoleGithub: async (roleId) => {
      const r = role(getBundle(), roleId);
      return (r && r.github) || {};
    },
    addChannel: async (roleId, spec) => {
      const b = clone(getBundle());
      const r = role(b, roleId);
      if (!r) throw new Error(`role ${roleId} not found`);
      if (!spec.from || spec.from === roleId) return;
      r.channels = upsertChannel(r.channels, spec);
      await persist(b);
    },
    // Upsert keyed on (artifact, from, label) (#828), so editing a channel's
    // gate reuses it while a new label adds a switch fan-in sibling.
    updateChannel: async (roleId, spec) => makeDraftOps(getBundle, persist).addChannel(roleId, spec),
    removeChannel: async (roleId, { artifact, from, label }) => {
      const b = clone(getBundle());
      const r = role(b, roleId);
      // Symmetric with addChannel (#1036): a channel lives on a role. If the
      // target isn't a role (e.g. a human delivery mis-routed here), surface a
      // clear error instead of persisting unchanged — a removal must never be a
      // silent no-op that reports success while the edge stays on the canvas.
      if (!r) throw new Error(`role ${roleId} not found`);
      r.channels = removeChannelFrom(r.channels, { artifact, from, label });
      if (!r.channels.length) delete r.channels;
      await persist(b);
    },
  };
}
