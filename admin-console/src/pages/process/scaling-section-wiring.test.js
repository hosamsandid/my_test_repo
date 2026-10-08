import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// ─── #2813 AC15 "Workspace mode + work source" wiring guard ─────────────────
//
// `ScalingSection.jsx` is uncovered by a renderer (#651: no DOM test renderer
// in this repo), so the wiring can only be checked by reading the source.
// #2294 removed the Workspace dropdown because `input-copy`/`none` had no UI
// for the `pool.workSource` they need; #2813 brings both back together:
//
//   • the shared section (embedded by NodeInspector's Details tab AND
//     AgentEditForm's Settings tab) offers the Workspace select from
//     POOL_WORKSPACE_OPTIONS and the work-source fields, shown only off
//     git-clean-base (`workSourceApplies`);
//   • `scalingSaveDecision` threads the chosen workspace, the parsed work
//     source and the carried `baseBranch` into `buildPoolPayload`, so a save
//     round-trips them instead of silently resetting to git-clean-base.
//
// Source-text guard, not a render test.

const here = dirname(fileURLToPath(import.meta.url));

function sourceOf(rel) {
  return readFileSync(join(here, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

test('ScalingSection.jsx: Workspace select + work-source fields, gated off git-clean-base', () => {
  const src = sourceOf('./ScalingSection.jsx');
  assert.match(src, /<select[^>]*value=\{draft\.workspace\}/);
  assert.match(src, /POOL_WORKSPACE_OPTIONS\.map/);
  assert.match(src, /workSourceApplies\(draft\)/);
  for (const f of ['itemsText', 'outputDirText', 'inputDirText']) {
    assert.match(src, new RegExp(`set\\(\\{ ${f}:`), `${f} is not editable`);
  }
});

test('scaling-view.js: scalingSaveDecision threads workspace, workSource and baseBranch', () => {
  const src = sourceOf('./scaling-view.js');
  const fn = src.match(/export function scalingSaveDecision[\s\S]*?\n\}/);
  assert.ok(fn, 'expected a scalingSaveDecision function (the host-owned save call site since #2295)');
  const call = fn[0].match(/buildPoolPayload\(\{[\s\S]*?\}\)/);
  assert.ok(call, 'expected exactly one buildPoolPayload({...}) call site in scalingSaveDecision');
  for (const key of ['workspace', 'workSource', 'baseBranch']) {
    assert.match(call[0], new RegExp(`\\b${key}\\b`), `buildPoolPayload is not given ${key}`);
  }
});
