/**
 * flow-canvas-hints.js — tooltip copy for the Flow-Editor canvas control row
 * (the overlay buttons `flow-graph-render.js` builds: Fit / Expand All /
 * Collapse All / flow-direction / Archived / Stages).
 *
 * Those six buttons carried no explanation at all (only the direction toggle
 * had a native `title=`), so "Fit", "Flow ↓" and "Archived" were guesswork
 * (#1999). Three of them are *toggles*, and a toggle's hint has to say which
 * way the click will go — otherwise "Archived" is still ambiguous once it is
 * already on. That state→text decision is the only logic here, which is why it
 * lives in this pure module rather than inline in the imperative renderer
 * (#651 convention): `flow-graph-render.js` just wires the returned string into
 * `attachTooltip`.
 *
 * Pure and DOM-free — no import from the renderer, no React.
 */

/** Static hints for the three one-shot view actions. */
export const CANVAS_TITLES = {
  fit: 'Fit the whole flow to the view',
  expandAll: 'Expand all agent nodes',
  collapseAll: 'Collapse all agent nodes',
};

/**
 * Hint for the flow-direction toggle. The button's own text already shows the
 * direction it will switch TO ("Flow →" while vertical), so the hint names both
 * ends to make that unambiguous.
 *
 * @param {'vertical'|'horizontal'} orientation  the CURRENT orientation
 * @returns {string}
 */
export function orientationTitle(orientation) {
  return orientation === 'vertical'
    ? 'Toggle layout direction — switch from top-down to left-right'
    : 'Toggle layout direction — switch from left-right to top-down';
}

/**
 * Hint for the Archived toggle.
 *
 * @param {boolean} showArchived  whether archived items are currently shown
 * @returns {string}
 */
export function archivedTitle(showArchived) {
  return showArchived
    ? 'Hide archived agents and teams from the canvas'
    : 'Show archived agents and teams on the canvas';
}

/**
 * Hint for the stage-grouping toggle.
 *
 * @param {boolean} showStages  whether stage grouping is currently on
 * @returns {string}
 */
export function stagesTitle(showStages) {
  return showStages
    ? 'Hide stage grouping — lay the flow out without stage bands'
    : 'Show stage grouping — band the agents by their stage';
}
