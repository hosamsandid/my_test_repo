/**
 * clone-team-view.js — the copy, id derivation and credential-needs summary
 * for the "Clone team…" action (#2171, epic #2166 A5).
 *
 * Cloning a team copies its structure — repository URLs/branches, mcpServers
 * refs, model provider, toolchain and additional context — never its
 * credentials (per-repo SSH key, GitHub token, MCP credential). The server
 * enforces the stripping (`copyEnvironmentStructure`, reused via
 * `POST /api/environments`'s `copyFromTeamId`); this module only derives the
 * id/name a fresh clone starts with and turns the server's
 * `credentialsNeeded` report into plain-language lines the dialog renders —
 * so the creator sees exactly which credentials the new team still needs
 * before anything is materialized.
 *
 * Dependency-free and unit-tested per the #651 convention; the dialog JSX in
 * `AgentLifecycleForms.jsx` renders whatever this returns.
 */

const TEAM_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

// Derive a slug-valid team id (mirrors TEAM_ID_RE in admin-console/api/api.js)
// from the source team's id, unique across the supplied existing-id set.
// Server still enforces uniqueness — this is just a friendlier starting point.
export function suggestCloneTeamId(sourceId, existingIds) {
  const base = `${String(sourceId || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '')}-clone`
    || 'team-clone';
  if (!existingIds.has(base)) return base;
  let n = 2;
  while (existingIds.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

export function isValidCloneTeamId(id) {
  return TEAM_ID_RE.test(id || '');
}

export function suggestCloneTeamName(sourceName) {
  const base = (sourceName || '').trim();
  return base ? `${base} (Clone)` : '';
}

export function cloneTeamDialogCopy(team) {
  const name = (team && (team.displayName || team.id)) || 'this team';
  return {
    title: `Clone "${name}"`,
    confirmLabel: 'Clone team',
    maxWidth: 520,
  };
}

/**
 * The server's `credentialsNeeded` report (from the cloned environment's
 * response) turned into one line per outstanding credential. Deliberately
 * never names a credential id — there isn't one yet, that is the whole point.
 */
export function credentialsNeededLines(credentialsNeeded) {
  const lines = [];
  const repos = Array.isArray(credentialsNeeded?.repositories) ? credentialsNeeded.repositories : [];
  const mcpServers = Array.isArray(credentialsNeeded?.mcpServers) ? credentialsNeeded.mcpServers : [];
  if (credentialsNeeded?.needsGithubToken) {
    lines.push('A GitHub token, to clone and push its repositories.');
  }
  for (const r of repos) {
    lines.push(`An SSH key for ${r.url}${r.branch ? ` (${r.branch})` : ''}, unless it will use the GitHub token over HTTPS.`);
  }
  for (const m of mcpServers) {
    lines.push(`A credential for the "${m.serverId}" MCP server.`);
  }
  return lines;
}

/**
 * Post-clone confirmation. Stub members (the default — see below) mean
 * nothing was cloned or attempted yet, so the notice points at supplying
 * credentials before materializing rather than reporting a failure.
 */
export function cloneResultNotice(response) {
  if (!response || !response.teamId) return null;
  const needs = credentialsNeededLines(response.credentialsNeeded);
  const base = `Cloned into the team "${response.teamName || response.teamId}", with its structure and none of its `
    + 'credentials. Its members were created as stubs, so nothing was cloned or attempted yet.';
  if (needs.length === 0) return `${base} No credentials are needed — you can materialize its members now.`;
  return `${base} Before materializing, add: ${needs.join(' ')}`;
}
