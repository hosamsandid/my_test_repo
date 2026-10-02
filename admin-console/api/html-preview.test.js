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
} = require('./html-preview');

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
    const headers = body.indexOf('res.set(htmlPreviewHeaders({ external: wantsExternalResources(req.query)');
    const send = body.indexOf('res.end(buf)');
    assert.ok(refusal > 0 && headers > refusal && send > headers, 'refusal → headers → body, in that order');
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
