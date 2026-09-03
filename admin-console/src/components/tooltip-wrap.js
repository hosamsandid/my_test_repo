/**
 * tooltip-wrap.js — one rule for when a tooltip label needs multi-line wrapping.
 *
 * `.eb-tooltip` is `white-space: nowrap` by default (short labels read best on
 * one line) with `max-width: min(320px, 100vw - 16px)`. A label longer than the
 * box therefore *overflows* it instead of wrapping, which is exactly the
 * "tooltip runs off the viewport" failure #1999 AC8 forbids. Both the React
 * `Tooltip` (`wrap` prop) and the imperative `attachTooltip` opt into wrapping,
 * so the decision belongs in one shared, testable place rather than being
 * eyeballed per call site.
 *
 * The threshold is a character count, not a measurement: the tooltip font is
 * `--eb-text-xs` (~11px), so ~40 characters is comfortably inside the 320px box
 * on every theme, and anything longer is at risk. Erring on the side of
 * wrapping is safe — a wrapped short label still renders on one line, because
 * the box only grows to its content.
 *
 * Pure and DOM-free per the #651 convention.
 */

/** Labels longer than this (in characters) are rendered multi-line. */
export const TOOLTIP_WRAP_CHARS = 40;

/**
 * Whether a tooltip label should be rendered with multi-line wrapping.
 *
 * @param {unknown} label  the tooltip text (non-strings — e.g. a ReactNode —
 *   are never auto-wrapped; those call sites pass `wrap` explicitly)
 * @param {number} [max]   character threshold
 * @returns {boolean}
 */
export function shouldWrapTooltip(label, max = TOOLTIP_WRAP_CHARS) {
  return typeof label === 'string' && label.length > max;
}
