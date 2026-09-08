// Source-reading guards for the Pending queue tab (#2101).
//
// Two jobs, both of which no other test in either package could do:
//
//  1. AC8 — every `kind` a producer can currently WRITE into a
//     `pending-triggers.json` has a label and a real tooltip. Before this
//     ticket `handover-dm` and `loop-verify` both rendered as a raw token with
//     the tooltip "An unrecognised queue entry", because nothing connected the
//     producers to KIND_LABELS. The enumeration below is mechanical, so the
//     NEXT new kind cannot land unlabelled either.
//
//  2. AC3/AC6 — the row is wired to the Processed tab's own cells, and the
//     repository / GitHub event id left the visible string without leaving the
//     page. The cells are JSX and stay uncovered per #651, so the wiring is
//     read out of the source instead.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { kindLabel, kindTooltip } from './pending-queue-view.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..', '..', '..');

function read(...parts) {
  return fs.readFileSync(path.join(REPO, ...parts), 'utf8');
}

// Comments are stripped before a source assertion, so a comment that merely
// NAMES a pattern (this file's own prose, or a `// kind: 'x'` note) can never
// stand in for the wiring it describes.
function stripJsComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function isLabelled(kind) {
  return kindLabel(kind) !== kind && kindTooltip(kind) !== kindTooltip('unknown');
}

/* ── 1a. the producer call sites ──────────────────────────────────────────────
   One row per place in the tree that writes a kind-bearing queue entry. The
   pattern is asserted to still match, so a producer that moves or is renamed
   fails here loudly ("re-point this guard") rather than silently dropping out
   of the enumeration. */
const PRODUCERS = [
  {
    kind: 'github-digest',
    where: ['orchestrator', 'github-poller.js'],
    pattern: /_enqueuePending\([^)]*,\s*\{\s*kind: 'github-digest'/,
  },
  {
    kind: 'throttle-warning',
    where: ['orchestrator', 'github-poller.js'],
    pattern: /_enqueuePending\([^)]*,\s*\{\s*kind: 'throttle-warning'/,
  },
  {
    kind: 'session-reset',
    where: ['orchestrator', 'orchestrator.js'],
    pattern: /enqueuePending\([^)]*,\s*\{\s*kind: 'session-reset'/,
  },
  {
    kind: 'session-set',
    where: ['orchestrator', 'orchestrator.js'],
    pattern: /enqueuePending\([^)]*,\s*\{\s*kind: 'session-set'/,
  },
  {
    kind: 'wake-agent',
    where: ['orchestrator', 'wake-agent.js'],
    pattern: /kind: 'wake-agent'/,
  },
  {
    kind: 'handover-dm',
    where: ['admin-console', 'api', 'api.js'],
    pattern: /kind: 'handover-dm'/,
  },
  {
    kind: 'loop-verify',
    where: ['agent-image', 'scripts', 'agent-entrypoint.py'],
    pattern: /"kind": "loop-verify"/,
  },
];

test('AC8 — every producer-side queue kind still has a producer, a label and a tooltip', () => {
  for (const { kind, where, pattern } of PRODUCERS) {
    const src = read(...where);
    assert.ok(
      pattern.test(src),
      `${where.join('/')} no longer writes kind '${kind}' in the expected shape — re-point this guard`,
    );
    assert.ok(isLabelled(kind), `kind '${kind}' is written by a producer but has no label/tooltip`);
  }
});

test('AC8 — the kinds derived from an entry with no explicit kind are labelled too', () => {
  // `github` and `trigger` are never written as a `kind` field: entryKind()
  // in the orchestrator's projection derives them from the entry's shape (a
  // `github` block, or a bare `triggerId`). They would fall out of a purely
  // literal producer scan, so they are named here from that same source.
  const src = stripJsComments(read('orchestrator', 'pending-queue.js'));
  assert.match(src, /return 'github'/, 'entryKind no longer derives github — re-point this guard');
  assert.match(src, /return 'trigger'/, 'entryKind no longer derives trigger — re-point this guard');
  for (const kind of ['github', 'trigger']) {
    assert.ok(isLabelled(kind), `derived kind '${kind}' has no label/tooltip`);
  }
  // `unknown` is the honest fallback and has its own copy on purpose.
  assert.equal(kindLabel('unknown'), 'Unknown');
});

/* ── 1b. completeness: the consumer is the oracle ─────────────────────────────
   A kind only does anything if the agent runtime's drain dispatches on it (or
   the orchestrator handles it out-of-band). So the runtime's dispatch is a
   mechanical, complete list of the kinds that can reach a row — which is what
   makes this a real ratchet rather than a checklist somebody has to remember to
   extend. */

// The body of `_handle_pending_entry`, i.e. the drain's dispatch — sliced out so
// unrelated `kind == "..."` comparisons elsewhere in a 5 000-line runtime (the
// control-channel switch, the trigger-type switch) are not mistaken for queue
// kinds.
function drainDispatchKinds(py) {
  const start = py.indexOf('def _handle_pending_entry');
  assert.notEqual(start, -1, 'agent-entrypoint.py no longer defines _handle_pending_entry — re-point this guard');
  const rest = py.slice(start);
  const end = rest.indexOf('\n    def ', 1);
  const body = end === -1 ? rest : rest.slice(0, end);

  const kinds = new Set();
  for (const m of body.matchAll(/kind == "([a-z][a-z0-9-]*)"/g)) kinds.add(m[1]);
  // One branch compares against a module constant rather than a literal.
  for (const m of body.matchAll(/kind == (_[A-Z_]+)/g)) {
    const decl = new RegExp(`^${m[1]} = "([a-z][a-z0-9-]*)"`, 'm').exec(py);
    assert.ok(decl, `agent-entrypoint.py: cannot resolve queue-kind constant ${m[1]}`);
    kinds.add(decl[1]);
  }
  return kinds;
}

test('AC8 — every kind the agent runtime drains has a label (the drift ratchet)', () => {
  const py = read('agent-image', 'scripts', 'agent-entrypoint.py');
  const kinds = drainDispatchKinds(py);
  // Sanity: the slice really found the dispatch. Without this the assertion
  // below would pass vacuously on an empty set.
  assert.ok(kinds.size >= 6, `expected the drain to dispatch on several kinds, found ${[...kinds].join(', ')}`);
  assert.ok(kinds.has('handover-dm') && kinds.has('loop-verify'), 'the two kinds #2101 labelled are no longer drained — re-point this guard');
  for (const kind of kinds) {
    assert.ok(isLabelled(kind), `kind '${kind}' is drained by the agent runtime but renders as an unrecognised entry`);
  }
});

test('AC8 — the kinds the runtime deliberately leaves to the orchestrator are labelled, except the retired one', () => {
  const py = read('agent-image', 'scripts', 'agent-entrypoint.py');
  const decl = /_PENDING_OUT_OF_SCOPE_KINDS = \{([^}]*)\}/.exec(py);
  assert.ok(decl, 'agent-entrypoint.py no longer declares _PENDING_OUT_OF_SCOPE_KINDS — re-point this guard');
  const kinds = [...decl[1].matchAll(/"([a-z][a-z0-9-]*)"/g)].map(m => m[1]);
  assert.ok(kinds.length > 0);
  for (const kind of kinds) {
    if (kind === 'bp-event-batch') {
      // Deliberately unlabelled: #1962 removed the producer and #1964 removed
      // the label. A leftover entry falls through to its own raw kind string,
      // which is more honest than inventing a name for a dead mechanism.
      assert.equal(kindLabel(kind), kind);
      continue;
    }
    assert.ok(isLabelled(kind), `out-of-scope kind '${kind}' has no label/tooltip`);
  }
});

/* ── 2. the row wiring ─────────────────────────────────────────────────────── */

const PAGE = () => stripJsComments(read('admin-console', 'src', 'pages', 'GithubEventLog.jsx'));

test('AC3 — the pending row renders the Processed tab\'s own work-item cells', () => {
  const src = PAGE();
  // The composite cell is what the Work item column renders, and it is built
  // out of the two existing cells rather than a second implementation of them.
  assert.match(src, /function PendingWorkItemCell\([\s\S]*?<TypeCell workItem=\{workItem\} \/>[\s\S]*?<WorkItemCell workItem=\{workItem\} repo=\{repo\} \/>/);
  assert.match(src, /label: 'Work item'[\s\S]{0,200}<PendingWorkItemCell/);
  assert.match(src, /label: 'Title'[\s\S]{0,200}<TitleCell/);
});

test('AC4 — a work-item-less pending row renders one dash, not two', () => {
  // TypeCell and WorkItemCell each render their own `—`, so the pair must be
  // guarded by a single absence check before either is mounted.
  const src = PAGE();
  const cell = /function PendingWorkItemCell\([\s\S]*?\n\}/.exec(src);
  assert.ok(cell, 'PendingWorkItemCell is gone — re-point this guard');
  const guardAt = cell[0].indexOf('number == null');
  const typeAt = cell[0].indexOf('<TypeCell');
  assert.ok(guardAt !== -1 && typeAt !== -1 && guardAt < typeAt);
});

test('AC6 — the repository and the event id are on the hover, not in the string', () => {
  const src = PAGE();
  // The Details cell offers the pure hover helper as its title…
  assert.match(src, /label: 'Details'[\s\S]{0,600}entryHoverDetail\(row\)/);
  assert.match(src, /label: 'Details'[\s\S]{0,900}title=\{hover \|\| undefined\}/);
  // …and the detail string itself no longer composes either value. The
  // orchestrator still PROJECTS repo (the work-item cell needs it to build a
  // `→ closes #n` link), so the guard is on the view helper, which is where the
  // string is built.
  const view = stripJsComments(read('admin-console', 'src', 'pages', 'pending-queue-view.js'));
  const detail = /export function entryDetail\([\s\S]*?\n\}/.exec(view);
  assert.ok(detail, 'entryDetail is gone — re-point this guard');
  const githubBranch = /case 'github': \{[\s\S]*?\}/.exec(detail[0]);
  assert.ok(githubBranch);
  assert.ok(!githubBranch[0].includes('entry.repo'), 'the repository is back in the Details string');
  assert.ok(!githubBranch[0].includes('entry.eventId'), 'the GitHub event id is back in the Details string');
  // AC6's last clause: nothing in this string may prefix a number with GitHub's
  // work-item reference sigil, which is what made an internal id read as a
  // ticket number in the first place.
  assert.ok(!githubBranch[0].includes('#'), 'no row element may prefix a non-work-item number with the # sigil');
});

test('AC5 — the event key is rendered through the shared friendly-name map', () => {
  const view = stripJsComments(read('admin-console', 'src', 'pages', 'pending-queue-view.js'));
  assert.match(view, /import \{ eventLabel \} from '\.\/agent-chat\/trigger-summary\.js'/);
  assert.match(view, /eventLabel\(entry\.event\)/);
});

test('AC7 — the label is rendered as a chip carrying the bare token and the raw one on hover', () => {
  const src = PAGE();
  assert.match(src, /function PendingLabelChip\(/);
  assert.match(src, /title=\{`Flow label: \$\{chip\.raw\}`\}/);
  assert.match(src, /\{chip\.token\}/);
  assert.match(src, /\{chip\.state\}/);
  assert.match(src, /label: 'Details'[\s\S]{0,600}<PendingLabelChip label=\{row\.label\} \/>/);
});

test('AC11 — cancel, refresh, grouping and the two counters are untouched', () => {
  const src = PAGE();
  // Cancel still calls the same handler with the same two arguments. #2102 moved
  // the call site from the row button's onClick into the kebab menu's onChoose
  // (the row gained a second action, so the house rule made it a menu), so the
  // row identifier is now the menu's captured row — the assertion follows the
  // call rather than pinning the surface it used to live on.
  assert.match(src, /onCancel\(group\.agentId, (?:row|menu\.row)\.id\)/);
  assert.match(src, /\{group\.count\} pending/);
  assert.match(src, /\{total\} entr\{total === 1 \? 'y' : 'ies'\} waiting/);
  assert.match(src, /groups\.map\(g => \([\s\S]{0,200}<AgentPendingGroup/);
});
