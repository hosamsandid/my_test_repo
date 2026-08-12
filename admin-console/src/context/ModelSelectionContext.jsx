import React, { createContext, useContext, useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useAuth } from '../auth/AuthContext';
import {
  storageKey,
  validateSelection,
  autoSelect,
  needsSelection,
} from './assist-model-selection.js';
import { setAssistSelection, registerAssistErrorHandlers } from './assist-transport.js';
import { classifyExclusions } from './assist-selector-exclusion.js';

// Global assist model selection (#1212, concept docs/assist-model-selection-
// concept.md §4.3–§4.5). Sibling of AuthProvider: after login it loads
// GET /api/assist/model-options, validates any per-user stored selection
// against it, auto-selects when there is exactly one provider, and exposes
// `{ selection, options, select, ... }` to the header control (Shell.jsx).
// The chosen selection is mirrored into the non-React transport (assist-
// transport.js) so apiCall() and the copilot streaming fetches attach the
// `X-Assist-Model` header without threading context through every caller.

const ModelSelectionContext = createContext(null);

const EMPTY_OPTIONS = { providers: [], envFallbackActive: false };

export function ModelSelectionProvider({ children }) {
  const { authenticated, user } = useAuth();
  const username = user?.username || null;

  const [options, setOptions] = useState(EMPTY_OPTIONS);
  const [loading, setLoading] = useState(false);
  const [selection, setSelectionState] = useState(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  // Exclusion reason when providers: [] — set by fetching the full endpoint list
  // to explain WHY no providers are available (AC3 / #1402).
  const [exclusionReason, setExclusionReason] = useState(null);

  // Keep the transport getter in sync with the live selection.
  useEffect(() => { setAssistSelection(selection); }, [selection]);

  const persist = useCallback((sel) => {
    const key = storageKey(username);
    if (!key) return;
    try {
      if (sel) localStorage.setItem(key, JSON.stringify(sel));
      else localStorage.removeItem(key);
    } catch { /* private-mode / quota — selection still works in-memory */ }
  }, [username]);

  // Apply freshly-loaded options: validate the stored selection, else auto-select
  // a single provider, else leave unselected (attention state handled by the UI).
  const applyOptions = useCallback((providers) => {
    let stored = null;
    const key = storageKey(username);
    if (key) {
      try { stored = JSON.parse(localStorage.getItem(key)); } catch { /* ignore */ }
    }
    const valid = validateSelection(stored, providers);
    if (valid) {
      setSelectionState(valid);
      // A coerced model (stale one dropped) should be written back.
      if (!stored || stored.modelId !== valid.modelId) persist(valid);
      return;
    }
    // Stored selection no longer validates → drop it silently (§4.4).
    if (stored) persist(null);
    const auto = autoSelect(providers);
    setSelectionState(auto);
    // Auto-selection is a UI convenience, not a stored preference — do not
    // persist it, so adding a second provider later returns to the attention
    // state rather than silently locking in the bootstrap pick.
  }, [username, persist]);

  const load = useCallback(async () => {
    if (!authenticated) return;
    setLoading(true);
    try {
      const res = await fetch('/api/assist/model-options');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const providers = Array.isArray(data.providers) ? data.providers : [];
      const envFallbackActive = !!data.envFallbackActive;
      setOptions({ providers, envFallbackActive });
      applyOptions(providers);

      // AC3 (#1402): when there are no selectable providers and the env fallback
      // is not active, fetch the full endpoint list to explain WHY (oauth exclusion
      // vs team-scope mismatch) so the selector chip can show a targeted message.
      if (providers.length === 0 && !envFallbackActive) {
        try {
          const epRes = await fetch('/api/llm-endpoints');
          if (epRes.ok) {
            const allEndpoints = await epRes.json();
            const userTeamIds = (user?.teams || []).map(t => t.teamId);
            const isSysAdmin = !!user?.admin;
            setExclusionReason(classifyExclusions(allEndpoints, userTeamIds, isSysAdmin));
          }
        } catch { /* best-effort — exclusion reason is cosmetic */ }
      } else {
        setExclusionReason(null);
      }
    } catch {
      // Fail soft: no picker, assist helpers still attempt calls (server decides).
      setOptions(EMPTY_OPTIONS);
      setSelectionState(null);
      setExclusionReason(null);
    } finally {
      setLoading(false);
    }
  }, [authenticated, applyOptions, user]);

  useEffect(() => {
    if (!authenticated) {
      setOptions(EMPTY_OPTIONS);
      setSelectionState(null);
      setPickerOpen(false);
      setExclusionReason(null);
      return;
    }
    load();
  }, [authenticated, username, load]);

  const select = useCallback((endpointId, modelId) => {
    const sel = validateSelection({ endpointId, modelId }, options.providers);
    if (!sel) return;
    setSelectionState(sel);
    persist(sel);
    setPickerOpen(false);
  }, [options.providers, persist]);

  const clearSelection = useCallback(() => {
    setSelectionState(null);
    persist(null);
  }, [persist]);

  const openPicker = useCallback(() => setPickerOpen(true), []);
  const closePicker = useCallback(() => setPickerOpen(false), []);

  // Error-code nudges from the transport layer (§4.5). Kept in a ref-free effect
  // so the latest handlers (closing over current state) are always registered.
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    return registerAssistErrorHandlers({
      onForbidden: () => {
        // Provider gone / team unassigned mid-session: drop the stale pick,
        // refetch options, open the picker so the user re-chooses.
        clearSelection();
        loadRef.current();
        setPickerOpen(true);
      },
      onNotSelected: () => setPickerOpen(true),
    });
  }, [clearSelection]);

  const attention = needsSelection(selection, options.providers);

  // Memoized so consumers don't re-render on an unrelated provider render:
  // the callbacks are already useCallback-stable and every other field is
  // primitive or a replaced-not-mutated object.
  const value = useMemo(() => ({
    loading,
    options,
    providers: options.providers,
    envFallbackActive: options.envFallbackActive,
    exclusionReason,
    selection,
    attention,
    pickerOpen,
    select,
    clearSelection,
    openPicker,
    closePicker,
    refetch: load,
  }), [
    loading, options, exclusionReason, selection, attention, pickerOpen,
    select, clearSelection, openPicker, closePicker, load,
  ]);

  return (
    <ModelSelectionContext.Provider value={value}>
      {children}
    </ModelSelectionContext.Provider>
  );
}

export function useModelSelection() {
  const ctx = useContext(ModelSelectionContext);
  if (!ctx) throw new Error('useModelSelection must be used within a ModelSelectionProvider');
  return ctx;
}
