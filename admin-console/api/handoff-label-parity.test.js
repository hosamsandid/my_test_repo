'use strict';

// #2665 — the Flow editor's hand-off dialogs validate label names with
// HANDOFF_LABEL_RE (src/pages/process/handoff-validation.js), a copy of the
// Flow Control READY_LABEL_RE in api.js: src cannot import this CJS module, so
// the literal is duplicated. This pins the two to the same pattern.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('node:url');

const VALIDATION = pathToFileURL(path.join(__dirname, '..', 'src', 'pages', 'process', 'handoff-validation.js')).href;

test('#2665: HANDOFF_LABEL_RE mirrors api.js READY_LABEL_RE', async () => {
  const api = fs.readFileSync(path.join(__dirname, 'api.js'), 'utf8');
  const m = api.match(/^const READY_LABEL_RE = \/(.+)\/;$/m);
  assert.ok(m, 'READY_LABEL_RE literal not found in api.js — re-point this guard');
  const { HANDOFF_LABEL_RE } = await import(VALIDATION);
  assert.equal(HANDOFF_LABEL_RE.source, m[1]);
  assert.equal(HANDOFF_LABEL_RE.flags, '');
});
