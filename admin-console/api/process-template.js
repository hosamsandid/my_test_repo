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
//                triggers: [ { id, type, events, labelFilter, from, cron, at,
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

// Remap a PR-review step's role references through roleKeyOf so an exported
// team's review wiring uses portable role keys (#347).
function remapReview(review, teamId) {
  const r = review || {};
  const out = {};
  if (r.reviewsPrFrom) out.reviewsPrFrom = roleKeyOf(r.reviewsPrFrom, teamId);
  if (r.onApprove) out.onApprove = roleKeyOf(r.onApprove, teamId);
  if (r.onChangesRequested) out.onChangesRequested = roleKeyOf(r.onChangesRequested, teamId);
  if (Array.isArray(r.paths) && r.paths.length) out.paths = r.paths.slice();
  return out;
}

// Slim a trigger for the bundle: keep what defines the wiring + behaviour, drop
// team-specific/runtime cruft (repo is re-applied at materialise time; secrets
// never live on triggers).
function bundleTrigger(t) {
  const out = { id: t.id, type: t.type, enabled: t.enabled !== false };
  if (t.type === 'github-event') {
    out.events = Array.isArray(t.events) ? t.events : [];
    if (t.from) out.from = t.from;
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
      // PR-review steps carry their structured routing (#347); plain agents omit it.
      ...(r.kind === 'pr-review' ? { kind: 'pr-review', review: remapReview(r.review, teamId) } : {}),
      sessionPolicy: r.sessionPolicy || 'persistent',
      systemPrompt: r.systemPrompt || '',
      // Agent-level emitted labels (label hand-offs) — keep in the portable bundle.
      ...(Array.isArray(r.emits) && r.emits.length ? { emits: r.emits.slice() } : {}),
      triggers: (r.triggers || []).map(bundleTrigger),
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
    name: name || 'Untitled process',
    level: 'template',
    roles: [],
    gates: [],
    labels: [],
    stages: [],
  };
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
    // Agent-level emitted labels (label hand-offs) — recorded on member config.
    ...(Array.isArray(r.emits) && r.emits.length ? { emits: r.emits } : {}),
    triggers: (r.triggers || []).map(t => ({
      id: t.id,
      type: t.type,
      enabled: t.enabled !== false,
      events: t.events,
      labelFilter: t.labelFilter,
      from: t.from,
      cron: t.cron,
      at: t.at,
      emits: t.emits,
      dataFlow: t.dataFlow,
      description: t.description,
      promptTemplate: t.prompt || '',
      preCheckScript: t.preCheckScript,
      preCheckEnv: t.preCheckEnv,
    })),
  }));
}

// ─── PR-review steps (#347) ──────────────────────────────────────────────
// Native GitHub PR reviews (Approve / Request changes), CODEOWNERS-style — not
// a custom label. A `pr-review` role is a real reviewer agent; this expansion
// (run only at materialise time) turns its structured routing into concrete
// triggers and injects the producer's rework trigger, then drops the meta so
// the role materialises like any other agent.

function reviewerPrompt(paths) {
  const scope = Array.isArray(paths) && paths.length
    ? `\n\nReview only changes touching: ${paths.map(p => `\`${p}\``).join(', ')}.`
    : '';
  return [
    'A pull request was opened or reopened in this repo (see the event payload above).',
    'Review it and submit a **native GitHub PR review**:',
    '- if it meets the bar, **Approve** it;',
    '- otherwise **Request changes** with specific, actionable line comments.',
    'Use `gh-as-agent` so your review is attributed to you. Do not merge — approval is the human/branch-protection step.' + scope,
    '',
    'Reply `[PASS]` if there is nothing to review (e.g. the PR is a draft or already reviewed).',
  ].join('\n');
}

function reworkPrompt(reviewerName) {
  return [
    `A PR review was submitted (see the event payload above). If the verdict from **${reviewerName}** is *Request changes*:`,
    '- address every comment, push new commits (this dismisses the stale review), and re-request review;',
    '- if you disagree, reply on the PR explaining why rather than silently ignoring it.',
    'If the verdict is *Approve* or *Comment*, reply `[PASS]`.',
  ].join('\n');
}

/**
 * Expand `pr-review` roles in a bundle into concrete agent wiring (materialise
 * time). Returns a NEW bundle: reviewer gets a PR-opened trigger + review
 * protocol; the reviewed producer gets a `pull_request_review.submitted` rework
 * trigger; the `kind`/`review` meta is removed. Non-review roles pass through.
 */
function expandReviewSteps(bundle) {
  const roles = (bundle.roles || []).map(r => ({ ...r, triggers: (r.triggers || []).slice() }));
  const byId = new Map(roles.map(r => [r.id, r]));

  for (const r of roles) {
    if (r.kind !== 'pr-review') continue;
    const rv = r.review || {};
    // Reviewer reacts to opened/reopened PRs and submits a native review.
    r.triggers.push({
      id: `${r.id}-review`,
      type: 'github-event',
      events: ['pull_request.opened', 'pull_request.reopened'],
      from: 'any-except-self',
      enabled: true,
      description: `Review PRs${rv.reviewsPrFrom ? ` from ${rv.reviewsPrFrom}` : ''}`,
      prompt: reviewerPrompt(rv.paths),
    });
    r.sessionPolicy = 'per-invocation';

    // Producer reacts to review submissions to rework on "Request changes".
    const producer = rv.reviewsPrFrom && byId.get(rv.reviewsPrFrom);
    if (producer && !producer.triggers.some(t => t.id === `${producer.id}-rework-${r.id}`)) {
      producer.triggers.push({
        id: `${producer.id}-rework-${r.id}`,
        type: 'github-event',
        events: ['pull_request_review.submitted'],
        from: 'any-except-self',
        enabled: true,
        description: `Rework on review from ${r.displayName || r.id}`,
        prompt: reworkPrompt(r.displayName || r.id),
      });
    }
    // The role is now a plain reviewer agent — drop the modeling meta.
    delete r.kind;
    delete r.review;
  }
  return { ...bundle, roles };
}

// ─── Data-flow steps (#379) ───────────────────────────────────────────────
// Core principle: agents hand files off via `git commit` + `git push`, so a
// push by an upstream agent IS the signal that downstream data is ready. This
// expansion (run only at materialise time) turns each data-flow edge —
// `depends_on` (ordering) and artifact output→input matches (data) — into a
// concrete `push` github-event trigger on the *consumer*, scoped via
// `from: ['<teamId>-<upstream>']` to that one upstream agent. Far more targeted
// than a generic push trigger: it fires only when a predecessor in the data
// chain pushes. The poller's existing origin attribution (commit author
// `<id>@agents.local`), `from` allowlist, and loop protection (layers 0/2/3)
// carry it — no runtime/router change.
//
// Path-level precision is deliberately NOT applied: the trigger fires on any
// push by the upstream and the woken agent decides whether the change is
// relevant (it can `[PASS]`). This also covers the case where an agent chose to
// produce something other than its declared artifact.

function dataFlowPrompt(upstreamName, paths) {
  const inputs = paths.length
    ? `Your declared inputs from it: ${paths.map(p => `\`${p}\``).join(', ')}.`
    : 'It is an upstream dependency of yours.';
  return [
    `Your upstream **${upstreamName}** just pushed to the team repo (the event payload above has the branch and commits).`,
    inputs,
    '',
    'Before you act:',
    '1. `git fetch`, then check out the pushed branch and `git pull --ff-only` (the ref is in the payload).',
    '2. Inspect what changed and confirm the inputs you need are present and complete.',
    '3. If this push does not actually affect your work, reply `[PASS]` — skipping is fine.',
    '',
    'Then do your part and commit + push your own outputs so your downstream agents are notified the same way.',
  ].join('\n');
}

/**
 * Expand data-flow edges into `push` triggers (materialise time). Returns a NEW
 * bundle; roles without dependencies/inputs are untouched (no-op for catalog
 * teams). `inputs/outputs/dependsOn` stay on the roles (carried to config by
 * templateToCustomRoles for the live graph).
 * @param {object} bundle
 * @param {{ teamId?: string }} [opts] - teamId to map a role id → member id
 *   (`<teamId>-<roleId>`) for the `from` allowlist.
 */
function expandDataFlowSteps(bundle, { teamId } = {}) {
  const roles = (bundle.roles || []).map(r => ({ ...r, triggers: (r.triggers || []).slice() }));
  const byId = new Map(roles.map(r => [r.id, r]));
  const memberId = (roleId) => (teamId ? `${teamId}-${roleId}` : roleId);
  const pathOf = (a) => (typeof a === 'string' ? a : (a && a.path)) || '';

  // Producers by artifact output path.
  const producersByPath = new Map();
  for (const r of roles) {
    for (const a of (r.outputs || [])) {
      const p = pathOf(a);
      if (!p) continue;
      if (!producersByPath.has(p)) producersByPath.set(p, []);
      producersByPath.get(p).push(r.id);
    }
  }

  for (const b of roles) {
    // upstream role id -> Set(path); empty set = pure dependency edge.
    const upstream = new Map();
    const ensure = (id) => { if (!upstream.has(id)) upstream.set(id, new Set()); return upstream.get(id); };

    for (const dep of (b.dependsOn || [])) {
      if (typeof dep === 'string' && dep && dep !== b.id && byId.has(dep)) ensure(dep);
    }
    for (const a of (b.inputs || [])) {
      const p = pathOf(a);
      if (!p) continue;
      for (const producer of (producersByPath.get(p) || [])) {
        if (producer !== b.id) ensure(producer).add(p);
      }
    }

    for (const [upId, paths] of upstream) {
      const triggerId = `${b.id}-on-push-${upId}`;
      if (b.triggers.some(t => t.id === triggerId)) continue; // idempotent
      b.triggers.push({
        id: triggerId,
        type: 'github-event',
        events: ['push'],
        from: [memberId(upId)],
        // Marker so the UI renders this as an agent data-flow dependency (an
        // editable "push from <upstream>" hand-off) rather than a raw push
        // trigger. The poller ignores unknown fields. (#379)
        dataFlow: true,
        enabled: true,
        description: `Data flow: wake on push from ${byId.get(upId)?.displayName || upId}`,
        prompt: dataFlowPrompt(byId.get(upId)?.displayName || upId, [...paths].sort()),
      });
    }
  }

  return { ...bundle, roles };
}

module.exports = {
  buildProcessTemplate, validateProcessTemplate, templateToCustomRoles,
  expandReviewSteps, expandDataFlowSteps, emptyDraftBundle, roleKeyOf, VERSION,
};
