// ─── Agent-toolchain JSX wiring guard (#1940) ────────────────────────────────
//
// toolchain-select-view.test.js proves the DECISIONS; nothing proves they are
// still wired, because `node --test` cannot load JSX (#651). A dropped call, a
// renamed form key or a lost `toolchainId` in the submit payload would leave
// every pure test green while the field silently stopped working — and one of
// these assertions is a security property rather than a feature one: this form
// must never send an image reference, only an id.
//
// Sources are read comment-stripped, because the comments in
// EnvironmentTemplates.jsx explain the very identifiers being matched.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function stripComments(src) {
  return String(src)
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
}

const SRC = stripComments(fs.readFileSync(path.join(HERE, 'EnvironmentTemplates.jsx'), 'utf8'));

// Prove the matcher is not vacuous (the #1891 lesson): the same assertions must
// FAIL against a source that lacks the wiring.
const BARE = stripComments(`
  import React from 'react';
  function EnvironmentForm() { return null; }
  export default function EnvironmentTemplates() { return null; }
`);

test('the pure view helpers are imported and every one is called', () => {
  assert.match(SRC, /from '\.\/toolchain-select-view\.js'/);
  for (const fn of ['toolchainOptions', 'toolchainEmptyState', 'toolchainChangeWarning']) {
    assert.match(SRC, new RegExp(`${fn}\\(`), `${fn} is imported but never called`);
    assert.doesNotMatch(BARE, new RegExp(`${fn}\\(`));
  }
});

test('the form reads the registry and keeps toolchainId in its own state', () => {
  assert.match(SRC, /useApi\('\/api\/toolchains'\)/);
  assert.match(SRC, /toolchainId:\s*initial\?\.toolchainId/, 'the edit form must seed from the environment');
  assert.match(SRC, /update\('toolchainId'/, 'the select must write back to form state');
});

test('the submit payload sends toolchainId and never an image reference (AC6)', () => {
  const submit = SRC.slice(SRC.indexOf('const submit = () => {'));
  const body = submit.slice(0, submit.indexOf('};'));
  assert.match(body, /toolchainId:\s*form\.toolchainId/);
  // The whole point of the id indirection: a Team Admin cannot introduce an
  // image reference, so this form has no business carrying one.
  assert.doesNotMatch(body, /\bimage\b/, 'the environment form must not send an image reference');
});

test('the change warning is rendered, not merely computed', () => {
  assert.match(SRC, /\{toolchainWarning &&/, 'the AC5 interrupt warning must reach the DOM');
  assert.match(SRC, /toolchainChangeWarning\(\{[\s\S]*?agentCount:/, 'the warning needs the agent count to be honest about the interruption');
});

test('the registry panel is System-Admin-gated in the UI and posts ids to the registry routes', () => {
  assert.match(SRC, /toolchainData\?\.canManage &&/, 'the Toolchains button must be gated on the payload flag');
  assert.match(SRC, /'POST',\s*'\/api\/toolchains'/);
  assert.match(SRC, /'DELETE',\s*`\/api\/toolchains\//);
});
