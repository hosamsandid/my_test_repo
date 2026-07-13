import React from 'react';

export default function SkillPicker({ allSkills, selected, onChange }) {
  const toggle = (name) => {
    if (selected.includes(name)) onChange(selected.filter(s => s !== name));
    else onChange([...selected, name]);
  };

  if (allSkills.length === 0) {
    return (
      <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-muted)' }}>
        No skills in the pool. Create skills on the Skills page or promote them from the Knowledge page.
      </div>
    );
  }

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      gap: 'var(--eb-space-1)',
      maxHeight: 240,
      overflowY: 'auto',
      border: '1px solid var(--eb-border-default)',
      borderRadius: 'var(--eb-radius-md)',
      padding: 'var(--eb-space-2)',
      background: 'var(--eb-bg-elevated)',
    }}>
      {allSkills.map(name => (
        <label key={name} style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--eb-space-2)',
          padding: 'var(--eb-space-1) var(--eb-space-2)',
          borderRadius: 'var(--eb-radius-sm)',
          cursor: 'pointer',
          fontSize: 'var(--eb-text-sm)',
        }}
        onMouseEnter={e => e.currentTarget.style.background = 'var(--eb-bg-hover)'}
        onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
        >
          <input
            type="checkbox"
            checked={selected.includes(name)}
            onChange={() => toggle(name)}
          />
          <span style={{ fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-xs)' }}>
            {name}
          </span>
        </label>
      ))}
    </div>
  );
}
