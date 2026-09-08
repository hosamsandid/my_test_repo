/**
 * flows-rail-menu.js — what the Flows left list offers on a row (#2053 B3).
 *
 * Before this ticket the rail had no context menu of any kind: a row was a
 * single `<button>`, the only per-row action was a hover-revealed trash icon on
 * **drafts**, and a **team** row had no action at all. That is also why
 * *Create team…* — the one action the whole page exists to lead to — was
 * reachable only from the canvas toolbar, after selecting the draft.
 *
 * The interaction model is the Agent-Chat rail's (#1928/#1938, epic #1925 D3:
 * "context menu, not icon rows"), so a beginner meets one model on both lists
 * rather than two. This module is the Flows-side sibling of
 * `agent-lifecycle/agent-lifecycle-menu.js`: it decides WHICH entries a row
 * gets, the page owns the menu state and every dialog and request behind it, and
 * `components/RowContextMenu.jsx` draws it.
 *
 * Item shape is `RowContextMenu`'s: `{key, label, danger?, disabled?, title?,
 * separated?}`. `separated` draws a group boundary as a `borderTop` on the item
 * that carries it — i.e. on the item AFTER the fence — so the menu stays a flat
 * list of real, focusable entries (a pseudo-separator would be an unfocusable
 * hole in the index-walked list).
 *
 * Pure and React-free so it unit-tests without a DOM (per the #651 convention).
 */

import { CREATE_TEAM_LABEL } from './create-team-copy.js';

/**
 * The canvas actions the rail cannot perform itself.
 *
 * *Create team…* needs the draft's bundle and *Edit as draft* needs the team's
 * exported template — both already loaded and handled by `ProcessCanvas`. Rather
 * than a second copy of either (a second `POST /api/process/drafts` with its own
 * subtly-different error handling is exactly how two front doors diverge), the
 * rail selects the row and hands the canvas an **intent** through the URL, the
 * way `?copilot=1` already keeps the Copilot panel open across a scope change.
 */
export const FLOW_INTENTS = {
  createTeam: 'create-team',
  editAsDraft: 'edit-draft',
};

const INTENT_VALUES = new Set(Object.values(FLOW_INTENTS));

/** Read an `?intent=` param, ignoring anything this build does not know. */
export function parseFlowIntent(raw) {
  return INTENT_VALUES.has(raw) ? raw : null;
}

/**
 * Which menu key maps to which canvas intent. A key with no entry here is
 * handled by the page itself (rename, export, delete, open-in-chat).
 */
const INTENT_FOR_KEY = {
  'create-team': FLOW_INTENTS.createTeam,
  'edit-as-draft': FLOW_INTENTS.editAsDraft,
};

/** The canvas intent a chosen menu key hands over, or null. */
export function intentForMenuKey(key) {
  return INTENT_FOR_KEY[key] || null;
}

/**
 * Why *Create team…* is inert on an empty draft. Deliberately a short menu hint
 * rather than the toolbar's full `NO_ROLES_REASON` sentence — a menu item's
 * `title` is a tooltip on one row, and the draft's own status line carries the
 * long form where there is room for it.
 */
export const NO_ROLES_MENU_HINT = 'Add at least one agent first.';

/**
 * The menu for one Flows rail row.
 *
 * @param {{kind: 'draft'|'team', name?: string, id?: string, roleCount?: number}} [target]
 * @returns {{label: string, items: object[]}} an empty `items` for an
 *   unrecognised target — the host renders nothing rather than guessing, the
 *   `railMenuItems` degradation rule.
 */
export function buildFlowsRailMenu(target) {
  const kind = target && target.kind;
  if (kind !== 'draft' && kind !== 'team') return { label: '', items: [] };

  const name = (target.name || target.id || '').trim();
  const label = `Actions for ${name || (kind === 'draft' ? 'this draft' : 'this team')}`;

  if (kind === 'team') {
    return {
      label,
      items: [
        { key: 'edit-as-draft', label: 'Edit as draft' },
        { key: 'export', label: 'Export…' },
        { key: 'open-chat', label: 'Open in Agent Chat' },
      ],
    };
  }

  // Draft. `Create team…` is FIRST and visually set apart (AC8): it is the one
  // action the page leads to, and the fence is drawn on the entry below it so
  // it reads as its own group without a pseudo-item.
  //
  // It is offered-but-inert on an empty draft rather than omitted, so the menu
  // has one stable shape and the reason is readable instead of the entry being
  // mysteriously absent — the `gate()` doctrine of `buildAgentMenu`.
  const roleCount = Number.isFinite(target.roleCount) ? target.roleCount : 0;
  return {
    label,
    items: [
      {
        key: 'create-team',
        label: CREATE_TEAM_LABEL,
        disabled: roleCount <= 0,
        title: roleCount <= 0 ? NO_ROLES_MENU_HINT : undefined,
      },
      { key: 'rename', label: 'Rename…', separated: true },
      { key: 'export', label: 'Export…' },
      { key: 'delete', label: 'Delete draft', danger: true },
    ],
  };
}

export default buildFlowsRailMenu;
