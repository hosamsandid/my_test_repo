// stage-model.js — pure generator for the stage/lane process view (#349).
//
// Operators think in ordered *stages* (Requirements → FDD → … → Run); this turns
// a stage list into the underlying draft bundle (roles + label wiring + review
// steps + human gates) so nobody types a label. The generated wiring is the
// SAME shape a hand-built graph produces, so the stage view and the graph view
// never diverge. Generated triggers are marked `_stageGen` so regeneration
// replaces only them and preserves any manual triggers.

export function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

// Normalise the operator's stage list: stable roleId (survives renames), a
// unique stage label slug, and the per-stage flags.
function normalizeStages(stages) {
  const seenRole = new Set();
  const seenSlug = new Set();
  return (stages || []).map((s, i) => {
    let roleId = s.roleId || slugify(s.name) || `stage-${i + 1}`;
    let rn = 2; while (seenRole.has(roleId)) roleId = `${slugify(s.name) || 'stage'}-${rn++}`;
    seenRole.add(roleId);
    let slug = slugify(s.name) || `stage-${i + 1}`;
    let sn = 2; const baseSlug = slug; while (seenSlug.has(slug)) slug = `${baseSlug}-${sn++}`;
    seenSlug.add(slug);
    return {
      id: s.id || `st${i + 1}`,
      roleId, slug,
      name: s.name || `Stage ${i + 1}`,
      requiresApproval: !!s.requiresApproval,
      hasReview: !!s.hasReview,
    };
  });
}

/**
 * Build a draft bundle from an ordered stage list. Preserves existing role
 * prompts/displayNames (matched by roleId) and any non-`_stageGen` triggers.
 * @param {Array} stages  [{ id?, roleId?, name, requiresApproval, hasReview }]
 * @param {object} base   the current bundle (for prompt/manual-trigger reuse)
 */
export function buildStageBundle(stages, base = {}) {
  const prev = new Map((base.roles || []).map(r => [r.id, r]));
  const norm = normalizeStages(stages);
  const roles = [];

  norm.forEach((s, i) => {
    const next = norm[i + 1];
    const before = norm[i - 1];
    const existing = prev.get(s.roleId) || {};

    // What this stage emits to wake the next one — nothing if a human gate
    // gates the transition (a human sets `human:<slug>-approved` instead).
    const emits = next && !s.requiresApproval ? [`stage:${next.slug}`] : [];

    const trig = {
      id: `stage-${s.slug}`,
      type: 'github-event',
      from: 'any-except-self',
      enabled: true,
      _stageGen: true,
      emits,
      description: `Stage: ${s.name}`,
      prompt: `Stage "${s.name}". Do your part of the process for this work item.` +
        (s.requiresApproval ? ' When done, wait for the human approval before it advances.' : ''),
    };
    if (i === 0) {
      // Kicked off when a work item (issue) is opened.
      trig.events = ['issues.opened'];
    } else {
      trig.events = ['issues.labeled'];
      // Woken by the previous stage's advance signal: its human gate, or its stage label.
      trig.labelFilter = before.requiresApproval ? `human:${before.slug}-approved` : `stage:${s.slug}`;
    }

    const manual = (existing.triggers || []).filter(t => !t._stageGen);
    roles.push({
      id: s.roleId,
      displayName: s.name,
      role: 'team-member',
      sessionPolicy: existing.sessionPolicy || 'persistent',
      systemPrompt: existing.systemPrompt || '',
      triggers: [trig, ...manual],
    });

    if (s.hasReview) {
      const revId = `${s.roleId}-review`;
      const revExisting = prev.get(revId) || {};
      roles.push({
        id: revId,
        displayName: `${s.name} review`,
        role: 'team-member',
        kind: 'pr-review',
        sessionPolicy: 'per-invocation',
        systemPrompt: revExisting.systemPrompt || '',
        review: {
          reviewsPrFrom: s.roleId,
          ...(next ? { onApprove: next.roleId } : {}),
          onChangesRequested: s.roleId,
        },
        triggers: [],
      });
    }
  });

  return {
    ...base,
    roles,
    stages: norm.map(s => ({ id: s.id, roleId: s.roleId, name: s.name, requiresApproval: s.requiresApproval, hasReview: s.hasReview })),
  };
}
