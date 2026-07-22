// Skill lifecycle tabs + suggestion-inbox derivation (#775, skill-UX Phase 2).
//
// Pure, side-effect-free helpers so the Knowledge page's skills column can be
// structured into lifecycle tabs (In use / Ready / Suggested) and the open
// promotion-suggestions turned into a ranked, grouped, cap-able inbox. Kept
// React-free and unit-tested with node:test (the CI-covered admin-console/api
// gate + the src/pages *.test.js pattern established by skill-rollout-view.js).
//
// Nothing here talks to the network or the DOM — the JSX passes in the graph's
// skill nodes and the /promotion-suggestions candidates and renders whatever
// these return.

// Candidate `source` values the triage view can filter on (issue #775 §3):
// the collector's convergence clusters, the curator's related-theme bundles
// (#604), an agent's own nomination, and operator "combine into skill".
export const SUGGESTION_SOURCES = ['convergence', 'related', 'agent-nominated', 'manual'];

export const INBOX_CAP = 10;                 // top-N shown inline on the Suggested tab
const RECENCY_HALFLIFE_DAYS = 14;            // evidence recency decay half-life
const DAY_MS = 24 * 3600 * 1000;

// ── Lifecycle tabs ─────────────────────────────────────────────────────────
// A promoted skill is "In use" once its activation overlay says active, else it
// sits in "Ready" (today's "promoted · not activated"). Suggestions live in
// their own tab and never mix with real skills.
export function skillLifecycle(skill) {
  return skill && skill.activation && skill.activation.active ? 'inuse' : 'ready';
}

export function partitionSkills(skills) {
  const list = Array.isArray(skills) ? skills : [];
  const inuse = [];
  const ready = [];
  for (const sk of list) {
    if (skillLifecycle(sk) === 'inuse') inuse.push(sk); else ready.push(sk);
  }
  return { inuse, ready };
}

// ── Evidence scoring ───────────────────────────────────────────────────────
// "involved agents × lesson count × recency", computed from fields the
// candidate already carries. Recency is an exponential decay so a fresh
// two-agent cluster can out-rank a stale many-agent one, without ever driving
// the score to zero (age only ever discounts, never nullifies, the evidence).
function timestampOf(s) {
  if (!s || typeof s !== 'object') return null;
  const candidates = [s.raisedAt];
  for (const m of Array.isArray(s.members) ? s.members : []) {
    if (m && m.createdAt) candidates.push(m.createdAt);
  }
  let best = null;
  for (const t of candidates) {
    const ms = t ? Date.parse(t) : NaN;
    if (!Number.isNaN(ms) && (best === null || ms > best)) best = ms;
  }
  return best;
}

export function recencyWeight(s, now) {
  const ts = timestampOf(s);
  const nowMs = typeof now === 'number' ? now : Date.parse(now);
  if (ts === null || Number.isNaN(nowMs)) return 0.5; // no timestamp → neutral
  const ageDays = Math.max(0, (nowMs - ts) / DAY_MS);
  return 0.5 ** (ageDays / RECENCY_HALFLIFE_DAYS);
}

export function evidenceScore(s, now) {
  const c = s && typeof s === 'object' ? s : {};
  const agents = Math.max(1, Number(c.convergenceCount)
    || (Array.isArray(c.convergence) ? c.convergence.length : 0) || 1);
  const lessons = Math.max(1, Number(c.lessonCount)
    || (Array.isArray(c.members) ? c.members.length : 0) || 1);
  return agents * lessons * recencyWeight(c, now);
}

// ── Sorting ────────────────────────────────────────────────────────────────
export const SORT_MODES = ['evidence', 'newest', 'oldest'];

export function sortSuggestions(suggestions, mode, now) {
  const list = (Array.isArray(suggestions) ? suggestions : []).slice();
  const ts = (s) => timestampOf(s) ?? -Infinity;
  const byId = (a, b) => String(a.id || '').localeCompare(String(b.id || ''));
  if (mode === 'newest') {
    list.sort((a, b) => (ts(b) - ts(a)) || byId(a, b));
  } else if (mode === 'oldest') {
    list.sort((a, b) => (ts(a) - ts(b)) || byId(a, b));
  } else {
    // evidence (default): score desc, tie-break newest then id for stability.
    list.sort((a, b) => (evidenceScore(b, now) - evidenceScore(a, now))
      || (ts(b) - ts(a)) || byId(a, b));
  }
  return list;
}

// ── Theme grouping ─────────────────────────────────────────────────────────
// `source: 'related'` candidates are the curator's thematic bundles (#604):
// they render as their own group (header + members), while every other kind of
// candidate falls under "Single suggestions". Order within each group is
// preserved from the ranked input.
export function groupSuggestions(sorted) {
  const list = Array.isArray(sorted) ? sorted : [];
  const themed = [];
  const singles = [];
  for (const s of list) {
    if (s && s.source === 'related') themed.push(s); else singles.push(s);
  }
  return { themed, singles };
}

// ── Search ─────────────────────────────────────────────────────────────────
function norm(q) { return String(q == null ? '' : q).trim().toLowerCase(); }

export function skillMatchesQuery(skill, query) {
  const q = norm(query);
  if (!q) return true;
  const hay = `${(skill && skill.label) || ''} ${(skill && skill.tier) || ''}`.toLowerCase();
  return hay.includes(q);
}

export function suggestionMatchesQuery(s, query) {
  const q = norm(query);
  if (!q) return true;
  const parts = [s && s.text, s && s.draft && s.draft.name, s && s.note];
  for (const m of Array.isArray(s && s.members) ? s.members : []) {
    if (m && m.text) parts.push(m.text);
  }
  return parts.some(p => typeof p === 'string' && p.toLowerCase().includes(q));
}

// ── Inbox assembly ─────────────────────────────────────────────────────────
// One call turns the open candidates into everything the Suggested tab needs:
// search-filtered, ranked, capped to `cap`, then grouped into themes + singles.
// `total` counts the post-search matches so "View all n →" is honest about how
// many the cap is hiding.
export function buildInbox(suggestions, {
  mode = 'evidence', now, cap = INBOX_CAP, query = '', sourceFilter = null,
} = {}) {
  let list = (Array.isArray(suggestions) ? suggestions : []).filter(Boolean);
  if (sourceFilter && SUGGESTION_SOURCES.includes(sourceFilter)) {
    list = list.filter(s => (s.source || 'convergence') === sourceFilter);
  }
  if (norm(query)) list = list.filter(s => suggestionMatchesQuery(s, query));
  const ranked = sortSuggestions(list, mode, now);
  const shown = cap == null ? ranked : ranked.slice(0, cap);
  const { themed, singles } = groupSuggestions(shown);
  return {
    total: ranked.length,
    shown,
    themed,
    singles,
    hiddenCount: Math.max(0, ranked.length - shown.length),
  };
}

// ── Tab counts + new-evidence dot ────────────────────────────────────────────
export function tabCounts(skills, openSuggestions) {
  const { inuse, ready } = partitionSkills(skills);
  const suggested = (Array.isArray(openSuggestions) ? openSuggestions : []).length;
  return { inuse: inuse.length, ready: ready.length, suggested };
}

// True when any open suggestion carries evidence newer than the operator's last
// visit to the Suggested tab (drives the "new evidence" dot). A missing/blank
// lastVisit means "never visited" → dot on if there is anything at all.
export function hasNewEvidence(openSuggestions, lastVisitIso) {
  const list = Array.isArray(openSuggestions) ? openSuggestions : [];
  if (list.length === 0) return false;
  const last = lastVisitIso ? Date.parse(lastVisitIso) : NaN;
  if (Number.isNaN(last)) return true;
  return list.some(s => {
    const ts = timestampOf(s);
    return ts !== null && ts > last;
  });
}
