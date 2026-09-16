'use strict';

// Agent Pools — Phase 4: LLM conflict prediction (#2249, epic #2251; design of
// record `docs/parallel-workers-concept.md` D6, §7). Pure module — no fs, no
// network — mirroring `flow-supervisor.js`'s own shape: this owns the SHAPE of
// a predicted-path set (sanitize, overlap check, prompt text, response
// parsing) and the deterministic heuristic fallback; `orchestrator.js` is the
// impure half that fetches the issue body/repo tree, calls the LLM, and
// caches the result per ticket.
//
// WHY THIS EXISTS (D6). Conflict avoidance is layered and optional. Baseline:
// WIP count + the post-hoc ledger (`ticket-reconciler.js`'s `conflict` /
// `stale-base` / `superseded` blockers) — always present, never removed by
// this phase. Added preventively for SDLC: epic-serialization (#2247, always
// on, not gated by `contentionPolicy` — Amendment 1 A1.4), THEN, only when a
// team opts in (`autoDispatch.contentionPolicy: "predicted-paths"`), a
// read-only pre-flight that guesses which files a ready item will touch and
// avoids starting two overlapping items concurrently. Sequential conflicts
// (A's base goes stale while B merges) are explicitly NOT eliminated — that is
// the ledger's `stale-base` job, unaffected by any of this.
//
// A prediction is advisory, never authoritative: an empty/missing/failed
// prediction imposes NO extra restriction (the ticket is treated exactly as it
// would be with `contentionPolicy` unset) — the safety net is the ledger, not
// this heuristic guess.

const MAX_PREDICTED_PATHS = 20;
const MAX_PATH_LENGTH = 200;
const MAX_REPO_TREE_SAMPLE = 300;

// Normalize one path-ish token for both storage and overlap comparison: trim,
// forward slashes, drop a leading "./", drop trailing slashes, lowercase (git
// hosting is case-insensitive often enough on shared filesystems that treating
// "Docs/x" and "docs/x" as the same conflict risk is the safer default for a
// PREDICTION, not an exact-match tool). Returns '' for anything unusable.
function normalizePathToken(raw) {
  if (typeof raw !== 'string') return '';
  let p = raw.trim().replace(/\\/g, '/');
  if (!p) return '';
  p = p.replace(/^\.\/+/, '').replace(/\/+$/, '');
  if (!p || p === '.' || p === '..') return '';
  if (p.length > MAX_PATH_LENGTH) p = p.slice(0, MAX_PATH_LENGTH);
  return p.toLowerCase();
}

/**
 * Clean an arbitrary list of candidate path strings (from an LLM response or
 * the heuristic extractor) into a deduplicated, capped, normalized array.
 * Never throws; a non-array input yields `[]`.
 */
function sanitizePathList(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const p = normalizePathToken(raw);
    if (!p || seen.has(p)) continue;
    seen.add(p);
    out.push(p);
    if (out.length >= MAX_PREDICTED_PATHS) break;
  }
  return out;
}

/**
 * Do two predicted-path sets name overlapping work? Exact match, OR one names
 * a directory that CONTAINS the other's path (a coarse LLM guess like
 * `orchestrator/` should still catch a sibling's precise
 * `orchestrator/flow-supervisor.js`). Both inputs are normalized defensively
 * (a caller may hand un-sanitized data), so this is safe to call directly.
 */
function pathsOverlap(a, b) {
  const as = sanitizePathList(a);
  const bs = sanitizePathList(b);
  if (!as.length || !bs.length) return false;
  for (const pa of as) {
    for (const pb of bs) {
      if (pa === pb || pa.startsWith(`${pb}/`) || pb.startsWith(`${pa}/`)) return true;
    }
  }
  return false;
}

// A capped, newline-joined repo-tree sample for the prompt — the "repo
// structure" half of the AC ("LLM over the issue + repo structure"). Absent
// tree (network/API failure, or none fetched) collapses to an empty section,
// which is fine: the model still has the issue text, and the heuristic
// fallback never needed the tree at all.
function formatRepoTreeSample(paths) {
  if (!Array.isArray(paths) || paths.length === 0) return '';
  return paths.slice(0, MAX_REPO_TREE_SAMPLE).join('\n');
}

/**
 * The single user-turn prompt sent to the LLM for one ticket's pre-flight.
 * Deliberately asks for STRICT JSON (a bare array of strings) so the response
 * parser has one shape to trust; `parsePredictedPathsResponse` still tolerates
 * prose/code-fence wrapping since models do not always comply exactly.
 */
function buildPredictionPrompt({ title, body, repoTree } = {}) {
  const treeSample = formatRepoTreeSample(repoTree);
  const lines = [
    'You are a read-only pre-flight check for a software team\'s work scheduler.',
    'Given the ticket below, predict which repository files or directories are',
    'MOST LIKELY to be touched by whoever implements it. Be conservative: name',
    'only paths you have real reason to believe are relevant from the ticket',
    'text and the repository listing.',
    '',
    `Ticket title: ${String(title || '(untitled)')}`,
    'Ticket body:',
    String(body || '(empty)').slice(0, 4000),
  ];
  if (treeSample) {
    lines.push('', 'A sample of the repository\'s file paths (not exhaustive):', treeSample);
  }
  lines.push(
    '',
    `Respond with ONLY a JSON array of up to ${MAX_PREDICTED_PATHS} path strings`,
    '(files or directory prefixes), most likely first. No prose, no markdown',
    'fences. If you cannot make a reasonable guess, respond with [].',
  );
  return lines.join('\n');
}

// Pull the first top-level JSON array literal out of a blob of text, tolerating
// a ```json fenced block or a little surrounding prose — models do not always
// comply with "respond with ONLY...". Returns the raw (still un-sanitized)
// parsed array, or null when nothing array-shaped could be found/parsed.
function extractJsonArray(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [];
  if (fenced) candidates.push(fenced[1]);
  const bracketStart = text.indexOf('[');
  const bracketEnd = text.lastIndexOf(']');
  if (bracketStart !== -1 && bracketEnd > bracketStart) {
    candidates.push(text.slice(bracketStart, bracketEnd + 1));
  }
  candidates.push(text);
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate.trim());
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // try the next candidate shape
    }
  }
  return null;
}

/**
 * Parse the LLM's raw text response into a clean predicted-path array, or
 * `null` when the response is not usable at all (the caller's cue to fall
 * back to the heuristic, not to treat it as "predicted nothing"). An empty
 * `[]` from the model IS a usable answer (the model made a call and found
 * nothing likely) and returns `[]`, not `null`.
 */
function parsePredictedPathsResponse(text) {
  const arr = extractJsonArray(text);
  if (arr === null) return null;
  return sanitizePathList(arr.filter((x) => typeof x === 'string'));
}

// A path-shaped token: at least one "/" (a real repo path), or a bare filename
// carrying a plausible extension — deliberately narrow so prose words like
// "the auth flow" never get swept in as a "path".
const PATH_TOKEN_RE = /`?([a-zA-Z0-9_.\-]+\/[a-zA-Z0-9_./\-]+|[a-zA-Z0-9_\-]+\.[a-zA-Z0-9]{1,8})`?/g;

/**
 * The deterministic, LLM-free fallback (AC: "LLM ... or a heuristic"): scan
 * the ticket's own text for path-shaped tokens (backtick-quoted or bare) —
 * exactly the convention this repo's own issues already follow (e.g.
 * `` `docs/parallel-workers-concept.md` ``). No repo-structure lookup, no
 * network — always available, always cheap, used whenever no assist LLM
 * binding is configured for the team or the LLM call/parse fails.
 */
function extractHeuristicPaths(text) {
  if (typeof text !== 'string' || !text) return [];
  const found = [];
  let m;
  PATH_TOKEN_RE.lastIndex = 0;
  while ((m = PATH_TOKEN_RE.exec(text)) !== null) {
    found.push(m[1]);
  }
  return sanitizePathList(found);
}

module.exports = {
  MAX_PREDICTED_PATHS,
  MAX_PATH_LENGTH,
  MAX_REPO_TREE_SAMPLE,
  normalizePathToken,
  sanitizePathList,
  pathsOverlap,
  formatRepoTreeSample,
  buildPredictionPrompt,
  parsePredictedPathsResponse,
  extractHeuristicPaths,
};
