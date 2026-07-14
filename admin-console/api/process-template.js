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
  if (Array.isArray(t.emits) && t.emits.length) out.emits = t.emits.slice();
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
      // Drop the derived producer block (#380) so the portable bundle stays clean;
      // it is regenerated from the `github` flag by expandGithubChannels.
      systemPrompt: stripProduceBlock(r.systemPrompt),
      // Agent-level emitted labels (label hand-offs) — keep in the portable bundle.
      ...(Array.isArray(r.emits) && r.emits.length ? { emits: r.emits.slice() } : {}),
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
    // Agent-level emitted labels (label hand-offs) — recorded on member config.
    ...(Array.isArray(r.emits) && r.emits.length ? { emits: r.emits } : {}),
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
      emits: t.emits,
      dataFlow: t.dataFlow,
      channel: t.channel,
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

const CHANNEL_EVENTS = {
  pr: { open: ['pull_request.opened', 'pull_request.reopened'], labeled: ['pull_request.labeled'] },
  issue: { open: ['issues.opened'], labeled: ['issues.labeled'] },
};

// Canonical id for a derived channel trigger, so reconciliation can find and
// regenerate it (kept in sync with reconcileTeamGithubChannels in api.js).
function channelTriggerId(consumerId, artifact, producerId) {
  return `${consumerId}-on-${artifact}-${producerId}`;
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
// Pure; `now` is injectable for tests.
function stampDerivedActivation(nextTriggers, prevTriggers, now) {
  const prevAt = new Map();
  for (const t of (Array.isArray(prevTriggers) ? prevTriggers : [])) {
    if (t && typeof t.id === 'string' && t.activatedAt) prevAt.set(t.id, t.activatedAt);
  }
  const stamp = now || new Date().toISOString();
  return (Array.isArray(nextTriggers) ? nextTriggers : []).map((t) => {
    if (!t || typeof t !== 'object') return t;
    const derived = t.channel === true || t.dataFlow === true;
    if (!derived || t.activatedAt) return t;
    return { ...t, activatedAt: prevAt.get(t.id) || stamp };
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
    for (const ch of (b.channels || [])) {
      const artifact = ch.artifact === 'issue' ? 'issue' : 'pr';
      const from = typeof ch.from === 'string' ? ch.from : '';
      if (!from || from === b.id) continue;
      const label = typeof ch.label === 'string' && ch.label.trim() ? ch.label.trim() : '';
      const human = ch.gate === 'human';
      const id = channelTriggerId(b.id, artifact, from);
      if (b.triggers.some(t => t.id === id)) continue;
      const events = (label ? CHANNEL_EVENTS[artifact].labeled : CHANNEL_EVENTS[artifact].open).slice();
      const producerName = byId.get(from)?.displayName || from;
      b.triggers.push({
        id,
        type: 'github-event',
        events,
        ...(label ? { labelFilter: label } : {}),
        // No origin filter: the trigger fires on any matching PR/issue event.
        // A human gate is expressed purely by the `human:*` label convention
        // (the labelFilter above) — humans apply it; agents don't, by convention.
        channel: true,
        enabled: true,
        description: `${artifact === 'pr' ? 'PR' : 'Issue'} from ${producerName}`
          + `${label ? ` labelled ${label}` : ''}${human ? ' (human-approved)' : ''}`,
        prompt: artifact === 'pr'
          ? consumePrPrompt(producerName, { label, human })
          : consumeIssuePrompt(producerName, { label, human }),
      });
    }
    // Producer instruction block — idempotent (strip any prior block, re-append).
    const stripped = stripProduceBlock(b.systemPrompt || '');
    const block = produceBlock(b.github);
    b.systemPrompt = block ? `${stripped ? stripped + '\n\n' : ''}${block}` : stripped;
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

module.exports = {
  buildProcessTemplate, validateProcessTemplate, templateToCustomRoles,
  expandGithubChannels, expandDataFlowSteps, normalizeLegacyReview,
  channelTriggerId, isChannelTrigger, stampDerivedActivation,
  emptyDraftBundle, roleKeyOf, VERSION,
  artifactKey, artifactHint, artifactIsNamed,
  slugifyDraft, deriveUniqueDraftId,
};
