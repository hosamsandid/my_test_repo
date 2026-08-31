// Pure, dependency-free core of the Meeting Note-Taker transcription session
// (#1296). Everything deterministic — the state machine, segment bookkeeping,
// transcript assembly, message formatting and the localStorage recovery-record
// shape — lives here so it can be exercised with `node --test` without React,
// a DOM or a MediaRecorder (same convention as
// message-send-keybinding.js). The provider
// (TranscriptionSessionContext.jsx) is the thin browser adapter that owns the
// MediaStream, timers and fetch and drives these functions.

// Default segment length. A meeting is captured as a chain of standalone,
// individually-decodable webm/opus blobs; each is transcribed on its own via
// the existing single-shot POST /api/transcribe. 120 s ≈ 0.5 MB — comfortably
// under the route's 10 MB cap.
export const SEGMENT_MS = 120_000;

// Number of retries (in addition to the first attempt) before a segment is
// recorded as an untranscribable gap. A single failed segment must never abort
// the session.
export const MAX_SEGMENT_RETRIES = 2;

// Placed at a segment's position when it could not be transcribed after
// retries, so the surrounding text stays positionally coherent.
export const GAP_MARKER = '[transcription gap]';

// localStorage key holding the crash/reload recovery record.
export const RECOVERY_KEY = 'transcription.recovery';

// The observable session lifecycle. `delivery-failed` is a terminal-ish state
// the overlay parks in (offering Retry / Copy) until the user resolves it.
export const STATES = Object.freeze([
  'idle',
  'recording',
  'paused',
  'stopping',
  'delivering',
  'delivery-failed',
]);

// State-machine transitions:
//   idle → recording ⇄ paused → stopping → delivering → idle
//   recording|paused —cancel→ idle              (discard)
//   recording|paused —end→ stopping             (mic ended / revoked)
//   delivering —fail→ delivery-failed
//   delivery-failed —retry→ delivering ; —discard→ idle
const TRANSITIONS = Object.freeze({
  idle: { start: 'recording' },
  recording: { pause: 'paused', stop: 'stopping', end: 'stopping', cancel: 'idle' },
  paused: { resume: 'recording', stop: 'stopping', end: 'stopping', cancel: 'idle' },
  stopping: { deliver: 'delivering' },
  delivering: { delivered: 'idle', fail: 'delivery-failed' },
  'delivery-failed': { retry: 'delivering', discard: 'idle', delivered: 'idle' },
});

/**
 * Resolve the next state for an action. Unknown/illegal transitions are a
 * no-op (return the current state) so the caller never lands in an undefined
 * state.
 * @param {string} current
 * @param {string} action
 * @returns {string}
 */
export function nextState(current, action) {
  const row = TRANSITIONS[current];
  if (row && Object.prototype.hasOwnProperty.call(row, action)) return row[action];
  return current;
}

/** True while a session is holding the mic / is mid-delivery (overlay visible). */
export function isActiveState(state) {
  return state === 'recording' || state === 'paused' || state === 'stopping' ||
    state === 'delivering' || state === 'delivery-failed';
}

/** True when the mic is (or should be) capturing audio for a new segment. */
export function isCapturingState(state) {
  return state === 'recording';
}

/**
 * A segment slot is one of:
 *   - a non-empty string : transcribed text
 *   - GAP_MARKER         : permanently failed after retries
 *   - '' (empty string)  : transcribed but silent — dropped from the transcript
 *   - null / undefined   : never resolved (lost in-flight on a crash) → gap
 *
 * @param {Array<string|null>} segments
 * @returns {string} the assembled transcript, gaps included in order.
 */
export function assembleTranscript(segments) {
  return (segments || [])
    .map(s => (s == null ? GAP_MARKER : String(s).trim()))
    .filter(part => part !== '')
    .join(' ');
}

/** Count the segment slots that carry no usable transcription (lost or gap). */
export function countGaps(segments) {
  return (segments || []).filter(s => s == null || s === GAP_MARKER).length;
}

/** Count the slots that resolved to something (text, empty or an explicit gap). */
export function countResolved(segments) {
  return (segments || []).filter(s => s !== null && s !== undefined).length;
}

/** True when at least one segment holds real, deliverable text. */
export function hasDeliverableContent(segments) {
  return (segments || []).some(s => typeof s === 'string' && s.trim() !== '' && s !== GAP_MARKER);
}

/** Whole minutes (rounded, min 1) for the transcript header. */
export function durationMinutes(ms) {
  return Math.max(1, Math.round((Number(ms) || 0) / 60_000));
}

/** M:SS elapsed label for the overlay timer. */
export function formatElapsed(totalSeconds) {
  const s = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * Build the chat message posted to the note-taker on stop.
 *
 *   🎙️ Meeting transcript — started <label>, duration <n> min
 *   <blank line>
 *   <assembled text>
 *   <blank line, only if notes>
 *   (recording was interrupted — this is a partial transcript)
 *   (<n> segment(s) could not be transcribed)
 *
 * @param {{startedAtLabel:string, durationMin:number, transcript:string,
 *          gapCount?:number, interrupted?:boolean}} params
 * @returns {string}
 */
export function formatTranscriptMessage({ startedAtLabel, durationMin, transcript, gapCount = 0, interrupted = false }) {
  const lines = [
    `🎙️ Transcript — started ${startedAtLabel}, duration ${durationMin} min`,
    '',
    transcript && transcript.trim() ? transcript : '(no speech was transcribed)',
  ];
  const notes = [];
  if (interrupted) notes.push('(recording was interrupted — this is a partial transcript)');
  if (gapCount > 0) notes.push(`(${gapCount} segment${gapCount === 1 ? '' : 's'} could not be transcribed)`);
  if (notes.length) {
    lines.push('');
    lines.push(...notes);
  }
  return lines.join('\n');
}

/**
 * Build the recovery record persisted to localStorage after every transcribed
 * segment. Segment *texts* only — audio blobs are never persisted.
 */
export function buildRecoveryRecord({ tabId, agentId, agentName, startedAt, segments, updatedAt }) {
  return {
    v: 1,
    tabId: tabId || null,
    agentId,
    agentName: agentName || agentId,
    startedAt: startedAt || null,
    // Coerce each slot to a JSON-safe string|null (drop undefined/gap-vs-null
    // ambiguity is fine: a gap round-trips as the GAP_MARKER string).
    segments: (segments || []).map(s => (typeof s === 'string' ? s : null)),
    updatedAt: updatedAt ?? Date.now(),
  };
}

/**
 * Parse a raw localStorage value into a validated recovery record, or null if
 * it is missing / malformed / carries no agent + segment array.
 */
export function parseRecoveryRecord(raw) {
  if (raw == null) return null;
  let obj = raw;
  if (typeof raw === 'string') {
    try { obj = JSON.parse(raw); } catch { return null; }
  }
  if (!obj || typeof obj !== 'object') return null;
  if (!obj.agentId || !Array.isArray(obj.segments)) return null;
  return {
    v: obj.v || 1,
    tabId: obj.tabId || null,
    agentId: String(obj.agentId),
    agentName: obj.agentName ? String(obj.agentName) : String(obj.agentId),
    startedAt: obj.startedAt || null,
    segments: obj.segments.map(s => (typeof s === 'string' ? s : null)),
    updatedAt: obj.updatedAt || null,
  };
}

/**
 * Whether a persisted record should surface the recovery banner. A session
 * carries a per-tab id; on a fresh mount the provider generates a new one, so
 * any existing record (foreign tab or same tab after a hard reload) that still
 * holds deliverable text is offered for recovery.
 */
export function shouldOfferRecovery(record, currentTabId) {
  if (!record) return false;
  if (currentTabId && record.tabId && record.tabId === currentTabId) {
    // Same live tab wrote this in the current session — not a recovery case
    // (the live session UI already covers it). Guards last-writer-wins so a
    // foreign record is never silently treated as our own.
    return false;
  }
  return hasDeliverableContent(record.segments);
}
