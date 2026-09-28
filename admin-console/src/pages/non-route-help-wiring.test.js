// ─── Non-route help wiring guard (E17 #1892, epic #1870 Phase 4) ─────────────
//
// The surfaces this ticket reaches are not routes, so `help-coverage.test.js`
// cannot see them: the Settings dialog and the steps inside the Agent Team
// Wizard. What can rot here is not content but *wiring* — a renamed wizard step
// or a dropped `useHelpSubject` call would each silently make a surface
// help-less again with no test failing.
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

// ── the help panel never opens on its own (#2069) ────────────────────────────
//
// #1873 shipped a first-run auto-open nudge here: a route-keyed effect that
// opened the panel once per topic-bearing route, remembering which routes it had
// already nudged in `localStorage help.seenRoutes.<username>`. Once Phase 3/4
// gave nearly every route its own topic (#1875–#1892, #1981, #1996) that fired
// on almost every page a user opened, so it was removed. This guard is what
// keeps it from coming back: the panel may open only on an explicit user action.

// The opener calls the provider makes. `setIsOpen(true)` is the state write that
// opens the panel; a route-keyed effect is what would make it automatic.
function openCalls(src) {
  return (src.match(/setIsOpen\(true\)/g) || []).length;
}

// The bodies of every `useEffect(…)` in a source, so an assertion can ask what
// an effect does rather than what the whole file contains. Brace-matched from
// each `useEffect(` so a nested block does not truncate the body.
function effectBodies(src) {
  const out = [];
  const re = /useEffect\(/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    let depth = 0;
    let i = m.index + m[0].length - 1; // at the '('
    for (; i < src.length; i++) {
      const c = src[i];
      if (c === '(') depth += 1;
      else if (c === ')') {
        depth -= 1;
        if (depth === 0) { i += 1; break; }
      }
    }
    out.push(src.slice(m.index, i));
  }
  return out;
}

test('the help panel opens only from an explicit user action', () => {
  const ctx = stripComments(fs.readFileSync(path.join(HERE, '../context/HelperChatContext.jsx'), 'utf8'));

  // AC5: nothing reads or writes the seen-routes key any more.
  assert.doesNotMatch(ctx, /seenRoutes/, 'the seen-routes storage key must be gone');

  // AC1–AC4: no effect may open the panel. The two legitimate openers —
  // openTour() and openHelpFor() — are useCallbacks invoked by a click.
  for (const body of effectBodies(ctx)) {
    assert.doesNotMatch(
      body,
      /setIsOpen\(true\)/,
      'an effect that opens the panel is an auto-open — the panel may only open from a user action',
    );
  }

  // And the openers themselves are still there, so "no auto-open" was not
  // achieved by breaking the Help button.
  assert.equal(openCalls(ctx), 2, 'exactly two openers: openTour() and openHelpFor()');
  assert.match(ctx, /const openTour = useCallback\(/);
  assert.match(ctx, /const openHelpFor = useCallback\(/);
});

test('the auto-open decision helpers are gone from the pure core', () => {
  // Scope 2: leaving them exported with no caller is what makes a removal
  // reversible by accident.
  const view = stripComments(fs.readFileSync(path.join(HERE, '../context/page-help-view.js'), 'utf8'));
  for (const gone of ['autoOpenPlan', 'autoOpenRouteKey', 'seenRoutesKey', 'markSeen', 'parseSeenRoutes', 'hasDedicatedTopic']) {
    assert.doesNotMatch(view, new RegExp(`\\b${gone}\\b`), `${gone} has no caller and must not be exported`);
  }
});

test('the panel-registration counter is gone with the nudge that needed it', () => {
  // Scope 3: `panelCountRef`/`registerHelpPanel` existed solely to keep the
  // nudge from being spent on a screen that mounts no panel.
  const ctx = stripComments(fs.readFileSync(path.join(HERE, '../context/HelperChatContext.jsx'), 'utf8'));
  const panel = stripComments(fs.readFileSync(path.join(HERE, '../components/HelperChatPanel.jsx'), 'utf8'));
  assert.doesNotMatch(ctx, /panelCountRef|registerHelpPanel/);
  assert.doesNotMatch(panel, /registerHelpPanel/);
});

test('the auto-open guards are not vacuous', () => {
  // The #1891 lesson: an assertion that has only ever run against a correct
  // source proves nothing. Run each matcher over the shape it must reject.
  const reintroduced = `
    useEffect(() => {
      if (!authenticated) return;
      const seen = parseSeenRoutes(window.localStorage.getItem(seenRoutesKey(user.username)));
      setMode('page');
      setIsOpen(true);
    }, [authenticated, currentRoute]);
  `;
  const bodies = effectBodies(reintroduced);
  assert.equal(bodies.length, 1, 'the effect matcher must find a reintroduced effect');
  assert.match(bodies[0], /setIsOpen\(true\)/, 'the effect body must carry the open call');
  assert.match(reintroduced, /seenRoutes/, 'the storage-key matcher must see the key');
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
