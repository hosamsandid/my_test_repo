// Guard tests for the three Revideo patch-package fixes (#742 / T2). Dependency-free:
// runs via `node --test scripts/*.test.mjs` on the fast CI lane WITHOUT installing the
// @revideo toolchain. The real "do they apply?" check happens at `npm ci` postinstall
// (patch-package); these tests guard that the committed patches still encode each of the
// three documented fixes and that the postinstall wiring stays in place — so a future
// regenerate/install that silently drops a fix fails here instead of in a render job.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const RENDERER_PATCH = join(root, 'patches', '@revideo+renderer+0.11.0.patch');
const FFMPEG_PATCH = join(root, 'patches', '@revideo+ffmpeg+0.10.4.patch');

test('package.json wires patch-package on postinstall', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.postinstall, 'patch-package');
  assert.ok(pkg.devDependencies['patch-package'], 'patch-package must be a devDependency');
});

test('fix 1: renderer no longer force-pushes --single-process', () => {
  const patch = readFileSync(RENDERER_PATCH, 'utf8');
  assert.match(patch, /render-video\.js/);
  // the forced push is removed …
  assert.match(patch, /^-\s*args\.push\('--single-process'\);/m);
  // … and no line re-adds it.
  assert.doesNotMatch(patch, /^\+\s*args\.push\('--single-process'\);/m);
});

test('fix 2: renderer basenames the outFile so an absolute path cannot corrupt the temp folder', () => {
  const patch = readFileSync(RENDERER_PATCH, 'utf8');
  assert.match(patch, /validate-settings\.js/);
  assert.match(patch, /^\+const path = require\("path"\);/m);
  assert.match(patch, /^\+\s*\? path\.basename\(settings\.outFile\)/m);
});

test('fix 3: ffmpeg resolvePath honours a configurable public dir (REVIDEO_PUBLIC_DIR)', () => {
  const patch = readFileSync(FFMPEG_PATCH, 'utf8');
  assert.match(patch, /utils\.js/);
  assert.match(patch, /^\+\s*const publicDir = process\.env\.REVIDEO_PUBLIC_DIR \|\| path\.join\(output, '\.\.\/public'\);/m);
  // the hardcoded-only join is gone
  assert.match(patch, /^-\s*resolvedPath = path\.join\(output, '\.\.\/public', assetPath\);/m);
});
