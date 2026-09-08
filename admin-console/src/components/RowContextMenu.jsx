import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import {
  firstEnabledIndex,
  lastEnabledIndex,
  nextEnabledIndex,
  clampMenuPosition,
} from './row-context-menu-view.js';

/**
 * RowContextMenu — a left rail's row context menu (#1928, shared since #2053).
 *
 * Built for the Agent-Chat rail's lifecycle menu; the Flows left list renders
 * the same component over its own item descriptors, which is why this lives in
 * `components/` rather than in either page's folder. Nothing here is specific to
 * either rail: it takes `{items, anchor, label, onChoose, onClose}` and knows
 * only how to place, draw and drive a `role="menu"`.
 *
 * A sibling of `HeaderOverflowMenu` (whose pure keyboard helpers it reuses) with
 * two differences a rail forces:
 *
 *  - It is **portaled** and positioned in viewport coordinates. The rail is a
 *    scrolling container with `overflow: hidden` ancestors, so an absolutely
 *    positioned menu would be clipped and would scroll away from its row.
 *  - It is anchored at a **point**, not at a trigger box, so the same component
 *    serves the hover-revealed kebab and the row's right-click (open question 1:
 *    both — the kebab for discoverability, right-click for speed).
 *
 * Keyboard-accessible (#1928 AC9, #2053 AC8): opening focuses the first enabled item, ↑/↓ traverse
 * enabled items (wrapping, skipping disabled), Home/End jump to the ends, Escape
 * closes and hands focus back, and an outside click or a scroll closes it. Items
 * are the descriptors a pure builder returns (`buildAgentMenu`/`buildTeamMenu`
 * for the chat rail, `buildFlowsRailMenu` for the Flows rail), so what a caller
 * may do is decided in one pure place, not here.
 */
export default function RowContextMenu({ items = [], anchor, label, onChoose, onClose }) {
  const menuRef = useRef(null);
  const itemRefs = useRef([]);
  const [focusIdx, setFocusIdx] = useState(-1);
  // Rendered off-screen for one frame so the real size can be measured before it
  // is placed — a menu whose height is unknown cannot be flipped reliably.
  const [pos, setPos] = useState(null);

  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el || !anchor) return;
    const rect = el.getBoundingClientRect();
    setPos(clampMenuPosition({
      x: anchor.x,
      y: anchor.y,
      width: rect.width,
      height: rect.height,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    }));
  }, [anchor, items.length]);

  // Focus the first enabled item so the menu is operable from the keyboard the
  // moment it opens.
  useEffect(() => {
    const first = firstEnabledIndex(items);
    setFocusIdx(first);
    if (first < 0) return;
    const id = requestAnimationFrame(() => itemRefs.current[first]?.focus());
    return () => cancelAnimationFrame(id);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    function onDocPointerDown(e) {
      if (menuRef.current && !menuRef.current.contains(e.target)) onClose();
    }
    function onKeyDown(e) {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
    }
    // A scroll would leave the point-anchored menu behind; close instead of
    // chasing the row.
    function onScroll() { onClose(); }
    document.addEventListener('mousedown', onDocPointerDown);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      document.removeEventListener('mousedown', onDocPointerDown);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [onClose]);

  function moveFocus(next) {
    if (next < 0) return;
    setFocusIdx(next);
    itemRefs.current[next]?.focus();
  }

  function onMenuKeyDown(e) {
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); moveFocus(nextEnabledIndex(items, focusIdx, 1)); break;
      case 'ArrowUp':   e.preventDefault(); moveFocus(nextEnabledIndex(items, focusIdx, -1)); break;
      case 'Home':      e.preventDefault(); moveFocus(firstEnabledIndex(items)); break;
      case 'End':       e.preventDefault(); moveFocus(lastEnabledIndex(items)); break;
      default: break;
    }
  }

  function choose(item) {
    if (item.disabled) return;
    onClose();
    onChoose(item.key);
  }

  if (!anchor || items.length === 0) return null;

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      aria-label={label}
      onKeyDown={onMenuKeyDown}
      // Right-clicking inside the menu should not open a second one.
      onContextMenu={e => e.preventDefault()}
      style={{
        position: 'fixed',
        left: pos ? pos.left : -9999,
        top: pos ? pos.top : -9999,
        // Hidden until measured so it never flashes at the wrong place.
        visibility: pos ? 'visible' : 'hidden',
        minWidth: 190,
        background: 'var(--eb-bg-surface)',
        border: '1px solid var(--eb-border-default)',
        borderRadius: 'var(--eb-radius-md)',
        boxShadow: 'var(--eb-shadow-lg)',
        padding: 'var(--eb-space-1)',
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        zIndex: 1200,
      }}
    >
      {items.map((item, i) => (
        <button
          key={item.key}
          ref={el => { itemRefs.current[i] = el; }}
          role="menuitem"
          type="button"
          tabIndex={i === focusIdx ? 0 : -1}
          disabled={item.disabled}
          aria-disabled={item.disabled || undefined}
          title={item.title}
          onClick={() => choose(item)}
          style={itemStyle(item)}
          onMouseEnter={e => {
            if (item.disabled) return;
            e.currentTarget.style.background = 'var(--eb-bg-hover)';
          }}
          onMouseLeave={e => { e.currentTarget.style.background = 'none'; }}
        >
          {item.label}
        </button>
      ))}
    </div>,
    document.body,
  );
}

function itemStyle(item) {
  const color = item.disabled
    ? 'var(--eb-text-muted)'
    : item.danger ? 'var(--eb-status-error)' : 'var(--eb-text-secondary)';
  return {
    display: 'block',
    width: '100%',
    textAlign: 'left',
    background: 'none',
    border: 'none',
    // A group boundary is drawn on the *following* item (#1938 D1) rather than
    // pushed into `items` as a separator entry — a pseudo-item would be an
    // unfocusable hole in the flat list the keyboard helpers walk by index.
    ...(item.separated ? {
      borderTop: '1px solid var(--eb-border-default)',
      marginTop: 'var(--eb-space-1)',
    } : null),
    borderRadius: 'var(--eb-radius-sm)',
    color,
    cursor: item.disabled ? 'not-allowed' : 'pointer',
    opacity: item.disabled ? 0.6 : 1,
    fontFamily: 'inherit',
    fontSize: 'var(--eb-text-xs)',
    padding: 'var(--eb-space-2) var(--eb-space-3)',
    transition: 'background var(--eb-transition-fast)',
  };
}
