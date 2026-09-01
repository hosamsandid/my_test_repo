import React, { useEffect, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from 'lucide-react';
import { isRowSelected, clampPopoverLeft } from './model-selector-view.js';

// One shared model-selector popover (#1670) used by BOTH the app-shell header
// assist-model selector and the Agent-Chat runtime model/provider selector, so
// the two read with one visual + interaction language while staying functionally
// separate (each surface keeps its own data source, persistence and capabilities
// via the props below). This component is presentation + interaction only — every
// surface-specific decision (what a click does, what the labels say, what the
// disabled reasons are) lives in the wrappers and their pure view modules.
//
// The popover is portaled into document.body with a viewport-clamped fixed
// position so it never clips inside a narrow column (the #1280 fix, generalised
// here so neither surface can regress it).

const POPOVER_WIDTH = 300;

// The popover is portaled to document.body, so its z-index competes with every
// other body-level layer — including modals (Modal.jsx / ConfirmDialog use 9999).
// Since #1805 this selector renders *inside* the Settings modal, so the menu must
// sit ABOVE that layer or it opens behind the modal (the #1280 body-portal escapes
// column clipping; this escapes the modal too). Kept above the 9999 modal tier.
const POPOVER_Z_INDEX = 10000;

const triggerBase = {
  background: 'none',
  border: '1px solid var(--eb-border-default)',
  borderRadius: 'var(--eb-radius-md)',
  color: 'var(--eb-text-secondary)',
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--eb-space-2)',
  padding: 'var(--eb-space-1) var(--eb-space-2)',
  fontFamily: 'inherit',
  fontSize: 'var(--eb-text-sm)',
  maxWidth: 260,
  transition: 'background var(--eb-transition-fast), color var(--eb-transition-fast)',
};

function ScopeBadge({ scope }) {
  return (
    <span style={{
      fontSize: 'var(--eb-text-xs)',
      color: 'var(--eb-text-muted)',
      border: '1px solid var(--eb-border-default)',
      borderRadius: 'var(--eb-radius-sm)',
      padding: '0 var(--eb-space-1)',
      textTransform: 'capitalize',
      flexShrink: 0,
    }}>
      {scope === 'system' ? 'System' : 'Team'}
    </span>
  );
}

// One provider group: name + scope badge, optional detail rows (auth/endpoint),
// then a model radio per catalogue entry (checkmark on the selection, "default"
// badge on the group default). No family/kind suffix on any label (AC9).
function ProviderGroup({ group, selection, selectable, onSelect }) {
  const models = Array.isArray(group.models) ? group.models : [];
  const details = Array.isArray(group.details) ? group.details : [];
  return (
    <div style={{ marginTop: 'var(--eb-space-2)' }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)',
        padding: 'var(--eb-space-1) var(--eb-space-2)',
        fontSize: 'var(--eb-text-sm)', fontWeight: 600, color: 'var(--eb-text-primary)',
      }}>
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {group.name || group.id}
        </span>
        <ScopeBadge scope={group.scope} />
      </div>
      {details.map((d, i) => (
        <div key={i} style={{
          display: 'flex', gap: 'var(--eb-space-2)',
          padding: '0 var(--eb-space-2)',
          fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)',
        }}>
          <span style={{ flexShrink: 0 }}>{d.label}</span>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.value}</span>
        </div>
      ))}
      {models.length === 0 && (
        <div style={{
          fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)',
          padding: 'var(--eb-space-1) var(--eb-space-2)',
        }}>
          {group.emptyText || 'No models configured'}
        </div>
      )}
      {models.map(m => {
        const selected = isRowSelected(selection, group.id, m.id);
        const rowStyle = {
          width: '100%',
          display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)',
          background: selected ? 'var(--eb-bg-hover)' : 'none',
          border: 'none',
          borderRadius: 'var(--eb-radius-sm)',
          color: 'var(--eb-text-primary)',
          textAlign: 'left',
          padding: 'var(--eb-space-1) var(--eb-space-2)',
          fontFamily: 'inherit',
          fontSize: 'var(--eb-text-sm)',
        };
        const content = (
          <>
            <Check size={14} style={{ flexShrink: 0, opacity: selected ? 1 : 0 }} />
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {m.label}
            </span>
            {m.meta && (
              <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', flexShrink: 0 }}>
                {m.meta}
              </span>
            )}
            {m.isDefault && (
              <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', flexShrink: 0 }}>
                default
              </span>
            )}
          </>
        );
        // Read-only surface (e.g. a viewer who can't manage the agent, AC6): the
        // rows still show the current binding but are not interactive.
        if (!selectable) {
          return (
            <div key={m.id} role="menuitemradio" aria-checked={selected} aria-disabled="true"
              style={{ ...rowStyle, cursor: 'default', opacity: 0.75 }}>
              {content}
            </div>
          );
        }
        return (
          <button
            key={m.id}
            type="button"
            role="menuitemradio"
            aria-checked={selected}
            data-model-row="1"
            onClick={() => onSelect(group.id, m.id)}
            style={{ ...rowStyle, cursor: 'pointer' }}
            onMouseEnter={e => { if (!selected) e.currentTarget.style.background = 'var(--eb-bg-hover)'; }}
            onMouseLeave={e => { if (!selected) e.currentTarget.style.background = 'none'; }}
          >
            {content}
          </button>
        );
      })}
    </div>
  );
}

export default function ModelSelectorPopover({
  // Trigger
  icon,
  label,
  title,
  ariaLabel = 'Model selector',
  tone = 'default',            // 'default' | 'attention' | 'override'
  disabled = false,            // whole control inert — the popover cannot open
  showOverrideDot = false,
  // Open state — controlled when `open` is passed (header error-reopen), else
  // internal (chat). Both report changes via onOpenChange.
  open,
  onOpenChange,
  // Popover body
  hint,
  notice,                      // ReactNode below the hint (read-only reasons etc.)
  groups = [],
  selection,
  selectable = true,           // false → read-only rows (AC6)
  onSelect,                    // (groupId, modelId, close) => void
  confirm,                     // ReactNode | (close) => ReactNode — replaces the list when present
  footer,                      // ReactNode | (close) => ReactNode — pinned below the list
  emptyGroupsText = 'No providers available.',
}) {
  const controlled = open !== undefined;
  const [internalOpen, setInternalOpen] = useState(false);
  const actualOpen = controlled ? open : internalOpen;

  const rootRef = useRef(null);
  const triggerRef = useRef(null);
  const popRef = useRef(null);
  const [pos, setPos] = useState(null);

  const setOpen = useCallback((v) => {
    if (!controlled) setInternalOpen(v);
    if (onOpenChange) onOpenChange(v);
  }, [controlled, onOpenChange]);
  const close = useCallback(() => setOpen(false), [setOpen]);

  // Position the portaled popover, clamped to the viewport (#1280).
  const place = useCallback(() => {
    const r = triggerRef.current?.getBoundingClientRect();
    if (!r) return;
    setPos({ top: r.bottom + 4, left: clampPopoverLeft(r, POPOVER_WIDTH, window.innerWidth) });
  }, []);

  useEffect(() => {
    if (!actualOpen) { setPos(null); return undefined; }
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [actualOpen, place]);

  // Outside-click / Escape close. The popover is portaled out of rootRef, so a
  // click inside it must also count as "inside" (popRef).
  useEffect(() => {
    if (!actualOpen) return undefined;
    const onDown = (e) => {
      const inRoot = rootRef.current && rootRef.current.contains(e.target);
      const inPop = popRef.current && popRef.current.contains(e.target);
      if (!inRoot && !inPop) close();
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { close(); return; }
      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && popRef.current) {
        const rows = Array.from(popRef.current.querySelectorAll('[data-model-row="1"]'));
        if (rows.length === 0) return;
        e.preventDefault();
        const idx = rows.indexOf(document.activeElement);
        const next = e.key === 'ArrowDown'
          ? (idx < 0 ? 0 : Math.min(idx + 1, rows.length - 1))
          : (idx < 0 ? rows.length - 1 : Math.max(idx - 1, 0));
        rows[next].focus();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [actualOpen, close]);

  const toneStyle = tone === 'attention'
    ? { border: '1px solid var(--eb-status-warning)', color: 'var(--eb-status-warning)', background: 'var(--eb-status-warning-bg)' }
    : tone === 'override'
      ? { color: 'var(--eb-accent-primary)' }
      : {};
  const plain = tone === 'default';

  const confirmNode = typeof confirm === 'function' ? confirm(close) : confirm;
  const footerNode = typeof footer === 'function' ? footer(close) : footer;

  return (
    <div ref={rootRef} style={{ position: 'relative' }}>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        onClick={() => setOpen(!actualOpen)}
        title={title}
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={actualOpen}
        style={{ ...triggerBase, ...toneStyle, opacity: disabled ? 0.6 : 1, cursor: disabled ? 'not-allowed' : 'pointer' }}
        onMouseEnter={e => { if (plain && !disabled) { e.currentTarget.style.background = 'var(--eb-bg-hover)'; e.currentTarget.style.color = 'var(--eb-text-primary)'; } }}
        onMouseLeave={e => { if (plain && !disabled) { e.currentTarget.style.background = 'none'; e.currentTarget.style.color = 'var(--eb-text-secondary)'; } }}
      >
        {icon}
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
        {showOverrideDot && (
          <span aria-hidden="true" style={{ flexShrink: 0, color: 'var(--eb-accent-primary)', fontWeight: 700 }}>•</span>
        )}
        <ChevronDown size={14} style={{ flexShrink: 0, opacity: 0.7 }} />
      </button>

      {actualOpen && pos && createPortal(
        <div
          ref={popRef}
          role="menu"
          style={{
            position: 'fixed', top: pos.top, left: pos.left, zIndex: POPOVER_Z_INDEX,
            width: POPOVER_WIDTH, boxSizing: 'border-box',
            maxHeight: '70vh', overflowY: 'auto',
            background: 'var(--eb-bg-elevated)',
            border: '1px solid var(--eb-border-default)',
            borderRadius: 'var(--eb-radius-md)',
            boxShadow: 'var(--eb-shadow-lg)',
            padding: 'var(--eb-space-2)',
          }}
        >
          {hint && (
            <div style={{
              fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)',
              padding: 'var(--eb-space-1) var(--eb-space-2)', lineHeight: 1.4,
            }}>
              {hint}
            </div>
          )}
          {notice && (
            <div style={{
              fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)',
              padding: 'var(--eb-space-1) var(--eb-space-2)', lineHeight: 1.4,
            }}>
              {notice}
            </div>
          )}
          {confirmNode ? (
            confirmNode
          ) : (
            <>
              {groups.length === 0 && (
                <div style={{
                  fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-muted)',
                  padding: 'var(--eb-space-2)',
                }}>
                  {emptyGroupsText}
                </div>
              )}
              {groups.map(g => (
                <ProviderGroup
                  key={g.id}
                  group={g}
                  selection={selection}
                  selectable={selectable}
                  onSelect={(gid, mid) => onSelect && onSelect(gid, mid, close)}
                />
              ))}
              {footerNode && (
                <div style={{
                  marginTop: 'var(--eb-space-2)',
                  paddingTop: 'var(--eb-space-2)',
                  borderTop: '1px solid var(--eb-border-default)',
                }}>
                  {footerNode}
                </div>
              )}
            </>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}
