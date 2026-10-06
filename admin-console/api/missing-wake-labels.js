'use strict';

// Wake labels that do not exist on their repository (#2878, epic #2880).
//
// A `github-event` trigger with a `labelFilter` wakes only when that label is
// added to an issue or PR. If the label does not exist on the trigger's
// repository, nobody can add it (`gh … --add-label` fails with "'<label>' not
// found") and the hand-off can never fire — silently. Team `agent-studio-3-0`
// listened on `ready-for-code-review-prod`, which the repo never had.
//
// Pure: the caller fetches the repositories' label names (the orchestrator's
// `GET /internal/teams/:teamId/repo-labels`) and passes them in. A repository
// whose labels could not be read is never reported — unknown is not missing.

function str(v) {
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * @param {Array} members  [{ id, triggers: [{ id, type, enabled, repo, labelFilter }] }]
 * @param {object} labelsByRepo  { "<owner/repo>": ["label", …] } — only repos that were read
 * @returns {Array} [{ repo, label, agentId, triggerId }], one per missing (repo, label, trigger)
 */
function missingWakeLabels(members, labelsByRepo) {
  const known = new Map();
  for (const [repo, names] of Object.entries(labelsByRepo || {})) {
    if (Array.isArray(names)) known.set(repo.toLowerCase(), new Set(names.map((n) => str(n).toLowerCase())));
  }
  const out = [];
  for (const m of Array.isArray(members) ? members : []) {
    for (const t of Array.isArray(m && m.triggers) ? m.triggers : []) {
      if (!t || t.type !== 'github-event' || t.enabled === false) continue;
      const repo = str(t.repo);
      const label = str(t.labelFilter);
      if (!repo || !label) continue;
      const names = known.get(repo.toLowerCase());
      // GitHub label names are case-insensitive.
      if (!names || names.has(label.toLowerCase())) continue;
      out.push({ repo, label, agentId: m.id, triggerId: t.id || null });
    }
  }
  return out;
}

// The repositories a team's label triggers listen on — what to fetch labels for.
function wakeLabelRepos(members) {
  const repos = new Set();
  for (const m of Array.isArray(members) ? members : []) {
    for (const t of Array.isArray(m && m.triggers) ? m.triggers : []) {
      if (t && t.type === 'github-event' && t.enabled !== false && str(t.repo) && str(t.labelFilter)) repos.add(str(t.repo));
    }
  }
  return [...repos].sort();
}

// One Flow-editor lint per missing (repo, label), naming every listener.
function missingWakeLabelLints(missing) {
  const byKey = new Map();
  for (const x of Array.isArray(missing) ? missing : []) {
    const k = `${x.repo}\u0000${x.label}`;
    if (!byKey.has(k)) byKey.set(k, { repo: x.repo, label: x.label, nodeIds: [] });
    if (!byKey.get(k).nodeIds.includes(x.agentId)) byKey.get(k).nodeIds.push(x.agentId);
  }
  return [...byKey.values()].map((x) => ({
    code: 'wake-label-missing',
    severity: 'warning',
    label: x.label,
    repo: x.repo,
    nodeId: x.nodeIds[0],
    message: `\`${x.label}\` does not exist on ${x.repo}, so ${x.nodeIds.map((id) => `\`${id}\``).join(', ')} can never be woken by it — adding it to an item fails.`,
  }));
}

// One plain line per missing label, for a materialisation's warnings.
function missingWakeLabelWarnings(missing) {
  return missingWakeLabelLints(missing).map((l) =>
    `Wake label '${l.label}' does not exist on ${l.repo} — its hand-off can never fire. Create it on GitHub or from the Flow editor.`);
}

module.exports = { missingWakeLabels, wakeLabelRepos, missingWakeLabelLints, missingWakeLabelWarnings };
