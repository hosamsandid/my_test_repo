'use strict';

// ─── process-template bundle (Process Canvas, #334) ──────────────────────────
//
// A *process template* is a portable, git-committable JSON description of a
// modeled orchestration: the roles (each with its persona prompt and triggers,
// including the declarative `emits`), plus the human gates and the label
// registry. It is the export format of the Process Canvas and the import format
// for materialising a real team. Pure transforms only — no I/O here.
//
// Shape (processTemplateVersion 1):
//   {
//     processTemplateVersion: 1,
//     name, level,                       // level: 'live' | 'template' (informational)
//     roles: [ { id, displayName, role, sessionPolicy, systemPrompt,
//                triggers: [ { id, type, events, labelFilter, cron, at,
//                              emits, description, prompt } ] } ],
//     gates:  [ { label } ],
//     labels: [ { name, humanGate, brake } ],
//   }

const {
  validateOutcomes, normalizeOutcomes, isAuthoredOutcomes, substituteOutcomes,
  outcomesToGithub,
} = require('./outcomes');

const VERSION = 1;

// Strip a leading `<teamId>-` so an exported member id becomes a reusable role
// key (e.g. `acme-developer` → `developer`). Idempotent for ids without it.
function roleKeyOf(id, teamId) {
  if (teamId && id.startsWith(teamId + '-')) return id.slice(teamId.length + 1);
  return id;
}

// Remap a channel's `from` role reference through roleKeyOf so an exported team's
// GitHub-channel wiring uses portable role keys (#380).
function remapChannel(ch, teamId) {
  return {
    artifact: ch.artifact === 'issue' ? 'issue' : 'pr',
    from: roleKeyOf(ch.from, teamId),
    ...(ch.label ? { label: ch.label } : {}),
    ...(ch.gate ? { gate: ch.gate } : {}),
  };
}

// Slim a trigger for the bundle: keep what defines the wiring + behaviour, drop
// team-specific/runtime cruft (repo is re-applied at materialise time; secrets
// never live on triggers).
function bundleTrigger(t) {
  const out = { id: t.id, type: t.type, enabled: t.enabled !== false };
  if (t.type === 'github-event') {
    out.events = Array.isArray(t.events) ? t.events : [];
    if (t.labelFilter) out.labelFilter = t.labelFilter;
  } else if (t.type === 'cron') {
    out.cron = t.cron || null;
  } else if (t.type === 'once') {
    out.at = t.at || null;
  }
  // Trigger-level `emits` was removed (#783) — the portable bundle carries
  // label hand-offs only at the role level. A legacy trigger `emits` is dropped
  // here; callers lift it to the role level (liftTriggerEmits) before export.
  if (t.dataFlow) out.dataFlow = true; // data-flow (agent dependency) marker (#379)
  if (t.description) out.description = t.description;
  if (t.prompt) out.prompt = t.prompt;
  if (t.preCheckScript) out.preCheckScript = t.preCheckScript;
  if (t.preCheckEnv && typeof t.preCheckEnv === 'object') out.preCheckEnv = { ...t.preCheckEnv };
  return out;
}

/**
 * Assemble a process-template bundle.
 * @param {object} opts
 * @param {string} opts.name
 * @param {string} opts.level - 'live' | 'template'
 * @param {string} [opts.teamId] - when exporting a team, used to derive role keys
 * @param {Array} opts.roles - [{ id, displayName, role, sessionPolicy, systemPrompt, triggers }]
 * @param {Array} [opts.gates]
 * @param {Array} [opts.labels]
 */
function buildProcessTemplate({ name, level, teamId, roles, gates, labels, stages }) {
  return {
    processTemplateVersion: VERSION,
    name: name || 'process-template',
    level: level || 'template',
    // Ordered stage names — the layout backbone (agents snap to their stage's
    // column in this order). Portable + git-committable like gates/labels.
    ...(Array.isArray(stages) && stages.length
      ? { stages: stages.map(s => (typeof s === 'string' ? s : s && s.name)).filter(Boolean) }
      : {}),
    roles: (roles || []).map(r => ({
      id: roleKeyOf(r.id, teamId),
      displayName: r.displayName || r.id,
      role: r.role || 'team-member',
      sessionPolicy: r.sessionPolicy || 'persistent',
      // Drop the derived prompt blocks (github-io #380 + outcomes #829) so the
      // portable bundle stays clean; they are regenerated from the `github` flag
      // and the `outcomes` port by expandGithubChannels on import/materialise.
      systemPrompt: stripDerivedPromptBlocks(r.systemPrompt),
      // Agent-level OUTCOMES port (#827) — the structured successor to `emits`.
      // When present it supersedes `emits` (writing outcomes clears emits,
      // mirroring PUT /api/agents/:id), so the two never both ride the bundle.
      ...(isAuthoredOutcomes(r.outcomes) ? { outcomes: normalizeOutcomes(r.outcomes) } : {}),
      // Agent-level emitted labels (legacy flat hand-offs) — kept only when no
      // structured outcomes supersede them.
      ...(!isAuthoredOutcomes(r.outcomes) && Array.isArray(r.emits) && r.emits.length
        ? { emits: r.emits.slice() } : {}),
      // Process stage band — portable so an exported team round-trips its stage
      // layout back into a draft (Edit as draft) and re-materialises unchanged.
      ...(typeof r.stage === 'string' && r.stage ? { stage: r.stage } : {}),
      // GitHub artifact ports (#380): what this role produces (PR/issue) and the
      // PR/issue channels it consumes. Declarative source of truth — the runtime
      // github-event triggers are re-derived from these (expandGithubChannels),
      // so the derived `channel:true` triggers are dropped from the portable bundle.
      ...(r.github && (r.github.producesPr || r.github.producesIssue)
        ? { github: { ...(r.github.producesPr ? { producesPr: true } : {}), ...(r.github.producesIssue ? { producesIssue: true } : {}) } }
        : {}),
      ...(Array.isArray(r.channels) && r.channels.length
        ? { channels: r.channels.map(c => remapChannel(c, teamId)) } : {}),
      triggers: (r.triggers || []).filter(t => !t.channel).map(bundleTrigger),
    })),
    gates: (gates || []).map(g => ({ label: g.label })),
    labels: (labels || []).map(l => ({ name: l.name, humanGate: !!l.humanGate, brake: !!l.brake })),
  };
}

// Basic shape validation for a bundle. Returns { ok, error }.
// `allowEmptyRoles` is for in-progress drafts (#344) — materialisation still
// requires a non-empty role set, so the default stays strict.
function validateProcessTemplate(b, { allowEmptyRoles = false } = {}) {
  if (!b || typeof b !== 'object') return { ok: false, error: 'not an object' };
  if (b.processTemplateVersion !== VERSION) {
    return { ok: false, error: `unsupported processTemplateVersion (expected ${VERSION})` };
  }
  if (!Array.isArray(b.roles)) return { ok: false, error: 'roles must be an array' };
  if (!allowEmptyRoles && b.roles.length === 0) return { ok: false, error: 'roles must be a non-empty array' };
  for (const r of b.roles) {
    if (!r || typeof r.id !== 'string' || !r.id) return { ok: false, error: 'each role needs a string id' };
    if (r.triggers && !Array.isArray(r.triggers)) return { ok: false, error: `role ${r.id}: triggers must be an array` };
    if (r.outcomes !== undefined) {
      const vo = validateOutcomes(r.outcomes);
      if (!vo.ok) return { ok: false, error: `role ${r.id}: ${vo.error}` };
    }
    if (r.channels !== undefined) {
      if (!Array.isArray(r.channels)) return { ok: false, error: `role ${r.id}: channels must be an array` };
      for (const c of r.channels) {
        if (!c || (c.artifact !== 'pr' && c.artifact !== 'issue')) {
          return { ok: false, error: `role ${r.id}: each channel needs artifact 'pr' or 'issue'` };
        }
        if (typeof c.from !== 'string' || !c.from) return { ok: false, error: `role ${r.id}: each channel needs a string 'from'` };
      }
    }
  }
  if (b.gates && !Array.isArray(b.gates)) return { ok: false, error: 'gates must be an array' };
  if (b.labels && !Array.isArray(b.labels)) return { ok: false, error: 'labels must be an array' };
  if (b.stages) {
    if (!Array.isArray(b.stages)) return { ok: false, error: 'stages must be an array' };
    if (!b.stages.every(s => typeof s === 'string')) return { ok: false, error: 'stages must be an array of strings' };
  }
  return { ok: true };
}

// An empty draft skeleton (#344).
function emptyDraftBundle(name) {
  return {
    processTemplateVersion: VERSION,
    name: name || 'Untitled flow',
    level: 'template',
    roles: [],
    gates: [],
    labels: [],
    stages: [],
  };
}

// Draft storage id (slug) derivation. A draft's id is a name-derived, mutable
// slug — re-keyed whenever the name changes (#581), not a permanent external
// identifier. Kept identical to the original creation-time behaviour: lower-case,
// collapse non-`[a-z0-9-]` runs to `-`, trim leading/trailing `-`, 48-char cap,
// empty result falls back to `process`.
const DRAFT_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
function slugifyDraft(name) {
  const base = String(name || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return base || 'process';
}

// Derive a unique draft id from a name. `exists(id)` reports whether an id is
// already taken; `currentId` (when re-deriving on rename) is treated as free so
// a name whose slug already equals the draft's own id is a no-op — never
// spuriously suffixed. Collisions reuse the creation-time `-2`/`-3` suffix loop.
function deriveUniqueDraftId(name, { currentId = null, exists } = {}) {
  let base = slugifyDraft(name);
  if (!DRAFT_ID_RE.test(base)) base = 'process';
  let id = base;
  let n = 2;
  while (id !== currentId && exists(id)) { id = `${base}-${n++}`; }
  return id;
}

// Transform a bundle's roles into the `customRoles` shape consumed by
// POST /api/teams — pseudo-templates the existing materialisation loop renders
// exactly like catalog templates (var substitution over prompt + triggers).
function templateToCustomRoles(bundle) {
  return (bundle.roles || []).map(r => ({
    id: r.id,
    displayName: r.displayName || r.id,
    sessionPolicy: r.sessionPolicy === 'per-invocation' ? 'per-invocation' : undefined,
    promptTemplate: r.systemPrompt || '',
    // Carry the BP data-flow ports + dependencies through so the materialised
    // member's config can record them — the live graph then renders the
    // dependency/artifact edges of an imported flow, not just the push triggers
    // (#379). No-op for ordinary catalog roles (they carry none).
    ...(Array.isArray(r.inputs) && r.inputs.length ? { inputs: r.inputs } : {}),
    ...(Array.isArray(r.outputs) && r.outputs.length ? { outputs: r.outputs } : {}),
    ...(Array.isArray(r.dependsOn) && r.dependsOn.length ? { dependsOn: r.dependsOn } : {}),
    // Parent role id (hierarchy) — the materialiser maps it to a member id so
    // the agent overview + live graph render the parent-child tree (#377).
    ...(typeof r.parent === 'string' && r.parent ? { parent: r.parent } : {}),
    // Process stage band — carried onto the materialised member's config so the
    // live graph reproduces the draft's stage layout instead of collapsing to
    // the auto-layered columns.
    ...(typeof r.stage === 'string' && r.stage ? { stage: r.stage } : {}),
    // Agent-level OUTCOMES port (#827) — recorded on member config; supersedes
    // `emits` when present (the two never coexist on a materialised member).
    ...(isAuthoredOutcomes(r.outcomes) ? { outcomes: normalizeOutcomes(r.outcomes) } : {}),
    // Agent-level emitted labels (legacy flat hand-offs) — recorded on member
    // config only when no structured outcomes supersede them.
    ...(!isAuthoredOutcomes(r.outcomes) && Array.isArray(r.emits) && r.emits.length
      ? { emits: r.emits } : {}),
    // GitHub artifact ports (#380) — carried to member config so the live graph
    // renders channel edges + the orchestrator instructs the agent to open
    // PRs/issues. The functional consumer triggers are already expanded by
    // expandGithubChannels before this runs.
    ...(r.github && (r.github.producesPr || r.github.producesIssue) ? { github: r.github } : {}),
    ...(Array.isArray(r.channels) && r.channels.length ? { channels: r.channels } : {}),
    triggers: (r.triggers || []).map(t => ({
      id: t.id,
      type: t.type,
      enabled: t.enabled !== false,
      events: t.events,
      labelFilter: t.labelFilter,
      cron: t.cron,
      at: t.at,
      // Trigger-level emits removed (#783) — label hand-offs ride on role `emits`.
      dataFlow: t.dataFlow,
      channel: t.channel,
      // Informational provenance for a consolidated channel listener (#826).
      ...(Array.isArray(t.sources) ? { sources: t.sources } : {}),
      description: t.description,
      promptTemplate: t.prompt || '',
      preCheckScript: t.preCheckScript,
      preCheckEnv: t.preCheckEnv,
    })),
  }));
}

// ─── GitHub PR/Issue channels (#380) ─────────────────────────────────────
// The declarative way agents hand work off over GitHub. A role's `github` flags
// say what it *produces* (opens PRs / opens issues); a consumer role's
// `channels: [{ artifact, from, label?, gate? }]` say which producer's PR/issue
// it *reacts to* (optionally only when a label is present, optionally only when a
// human applied that label — the inline approval gate). This mirrors the
// data-flow port model: the ports are the single source of truth, and this
// expansion (materialise time + live reconcile) derives the concrete
// github-event trigger on the consumer, marked `channel: true` so it can be
// regenerated idempotently. The producer-side instruction ("open a PR/issue") is
// appended to the producer's systemPrompt as an idempotent, marker-delimited
// block (stripped on export, regenerated on expand) so a re-import never
// duplicates it.

// Marker-delimited producer instruction block (#380) — kept idempotent so
// export→import→materialise round-trips cleanly.
const PRODUCE_MARK_START = '<!-- github-io:start -->';
const PRODUCE_MARK_END = '<!-- github-io:end -->';

function producePrText() {
  return [
    '**Opening pull requests.** When a unit of your work is ready for the team, open a',
    'Pull Request: write the PR body to a file, run `gh-as-agent stamp <file>`, then',
    '`gh pr create --title "<title>" --body-file <file>`. Downstream agents are woken by',
    'your PR, so always open one when you finish a piece of work.',
  ].join('\n');
}

function produceIssueText() {
  return [
    '**Opening issues.** When you identify work another agent should pick up, open a',
    'GitHub Issue: write the issue body to a file, run `gh-as-agent stamp <file>`, then',
    '`gh issue create --title "<title>" --body-file <file>`.',
  ].join('\n');
}

function stripProduceBlock(text) {
  if (typeof text !== 'string' || !text.includes(PRODUCE_MARK_START)) return typeof text === 'string' ? text : '';
  return text.replace(
    new RegExp(`\\n*${PRODUCE_MARK_START}[\\s\\S]*?${PRODUCE_MARK_END}\\n*`, 'g'), '',
  ).trimEnd();
}

function produceBlock(github) {
  const parts = [];
  if (github && github.producesPr) parts.push(producePrText());
  if (github && github.producesIssue) parts.push(produceIssueText());
  if (!parts.length) return '';
  return `${PRODUCE_MARK_START}\n\n## GitHub outputs\n\n${parts.join('\n\n')}\n\n${PRODUCE_MARK_END}`;
}

// ─── Outcomes prompt block (#829, agent-outcomes concept §6) ─────────────────
//
// The structured `outcomes` declaration (#827) is the source of truth; this is
// its generated *prompt projection* — the same marker-delimited, strip-then-
// reappend idempotency as the github-io produce block above, so a re-import /
// re-reconcile never duplicates it. Only an **authored** outcomes port projects
// a block: an agent carrying just flat `emits` (the degenerate read-path lift)
// gets nothing, so a migration alone changes no behaviour (concept §7, AC4).
//
// It closes the gap the produce block leaves open — today's producePrText /
// produceIssueText never mention the routing *label* the consumer filters on, so
// agent-driven labelling only worked if the author remembered to put it in
// prose. With outcomes the projection is guaranteed consistent with the switch.
const OUTCOMES_MARK_START = '<!-- outcomes:start -->';
const OUTCOMES_MARK_END = '<!-- outcomes:end -->';

function stripOutcomesBlock(text) {
  if (typeof text !== 'string' || !text.includes(OUTCOMES_MARK_START)) {
    return typeof text === 'string' ? text : '';
  }
  return text.replace(
    new RegExp(`\\n*${OUTCOMES_MARK_START}[\\s\\S]*?${OUTCOMES_MARK_END}\\n*`, 'g'), '',
  ).trimEnd();
}

// The "Then: …" action clause for one option — a human-readable summary of its
// actions joined with " and ". `setLabel` names the label; `openPr`/`openIssue`
// use the produce verbs (the full how-to is appended once below, reusing
// producePrText/produceIssueText); a `none`-only / empty action set is
// "set no label". A `notify: "dm"` option appends the DM-reporting instruction.
// Returns the clause plus whether this option opens a PR/issue.
function outcomeActionClause(option) {
  const parts = [];
  let opensPr = false;
  let opensIssue = false;
  for (const a of (option && Array.isArray(option.actions) ? option.actions : [])) {
    if (!a || typeof a !== 'object') continue;
    if (a.type === 'setLabel' && typeof a.label === 'string' && a.label.trim()) {
      parts.push(`apply label \`${a.label.trim()}\``);
    } else if (a.type === 'openPr') {
      parts.push('open a pull request'); opensPr = true;
    } else if (a.type === 'openIssue') {
      parts.push('open a GitHub issue'); opensIssue = true;
    }
  }
  if (!parts.length) parts.push('set no label');
  let clause = parts.join(' and ');
  if (option && option.notify === 'dm') clause += '; report to the user in the DM';
  return { clause, opensPr, opensIssue };
}

// Generate the marker-delimited `## Outcomes` block for an authored outcomes
// port (concept §6). Empty string for a non-authored port (nothing to project).
// Pure; the caller (expandGithubChannels / reconcileTeamOutcomes) does the
// strip-then-reappend into the systemPrompt.
function outcomesBlock(outcomes) {
  if (!isAuthoredOutcomes(outcomes)) return '';
  const exactlyOne = outcomes.mode === 'exactlyOne';
  const lead = exactlyOne
    ? 'At the end of every run you choose **exactly one** of the following outcomes:'
    : 'At the end of every run you choose **all outcomes that apply** — zero is allowed:';
  const items = [];
  let anyPr = false;
  let anyIssue = false;
  outcomes.options.forEach((o, i) => {
    const title = (typeof o.title === 'string' && o.title.trim()) ? o.title.trim() : o.id;
    const { clause, opensPr, opensIssue } = outcomeActionClause(o);
    anyPr = anyPr || opensPr;
    anyIssue = anyIssue || opensIssue;
    const when = (typeof o.when === 'string' && o.when.trim()) ? ` when: ${o.when.trim()}.` : '';
    items.push(`${i + 1}. **${title}** —${when} Then: ${clause}.`);
  });
  const body = [lead, '', ...items];
  if (exactlyOne) {
    body.push('', 'Never apply more than one of these labels in a single run.');
  }
  // Absorb the produce how-to once for any option that opens a PR/issue —
  // reusing the exact producePrText/produceIssueText wording. The github-io
  // produce block omits the flags an outcome already covers (see
  // expandGithubChannels), so the "open a PR/issue" instruction never doubles.
  const tail = [];
  if (anyPr) tail.push(producePrText());
  if (anyIssue) tail.push(produceIssueText());
  const full = tail.length ? `${body.join('\n')}\n\n${tail.join('\n\n')}` : body.join('\n');
  return `${OUTCOMES_MARK_START}\n\n## Outcomes\n\n${full}\n\n${OUTCOMES_MARK_END}`;
}

// Strip both derived prompt blocks (github-io #380 + outcomes #829) from a
// systemPrompt — the portable/base form. Used on export and by the reconciler
// before re-appending freshly-generated blocks.
function stripDerivedPromptBlocks(text) {
  return stripOutcomesBlock(stripProduceBlock(text));
}

// Re-render a role/agent's systemPrompt with both derived prompt blocks from its
// declarative ports (`github` + `outcomes`) — strip-then-reappend, idempotent.
// Coexistence (AC3): an outcome that opens a PR/issue already carries the produce
// how-to inside the outcomes block, so the produce flags it covers are dropped
// from the github-io block — the instruction never appears twice. Order is
// produce-then-outcomes so a github-only agent's prompt stays byte-identical to
// before #829 (the outcomes block is empty and appends nothing). Pure.
function applyDerivedPromptBlocks(systemPrompt, { github, outcomes } = {}) {
  const base = stripDerivedPromptBlocks(systemPrompt || '');
  const covered = isAuthoredOutcomes(outcomes) ? outcomesToGithub(outcomes) : {};
  const effGithub = github && typeof github === 'object'
    ? {
      producesPr: !!(github.producesPr && !covered.producesPr),
      producesIssue: !!(github.producesIssue && !covered.producesIssue),
    }
    : github;
  const appended = [produceBlock(effGithub), outcomesBlock(outcomes)]
    .filter(Boolean).join('\n\n');
  return appended ? `${base ? `${base}\n\n` : ''}${appended}` : base;
}

const CHANNEL_EVENTS = {
  pr: { open: ['pull_request.opened', 'pull_request.reopened'], labeled: ['pull_request.labeled'] },
  issue: { open: ['issues.opened'], labeled: ['issues.labeled'] },
};

// Canonical id for a derived channel trigger, so reconciliation can find and
// regenerate it (kept in sync with reconcileTeamGithubChannels in api.js).
// The id is keyed on the (artifact, label) the trigger listens on — NOT on the
// producer (#826): channels from several producers over the same label collapse
// into ONE derived listener (the poller has no origin filter, so per-producer
// triggers were functionally identical duplicates). The contributing producers
// are recorded informationally on the trigger's `sources`.
function channelTriggerId(consumerId, artifact, label) {
  const lbl = typeof label === 'string' && label.trim() ? label.trim() : '';
  return `${consumerId}-on-${artifact}${lbl ? `-${lbl}` : ''}`;
}

function isChannelTrigger(t) {
  return !!(t && t.channel === true);
}

// A derived trigger owns no stable authoring point: channel (#380) and data-flow
// (#379) triggers are stripped and regenerated on every reconcile. Without a
// stamp, the poller's per-subscriber history horizon falls back to the volatile
// triggers.json mtime (effectiveHorizon in github-poller.js), so each reconcile
// rewrite pushes the horizon to "now" and can silently drop events that arrived
// in between (the #446 residual). `stampDerivedActivation` carries the prior
// same-id trigger's `activatedAt` onto its regenerated replacement — keeping the
// horizon fixed across reconciles — and stamps a genuinely new derived trigger
// with `now`. Non-derived and already-stamped triggers pass through untouched.
//
// Consolidation (#826): the channel id scheme changed from `<c>-on-<art>-<prod>`
// to `<c>-on-<art>[-<label>]` (producer dropped), so a reconcile that migrates an
// old team's per-producer triggers onto the new consolidated one cannot match by
// id — the ids differ. To keep the history horizon fixed across that migration, a
// derived trigger with no exact id match falls back to matching prior derived
// triggers by their (events, labelFilter) *listener signature* and carries the
// **oldest** `activatedAt` of that merged set. So merging N old triggers into one
// listener can never shove the poller's horizon forward to "now" and drop a
// pending event that arrived before the oldest of them. Id match still wins first
// (steady-state regeneration).
//
// The signature fallback is deliberately scoped to `channel` triggers: their id
// scheme changed (#826), so a migrated trigger must re-find its predecessors by
// signature. Data-flow (`<c>-on-push-<upstream>`) ids never changed and every
// data-flow trigger of one consumer shares the same `push` signature, so a
// signature fallback there would make a genuinely-new upstream inherit a
// sibling's old horizon and replay stale pushes — data-flow stays id-match only.
// Pure; `now` is injectable for tests.
function derivedListenerSignature(t) {
  const events = Array.isArray(t.events) ? t.events.slice().sort() : [];
  const label = typeof t.labelFilter === 'string' ? t.labelFilter : '';
  return `${events.join(',')}|${label}`;
}
function stampDerivedActivation(nextTriggers, prevTriggers, now) {
  const prevAt = new Map();           // id -> activatedAt (exact-id preservation)
  const prevChannelBySig = new Map(); // channel listener signature -> oldest activatedAt
  for (const t of (Array.isArray(prevTriggers) ? prevTriggers : [])) {
    if (!t || typeof t !== 'object' || !t.activatedAt) continue;
    if (!(t.channel === true || t.dataFlow === true)) continue;
    if (typeof t.id === 'string') prevAt.set(t.id, t.activatedAt);
    if (t.channel === true) {
      const sig = derivedListenerSignature(t);
      const cur = prevChannelBySig.get(sig);
      if (!cur || t.activatedAt < cur) prevChannelBySig.set(sig, t.activatedAt); // ISO strings sort lexicographically
    }
  }
  const stamp = now || new Date().toISOString();
  return (Array.isArray(nextTriggers) ? nextTriggers : []).map((t) => {
    if (!t || typeof t !== 'object') return t;
    const derived = t.channel === true || t.dataFlow === true;
    if (!derived || t.activatedAt) return t;
    const carried = prevAt.get(t.id)
      || (t.channel === true ? prevChannelBySig.get(derivedListenerSignature(t)) : undefined);
    return { ...t, activatedAt: carried || stamp };
  });
}

function consumePrPrompt(producerName, { label, human } = {}) {
  const lead = human && label
    ? `A human applied the \`${label}\` label to a pull request from **${producerName}** — that is your go-ahead.`
    : label
      ? `A pull request from **${producerName}** was labelled \`${label}\`.`
      : `**${producerName}** opened a pull request (see the event payload above).`;
  return [
    lead,
    '',
    'Act on it:',
    '1. `gh pr checkout <number>` (the PR number is in the payload) and read the diff.',
    '2. Do your part of the work on that PR / branch.',
    '3. Use `gh-as-agent` for any PR comments or reviews so your identity is stamped.',
    '',
    'Reply `[PASS]` if there is nothing for you to do here.',
  ].join('\n');
}

function consumeIssuePrompt(producerName, { label, human } = {}) {
  const lead = human && label
    ? `A human applied the \`${label}\` label to an issue from **${producerName}** — that is your go-ahead.`
    : label
      ? `An issue from **${producerName}** was labelled \`${label}\`.`
      : `**${producerName}** opened a GitHub issue (see the event payload above).`;
  return [
    lead,
    '',
    'Pick it up: read the issue, do the work it describes, then report back on the issue',
    '(write any comment to a file, run `gh-as-agent stamp <file>`, then `gh issue comment <n> --body-file <file>`).',
    '',
    'Reply `[PASS]` if this issue is not for you.',
  ].join('\n');
}

/**
 * Expand a role's `channels` ports into concrete consumer github-event triggers.
 * Returns a NEW bundle. Previously-derived `channel:true` triggers are stripped
 * first so an edited port (e.g. a newly-added label) regenerates cleanly rather
 * than leaving a stale trigger behind. Idempotent. Roles without channels are
 * untouched (no-op for catalog teams).
 * @param {object} bundle
 * @param {object} [_opts] - accepted for call-site parity; derived channel
 *   triggers carry no origin filter, so no team→member mapping is needed.
 */
function expandGithubChannels(bundle, _opts = {}) {
  const roles = (bundle.roles || []).map(r => ({
    ...r,
    triggers: (r.triggers || []).filter(t => !isChannelTrigger(t)),
  }));
  const byId = new Map(roles.map(r => [r.id, r]));

  for (const b of roles) {
    // Group this consumer's channels by the (artifact, label) listener they
    // resolve to (#826). Several producers over the same label yield ONE derived
    // trigger: since the poller carries no origin filter, per-producer triggers
    // were functionally identical (same events + labelFilter) and woke the agent
    // once per producer. The contributing producers are kept on `sources` for
    // provenance only. Insertion order (first channel wins the slot) is preserved
    // so the derivation stays deterministic.
    const groups = new Map(); // `${artifact}::${label}` -> { artifact, label, human, sources: [] }
    for (const ch of (b.channels || [])) {
      const artifact = ch.artifact === 'issue' ? 'issue' : 'pr';
      const from = typeof ch.from === 'string' ? ch.from : '';
      if (!from || from === b.id) continue;
      const label = typeof ch.label === 'string' && ch.label.trim() ? ch.label.trim() : '';
      const human = ch.gate === 'human';
      const key = `${artifact}::${label}`;
      let g = groups.get(key);
      if (!g) { g = { artifact, label, human: false, sources: [] }; groups.set(key, g); }
      // Gated iff any contributing channel gates it (a mixed gated/ungated set on
      // the same label is degenerate — treat as gated, matching the old behaviour
      // where the labelled trigger already reacted to the label change).
      g.human = g.human || human;
      if (!g.sources.includes(from)) g.sources.push(from);
    }

    for (const g of groups.values()) {
      const id = channelTriggerId(b.id, g.artifact, g.label);
      if (b.triggers.some(t => t.id === id)) continue;
      const events = (g.label ? CHANNEL_EVENTS[g.artifact].labeled : CHANNEL_EVENTS[g.artifact].open).slice();
      const producerNames = g.sources.map(s => byId.get(s)?.displayName || s);
      const producerLabel = producerNames.join(', ') || 'an upstream';
      b.triggers.push({
        id,
        type: 'github-event',
        events,
        ...(g.label ? { labelFilter: g.label } : {}),
        // No origin filter: the trigger fires on any matching PR/issue event.
        // A human gate is expressed purely by the `human:*` label convention
        // (the labelFilter above) — humans apply it; agents don't, by convention.
        channel: true,
        // Informational only (#826): which producers' channels contributed to
        // this consolidated listener. No runtime meaning (the poller ignores it);
        // kept for provenance and so the graph can map each channel edge onto the
        // shared listener.
        sources: g.sources.slice(),
        enabled: true,
        description: `${g.artifact === 'pr' ? 'PR' : 'Issue'} from ${producerLabel}`
          + `${g.label ? ` labelled ${g.label}` : ''}${g.human ? ' (human-approved)' : ''}`,
        prompt: g.artifact === 'pr'
          ? consumePrPrompt(producerLabel, { label: g.label, human: g.human })
          : consumeIssuePrompt(producerLabel, { label: g.label, human: g.human }),
      });
    }
    // Derived prompt blocks — idempotent (strip any prior blocks, re-append):
    // the github-io producer instruction (#380) and the outcomes projection
    // (#829). Coexistence is handled inside applyDerivedPromptBlocks.
    b.systemPrompt = applyDerivedPromptBlocks(b.systemPrompt, { github: b.github, outcomes: b.outcomes });
  }
  return { ...bundle, roles };
}

/**
 * Back-compat: map a legacy `kind:'pr-review'` role (#347) onto the #380 channel
 * ports so old drafts/teams keep rendering. The reviewer becomes a plain agent
 * consuming a PR channel from its reviewed producer; the producer gets
 * `producesPr`. The approve/changes outcome routing is dropped (superseded by the
 * channel model). Idempotent; roles without the legacy meta pass through.
 */
function normalizeLegacyReview(bundle) {
  if (!bundle || !Array.isArray(bundle.roles)) return bundle;
  const roles = bundle.roles.map(r => ({ ...r }));
  const byId = new Map(roles.map(r => [r.id, r]));
  let changed = false;
  for (const r of roles) {
    if (r.kind !== 'pr-review') continue;
    changed = true;
    const rv = r.review || {};
    if (rv.reviewsPrFrom && byId.has(rv.reviewsPrFrom)) {
      r.channels = Array.isArray(r.channels) ? r.channels.slice() : [];
      if (!r.channels.some(c => c.artifact === 'pr' && c.from === rv.reviewsPrFrom)) {
        r.channels.push({ artifact: 'pr', from: rv.reviewsPrFrom });
      }
      const producer = byId.get(rv.reviewsPrFrom);
      producer.github = { ...(producer.github || {}), producesPr: true };
    }
    delete r.kind;
    delete r.review;
  }
  return changed ? { ...bundle, roles } : bundle;
}

/**
 * Backward-compat lift (#783). Trigger-level `emits` was removed — the agent/
 * role level is the canonical, sole source of label hand-off edges. An old
 * bundle, draft, exported team, or live `triggers.json` may still carry `emits`
 * on a role's triggers. Merge every such label into the role-level `emits`
 * (deduped, order-preserving: role labels first, then lifted trigger labels) and
 * strip `emits`/`emitsDerived` from the triggers, so no drawn edge is lost on
 * import/materialisation. Returns a NEW bundle; roles carrying no trigger emits
 * pass through untouched. Idempotent.
 */
function liftTriggerEmits(bundle) {
  if (!bundle || !Array.isArray(bundle.roles)) return bundle;
  let changed = false;
  const roles = bundle.roles.map((r) => {
    const triggers = Array.isArray(r.triggers) ? r.triggers : [];
    const hasTriggerEmits = triggers.some(
      (t) => t && typeof t === 'object' && ('emits' in t || 'emitsDerived' in t));
    if (!hasTriggerEmits) return r;
    changed = true;
    const lifted = [];
    for (const t of triggers) {
      if (t && Array.isArray(t.emits)) {
        for (const e of t.emits) if (typeof e === 'string' && e) lifted.push(e);
      }
    }
    const roleEmits = Array.isArray(r.emits) ? r.emits.filter((e) => typeof e === 'string' && e) : [];
    const merged = [...new Set([...roleEmits, ...lifted])];
    const strippedTriggers = triggers.map((t) => {
      if (t && typeof t === 'object' && ('emits' in t || 'emitsDerived' in t)) {
        const { emits, emitsDerived, ...rest } = t; // eslint-disable-line no-unused-vars
        return rest;
      }
      return t;
    });
    return { ...r, ...(merged.length ? { emits: merged } : {}), triggers: strippedTriggers };
  });
  return changed ? { ...bundle, roles } : bundle;
}

// ─── Data-flow steps (#379) ───────────────────────────────────────────────
// Core principle: agents hand files off via `git commit` + `git push`, so a
// push by an upstream agent IS the signal that downstream data is ready. This
// expansion (run only at materialise time) turns each data-flow edge —
// `depends_on` (ordering) and artifact output→input matches (data) — into a
// concrete `push` github-event trigger on the *consumer*. The trigger carries
// no origin filter — it fires on any push to the repo and the woken agent
// decides whether the change is relevant (it can `[PASS]`). The Layer-3
// throttle caps runaway wake-ups per branch. No runtime/router change.
//
// Path-level precision is deliberately NOT applied: this also covers the case
// where an agent chose to produce something other than its declared artifact.
//
// Artifacts are matched by their *logical name* (#382), not their physical path:
// an agent instance may write "the Functional Design" to a different path each
// run (or a whole directory, or something it couldn't predict). The path becomes
// an optional `hint`; the real location is resolved at runtime from the git-
// committed artifact manifest (`.aee/artifacts.jsonl`, written via `aee-artifact
// add`). A port with only a `path` (BriefingPack artifacts + legacy team ports)
// still matches by path — unchanged.

// The match key of an artifact port: its logical name if present, else its path.
function artifactKey(a) {
  if (typeof a === 'string') return a;
  return (a && (a.name || a.path)) || '';
}
// The physical hint for a named artifact (informative; path IS the key when
// there is no name).
function artifactHint(a) {
  if (!a || typeof a !== 'object') return '';
  return a.hint || (a.name ? a.path : '') || '';
}
function artifactIsNamed(a) { return !!(a && typeof a === 'object' && a.name); }

// Build the consumer's wake prompt. `artifacts` = [{ key, hint, named }] for the
// one upstream. Named artifacts are resolved from the manifest; path-only
// (legacy/BP) artifacts are named inline; a bare dependency has neither.
function dataFlowPrompt(upstreamName, artifacts) {
  const list = Array.isArray(artifacts) ? artifacts : [];
  const named = list.filter(a => a.named && a.key);
  const legacy = list.filter(a => !a.named && a.key);
  const lines = [
    `Your upstream **${upstreamName}** just pushed to the team repo (the event payload above has the branch and commits).`,
  ];
  if (named.length) {
    const desc = named.map(a => `**${a.key}**${a.hint ? ` (usually under \`${a.hint}\`)` : ''}`).join(', ');
    lines.push(`It may have produced the artifact(s) you consume: ${desc}.`);
    lines.push('The exact path can vary per run, so resolve it from the artifact manifest instead of guessing — run `aee-artifact list "<artifact name>"` (or read `.aee/artifacts.jsonl`) to get the path the upstream registered.');
  } else if (legacy.length) {
    lines.push(`Your declared inputs from it: ${legacy.map(a => `\`${a.key}\``).join(', ')}.`);
  } else {
    lines.push('It is an upstream dependency of yours.');
  }
  lines.push('');
  lines.push('Before you act:');
  lines.push('1. `git fetch`, then check out the pushed branch and `git pull --ff-only` (the ref is in the payload).');
  if (named.length) {
    lines.push('2. Resolve each artifact you need from the manifest and confirm the file/directory is present and complete.');
    lines.push('3. If the upstream pushed but never registered an artifact you expect, don\'t guess a path — tell the user it is missing and stop.');
  } else {
    lines.push('2. Inspect what changed and confirm the inputs you need are present and complete.');
    lines.push('3. If this push does not actually affect your work, reply `[PASS]` — skipping is fine.');
  }
  lines.push('');
  lines.push(named.length
    ? 'Then do your part. When you produce an artifact others depend on, register it so downstream agents can find it: `aee-artifact add "<name>" <path>`. Commit + push so they are notified the same way.'
    : 'Then do your part and commit + push your own outputs so your downstream agents are notified the same way.');
  return lines.join('\n');
}

/**
 * Expand data-flow edges into `push` triggers (materialise time). Returns a NEW
 * bundle; roles without dependencies/inputs are untouched (no-op for catalog
 * teams). `inputs/outputs/dependsOn` stay on the roles (carried to config by
 * templateToCustomRoles for the live graph).
 * @param {object} bundle
 * @param {{ teamId?: string }} [opts] - teamId (accepted for signature parity
 *   with expandGithubChannels; the derived triggers carry no origin filter).
 */
function expandDataFlowSteps(bundle) {
  const roles = (bundle.roles || []).map(r => ({ ...r, triggers: (r.triggers || []).slice() }));
  const byId = new Map(roles.map(r => [r.id, r]));

  // Producers by artifact match key (logical name, else path).
  const producersByKey = new Map();
  for (const r of roles) {
    for (const a of (r.outputs || [])) {
      const k = artifactKey(a);
      if (!k) continue;
      if (!producersByKey.has(k)) producersByKey.set(k, []);
      producersByKey.get(k).push(r.id);
    }
  }

  for (const b of roles) {
    // upstream role id -> Map(key -> {key, hint, named}); empty map = pure
    // dependency edge (ordering only, no artifact).
    const upstream = new Map();
    const ensure = (id) => { if (!upstream.has(id)) upstream.set(id, new Map()); return upstream.get(id); };

    for (const dep of (b.dependsOn || [])) {
      if (typeof dep === 'string' && dep && dep !== b.id && byId.has(dep)) ensure(dep);
    }
    for (const a of (b.inputs || [])) {
      const k = artifactKey(a);
      if (!k) continue;
      for (const producer of (producersByKey.get(k) || [])) {
        if (producer !== b.id) {
          ensure(producer).set(k, { key: k, hint: artifactHint(a), named: artifactIsNamed(a) });
        }
      }
    }

    for (const [upId, artifacts] of upstream) {
      const triggerId = `${b.id}-on-push-${upId}`;
      if (b.triggers.some(t => t.id === triggerId)) continue; // idempotent
      const list = [...artifacts.values()].sort((x, y) => x.key.localeCompare(y.key));
      b.triggers.push({
        id: triggerId,
        type: 'github-event',
        events: ['push'],
        // Marker so the UI renders this as an agent data-flow dependency (an
        // editable "push from <upstream>" hand-off) rather than a raw push
        // trigger. The poller ignores unknown fields. (#379)
        dataFlow: true,
        enabled: true,
        description: `Data flow: wake on push from ${byId.get(upId)?.displayName || upId}`,
        prompt: dataFlowPrompt(byId.get(upId)?.displayName || upId, list),
      });
    }
  }

  return { ...bundle, roles };
}

// Substitute `{{varname}}` placeholders. Unknown vars stay literal so a rogue
// template field doesn't silently disappear into "undefined" — mirrors
// api.js's applyTemplateVars (kept local so this module stays dependency-free).
function substituteVars(s, vars) {
  if (typeof s !== 'string') return s;
  return s.replace(/\{\{(\w+)\}\}/g, (_m, k) =>
    vars && vars[k] !== undefined ? String(vars[k]) : `{{${k}}}`);
}

/**
 * Build the orchestrator member-create body from a role TEMPLATE, applying
 * per-member `{{var}}` substitution. This is the single source of truth shared
 * by the Team-Setup wizard (POST /api/teams[/stream]) and the Flow Editor's
 * "add role from a template" flow (#586), so both express a template's fields
 * — prompt, sessionPolicy, triggers, and the catalog-v2 declarative ports —
 * identically. Pure; the caller supplies the resolved substitution `vars`
 * (repoFullName, teamName, agentId, readyLabel, …) and the target ids.
 *
 * @param {object} template - a raw agent template ({ promptTemplate, triggers, … })
 * @param {object} opts
 * @param {string} opts.teamId          - owning team agent id (for `<teamId>-<roleId>` refs)
 * @param {string} opts.memberId        - the new member's id
 * @param {string} opts.memberDisplayName - the new member's display name
 * @param {object} opts.vars            - substitution variables
 * @param {boolean} [opts.materialize]  - when defined, passed through to the orchestrator
 * @returns {object} the member-create body for POST /internal/teams/:teamId/members
 */
function buildMemberFromTemplate(template, { teamId, memberId, memberDisplayName, vars, materialize } = {}) {
  const t = template && typeof template === 'object' ? template : {};
  const subst = (s) => substituteVars(s, vars);

  const triggers = (Array.isArray(t.triggers) ? t.triggers : []).map((tr) => {
    const out = {
      id: tr.id,
      type: tr.type,
      enabled: tr.enabled !== false,
      description: tr.description || `${t.displayName} — ${tr.id}`,
      prompt: subst(tr.promptTemplate || ''),
    };
    if (tr.type === 'github-event') {
      out.events = tr.events || [];
      out.repo = vars ? vars.repoFullName : undefined;
      if (typeof tr.labelFilter === 'string' && tr.labelFilter.trim()) {
        out.labelFilter = subst(tr.labelFilter);
      }
      // Data-flow (agent dependency) marker so the trigger UI renders it as an
      // editable "push from <upstream>" hand-off rather than a raw push (#379).
      if (tr.dataFlow) out.dataFlow = true;
      // GitHub-channel marker (#380) so reconciliation can regenerate it and the
      // graph builders skip it (the on:'github' edge comes from the port).
      if (tr.channel) out.channel = true;
      // Consolidated-listener provenance (#826), informational only.
      if (Array.isArray(tr.sources)) out.sources = tr.sources.slice();
      // Stamp the history horizon (#320/#446) on EVERY github-event trigger so
      // the poller starts a fresh member from "now", not the triggers.json mtime.
      const now = new Date().toISOString();
      out.createdAt = now;
      out.activatedAt = now;
    } else if (tr.type === 'cron') {
      out.cron = tr.cron;
    }
    if (tr.preCheckScript) out.preCheckScript = tr.preCheckScript;
    if (tr.preCheckEnv && typeof tr.preCheckEnv === 'object') {
      out.preCheckEnv = Object.fromEntries(
        Object.entries(tr.preCheckEnv).map(([k, v]) => [k, subst(v)]));
    }
    // Trigger-level `emits` (#328) was removed (#783). Label hand-offs are the
    // template's role-level `emits`, applied to the member config below.
    return out;
  });

  const inputs = Array.isArray(t.inputs) ? t.inputs : [];
  const outputs = Array.isArray(t.outputs) ? t.outputs : [];
  const dependsOn = Array.isArray(t.dependsOn) ? t.dependsOn : [];
  const dataFlow = (inputs.length || outputs.length || dependsOn.length)
    ? {
      ...(inputs.length ? { inputs } : {}),
      ...(outputs.length ? { outputs } : {}),
      // dependsOn role ids → member ids so the live graph connects members.
      ...(dependsOn.length ? { dependsOn: dependsOn.map((d) => `${teamId}-${d}`) } : {}),
    }
    : null;

  return {
    id: memberId,
    displayName: memberDisplayName,
    systemPromptOverride: subst(t.promptTemplate || ''),
    // skillsOverride deliberately omitted — members inherit the team agent's
    // `skills[]` (team-owned grant).
    sessionPolicy: t.sessionPolicy === 'per-invocation' ? 'per-invocation' : undefined,
    triggers,
    // Declarative ports (parity with POST /api/teams): data-flow (#379),
    // hierarchy (#377), agent-level emits, stage band, GitHub ports (#380).
    ...(dataFlow ? { dataFlow } : {}),
    ...(typeof t.parent === 'string' && t.parent ? { parentMemberId: `${teamId}-${t.parent}` } : {}),
    // OUTCOMES port (#827): `{{var}}` substituted inside label/when like trigger
    // fields; supersedes `emits` when present. Only one of the two is carried.
    ...(isAuthoredOutcomes(t.outcomes)
      ? { outcomes: normalizeOutcomes(substituteOutcomes(t.outcomes, subst)) }
      : (Array.isArray(t.emits) && t.emits.length ? { emits: t.emits } : {})),
    ...(typeof t.stage === 'string' && t.stage ? { stage: t.stage } : {}),
    ...(t.github && (t.github.producesPr || t.github.producesIssue) ? { github: t.github } : {}),
    ...(Array.isArray(t.channels) && t.channels.length
      ? { channels: t.channels.map((c) => ({ ...c, from: `${teamId}-${c.from}` })) }
      : {}),
    ...(materialize !== undefined ? { materialize } : {}),
  };
}

module.exports = {
  buildProcessTemplate, validateProcessTemplate, templateToCustomRoles,
  buildMemberFromTemplate, liftTriggerEmits,
  expandGithubChannels, expandDataFlowSteps, normalizeLegacyReview,
  channelTriggerId, isChannelTrigger, stampDerivedActivation,
  outcomesBlock, stripOutcomesBlock, stripDerivedPromptBlocks, applyDerivedPromptBlocks,
  emptyDraftBundle, roleKeyOf, VERSION,
  artifactKey, artifactHint, artifactIsNamed,
  slugifyDraft, deriveUniqueDraftId,
};
