/**
 * Shared icon-only action button: pairs the icon with a visible, fast
 * (no native-title hover delay) tooltip so the button's purpose is
 * recognizable without clicking or memorizing the icon.
 */
export default function IconButton({ icon: Icon, label, onClick, danger, title, disabled, size = 13 }) {
  const tooltipText = title || label;
  return (
    <span className="eb-icon-btn-wrap">
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
      {tooltipText && <span className="eb-icon-btn-tooltip" role="tooltip">{tooltipText}</span>}
    </span>
  );
}
