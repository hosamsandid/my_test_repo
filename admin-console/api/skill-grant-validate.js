'use strict';

// Pure validator for skill-grant name lists (#633). The grant-aware pickers
// only ever offer real skills, so an unknown name reaching a save is either a
// stale grant carried through from before the picker existed, or a direct API
// call. We reject a NEWLY introduced unknown name (a typo that would otherwise
// become a silent dead grant — the exact footgun the free-text override had)
// while preserving names that were ALREADY granted, so pre-existing dead grants
// are surfaced/flagged in the UI and removed by hand rather than silently
// dropped (AC2 + AC4). No fs/network here — the caller supplies the known set.

function normalizeNames(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((s) => typeof s === 'string' && s.trim())
    .map((s) => s.trim());
}

function toSet(v) {
  return v instanceof Set ? v : new Set(normalizeNames(v));
}

// Returns { ok, unknown } where `unknown` is the de-duplicated list of
// submitted names that are neither a known skill nor already present in the
// previous grant (so a name being carried through unchanged never blocks a
// save). Order of first appearance is preserved for a stable error message.
function validateGrantNames(submitted, known, previous) {
  const knownSet = toSet(known);
  const prevSet = toSet(previous);
  const unknown = [];
  const seen = new Set();
  for (const name of normalizeNames(submitted)) {
    if (knownSet.has(name) || prevSet.has(name)) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    unknown.push(name);
  }
  return { ok: unknown.length === 0, unknown };
}

module.exports = { validateGrantNames, normalizeNames };
