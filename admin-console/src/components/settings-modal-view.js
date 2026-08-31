// Pure model for the user Settings modal's sectioned layout (#651 — SettingsModal.jsx
// stays a thin renderer over these).
//
// UX-1 (#1802) ships the modal shell empty — the individual preferences are
// migrated into these sections by the dependent tickets UX-3 / UX-4 / UX-8. The
// section list is the ordered set of tabs the shell renders; each id is the
// stable key a later ticket hangs its preference controls on.
export const SETTINGS_SECTIONS = [
  { id: 'behavior', label: 'Behavior', blurb: 'How agents respond and interact.' },
  { id: 'model', label: 'Model', blurb: 'Provider and model defaults for AI helpers.' },
  { id: 'display', label: 'Display', blurb: 'Theme, density and other display preferences.' },
];

// The section shown when the modal first opens.
export function defaultSectionId() {
  return SETTINGS_SECTIONS[0].id;
}

// Resolve a (possibly stale) section id to a valid one, falling back to the
// first section so the content pane always has something to render.
export function resolveSectionId(id, sections = SETTINGS_SECTIONS) {
  if (!Array.isArray(sections) || sections.length === 0) return null;
  return sections.some((s) => s.id === id) ? id : sections[0].id;
}

// Arrow-key navigation across the tab rail: dir === +1 moves to the next section,
// -1 to the previous, wrapping at both ends so focus never falls off the rail.
export function adjacentSectionId(currentId, dir, sections = SETTINGS_SECTIONS) {
  const n = Array.isArray(sections) ? sections.length : 0;
  if (n === 0) return null;
  let idx = sections.findIndex((s) => s.id === currentId);
  if (idx === -1) idx = 0;
  const next = (((idx + dir) % n) + n) % n;
  return sections[next].id;
}

// The section descriptor for an id (or the first section as a safe fallback).
export function sectionById(id, sections = SETTINGS_SECTIONS) {
  if (!Array.isArray(sections) || sections.length === 0) return null;
  return sections.find((s) => s.id === id) || sections[0];
}
