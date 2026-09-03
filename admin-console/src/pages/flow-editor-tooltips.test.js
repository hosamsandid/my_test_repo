import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Drift guard for the Flow-Editor tooltip rollout (#1999, the Flow-editor slice
// of #1850). The three surfaces are JSX or imperative DOM, so the pure tests
// (process-toolbar-hints / flow-canvas-hints / tooltip-wrap) can prove the COPY
// but not that it is wired — and the failure mode this ticket exists to fix is
// precisely a button that renders without one. Assert against source per #651.
const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
// Comments name what moved and why, so strip them before asserting a native
// `title=` is gone (a comment mentioning it is not a regression).
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const canvas = read('./ProcessCanvas.jsx');
const canvasCode = stripComments(canvas);
const briefings = read('./Briefings.jsx');
const render = read('./process/flow-graph-render.js');
const renderCode = stripComments(render);

// ─── B. Flow header row (ProcessCanvas.jsx) ───────────────────────────────

test('ToolbarButton renders the shared Tooltip instead of a native title', () => {
  const body = canvasCode.slice(canvasCode.indexOf('function ToolbarButton('));
  const decl = body.slice(0, body.indexOf('\n}\n'));
  assert.match(decl, /<Tooltip label=\{title\}/, 'ToolbarButton must wrap its button in Tooltip');
  assert.doesNotMatch(decl, /title=\{title\}/, 'the native title attribute must be gone');
});

test('the header row keeps exactly one ToolbarButton implementation', () => {
  // AC2 leans on this: migrating the one wrapper covers every header button.
  const impls = canvasCode.match(/function ToolbarButton\(/g) || [];
  assert.equal(impls.length, 1);
});

// `<ToolbarButton onClick={() => …}>` contains a `>` inside its props, so the
// open tag ends at the first `>` seen at brace depth 0.
function openTag(src, start) {
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === '>' && depth === 0) return src.slice(start, i + 1);
  }
  return src.slice(start);
}

test('every ToolbarButton in the header row passes a title', () => {
  const opens = [...canvasCode.matchAll(/<ToolbarButton\b/g)];
  assert.ok(opens.length >= 14, `expected the full header row, saw ${opens.length}`);
  for (const m of opens) {
    const tag = openTag(canvasCode, m.index);
    assert.match(tag, /\btitle=\{/, `a ToolbarButton has no tooltip: ${tag.slice(0, 90)}`);
  }
});

test('the header-row copy comes from the pure hints module, not inline strings', () => {
  assert.match(canvas, /import \{ toolbarTitle, STATUS_TITLES \} from '\.\/process-toolbar-hints'/);
  // A literal title="…" / title={'…'} would be copy no test can reach.
  assert.doesNotMatch(canvasCode, /<ToolbarButton[\s\S]{0,200}?title="/);
});

test('the mode pill and the rename control migrated too', () => {
  assert.match(canvasCode, /<Tooltip label=\{title\}[\s\S]{0,200}?<span\s+aria-label=/);
  assert.match(canvasCode, /<Tooltip label=\{STATUS_TITLES\.renameDraft\}/);
  // AC6: the rename button's visible text is the flow NAME, so the verb has to
  // survive in the accessible name once the native title is gone.
  assert.match(canvasCode, /aria-label=\{`Rename flow: \$\{name \|\| 'Untitled flow'\}`\}/);
});

test('no native title attribute is left in the flow header row', () => {
  // Locate on the raw source (the markers are JSX comments) and strip after.
  const row = stripComments(canvas.slice(
    canvas.indexOf('{/* Toolbar — the scope picker'),
    canvas.indexOf('{/* Imported-bundle banner */}'),
  ));
  assert.ok(row.length > 500, 'header row slice not found — update the markers');
  assert.doesNotMatch(row, /\btitle="/);
});

// ─── A. Flows page-action bar (Briefings.jsx) ──────────────────────────────

test('every page-action button is wrapped in a Tooltip', () => {
  assert.match(briefings, /import \{ PAGE_ACTION_TITLES \} from '\.\/process-toolbar-hints'/);
  for (const key of ['import', 'describe', 'newFlow']) {
    assert.match(
      briefings,
      new RegExp(`<Tooltip[\\s\\S]{0,160}?PAGE_ACTION_TITLES\\.${key}\\b`),
      `the ${key} button has no tooltip`,
    );
  }
  // #1965 added a fourth. Its copy lives in its own pure module rather than in
  // PAGE_ACTION_TITLES — the whole point of the sentence is that this action is
  // NOT one of the create actions those titles describe — but "no button is
  // left unexplained" has to keep covering it.
  assert.match(
    briefings,
    /<Tooltip[\s\S]{0,200}?IMPORT_BRIEFINGS_COPY\.tooltip\b/,
    'the BriefingPack-import button has no tooltip',
  );
});

test('the page-action bar has a tooltip for every button it renders', () => {
  // Counted rather than enumerated, so a fifth action added without a hint
  // fails here instead of quietly slipping past the list above.
  const bar = briefings.slice(
    briefings.indexOf('const headerAction = usePageActions('),
    briefings.indexOf('  return (\n    <>'),
  );
  assert.ok(bar.length > 500, 'page-action bar slice not found — update the markers');
  const buttons = (bar.match(/<button\b/g) || []).length;
  const tooltips = (bar.match(/<Tooltip\b/g) || []).length;
  assert.equal(tooltips, buttons, `${buttons} page-action buttons but ${tooltips} tooltips`);
});

// ─── C. Canvas control row (flow-graph-render.js) ──────────────────────────

test('the imperative control row uses the shared tooltip, not a native title', () => {
  assert.match(render, /import \{ attachTooltip \} from '\.\.\/\.\.\/components\/tooltip-dom'/);
  assert.match(renderCode, /b\._tip = attachTooltip\(b, title\)/);
  // The direction toggle used to assign btn.title on every relabel.
  assert.doesNotMatch(renderCode, /\bbtn\.title\s*=/);
});

// Span of a `makeToolBtn(…)` call — its second argument is an arrow function
// with its own parentheses, so scan to the matching close.
function callSpan(src, start) {
  let depth = 0;
  for (let i = src.indexOf('(', start); i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')' && --depth === 0) return src.slice(start, i + 1);
  }
  return src.slice(start);
}

test('every control-row button is created with a hint', () => {
  const calls = [...renderCode.matchAll(/(?<!function )makeToolBtn\(/g)];
  assert.equal(calls.length, 6, 'expected the six canvas control buttons');
  const hint = /(CANVAS_TITLES\.\w+|orientationTitle\(|archivedTitle\(|stagesTitle\()/;
  for (const m of calls) {
    const call = callSpan(renderCode, m.index);
    assert.match(call, hint, `a canvas button has no hint: ${call.slice(0, 60)}`);
  }
});

test('each toggle relabels its tooltip when it relabels itself', () => {
  // Otherwise "Archived" would keep saying "Show…" after it was switched on.
  for (const fn of ['archivedTitle', 'orientationTitle', 'stagesTitle']) {
    assert.match(
      renderCode,
      new RegExp(`_tip\\?\\.setLabel\\(${fn}\\(`),
      `${fn} is never pushed back into the tooltip`,
    );
  }
});

test('cleanup destroys the portaled tooltips before dropping the buttons', () => {
  const cleanup = renderCode.slice(renderCode.indexOf('function cleanup()'));
  const body = cleanup.slice(0, cleanup.indexOf('\n  }\n'));
  const destroy = body.indexOf('tip.destroy()');
  const removeDom = body.indexOf('viewport.removeChild');
  assert.ok(destroy > -1, 'cleanup must destroy the tooltip handles');
  assert.ok(destroy < removeDom, 'destroy must run before the subtree is torn down');
});

// ─── AC8: long labels wrap rather than overflow ────────────────────────────

test('the wrapping decision is the shared helper, never a hand-picked flag', () => {
  for (const [name, src] of [['ProcessCanvas', canvas], ['Briefings', briefings]]) {
    assert.match(
      src,
      /import \{ shouldWrapTooltip \} from '\.\.\/components\/tooltip-wrap'/,
      `${name} must use the shared wrap rule`,
    );
  }
  assert.match(canvasCode, /wrap=\{shouldWrapTooltip\(title\)\}/);
  assert.match(read('../components/tooltip-dom.js'), /shouldWrapTooltip\(text\)/);
});
