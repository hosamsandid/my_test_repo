// Detect loop-closing roles an Agent Team is missing relative to the reference
// process template it was assembled from, and offer a one-click add (#1375).
//
// Teams built piecewise from a template (dev + reviewer only, say) run part of
// the SDLC loop and then stall at the first missing role's terminal label — a
// missing `merger` leaves `ready-to-merge` idle; a missing `reworker` leaves
// `revisions-required` idle. The team config does NOT persist which template it
// came from (POST /api/teams flattens the bundle into members and discards the
// template identity), so the source is INFERRED here from two signals the team
// agent DOES persist:
//
//   1. The gate/brake label registry (`team.labels[]`, #928) — the strongest
//      fingerprint, since each shipped template has a distinct registry. We match
//      by containment: a template whose whole label set is present on the team is
//      a candidate, and the most-specific (largest) contained registry wins. Label
//      tokens are suffix-stripped first (#902) so a team created with a
//      `labelSuffix` still matches its source template.
//   2. Present member role-ids, recovered from each member id (`<teamId>-<roleId>`,
//      the deterministic materialisation scheme) — used as the fallback signal
//      when a team carries no label registry (hand-built / pre-#928), and always
//      to compute which roles are missing.
//
// Conservative by design: when nothing clearly matches we surface NOTHING (an
// empty result), so unrelated teams never sprout spurious buttons — the button
// surface is purely additive (issue #1375 "zero risk to existing teams").
//
// Pure — no React dependency — so it's unit-tested directly
// (missing-roles-view.test.js) even though this repo has no JSX/component test
// runner yet (#651).

// Strip a trailing `-<suffix>` label-suffix (#902) from a token, if present.
function stripSuffix(token, suffix) {
  if (typeof token !== 'string') return '';
  const t = token.trim();
  if (suffix && t.endsWith(`-${suffix}`)) return t.slice(0, -(suffix.length + 1));
  return t;
}

// Recover the set of role-ids currently present on a team from its member ids.
// A member id is `<teamId>-<roleId>` (POST /api/teams materialisation scheme).
// Multi-instance roles add a `-N` suffix (`<teamId>-<roleId>-2`); the base role
// counts as present either way, so a trailing `-<digits>` is trimmed.
export function presentRoleIds(teamId, members) {
  const prefix = `${teamId}-`;
  const out = new Set();
  for (const m of members || []) {
    const id = m && typeof m.id === 'string' ? m.id : '';
    if (!id.startsWith(prefix)) continue;
    let roleId = id.slice(prefix.length);
    roleId = roleId.replace(/-\d+$/, ''); // drop multi-instance suffix
    if (roleId) out.add(roleId);
  }
  return out;
}

// Score how well a template matches the team by label-registry containment.
// Returns the count of the template's labels that are present on the team when
// the WHOLE registry is contained, else -1 (not a label-containment candidate).
function labelContainmentScore(teamLabelSet, template) {
  const tplLabels = Array.isArray(template.labels)
    ? template.labels.map(l => (l && typeof l.name === 'string' ? l.name.trim() : '')).filter(Boolean)
    : [];
  if (tplLabels.length === 0) return -1;
  const contained = tplLabels.every(l => teamLabelSet.has(l));
  return contained ? tplLabels.length : -1;
}

// Infer the source template for a team and the roles it is missing.
//
// @param {object} team       - the team agent config ({ id, labels?, labelSuffix? }).
// @param {object[]} members  - the team's member agent configs ({ id }).
// @param {object[]} templates - full process-template bundles
//                               ({ id, name, roles: [{id, displayName}], labels? }).
// @returns {{ templateId, templateName, missing: [{id, displayName}] } | null}
//          null when no template clearly matches or nothing is missing.
export function inferMissingRoles(team, members, templates) {
  if (!team || !Array.isArray(templates) || templates.length === 0) return null;
  const teamId = team.id;
  const present = presentRoleIds(teamId, members);
  if (present.size === 0) return null; // empty team — nothing to infer from

  const suffix = typeof team.labelSuffix === 'string' ? team.labelSuffix : '';
  const teamLabelSet = new Set(
    (Array.isArray(team.labels) ? team.labels : [])
      .map(l => (l && typeof l.name === 'string' ? stripSuffix(l.name, suffix) : ''))
      .filter(Boolean),
  );

  let winner = null;

  if (teamLabelSet.size > 0) {
    // Primary signal: label-registry containment. Pick the most-specific
    // (largest) template whose entire registry is present on the team. This
    // cleanly disambiguates templates that share role names but differ in labels
    // (e.g. core-sdlc vs dispatched-sdlc). Deterministic tie-break by template id.
    let bestScore = -1;
    for (const tpl of [...templates].sort((a, b) => String(a.id).localeCompare(String(b.id)))) {
      const score = labelContainmentScore(teamLabelSet, tpl);
      if (score > bestScore) { bestScore = score; winner = tpl; }
    }
    if (bestScore < 0) winner = null;
  }

  if (!winner) {
    // Fallback signal (team carries no usable label registry): role-id overlap.
    // Require a clear, unambiguous winner — a strong majority of present roles
    // overlap AND a strictly larger overlap than any other template — else we
    // surface nothing rather than guess.
    const scored = templates.map(tpl => {
      const roleIds = new Set((tpl.roles || []).map(r => r.id));
      let overlap = 0;
      for (const r of present) if (roleIds.has(r)) overlap += 1;
      return { tpl, overlap };
    }).sort((a, b) => b.overlap - a.overlap || String(a.tpl.id).localeCompare(String(b.tpl.id)));

    const top = scored[0];
    const runnerUp = scored[1];
    const strongMajority = top && top.overlap >= 2 && top.overlap * 2 >= present.size;
    const clearWinner = top && (!runnerUp || top.overlap > runnerUp.overlap);
    if (strongMajority && clearWinner) winner = top.tpl;
  }

  if (!winner) return null;

  const missing = (winner.roles || [])
    .filter(r => r && typeof r.id === 'string' && !present.has(r.id))
    .map(r => ({ id: r.id, displayName: r.displayName || r.id }));
  if (missing.length === 0) return null;

  return { templateId: winner.id, templateName: winner.name || winner.id, missing };
}
