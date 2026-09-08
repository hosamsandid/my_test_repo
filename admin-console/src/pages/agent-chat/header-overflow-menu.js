/**
 * header-overflow-menu.js — pure keyboard-navigation helpers for the agent-header
 * overflow menu (#1810).
 *
 * The `…` menu groups the rare, destructive session actions (Reset Session /
 * Clear History). A proper `role="menu"` supports arrow-key traversal, so these
 * helpers compute which item receives focus next while **skipping disabled
 * items** (a disabled Reset/Clear must never be the arrow target) and wrapping
 * around the ends. `HeaderOverflowMenu.jsx` is a thin renderer over them.
 *
 * **The implementations moved to `src/components/row-context-menu-view.js`**
 * (#2053), together with the `RowContextMenu` that also uses them: that
 * component is now shared between the Agent-Chat rail and the Flows rail, and a
 * component under `components/` must not import out of a `pages/` folder. This
 * module re-exports them so every existing importer — and
 * `header-overflow-menu.test.js` — keeps addressing them here.
 */

export {
  firstEnabledIndex,
  lastEnabledIndex,
  nextEnabledIndex,
} from '../../components/row-context-menu-view.js';
