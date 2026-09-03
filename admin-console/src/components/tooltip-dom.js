/**
 * tooltip-dom.js — the imperative twin of Tooltip.jsx (#1999, open question 1).
 *
 * The Flow-Editor canvas control row (Fit / Expand All / Collapse All / the
 * flow-direction toggle / Archived / Stages) is built with raw
 * `document.createElement('button')` inside `flow-graph-render.js`, a ~2800-line
 * imperative renderer that owns its own DOM. The React `<Tooltip>` cannot wrap
 * those nodes, and refactoring the row to React just to get a hover hint is a
 * far larger change than the affordance is worth — so this helper gives those
 * buttons the *same* tooltip instead of leaving them on the slow grey native
 * `title=`.
 *
 * "The same" is meant literally, and that is the whole point of this file:
 *   - identical look: it renders a `.eb-tooltip` span (tokens.css), so all three
 *     themes and the `--wrap` / `--bottom` modifiers come for free;
 *   - identical placement: it calls the very same pure geometry module
 *     (`tooltip-position.js`) the React component uses, so flipping and
 *     viewport clamping behave the same and there is no second copy of the math;
 *   - identical portaling: the span is appended to `document.body` with
 *     `position: fixed`, so the canvas's `overflow: hidden` viewport can never
 *     clip it;
 *   - identical triggers: shown instantly on `mouseenter` AND `focus`, so the
 *     label is reachable by keyboard.
 *
 * This module is deliberately the *only* DOM-touching part: everything with a
 * decision in it (which label, when to wrap) lives in the pure, node:test-
 * covered `tooltip-position.js` / `tooltip-wrap.js` / `flow-canvas-hints.js`
 * per the #651 convention. Keep it that way — logic added here is logic that
 * cannot be tested, because the admin console has no DOM test renderer.
 */
import {
  resolveTooltipPlacement,
  clampTooltipLeft,
  tooltipAnchorTop,
} from './tooltip-position.js';
import { shouldWrapTooltip } from './tooltip-wrap.js';

/**
 * Give an existing DOM element the shared dark hover tooltip.
 *
 * The label may change over the element's life (the canvas toggles relabel
 * themselves — "Flow ↓" ⇄ "Flow →", "Archived" on/off), hence `setLabel`.
 *
 * @param {HTMLElement} el     the trigger (typically a <button>)
 * @param {string} label       initial tooltip text ('' → no tooltip)
 * @returns {{setLabel(next: string): void, destroy(): void}} handle — the caller
 *   MUST call `destroy()` when it tears its DOM down, otherwise a tooltip that
 *   happens to be open outlives the button it described (it lives in body, not
 *   in the removed subtree).
 */
export function attachTooltip(el, label) {
  let text = label || '';
  let tip = null;

  const hide = () => {
    if (tip) {
      tip.remove();
      tip = null;
    }
  };

  const show = () => {
    if (!text || tip || !el.isConnected) return;
    const rect = el.getBoundingClientRect();

    tip = document.createElement('span');
    tip.setAttribute('role', 'tooltip');
    tip.className = 'eb-tooltip' + (shouldWrapTooltip(text) ? ' eb-tooltip--wrap' : '');
    tip.textContent = text;
    // Measure first, position second — mirrors Tooltip.jsx's hidden first
    // render, so the user never sees the pre-clamp position.
    tip.style.visibility = 'hidden';
    tip.style.left = `${rect.left + rect.width / 2}px`;
    tip.style.top = `${rect.top - 6}px`;
    document.body.appendChild(tip);

    const tipRect = tip.getBoundingClientRect();
    const placement = resolveTooltipPlacement(rect, tipRect.height, window.innerHeight);
    tip.style.left = `${clampTooltipLeft(rect.left + rect.width / 2, tipRect.width, window.innerWidth)}px`;
    tip.style.top = `${tooltipAnchorTop(rect, placement)}px`;
    if (placement === 'bottom') tip.classList.add('eb-tooltip--bottom');
    tip.style.visibility = '';
  };

  el.addEventListener('mouseenter', show);
  el.addEventListener('mouseleave', hide);
  el.addEventListener('focus', show);
  el.addEventListener('blur', hide);
  // A toggle relabels itself on click; the stale tooltip would sit there
  // contradicting the button underneath it, so drop it and let the next hover
  // re-show the new text.
  el.addEventListener('click', hide);

  return {
    setLabel(next) {
      text = next || '';
      // The open tooltip (if any) still shows the previous text.
      hide();
    },
    destroy() {
      hide();
      el.removeEventListener('mouseenter', show);
      el.removeEventListener('mouseleave', hide);
      el.removeEventListener('focus', show);
      el.removeEventListener('blur', hide);
      el.removeEventListener('click', hide);
    },
  };
}
