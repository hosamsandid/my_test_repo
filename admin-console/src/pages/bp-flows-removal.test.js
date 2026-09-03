import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Removal guard for the Flows-page half of the BriefingPack removal
 * (#1965, epic #1961 Phase 4).
 *
 * A SIBLING of `bp-removal-ui.test.js` (Phase 3) rather than an extension of
 * it, and the reason is the retention. That guard sweeps its surfaces for a
 * flat vocabulary list including `/BriefingPack/`, which is correct there —
 * every BP mention on those pages went. Here it would be wrong: this phase
 * KEEPS the pack importer (epic decision R3) and AC4 requires its wording to
 * say so, so `Briefings.jsx` names BriefingPacks on purpose. Adding these files
 * to that guard's SURFACES would fail on the very copy this ticket asks for.
 *
 * So the split is by claim, not by file: Phase 3 asserts "no BP vocabulary on
 * these pages", Phase 4 asserts "no BP *source* in the flow editor, and the one
 * retained affordance is an explicit, correctly-worded action".
 *
 * Source-reading per the #651 convention — these are JSX and imperative DOM
 * modules the pure tests cannot load.
 */

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const has = (rel) => existsSync(fileURLToPath(new URL(rel, import.meta.url)));

/**
 * Comments name the removed feature — a removal PR's own explanatory comments
 * are exactly what a naive sweep trips over — so strip them before asserting.
 *
 * LINE-oriented, not the usual `/\/\*[\s\S]*?\*\//` block sweep, and not out of
 * caution: `EdgeDialogs.jsx` carries the literal
 * `placeholder="e.g. designs/**  — where it usually lands"`. A block sweep
 * reads that `/*` as a comment opener and runs to the next `*​/` — the JSDoc
 * header of a later function — swallowing the real code in between, after which
 * every `doesNotMatch` below would pass for entirely the wrong reason. (Same
 * hazard the api-side guard hits on Express route strings ending in `/*`.)
 *
 * The trade-off is that prose on the continuation lines of a multi-line JSX
 * `{...}` comment survives the strip, so every assertion below is anchored on
 * code shapes — a JSX tag, a call, a property — rather than on bare vocabulary
 * a comment could plausibly contain.
 */
const strip = (src) => src
  .replace(/^[ \t]*\/\/[^\n]*$/gm, '')   // whole-line // comments
  .replace(/^[ \t]*\*[^\n]*$/gm, '')      // continuation lines of /* … */ blocks
  .replace(/^[ \t]*\/\*[^\n]*$/gm, '')    // opening line of a /* … */ block
  .replace(/[ \t]\/\/[^\n]*$/gm, '');     // trailing comments

const FILES = {
  'Briefings.jsx': 'Briefings.jsx',
  'process/edit-adapters.js': 'process/edit-adapters.js',
  'process/connection-capabilities.js': 'process/connection-capabilities.js',
  'process/flow-graph-render.js': 'process/flow-graph-render.js',
  'process/flow-layout.js': 'process/flow-layout.js',
  'process/wiring-engine.js': 'process/wiring-engine.js',
  'process/EdgeDialogs.jsx': 'process/EdgeDialogs.jsx',
  'ProcessCanvas.jsx': 'ProcessCanvas.jsx',
};

const RAW = Object.fromEntries(Object.entries(FILES).map(([k, rel]) => [k, read(`./${rel}`)]));
const CODE = Object.fromEntries(Object.entries(RAW).map(([k, src]) => [k, strip(src)]));

/* ── strip sanity ────────────────────────────────────────────────────── */

test('the comment strip leaves every swept file structurally intact', () => {
  // Without this, a strip that ate a whole file would make every doesNotMatch
  // below pass for entirely the wrong reason.
  const signatures = {
    'Briefings.jsx': /export default function Briefings\(/,
    'process/edit-adapters.js': /export const liveOps/,
    'process/connection-capabilities.js': /export function capabilitiesFor/,
    'process/flow-graph-render.js': /export function initFlowGraph/,
    'process/flow-layout.js': /^function computeFlowLayout\(/m,
    'process/wiring-engine.js': /export async function wireArtifactFlow/,
    'process/EdgeDialogs.jsx': /export function EditHandoffDialog/,
    'ProcessCanvas.jsx': /export function ProcessGraphPanel/,
  };
  for (const [name, src] of Object.entries(CODE)) {
    assert.ok(src.length > RAW[name].length * 0.25, `${name}: strip removed most of the file`);
    assert.match(src, signatures[name], `${name} lost its own code to the strip`);
  }
});

test('the line-oriented strip preserves a "/*" that lives inside a string literal', () => {
  // The concrete reason this file does not use the usual block sweep. Pinned
  // rather than described, so if the literal is ever reworded the rationale
  // above is re-checked instead of quietly becoming folklore.
  const hazards = Object.entries(RAW)
    .filter(([, src]) => /['"`][^'"`\n]*\/\*/.test(src))
    .map(([name]) => name);
  assert.deepEqual(hazards, ['process/EdgeDialogs.jsx'], 'the set of block-strip hazards changed');
  assert.match(CODE['process/EdgeDialogs.jsx'], /designs\/\*\*/, 'the strip ate the literal');
  // …and the code that follows it in the file survived.
  assert.match(CODE['process/EdgeDialogs.jsx'], /export function EditHandoffDialog/);
});

/* ── AC1: the Flows page lists drafts and live flows only ────────────── */

test('AC1 — the BriefingPack listing is gone from the Flows page', () => {
  const page = CODE['Briefings.jsx'];
  assert.doesNotMatch(page, /BriefingPack flows/, 'the list section header is back');
  assert.doesNotMatch(page, /<SectionHeader>BriefingPack/);
  assert.doesNotMatch(page, /role === 'orchestrator'/, 'the page still derives an orchestrator list');
  assert.doesNotMatch(page, /\borchestrators\b/);
  assert.doesNotMatch(page, /<FlowRow\b/, 'the BP list row is still rendered');
  assert.doesNotMatch(page, /function FlowRow\(/, 'the BP list row component is still defined');
  // The sections that stay.
  assert.match(page, /<SectionHeader>Drafts<\/SectionHeader>/);
  assert.match(page, /<SectionHeader[\s\S]{0,80}?Teams/);
});

test('AC1 — the page no longer selects, persists or restores a BP flow', () => {
  const page = CODE['Briefings.jsx'];
  assert.doesNotMatch(page, /function selectFlow\(/);
  assert.doesNotMatch(page, /persistLastSelected\('flow'/, "a 'flow' selection is persisted again");
  assert.doesNotMatch(page, /stored\.kind === 'flow'/, 'a stale stored BP selection is restored again');
  assert.doesNotMatch(page, /\bselectedAgent\b/);
  // An old `?flow=` bookmark must be dropped rather than silently ignored —
  // otherwise it renders an empty right pane with no explanation.
  assert.match(page, /searchParams\.get\('flow'\)/, 'the stale param is no longer read at all');
  assert.match(page, /staleFlowParam[\s\S]{0,200}?setSearchParams/);
});

test('AC1 — the flow editor no longer mounts the BP viewer or its inspector', () => {
  assert.ok(!has('./process/FlowGraph.jsx'), 'the BP viewer component must be deleted, not merely unmounted');
  assert.ok(!has('./process/BpNodeInspector.jsx'), 'the BP node inspector must be deleted');
  for (const [name, src] of Object.entries(CODE)) {
    assert.doesNotMatch(src, /\bFlowGraph\b/, `${name} still references the BP viewer`);
    assert.doesNotMatch(src, /BpNodeInspector/, `${name} still references the BP node inspector`);
  }
});

/* ── AC1: no brief.md editing anywhere ───────────────────────────────── */

test('AC1 — nothing writes back to a brief.md', () => {
  for (const [name, src] of Object.entries(CODE)) {
    assert.doesNotMatch(src, /makeBpOps/, `${name} still builds the brief.md write adapter`);
    assert.doesNotMatch(src, /frontmatter-edit/, `${name} still calls the front-matter edit endpoint`);
    assert.doesNotMatch(src, /bp-explorer/, `${name} still talks to bp-explorer`);
    assert.doesNotMatch(src, /brief\.md/, `${name} still names a brief.md as an edit target`);
  }
});

test("AC1 — the 'bp' capability mode is gone from the matrix", () => {
  const caps = CODE['process/connection-capabilities.js'];
  assert.doesNotMatch(caps, /^\s*bp:\s*\{/m, 'the bp mode entry is back in MODES');
  assert.doesNotMatch(caps, /export function bpMode/);
  // The four that stay.
  for (const mode of ['live', 'draft', 'blueprint', 'viewer']) {
    assert.match(caps, new RegExp(`^\\s*${mode}:\\s*\\{`, 'm'), `the ${mode} mode is missing`);
  }
});

/* ── AC4: the import is an explicit, correctly-worded action ─────────── */

test('AC4 — the import is a page action wired to the pure copy module', () => {
  const page = RAW['Briefings.jsx']; // read unstripped: the import statement matters
  assert.match(
    page,
    /import \{[\s\S]{0,200}?IMPORT_BRIEFINGS_COPY[\s\S]{0,200}?\} from '\.\/process\/import-briefings-view'/,
    'the copy must come from the pure module, not inline strings no test can reach',
  );
  const code = CODE['Briefings.jsx'];
  assert.match(code, /<Tooltip[\s\S]{0,200}?IMPORT_BRIEFINGS_COPY\.tooltip/, 'the action has no tooltip');
  assert.match(code, /onClick=\{openBriefingsImport\}/, 'the action does not open the dialog');
  assert.match(code, /IMPORT_BRIEFINGS_COPY\.action/, 'the button does not use the shared label');
  // Held until the agent list resolves — the dialog's picker is built from it,
  // and an empty list mid-load is indistinguishable from "there are none".
  assert.match(code, /disabled=\{agents === null\}/, 'the action opens before the list has loaded');
  assert.match(code, /IMPORT_BRIEFINGS_COPY\.loading/, 'the held state has no explanation');
});

test('AC4 — the import survives as a reachable action, not a passive listing', () => {
  const code = CODE['Briefings.jsx'];
  assert.match(code, /\/api\/process\/drafts\/import-briefings/, 'the import endpoint is no longer called');
  assert.match(code, /importRequestBody\(/, 'the request body is built inline again');
  // It opens the resulting draft — the migration is not finished at the POST.
  assert.match(code, /setSearchParams\(\{ proc: `draft:\$\{d\.id\}` \}\)/);
});

test('AC4 — the import no longer sends an unguarded absolute workspace path', () => {
  const code = CODE['Briefings.jsx'];
  assert.doesNotMatch(code, /\/workspace\/agents\//, 'an absolute container path is built client-side again');
  assert.doesNotMatch(code, /briefingsPath/, 'the page reads the retired config field directly again');
});

test('AC4 — a failed import is shown inline, not in a window.alert', () => {
  // The server's message names the directory / id / containment problem the
  // user has to fix, and it belongs next to the field they must correct.
  const code = CODE['Briefings.jsx'];
  assert.doesNotMatch(code, /window\.alert/);
  assert.match(code, /importErrorText\(/);
});

/* ── AC5: flow authoring is untouched ────────────────────────────────── */

test('AC5 — the .bp-node class family survives (it is every node, a naming legacy)', () => {
  // The ticket's Trap: `.bp-node` is the class of EVERY node in the flow
  // editor, and the e2e flow journeys select on it. A removal sweep that took
  // it would leave the editor rendering and every journey failing.
  const render = RAW['process/flow-graph-render.js'];
  assert.match(render, /'bp-node'/, 'the node class is gone');
  assert.match(render, /bp-node-human/, 'the human-node class is gone');
  assert.match(render, /bp-graph-styles/, 'the style element id is gone');
  assert.match(render, /bp-badge\b/, 'the badge classes are gone');
});

test('AC5 — the shared edge/wiring surfaces keep their behaviour', () => {
  // These files were in scope for comment cleanup only. Assert the code the
  // comments described is still there, so a comment sweep cannot quietly take
  // a branch with it.
  assert.match(CODE['process/wiring-engine.js'], /ops\.addDependency\(to, from\)/);
  assert.match(CODE['process/EdgeDialogs.jsx'], /wireArtifactFlow\(\{ ops \}/);
  assert.match(CODE['process/flow-layout.js'], /^\s*wrapColumns,$/m, 'the column-wrap export is gone');
  assert.match(CODE['ProcessCanvas.jsx'], /capabilitiesFor\(processMode\(/);
});

test('AC5 — the write-target adapters the editor actually uses are retained', () => {
  const adapters = CODE['process/edit-adapters.js'];
  assert.match(adapters, /export const liveOps/);
  assert.match(adapters, /export function makeDraftOps/);
});
