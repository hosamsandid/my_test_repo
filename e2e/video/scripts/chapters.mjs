// Walkthrough chapter registry + selection (#749).
//
// The dedicated `walkthrough-video.yml` workflow_dispatch exposes a `journeys`
// input so an operator can render one chapter (or a subset) on demand instead of
// the whole walkthrough. This pure, dependency-free module maps that selection to
// the composed `npm run render:<id>` scripts in package.json — it is the single
// source of truth for "which chapters exist" and is unit-tested without booting
// Revideo (the heavy render itself only runs in the manual CI job / a workstation).
//
// Adding a chapter = one entry here + its `render:<id>` script in package.json.

// Ordered so a full `all` render always produces chapters in a stable sequence.
export const CHAPTERS = [
  { id: 'team-setup', script: 'render:team-setup' },
  { id: 'iban-story', script: 'render:iban-story' },
];

export function chapterIds() {
  return CHAPTERS.map((c) => c.id);
}

// Parse the raw `journeys` selection. `all` (any case) and an empty/blank value
// both mean "every chapter" and return null; otherwise a comma- and/or
// whitespace-separated list of ids.
export function parseSelection(raw) {
  const sel = (raw || '').trim();
  if (!sel || sel.toLowerCase() === 'all') return null;
  return sel
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// Resolve a selection to the ordered list of chapter objects to render. Throws on
// an unknown id (a typo should fail loudly, not silently render nothing). The
// result keeps registry order and de-duplicates repeated ids.
export function resolveChapters(raw) {
  const ids = parseSelection(raw);
  if (ids === null) return [...CHAPTERS];

  const known = new Set(chapterIds());
  const unknown = ids.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown journey id(s): ${unknown.join(', ')}. ` +
        `Valid ids: ${chapterIds().join(', ')} (or 'all').`,
    );
  }

  const wanted = new Set(ids);
  return CHAPTERS.filter((c) => wanted.has(c.id));
}
