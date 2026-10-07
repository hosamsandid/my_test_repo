// Run: node --test admin-console/src/pages/team-setup-review-wiring.test.js
//
// Source-reading drift guard (#651) for the #2658 Team-Wizard fixes. The copy and
// derivations are unit-tested in team-setup/{review-fields,go-live-notice,
// leave-guard}.test.js; this guards the JSX wiring those tests cannot see.

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

function fnBody(signature) {
  const start = SRC.indexOf(signature);
  assert.ok(start >= 0, `missing ${signature}`);
  const rest = SRC.slice(start);
  return rest.slice(0, rest.indexOf('\n}\n') + 2);
}

test('Review reads the env detail credentialRefs and the caller\'s personal token into buildReviewFields', () => {
  const body = fnBody('function StepReview(');
  assert.match(body, /useApi\(form\.environmentId \? `\/api\/environments\/\$\{encodeURIComponent\(form\.environmentId\)\}` : null\)/);
  assert.match(body, /\.find\(t => t\.scope === 'personal'\)/);
  assert.match(body, /credentialRefs: envDetail\?\.credentialRefs,/);
  assert.match(body, /\n\s+personalToken,\n/);
});

test('the go-live notice is fed stub mode and GitHub use, and renders every part', () => {
  const review = fnBody('function StepReview(');
  assert.match(review, /materializeNow=\{form\.materializeNow\}/);
  assert.match(review, /usesGithub=\{bundleUsesGithub\(form\.processBundle\)\}/);
  const notice = fnBody('function GoLiveNotice(');
  assert.match(notice, /goLiveNotice\(\{ agentCount, repoLabel, materializeNow, usesGithub \}\)/);
  assert.match(notice, /\{notice\.before\}\{notice\.code \? <code>\{notice\.code\}<\/code> : null\}\{notice\.after\}/);
  assert.match(notice, /\{notice\.repoWarning && \(\s*<p[^>]*>\{notice\.repoWarning\}<\/p>/);
});

test('the wizard offers no extend toggle (create-only)', () => {
  assert.match(SRC, /fields=\{\['materializeNow'\]\}/);
  assert.doesNotMatch(SRC, /fields=\{\[[^\]]*'extend'/);
  assert.match(SRC, /\n\s+extend: false,\n/);
});

test('reload / tab close warns while the wizard holds input', () => {
  assert.match(SRC, /const unsaved = wizardHasUnsavedInput\(\{ step, form, launched \}\);/);
  assert.match(SRC, /if \(!unsaved\) return undefined;/);
  assert.match(SRC, /window\.addEventListener\('beforeunload', handler\)/);
  assert.match(SRC, /window\.removeEventListener\('beforeunload', handler\)/);
  assert.match(SRC, /\}, \[unsaved\]\);/);
  assert.match(fnBody('  function onLaunchComplete('.trim()), /setLaunched\(true\);/);
});

test('no internal ticket reference in rendered copy', () => {
  // Comments are stripped above; what is left of a `#1234` is user-visible text.
  const hits = SRC.match(/#\d{3,5}\b/g) || [];
  assert.deepEqual(hits, [], `ticket ids in UI copy: ${hits.join(', ')}`);
});
