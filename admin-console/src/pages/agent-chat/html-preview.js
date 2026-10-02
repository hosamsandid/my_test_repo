// Pure helpers for the Workspace viewer's sandboxed HTML preview (#2778).
// React-free so they can be unit-tested with plain `node --test` (#651).
//
// Agent-written HTML is untrusted, so the preview is a confirm-every-time,
// opt-in view: raw source by default, a warning dialog on EVERY switch to
// Rendered (no persisted choice), and an iframe whose content comes from the
// `/html-preview` endpoint — which carries its own CSP sandbox headers
// (admin-console/api/html-preview.js). The iframe's `sandbox` attribute below is
// the second, independent layer.

import { workspaceUrl } from './workspace-source.js';

// Mirrors HTML_PREVIEW_MAX_BYTES in admin-console/api/html-preview.js
// (parity-tested). Above it the viewer offers download instead of a render.
export const HTML_PREVIEW_MAX_BYTES = 5 * 1024 * 1024; // 5 MB

// The iframe's sandbox flags: scripts, and nothing else. NEVER add
// allow-same-origin — the preview would then run with the viewer's console
// session (S1). A source guard in html-preview.test.js pins this.
export const HTML_PREVIEW_SANDBOX = 'allow-scripts';

export function isHtmlFile(path) {
  return /\.html?$/i.test(String(path || ''));
}

// Whether the /file response describes an HTML file the Rendered toggle may be
// offered for: a non-empty, non-binary .html/.htm. An empty or binary-flagged
// file gets no toggle (edge case). An oversize one still gets the toggle — it
// answers with the "too large" message instead of the dialog (AC9).
export function canOfferHtmlPreview(relPath, data) {
  if (!isHtmlFile(relPath) || !data) return false;
  if (data.binary) return false;
  return typeof data.size === 'number' && data.size > 0;
}

export function isHtmlTooLarge(data) {
  return !!data && typeof data.size === 'number' && data.size > HTML_PREVIEW_MAX_BYTES;
}

// Preview URL for one confirmed opening. `openId` changes per confirmation so
// every opening is a fresh document (and a fresh network request); `external`
// is the dialog checkbox for THIS opening only.
export function htmlPreviewUrl(agentId, key, { external = false, openId = 0 } = {}) {
  const base = workspaceUrl(agentId, key, 'html-preview');
  if (!base) return null;
  return `${base}${external ? '&external=1' : ''}&v=${encodeURIComponent(String(openId))}`;
}

/* ─── View state ──────────────────────────────────────────────────────── */
//
// One reducer for the viewer's Raw/Rendered state. For HTML, "rendered" is only
// reachable through "confirm"; nothing about a confirmation survives a switch
// back to raw, a file change or a close, so the dialog shows on every opening
// (AC3). For Markdown it is the old plain toggle.
//
//   mode: 'raw' | 'confirm' | 'rendered' | 'too-large'
//   external: whether THIS rendered opening may load external resources
//   openId: increments per confirmed opening (iframe key + URL cache-buster)
//   relPath: the file this state belongs to

export function initialViewState(relPath) {
  const md = String(relPath || '').toLowerCase().endsWith('.md');
  return { mode: md ? 'rendered' : 'raw', external: false, openId: 0, relPath: relPath == null ? '' : String(relPath) };
}

// The state to render for `relPath`. A state recorded for another file is never
// reused — not even for the one render before the reset effect runs — so a
// confirmation for file A can never render file B (AC3).
export function viewStateFor(state, relPath) {
  const key = relPath == null ? '' : String(relPath);
  if (!state || state.relPath !== key) return initialViewState(key);
  return state;
}

export function viewStateReducer(state, action) {
  switch (action && action.type) {
    case 'reset':
      return { ...initialViewState(action.relPath), openId: state.openId };
    case 'toggle': {
      if (state.mode === 'rendered' || state.mode === 'too-large' || state.mode === 'confirm') {
        return { ...state, mode: 'raw', external: false };
      }
      if (!action.html) return { ...state, mode: 'rendered' };
      if (action.tooLarge) return { ...state, mode: 'too-large', external: false };
      return { ...state, mode: 'confirm', external: false };
    }
    case 'confirm':
      if (state.mode !== 'confirm') return state;
      return { ...state, mode: 'rendered', external: !!action.external, openId: state.openId + 1 };
    case 'cancel':
      if (state.mode !== 'confirm') return state;
      return { ...state, mode: 'raw', external: false };
    // The frame navigated away from the preview document (a link or a
    // meta-refresh): drop it, like switching to Raw.
    case 'navigated':
      if (state.mode !== 'rendered') return state;
      return { ...state, mode: 'raw', external: false };
    default:
      return state;
  }
}

// What the body shows for a given state: the raw source while the dialog is
// open (nothing is rendered until the user confirms — AC3).
export function bodyViewMode(state) {
  return state.mode === 'confirm' ? 'raw' : state.mode;
}

// Banner text above the rendered frame (AC4).
export function htmlPreviewBannerText(external) {
  return 'Untrusted content from an agent — do not enter passwords or credentials. '
    + (external ? 'External resources are allowed for this preview.' : 'External resources are blocked.');
}
