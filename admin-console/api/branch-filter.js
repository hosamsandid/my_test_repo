'use strict';

// Push-trigger branch filter (#2570) — the console's write-side half: parse,
// validate and normalize a github-event trigger's `branchFilter` before it is
// persisted. The matching itself lives in orchestrator/branch-filter.js (the
// poller); the form/card copy in src/pages/agent-chat/branch-filter.js; the
// agent-side advisory in agent-entrypoint.py `_branch_filter_error`. The
// console cannot require the orchestrator module — keep the four in sync.
//
// Stored form: an array of trimmed, de-duplicated patterns, or the key absent
// (no filter = every branch). Input may be that array or a comma-separated
// string. `*` matches within one path segment, `**` across `/`; everything else
// is literal.

function parseBranchFilter(raw) {
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

// Why one entry can never name a branch, or null when it is usable.
function branchPatternError(entry) {
  if (/[\s\x00-\x1f\x7f]/.test(entry)) return 'contains whitespace or a control character';
  if (entry.startsWith('/') || entry.endsWith('/')) return 'must not start or end with "/"';
  if (entry.includes('//')) return 'must not contain "//"';
  if (entry.includes('***')) return 'only "*" and "**" are wildcards';
  return null;
}

// Human-readable error for a trigger's branchFilter, or null when valid.
// Absent / null / blank is valid (no filter).
function branchFilterError(raw) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string' && !(Array.isArray(raw) && raw.every(v => typeof v === 'string'))) {
    return 'branchFilter must be a comma-separated string or an array of branch names';
  }
  for (const entry of parseBranchFilter(raw)) {
    const why = branchPatternError(entry);
    if (why) return `branchFilter entry "${entry}" ${why}`;
  }
  return null;
}

// Normalize `t.branchFilter` in place to the stored form: the parsed array, or
// the key removed when blank. Call after validation.
function normalizeBranchFilter(t) {
  if (!t || typeof t !== 'object' || !('branchFilter' in t)) return t;
  const list = parseBranchFilter(t.branchFilter);
  if (list.length) t.branchFilter = list;
  else delete t.branchFilter;
  return t;
}

module.exports = { parseBranchFilter, branchPatternError, branchFilterError, normalizeBranchFilter };
