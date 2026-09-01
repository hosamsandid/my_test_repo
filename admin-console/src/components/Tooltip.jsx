import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  resolveTooltipPlacement,
  clampTooltipLeft,
  tooltipAnchorTop,
} from './tooltip-position.js';

/**
 * Canonical short-label hover tooltip for the whole admin console (#1850).
 *
 * This is the single documented standard for the "hover an icon/control to
 * learn what it does" affordance. It replaces the local `ButtonTooltip` in the
 * Agent-Chat composer, backs the shared `IconButton`, and is what new code and
 * per-area `title=`→tooltip migrations should use.
 *
 * Behaviour (see AC list in issue #1850):
 *  - Dark/inverted look via the `.eb-tooltip` class (tokens.css), readable in
 *    all three themes (admin-dark / admin-light / high-contrast).
 *  - Appears instantly — no show delay — on mouse hover AND keyboard focus, and
 *    dismisses on mouse-leave / blur. Handlers sit on the wrapping span so the
 *    tooltip still explains *disabled* buttons (a disabled <button> swallows its
 *    own pointer/focus events, but the wrapper still receives them).
 *  - Portaled into document.body with `position: fixed`, so it is never clipped
 *    by an ancestor's `overflow` (e.g. a horizontally-scrolling DataTable).
 *  - Positioned above the trigger by default, flipping below and clamping
 *    horizontally so it always stays inside the viewport (pure math in
 *    tooltip-position.js).
 *
 * Usage:
 *   <Tooltip label="Run a loop — repeats until the goal is met">
 *     <button …><Repeat /></button>
 *   </Tooltip>
 *
 * The wrapped control keeps its own accessible name (`aria-label` / text): the
 * tooltip is purely presentational and does not replace labelling.
 *
 * @param {object}  props
 * @param {import('react').ReactNode} props.label     tooltip text (falsy → no tooltip)
 * @param {import('react').ReactNode} props.children  the control to wrap
 * @param {string}  [props.wrapClassName]  className for the wrapper span
 * @param {object}  [props.wrapStyle]      style override for the wrapper span
 * @param {boolean} [props.wrap]           allow multi-line wrapping for long labels
 */
export default function Tooltip({ label, children, wrapClassName, wrapStyle, wrap = false }) {
  const wrapRef = useRef(null);
  const tipRef = useRef(null);
  // The trigger rect captured on show; null means hidden.
  const [rect, setRect] = useState(null);
  // Final resolved position; null on the first (hidden, measuring) render.
  const [pos, setPos] = useState(null);

  const show = () => {
    if (!label || !wrapRef.current) return;
    setRect(wrapRef.current.getBoundingClientRect());
  };
  const hide = () => {
    setRect(null);
    setPos(null);
  };

  // After the tooltip mounts (hidden), measure it and compute a clamped,
  // possibly-flipped position. useLayoutEffect runs before paint, so the user
  // never sees the pre-clamp position.
  useLayoutEffect(() => {
    if (!rect || !tipRef.current) return;
    const tip = tipRef.current.getBoundingClientRect();
    const placement = resolveTooltipPlacement(rect, tip.height, window.innerHeight);
    const left = clampTooltipLeft(rect.left + rect.width / 2, tip.width, window.innerWidth);
    const top = tooltipAnchorTop(rect, placement);
    setPos({ left, top, placement });
  }, [rect]);

  const style = { position: 'relative', display: 'inline-flex', flexShrink: 0, ...wrapStyle };

  return (
    <span
      ref={wrapRef}
      className={wrapClassName}
      style={style}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      {children}
      {rect &&
        createPortal(
          <span
            ref={tipRef}
            role="tooltip"
            className={
              'eb-tooltip' +
              (pos?.placement === 'bottom' ? ' eb-tooltip--bottom' : '') +
              (wrap ? ' eb-tooltip--wrap' : '')
            }
            style={
              pos
                ? { left: pos.left, top: pos.top }
                : // First render: place at the trigger centre but hidden while we
                  // measure the tooltip's real size for clamping.
                  { left: rect.left + rect.width / 2, top: rect.top - 6, visibility: 'hidden' }
            }
          >
            {label}
          </span>,
          document.body,
        )}
    </span>
  );
}
