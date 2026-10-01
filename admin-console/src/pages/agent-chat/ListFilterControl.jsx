import React, { useEffect, useId, useRef, useState } from 'react';
import { ChevronDown, Search } from 'lucide-react';
import {
  QUICK_FILTERS,
  isEntryShown,
  searchEntries,
  selectionSummary,
} from './list-selection.js';

/**
 * The Agent Chat rail's multi-select team filter (#2740).
 *
 * A one-line button summarising the selection ("All agents", a team name, or
 * "N of M teams") that opens a panel with a name search, Select all / Deselect
 * all, the membership quick filters and one checkbox per entry. Every decision
 * — the entries, what a search lists, what a click does to the selection, the
 * summary — lives in the pure `list-selection.js`; this component only renders
 * it and hands the next selection to `onChange`.
 *
 * Keyboard (AC13): the button opens/closes the panel, the search field takes
 * focus on open, Tab / ArrowUp / ArrowDown move through the controls and the
 * entries, Space toggles a checkbox (native), Escape closes and returns focus
 * to the button.
 *
 * @param {object[]} props.entries      `selectionEntries(...)`
 * @param {{hidden:string[]}} props.selection
 * @param {(action:{type:string, key?:string, keys?:string[], shown?:boolean, filterId?:string})=>void} props.onAction
 * @param {string|null} props.quickFiltersDisabledReason  null = available
 */
export default function ListFilterControl({ entries, selection, onAction, quickFiltersDisabledReason = null }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const wrapperRef = useRef(null);
  const buttonRef = useRef(null);
  const panelRef = useRef(null);
  const searchRef = useRef(null);
  const panelId = useId();

  const listed = searchEntries(entries, query);
  const summary = selectionSummary(entries, selection);

  // Close on a click anywhere outside the control.
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  useEffect(() => {
    if (open) searchRef.current?.focus();
    else setQuery('');
  }, [open]);

  function close() {
    setOpen(false);
    buttonRef.current?.focus();
  }

  function onPanelKeyDown(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const focusables = [...(panelRef.current?.querySelectorAll('input, button:not([disabled])') || [])];
    const at = focusables.indexOf(document.activeElement);
    if (at === -1 || focusables.length === 0) return;
    e.preventDefault();
    const next = e.key === 'ArrowDown'
      ? focusables[(at + 1) % focusables.length]
      : focusables[(at - 1 + focusables.length) % focusables.length];
    next.focus();
  }

  const listedKeys = listed.map(e => e.key);

  return (
    <div ref={wrapperRef} style={{ minWidth: 0 }}>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen(v => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={`Filter agent list: ${summary}`}
        title="Filter agent list"
        style={triggerStyle}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
          {summary}
        </span>
        <ChevronDown size={12} aria-hidden="true" style={{ flexShrink: 0 }} />
      </button>

      {open && (
        <div
          ref={panelRef}
          id={panelId}
          role="dialog"
          aria-label="Filter agent list by team"
          onKeyDown={onPanelKeyDown}
          style={panelStyle}
        >
          <div style={{ position: 'relative' }}>
            <Search size={12} aria-hidden="true" style={searchIconStyle} />
            <input
              ref={searchRef}
              type="search"
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search teams"
              aria-label="Search teams"
              style={searchStyle}
            />
          </div>

          <div style={{ display: 'flex', gap: 'var(--eb-space-2)' }}>
            <button
              type="button"
              style={linkButtonStyle}
              onClick={() => onAction({ type: 'set', keys: listedKeys, shown: true })}
            >
              Select all
            </button>
            <button
              type="button"
              style={linkButtonStyle}
              onClick={() => onAction({ type: 'set', keys: listedKeys, shown: false })}
            >
              Deselect all
            </button>
          </div>

          <div role="group" aria-label="Quick filters" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span style={sectionLabelStyle}>Quick filters</span>
            {QUICK_FILTERS.map(q => (
              <button
                key={q.id}
                type="button"
                disabled={!!quickFiltersDisabledReason}
                title={quickFiltersDisabledReason || 'Replaces the current selection'}
                onClick={() => onAction({ type: 'quick', filterId: q.id })}
                style={{
                  ...quickButtonStyle,
                  cursor: quickFiltersDisabledReason ? 'not-allowed' : 'pointer',
                  opacity: quickFiltersDisabledReason ? 0.5 : 1,
                }}
              >
                {q.label}
              </button>
            ))}
          </div>

          <div role="group" aria-label="Teams" style={listStyle}>
            {listed.length === 0 && (
              <div style={{ padding: 'var(--eb-space-2)', color: 'var(--eb-text-muted)', fontSize: 'var(--eb-text-xs)' }}>
                {entries.length === 0 ? 'No teams to filter.' : 'No teams match your search.'}
              </div>
            )}
            {listed.map(entry => (
              <label key={entry.key} style={entryStyle}>
                <input
                  type="checkbox"
                  checked={isEntryShown(selection, entry.key)}
                  onChange={() => onAction({ type: 'toggle', key: entry.key })}
                  aria-label={entry.subtitle ? `${entry.label} (${entry.subtitle})` : entry.label}
                  style={{ margin: 0, flexShrink: 0 }}
                />
                <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                  <span style={ellipsis}>{entry.label}</span>
                  {entry.subtitle && (
                    <span style={{ ...ellipsis, color: 'var(--eb-text-muted)', fontSize: 11 }} title={entry.subtitle}>
                      {entry.subtitle}
                    </span>
                  )}
                </span>
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

const ellipsis = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };

const triggerStyle = {
  width: '100%',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 'var(--eb-space-1)',
  padding: '4px 6px',
  fontSize: 'var(--eb-text-xs)',
  background: 'var(--eb-bg-app)',
  color: 'var(--eb-text-primary)',
  border: '1px solid var(--eb-border-default)',
  borderRadius: 'var(--eb-radius-sm)',
  fontFamily: 'inherit',
  cursor: 'pointer',
  textAlign: 'left',
};

// Anchored to the rail header row (which is `position: relative`), so the panel
// spans the header's width rather than only the narrow trigger.
const panelStyle = {
  position: 'absolute',
  top: '100%',
  left: 'var(--eb-space-2)',
  right: 'var(--eb-space-2)',
  zIndex: 20,
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--eb-space-2)',
  padding: 'var(--eb-space-2)',
  background: 'var(--eb-bg-elevated)',
  border: '1px solid var(--eb-border-default)',
  borderRadius: 'var(--eb-radius-sm)',
  boxShadow: '0 6px 18px rgba(0, 0, 0, 0.25)',
  fontSize: 'var(--eb-text-xs)',
  color: 'var(--eb-text-primary)',
};

const searchIconStyle = {
  position: 'absolute',
  left: 6,
  top: '50%',
  transform: 'translateY(-50%)',
  color: 'var(--eb-text-muted)',
  pointerEvents: 'none',
};

const searchStyle = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '4px 6px 4px 22px',
  fontSize: 'var(--eb-text-xs)',
  background: 'var(--eb-bg-app)',
  color: 'var(--eb-text-primary)',
  border: '1px solid var(--eb-border-default)',
  borderRadius: 'var(--eb-radius-sm)',
  fontFamily: 'inherit',
};

const linkButtonStyle = {
  background: 'none',
  border: 'none',
  padding: 0,
  color: 'var(--eb-accent-primary)',
  fontSize: 'var(--eb-text-xs)',
  fontFamily: 'inherit',
  textDecoration: 'underline',
  cursor: 'pointer',
};

const sectionLabelStyle = {
  color: 'var(--eb-text-muted)',
  fontSize: 11,
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
};

const quickButtonStyle = {
  background: 'none',
  border: 'none',
  padding: '2px 0',
  color: 'var(--eb-text-primary)',
  fontSize: 'var(--eb-text-xs)',
  fontFamily: 'inherit',
  textAlign: 'left',
};

// The list scrolls on its own so the panel never grows past the rail with many
// teams (edge case).
const listStyle = {
  display: 'flex',
  flexDirection: 'column',
  maxHeight: 280,
  overflowY: 'auto',
  borderTop: '1px solid var(--eb-border-default)',
  paddingTop: 'var(--eb-space-1)',
};

const entryStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--eb-space-2)',
  padding: '3px 2px',
  cursor: 'pointer',
  minWidth: 0,
};
