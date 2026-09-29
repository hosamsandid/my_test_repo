import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Drift guard for the #2558 wiring (the #651 convention): the decisions live in
 * `add-role-materialize.js`, but the checkbox, the request key and the notice
 * are wired in `ProcessCanvas.jsx`, which `node --test` cannot load.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const code = fs.readFileSync(path.join(HERE, '..', 'ProcessCanvas.jsx'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

const dialog = code.slice(code.indexOf('function AddRoleDialog('));
const dialogEnd = dialog.indexOf('\nfunction ', 1);
const dialogSrc = dialogEnd > 0 ? dialog.slice(0, dialogEnd) : dialog;

test('AddRoleDialog: checkbox state starts from the shared default', () => {
  assert.match(dialogSrc, /useState\(ADD_ROLE_MATERIALIZE_DEFAULT\)/);
});

test('AddRoleDialog: the checkbox renders only on a live team, with the shared label and hint', () => {
  assert.match(dialogSrc, /function AddRoleDialog\(\{ live = false,/);
  assert.match(dialogSrc, /\{live && \(\s*<label[\s\S]*?type="checkbox" checked=\{materializeNow\}/);
  assert.match(dialogSrc, /\{ADD_ROLE_MATERIALIZE_LABEL\}/);
  assert.match(dialogSrc, /\{ADD_ROLE_MATERIALIZE_HINT\}/);
});

test('AddRoleDialog: both tabs pass the choice to onCreate (AC7)', () => {
  assert.match(dialogSrc, /templateId: selectedTemplateId, template: fullTemplate, \.\.\.materialize \}/);
  assert.match(dialogSrc, /systemPrompt, \.\.\.materialize \}/);
});

test('AddRoleDialog: the submit label comes from the pure module', () => {
  assert.match(dialogSrc, /addRoleSubmitLabel\(\{ busy, materializeNow, live \}\)/);
});

test('canvas: the dialog is live only outside a draft, and the choice reaches addLiveRole', () => {
  assert.match(code, /<AddRoleDialog\s+live=\{!isDraft\}/);
  assert.match(code, /addLiveRole\(\{ displayName, systemPrompt, templateId, materializeNow \}\)/);
});

test('addLiveRole: always sends the explicit `materialize` key and reports the server mode', () => {
  const fn = code.slice(code.indexOf('async function addLiveRole('));
  const body = fn.slice(0, fn.indexOf('\n  }\n'));
  assert.match(body, /\.\.\.addRoleMaterializeBody\(\{ materializeNow \}\)/);
  assert.match(body, /addRoleNotice\(\{ \.\.\.\(created \|\| \{\}\), id \}\)/);
  assert.match(code, /addRoleResult && addRoleResult\.scope === scope/);
});
