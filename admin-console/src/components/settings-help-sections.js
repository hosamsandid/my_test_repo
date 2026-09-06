// ─── Settings dialog help chapters (#1996, epic #1981) ───────────────────────
//
// The "?" in the Settings dialog opens the `settings` help topic AT the chapter
// that explains the section you are looking at. A chapter is addressed by the
// slug of its heading (see sectionSlug in context/page-help-view.js), so this
// file is the one place those slugs are written down — SettingsModal.jsx imports
// from here, and settings-help-extraction.test.js asserts each value is really a
// heading in help-topics/settings.md.
//
// The keys are the dialog's own section ids (SECTIONS in settings-modal-view.js),
// which is what lets the single "?" in the section header resolve its chapter by
// lookup instead of a switch — a fourth section added there without a chapter
// here degrades to "open the topic from the top" rather than breaking, and the
// extraction test is what turns that silent degradation into a CI failure.
//
// It lives beside SettingsModal.jsx rather than in src/pages/, because the
// dialog is a component (an overlay over every route), not a page — unlike the
// other #1981 registries, whose surfaces are pages. Same flat-beside-the-source
// convention as skills-help-sections.js (#1990) and token-usage-help-sections.js
// (#1994).

export const SETTINGS_HELP_SECTIONS = {
  // 1 — the send keybinding, both presets, the always-works modifier chord
  behavior: 'behavior-how-the-composer-sends',
  // 2 — assist model != agent model, the closed helper list, the oauth-token gap
  model: 'model-which-provider-ai-helpers-bill-against',
  // 3 — theme options and the 10–18 px transcript stepper
  display: 'display-theme-and-transcript-size',
};

export default SETTINGS_HELP_SECTIONS;
