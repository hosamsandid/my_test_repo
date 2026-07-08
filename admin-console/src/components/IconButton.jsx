import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * Shared icon-only action button: pairs the icon with a visible, fast
 * (no native-title hover delay) tooltip so the button's purpose is
 * recognizable without clicking or memorizing the icon.
 *
 * The tooltip is rendered into document.body via a portal and positioned
 * with `position: fixed` from the button's own bounding rect, so it can
 * never be clipped by an ancestor's `overflow` (e.g. DataTable's scroll
 * wrapper) the way an absolutely-positioned in-flow tooltip would be.
 */
export default function IconButton({ icon: Icon, label, onClick, danger, title, disabled, size = 13 }) {
  const tooltipText = title || label;
  const btnRef = useRef(null);
  const [coords, setCoords] = useState(null);

  const showTooltip = () => {
    if (!tooltipText || !btnRef.current) return;
    const rect = btnRef.current.getBoundingClientRect();
    setCoords({ top: rect.top - 4, left: rect.left + rect.width / 2 });
  };
  const hideTooltip = () => setCoords(null);

  return (
    <span className="eb-icon-btn-wrap">
      <button
        ref={btnRef}
        type="button"
        aria-label={label}
        onClick={onClick}
        disabled={disabled}
        onMouseEnter={showTooltip}
        onMouseLeave={hideTooltip}
        onFocus={showTooltip}
        onBlur={hideTooltip}
        style={{
          background: 'none',
          border: `1px solid ${danger ? 'var(--eb-status-error)' : 'var(--eb-border-default)'}`,
          borderRadius: 'var(--eb-radius-md)',
          cursor: disabled ? 'not-allowed' : 'pointer',
          color: danger ? 'var(--eb-status-error)' : 'var(--eb-text-secondary)',
          padding: '4px 8px', display: 'flex', alignItems: 'center', gap: 4,
          fontSize: 'var(--eb-text-xs)', fontFamily: 'inherit',
          opacity: disabled ? 0.5 : 1,
        }}
      >
        <Icon size={size} />
      </button>
      {coords && createPortal(
        <span
          role="tooltip"
          className="eb-icon-btn-tooltip"
          style={{ top: coords.top, left: coords.left }}
        >
          {tooltipText}
        </span>,
        document.body,
      )}
    </span>
  );
}
