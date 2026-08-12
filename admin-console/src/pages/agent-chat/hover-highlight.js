/**
 * Cross-panel hover highlight, driven by CSS rather than per-row React state
 * (#1676).
 *
 * Previously the shared `hoveredCorrelationId` was threaded into every chat
 * bubble / log row as a `dimmed` prop, so a single mouse-enter/leave flipped a
 * prop on (almost) every row and re-rendered the whole transcript — re-running
 * the expensive react-markdown + Shiki pipeline for every message on each
 * hover.
 *
 * Instead, each row carries a stable `data-cid="<correlationId>"` and its
 * scrolling container carries `data-hover-scope="<scope>"`. A single generated
 * stylesheet dims the rows whose `data-cid` doesn't match the hovered id. The
 * message list itself is memoized on its data (not on the hover state), so a
 * hover mutates one `<style>` node instead of reconciling the row tree.
 *
 * Pure string helpers only (no DOM) so they stay unit-testable under the
 * `admin-console-src` `node --test` job; the JSX panels are the thin adapters.
 */

export const HOVER_SCOPE_ATTR = 'data-hover-scope';
export const HOVER_ROW_ATTR = 'data-cid';
export const DEFAULT_DIM_OPACITY = 0.35;

/**
 * Escape a string for safe embedding inside a CSS double-quoted attribute-
 * selector value. Correlation ids are Matrix event ids (`$…`) or synthetic
 * `trigger:<id>:<ts>` strings, so backslashes / quotes / newlines must be
 * neutralised before they land in `[data-cid="…"]`.
 */
export function cssEscapeAttrValue(value) {
  return String(value).replace(/[\\"\n\r]/g, (ch) => {
    if (ch === '\n') return '\\A ';
    if (ch === '\r') return '\\D ';
    return `\\${ch}`;
  });
}

/**
 * The always-on rule for a hover scope: a transition so rows fade both into
 * and out of the dimmed state (the generated opacity rules below have no
 * transition of their own, and a removed rule can't animate).
 */
export function hoverBaseCss(scope) {
  const s = `[${HOVER_SCOPE_ATTR}="${cssEscapeAttrValue(scope)}"]`;
  return `${s} [${HOVER_ROW_ATTR}]{transition:opacity 0.15s;}`;
}

/**
 * The generated dim rules for the currently-hovered correlation id. Dims every
 * row in `scope`, then restores full opacity on the row(s) whose `data-cid`
 * matches. Returns '' when nothing is hovered (no dimming at all).
 */
export function hoverDimCss(scope, hoveredCid, dimOpacity = DEFAULT_DIM_OPACITY) {
  if (!hoveredCid) return '';
  const s = `[${HOVER_SCOPE_ATTR}="${cssEscapeAttrValue(scope)}"]`;
  const cid = cssEscapeAttrValue(hoveredCid);
  return (
    `${s} [${HOVER_ROW_ATTR}]{opacity:${dimOpacity};}` +
    `${s} [${HOVER_ROW_ATTR}="${cid}"]{opacity:1;}`
  );
}
