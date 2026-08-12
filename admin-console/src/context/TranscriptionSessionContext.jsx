import React, { createContext, useContext, useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { apiCall } from '../hooks/useApi';
import { transcribeAudio } from '../hooks/useVoiceRecorder.js';
import {
  SEGMENT_MS,
  MAX_SEGMENT_RETRIES,
  GAP_MARKER,
  RECOVERY_KEY,
  nextState,
  isActiveState,
  assembleTranscript,
  countGaps,
  countResolved,
  durationMinutes,
  formatTranscriptMessage,
  buildRecoveryRecord,
  parseRecoveryRecord,
  shouldOfferRecovery,
} from './transcription-session.js';

// Meeting Note-Taker session engine (#1296). Mounted app-level (above the
// router, inside AuthProvider) so the MediaStream and segment loop survive all
// client-side navigation — the mic is never released when the composer that
// started the session unmounts. The deterministic core lives in the pure
// transcription-session.js; this provider is the thin browser adapter that
// owns getUserMedia, the MediaRecorder rotation, the sequential upload queue,
// localStorage recovery and delivery via the existing DM + messages APIs.

const TranscriptionSessionContext = createContext(null);

export function useTranscriptionSession() {
  return useContext(TranscriptionSessionContext);
}

function newTabId() {
  try {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  } catch { /* fall through */ }
  return `tab-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function TranscriptionSessionProvider({ children }) {
  // Rendered session snapshot the overlay + entry point read.
  const [session, setSession] = useState(null); // null when idle
  // Recovery banner data (a prior interrupted session's transcribed portion).
  const [recovery, setRecovery] = useState(null);

  // ── Engine refs (mutable, not render state) ──────────────────────────────
  const tabIdRef = useRef(newTabId());
  const streamRef = useRef(null);
  const recorderRef = useRef(null);
  const capturingRef = useRef(false);          // mic should keep rotating segments
  const segmentsRef = useRef([]);              // text | GAP_MARKER | null, by index
  const nextSegIndexRef = useRef(0);
  const queueRef = useRef([]);                 // pending { index, blob }
  const pumpingRef = useRef(false);
  const drainWaitersRef = useRef([]);          // resolve fns awaiting a full drain
  const agentIdRef = useRef(null);
  const agentNameRef = useRef(null);
  const startedAtRef = useRef(0);
  const elapsedRef = useRef(0);                // whole seconds captured (frozen while paused)
  const elapsedTimerRef = useRef(null);
  const segTimerRef = useRef(null);
  const segDeadlineRef = useRef(0);            // Date.now() when the current segment rotates
  const stateRef = useRef('idle');
  const lastMessageRef = useRef('');           // assembled message, kept for Copy/Retry
  const lastDeliverRef = useRef(null);         // { agentId, message } for Retry

  // ── Render-state helpers ─────────────────────────────────────────────────
  const publish = useCallback((patch) => {
    // Keep the synchronous stateRef mirror authoritative for logic that reads
    // it between renders (the React state updater is not guaranteed to run at
    // call time). A status of 'idle' collapses the session to null.
    if (patch.status) stateRef.current = patch.status;
    setSession(prev => {
      const base = prev || {
        status: 'idle', agentId: null, agentName: null, startedAt: 0,
        elapsedSec: 0, segsDone: 0, segsTotal: 0, gapCount: 0, error: null,
      };
      const next = { ...base, ...patch };
      return next.status === 'idle' ? null : next;
    });
  }, []);

  const applyAction = useCallback((action, patch = {}) => {
    const to = nextState(stateRef.current, action);
    publish({ ...patch, status: to });
    return to;
  }, [publish]);

  const refreshProgress = useCallback(() => {
    const segs = segmentsRef.current;
    publish({
      segsDone: countResolved(segs),
      segsTotal: Math.max(nextSegIndexRef.current, segs.length),
      gapCount: countGaps(segs),
    });
  }, [publish]);

  // ── Recovery persistence ─────────────────────────────────────────────────
  const persistRecovery = useCallback(() => {
    try {
      const rec = buildRecoveryRecord({
        tabId: tabIdRef.current,
        agentId: agentIdRef.current,
        agentName: agentNameRef.current,
        startedAt: startedAtRef.current,
        segments: segmentsRef.current,
      });
      localStorage.setItem(RECOVERY_KEY, JSON.stringify(rec));
    } catch { /* storage full / disabled — best effort */ }
  }, []);

  const clearRecovery = useCallback(() => {
    try { localStorage.removeItem(RECOVERY_KEY); } catch { /* ignore */ }
  }, []);

  // ── Upload queue (sequential, index-ordered) ──────────────────────────────
  const transcribeWithRetry = useCallback(async (blob) => {
    for (let attempt = 0; attempt <= MAX_SEGMENT_RETRIES; attempt++) {
      try {
        const text = await transcribeAudio(blob);
        return typeof text === 'string' ? text : '';
      } catch {
        if (attempt === MAX_SEGMENT_RETRIES) return GAP_MARKER;
      }
    }
    return GAP_MARKER;
  }, []);

  const pump = useCallback(async () => {
    if (pumpingRef.current) return;
    pumpingRef.current = true;
    try {
      while (queueRef.current.length) {
        const { index, blob } = queueRef.current.shift();
        const text = await transcribeWithRetry(blob);
        segmentsRef.current[index] = text;
        persistRecovery();
        refreshProgress();
      }
    } finally {
      pumpingRef.current = false;
      if (!queueRef.current.length) {
        const waiters = drainWaitersRef.current;
        drainWaitersRef.current = [];
        waiters.forEach(fn => fn());
      }
    }
  }, [transcribeWithRetry, persistRecovery, refreshProgress]);

  const enqueueSegment = useCallback((index, blob) => {
    // Reserve the slot immediately so ordering + progress totals are stable
    // even before transcription resolves.
    if (segmentsRef.current[index] === undefined) segmentsRef.current[index] = null;
    queueRef.current.push({ index, blob });
    refreshProgress();
    pump();
  }, [pump, refreshProgress]);

  const waitForDrain = useCallback(() => {
    if (!pumpingRef.current && queueRef.current.length === 0) return Promise.resolve();
    return new Promise(resolve => { drainWaitersRef.current.push(resolve); });
  }, []);

  // ── Segment recorder rotation ─────────────────────────────────────────────
  const beginSegment = useCallback((index) => {
    const stream = streamRef.current;
    if (!stream) return;
    let rec;
    try {
      rec = new MediaRecorder(stream);
    } catch {
      return; // recording unsupported — the session will just have no segments
    }
    recorderRef.current = rec;
    nextSegIndexRef.current = index + 1;

    rec.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) enqueueSegment(index, e.data);
    };
    rec.onstop = () => {
      // Chain the next segment on the same still-open stream while capturing.
      if (capturingRef.current && streamRef.current) beginSegment(index + 1);
    };
    rec.start(); // single blob delivered on stop (no timeslice)

    // Schedule the rotation for a full segment's worth of audio.
    segDeadlineRef.current = Date.now() + SEGMENT_MS;
    clearTimeout(segTimerRef.current);
    segTimerRef.current = setTimeout(() => {
      try { if (rec.state !== 'inactive') rec.stop(); } catch { /* ignore */ }
    }, SEGMENT_MS);
  }, [enqueueSegment]);

  // ── Timers ─────────────────────────────────────────────────────────────────
  const startElapsedTimer = useCallback(() => {
    clearInterval(elapsedTimerRef.current);
    elapsedTimerRef.current = setInterval(() => {
      elapsedRef.current += 1;
      publish({ elapsedSec: elapsedRef.current });
    }, 1000);
  }, [publish]);

  const stopElapsedTimer = useCallback(() => {
    clearInterval(elapsedTimerRef.current);
    elapsedTimerRef.current = null;
  }, []);

  // ── Teardown ────────────────────────────────────────────────────────────────
  // Stop the current recorder and resolve only once its final blob has been
  // delivered (ondataavailable fires before onstop), so the last segment is
  // never dropped from the queue. Does NOT release the stream tracks.
  const flushFinalSegment = useCallback(() => {
    return new Promise((resolve) => {
      capturingRef.current = false;
      clearTimeout(segTimerRef.current);
      segTimerRef.current = null;
      const rec = recorderRef.current;
      if (!rec || rec.state === 'inactive') { resolve(); return; }
      rec.onstop = () => resolve(); // don't chain a new segment; ondataavailable already ran
      try { rec.stop(); } catch { resolve(); }
    });
  }, []);

  // Hard teardown: stop the recorder (no flush wait) + release the mic tracks.
  const releaseMedia = useCallback(() => {
    capturingRef.current = false;
    clearTimeout(segTimerRef.current);
    segTimerRef.current = null;
    stopElapsedTimer();
    try {
      if (recorderRef.current && recorderRef.current.state !== 'inactive') {
        recorderRef.current.onstop = null; // don't chain another segment
        recorderRef.current.stop();
      }
    } catch { /* ignore */ }
    recorderRef.current = null;
    try { streamRef.current?.getTracks().forEach(t => t.stop()); } catch { /* ignore */ }
    streamRef.current = null;
  }, [stopElapsedTimer]);

  const resetEngine = useCallback(() => {
    segmentsRef.current = [];
    nextSegIndexRef.current = 0;
    queueRef.current = [];
    drainWaitersRef.current = [];
    elapsedRef.current = 0;
    agentIdRef.current = null;
    agentNameRef.current = null;
    startedAtRef.current = 0;
  }, []);

  // ── Delivery ──────────────────────────────────────────────────────────────
  const deliverMessage = useCallback(async (agentId, message) => {
    lastDeliverRef.current = { agentId, message };
    lastMessageRef.current = message;
    const dm = await apiCall('POST', `/api/matrix/agents/${encodeURIComponent(agentId)}/dm`);
    if (!dm || !dm.roomId) throw new Error('No DM room');
    await apiCall('POST', `/api/matrix/rooms/${encodeURIComponent(dm.roomId)}/messages`, { body: message });
  }, []);

  const buildMessage = useCallback(({ segments, startedAt, interrupted }) => {
    const transcript = assembleTranscript(segments);
    const gapCount = countGaps(segments);
    const durationMin = durationMinutes(Date.now() - (startedAt || Date.now()));
    let startedAtLabel;
    try { startedAtLabel = new Date(startedAt || Date.now()).toLocaleString(); }
    catch { startedAtLabel = String(startedAt || ''); }
    return formatTranscriptMessage({ startedAtLabel, durationMin, transcript, gapCount, interrupted });
  }, []);

  // Finish an active session: flush the final segment, drain the queue,
  // assemble and deliver.
  const finishAndDeliver = useCallback(async ({ interrupted = false } = {}) => {
    applyAction('stop'); // → stopping
    stopElapsedTimer();
    await flushFinalSegment(); // waits for the last blob to be enqueued
    // Release the mic now that capture is complete.
    try { streamRef.current?.getTracks().forEach(t => t.stop()); } catch { /* ignore */ }
    streamRef.current = null;
    recorderRef.current = null;
    await waitForDrain();
    applyAction('deliver'); // → delivering
    refreshProgress();
    const agentId = agentIdRef.current;
    const message = buildMessage({
      segments: segmentsRef.current, startedAt: startedAtRef.current, interrupted,
    });
    try {
      await deliverMessage(agentId, message);
      clearRecovery();
      resetEngine();
      publish({ status: 'idle' });
    } catch {
      publish({ status: 'delivery-failed', error: 'Delivery failed' });
    }
  }, [applyAction, stopElapsedTimer, flushFinalSegment, waitForDrain, refreshProgress, buildMessage, deliverMessage, clearRecovery, resetEngine, publish]);

  // ── Public API ────────────────────────────────────────────────────────────
  const startSession = useCallback(async ({ agentId, agentName } = {}) => {
    if (!agentId) return;
    if (isActiveState(stateRef.current)) return; // one active session per tab

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      // No media was acquired, so there is nothing to hold open. Surface the
      // permission error briefly via a transient error session that the caller
      // (entry point) can render, then collapse to idle.
      publish({
        status: 'error', agentId, agentName: agentName || agentId,
        error: 'Microphone blocked — allow it in your browser, then start again.',
      });
      window.setTimeout(() => publish({ status: 'idle' }), 4000);
      return;
    }

    resetEngine();
    streamRef.current = stream;
    agentIdRef.current = agentId;
    agentNameRef.current = agentName || agentId;
    startedAtRef.current = Date.now();
    elapsedRef.current = 0;
    capturingRef.current = true;

    // A track ending (permission revoked, device unplugged) is treated as Stop
    // with a partial-delivery warning.
    stream.getAudioTracks().forEach(t => {
      t.addEventListener('ended', () => {
        if (isActiveState(stateRef.current) && stateRef.current !== 'stopping' &&
            stateRef.current !== 'delivering' && stateRef.current !== 'delivery-failed') {
          finishAndDeliver({ interrupted: true });
        }
      });
    });

    publish({
      status: 'recording', agentId, agentName: agentName || agentId,
      startedAt: startedAtRef.current, elapsedSec: 0,
      segsDone: 0, segsTotal: 0, gapCount: 0, error: null,
    });
    startElapsedTimer();
    beginSegment(0);
  }, [publish, resetEngine, startElapsedTimer, beginSegment, finishAndDeliver]);

  const pause = useCallback(() => {
    if (stateRef.current !== 'recording') return;
    try { recorderRef.current?.pause(); } catch { /* ignore */ }
    // Freeze both timers; remember remaining segment time.
    clearTimeout(segTimerRef.current);
    segTimerRef.current = null;
    segDeadlineRef.current = Math.max(0, segDeadlineRef.current - Date.now());
    stopElapsedTimer();
    applyAction('pause');
  }, [applyAction, stopElapsedTimer]);

  const resume = useCallback(() => {
    if (stateRef.current !== 'paused') return;
    try { recorderRef.current?.resume(); } catch { /* ignore */ }
    const remaining = segDeadlineRef.current > 0 ? segDeadlineRef.current : SEGMENT_MS;
    segDeadlineRef.current = Date.now() + remaining;
    clearTimeout(segTimerRef.current);
    const rec = recorderRef.current;
    segTimerRef.current = setTimeout(() => {
      try { if (rec && rec.state !== 'inactive') rec.stop(); } catch { /* ignore */ }
    }, remaining);
    startElapsedTimer();
    applyAction('resume');
  }, [applyAction, startElapsedTimer]);

  const stop = useCallback(() => {
    if (stateRef.current !== 'recording' && stateRef.current !== 'paused') return;
    finishAndDeliver({ interrupted: false });
  }, [finishAndDeliver]);

  const cancel = useCallback(() => {
    if (!isActiveState(stateRef.current)) return;
    releaseMedia();
    clearRecovery();
    resetEngine();
    publish({ status: 'idle' });
  }, [releaseMedia, clearRecovery, resetEngine, publish]);

  const retryDelivery = useCallback(async () => {
    const last = lastDeliverRef.current;
    if (!last) return;
    applyAction('retry'); // → delivering
    try {
      await deliverMessage(last.agentId, last.message);
      clearRecovery();
      resetEngine();
      publish({ status: 'idle' });
      setRecovery(null);
    } catch {
      publish({ status: 'delivery-failed', error: 'Delivery failed' });
    }
  }, [applyAction, deliverMessage, clearRecovery, resetEngine, publish]);

  const copyTranscript = useCallback(async () => {
    const text = lastMessageRef.current;
    if (!text) return false;
    try { await navigator.clipboard.writeText(text); return true; }
    catch { return false; }
  }, []);

  // ── Recovery actions (from the banner) ─────────────────────────────────────
  const deliverRecovery = useCallback(async () => {
    if (!recovery) return;
    const message = buildMessage({
      segments: recovery.segments,
      startedAt: recovery.startedAt || Date.now(),
      interrupted: true,
    });
    try {
      await deliverMessage(recovery.agentId, message);
      clearRecovery();
      setRecovery(null);
    } catch {
      // Surface the transcript in the delivery-failed overlay for Retry/Copy.
      lastMessageRef.current = message;
      lastDeliverRef.current = { agentId: recovery.agentId, message };
      publish({
        status: 'delivery-failed',
        agentId: recovery.agentId, agentName: recovery.agentName,
        error: 'Delivery failed',
      });
      setRecovery(null);
    }
  }, [recovery, buildMessage, deliverMessage, clearRecovery, publish]);

  const discardRecovery = useCallback(() => {
    clearRecovery();
    setRecovery(null);
  }, [clearRecovery]);

  // ── beforeunload guard while a session is active ───────────────────────────
  const active = isActiveState(session?.status);
  useEffect(() => {
    if (!active) return undefined;
    const handler = (e) => { e.preventDefault(); e.returnValue = ''; return ''; };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [active]);

  // ── On mount: surface any recovery record from a prior interrupted run ─────
  useEffect(() => {
    let raw = null;
    try { raw = localStorage.getItem(RECOVERY_KEY); } catch { raw = null; }
    const rec = parseRecoveryRecord(raw);
    if (shouldOfferRecovery(rec, tabIdRef.current)) setRecovery(rec);
    // Release the mic if the whole app unmounts.
    return () => releaseMedia();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Memoized so a provider re-render with unchanged inputs keeps a stable
  // `value` identity: the action callbacks are already useCallback-stable and
  // session/recovery are replaced (never mutated) on change.
  const value = useMemo(() => ({
    session,
    recovery,
    active,
    startSession,
    pause,
    resume,
    stop,
    cancel,
    retryDelivery,
    copyTranscript,
    deliverRecovery,
    discardRecovery,
  }), [
    session, recovery, active, startSession, pause, resume, stop, cancel,
    retryDelivery, copyTranscript, deliverRecovery, discardRecovery,
  ]);

  return (
    <TranscriptionSessionContext.Provider value={value}>
      {children}
    </TranscriptionSessionContext.Provider>
  );
}

export default TranscriptionSessionProvider;
