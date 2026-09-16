// Run: node --test admin-console/src/pages/team-setup-template-wiring.test.js
//
// Source-reading drift guard (#651) for "start from a template" at team
// creation (#2170, epic #2166 A4, AC: "creating a team can start from a
// template and copies its structure"). The pure backend mechanism
// (POST /api/environments {copyFromTemplateId}, credential stripping) is
// covered by environment-template.test.js and tiered-resource-routes.test.js;
// this guards the one piece that is JSX and therefore untestable there — that
// TeamSetup.jsx actually wires a template pick to that mechanism, and never to
// a direct live binding (which the server refuses outright).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

function stripComments(src) {
  return src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const SRC = stripComments(readFileSync(join(here, 'TeamSetup.jsx'), 'utf8'));

test('the wizard reads the template catalog, not the ordinary environment list', () => {
  assert.match(SRC, /useApi\('\/api\/environments\?isTemplate=true'\)/, 'must fetch the isTemplate=true view');
});

test('picking a template mints a new environment via copyFromTemplateId — never a direct bind', () => {
  const fn = SRC.slice(SRC.indexOf('async function selectTemplate('));
  const body = fn.slice(0, fn.indexOf('\n  }') + 4);
  assert.match(body, /apiCall\('POST', '\/api\/environments', \{/, 'must POST to create a new environment');
  assert.match(body, /copyFromTemplateId:\s*template\.id/, 'must pass copyFromTemplateId, the server-side copy mechanism');
  assert.doesNotMatch(body, /environmentId:\s*template\.id/, 'must never bind the team directly to the template id');
});

test('a minted environment is then treated exactly like an ordinary reused one', () => {
  const fn = SRC.slice(SRC.indexOf('async function selectTemplate('));
  const body = fn.slice(0, fn.indexOf('\n  }') + 4);
  assert.match(body, /selectEnvironment\(minted\)/, 'must hand the minted record to the same selection path as picking an existing environment');
});

test('the template picker is wired into the environment-select step', () => {
  assert.match(SRC, /envTemplates=\{envTemplates\}/);
  assert.match(SRC, /onSelectTemplate=\{selectTemplate\}/);
  const step = SRC.slice(SRC.indexOf('function StepEnvironmentSelect('));
  assert.match(step, /onSelectTemplate\?\.\(t\)/, 'the template card click must reach the mint handler');
});
