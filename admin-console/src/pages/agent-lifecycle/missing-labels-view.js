// Team Settings: wake labels that do not exist on their repository (#2878).
// Pure, so it unit-tests under `node --test`; MissingWakeLabelsSection.jsx
// renders it. Input is `GET /api/teams/:teamId/missing-labels`.

// One line per missing (repo, label), naming the agents that listen on it.
export function missingLabelRows(data) {
  const byKey = new Map();
  for (const m of Array.isArray(data && data.missing) ? data.missing : []) {
    if (!m || typeof m.repo !== 'string' || typeof m.label !== 'string') continue;
    const k = `${m.repo}\u0000${m.label}`;
    if (!byKey.has(k)) byKey.set(k, { key: k, repo: m.repo, label: m.label, agents: [] });
    if (m.agentId && !byKey.get(k).agents.includes(m.agentId)) byKey.get(k).agents.push(m.agentId);
  }
  return [...byKey.values()].map((r) => ({
    ...r,
    text: `'${r.label}' does not exist on ${r.repo} — ${r.agents.join(', ') || 'its agent'} can never be woken by it.`,
  }));
}

// The note for repositories whose labels could not be read; null when none.
export function unreadableNote(data) {
  const list = (Array.isArray(data && data.unreadable) ? data.unreadable : []).map((u) => u && u.repo).filter(Boolean);
  return list.length ? `Labels of ${list.join(', ')} could not be read, so they are not checked.` : null;
}
