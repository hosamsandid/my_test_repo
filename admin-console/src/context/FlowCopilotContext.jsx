import React, { createContext, useContext, useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { apiCall } from '../hooks/useApi';
import { UNAUTHORIZED_EVENT } from '../auth/AuthContext';
import { assistHeaders, notifyAssistError } from './assist-transport.js';
import {
  consumeCopilotStream,
  copilotErrorInfo,
} from '../pages/process/flow-copilot-view.js';
import {
  isBindableScope,
  isSameScope,
  pendingForScope,
  putPending,
  dropPending,
  dropPendingById,
  rekeyTurn,
  rekeyPending,
} from '../pages/process/flow-copilot-turn.js';

// FlowCopilotProvider (#2087) — app-level ownership of an in-flight Flow
// Copilot turn.
//
// A turn takes 20–60 s (up to three LLM calls through the repair loop). Its
// state used to live entirely in FlowCopilotPanel, so three ordinary actions
// destroyed it: navigating away from /flows, closing the panel (the mount is
// conditional), and selecting another flow (which remounts ProcessGraphPanel
// via `key={proc}`). The fetch and the reader loop kept running and their
// setState calls landed on a dead component, so the turn was lost silently.
//
// Mounted in src/index.jsx ABOVE the router — the same reason
// TranscriptionSessionProvider (#1296) and HelperChatProvider (#1735) are:
// nothing below the router survives client-side navigation. This is deliberately
// NOT navigation-blocking (D1): `window.confirm` is forbidden by three drift
// guards, `useBlocker` is unavailable under the plain <BrowserRouter>, and a
// block would cover only one of the three paths anyway.
//
// What lives here is the TURN, not the chat. The durable chat history stays
// exactly where #1071 put it — the draft's own `copilot.messages`, written by
// the panel through onApplyBundle/onPersistHistory — so there is no second
// persistence mechanism (AC7). The provider holds only what would otherwise
// die with the panel: the running turn, and a finished turn's proposal until
// the user applies or discards it (D4).

const FlowCopilotContext = createContext(null);

export function useFlowCopilot() {
  return useContext(FlowCopilotContext);
}

let turnSeq = 0;
const nextTurnId = () => `turn-${++turnSeq}`;

export function FlowCopilotProvider({ children }) {
  // At most one turn runs per browser tab (AC4) — a single slot, not a map, so
  // the constraint is structural rather than enforced.
  const [turn, setTurn] = useState(null);
  // Finished-but-unapplied proposals, keyed by scope (AC5/AC6). Keyed rather
  // than single-slotted: finishing a turn on one draft and starting one on
  // another must not silently drop a proposal nobody has reviewed yet.
  const [pendingByScope, setPendingByScope] = useState({});
  // The last turn's failure, so an error row + Retry survives the remount too.
  const [failure, setFailure] = useState(null);
  const [stopping, setStopping] = useState(false);
  // Which scope the mounted Copilot panel is showing (null when none is open).
  // Drives AC13 — the indicator hides when that surface already shows progress.
  const [panelScope, setPanelScope] = useState(null);

  // The in-flight request. `turnRef` mirrors `turn` so callbacks resolving long
  // after their render can tell whether they are still the current turn.
  const abortRef = useRef(null);
  const turnRef = useRef(null);
  turnRef.current = turn;

  const isCurrent = useCallback((id) => turnRef.current && turnRef.current.id === id, []);

  const clearTurn = useCallback((id) => {
    setTurn((t) => (t && t.id === id ? null : t));
    if (turnRef.current && turnRef.current.id === id) turnRef.current = null;
    abortRef.current = null;
    setStopping(false);
  }, []);

  // The scope the running turn is bound to RIGHT NOW — `rekeyScope` updates the
  // ref synchronously, so a draft renamed mid-turn is followed rather than
  // reported against the id it no longer has.
  const boundScope = useCallback((id) => (
    turnRef.current && turnRef.current.id === id ? turnRef.current.scope : null
  ), []);

  /**
   * Start a turn for `scope`. Resolves when the turn ENDS (either way) so the
   * caller can await it, but nothing about the outcome is returned through the
   * promise: the result lands in provider state, which is the whole point —
   * the caller may be unmounted by then.
   */
  const startTurn = useCallback(async ({ scope, flowName, userText, apiMessages, bundle }) => {
    if (!isBindableScope(scope)) return;
    // Refuse rather than queue or run in parallel (AC4). The panel disables the
    // control from the same pure decision, so this is the server-of-last-resort.
    if (turnRef.current) return;

    const id = nextTurnId();
    const controller = new AbortController();
    abortRef.current = { id, controller };
    const started = {
      id, scope, flowName: flowName || '', userText: userText || '',
      phase: null, status: 'running', startedAt: Date.now(),
    };
    turnRef.current = started;
    setTurn(started);
    setFailure(null);
    // Starting a turn retires this scope's unreviewed proposal — the panel has
    // already superseded its card, and keeping it would offer an Apply for a
    // bundle the new turn was asked to replace.
    setPendingByScope((m) => dropPending(m, scope));

    const failWith = (info) => {
      if (!isCurrent(id)) return;
      setFailure({ scope: boundScope(id) || scope, retryText: userText || '', ...info });
      clearTurn(id);
    };

    try {
      let res;
      try {
        // AC16: the Copilot stream is one of the few call sites that sets
        // X-Assist-Model explicitly rather than through apiCall(). Ownership
        // moved out of the panel, so the header moved with it.
        res = await fetch('/api/process/copilot', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...assistHeaders() },
          body: JSON.stringify({ messages: apiMessages, bundle }),
          signal: controller.signal,
        });
      } catch (e) {
        // An abort is the user's own Stop — `stopTurn` has already cleared the
        // turn, and a "request failed" row for it would be a lie.
        if (e && e.name === 'AbortError') return;
        failWith(copilotErrorInfo(undefined, e && e.message));
        return;
      }
      if (!res.ok) {
        // A pre-stream rejection: request shape, or the provider/assist-model
        // gate (400 assist-model-not-selected / 403 assist-endpoint-not-permitted).
        // The existing nudge that opens Settings → Model must still fire, and
        // no indicator may be left armed — `failWith` clears the turn.
        if (res.status === 401) window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
        const errBody = await res.json().catch(() => null);
        if (errBody && errBody.code) notifyAssistError(errBody.code);
        failWith(copilotErrorInfo(res.status, errBody && errBody.error));
        return;
      }

      let body;
      try {
        body = await consumeCopilotStream(res, (ev) => {
          setTurn((t) => (t && t.id === id ? { ...t, phase: ev } : t));
        });
      } catch (e) {
        if (e && e.name === 'AbortError') return;
        // A stop that aborts mid-stream surfaces as a reader error; the turn is
        // already gone, so there is nothing to report.
        if (!isCurrent(id)) return;
        failWith(copilotErrorInfo(e.status, e.message, e.copilotCode));
        return;
      }
      // The stop may have won the race with the result (edge case): exactly one
      // outcome wins, and a stopped turn never leaves a proposal.
      if (!isCurrent(id)) return;

      // Derive the canvas preview graph exactly like the import path does — here
      // rather than in the panel, so a proposal returned to later still has one.
      // A strict-invalid best-effort bundle (ok:false) fails this build; the card
      // still shows the findings, just without a canvas render.
      let graph = null;
      if (body.bundle) {
        try { graph = await apiCall('POST', '/api/flows/graph', { processTemplate: body.bundle }); }
        catch { /* no preview for a strict-invalid bundle */ }
      }
      if (!isCurrent(id)) return;

      // Capture the turn's identity NOW, synchronously, while `turnRef.current`
      // is still the live turn. The `setPendingByScope` updater below runs
      // LATER (React processes it during the next render), by which point the
      // `clearTurn(id)` on the line after has already set `turnRef.current` to
      // null — so reading the ref from inside the updater dereferences null.
      // `boundScope` already tolerates that (it returns null and we fall back to
      // `scope`); `flowName` did not, which crashed the turn on completion.
      const boundTo = boundScope(id) || scope;
      const finishedFlowName = (turnRef.current && turnRef.current.flowName) || flowName || '';

      setPendingByScope((m) => putPending(m, {
        id, scope: boundTo, flowName: finishedFlowName,
        userText: userText || '',
        summary: body.summary || '',
        changes: Array.isArray(body.changes) ? body.changes : [],
        lints: Array.isArray(body.lints) ? body.lints : [],
        ok: !!body.ok,
        // An answer-only turn (#2915): a question answered or a request
        // refused — no bundle, nothing to apply.
        answer: !!body.answer,
        bundle: body.bundle,
        // The bundle the turn was asked to change — a live-team apply diffs
        // against it and refuses when the team has moved on since (#2556).
        baseBundle: bundle || null,
        graph,
        model: body.model || null,
        finishedAt: Date.now(),
      }));
      clearTurn(id);
    } catch (e) {
      // Every expected failure is handled above; this only catches a genuine
      // bug. It must not become an unhandled rejection (the caller does not
      // await this promise) and must not leave the indicator armed forever.
      failWith({ kind: 'transport', retryable: true, message: (e && e.message) || 'The Copilot turn failed unexpectedly.' });
    } finally {
      // Belt and braces: never leave the indicator armed on an unexpected throw.
      if (isCurrent(id)) clearTurn(id);
    }
  }, [clearTurn, isCurrent, boundScope]);

  /**
   * Stop the running turn (D2). Aborting the fetch closes the socket, which is
   * the `res.on('close')` the route already watched — so one client action ends
   * both the delivery and the server-side LLM loop. Inert once pressed (AC10).
   */
  const stopTurn = useCallback(() => {
    const live = abortRef.current;
    if (!live || !turnRef.current || turnRef.current.id !== live.id) return;
    setStopping(true);
    const stoppedScope = turnRef.current.scope;
    try { live.controller.abort(); } catch { /* already gone */ }
    // A stopped turn leaves no proposal and no partially written draft (AC11):
    // nothing was written — Apply is the only writer — and the pending slot is
    // cleared here for the same reason.
    setPendingByScope((m) => dropPending(m, stoppedScope));
    setFailure(null);
    turnRef.current = null;
    setTurn(null);
    abortRef.current = null;
    setStopping(false);
  }, []);

  /**
   * Drop a finished proposal once the panel has applied or discarded it. Keyed
   * on the proposal's own turn id, not on a scope: applying can re-key the
   * draft (the first generation proposes a name), so by the time the write
   * returns the proposal may already be filed under the new scope.
   */
  const resolvePending = useCallback((pendingId) => {
    setPendingByScope((m) => dropPendingById(m, pendingId));
  }, []);

  /** Clear the error row for a scope (the panel's Retry strips it first). */
  const clearFailure = useCallback((scope) => {
    setFailure((f) => (f && isSameScope(f.scope, scope) ? null : f));
  }, []);

  /**
   * Follow a draft that was saved under a new id mid-turn (edge case):
   * ProcessCanvas navigates to `draft:<newId>` after such a save, so the scope
   * key the turn was bound to changes underneath it. The binding follows the
   * rename rather than silently mismatching — same draft file, new id.
   */
  const rekeyScope = useCallback((from, to) => {
    if (!isBindableScope(from) || !isBindableScope(to) || from === to) return;
    setTurn((t) => rekeyTurn(t, from, to));
    turnRef.current = rekeyTurn(turnRef.current, from, to);
    setPendingByScope((m) => rekeyPending(m, from, to));
    setFailure((f) => (f && isSameScope(f.scope, from) ? { ...f, scope: to } : f));
    setPanelScope((s) => (isSameScope(s, from) ? to : s));
  }, []);

  /**
   * The mounted panel publishes the scope it is showing, and retracts it on
   * unmount (the `useHelpSubject` shape). Only one Copilot panel can be
   * mounted at a time — it lives inside the single ProcessGraphPanel.
   */
  const registerPanel = useCallback((scope) => {
    setPanelScope(isBindableScope(scope) ? scope : null);
    return () => setPanelScope((s) => (isSameScope(s, scope) ? null : s));
  }, []);

  // ── beforeunload guard while a turn runs (D6 / AC14) ───────────────────────
  // The five other decisions are about CLIENT-side navigation, where the stream
  // stays open. Once the socket is genuinely gone the result cannot be
  // delivered, so aborting is the consistent outcome under D2 — and it happens
  // by itself: closing the tab closes the socket, which fires the route's
  // `res.on('close')` and aborts the LLM loop. The browser's own leave
  // confirmation comes first, so nothing is lost silently.
  const running = !!turn && turn.status === 'running';
  useEffect(() => {
    if (!running) return undefined;
    const handler = (e) => { e.preventDefault(); e.returnValue = ''; return ''; };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [running]);

  // Abort a still-running turn if the whole app unmounts — the mirror of
  // TranscriptionSessionProvider releasing the mic.
  useEffect(() => () => {
    const live = abortRef.current;
    if (live) { try { live.controller.abort(); } catch { /* ignore */ } }
  }, []);

  /**
   * Per-scope view of the provider, so the panel needs no scope plumbing. The
   * send/stop DECISION is deliberately not made here — it also depends on the
   * panel's own composer text and bundle, so the panel folds those in and calls
   * `decideCopilotAction` itself, at one call site with all five inputs.
   */
  const viewFor = useCallback((scope) => {
    const mine = isSameScope(turn && turn.scope, scope);
    return {
      running: mine && running,
      phase: mine ? (turn && turn.phase) || null : null,
      userText: mine ? (turn && turn.userText) || '' : '',
      pending: pendingForScope(pendingByScope, scope),
      failure: failure && isSameScope(failure.scope, scope) ? failure : null,
      // The tab-wide turn, for the "busy on another flow" refusal (AC4).
      turnScope: turn ? turn.scope : null,
      turnFlowName: turn ? turn.flowName : '',
      stopping,
    };
  }, [turn, running, pendingByScope, failure, stopping]);

  const value = useMemo(() => ({
    turn, running, stopping, panelScope, pendingByScope, failure,
    startTurn, stopTurn, resolvePending, clearFailure, rekeyScope, registerPanel, viewFor,
  }), [
    turn, running, stopping, panelScope, pendingByScope, failure,
    startTurn, stopTurn, resolvePending, clearFailure, rekeyScope, registerPanel, viewFor,
  ]);

  return (
    <FlowCopilotContext.Provider value={value}>
      {children}
    </FlowCopilotContext.Provider>
  );
}

export default FlowCopilotProvider;
