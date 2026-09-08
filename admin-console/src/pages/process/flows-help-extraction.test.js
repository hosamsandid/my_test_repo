import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { FLOWS_HELP_SECTIONS } from './flows-help-sections.js';
import {
  topicSections,
  sectionSlug,
  OVERLAY_FLOW_EDGE,
  OVERLAY_FLOW_LABELS,
  OVERLAY_FLOW_HUMANS,
  OVERLAY_FLOW_STAGES,
  OVERLAY_FLOW_NODE,
  OVERLAY_FLOW_ANOMALIES,
  OVERLAY_FLOW_IMPROVEMENTS,
  OVERLAY_DRAFT_SHARE,
} from '../../context/page-help-view.js';

// ─── #1984 (epic #1981) Flows per-surface help guard ─────────────────────────
//
// E2 (#1876) left `help-topics/flows.md` as one topic behind one page-level "?"
// on the flows-list header. Flows is the console's busiest page — a canvas, six
// side panels, a docked Copilot rail and a family of edge dialogs — so this
// ticket split the topic into ten chapters and pointed each surface at the one
// written for it. Four things can rot here, and none of them throws at runtime:
//
//   • a chapter heading reworded out from under the slug a surface names — the
//     panel then just renders the topic from the top, which still *looks* like
//     the "?" worked,
//   • a surface losing its affordance, or gaining a hand-written slug instead
//     of the shared constant,
//   • a SidePanel losing its published help subject — the "?" still opens the
//     panel, but at z-index 50 it opens BEHIND the panel it is explaining,
//     which reads as "the button does nothing" (the bug #1990 flagged on THIS
//     page and left for this ticket), and
//   • the two factual corrections this ticket made (the left list has no third
//     section; the chooser's tiles depend on the drag source) being reworded
//     back to what the older docs claimed.
//
// All four are asserted from the real sources here. The JSX is otherwise
// uncovered per the #651 convention — this is a source-text guard, not a render
// test.

const here = dirname(fileURLToPath(import.meta.url));

// Comments are stripped before asserting on the source: this ticket's own
// comments name the very chapters, constants and hooks being checked, and would
// otherwise satisfy the matchers they merely explain.
function sourceOf(rel) {
  return readFileSync(join(here, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
}

// The surfaces from the ticket's table, as { file, chapter key }. Ten from
// #1984, plus the draft Share panel #2068 added — it lives in Briefings.jsx
// beside the left-list header, which is why that file appears twice.
const SURFACES = [
  ['the flows left-list header', '../Briefings.jsx', 'overview'],
  ['the draft Share panel', '../Briefings.jsx', 'sharingDrafts'],
  ['the canvas toolbar', '../ProcessCanvas.jsx', 'canvas'],
  ['the hand-off chooser', './EdgeDialogs.jsx', 'handoffs'],
  ['the label registry', './LabelRegistryPanel.jsx', 'humans'],
  ['the human-role registry', './HumanRegistryPanel.jsx', 'humans'],
  ['the Routing section', './RoutingSection.jsx', 'routing'],
  ['the stage manager', './StageManager.jsx', 'stages'],
  ['the anomalies panel', './FlowAnomaliesPanel.jsx', 'anomalies'],
  ['the improvements panel', './ImprovementsPanel.jsx', 'improvements'],
  ['the Flow Copilot rail', './FlowCopilotPanel.jsx', 'copilot'],
];

// The SidePanel-hosted surfaces, which additionally need a published subject.
// FlowCopilotPanel is deliberately absent: it is a flex CHILD of the canvas
// layout, not a SidePanel, so the help panel already opens in front of it.
// NodeInspector publishes on RoutingSection's behalf — the "?" is in the
// Routing tab, but the panel body is the inspector's.
// Briefings.jsx joined the list with #2068: its Share panel is a `SidePanel`
// too, so it needs the same lift as the seven Flow-editor ones.
const OVERLAY_OWNERS = [
  ['../Briefings.jsx', 'OVERLAY_DRAFT_SHARE', OVERLAY_DRAFT_SHARE],
  ['./EdgeDialogs.jsx', 'OVERLAY_FLOW_EDGE', OVERLAY_FLOW_EDGE],
  ['./LabelRegistryPanel.jsx', 'OVERLAY_FLOW_LABELS', OVERLAY_FLOW_LABELS],
  ['./HumanRegistryPanel.jsx', 'OVERLAY_FLOW_HUMANS', OVERLAY_FLOW_HUMANS],
  ['./StageManager.jsx', 'OVERLAY_FLOW_STAGES', OVERLAY_FLOW_STAGES],
  ['./NodeInspector.jsx', 'OVERLAY_FLOW_NODE', OVERLAY_FLOW_NODE],
  ['./FlowAnomaliesPanel.jsx', 'OVERLAY_FLOW_ANOMALIES', OVERLAY_FLOW_ANOMALIES],
  ['./ImprovementsPanel.jsx', 'OVERLAY_FLOW_IMPROVEMENTS', OVERLAY_FLOW_IMPROVEMENTS],
];

const topicBody = readFileSync(
  join(here, '../../../api/helper-chat/help-topics/flows.md'), 'utf8',
);

test('the stripped sources are still the components, not holes', () => {
  // Several of these files carry long block comments; a runaway strip would
  // make every doesNotMatch/absence assertion below pass for the wrong reason.
  const signatures = [
    ['../Briefings.jsx', 'export default function Briefings'],
    ['../ProcessCanvas.jsx', 'export function ProcessGraphPanel'],
    ['./EdgeDialogs.jsx', 'export function CreateEdgeDialog'],
    ['./LabelRegistryPanel.jsx', 'export default function LabelRegistryPanel'],
    ['./HumanRegistryPanel.jsx', 'export default function HumanRegistryPanel'],
    ['./RoutingSection.jsx', 'export default function RoutingSection'],
    ['./StageManager.jsx', 'export default function StageManager'],
    ['./FlowAnomaliesPanel.jsx', 'export default function FlowAnomaliesPanel'],
    ['./ImprovementsPanel.jsx', 'export default function ImprovementsPanel'],
    ['./FlowCopilotPanel.jsx', 'export default function FlowCopilotPanel'],
    ['./NodeInspector.jsx', 'export default function NodeInspector'],
  ];
  for (const [file, signature] of signatures) {
    assert.ok(
      sourceOf(file).includes(signature),
      `comment-stripping removed ${signature} from ${file}`,
    );
  }
});

test('every chapter slug the page names is really a heading in the topic', () => {
  const known = new Set(topicSections(topicBody).map(s => s.slug));
  const missing = Object.entries(FLOWS_HELP_SECTIONS)
    .filter(([, slug]) => !known.has(slug))
    .map(([name, slug]) => `${name} → "${slug}"`);
  assert.deepEqual(
    missing, [],
    'help-topics/flows.md no longer has a heading for these chapters. Reword the '
    + 'heading back, or update FLOWS_HELP_SECTIONS — a stale slug degrades silently '
    + `to "open the topic at the top". Known headings: ${[...known].join(', ')}`,
  );
});

test('the chapter slugs are derived from the headings, not hand-written', () => {
  // Guards the pairing itself: if sectionSlug ever changed its rule, the
  // constants would still "exist" as strings while matching nothing at runtime.
  const pairs = [
    ['What Flows is', 'overview'],
    ['The flows left list', 'list'],
    ['The canvas', 'canvas'],
    ['Wiring hand-offs: the edge chooser', 'handoffs'],
    ['Human gates, brakes and named human roles', 'humans'],
    ['Outcomes and inputs, per agent', 'routing'],
    ['Stages', 'stages'],
    ['Anomalies', 'anomalies'],
    ['Improvements', 'improvements'],
    ['Describe the flow: the Copilot', 'copilot'],
    ['Sharing a draft', 'sharingDrafts'],
  ];
  for (const [heading, key] of pairs) {
    assert.equal(sectionSlug(heading), FLOWS_HELP_SECTIONS[key], `chapter "${heading}"`);
  }
});

test('all the areas the tickets name are top-level chapters, not sub-headings', () => {
  const h2 = topicSections(topicBody).filter(s => s.level === 2).map(s => s.slug);
  for (const [key, slug] of Object.entries(FLOWS_HELP_SECTIONS)) {
    assert.ok(
      h2.includes(slug),
      `"${slug}" (${key}) must stay a "## " chapter — the panel scrolls to h2/h3, `
      + 'but the ticket asks for one clearly-headed chapter per area',
    );
  }
  // Ten from #1984 plus `Sharing a draft` (#2068).
  assert.equal(
    h2.length, 11,
    `expected exactly the eleven chapters, got ${h2.length}: ${h2.join(' · ')}`,
  );
});

test('the chapter with no "?" of its own keeps its own heading', () => {
  // `list` is reached by scrolling one heading down from `overview`, which is
  // where the flows-list header's button lands. Nothing else would notice if it
  // were folded into a neighbour, so it must stay separately addressable.
  const h2 = topicSections(topicBody).filter(s => s.level === 2).map(s => s.slug);
  assert.ok(h2.includes(FLOWS_HELP_SECTIONS.list), 'the left-list chapter is gone');
});

test('each of the ten surfaces mounts a "?" pointed at its own chapter', () => {
  // Per-surface `includes` rather than one regex over one file: these ten
  // surfaces live in nine files, and the mounts are not uniformly formatted.
  for (const [what, file, key] of SURFACES) {
    const src = sourceOf(file);
    assert.ok(
      src.includes('<PageHelpButton'),
      `${what} (${file}) must render the shared PageHelpButton`,
    );
    assert.ok(
      src.includes(`section={FLOWS_HELP_SECTIONS.${key}}`),
      `${what} (${file}) must deep-link to the ${key} chapter — a section-less `
      + 'button opens the topic at the top, which is the bug this ticket closes',
    );
    assert.ok(
      /import \{ FLOWS_HELP_SECTIONS \}/.test(src),
      `${what} (${file}) must import the shared registry, never inline a slug`,
    );
  }
});

test('every chapter that owns a surface is actually claimed by one', () => {
  // The converse of the test above: a chapter written for a surface that no
  // longer points at it is dead documentation, and nothing else notices.
  const claimed = new Set(SURFACES.map(([, , key]) => key));
  const unclaimed = Object.keys(FLOWS_HELP_SECTIONS).filter(k => !claimed.has(k));
  assert.deepEqual(
    unclaimed, ['list'],
    'exactly one chapter (`list`) is deliberately without its own "?" — the '
    + 'flows-list header opens `overview`, one heading above it. Any other '
    + 'unclaimed chapter means a surface lost its affordance',
  );
});

test('no chapter slug is inlined as a literal anywhere on the page', () => {
  // Two passes, because four of the ten slugs are single ordinary words
  // (`stages`, `anomalies`, `improvements`, `canvas`) that legitimately appear
  // as unrelated string literals on this page — `toolbarTitle('stages')` is not
  // a hand-written help slug. Matching those by value would be a false positive
  // that a later reader "fixes" by deleting the wrong line.
  //
  // Pass 1: the hyphenated multi-word slugs are unambiguous, so a bare literal
  // really is a hand-written slug.
  for (const [, file] of SURFACES) {
    const src = sourceOf(file);
    for (const [name, slug] of Object.entries(FLOWS_HELP_SECTIONS)) {
      if (!slug.includes('-')) continue;
      assert.ok(
        !src.includes(`'${slug}'`) && !src.includes(`"${slug}"`),
        `${name}'s slug is inlined in ${file} — import it from `
        + 'flows-help-sections.js so the drift guard above can see it',
      );
    }
  }
  // Pass 2: catches every slug regardless of shape, by anchoring on the prop
  // instead of the value — a `section=` that is not a FLOWS_HELP_SECTIONS
  // member reference is a hand-written slug whatever it spells.
  //
  // Scoped to the <PageHelpButton> element rather than to the file: EdgeDialogs
  // has its own unrelated `section` prop on OpenRoutingLink (which routing
  // sub-section to scroll the inspector to, e.g. section="inputs"), and that is
  // a name collision, not a hand-written help slug.
  let checked = 0;
  // Deduped: Briefings.jsx hosts two surfaces (#2068), and walking it twice
  // would double-count its buttons and make the anti-vacuity total meaningless.
  for (const file of [...new Set(SURFACES.map(([, f]) => f))]) {
    for (const el of sourceOf(file).match(/<PageHelpButton[\s\S]*?\/>/g) || []) {
      const m = /\bsection=(\{[^}]*\}|"[^"]*"|'[^']*')/.exec(el);
      assert.ok(m, `a PageHelpButton in ${file} names no chapter at all`);
      assert.match(
        m[1], /^\{FLOWS_HELP_SECTIONS\.\w+\}$/,
        `${file} passes a hand-written section (${m[1]}) — every "?" on this `
        + 'page must name its chapter through the shared registry',
      );
      checked += 1;
    }
  }
  // Anti-vacuity: this loop asserts nothing if the element regex stops matching
  // (a reformat that puts a child between the tags, say). Eleven surfaces, one
  // button each — the two registry panels share the `humans` CHAPTER but still
  // mount a button apiece, so the totals agree.
  assert.equal(checked, 11, `expected to check eleven "?" mounts, checked ${checked}`);
});

test('every SidePanel-hosted surface publishes a help subject', () => {
  // Without these the "?" inside a SidePanel (z-index 60/61) opens the help
  // panel underneath the surface it explains — a silent, entirely visual
  // failure, and the one #1990 flagged on this page without fixing.
  for (const [file, constName, value] of OVERLAY_OWNERS) {
    const src = sourceOf(file);
    assert.ok(
      // Depth-tolerant: the seven Flow-editor panels live in `pages/process/`,
      // Briefings.jsx one level up in `pages/`.
      /import \{ useHelpSubject \} from '(\.\.\/)+context\/HelperChatContext'/.test(src),
      `${file} must import useHelpSubject`,
    );
    assert.ok(
      src.includes(`useHelpSubject({ overlay: ${constName} })`),
      `${file} must publish ${constName} — its "?" is inside a SidePanel`,
    );
    assert.ok(
      src.includes(constName),
      `${file} must import the ${constName} constant, not a bare string`,
    );
    assert.ok(!src.includes(`'${value}'`), `${file} inlines the overlay id ${value}`);
  }
});

test('the Copilot rail deliberately publishes NO subject', () => {
  // It is a flex child of the canvas, not an overlay. Publishing one would lift
  // the help panel above every dialog on the route for as long as the rail is
  // open — including dialogs it knows nothing about.
  const src = sourceOf('./FlowCopilotPanel.jsx');
  assert.ok(
    !src.includes('useHelpSubject'),
    'FlowCopilotPanel is not a SidePanel — it must not publish a help subject',
  );
});

test('the overlay ids the page publishes are registered on both sides', () => {
  assert.equal(OVERLAY_FLOW_EDGE, 'modal:flow-edge');
  assert.equal(OVERLAY_FLOW_LABELS, 'modal:flow-labels');
  assert.equal(OVERLAY_FLOW_HUMANS, 'modal:flow-humans');
  assert.equal(OVERLAY_FLOW_STAGES, 'modal:flow-stages');
  assert.equal(OVERLAY_FLOW_NODE, 'modal:flow-node');
  assert.equal(OVERLAY_FLOW_ANOMALIES, 'modal:flow-anomalies');
  assert.equal(OVERLAY_FLOW_IMPROVEMENTS, 'modal:flow-improvements');
  const helpRoutes = readFileSync(
    join(here, '../../../api/helper-chat/help-routes.js'), 'utf8',
  );
  for (const [, , key] of OVERLAY_OWNERS) {
    // An unregistered key resolves to no context, so panelZIndex never lifts —
    // the exact failure the subject was published to avoid. Two occurrences,
    // because the key belongs in OVERLAY_KEYS *and* CONTEXT_KEYS.
    const hits = helpRoutes.split(`'${key}'`).length - 1;
    assert.equal(
      hits, 2,
      `${key} must appear in BOTH OVERLAY_KEYS and CONTEXT_KEYS in `
      + `help-routes.js (found ${hits} occurrence(s))`,
    );
  }
});

test('the flows-list header keeps exactly one page-level "?"', () => {
  // A second entry point in that header would compete with the one the epic
  // standardised on; every other button on this page lives inside a panel, a
  // dialog or the canvas toolbar.
  //
  // Briefings.jsx carries two buttons since #2068 — the header's, and the one
  // inside the draft Share `SidePanel` — so counting the file is no longer the
  // same as counting the header. Assert the chapters instead: exactly one
  // `overview` (the header) and exactly one `sharingDrafts` (the panel), and
  // nothing else. A third button would have to name a third chapter, and a
  // second header button would push `overview` to two.
  const src = sourceOf('../Briefings.jsx');
  const sections = (src.match(/<PageHelpButton[\s\S]*?\/>/g) || [])
    .map(el => (/\bsection=\{FLOWS_HELP_SECTIONS\.(\w+)\}/.exec(el) || [])[1]);
  assert.deepEqual(
    sections.sort(), ['overview', 'sharingDrafts'],
    'expected exactly one page-level "?" (the Flows left-list header) and one '
    + 'inside the draft Share panel',
  );
});

test('no point-of-decision microcopy was traded for a "?"', () => {
  // Scope — out: the ticket expands the topic and adds "?" links. Every hint
  // below sits at the moment a decision is made and must stay on the page.
  const edges = sourceOf('./EdgeDialogs.jsx');
  const routing = sourceOf('./RoutingSection.jsx');
  const hints = sourceOf('../process-toolbar-hints.js');
  const canvas = sourceOf('../ProcessCanvas.jsx');

  // The per-tile one-liners in the hand-off chooser.
  for (const phrase of [
    'sets a label that wakes',
    'opens an issue that wakes',
    'opens a pull request that wakes',
    'Leave the name empty for a plain dependency.',
    'wakes on a repo event (issue opened, PR opened, push',
    'via an HTTP call',
    'groups ${B} as a child',
  ]) {
    assert.ok(edges.includes(phrase), `"${phrase}" is a per-tile one-liner and must stay on the page`);
  }
  // The Delivery selector's own explainer — the live consequence of a choice.
  for (const phrase of [
    'Via GitHub events — the poller delivers the wake',
    'Direct (internal) — label mirrored to GitHub',
  ]) {
    assert.ok(edges.includes(phrase), `"${phrase}" is the Delivery selector's copy`);
  }
  // The dynamic Inputs / Outcomes hints.
  for (const phrase of [
    'exactly one — the agent picks exactly one outcome per run (a switch).',
    'any of — zero or more outcomes may apply on a run.',
    'Nothing wakes this agent yet',
    'Nothing is stored until you do.',
  ]) {
    assert.ok(routing.includes(phrase), `"${phrase}" is a dynamic routing hint and must stay`);
  }
  // process-toolbar-hints.js keeps the disabled-reasons, and the toolbar keeps
  // reading them — a "?" is not a substitute for saying why a button is dead.
  assert.ok(hints.includes('export const TOOLBAR_TITLES'), 'TOOLBAR_TITLES was removed');
  assert.ok(hints.includes('export const STATUS_TITLES'), 'STATUS_TITLES was removed');
  assert.ok(
    canvas.includes("toolbarTitle('materialize'") && canvas.includes("toolbarTitle('export'"),
    'the canvas toolbar stopped reading its disabled-reason copy',
  );
  // The two panels kept the lead lines their "?" now sits beside.
  assert.ok(
    sourceOf('./LabelRegistryPanel.jsx').includes('who sets it, and who reacts'),
    'the label registry lost its lead line',
  );
  assert.ok(
    sourceOf('./HumanRegistryPanel.jsx').includes('A human role never runs anything'),
    'the human registry lost its lead line',
  );
  assert.ok(
    sourceOf('./FlowAnomaliesPanel.jsx').includes('Observe-only; nothing is repaired here.'),
    'the anomalies panel lost its observe-only lead',
  );
  assert.ok(
    sourceOf('./ImprovementsPanel.jsx').includes('nothing changes until you apply one'),
    'the improvements panel lost its proposals-only lead',
  );
});

test('the topic records the two corrections this ticket made', () => {
  // Both contradict a premise the ticket (and CLAUDE.md) still carried, and
  // both were verified against the code. A reword must not restore the old
  // reading — that is exactly how these claims got stale the first time.
  //
  // 1. The left list has Teams and Drafts only: the Role-templates blueprint
  //    scope is discarded outright (Briefings.jsx drops `?proc=templates`), and
  //    the BriefingPack list went with #1965.
  assert.match(
    topicBody, /There is no third section\./,
    'the topic must keep saying the left list has only Teams and Drafts',
  );
  // 2. The chooser's tiles are per drag-source: an agent source offers no
  //    GitHub-trigger and no webhook tile (connection-capabilities.js), and
  //    `dependency` is not an explicit tile at all any more.
  assert.match(
    topicBody, /depends on where you dragged from/i,
    'the topic must keep saying which tiles appear depends on the drag source',
  );
  const source = readFileSync(join(here, 'connection-capabilities.js'), 'utf8');
  assert.match(
    source, /agent:\s*\['github-pr', 'github-issue', 'label', 'wake', 'artifact', 'hierarchy'\]/,
    'the agent create-type list changed — recheck the chooser chapter against it',
  );
});

test('#2031: the chooser chapter documents the direct hand-off and its limits', () => {
  // This guard is why the create-type assertion above is pinned to the exact
  // list: adding a tile without documenting it is the drift it exists to catch.
  assert.match(topicBody, /\*\*Hand off directly\*\*/, 'the tile is in the chooser table');
  assert.match(topicBody, /Label hand-off or direct hand-off\?/,
    'the topic answers WHICH to pick — the only question the two tiles raise');
  // The distinguishing question is what a human can see afterwards, not speed
  // or reliability: all three mechanisms use the same queue (concept §11).
  assert.match(topicBody, /\*\*what a human can see afterwards\*\*/i);
  // The three limits a reader would otherwise discover as a validation error.
  assert.match(topicBody, /same team/, 'the same-team limit');
  assert.match(topicBody, /never a person/, 'a human role has no queue to deliver to');
  assert.match(topicBody, /internal by construction/, 'no Delivery selector, and why');
  // And the two non-obvious facts about the note + the derived instruction.
  assert.match(topicBody, /context to\s+check/, 'the note is context, not instructions');
  assert.match(topicBody, /one per\s+agent, not one per incoming arrow/);
});
