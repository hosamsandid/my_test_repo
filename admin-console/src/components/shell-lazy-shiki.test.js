import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Bundle-weight regression guard (#2918). Shiki (~40 grammars + the Oniguruma
 * WASM, ~2.9 MB) and the full markdown pipeline used to sit in the shell chunk,
 * so every page — About, Flows, Settings … — downloaded them. They must only be
 * reachable through a dynamic import():
 *   - the app entry's STATIC import graph (index.jsx → App → Shell → …) never
 *     imports `shiki`, nor shiki-rehype.js / Message.jsx / HelperChatPanel.jsx;
 *   - shiki-rehype.js itself loads `shiki` only via import('shiki');
 *   - the 350 KB help corpus is fetched on the panel's first open, not at boot.
 *
 * There is no JSX test renderer (#651), so this reads the real sources and
 * follows relative static imports the way the bundler does.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..');

function stripComments(src) {
  return String(src)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
}

// Static import / re-export specifiers of a module (dynamic import() excluded).
function staticSpecifiers(src) {
  const s = stripComments(src);
  const out = [];
  const re = /(?:^|[;\n])\s*(?:import|export)\s+(?:[^;'"]*?\s+from\s+)?['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(s))) out.push(m[1]);
  return out;
}

function resolveRelative(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const cand of [base, `${base}.js`, `${base}.jsx`, path.join(base, 'index.js'), path.join(base, 'index.jsx')]) {
    if (fs.existsSync(cand) && fs.statSync(cand).isFile()) return cand;
  }
  return null;
}

// Every source file and bare package reachable from `entry` by static imports.
function staticGraph(entry) {
  const files = new Set();
  const packages = new Set();
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop();
    if (files.has(file)) continue;
    files.add(file);
    if (!/\.(js|jsx)$/.test(file)) continue;
    for (const spec of staticSpecifiers(fs.readFileSync(file, 'utf8'))) {
      if (spec.startsWith('.')) {
        const resolved = resolveRelative(file, spec);
        if (resolved) queue.push(resolved);
      } else {
        packages.add(spec);
      }
    }
  }
  return { files, packages };
}

const isShiki = (spec) => spec === 'shiki' || spec.startsWith('shiki/') || spec.startsWith('@shikijs/');
const rel = (f) => path.relative(SRC, f).split(path.sep).join('/');

test('matcher: picks up static imports/re-exports and skips dynamic import()', () => {
  const specs = staticSpecifiers(`
    import React, { lazy } from 'react';
    import './side-effect.css';
    import {
      a,
      b,
    } from './multi-line';
    export { c } from './re-export.js';
    // import x from './commented-out';
    const Lazy = lazy(() => import('./Lazy'));
    const shiki = await import('shiki');
  `);
  assert.deepEqual(specs, ['react', './side-effect.css', './multi-line', './re-export.js']);
});

test('#2918 — the entry graph is walked (sanity: it reaches Shell.jsx)', () => {
  const { files } = staticGraph(path.join(SRC, 'index.jsx'));
  assert.ok(files.has(path.join(SRC, 'components', 'Shell.jsx')), 'Shell.jsx not reached from index.jsx');
  assert.ok(files.size > 20, `suspiciously small static graph (${files.size} files)`);
});

test('#2918 AC1/AC5 — no module in the entry\'s static import graph imports shiki', () => {
  const { files, packages } = staticGraph(path.join(SRC, 'index.jsx'));
  assert.deepEqual([...packages].filter(isShiki), []);
  const heavy = ['components/shiki-rehype.js', 'pages/agent-chat/Message.jsx', 'components/HelperChatPanel.jsx'];
  const reached = [...files].map(rel).filter((f) => heavy.includes(f));
  assert.deepEqual(reached, [], 'these must only be reachable through a dynamic import()');
});

test('#2918 — Shell loads the Help panel lazily', () => {
  const shell = stripComments(fs.readFileSync(path.join(HERE, 'Shell.jsx'), 'utf8'));
  assert.match(shell, /const\s+HelperChatPanel\s*=\s*lazy\(\s*\(\)\s*=>\s*import\(\s*['"]\.\/HelperChatPanel['"]\s*\)\s*\)/);
  assert.match(shell, /<Suspense[^>]*>\s*<HelperChatPanel\s*\/>\s*<\/Suspense>/);
});

test('#2918 AC1 — shiki-rehype loads shiki only through a dynamic import()', () => {
  const src = fs.readFileSync(path.join(HERE, 'shiki-rehype.js'), 'utf8');
  assert.deepEqual(staticSpecifiers(src).filter(isShiki), []);
  assert.match(stripComments(src), /import\(\s*['"]shiki['"]\s*\)/);
  assert.doesNotMatch(stripComments(src), /PRELOAD_LANGS/, 'no eager grammar preload list');
});

test('#2918 AC4 — /api/helper/page-help is fetched only once the panel is open', () => {
  const ctx = stripComments(fs.readFileSync(path.join(SRC, 'context', 'HelperChatContext.jsx'), 'utf8'));
  const at = ctx.indexOf("'/api/helper/page-help'");
  assert.ok(at > 0, 'page-help fetch not found');
  const start = ctx.lastIndexOf('useEffect(', at);
  const end = ctx.indexOf(']', ctx.indexOf('}, [', at));
  const effect = ctx.slice(start, end + 1);
  const bail = effect.search(/if\s*\(\s*!isOpen\b/);
  assert.ok(bail >= 0 && bail < effect.indexOf("'/api/helper/page-help'"), 'effect must bail out while the panel is closed');
  assert.match(effect.slice(effect.lastIndexOf('}, [')), /\bisOpen\b/, 'effect must re-run when the panel opens');
});
