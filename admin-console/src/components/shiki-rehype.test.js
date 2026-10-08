import { test } from 'node:test';
import assert from 'node:assert/strict';

import { rehypeShikiSync, subscribeShiki, shikiVersion } from './shiki-rehype.js';

/**
 * Lazy Shiki loading (#2918): the highlighter is created on the first tree that
 * holds a code block, each block's grammar is loaded on demand, and every
 * "something new is ready" step bumps the store version so a mounted renderer
 * re-renders and upgrades its plain blocks (AC3: the first block may render
 * plain and upgrade). Runs against the real `shiki` package.
 */

// A minimal hast tree as remark-rehype emits for ```<lang>\n<code>\n```.
function codeTree(lang, code) {
  const codeEl = {
    type: 'element', tagName: 'code',
    properties: lang ? { className: [`language-${lang}`] } : {},
    children: [{ type: 'text', value: code }],
  };
  return {
    type: 'root',
    children: [{ type: 'element', tagName: 'pre', properties: {}, children: [codeEl] }],
  };
}

const paragraphTree = () => ({
  type: 'root',
  children: [{ type: 'element', tagName: 'p', properties: {}, children: [{ type: 'text', value: 'hi' }] }],
});

const run = (tree) => { rehypeShikiSync()(tree); return tree; };
const isHighlighted = (tree) => tree.children[0].properties['data-theme'] === 'github-light github-dark';

// Resolves on the next store bump (or rejects after `ms`).
function nextBump(ms = 20000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { unsub(); reject(new Error('no shiki store bump')); }, ms);
    const unsub = subscribeShiki(() => { clearTimeout(timer); unsub(); resolve(shikiVersion()); });
  });
}

test('#2918 — lazy highlighter: no load without a code block, plain first, then upgrade per grammar', async () => {
  // A tree without any code block does not start the load.
  const v0 = shikiVersion();
  run(paragraphTree());
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(shikiVersion(), v0, 'a code-free tree must not load shiki');

  // The first code block renders plain and starts the load.
  const ready = nextBump();
  assert.equal(isHighlighted(run(codeTree('js', 'const a = 1;'))), false);
  assert.ok((await ready) > v0);

  // Highlighter ready: plaintext highlights at once; js is still loading → plain.
  assert.equal(isHighlighted(run(codeTree('text', 'hello'))), true);
  assert.equal(isHighlighted(run(codeTree(null, 'no lang'))), true);
  const grammar = nextBump();
  const first = run(codeTree('js', 'const a = 1;'));
  assert.equal(isHighlighted(first), true, 'falls back to a plaintext-styled block');
  await grammar;

  // The js grammar is loaded on demand — the re-render tokenises it.
  const upgraded = run(codeTree('js', 'const a = 1;'));
  assert.equal(isHighlighted(upgraded), true);
  const spans = JSON.stringify(upgraded);
  assert.match(spans, /--shiki-dark/);
  assert.ok((spans.match(/"tagName":"span"/g) || []).length > 3, 'js should be tokenised into several spans');
});

test('#2918 — an unbundled language (jcl) stays plaintext without throwing', () => {
  assert.doesNotThrow(() => run(codeTree('jcl', '//JOB1 JOB')));
});
