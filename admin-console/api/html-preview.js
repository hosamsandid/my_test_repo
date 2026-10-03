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

// In-memory browser storage for the previewed page (#2786). The opaque origin
// (S1) makes the browser throw a SecurityError on localStorage,
// sessionStorage, document.cookie and indexedDB, which aborts the many agent
// pages that read a theme setting first thing. This script replaces them with
// stand-ins that live only in this document: nothing persists across openings
// (each opening is a fresh document) and nothing reaches the console origin or
// the network. It is NOT a security boundary — the headers above still are —
// and it needs no extra sandbox capability; it runs as inline script, which
// the CSP already allows in both network modes.
//
// Runs before any of the file's own scripts, removes its own <script> element
// so the page's DOM looks as authored, and never throws (each stand-in is
// installed on its own so one failure does not take the others down).
const HTML_PREVIEW_STORAGE_SHIM = `(function () {
  function define(obj, name, desc) {
    try { desc.configurable = true; Object.defineProperty(obj, name, desc); } catch (e) {}
  }
  function makeStorage() {
    var data = new Map();
    var api = {
      getItem: function (k) { k = String(k); return data.has(k) ? data.get(k) : null; },
      setItem: function (k, v) { data.set(String(k), String(v)); },
      removeItem: function (k) { data.delete(String(k)); },
      clear: function () { data.clear(); },
      key: function (i) { i = Math.floor(Number(i)) || 0; var ks = Array.from(data.keys()); return i >= 0 && i < ks.length ? ks[i] : null; }
    };
    var own = function (p) { return typeof p === 'string' && !Object.prototype.hasOwnProperty.call(api, p) && p !== 'length'; };
    return new Proxy(api, {
      get: function (t, p) {
        if (p === 'length') return data.size;
        if (Object.prototype.hasOwnProperty.call(t, p)) return t[p];
        return own(p) && data.has(p) ? data.get(p) : undefined;
      },
      set: function (t, p, v) { if (own(p)) data.set(p, String(v)); return true; },
      deleteProperty: function (t, p) { if (own(p)) data.delete(p); return true; },
      has: function (t, p) { return p === 'length' || p in t || (own(p) && data.has(p)); },
      ownKeys: function () { return Array.from(data.keys()); },
      getOwnPropertyDescriptor: function (t, p) {
        if (own(p) && data.has(p)) return { value: data.get(p), writable: true, enumerable: true, configurable: true };
        return undefined;
      }
    });
  }
  var local = makeStorage();
  var session = makeStorage();
  define(window, 'localStorage', { get: function () { return local; } });
  define(window, 'sessionStorage', { get: function () { return session; } });

  var jar = new Map();
  define(document, 'cookie', {
    get: function () { return Array.from(jar, function (e) { return e[0] ? e[0] + '=' + e[1] : e[1]; }).join('; '); },
    set: function (v) {
      var parts = String(v).split(';');
      var pair = parts.shift();
      var eq = pair.indexOf('=');
      var name = (eq < 0 ? '' : pair.slice(0, eq)).trim();
      var value = (eq < 0 ? pair : pair.slice(eq + 1)).trim();
      var expired = parts.some(function (a) {
        var kv = a.split('='); var k = kv[0].trim().toLowerCase(); var val = kv.slice(1).join('=').trim();
        if (k === 'max-age') return Number(val) <= 0;
        if (k === 'expires') { var t = Date.parse(val); return !isNaN(t) && t <= Date.now(); }
        return false;
      });
      if (expired) jar.delete(name); else jar.set(name, value);
    }
  });

  function failedRequest() {
    var req = new EventTarget();
    var err = new DOMException('Storage is not available in the preview', 'InvalidStateError');
    req.result = undefined; req.error = err; req.readyState = 'pending'; req.source = null; req.transaction = null;
    req.onsuccess = null; req.onerror = null; req.onupgradeneeded = null; req.onblocked = null;
    setTimeout(function () {
      req.readyState = 'done';
      var ev = new Event('error', { cancelable: true });
      try { if (typeof req.onerror === 'function') req.onerror(ev); } catch (e) { setTimeout(function () { throw e; }); }
      req.dispatchEvent(ev);
    });
    return req;
  }
  var idb = {
    open: function () { return failedRequest(); },
    deleteDatabase: function () { return failedRequest(); },
    databases: function () { return Promise.resolve([]); },
    cmp: function (a, b) { return a < b ? -1 : a > b ? 1 : 0; }
  };
  define(window, 'indexedDB', { get: function () { return idb; } });

  try { document.currentScript.remove(); } catch (e) {}
})();`;

const SHIM_TAG = Buffer.from(`<script>${HTML_PREVIEW_STORAGE_SHIM}</script>`, 'utf8');

// Byte offset where the shim goes: after the leading BOM, whitespace,
// comments, <?xml …?> and the doctype (so the doctype stays first and the page
// keeps standards mode), then after an opening <html …> and <head …> when they
// come next, so the shim lands inside <head> without the parser dropping their
// attributes. Anything else (a bare <title>, a fragment, an empty file) gets
// the shim right after that prolog — the parser then opens <html>/<head>
// implicitly, as it would for the file on its own. Matched on a latin1 view so
// string indices are byte offsets and multi-byte UTF-8 is never split.
function storageShimOffset(buf) {
  const s = buf.toString('latin1');
  let i = s.startsWith('\xEF\xBB\xBF') ? 3 : 0;
  const skip = (re) => {
    re.lastIndex = i;
    const m = re.exec(s);
    if (m && m.index === i) { i += m[0].length; return true; }
    return false;
  };
  const SPACE = /\s+/y;
  const COMMENT = /<!--[\s\S]*?(?:-->|$)/y;
  const BOGUS = /<\?[^>]*>?/y;
  const DOCTYPE = /<!doctype\b[^>]*>?/iy;
  const prolog = () => { while (skip(SPACE) || skip(COMMENT) || skip(BOGUS)); };
  prolog();
  if (skip(DOCTYPE)) prolog();
  if (skip(/<html(?=[\s/>])[^>]*>/iy)) {
    prolog();
    skip(/<head(?=[\s/>])[^>]*>/iy);
  }
  return i;
}

// The bytes the preview route sends: the file with the storage shim spliced in.
// Only for /html-preview — Raw view, /file and download keep the original
// bytes. The size refusal is decided on the ORIGINAL buffer before this runs.
function withStorageShim(buf) {
  const at = storageShimOffset(buf);
  return Buffer.concat([buf.subarray(0, at), SHIM_TAG, buf.subarray(at)]);
}

module.exports = {
  HTML_PREVIEW_MAX_BYTES,
  HTML_PREVIEW_SANDBOX,
  HTML_PREVIEW_STORAGE_SHIM,
  isHtmlPreviewPath,
  wantsExternalResources,
  htmlPreviewCsp,
  htmlPreviewHeaders,
  htmlPreviewRefusal,
  storageShimOffset,
  withStorageShim,
};
