import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pushOpenPanel, removeOpenPanel, isTopPanel,
  panelTabAction, initialFocusTarget, canRestoreFocus,
} from './side-panel-view.js';
import { focusTrapTarget } from './modal-view.js';

const at = (over) => ({ isTop: true, inPanel: false, inOtherDialog: false, inAppRoot: false, onBody: false, ...over });

test('#2960 AC1 — opening focuses the first body field, else the close button', () => {
  assert.equal(initialFocusTarget({ activeInPanel: false, bodyFocusableCount: 3 }), 'body');
  assert.equal(initialFocusTarget({ activeInPanel: false, bodyFocusableCount: 0 }), 'close');
});

test('#2960 AC1 — a consumer that already focused a field inside (autoFocus) keeps it', () => {
  assert.equal(initialFocusTarget({ activeInPanel: true, bodyFocusableCount: 3 }), 'keep');
});

test('#2960 AC2 — Tab inside the top panel is trapped', () => {
  assert.equal(panelTabAction(at({ inPanel: true, inAppRoot: true })), 'trap');
});

test('#2960 AC2 — focus on the dimmed page or <body> is pulled back into the panel', () => {
  assert.equal(panelTabAction(at({ inAppRoot: true })), 'pull');
  assert.equal(panelTabAction(at({ onBody: true })), 'pull');
});

test('#2960 — a dialog layered over the panel (ConfirmDialog) keeps its own keyboard', () => {
  assert.equal(panelTabAction(at({ inOtherDialog: true })), 'ignore');
  // ...also when that dialog is rendered inline inside the panel's subtree.
  assert.equal(panelTabAction(at({ inOtherDialog: true, inPanel: true, inAppRoot: true })), 'ignore');
});

test('#2960 — a popover portaled to <body> outside the app root is left alone', () => {
  assert.equal(panelTabAction(at({})), 'ignore');
});

test('#2960 — only the most recently opened panel handles Tab', () => {
  assert.equal(panelTabAction(at({ isTop: false, inPanel: true })), 'ignore');
  assert.equal(panelTabAction(at({ isTop: false, inAppRoot: true })), 'ignore');
});

test('#2960 — open-panel stack: the last opened is top; closing it hands back to the one below', () => {
  const a = {}; const b = {};
  pushOpenPanel(a);
  assert.equal(isTopPanel(a), true);
  pushOpenPanel(b);
  assert.equal(isTopPanel(a), false);
  assert.equal(isTopPanel(b), true);
  removeOpenPanel(b);
  assert.equal(isTopPanel(a), true);
  removeOpenPanel(a);
  assert.equal(isTopPanel(a), false);
  removeOpenPanel(a); // idempotent
});

test('#2960 — closing a lower panel first leaves the upper one on top', () => {
  const a = {}; const b = {};
  pushOpenPanel(a); pushOpenPanel(b);
  removeOpenPanel(a);
  assert.equal(isTopPanel(b), true);
  removeOpenPanel(b);
});

test('#2960 AC2 — pulled-in focus lands on the first (Tab) or last (Shift+Tab) panel control', () => {
  // A 'pull' passes index -1 into the shared Modal trap rule.
  assert.equal(focusTrapTarget(-1, 11, false), 0);
  assert.equal(focusTrapTarget(-1, 11, true), 10);
});

test('#2960 AC2 — 30 Tab presses over an 11-control panel never leave it', () => {
  // Simulates the Add Trigger panel from the issue: the browser moves focus
  // one step forward unless the trap redirects it.
  const n = 11;
  for (const back of [false, true]) {
    let i = 0;
    for (let k = 0; k < 30; k++) {
      const forced = focusTrapTarget(i, n, back);
      i = forced !== null ? forced : i + (back ? -1 : 1);
      assert.ok(i >= 0 && i < n, `focus left the panel at press ${k + 1}`);
    }
  }
});

test('#2960 AC3 — focus is restored only to an opener that still exists', () => {
  const live = { isConnected: true, focus() {} };
  assert.equal(canRestoreFocus(live), true);
  assert.equal(canRestoreFocus({ isConnected: false, focus() {} }), false);
  assert.equal(canRestoreFocus(null), false);
  assert.equal(canRestoreFocus({ isConnected: true }), false);
});
