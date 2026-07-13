import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { HelpCircle } from 'lucide-react';

/**
 * Small inline "?" affordance that reveals a rich, multi-line explanation on
 * hover or keyboard focus. Companion to IconButton's fast tooltip, but built
 * for sentences rather than a short label: the popover wraps, has a readable
 * max width, and may carry an optional bold title line.
 *
 * Rendered into document.body via a portal with position: fixed (coordinates
 * from the trigger's bounding rect, clamped to the viewport) so it is never
 * clipped by an ancestor's overflow.
 */
export default function InfoTip({ title, text, size = 13 }) {
  const ref = useRef(null);
  const [pos, setPos] = useState(null);

  const show = () => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    const width = 300; // matches .eb-infotip-pop max-width
    const half = width / 2;
    const left = Math.max(half + 8, Math.min(r.left + r.width / 2, window.innerWidth - half - 8));
    setPos({ top: r.bottom + 6, left });
  };
  const hide = () => setPos(null);

  return (
    <span
      ref={ref}
      tabIndex={0}
      role="button"
      aria-label={title || 'Explanation'}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
      style={{
        display: 'inline-flex', alignItems: 'center', flexShrink: 0,
        color: 'var(--eb-text-muted)', cursor: 'help', outline: 'none',
      }}
    >
      <HelpCircle size={size} />
      {pos && createPortal(
        <span role="tooltip" className="eb-infotip-pop" style={{ top: pos.top, left: pos.left }}>
          {title && <span style={{ display: 'block', fontWeight: 600, marginBottom: 3, color: 'var(--eb-text-primary)' }}>{title}</span>}
          {text}
        </span>,
        document.body,
      )}
    </span>
  );
}
