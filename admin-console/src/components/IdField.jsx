import React from 'react';

/**
 * IdField — standard ID input paired with a "Reset to auto" affordance.
 *
 * Pair it with `useAutoDerivedId` from `hooks/useAutoDerivedId`:
 *
 *   const { handleNameChange, handleIdChange, resetAutoDerive, isAutoDerived } =
 *     useAutoDerivedId({ setName, setId, getName: () => name });
 *
 *   <FormInput label="Name *" value={name} onChange={handleNameChange} />
 *   <IdField
 *     value={id}
 *     onChange={handleIdChange}
 *     isAutoDerived={isAutoDerived()}
 *     onResetAuto={resetAutoDerive}
 *     placeholder="my-thing"
 *     helpText={<>Used as the URL slug. <strong>Cannot be changed after creation.</strong></>}
 *   />
 */
export default function IdField({
  value,
  onChange,
  isAutoDerived,
  onResetAuto,
  placeholder,
  helpText,
  disabled = false,
  label = 'ID',
  required = true,
}) {
  const inputStyle = {
    width: '100%',
    padding: 'var(--eb-space-2) var(--eb-space-3)',
    background: 'var(--eb-bg-elevated)',
    border: '1px solid var(--eb-border-default)',
    borderRadius: 'var(--eb-radius-md)',
    color: 'var(--eb-text-primary)',
    fontSize: 'var(--eb-text-sm)',
    fontFamily: 'var(--eb-font-mono)',
    outline: 'none',
    boxSizing: 'border-box',
    opacity: disabled ? 0.6 : 1,
    marginTop: 'var(--eb-space-1)',
  };

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 'var(--eb-space-2)' }}>
        <div style={{
          fontSize: 'var(--eb-text-sm)',
          fontWeight: 'var(--eb-font-medium)',
          color: 'var(--eb-text-secondary)',
        }}>
          {label}{required && <span style={{ color: 'var(--eb-status-error)', marginLeft: 2 }}>*</span>}
        </div>
        {!disabled && !isAutoDerived && onResetAuto && (
          <button
            type="button"
            onClick={onResetAuto}
            style={{
              background: 'none', border: 'none', padding: 0,
              color: 'var(--eb-accent-primary)', cursor: 'pointer',
              fontSize: 'var(--eb-text-xs)',
            }}
            title="Re-derive ID from Name"
          >
            Reset to auto
          </button>
        )}
      </div>
      <input
        value={value ?? ''}
        onChange={e => onChange?.(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        style={inputStyle}
      />
      {helpText && (
        <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', marginTop: 'var(--eb-space-1)' }}>
          {helpText}
        </div>
      )}
    </div>
  );
}
