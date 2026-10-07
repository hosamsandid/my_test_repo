'use strict';

// #2778 — the sandboxed HTML preview's security headers (S1–S4). The policy is
// pure (html-preview.js); the route wiring in api.js is pinned by source guards
// because api.js binds a port on require (#651).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  HTML_PREVIEW_MAX_BYTES,
  HTML_PREVIEW_SANDBOX,
  isHtmlPreviewPath,
  wantsExternalResources,
  htmlPreviewCsp,
  htmlPreviewHeaders,
  htmlPreviewRefusal,
  HTML_PREVIEW_STORAGE_SHIM,
  storageShimOffset,
  withStorageShim,
} = require('./html-preview');
const vm = require('node:vm');

// "a b; c d" → Map { a => ['b'], c => ['d'] }
function directives(csp) {
  const m = new Map();
  for (const part of csp.split(';')) {
    const [name, ...values] = part.trim().split(/\s+/);
    if (name) m.set(name, values);
  }
  return m;
}

const SANDBOX_FORBIDDEN = [
  'allow-same-origin', 'allow-forms', 'allow-popups', 'allow-popups-to-escape-sandbox',
  'allow-top-navigation', 'allow-top-navigation-by-user-activation',
  'allow-top-navigation-to-custom-protocols', 'allow-downloads', 'allow-modals',
  'allow-pointer-lock', 'allow-presentation', 'allow-storage-access-by-user-activation',
];

test('isHtmlPreviewPath: .html/.htm in any case, nothing else', () => {
  for (const p of ['a.html', 'docs/x.htm', 'A.HTML', 'b.HtM', '/context/r/report.html']) {
    assert.equal(isHtmlPreviewPath(p), true, p);
  }
  for (const p of ['a.md', 'a.svg', 'a.html.txt', 'html', 'a.xhtml', '', null, undefined]) {
    assert.equal(isHtmlPreviewPath(p), false, String(p));
  }
});

test('wantsExternalResources: only ?external=1 turns the network on', () => {
  assert.equal(wantsExternalResources({ external: '1' }), true);
  for (const q of [{}, { external: '0' }, { external: 'true' }, { external: ['1', '1'] }, null, undefined]) {
    assert.equal(wantsExternalResources(q), false, JSON.stringify(q));
  }
});

for (const external of [false, true]) {
  const mode = external ? 'external on' : 'external off';

  test(`S1/S2 (${mode}): CSP sandbox grants scripts only — never allow-same-origin`, () => {
    const d = directives(htmlPreviewCsp({ external }));
    assert.deepEqual(d.get('sandbox'), ['allow-scripts']);
    for (const flag of SANDBOX_FORBIDDEN) {
      assert.ok(!htmlPreviewCsp({ external }).includes(flag), `${flag} must never be granted`);
    }
  });

  test(`S2 (${mode}): no plugins, form posts, <base> or foreign framing`, () => {
    const d = directives(htmlPreviewCsp({ external }));
    assert.deepEqual(d.get('object-src'), ["'none'"]);
    assert.deepEqual(d.get('form-action'), ["'none'"]);
    assert.deepEqual(d.get('base-uri'), ["'none'"]);
    assert.deepEqual(d.get('frame-ancestors'), ["'self'"]);
  });

  test(`S4 (${mode}): headers carry the CSP and refuse sniffing / caching / referrers`, () => {
    const h = htmlPreviewHeaders({ external, size: 42 });
    assert.equal(h['Content-Security-Policy'], htmlPreviewCsp({ external }));
    assert.equal(h['Content-Type'], 'text/html; charset=utf-8');
    assert.equal(h['X-Content-Type-Options'], 'nosniff');
    assert.equal(h['Cache-Control'], 'no-store');
    assert.equal(h['Referrer-Policy'], 'no-referrer');
    assert.equal(h['Content-Length'], 42);
  });
}

test('S3 (external off): nothing but inline and data:/blob: — no host, no self, no wildcard', () => {
  const csp = htmlPreviewCsp({ external: false });
  const d = directives(csp);
  assert.deepEqual(d.get('default-src'), ["'none'"]);
  // connect-src (fetch/XHR/WebSocket/beacon) and frame-src must fall back to 'none'.
  assert.equal(d.has('connect-src'), false);
  assert.equal(d.has('frame-src'), false);
  assert.equal(d.has('child-src'), false);
  for (const [name, values] of d) {
    if (name === 'sandbox' || name === 'frame-ancestors') continue;
    for (const v of values) {
      assert.ok(
        ["'none'", "'unsafe-inline'", "'unsafe-eval'", 'data:', 'blob:'].includes(v),
        `${name} ${v} would open the network`,
      );
    }
  }
  // Inline styles/scripts and data: images still work (AC8).
  assert.ok(d.get('script-src').includes("'unsafe-inline'"));
  assert.ok(d.get('style-src').includes("'unsafe-inline'"));
  assert.ok(d.get('img-src').includes('data:'));
});

test('S3 (external on): any host may be loaded', () => {
  const d = directives(htmlPreviewCsp({ external: true }));
  assert.ok(d.get('default-src').includes('*'));
});

test('HTML_PREVIEW_MAX_BYTES is above the 512 KB /file cap (real agent HTML is ~780 KB) and bounded', () => {
  assert.ok(HTML_PREVIEW_MAX_BYTES >= 780 * 1024);
  assert.equal(HTML_PREVIEW_MAX_BYTES, 5 * 1024 * 1024);
  assert.equal(HTML_PREVIEW_SANDBOX, 'allow-scripts');
});

test('htmlPreviewRefusal: non-HTML, oversize and binary files are refused', () => {
  assert.equal(htmlPreviewRefusal({ relPath: 'a.html', size: 780 * 1024, head: Buffer.from('<p>') }), null);
  assert.equal(htmlPreviewRefusal({ relPath: 'a.html', size: 0, head: Buffer.alloc(0) }), null);
  assert.equal(htmlPreviewRefusal({ relPath: 'a.svg', size: 10, head: Buffer.from('<svg>') }).code, 'not-html');
  assert.equal(htmlPreviewRefusal({ relPath: 'a.html', size: HTML_PREVIEW_MAX_BYTES + 1, head: Buffer.alloc(0) }).status, 413);
  assert.equal(htmlPreviewRefusal({ relPath: 'a.html', size: Infinity, head: Buffer.from('x') }).code, 'too-large');
  assert.equal(htmlPreviewRefusal({ relPath: 'a.htm', size: 3, head: Buffer.from([0x3c, 0, 0x3e]) }).code, 'binary');
});

/* ─── api.js wiring (source guards, #651) ─────────────────────────────── */

const API_SRC = fs.readFileSync(path.join(__dirname, 'api.js'), 'utf8');

function routeBody(routePath) {
  const start = API_SRC.indexOf(`app.get('${routePath}'`);
  assert.ok(start >= 0, `${routePath} must be registered`);
  const end = API_SRC.indexOf('\napp.', start + 1);
  return API_SRC.slice(start, end).replace(/^\s*\/\/.*$/gm, '').replace(/\s+/g, ' ');
}

for (const route of [
  '/api/agents/:agentId/workspace/html-preview',
  '/api/agents/:agentId/context/html-preview',
]) {
  test(`${route}: refuses before it serves, and serves only with the preview headers`, () => {
    const body = routeBody(route);
    assert.ok(body.includes('apiLimiter'), 'rate-limited like the other workspace reads');
    const refusal = body.indexOf('htmlPreviewRefusal(');
    const shim = body.indexOf('const page = withStorageShim(buf);');
    const headers = body.indexOf('res.set(htmlPreviewHeaders({ external: wantsExternalResources(req.query), size: page.length }));');
    const send = body.indexOf('res.end(page)');
    assert.ok(refusal > 0 && shim > refusal && headers > shim && send > headers,
      'refusal (on the original bytes) → shim → headers (Content-Length of what is sent) → body, in that order');
    assert.equal(body.split('res.end(').length - 1, 1, 'exactly one place sends the file bytes');
    assert.ok(!/res\.(send|sendFile|setHeader\('Content-Type')/.test(body), 'no other way to send HTML');
  });
}

test('workspace html-preview reads through safeAgentPath and never past the preview cap', () => {
  const body = routeBody('/api/agents/:agentId/workspace/html-preview');
  assert.ok(body.includes('const target = safeAgentPath(agentId, relPath);'));
  assert.ok(body.includes('st.size <= HTML_PREVIEW_MAX_BYTES ? fs.readFileSync(target)'));
});

test('context html-preview refuses a truncated orchestrator read', () => {
  const body = routeBody('/api/agents/:agentId/context/html-preview');
  assert.ok(body.includes('body.truncated ? Infinity'));
});

/* ─── #2786: in-memory browser storage for the opaque-origin preview ──── */

const SHIM_TAG = `<script>${HTML_PREVIEW_STORAGE_SHIM}</script>`;
const shimmed = (html) => withStorageShim(Buffer.from(html, 'utf8')).toString('utf8');

test('withStorageShim: the shim goes before the first script, after the prolog (AC6)', () => {
  const cases = [
    // [file, expected prefix before the shim]
    ['<title>x</title><script>localStorage.getItem("a")</script>', ''],
    ['<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><script>1</script>', '<!DOCTYPE html><html lang="en"><head>'],
    ['<!doctype html>\n<!-- note -->\n<html>\n  <head>\n<script>1</script>', '<!doctype html>\n<!-- note -->\n<html>\n  <head>'],
    ['<!DOCTYPE html><body><script>1</script>', '<!DOCTYPE html>'],
    ['  <!-- c --><!DOCTYPE html><script>1</script>', '  <!-- c --><!DOCTYPE html>'],
    ['<?xml version="1.0"?><!DOCTYPE html><html><script>1</script>', '<?xml version="1.0"?><!DOCTYPE html><html>'],
    ['<html><HEAD class="h"><script>1</script>', '<html><HEAD class="h">'],
    ['<htmlx><script>1</script>', ''],
    ['<header>x</header>', ''],
    ['just text, no tags', ''],
    ['', ''],
  ];
  for (const [file, prefix] of cases) {
    const out = shimmed(file);
    assert.equal(out, prefix + SHIM_TAG + file.slice(prefix.length), JSON.stringify(file));
  }
});

test('withStorageShim: a UTF-8 BOM stays first and the doctype still leads the markup (edge case)', () => {
  const bom = Buffer.from([0xef, 0xbb, 0xbf]);
  const file = Buffer.concat([bom, Buffer.from('<!DOCTYPE html><p>Grüße – ✓</p>', 'utf8')]);
  const out = withStorageShim(file);
  assert.deepEqual(out.subarray(0, 3), bom);
  const text = out.subarray(3).toString('utf8');
  assert.ok(text.startsWith('<!DOCTYPE html>' + SHIM_TAG), 'doctype stays first, so no quirks mode');
  assert.ok(text.endsWith('<p>Grüße – ✓</p>'), 'multi-byte UTF-8 survives byte-exact');
  assert.equal(storageShimOffset(file), 3 + '<!DOCTYPE html>'.length);
});

test('withStorageShim: only adds the shim — the original bytes survive unchanged around it (AC8/AC9)', () => {
  const file = Buffer.from('<!DOCTYPE html><html><head></head><body>ä</body></html>', 'utf8');
  const out = withStorageShim(file);
  assert.equal(out.length, file.length + Buffer.byteLength(SHIM_TAG));
  const at = storageShimOffset(file);
  assert.deepEqual(Buffer.concat([out.subarray(0, at), out.subarray(at + Buffer.byteLength(SHIM_TAG))]), file);
  // The size refusal is decided on the original size: a file just under the cap
  // is not pushed over it by the shim.
  assert.equal(htmlPreviewRefusal({ relPath: 'a.html', size: HTML_PREVIEW_MAX_BYTES, head: file }), null);
});

test('the shim cannot terminate its own <script> early', () => {
  assert.ok(!/<\/script/i.test(HTML_PREVIEW_STORAGE_SHIM));
  assert.ok(!HTML_PREVIEW_STORAGE_SHIM.includes('<!--'));
});

// Run the shim against a fake opaque-origin window: every storage getter
// throws the SecurityError a sandboxed document without allow-same-origin gets.
function opaqueOriginWindow() {
  const securityError = (what) => () => { throw new DOMException(`Failed to read '${what}'`, 'SecurityError'); };
  let removed = false;
  const document = { currentScript: { remove() { removed = true; } } };
  Object.defineProperty(document, 'cookie', { get: securityError('cookie'), set: securityError('cookie'), configurable: true });
  const window = {};
  for (const name of ['localStorage', 'sessionStorage', 'indexedDB']) {
    Object.defineProperty(window, name, { get: securityError(name), configurable: true });
  }
  const timers = [];
  const ctx = vm.createContext({
    window, document, EventTarget, Event, DOMException,
    setTimeout: (fn) => { timers.push(fn); },
  });
  vm.runInContext(HTML_PREVIEW_STORAGE_SHIM, ctx);
  const flush = () => { while (timers.length) timers.shift()(); };
  return { window, document, flush, removed: () => removed };
}

test('baseline: the fake window throws like an opaque origin does', () => {
  const window = {};
  Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('x', 'SecurityError'); } });
  assert.throws(() => window.localStorage.getItem('ag-theme'), /x/);
});

test('shim: the reproduction script runs — localStorage read on the first line (AC1)', () => {
  const { window, removed } = opaqueOriginWindow();
  const theme = window.localStorage.getItem('ag-theme') || 'auto';
  assert.equal(theme, 'auto');
  assert.equal(removed(), true, 'the shim removes its own <script> element');
});

for (const name of ['localStorage', 'sessionStorage']) {
  test(`shim: ${name} has Web Storage semantics (AC2)`, () => {
    const { window } = opaqueOriginWindow();
    const s = window[name];
    assert.equal(s.getItem('missing'), null);
    assert.equal(s.length, 0);
    s.setItem('ag-theme', 'dark');
    s.setItem('n', 5);
    s.setItem('o', { a: 1 });
    assert.equal(s.getItem('ag-theme'), 'dark', 'a value set can be read back in the same opening');
    assert.equal(s.getItem('n'), '5', 'values are stored as strings');
    assert.equal(s.getItem('o'), '[object Object]');
    assert.equal(s.length, 3);
    assert.equal(s.key(0), 'ag-theme');
    assert.equal(s.key(2), 'o');
    assert.equal(s.key(3), null);
    assert.equal(s.key(-1), null);
    s.setItem('ag-theme', 'light');
    assert.equal(s.length, 3, 'overwrite does not add a key');
    s.removeItem('n');
    assert.equal(s.getItem('n'), null);
    assert.equal(s.length, 2);
    s.clear();
    assert.equal(s.length, 0);
    assert.equal(s.getItem('ag-theme'), null);
    // Named-property access, as many pages use.
    s.theme = 1;
    assert.equal(s.getItem('theme'), '1');
    assert.equal(s.theme, '1');
    assert.deepEqual(Object.keys(s), ['theme']);
    assert.ok('theme' in s);
    delete s.theme;
    assert.equal(s.getItem('theme'), null);
    // Keys that collide with method names stay data, not methods.
    s.setItem('getItem', 'x');
    assert.equal(s.getItem('getItem'), 'x');
    assert.equal(typeof s.getItem, 'function');
  });
}

test('shim: localStorage and sessionStorage are separate stores', () => {
  const { window } = opaqueOriginWindow();
  window.localStorage.setItem('k', 'local');
  assert.equal(window.sessionStorage.getItem('k'), null);
});

test('shim: every opening starts empty — nothing persists (AC3)', () => {
  const first = opaqueOriginWindow();
  first.window.localStorage.setItem('ag-theme', 'dark');
  first.document.cookie = 'a=1';
  const second = opaqueOriginWindow();
  assert.equal(second.window.localStorage.getItem('ag-theme'), null);
  assert.equal(second.window.localStorage.length, 0);
  assert.equal(second.document.cookie, '');
});

test('shim: document.cookie reads and writes without throwing, in memory only (AC4)', () => {
  const { document } = opaqueOriginWindow();
  assert.equal(document.cookie, '');
  document.cookie = 'theme=dark; path=/; SameSite=Lax';
  document.cookie = 'lang=de';
  assert.equal(document.cookie, 'theme=dark; lang=de');
  document.cookie = 'theme=light';
  assert.equal(document.cookie, 'theme=light; lang=de');
  document.cookie = 'theme=; max-age=0';
  assert.equal(document.cookie, 'lang=de');
  document.cookie = 'lang=; expires=Thu, 01 Jan 1970 00:00:00 GMT';
  assert.equal(document.cookie, '');
});

test('shim: indexedDB feature tests keep running — open() fails asynchronously (AC5)', () => {
  const { window, flush } = opaqueOriginWindow();
  assert.ok(window.indexedDB, 'if (window.indexedDB) is truthy');
  const req = window.indexedDB.open('db', 1);
  let onerror = 0; let listener = 0; let success = 0;
  req.onerror = () => { onerror++; };
  req.onsuccess = () => { success++; };
  req.addEventListener('error', () => { listener++; });
  assert.equal(onerror, 0, 'nothing fires synchronously');
  flush();
  assert.equal(onerror, 1);
  assert.equal(listener, 1);
  assert.equal(success, 0);
  assert.equal(req.error.name, 'InvalidStateError');
  assert.equal(req.readyState, 'done');
  const del = window.indexedDB.deleteDatabase('db');
  flush();
  assert.equal(del.readyState, 'done');
});

test('shim: a page that already guards storage with try/catch behaves the same or better (edge case)', () => {
  const { window } = opaqueOriginWindow();
  let value;
  try { value = window.localStorage.getItem('x'); } catch { value = 'fallback'; }
  assert.equal(value, null);
});

test('S1 stays pinned with the shim: it adds no sandbox capability and needs none (AC7)', () => {
  for (const external of [false, true]) {
    const d = directives(htmlPreviewCsp({ external }));
    assert.deepEqual(d.get('sandbox'), ['allow-scripts']);
    // The shim is inline script, which both modes already allow.
    assert.ok((d.get('script-src') || d.get('default-src')).includes("'unsafe-inline'"));
  }
  assert.ok(!HTML_PREVIEW_STORAGE_SHIM.includes('allow-same-origin'));
  assert.ok(!/\b(fetch|XMLHttpRequest|sendBeacon|WebSocket|parent|top|opener)\b/.test(HTML_PREVIEW_STORAGE_SHIM),
    'the shim talks to nobody outside the document');
});

test('Raw view, /file and download keep the original bytes — only /html-preview splices the shim (AC8)', () => {
  const uses = API_SRC.split('withStorageShim(').length - 1;
  assert.equal(uses, 2, 'exactly the two /html-preview routes');
  for (const route of [
    '/api/agents/:agentId/workspace/file',
    '/api/agents/:agentId/workspace/download',
    '/api/agents/:agentId/context/file',
    '/api/agents/:agentId/context/download',
  ]) {
    assert.ok(!routeBody(route).includes('withStorageShim'), `${route} must not add the shim`);
  }
});
