// ─── Non-route help wiring guard (E17 #1892, epic #1870 Phase 4) ─────────────
//
// The three surfaces this ticket reaches are not routes, so `help-coverage.test.js`
// cannot see them: the Settings dialog, the first-run setup wizard, and the steps
// inside the Agent Team Wizard. What can rot here is not content but *wiring* —
// a fourth first-run step, a renamed wizard step, or a dropped `useHelpSubject`
// call would each silently make a surface help-less again with no test failing.
//
// So this reads the real sources and asserts the wiring, with the two invariants
// that actually matter:
//   • every step id a wizard renders has a registered context key, and
//   • the step-id list stays index-aligned with the step labels beside it.
//
// The extraction is done by pure functions that are also run over synthetic
// sources below, so a broken matcher fails loudly instead of passing vacuously
// (the #1891 lesson).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require_ = createRequire(import.meta.url);
const { CONTEXT_KEYS } = require_('../../api/helper-chat/help-routes.js');

// Comments are stripped first: the extraction this ticket adds is *explained* in
// comments that name the very keys being asserted, which would otherwise satisfy
// (or confuse) the matchers below.
function stripComments(src) {
  return String(src)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
}

function readSource(rel) {
  return stripComments(fs.readFileSync(path.join(HERE, rel), 'utf8'));
}

// The string items of a named array literal (`const NAME = ['a', 'b'];`), or null
// when the declaration is absent.
function arrayLiteral(src, name) {
  const m = new RegExp(`const\\s+${name}\\s*=\\s*\\[([^\\]]*)\\]`).exec(src);
  if (!m) return null;
  const items = m[1].match(/['"]([^'"]*)['"]/g) || [];
  return items.map((s) => s.slice(1, -1));
}

// The `id:` values of an array-of-objects literal (`const STEPS = [{ id: 'a', … }]`).
function objectIds(src, name) {
  const m = new RegExp(`const\\s+${name}\\s*=\\s*\\[([\\s\\S]*?)\\n\\];`).exec(src);
  if (!m) return null;
  const ids = m[1].match(/id:\s*['"]([^'"]+)['"]/g) || [];
  return ids.map((s) => s.replace(/^id:\s*['"]/, '').replace(/['"]$/, ''));
}

// ── the extractors are verified, not just used ───────────────────────────────

test('arrayLiteral / objectIds actually parse, and report an absent declaration', () => {
  assert.deepEqual(arrayLiteral("const A = ['x', 'y'];", 'A'), ['x', 'y']);
  assert.equal(arrayLiteral('const B = 1;', 'A'), null);
  assert.deepEqual(objectIds("const S = [\n  { id: 'a', label: 'A' },\n  { id: 'b' },\n];", 'S'), ['a', 'b']);
  assert.equal(objectIds('const S = 2;', 'S'), null);
});

test('stripComments removes the explanation that names the keys under test', () => {
  assert.equal(stripComments("// resolves /team-setup#process\nconst A = ['x'];").trim(), "const A = ['x'];");
  assert.equal(stripComments('/* modal:settings */ const A = 1;').trim(), 'const A = 1;');
});

// ── the Agent Team Wizard: one context key per step, index-aligned ───────────

const teamSetup = readSource('TeamSetup.jsx');

test('TeamSetup publishes the current step as the help subject', () => {
  assert.match(
    teamSetup, /useHelpSubject\(\{\s*step:\s*STEP_HELP_IDS\[step\]/,
    'the wizard must publish its step, or the panel only ever sees the route',
  );
  assert.match(teamSetup, /<PageHelpButton/, 'the wizard needs a "?" to open that help');
});

test('STEP_HELP_IDS is index-aligned with the step labels it keys', () => {
  const labels = arrayLiteral(teamSetup, 'STEPS');
  const ids = arrayLiteral(teamSetup, 'STEP_HELP_IDS');
  assert.ok(labels && labels.length > 0, 'STEPS not found in TeamSetup.jsx');
  assert.ok(ids && ids.length > 0, 'STEP_HELP_IDS not found in TeamSetup.jsx');
  assert.equal(
    ids.length, labels.length,
    'a step was added or removed without giving it a help key — the ids are index-aligned with STEPS',
  );
});

test('every Agent Team Wizard step key is registered in help-routes.js', () => {
  const ids = arrayLiteral(teamSetup, 'STEP_HELP_IDS');
  for (const id of ids) {
    const key = `/team-setup#${id}`;
    assert.ok(
      Object.prototype.hasOwnProperty.call(CONTEXT_KEYS, key),
      `${key} is published by the wizard but not registered in CONTEXT_KEYS`,
    );
  }
});

// ── the first-run wizard: help for every step, sourced from existing topics ──

const setupWizard = readSource('SetupWizard.jsx');

test('the first-run wizard renders inline help for its current step', () => {
  // It runs *instead of* the Shell, so the panel is not mounted — the help has to
  // be rendered in the gate itself (AC2).
  assert.match(setupWizard, /<SetupStepHelp stepId=\{stepId\} \/>/);
  assert.match(setupWizard, /OVERLAY_SETUP_WIZARD/);
  assert.doesNotMatch(
    setupWizard, /openHelpFor/,
    'openHelpFor would flip panel state behind a screen where no panel is mounted',
  );
});

test('every first-run step has a context key, and it aliases an existing page topic', () => {
  const ids = objectIds(setupWizard, 'STEPS');
  assert.ok(ids && ids.length > 0, 'STEPS not found in SetupWizard.jsx');
  for (const id of ids) {
    const key = `wizard:setup#${id}`;
    const entry = CONTEXT_KEYS[key];
    assert.ok(entry, `${key} is a first-run step with no registered help context`);
    assert.ok(
      entry.alias,
      `${key} must alias the route whose topic already covers it — the first-run flow `
      + 'reuses existing topics rather than duplicating their prose (AC2)',
    );
  }
});

test('the first-run auto-open nudge is not spent on a screen with no panel', () => {
  // The setup wizard replaces the Shell, so no panel is mounted there; the nudge
  // would otherwise open + persist "seen" for a route the user never saw it on.
  const ctx = stripComments(fs.readFileSync(path.join(HERE, '../context/HelperChatContext.jsx'), 'utf8'));
  assert.match(ctx, /panelCountRef\.current === 0\) return/);
  const panel = stripComments(fs.readFileSync(path.join(HERE, '../components/HelperChatPanel.jsx'), 'utf8'));
  assert.match(panel, /registerHelpPanel\(\)/, 'the panel must register itself, or the nudge never fires');
});

// ── the Settings dialog ─────────────────────────────────────────────────────

const settingsModal = readSource('../components/SettingsModal.jsx');

test('the Settings dialog publishes itself as an overlay only while it is open', () => {
  assert.match(
    settingsModal,
    /useHelpSubject\(\{\s*overlay:\s*OVERLAY_SETTINGS,\s*step:\s*active\.id,\s*active:\s*open\s*\}\)/,
    'gating on `open` is what hands help back to the page when the dialog closes (AC1)',
  );
  assert.match(settingsModal, /<PageHelpButton/, 'the dialog needs its own "?"');
});

test('the Settings dialog sections have registered context keys', () => {
  const view = readSource('../components/settings-modal-view.js');
  const ids = objectIds(view, 'SETTINGS_SECTIONS');
  assert.ok(ids && ids.length > 0, 'SETTINGS_SECTIONS not found');
  for (const id of ids) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(CONTEXT_KEYS, `modal:settings#${id}`),
      `modal:settings#${id} is published by the dialog but not registered in CONTEXT_KEYS`,
    );
  }
});
