import React, { useState, useRef, useEffect } from 'react';
import { UserCircle, Settings, LogOut, ChevronDown } from 'lucide-react';

/**
 * AccountMenu — the header account control (#1802).
 *
 * Replaces the bare username element that silently doubled as the logout button.
 * The trigger is anchored on the user and opens a small menu containing an
 * explicit Settings item (opens the Settings modal) and a distinct, clearly
 * labelled Logout item — so logging out is now a deliberate, named action.
 *
 * Props:
 *   username      — string, the signed-in user's name (shown on the trigger)
 *   onOpenSettings — () => void, opens the Settings modal
 *   onLogout      — () => void, the existing auth logout
 */
export default function AccountMenu({ username, onOpenSettings, onLogout }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const triggerRef = useRef(null);
  const firstItemRef = useRef(null);

  // Close on an outside click or Escape; on Escape return focus to the trigger.
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

  // Move focus to the first menu item when the menu opens (keyboard users).
  useEffect(() => {
    if (open) {
      const id = requestAnimationFrame(() => firstItemRef.current?.focus());
      return () => cancelAnimationFrame(id);
    }
  }, [open]);

  function choose(action) {
    setOpen(false);
    // Return focus to the trigger before running the action, so a modal opened
    // from here (Settings) captures the trigger as its focus-restore target and
    // returns focus to the account menu when it closes (AC4).
    triggerRef.current?.focus();
    action?.();
  }

  return (
    <div ref={rootRef} style={{ position: 'relative' }}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Account menu"
        title={username ? `Account: ${username}` : 'Account'}
        style={{
          ...triggerStyle,
          background: open ? 'var(--eb-bg-selected)' : 'none',
          color: open ? 'var(--eb-text-primary)' : 'var(--eb-text-secondary)',
        }}
        onMouseEnter={(e) => { if (!open) { e.currentTarget.style.background = 'var(--eb-bg-hover)'; e.currentTarget.style.color = 'var(--eb-text-primary)'; } }}
        onMouseLeave={(e) => { if (!open) { e.currentTarget.style.background = 'none'; e.currentTarget.style.color = 'var(--eb-text-secondary)'; } }}
      >
        <UserCircle size={16} />
        {username && (
          <span style={{ maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {username}
          </span>
        )}
        <ChevronDown size={14} style={{ opacity: 0.7 }} />
      </button>

      {open && (
        <div role="menu" aria-label="Account" style={menuStyle}>
          <MenuItem
            innerRef={firstItemRef}
            icon={<Settings size={15} />}
            label="Settings"
            onClick={() => choose(onOpenSettings)}
          />
          <MenuItem
            icon={<LogOut size={15} />}
            label="Logout"
            onClick={() => choose(onLogout)}
          />
        </div>
      )}
    </div>
  );
}

function MenuItem({ innerRef, icon, label, onClick }) {
  return (
    <button
      ref={innerRef}
      role="menuitem"
      type="button"
      onClick={onClick}
      style={menuItemStyle}
      onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--eb-bg-hover)'; e.currentTarget.style.color = 'var(--eb-text-primary)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; e.currentTarget.style.color = 'var(--eb-text-secondary)'; }}
    >
      <span style={{ display: 'inline-flex', alignItems: 'center', width: 15 }}>{icon}</span>
      <span>{label}</span>
    </button>
  );
}

const triggerStyle = {
  border: '1px solid var(--eb-border-default)',
  borderRadius: 'var(--eb-radius-md)',
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--eb-space-2)',
  padding: 'var(--eb-space-1) var(--eb-space-2)',
  fontFamily: 'inherit',
  fontSize: 'var(--eb-text-sm)',
  transition: 'background var(--eb-transition-fast), color var(--eb-transition-fast)',
};

const menuStyle = {
  position: 'absolute',
  top: 'calc(100% + var(--eb-space-2))',
  right: 0,
  minWidth: 180,
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

const menuItemStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--eb-space-2)',
  width: '100%',
  textAlign: 'left',
  background: 'none',
  border: 'none',
  borderRadius: 'var(--eb-radius-sm)',
  color: 'var(--eb-text-secondary)',
  cursor: 'pointer',
  fontFamily: 'inherit',
  fontSize: 'var(--eb-text-sm)',
  padding: 'var(--eb-space-2) var(--eb-space-3)',
  transition: 'background var(--eb-transition-fast), color var(--eb-transition-fast)',
};
