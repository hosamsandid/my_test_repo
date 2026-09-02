import React, { useState, useRef, useEffect } from 'react';
import { MoreHorizontal, Loader2 } from 'lucide-react';
import {
  firstEnabledIndex,
  lastEnabledIndex,
  nextEnabledIndex,
} from './header-overflow-menu.js';

/**
 * HeaderOverflowMenu — the agent-header `…` overflow menu (#1810).
 *
 * Groups the rare, higher-risk session actions behind a single `…` button so
 * they sit apart from the primary session action that stays directly visible on
 * the toolbar — Reset Session since #1922, which promoted it out of this menu
 * and left Clear History as the current sole item (the menu stays as the home
 * for further actions). Each action keeps its own disabled/guard state and busy
 * spinner; the menu only relocates the trigger — clicking an item runs the exact
 * same handler as before (so the Clear History confirmation dialog is unchanged).
 *
 * Keyboard-accessible (AC4): the trigger is a real button (Enter/Space toggles),
 * opening moves focus to the first enabled item, ↑/↓ traverse enabled items
 * (wrapping, skipping disabled), Home/End jump to the ends, Escape closes and
 * restores focus to the trigger, and an outside click closes it.
 *
 * Props:
 *   items — [{ key, label, icon, onClick, disabled?, busy?, title? }]
 *   buttonStyle — (disabled) => styleObject, reused from the toolbar so the
 *                 trigger matches the sibling buttons visually
 */
export default function HeaderOverflowMenu({ items = [], buttonStyle }) {
  const [open, setOpen] = useState(false);
  const [focusIdx, setFocusIdx] = useState(-1);
  const rootRef = useRef(null);
  const triggerRef = useRef(null);
  const itemRefs = useRef([]);
  itemRefs.current = [];

  // Close on outside click or Escape; Escape returns focus to the trigger.
  useEffect(() => {
    if (!open) return;
    function onDocClick(e) {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
    }
    function onKeyDown(e) {
      if (e.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  // On open, focus the first enabled item (keyboard users).
  useEffect(() => {
    if (!open) { setFocusIdx(-1); return; }
    const first = firstEnabledIndex(items);
    setFocusIdx(first);
    if (first >= 0) {
      const id = requestAnimationFrame(() => itemRefs.current[first]?.focus());
      return () => cancelAnimationFrame(id);
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  function moveFocus(next) {
    if (next < 0) return;
    setFocusIdx(next);
    itemRefs.current[next]?.focus();
  }

  function onMenuKeyDown(e) {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        moveFocus(nextEnabledIndex(items, focusIdx, 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        moveFocus(nextEnabledIndex(items, focusIdx, -1));
        break;
      case 'Home':
        e.preventDefault();
        moveFocus(firstEnabledIndex(items));
        break;
      case 'End':
        e.preventDefault();
        moveFocus(lastEnabledIndex(items));
        break;
      default:
        break;
    }
  }

  function choose(item) {
    if (item.disabled) return;
    setOpen(false);
    // Restore focus to the trigger before running the action so a dialog opened
    // by the handler (Clear History's confirm) treats the trigger as its
    // focus-restore target.
    triggerRef.current?.focus();
    item.onClick?.();
  }

  const triggerDisabledStyle = buttonStyle ? buttonStyle(false) : {};

  return (
    <div ref={rootRef} style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="More session actions"
        title="More session actions"
        style={{
          ...triggerDisabledStyle,
          ...(open ? { background: 'var(--eb-bg-selected)', color: 'var(--eb-text-primary)' } : null),
        }}
      >
        <MoreHorizontal size={13} />
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Session actions"
          onKeyDown={onMenuKeyDown}
          style={menuStyle}
        >
          {items.map((item, i) => (
            <button
              key={item.key}
              ref={(el) => { itemRefs.current[i] = el; }}
              role="menuitem"
              type="button"
              tabIndex={i === focusIdx ? 0 : -1}
              disabled={item.disabled}
              aria-disabled={item.disabled || undefined}
              title={item.title}
              onClick={() => choose(item)}
              style={menuItemStyle(item.disabled)}
              onMouseEnter={(e) => {
                if (item.disabled) return;
                e.currentTarget.style.background = 'var(--eb-bg-hover)';
                e.currentTarget.style.color = 'var(--eb-text-primary)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'none';
                e.currentTarget.style.color = item.disabled
                  ? 'var(--eb-text-muted)' : 'var(--eb-text-secondary)';
              }}
            >
              <span style={{ display: 'inline-flex', alignItems: 'center', width: 13 }}>
                {item.busy
                  ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} />
                  : item.icon}
              </span>
              <span>{item.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const menuStyle = {
  position: 'absolute',
  top: 'calc(100% + var(--eb-space-1))',
  left: 0,
  minWidth: 170,
  background: 'var(--eb-bg-surface)',
  border: '1px solid var(--eb-border-default)',
  borderRadius: 'var(--eb-radius-md)',
  boxShadow: 'var(--eb-shadow-lg)',
  padding: 'var(--eb-space-1)',
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  zIndex: 1000,
};

function menuItemStyle(isDisabled) {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--eb-space-2)',
    width: '100%',
    textAlign: 'left',
    background: 'none',
    border: 'none',
    borderRadius: 'var(--eb-radius-sm)',
    color: isDisabled ? 'var(--eb-text-muted)' : 'var(--eb-text-secondary)',
    cursor: isDisabled ? 'not-allowed' : 'pointer',
    opacity: isDisabled ? 0.6 : 1,
    fontFamily: 'inherit',
    fontSize: 'var(--eb-text-xs)',
    padding: 'var(--eb-space-2) var(--eb-space-3)',
    transition: 'background var(--eb-transition-fast), color var(--eb-transition-fast)',
  };
}
