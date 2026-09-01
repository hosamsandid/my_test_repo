import Tooltip from './Tooltip.jsx';

/**
 * Shared icon-only action button: pairs the icon with a visible, fast
 * (no native-title hover delay) tooltip so the button's purpose is
 * recognizable without clicking or memorizing the icon.
 *
 * The tooltip is the shared, dark/inverted `Tooltip` component (#1850): it is
 * portaled into document.body with `position: fixed` (so it is never clipped by
 * an ancestor's `overflow`, e.g. DataTable's scroll wrapper) and reads
 * identically to the Agent-Chat composer tooltip. Hover/focus handling lives on
 * the wrapper span, so even a disabled button still shows its tooltip.
 */
export default function IconButton({ icon: Icon, label, onClick, danger, title, disabled, size = 13 }) {
  const tooltipText = title || label;

  return (
    <Tooltip label={tooltipText} wrapClassName="eb-icon-btn-wrap">
      <button
        type="button"
        aria-label={label}
        onClick={onClick}
        disabled={disabled}
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
    </Tooltip>
  );
}
