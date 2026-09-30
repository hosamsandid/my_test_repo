import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { NOT_FOUND_LABEL, breadcrumbFor } from './breadcrumbs.js';

test('static routes resolve to their label', () => {
  assert.equal(breadcrumbFor('/chats'), 'Agent Chat');
  assert.equal(breadcrumbFor('/ssh-keys'), 'SSH Keys');
  assert.equal(breadcrumbFor('/users'), 'Administration');
});

test('dynamic routes keep their existing labels', () => {
  assert.equal(breadcrumbFor('/chats/release-manager'), 'Agent Chat');
  assert.equal(breadcrumbFor('/plugins/netzplan/view'), 'Plugins / netzplan');
});

test('unknown paths read "Page not found", never the raw pathname (#2615)', () => {
  for (const p of ['/does-not-exist-xyz', '/chat', '/chats/a/b', '/plugins/x', '/plugins/x/view/extra']) {
    assert.equal(breadcrumbFor(p), NOT_FOUND_LABEL, p);
  }
  assert.equal(NOT_FOUND_LABEL, 'Page not found');
});

test('the root path is labelled for its redirect destination', () => {
  assert.equal(breadcrumbFor('/'), 'Agent Chat');
});

test('trailing slash and case match the way React Router matches', () => {
  assert.equal(breadcrumbFor('/ssh-keys/'), 'SSH Keys');
  assert.equal(breadcrumbFor('/SSH-Keys'), 'SSH Keys');
  assert.equal(breadcrumbFor('/chats/'), 'Agent Chat');
  assert.equal(breadcrumbFor('/Plugins/NetzPlan/view/'), 'Plugins / NetzPlan');
});

// Drift guard over App.jsx (#651 convention: the JSX can't be loaded, so read
// it). Every route that renders a page must resolve to a real label — otherwise
// adding a page without a BREADCRUMBS entry would show it under "Page not found".
// Redirect-only routes (<Navigate> or a *Redirect component) are skipped.
test('every App.jsx page route has a label', () => {
  const app = readFileSync(fileURLToPath(new URL('../App.jsx', import.meta.url)), 'utf8');
  const routes = [...app.matchAll(/<Route\s+path="([^"]+)"\s+element=\{<(\w+)/g)]
    .map(m => ({ path: m[1], el: m[2] }));
  assert.ok(routes.length > 20, 'expected to find the route table');
  for (const { path: p, el } of routes) {
    if (p === '*' || el === 'Navigate' || /Redirect$/.test(el)) continue;
    const sample = p.replace(/:[^/]+/g, 'sample-id');
    assert.notEqual(breadcrumbFor(sample), NOT_FOUND_LABEL, `route ${p} has no breadcrumb label`);
  }
});

test('App.jsx ends its route table with the NotFound catch-all', () => {
  const app = readFileSync(fileURLToPath(new URL('../App.jsx', import.meta.url)), 'utf8')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
  assert.match(app, /const NotFound\s*=\s*lazy\(\(\) => import\('\.\/pages\/NotFound'\)\)/);
  assert.match(app, /<Route path="\*" element=\{<NotFound \/>\} \/>\s*<\/Routes>/);
});
