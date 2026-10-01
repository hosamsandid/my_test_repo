import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Drift guard for the #2704 Agent Chat rail semantics.
 *
 * axe flagged the rail as an unnamed `listbox` owning team-header buttons
 * (aria-required-children / aria-input-field-name), `aria-selected` on those
 * plain buttons (aria-allowed-attr), and kebab/drag-grip controls nested inside
 * the `role="option"` rows and the header buttons (nested-interactive). The fix
 * is a structure: a named `list` of `listitem`s whose main `<button>` sits
 * BESIDE the secondary controls, never around them.
 *
 * `AgentList.jsx` is JSX, which `node --test` cannot load (#651), so these
 * assertions read the source instead — in the same spirit as
 * `rail-lifecycle-wiring.test.js`. Comments are stripped first so a comment
 * mentioning the old roles can't stand in for (or trip over) the code.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = rel => fs.readFileSync(path.join(HERE, rel), 'utf8');

function code(src) {
  return src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

const list = code(read('./AgentList.jsx'));

const agentRow = list.match(/const AgentRow = React\.memo\(function AgentRow\([\s\S]*?\n\}\);/)[0];
const header = list.match(/function CollapsibleHeader\([\s\S]*?\n\}/)[0];
const kebab = list.match(/function KebabButton\([\s\S]*?\n\}/)[0];

test('#2704 — the rail is a named list, not a listbox of options', () => {
  assert.doesNotMatch(list, /role="listbox"/);
  assert.doesNotMatch(list, /role="option"/);
  assert.match(list, /const RAIL_LABEL = 'Agents';/);
  assert.match(list, /<div role="list" aria-label=\{RAIL_LABEL\}/);
});

test('#2704 — every child of a list is a listitem (team block, singles, rows, sub-sections)', () => {
  // The team block, the "Individual agents" block, the stub and pool-instance
  // sub-sections, and every agent row.
  assert.match(list, /<div role="listitem" style=\{TEAM_BLOCK_STYLE\}>/);
  assert.match(agentRow, /role="listitem"/);
  for (const fn of ['StubSection', 'PoolInstancesSection']) {
    const body = list.match(new RegExp(`function ${fn}\\([\\s\\S]*?\\n\\}`))[0];
    assert.match(body, /<div role="listitem">/, `${fn} must render a listitem`);
    assert.match(body, /<div role="list" aria-label=\{label\}>/, `${fn} must nest its rows in a named list`);
  }
  // Nested member lists are named after the team they belong to.
  assert.match(list, /<div role="list" aria-label=\{group\.displayName\}>/);
  assert.match(list, /<div role="list" aria-label=\{INDIVIDUAL_LABEL\}>/);
});

test('#2704 — the empty-state hint is rendered outside the list', () => {
  const railList = list.indexOf('<div role="list" aria-label={RAIL_LABEL}');
  const hint = list.indexOf("'No agents match this filter.'");
  // The list closes before the hint: the last `</div>` that closes the rail
  // list sits between them, and the hint's guard is the `empty &&` block.
  assert.ok(railList >= 0 && hint > railList);
  const between = list.slice(railList, hint);
  assert.match(between, /\n {6}<\/div>\n\n {6}\{empty && \(/);
});

test('#2704 — selection is aria-current, never aria-selected on a plain button', () => {
  assert.doesNotMatch(list, /aria-selected/);
  assert.match(agentRow, /aria-current=\{selected \? 'true' : undefined\}/);
  assert.match(header, /aria-current=\{selected \? 'true' : undefined\}/);
});

test('#2704 — no interactive element is nested inside a row or header button', () => {
  // No ARIA buttons faked on spans anywhere in the rail any more.
  assert.doesNotMatch(list, /role="button"/);
  // The kebab is a real button now that it no longer lives inside one.
  assert.match(kebab, /<button\s+type="button"/);
  // In a row, the main button closes before the kebab and the grip open.
  const rowClose = agentRow.indexOf('</button>');
  assert.ok(rowClose > 0, 'AgentRow renders a main <button>');
  assert.ok(agentRow.indexOf('<KebabButton') > rowClose, 'kebab sits after the row button, not inside it');
  assert.ok(agentRow.indexOf('<DragGrip') > rowClose, 'grip sits after the row button, not inside it');
  assert.equal((agentRow.match(/<button/g) || []).length, 1);
  // In a header: chevron button, then the main button — both closed before
  // the kebab and grip.
  assert.equal((header.match(/<button/g) || []).length, 2);
  const headerClose = header.lastIndexOf('</button>');
  assert.ok(header.indexOf('<KebabButton') > headerClose);
  assert.ok(header.indexOf('<DragGrip') > headerClose);
});

test('#2704 — keyboard behaviour is unchanged: the row still owns Alt+↑/↓ and the menu keys', () => {
  for (const [name, body] of [['AgentRow', agentRow], ['CollapsibleHeader', header]]) {
    assert.match(body, /aria-keyshortcuts=\{dragEnabled \? 'Alt\+ArrowUp Alt\+ArrowDown' : undefined\}/, name);
    assert.match(body, /if \(e\.key === 'ArrowUp'\)\s+\{ e\.preventDefault\(\); onReorder\(dragScope, dragKey, -1\); \}/, name);
    assert.match(body, /if \(e\.key === 'ArrowDown'\) \{ e\.preventDefault\(\); onReorder\(dragScope, dragKey, 1\); \}/, name);
    assert.match(body, /e\.key === 'ContextMenu' \|\| \(e\.shiftKey && e\.key === 'F10'\)/, name);
  }
  // Selection still goes through the id-taking callback (and a non-openable
  // row still opens its menu instead).
  assert.match(agentRow, /if \(openable\) \{ onSelect\(agent\.id\); return; \}/);
  assert.match(header, /onClick=\{onActivate\}/);
});

test('#2704 — labelled indicator spans beside the buttons carry role="img"', () => {
  // Outside a button a bare `span[aria-label]` is aria-prohibited-attr, so the
  // grip and the row's status dot must keep their img role.
  const grip = list.match(/function DragGrip\([\s\S]*?\n\}/)[0];
  assert.match(grip, /<span\s+role="img"\s+aria-label="Drag to reorder"/);
  assert.match(agentRow, /<span\s+role="img"\s+title=\{dot\.label\}\s+aria-label=\{dot\.label\}/);
});

test('#2704 — a kebab click opens the menu without selecting the row', () => {
  // The kebab is a sibling of the main button inside the row wrapper, whose
  // onClick selects the agent; only stopPropagation keeps the click off it.
  assert.match(kebab, /function open\(e\) \{\s+e\.stopPropagation\(\);/);
});
