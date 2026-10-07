// Push-trigger branch filter (#2570) — the trigger form's parse / validate and
// the card's summary copy. Pure so `node --test` covers it. The console bundle
// cannot import the CommonJS server modules; this mirrors
// admin-console/api/branch-filter.js (write validation, same messages) and
// orchestrator/branch-filter.js (matching) — keep them in sync.
//
// Form value: a comma-separated string. Stored value: an array of trimmed,
// de-duplicated patterns, or no key at all (no filter = every branch).

// Split on commas, trim, drop empties and duplicates.
export function parseBranchFilter(raw) {
  const parts = [];
  if (typeof raw === 'string') parts.push(...raw.split(','));
  else if (Array.isArray(raw)) {
    for (const v of raw) if (typeof v === 'string') parts.push(...v.split(','));
  }
  const out = [];
  for (const p of parts) {
    const s = p.trim();
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

function branchPatternError(entry) {
  if (/[\s\x00-\x1f\x7f]/.test(entry)) return 'contains whitespace or a control character';
  if (entry.startsWith('/') || entry.endsWith('/')) return 'must not start or end with "/"';
  if (entry.includes('//')) return 'must not contain "//"';
  if (entry.includes('***')) return 'only "*" and "**" are wildcards';
  return null;
}

// Form-level error for the Branches field, or null when valid (blank = valid).
export function branchFilterFormError(raw) {
  for (const entry of parseBranchFilter(raw)) {
    const why = branchPatternError(entry);
    if (why) return `Branches: "${entry}" ${why}.`;
  }
  return null;
}

// The stored array → the form's editable string ("main, feature/*").
export function branchFilterToInput(stored) {
  return parseBranchFilter(stored).join(', ');
}

// The PUT/POST body value: the parsed array, or `null` so an edit clears a
// stored filter when the field is blanked or hidden.
export function branchFilterBody(raw, { show = true } = {}) {
  if (!show) return null;
  const list = parseBranchFilter(raw);
  return list.length ? list : null;
}

// Form copy. Kept here, not inline in the JSX: the wiring tests strip `/* … */`
// comments from TriggersPanel.jsx, and a literal `feature/*` would open one.
export const BRANCH_FILTER_PLACEHOLDER = 'e.g. main, feature/* (leave empty for all branches)';
export const BRANCH_FILTER_HELP = 'Empty = all branches. Comma-separated; * matches within one path segment '
  + '(feature/*), ** also across / (feature/**). Names match exactly and case-sensitively; '
  + 'tag pushes never match a filter.';

// #2602: pushes to a knowledge-base branch never wake a push trigger — built
// in, not configurable. The form shows this read-only note under Branches.
// `branches` are the repo's KB branches from the poller's repo status
// (`knowledgeBranches`); unknown / empty falls back to the default name.
export function knowledgeBranchNote(branches) {
  const list = Array.isArray(branches) ? branches.filter(b => typeof b === 'string' && b) : [];
  const named = list.length
    ? `on this repository: ${list.map(b => `'${b}'`).join(', ')}`
    : "e.g. 'agent-knowledge'";
  return `Pushes to knowledge-base branches (${named}) never wake push triggers. This can't be changed.`;
}

// The KB branches the poller knows for `repo` (`owner/name`), from the
// `/api/github-events/repo-status` rows; [] when unknown.
export function knowledgeBranchesForRepo(rows, repo) {
  if (!Array.isArray(rows) || typeof repo !== 'string' || !repo) return [];
  const want = repo.toLowerCase();
  const row = rows.find(r => r && typeof r.repo === 'string' && r.repo.toLowerCase() === want);
  return row && Array.isArray(row.knowledgeBranches) ? row.knowledgeBranches : [];
}
