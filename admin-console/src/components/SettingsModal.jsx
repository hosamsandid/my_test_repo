import React, { useState, useRef, useEffect } from 'react';
import Modal from './Modal.jsx';
import {
  SETTINGS_SECTIONS, defaultSectionId, resolveSectionId, adjacentSectionId, sectionById,
} from './settings-modal-view.js';
import AssistModelSelector from './AssistModelSelector.jsx';
import {
  isMacPlatform,
  loadSendKeybinding,
  saveSendKeybinding,
  notifySendKeybindingChanged,
  sendKeybindingOptions,
} from '../pages/agent-chat/message-send-keybinding.js';
import { useAuth } from '../auth/AuthContext.jsx';
import { useHelpSubject } from '../context/HelperChatContext.jsx';
import PageHelpButton from './PageHelpButton.jsx';
import { OVERLAY_SETTINGS } from '../context/page-help-view.js';
import useTheme from '../hooks/useTheme.js';
import { apiCall } from '../hooks/useApi.js';
import {
  MIN_FONT_SIZE, MAX_FONT_SIZE, stepFontSize, canIncrease, canDecrease,
  resolveInitialFontSize, loadStoredFontSize, saveStoredFontSize,
  notifyFontSizeChanged,
} from '../pages/agent-chat/chat-font-size.js';

/**
 * SettingsModal — the user Settings dialog (#1802, UX-1 foundation).
 *
 * A sectioned shell (Behavior · Model · Display) ready to receive per-user
 * preferences — the individual settings are migrated in by UX-3 / UX-4 / UX-8,
 * so every section renders an empty placeholder for now. The overlay behaviour
 * (centred, focus-trapped, Esc / ✕ / backdrop dismiss) is owned by <Modal>.
 */
export default function SettingsModal({ open, onClose, requestedSectionId = null }) {
  const [activeId, setActiveId] = useState(defaultSectionId());
  const tabRefs = useRef({});

  const active = sectionById(resolveSectionId(activeId));

  // Settings is a dialog, not a route, so the help panel cannot find it from the
  // pathname (E17 #1892). Publish it as the active help subject while the modal is
  // open — including the section, so a later per-section topic resolves without
  // another wiring change — and retract it on close, which hands help straight
  // back to the page underneath (AC1).
  useHelpSubject({ overlay: OVERLAY_SETTINGS, step: active.id, active: open });

  // On open, land on the requested section when the caller deep-links to one
  // (e.g. the assist-error nudge opens Settings → Model, #1805); otherwise the
  // default first section. Keyed on [open, requestedSectionId] so a fresh open
  // — or a nudge arriving while the modal is already open — jumps correctly.
  useEffect(() => {
    if (!open) return;
    setActiveId(requestedSectionId ? resolveSectionId(requestedSectionId) : defaultSectionId());
  }, [open, requestedSectionId]);

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
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-1)' }}>
            <h3 style={paneTitleStyle}>{active.label}</h3>
            {/* Opens the Help panel on the Settings topic rather than the page
                behind the dialog — the panel is lifted above the modal layer while
                this overlay subject is published. */}
            <PageHelpButton label="What these settings do" size={14} style={{ padding: 0 }} />
          </div>
          <p style={paneBlurbStyle}>{active.blurb}</p>
          {active.id === 'behavior' ? (
            <BehaviorSettings />
          ) : active.id === 'model' ? (
            <div style={settingRowStyle}>
              <div>
                <div style={settingLabelStyle}>Assist model</div>
                <div style={settingHintStyle}>Which model AI helpers bill against</div>
              </div>
              <AssistModelSelector />
            </div>
          ) : (
            <DisplaySettings />
          )}
        </div>
      </div>
    </Modal>
  );
}

/**
 * Behavior section — the per-user send-on-Enter preset (#1804, migrated out of
 * the chat composer). Persists to localStorage via `saveSendKeybinding` and
 * broadcasts `notifySendKeybindingChanged()` so the active chat's composer
 * applies the new mode immediately, without a reload (AC3). Reuses the same
 * `agentChat.sendKeybinding` key + `message-send-keybinding.js` logic, so the
 * setting round-trips with the composer (AC4) and its tooltip (AC5).
 */
function BehaviorSettings() {
  const isMac = isMacPlatform();
  const [sendKeybinding, setSendKeybinding] = useState(() => loadSendKeybinding());
  const options = sendKeybindingOptions(isMac);

  function change(value) {
    setSendKeybinding(value);
    saveSendKeybinding(value);
    notifySendKeybindingChanged();
  }

  return (
    <div style={settingRowStyle}>
      <div>
        <div style={settingLabelStyle}>Send on Enter</div>
        <div style={settingHintStyle}>
          Choose what pressing Enter does in the chat composer. IDE style keeps
          Enter for newlines ({isMac ? '⌘' : 'Ctrl'}+↩ sends); Chat style sends
          on Enter (Shift+↩ for a newline).
        </div>
      </div>
      <select
        value={sendKeybinding}
        onChange={(e) => change(e.target.value)}
        aria-label="Enter key sends or inserts a newline"
        style={selectStyle}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </div>
  );
}

const THEME_OPTIONS = [
  { value: 'admin-dark', label: 'Dark' },
  { value: 'admin-light', label: 'Light' },
  { value: 'high-contrast', label: 'High contrast' },
];

/**
 * Display section — theme selector and chat font-size stepper (UX-8).
 * Theme changes apply immediately via useTheme's setTheme. Font-size changes
 * persist to localStorage + server and notify the active ChatPanel via the
 * FONT_SIZE_CHANGED_EVENT custom event (same pattern as send-keybinding).
 */
function DisplaySettings() {
  const { user } = useAuth();
  const { theme, setTheme } = useTheme();
  const username = user?.username;
  const hasServerRecord = user != null && user.userId != null;

  const [fontSize, setFontSize] = useState(() => resolveInitialFontSize({
    sessionValue: user?.chatFontSize,
    storedValue: loadStoredFontSize(username),
    hasServerRecord,
  }));

  function changeFontSize(delta) {
    const next = stepFontSize(fontSize, delta);
    if (next === fontSize) return;
    setFontSize(next);
    saveStoredFontSize(username, next);
    notifyFontSizeChanged(next);
    apiCall('PUT', '/api/me/preferences', { chatFontSize: next }).catch(() => {});
  }

  return (
    <>
      <div style={settingRowStyle}>
        <div>
          <div style={settingLabelStyle}>Theme</div>
          <div style={settingHintStyle}>Choose the console colour scheme.</div>
        </div>
        <select
          value={theme}
          onChange={(e) => setTheme(e.target.value)}
          aria-label="Console theme"
          style={selectStyle}
        >
          {THEME_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </div>
      <div style={settingRowStyle}>
        <div>
          <div style={settingLabelStyle}>Chat font size</div>
          <div style={settingHintStyle}>
            Adjustable {MIN_FONT_SIZE}–{MAX_FONT_SIZE} px. Applies immediately to the message transcript.
          </div>
        </div>
        <div
          role="group"
          aria-label="Chat font size"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 4, flexShrink: 0 }}
        >
          <button
            type="button"
            onClick={() => changeFontSize(-1)}
            disabled={!canDecrease(fontSize)}
            aria-label="Decrease chat font size"
            style={{
              ...stepBtnStyle,
              opacity: canDecrease(fontSize) ? 1 : 0.5,
              cursor: canDecrease(fontSize) ? 'pointer' : 'not-allowed',
            }}
          >−</button>
          <span
            aria-live="polite"
            style={{
              minWidth: 36,
              textAlign: 'center',
              fontFamily: 'var(--eb-font-mono)',
              fontSize: 'var(--eb-text-sm)',
              color: 'var(--eb-text-secondary)',
            }}
          >
            {fontSize}px
          </span>
          <button
            type="button"
            onClick={() => changeFontSize(1)}
            disabled={!canIncrease(fontSize)}
            aria-label="Increase chat font size"
            style={{
              ...stepBtnStyle,
              opacity: canIncrease(fontSize) ? 1 : 0.5,
              cursor: canIncrease(fontSize) ? 'pointer' : 'not-allowed',
            }}
          >+</button>
        </div>
      </div>
    </>
  );
}

const stepBtnStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 28,
  height: 28,
  padding: 0,
  fontFamily: 'inherit',
  fontSize: 'var(--eb-text-md)',
  background: 'var(--eb-bg-elevated)',
  border: '1px solid var(--eb-border-default)',
  borderRadius: 'var(--eb-radius-sm)',
  color: 'var(--eb-text-secondary)',
};

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

const settingRowStyle = {
  marginTop: 'var(--eb-space-5)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 'var(--eb-space-4)',
};

const settingLabelStyle = {
  fontSize: 'var(--eb-text-sm)',
  fontWeight: 'var(--eb-font-medium)',
  color: 'var(--eb-text-primary)',
};

const settingHintStyle = {
  marginTop: 'var(--eb-space-1)',
  fontSize: 'var(--eb-text-xs)',
  color: 'var(--eb-text-secondary)',
};

const selectStyle = {
  fontFamily: 'inherit',
  fontSize: 'var(--eb-text-sm)',
  color: 'var(--eb-text-primary)',
  background: 'var(--eb-bg-elevated)',
  border: '1px solid var(--eb-border-default)',
  borderRadius: 'var(--eb-radius-sm)',
  padding: 'var(--eb-space-1) var(--eb-space-2)',
  cursor: 'pointer',
  flexShrink: 0,
};
