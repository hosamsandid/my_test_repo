// Build-time git version label for the footer (#483). VITE_GIT_COMMIT /
// VITE_GIT_DIRTY are embedded at build time (see admin-console/Dockerfile);
// there is no runtime lookup.
export function formatVersionLabel(commit, dirty) {
  if (!commit || commit === 'unknown') return 'unknown';
  return dirty === 'dirty' ? `${commit}-dirty` : commit;
}

// Human-readable, absolute commit creation timestamp for the sidebar About box
// (#1741). VITE_GIT_COMMIT_TIME is the commit's own committer date in strict
// ISO-8601 (git `%cI`, e.g. "2026-08-13T17:52:03+02:00"), embedded at build
// time next to the hash. We format it as "2026-08-13 17:52 +0200" by parsing
// the string's own fields — never `new Date()` — so the timezone the commit was
// authored in survives verbatim (a Date would rebase it onto the viewer's local
// zone and lose that, breaking AC3's unambiguity). Any shape we can't describe
// fails safe to "unknown" (AC5) so the box never shows an empty/broken value.
export function formatCommitTimestamp(iso, dirty) {
  const base = parseCommitTimestamp(iso);
  if (base === 'unknown') return 'unknown';
  return dirty === 'dirty' ? `${base} (dirty)` : base;
}

function parseCommitTimestamp(iso) {
  if (!iso || iso === 'unknown') return 'unknown';
  // date T hh:mm[:ss] (offset | Z)
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::\d{2})?(Z|[+-]\d{2}:?\d{2})$/.exec(iso);
  if (!m) return 'unknown';
  const [, date, time, rawTz] = m;
  const tz = rawTz === 'Z' ? '+0000' : rawTz.replace(':', '');
  return `${date} ${time} ${tz}`;
}
