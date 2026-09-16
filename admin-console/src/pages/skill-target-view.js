// Pure view helpers for the Skills Registry's global-entry permission
// narrowing (#2307): one rule for every path that writes into the global or a
// team skill pool (import, merge, create, edit) — mirrors the server's
// scope.js `isTeamAdminOfAny` / `canManageTeam` and skill-transfer.js's
// `requiredPoolWritePermission`. Kept pure (no React, no fetch) so it is
// unit-tested and shared by the Import-to and +New Skill target selectors.
//
// UX only — every mutating route re-checks server-side (#2307 D-none, same
// caveat as credential-scope-view.js). The point is to avoid landing a caller
// on a target that is certain to 403, per AC11/AC12/AC14.
//
// `caller` is the `{ isSysAdmin, adminTeamIds }` shape ModelRegistry.jsx
// already derives from the session user via credential-scope-view.js's
// `adminTeamIdsOf` — reused here rather than re-deriving it.

// May the caller write into the GLOBAL skill pool? System Admin, or Team
// Admin of at least one team (#2178/#2180/#2307 — entering global is a
// Team-Admin act, not System-Admin-only).
export function canWriteGlobalSkills({ isSysAdmin, adminTeamIds = [] } = {}) {
  return !!isSysAdmin || adminTeamIds.length > 0;
}

// The team options to OFFER in a target selector: every team for a System
// Admin (AC15 — no capability lost anywhere), else only the teams the caller
// administers (AC13 — not every team they are merely a member of).
export function writableTeamOptions({ isSysAdmin, adminTeamIds = [] } = {}, teams = []) {
  const list = Array.isArray(teams) ? teams : [];
  if (isSysAdmin) return list;
  const ids = new Set(adminTeamIds);
  return list.filter(t => t && ids.has(t.id));
}

// Every target the caller may write to, as `{value, label}` options — global
// first when writable, then each writable team as `team:<id>` (AC11/AC12).
export function writableSkillTargets(caller, teams = []) {
  const out = [];
  if (canWriteGlobalSkills(caller)) out.push({ value: 'global', label: 'Global pool (visible to all teams)' });
  for (const t of writableTeamOptions(caller, teams)) {
    out.push({ value: `team:${t.id}`, label: `Team: ${t.name || t.id} (${t.id})` });
  }
  return out;
}

// The value a target selector should be pre-set to — always a permitted
// target (AC11), or '' when the caller may write nowhere (AC14 disables the
// control on an empty value rather than offering a target certain to fail).
export function defaultSkillTarget(caller, teams = []) {
  const options = writableSkillTargets(caller, teams);
  return options.length ? options[0].value : '';
}
