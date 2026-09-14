import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { FLOW_CONTROL_HELP_SECTIONS } from './flow-control-help-sections.js';
import { topicSections, sectionSlug } from '../context/page-help-view.js';

// ─── #2116 (epic #2112) Flow Control board help guard ────────────────────────
//
// The board's surfaces deep-link into the `flow-control` topic's chapters. Two
// things rot silently and neither throws at runtime:
//
//   • a chapter heading reworded out from under the slug a call site names —
//     the panel then renders the topic from the top, which still *looks* like
//     the "?" worked; and
//   • a surface losing its affordance, or gaining a hand-written slug instead
//     of the shared constant.
//
// The JSX is otherwise uncovered per #651 — this is a source-text guard, not a
// render test.

const here = dirname(fileURLToPath(import.meta.url));

// Comments are stripped first: this file's own comments name the very chapters
// and constants being checked and would otherwise satisfy the matchers they
// merely explain.
function sourceOf(file) {
  return readFileSync(join(here, file), 'utf8')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

const page = sourceOf('FlowControl.jsx');
const topicBody = readFileSync(
  join(here, '../../api/helper-chat/help-topics/flow-control.md'), 'utf8',
);

test('the comment strip left the source intact', () => {
  // A strip that ate the file would make every absence assertion below vacuous.
  assert.ok(page.includes('export default function FlowControl'), 'the page body must survive');
  assert.ok(page.length > 2000, `stripped source is only ${page.length} chars`);
});

test('every chapter slug a call site names is really a heading in the topic', () => {
  const known = new Set(topicSections(topicBody).map((s) => s.slug));
  const missing = Object.entries(FLOW_CONTROL_HELP_SECTIONS)
    .filter(([, slug]) => !known.has(slug))
    .map(([name, slug]) => `${name} → "${slug}"`);
  assert.deepEqual(
    missing, [],
    'help-topics/flow-control.md no longer has a heading for these chapters. Reword the '
    + 'heading back, or update FLOW_CONTROL_HELP_SECTIONS — a stale slug degrades silently '
    + `to "open the topic at the top". Known headings: ${[...known].join(', ')}`,
  );
});

test('the chapter slugs are derived from the headings, not hand-written', () => {
  // If sectionSlug ever changed its rule the constants would still "exist" as
  // strings while matching nothing at runtime.
  assert.equal(sectionSlug('What the Flow Control board shows'), FLOW_CONTROL_HELP_SECTIONS.page);
  assert.equal(sectionSlug('The epic roll-up'), FLOW_CONTROL_HELP_SECTIONS.epics);
});

test('the four areas are top-level chapters, not sub-headings', () => {
  const h2 = topicSections(topicBody).filter((s) => s.level === 2).map((s) => s.slug);
  for (const key of Object.keys(FLOW_CONTROL_HELP_SECTIONS)) {
    assert.ok(
      h2.includes(FLOW_CONTROL_HELP_SECTIONS[key]),
      `"${FLOW_CONTROL_HELP_SECTIONS[key]}" must stay a "## " chapter`,
    );
  }
  // The empty/degraded-board material is deliberately a `###` inside chapter 1 —
  // this catches a stray top-level chapter splitting a deep-link target in two.
  assert.equal(h2.length, 5, `expected exactly the five chapters, got ${h2.join(' · ')}`);
});

test('each board surface mounts a "?" pointed at its own chapter', () => {
  assert.ok(
    /import PageHelpButton from '\.\.\/components\/PageHelpButton'/.test(page),
    'FlowControl must import the shared PageHelpButton',
  );
  assert.ok(
    /import \{ FLOW_CONTROL_HELP_SECTIONS \} from '\.\/flow-control-help-sections'/.test(page),
    'the slugs must come from the shared registry, never be written out inline',
  );
  for (const key of ['page', 'states', 'epics', 'poolControls']) {
    assert.ok(
      page.includes(`FLOW_CONTROL_HELP_SECTIONS.${key}`),
      `the ${key} surface must deep-link to its chapter (never a hand-written slug)`,
    );
  }
});

test('no chapter slug is inlined as a string literal in the page', () => {
  for (const slug of Object.values(FLOW_CONTROL_HELP_SECTIONS)) {
    assert.ok(
      !page.includes(`'${slug}'`) && !page.includes(`"${slug}"`),
      `"${slug}" is written out in FlowControl.jsx — import it from the registry instead`,
    );
  }
});

// ─── AC2, from the page's side ───────────────────────────────────────────────
//
// `flow-control-view.test.js` proves the *decisions* never read a label. This
// asserts the JSX did not reintroduce one behind the pure module's back — the
// only place a raw label could re-enter the board.

test('the page renders no raw label of its own', () => {
  assert.ok(
    !/\.labels\b/.test(page),
    'FlowControl.jsx must not read ticket.labels — state comes from the reconciler (AC2)',
  );
  for (const token of ['ready-2', 'ready-for-review', ':completed', ':wip']) {
    assert.ok(!page.includes(token), `the flow vocabulary "${token}" must not appear in the page`);
  }
});

test('the ticket ledger itself stays observe-only, even though the board now mutates pool state (#2250)', () => {
  // §4.1's guarantee is about the LEDGER — a ticket's derived state must never
  // be set by a mutating call from this page. #2250 Phase 5 adds a legitimate,
  // ADJACENT mutation surface (pause/resume/drain a pooled role; force-dispatch
  // a held ticket past the WIP limit) that acts on the admission lane / pool
  // runtime state, never on a ticket's own lifecycle field — so the ledger
  // fetch itself must stay GET-only, and every POST must target one of the
  // two named pool-control endpoints, never `/tickets`.
  assert.ok(
    /apiCall\('GET', `\/api\/teams\/\$\{encodeURIComponent\(teamId\)\}\/tickets`\)/.test(page),
    'the board must read the ledger endpoint',
  );
  const mutations = page.match(/apiCall\('(POST|PUT|PATCH|DELETE)', `[^`]*`/g) || [];
  assert.ok(mutations.length > 0, 'expected the pool-control/force-dispatch mutations to be present');
  for (const call of mutations) {
    assert.ok(
      /\/pool-control\/\$\{encodeURIComponent\(roleId\)\}`$/.test(call) || /\/force-dispatch`$/.test(call),
      `unexpected mutating call in the Flow Control board: ${call} — the ticket ledger must stay observe-only`,
    );
  }
});
