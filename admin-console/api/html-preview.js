'use strict';

// Sandboxed rendered preview for agent-written HTML files in the Workspace
// viewer (#2778). Agent output is untrusted — an agent can be steered by what it
// reads (web pages, issues, tickets) into writing a malicious page — and the
// console's session cookie lives on the SAME origin as /api. So the preview
// endpoint never serves HTML that could run in the console's origin: every
// response carries a header CSP whose `sandbox` directive gives the document an
// opaque origin (S1) with scripts as the only capability (S2), and whose fetch
// directives keep the network off unless the user opted in for this opening
// (S3). Because these are RESPONSE HEADERS, they hold even when the URL is
// opened directly in a new tab (S4), and a `<meta http-equiv>` inside the file
// can only tighten them, never widen them (CSPs intersect).
//
// Pure (no fs, no express) so the policy is unit-testable on its own; api.js
// owns the routes and only asks this module what to send.

// Upper size limit for a rendered preview. Above it the viewer offers download
// instead of a truncated render (AC9). Mirrored in the browser by
// src/pages/agent-chat/html-preview.js (parity-tested).
const HTML_PREVIEW_MAX_BYTES = 5 * 1024 * 1024; // 5 MB

// The ONLY sandbox capability the preview gets. Deliberately absent:
// allow-same-origin (S1), allow-forms, allow-popups, allow-top-navigation*,
// allow-downloads, allow-modals, allow-pointer-lock (S2).
const HTML_PREVIEW_SANDBOX = 'allow-scripts';

function isHtmlPreviewPath(p) {
  return /\.html?$/i.test(String(p || ''));
}

// `?external=1` is the only spelling that turns external resources on — any
// other value (absent, '0', 'true', an array from a repeated param) stays off.
function wantsExternalResources(query) {
  return !!query && query.external === '1';
}

// Directives shared by both modes: no plugins, no form posts, no <base> games,
// and only the console itself may frame the preview.
const COMMON_DIRECTIVES = [
  "object-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'self'",
  `sandbox ${HTML_PREVIEW_SANDBOX}`,
];

// Network off (default): inline <style>/<script> and data:/blob: assets work,
// nothing else is fetched or sent — no external scripts/styles/fonts/images,
// no fetch/XHR/WebSocket/beacon (connect-src falls back to 'none').
const OFFLINE_DIRECTIVES = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval' data: blob:",
  "style-src 'unsafe-inline' data: blob:",
  'img-src data: blob:',
  'font-src data: blob:',
  'media-src data: blob:',
];

// Network on (user ticked "Also load external resources" for this opening):
// any host may be loaded. S1/S2 still hold — the sandbox directive is shared.
const EXTERNAL_DIRECTIVES = [
  "default-src * data: blob: 'unsafe-inline' 'unsafe-eval'",
];

function htmlPreviewCsp({ external = false } = {}) {
  const fetchDirectives = external ? EXTERNAL_DIRECTIVES : OFFLINE_DIRECTIVES;
  return [...fetchDirectives, ...COMMON_DIRECTIVES].join('; ');
}

// Every header the preview response sends. `Content-Type` pins UTF-8 (agent
// output is UTF-8; without it a file lacking <meta charset> would be decoded
// as windows-1252).
function htmlPreviewHeaders({ external = false, size } = {}) {
  const headers = {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': htmlPreviewCsp({ external }),
    'Content-Disposition': 'inline',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), display-capture=()',
  };
  if (Number.isFinite(size)) headers['Content-Length'] = size;
  return headers;
}

// Why a file cannot be previewed, or null when it can. `head` is the first
// bytes of the file (for the NUL-byte binary probe the /file route uses).
function htmlPreviewRefusal({ relPath, size, head }) {
  if (!isHtmlPreviewPath(relPath)) {
    return { status: 415, error: 'Only .html and .htm files can be previewed', code: 'not-html' };
  }
  if (typeof size === 'number' && size > HTML_PREVIEW_MAX_BYTES) {
    return { status: 413, error: 'File is too large to preview — download it instead', code: 'too-large' };
  }
  if (head && head.length && head.slice(0, Math.min(head.length, 8192)).includes(0)) {
    return { status: 415, error: 'Binary file — preview unavailable', code: 'binary' };
  }
  return null;
}

module.exports = {
  HTML_PREVIEW_MAX_BYTES,
  HTML_PREVIEW_SANDBOX,
  isHtmlPreviewPath,
  wantsExternalResources,
  htmlPreviewCsp,
  htmlPreviewHeaders,
  htmlPreviewRefusal,
};
