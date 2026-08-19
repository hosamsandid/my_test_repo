// App-shell volatile-region masks (docs/journey-spec-concept.md §7).
//
// This module contributes no journey steps — only a `volatileLocators` export,
// which the step-registry aggregates and the recorder applies as a screenshot
// `mask` on EVERY capture (recorder.js). It exists so shell chrome that is
// present on every page but varies between builds does not create spurious
// visual-diff noise against the main baseline.
//
// `app-version`: the sidebar footer renders the running build's commit creation
// timestamp (`VITE_GIT_COMMIT_TIME`, #1741 — was the `v{VITE_GIT_COMMIT}` hash),
// baked in at build time. The baseline is built at main's SHA and each PR at its
// own SHA, so this label differs by construction on every PR — masking it keeps
// the before/after diff focused on real UI changes.

/** @param {import('@playwright/test').Page} page */
function volatileLocators(page) {
  return [page.getByTestId('app-version')];
}

module.exports = { volatileLocators };
