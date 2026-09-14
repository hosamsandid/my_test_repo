import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// ─── #2294 "remove the Workspace dropdown" wiring guard ──────────────────────
//
// `ScalingSection.jsx` is uncovered by a renderer (#651: no DOM test renderer
// in this repo), so the two facts this ticket depends on can only be checked
// by reading the source:
//
//   • AC1 — the "Workspace" field/select must be gone from BOTH hosts
//     (NodeInspector's Details tab and AgentEditForm's Settings tab), which
//     embed this ONE shared component — removing it here removes it from both.
//   • AC3 — the save payload must never carry a `workspace` value other than
//     `git-clean-base` (or omit the field). `buildPoolPayload` (scaling-view.js,
//     pure, unit-tested) already defaults an omitted `workspace` to
//     `git-clean-base`, so the save call site must not thread a variable
//     `workspace` value into it — that is the only way a stale/rehydrated
//     `pool.workspace` (`input-copy`/`none`) could sneak back into a save.
//
// Source-text guard, not a render test.

const here = dirname(fileURLToPath(import.meta.url));

function sourceOf(rel) {
  return readFileSync(join(here, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

test('ScalingSection.jsx: no Workspace select, no POOL_WORKSPACE_OPTIONS/workspaceValue wiring', () => {
  const src = sourceOf('./ScalingSection.jsx');
  assert.equal(/<select/.test(src), false, 'a <select> reappeared — the removed Workspace dropdown, or a new one');
  assert.equal(/POOL_WORKSPACE_OPTIONS/.test(src), false);
  assert.equal(/workspaceValue/.test(src), false);
  assert.equal(/\bsetWorkspace\b/.test(src), false);
});

test('ScalingSection.jsx: the save() -> buildPoolPayload call never threads a workspace value', () => {
  const src = sourceOf('./ScalingSection.jsx');
  const call = src.match(/buildPoolPayload\(\{[\s\S]*?\}\)/);
  assert.ok(call, 'expected exactly one buildPoolPayload({...}) call site');
  assert.equal(/workspace/.test(call[0]), false,
    'buildPoolPayload is called with a workspace key — it must rely on the pure default (git-clean-base) instead');
});
