// Pure row model behind SkillPicker (#1143). Extracted so the two-tier
// collapse, the shadow/unknown/drift flags and the drift → Lineage deep-link
// target are covered by node:test (admin-console-src CI job) — the JSX shell in
// SkillPicker.jsx stays a thin renderer over these rows.
//
// `skills` are the objects from GET /api/skills[?teamId=]: each carries
// { name, source: 'pool'|'team', teamId?, description?, version?, drift? }. The
// grant is name-based, so there is ONE row per name; when a team skill shadows a
// global one of the same name, team-first resolution wins and the row says so.

export function tierOf(source) {
  return source === 'team' ? 'team' : 'global';
}

// Collapse the skill list to one row per name (team-first) and append any
// selected-but-unknown names as flagged rows so an existing grant renders
// unchanged (AC4). Rows are sorted by name; unknown rows follow the known ones.
export function buildRows(skills, selected) {
  const byName = new Map();
  for (const s of skills || []) {
    if (!s || typeof s.name !== 'string') continue;
    const tier = tierOf(s.source);
    const cur = byName.get(s.name) || { name: s.name, tiers: {} };
    cur.tiers[tier] = s;
    byName.set(s.name, cur);
  }
  const rows = [];
  for (const { name, tiers } of byName.values()) {
    const effective = tiers.team || tiers.global;
    rows.push({
      name,
      tier: tiers.team ? 'team' : 'global',
      teamId: (tiers.team && effective.teamId) || null,
      shadowsGlobal: !!(tiers.team && tiers.global),
      description: effective.description || '',
      version: Number.isInteger(effective.version) ? effective.version : null,
      drift: effective.drift && effective.drift !== 'in-sync' ? effective.drift : null,
      unknown: false,
    });
  }
  rows.sort((a, b) => a.name.localeCompare(b.name));
  const known = new Set(rows.map(r => r.name));
  for (const name of selected || []) {
    if (typeof name === 'string' && name && !known.has(name)) {
      rows.push({ name, unknown: true });
      known.add(name);
    }
  }
  return rows;
}

// Deep-link a drifted row to its Lineage/Drift view on the Skills page. Mirrors
// the SkillsRegistry deep-link contract (#774 AC5, extended with `tab` in #1143):
// `?skill=<name>&tier=<pool|team>&team=<id>&tab=lineage`. Team rows carry their
// teamId so the viewer resolves the right copy; global rows use tier=pool.
export function driftLineageHref(row) {
  if (!row || !row.name) return null;
  const params = new URLSearchParams();
  params.set('skill', row.name);
  if (row.tier === 'team') {
    params.set('tier', 'team');
    if (row.teamId) params.set('team', row.teamId);
  } else {
    params.set('tier', 'pool');
  }
  params.set('tab', 'lineage');
  return `/skills?${params.toString()}`;
}
