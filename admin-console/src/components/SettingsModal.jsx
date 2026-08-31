import React, { useState, useRef } from 'react';
import Modal from './Modal.jsx';
import {
  SETTINGS_SECTIONS, defaultSectionId, resolveSectionId, adjacentSectionId, sectionById,
} from './settings-modal-view.js';

/**
 * SettingsModal — the user Settings dialog (#1802, UX-1 foundation).
 *
 * A sectioned shell (Behavior · Model · Display) ready to receive per-user
 * preferences — the individual settings are migrated in by UX-3 / UX-4 / UX-8,
 * so every section renders an empty placeholder for now. The overlay behaviour
 * (centred, focus-trapped, Esc / ✕ / backdrop dismiss) is owned by <Modal>.
 */
export default function SettingsModal({ open, onClose }) {
  const [activeId, setActiveId] = useState(defaultSectionId());
  const tabRefs = useRef({});

  const active = sectionById(resolveSectionId(activeId));

  // Arrow keys move between tabs on the vertical rail (roving focus).
  function onTabKeyDown(e) {
    let dir = 0;
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') dir = 1;
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') dir = -1;
    else return;
    e.preventDefault();
    const nextId = adjacentSectionId(active.id, dir);
    setActiveId(nextId);
    // Keep DOM focus on the newly-selected tab.
    requestAnimationFrame(() => tabRefs.current[nextId]?.focus());
  }

  return (
    <Modal open={open} onClose={onClose} title="Settings" maxWidth={720}>
      <div style={layoutStyle}>
        {/* Section rail */}
        <div
          role="tablist"
          aria-orientation="vertical"
          aria-label="Settings sections"
          style={railStyle}
        >
          {SETTINGS_SECTIONS.map((s) => {
            const selected = s.id === active.id;
            return (
              <button
                key={s.id}
                ref={(el) => { tabRefs.current[s.id] = el; }}
                role="tab"
                type="button"
                id={`settings-tab-${s.id}`}
                aria-selected={selected}
                aria-controls={`settings-panel-${s.id}`}
                tabIndex={selected ? 0 : -1}
                onClick={() => setActiveId(s.id)}
                onKeyDown={onTabKeyDown}
                style={{
                  ...tabStyle,
                  background: selected ? 'var(--eb-bg-selected)' : 'none',
                  color: selected ? 'var(--eb-text-primary)' : 'var(--eb-text-secondary)',
                  fontWeight: selected ? 'var(--eb-font-medium)' : 'var(--eb-font-normal)',
                }}
                onMouseEnter={(e) => { if (!selected) e.currentTarget.style.background = 'var(--eb-bg-hover)'; }}
                onMouseLeave={(e) => { if (!selected) e.currentTarget.style.background = 'none'; }}
              >
                {s.label}
              </button>
            );
          })}
        </div>

        {/* Section content pane */}
        <div
          role="tabpanel"
          id={`settings-panel-${active.id}`}
          aria-labelledby={`settings-tab-${active.id}`}
          style={paneStyle}
        >
          <h3 style={paneTitleStyle}>{active.label}</h3>
          <p style={paneBlurbStyle}>{active.blurb}</p>
          <p style={placeholderStyle}>
            Settings for this section will appear here.
          </p>
        </div>
      </div>
    </Modal>
  );
}

const layoutStyle = {
  display: 'flex',
  alignItems: 'stretch',
  minHeight: 260,
};

const railStyle = {
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--eb-space-1)',
  padding: 'var(--eb-space-4)',
  borderRight: '1px solid var(--eb-border-default)',
  flexShrink: 0,
  minWidth: 160,
};

const tabStyle = {
  textAlign: 'left',
  border: 'none',
  borderRadius: 'var(--eb-radius-md)',
  padding: 'var(--eb-space-2) var(--eb-space-3)',
  fontSize: 'var(--eb-text-sm)',
  fontFamily: 'inherit',
  cursor: 'pointer',
  transition: 'background var(--eb-transition-fast), color var(--eb-transition-fast)',
};

const paneStyle = {
  flex: 1,
  minWidth: 0,
  padding: 'var(--eb-space-5)',
};

const paneTitleStyle = {
  margin: 0,
  fontSize: 'var(--eb-text-md)',
  fontWeight: 'var(--eb-font-semibold)',
  color: 'var(--eb-text-primary)',
};

const paneBlurbStyle = {
  margin: 'var(--eb-space-2) 0 0',
  fontSize: 'var(--eb-text-sm)',
  color: 'var(--eb-text-secondary)',
  lineHeight: 1.5,
};

const placeholderStyle = {
  margin: 'var(--eb-space-5) 0 0',
  fontSize: 'var(--eb-text-sm)',
  color: 'var(--eb-text-muted)',
  fontStyle: 'italic',
};
