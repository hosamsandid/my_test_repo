import React, { useEffect, useRef, useState } from 'react';
import { Send, Paperclip, Loader2, Mic, Square, Repeat, ChevronDown, Radio } from 'lucide-react';
import useVoiceRecorder from '../../hooks/useVoiceRecorder.js';
import LoopSummaryCard from './LoopSummaryCard';
import {
  isMacPlatform,
  loadSendKeybinding,
  saveSendKeybinding,
  decideSendKey,
  placeholderSendHint,
  helperSendKeys,
} from './message-send-keybinding.js';
import { loadDraft, saveDraft, clearDraft } from './message-draft.js';
import { decideComposerAction } from './composer-action.js';

// OS-aware modifier idiom (shared with RightRail.jsx): Cmd on Mac, Ctrl else.
const IS_MAC = isMacPlatform();

/**
 * Auto-resizing textarea with a send button and inline file attachments.
 *
 * Send keybinding (#1354) is user-configurable via `agentChat.sendKeybinding`:
 *   - 'ide'  (default): Cmd/Ctrl + Enter ⇒ submit; plain Enter ⇒ newline
 *   - 'chat'          : plain Enter ⇒ submit; Shift + Enter ⇒ newline
 * The placeholder + helper row reflect both the active preset and the OS, so
 * Windows/Linux users see `Ctrl` rather than the Mac-only `⌘` glyph.
 *
 * Attachments: drag-and-drop files onto the composer, paste files from the
 * clipboard, or use the paperclip button. Each file is uploaded into the
 * agent's `chat-uploads/` directory via `onUpload` and a
 * `@chat-uploads/<name>` reference is inserted into the draft at the caret —
 * the agent's cwd is its workspace root, so that token resolves to a file it
 * can open.
 *
 * Auto-resize: line height ~20 px, min 1 row, max 8 rows; we measure via
 * scrollHeight after each input event and clamp.
 *
 * Draft persistence (#1388): because `AgentChat.jsx` remounts this component on
 * every agent switch (`key={selectedAgent.id}`), the composer's local `value`
 * would otherwise be destroyed and the typed draft lost. We persist the draft
 * per agent under `agentChat.draft.<agentId>` (see message-draft.js) — restored
 * on mount, cleared on a successful send.
 *
 * @param {(text:string)=>void} onSend
 * @param {boolean} [disabled]
 * @param {?string} [agentId]            persists the composer draft per agent
 * @param {string}  [agentDisplayName]   used in placeholder
 * @param {(files:FileList|File[])=>Promise<Array<{name:string,ref:string}>>} [onUpload]
 *        Uploads files and resolves to the uploaded descriptors (empty on failure).
 * @param {boolean} [uploading]          true while an upload is in flight
 * Unified Stop control (#1427): while the selected agent is busy on a
 * chat-initiated turn *or* a launched loop (`busy`), the primary-action button
 * switches from Send to a single Stop (⏹) control in the same position, and
 * `onStop` aborts whatever is running. There is exactly one stop affordance in
 * the composer — the loop control below is a launcher only, never a second Stop.
 *
 * @param {()=>void} [onLoopClick]        Launch a loop. When provided, a loop
 *        control renders immediately left of the mic (launch-only — stopping a
 *        running loop is handled by the unified Stop button, see `onStop`).
 * @param {boolean} [loopRunning]         true while a chat-launched loop runs
 * @param {boolean} [loopBusy]            true while a loop launch/stop is in flight
 * @param {?object} [loopTrigger]         the running launched-loop trigger (full config)
 * @param {?object} [loopProgress]        `{ iteration, maxIterations|null }` or null
 * @param {boolean} [busy]                true while a chat turn or loop is running
 *        for this agent — flips the primary action from Send to Stop.
 * @param {()=>void} [onStop]             Abort whatever is running (turn or loop).
 * @param {boolean} [stopBusy]            true while a stop request is in flight
 *        (disables the Stop button so a double-press can't fire two aborts).
 * @param {()=>void} [onStartMeeting]      Start a persistent meeting transcription (#1296)
 *        for this agent. When provided, a chevron next to the mic opens a
 *        "Record meeting" menu; quick dictation stays the plain mic tap.
 * @param {boolean} [meetingActive]        true while a meeting session is running
 *        anywhere in the app — disables both quick dictation and starting a
 *        second meeting (one mic use at a time).
 * @param {?{ref:string, ts:number}} [insertRefRequest]  Cross-panel request
 *        (#1699) to splice a `@<ref>` token into this agent's draft — fired by the
 *        workspace browser's "Reference in chat" button. Reuses the same
 *        caret-aware `insertRefs` path uploads use, so it obeys AC3/AC4/AC7/AC8.
 *        `ts` re-fires the effect on repeat clicks (request-object pattern,
 *        mirrors `resumeRequest`); the leading `@` is added here, so `ref` is a
 *        bare workspace-relative path with no `@`.
 */
export default function MessageInput({ onSend, disabled = false, agentId = null, agentDisplayName, onUpload, uploading = false, onLoopClick, loopRunning = false, loopBusy = false, loopTrigger = null, loopProgress = null, busy = false, onStop, stopBusy = false, onStartMeeting, meetingActive = false, insertRefRequest = null }) {
  // Seed the composer from any persisted draft for this agent (#1388). The
  // component remounts per agent (key={agent.id}) so this initialiser runs
  // fresh with the right agentId on every switch.
  const [value, setValue] = useState(() => loadDraft(agentId));
  const [dragging, setDragging] = useState(false);
  // Per-user send-keybinding preset ('ide' | 'chat'), persisted in localStorage
  // (mirrors WorkspaceBrowser's workspaceMode pattern). Defaults to 'ide' so
  // existing users keep the historic Cmd/Ctrl+Enter behaviour (#1354 AC).
  const [sendKeybinding, setSendKeybinding] = useState(() => loadSendKeybinding());
  useEffect(() => { saveSendKeybinding(sendKeybinding); }, [sendKeybinding]);
  // Meeting-mode menu (#1296): the mic becomes a split control — plain tap is
  // quick dictation (unchanged), the chevron opens a small menu to start a
  // persistent meeting transcription for this agent.
  const [meetingMenuOpen, setMeetingMenuOpen] = useState(false);
  const micGroupRef = useRef(null);
  const taRef = useRef(null);
  const fileRef = useRef(null);
  // dragenter/dragleave fire for every child element; count them so the
  // overlay only clears when the pointer truly leaves the composer.
  const dragDepth = useRef(0);
  // Track IME composition: pressing Enter while a Japanese/Chinese/Korean
  // (or any IME) candidate is active must NOT submit the message — that
  // Enter is consumed by the IME to commit the candidate.
  const composingRef = useRef(false);

  const handleTranscription = React.useCallback((text) => {
    setValue(prev => {
      if (!prev.trim()) return text;
      return prev + ' ' + text;
    });
  }, []);

  const { state: voiceState, elapsedSeconds, error: voiceError, toggleRecording, clearError } = useVoiceRecorder({
    onTranscription: handleTranscription,
  });

  // Auto-clear voice error after 3 seconds.
  React.useEffect(() => {
    if (!voiceError) return;
    const t = setTimeout(clearError, 3000);
    return () => clearTimeout(t);
  }, [voiceError, clearError]);

  useEffect(() => { autoResize(taRef.current); }, [value]);

  // Close the meeting menu on an outside click / Escape.
  useEffect(() => {
    if (!meetingMenuOpen) return undefined;
    const onDown = (e) => { if (!micGroupRef.current?.contains(e.target)) setMeetingMenuOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setMeetingMenuOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [meetingMenuOpen]);

  // Persist the draft per agent (#1388) so it survives the agent-switch remount
  // (and a page reload). saveDraft removes the key for an empty draft (AC4).
  useEffect(() => { saveDraft(agentId, value); }, [agentId, value]);

  // Auto-focus on mount and when re-enabled.
  useEffect(() => {
    if (!disabled) taRef.current?.focus();
  }, [disabled]);

  function submit() {
    const text = value.trim();
    if (!text || disabled) return;
    onSend(text);
    setValue('');
    // Drop the persisted draft immediately so the composer doesn't re-populate
    // after a send (AC2). The value effect would also clear it, but doing it
    // here keeps intent explicit and avoids relying on effect timing.
    clearDraft(agentId);
    // Refocus right away — clearing the value won't move focus on its own.
    requestAnimationFrame(() => taRef.current?.focus());
  }

  function handleKey(e) {
    // The IME guard (composing / isComposing / keyCode 229) and the preset
    // decision both live in the pure `decideSendKey`. 'send' ⇒ submit;
    // 'newline' / 'ignore' ⇒ let the textarea insert the newline.
    if (decideSendKey(e, sendKeybinding, composingRef.current) === 'send') {
      e.preventDefault();
      submit();
    }
  }

  // Insert `@chat-uploads/<name>` tokens at the caret (or replace the
  // selection), padding with spaces so each reference stays a discrete token.
  function insertRefs(refs) {
    if (!refs.length) return;
    const snippet = refs.map(r => `@${r.ref}`).join(' ');
    const ta = taRef.current;
    setValue(prev => {
      const start = ta?.selectionStart ?? prev.length;
      const end = ta?.selectionEnd ?? prev.length;
      const before = prev.slice(0, start);
      const after = prev.slice(end);
      const lead = before && !/\s$/.test(before) ? ' ' : '';
      const trail = /^\s/.test(after) ? '' : ' ';
      const next = `${before}${lead}${snippet}${trail}${after}`;
      // Restore the caret just after the inserted snippet on the next frame.
      const caret = (before + lead + snippet + trail).length;
      requestAnimationFrame(() => {
        if (ta) { ta.focus(); ta.setSelectionRange(caret, caret); }
      });
      return next;
    });
  }

  async function doUpload(files) {
    const list = Array.from(files || []);
    if (!onUpload || disabled || list.length === 0) return;
    const uploaded = await onUpload(list);
    if (Array.isArray(uploaded) && uploaded.length) insertRefs(uploaded);
  }

  // Cross-panel "Reference in chat" (#1699): the workspace browser pushes a
  // `{ ref, ts }` request; we splice `@<ref>` into the draft through the same
  // caret-aware `insertRefs` uploads use. Seeding the ref with the incoming ts
  // means a request already present when this composer mounts (e.g. left over on
  // an agent switch) is NOT re-inserted — only a genuinely new ts fires, so an
  // insertion always targets the currently selected agent's draft (edge case).
  const lastInsertRefTs = useRef(insertRefRequest?.ts ?? null);
  useEffect(() => {
    const ts = insertRefRequest?.ts;
    if (!ts || ts === lastInsertRefTs.current) return;
    lastInsertRefTs.current = ts;
    if (insertRefRequest.ref) insertRefs([{ ref: insertRefRequest.ref }]);
    // insertRefs is a stable closure over refs (taRef/setValue); it needs no dep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [insertRefRequest]);

  const hasFiles = (e) => Array.from(e.dataTransfer?.types || []).includes('Files');

  function handleDragEnter(e) {
    if (!onUpload || disabled || !hasFiles(e)) return;
    e.preventDefault();
    dragDepth.current += 1;
    setDragging(true);
  }
  function handleDragOver(e) {
    if (!onUpload || disabled || !hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }
  function handleDragLeave() {
    if (!onUpload || disabled) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  }
  function handleDrop(e) {
    if (!onUpload || disabled) return;
    e.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    const files = e.dataTransfer?.files;
    if (files && files.length) doUpload(files);
  }
  function handlePaste(e) {
    if (!onUpload || disabled) return;
    const files = e.clipboardData?.files;
    if (files && files.length) {
      e.preventDefault(); // don't also paste the file as a text/image blob
      doUpload(files);
    }
  }

  // OS- and preset-aware send hint, e.g. '⌘↩ to send' (Mac/IDE),
  // 'Ctrl+↩ to send' (Windows/IDE) or '↩ to send' (chat style).
  const sendHint = placeholderSendHint(sendKeybinding, IS_MAC);
  const placeholder = agentDisplayName
    ? `Message ${agentDisplayName}…  (${sendHint})`
    : `Message…  (${sendHint})`;
  const keys = helperSendKeys(sendKeybinding, IS_MAC);

  // Loop launcher discoverability (#1120): name the otherwise icon-only loop
  // control in the composer helper line so newcomers know what it does.
  const loopHint = onLoopClick
    ? <> · <Repeat size={11} style={{ verticalAlign: '-1px' }} /> runs a loop until a goal is met</>
    : null;

  const canAttach = !!onUpload && !disabled && !uploading;
  // The loop control is a launcher only (#1427): stopping a running loop moves
  // to the unified Stop button in the primary-action position, so the loop
  // button is disabled whenever the agent is already busy (a turn or a loop is
  // running) or the composer is disabled — you can't launch a second loop.
  const canLoop = !!onLoopClick && !loopBusy && !busy && !disabled;

  // Primary-action button: Send when idle, a single unified Stop while the
  // agent is busy on a turn or loop (#1427). Decision is the pure
  // `decideComposerAction` so it stays unit-testable.
  const primary = decideComposerAction({
    busy,
    canStop: !!onStop,
    hasText: !!value.trim(),
    disabled,
    stopBusy,
  });
  const showStop = primary.mode === 'stop';

  return (
    <div style={{
      borderTop: '1px solid var(--eb-border-default)',
      padding: 'var(--eb-space-3) var(--eb-space-4)',
      background: 'var(--eb-bg-surface)',
      flexShrink: 0,
    }}>
      {(voiceState === 'recording' || loopRunning || showStop) && (
        <style>{'@keyframes stt-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }'}</style>
      )}
      {/* Running-loop transparency (#1155): a collapsed summary the user can
          expand to review the loop's prompt, stop contract, verifier and live
          progress — reachable at the moment of stopping, without extra clicks. */}
      {loopRunning && loopTrigger && (
        <LoopSummaryCard trigger={loopTrigger} progress={loopProgress} />
      )}
      <div
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        style={{
          position: 'relative',
          display: 'flex',
          alignItems: 'flex-end',
          gap: 'var(--eb-space-2)',
          background: 'var(--eb-bg-elevated)',
          border: `1px solid ${dragging ? 'var(--eb-accent-primary)' : 'var(--eb-border-default)'}`,
          borderRadius: 'var(--eb-radius-md)',
          padding: 'var(--eb-space-2)',
          transition: 'border-color var(--eb-transition-fast)',
        }}
      >
        {dragging && (
          <div style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 'var(--eb-space-2)',
            background: 'var(--eb-status-info-bg, var(--eb-bg-hover))',
            border: '2px dashed var(--eb-accent-primary)',
            borderRadius: 'var(--eb-radius-md)',
            color: 'var(--eb-accent-primary)',
            fontSize: 'var(--eb-text-sm)',
            fontWeight: 'var(--eb-font-medium)',
            pointerEvents: 'none',
            zIndex: 2,
          }}>
            <Paperclip size={16} /> Drop files to attach
          </div>
        )}

        {onUpload && (
          <>
            <input
              ref={fileRef}
              type="file"
              multiple
              hidden
              onChange={e => { doUpload(e.target.files); e.target.value = ''; }}
            />
            <button
              onClick={() => fileRef.current?.click()}
              disabled={!canAttach}
              aria-label="Attach files"
              title="Attach files"
              style={{
                width: 32, height: 32,
                background: 'transparent',
                color: canAttach ? 'var(--eb-text-secondary)' : 'var(--eb-text-muted)',
                border: 'none',
                borderRadius: 'var(--eb-radius-md)',
                cursor: canAttach ? 'pointer' : 'not-allowed',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                flexShrink: 0,
              }}
            >
              {uploading
                ? <Loader2 size={16} style={{ animation: 'spin 0.8s linear infinite' }} />
                : <Paperclip size={16} />}
            </button>
          </>
        )}

        <textarea
          ref={taRef}
          value={value}
          disabled={disabled}
          onChange={e => setValue(e.target.value)}
          onKeyDown={handleKey}
          onPaste={handlePaste}
          onCompositionStart={() => { composingRef.current = true; }}
          onCompositionEnd={()   => { composingRef.current = false; }}
          placeholder={placeholder}
          rows={1}
          style={{
            flex: 1,
            background: 'transparent',
            border: 'none',
            outline: 'none',
            resize: 'none',
            color: 'var(--eb-text-primary)',
            fontFamily: 'inherit',
            fontSize: 'var(--eb-text-md)',
            lineHeight: 1.5,
            maxHeight: '20em', // ~8 rows of body text
            minHeight: '1.5em',
            padding: '4px 6px',
          }}
        />
        {onLoopClick && (
          <button
            onClick={() => canLoop && onLoopClick()}
            disabled={!canLoop}
            aria-label="Start a loop"
            title={loopRunning
              ? 'A loop is running — use Stop to end it'
              : busy
                ? 'Agent is busy — wait for the turn to finish'
                : 'Start a loop — run this agent until the goal is met'}
            style={{
              width: 32, height: 32,
              background: 'transparent',
              color: canLoop ? 'var(--eb-text-secondary)' : 'var(--eb-text-muted)',
              border: 'none',
              borderRadius: 'var(--eb-radius-md)',
              cursor: canLoop ? 'pointer' : 'not-allowed',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            {loopBusy
              ? <Loader2 size={15} style={{ animation: 'spin 0.8s linear infinite' }} />
              : <Repeat size={15} />}
          </button>
        )}
        <div style={{ display: 'flex', alignItems: 'center', flexShrink: 0, gap: 4 }}>
          {voiceState === 'recording' && (
            <span style={{
              fontSize: 'var(--eb-text-xs)',
              color: 'var(--eb-status-error-text, #dc2626)',
              whiteSpace: 'nowrap',
              fontVariantNumeric: 'tabular-nums',
            }}>
              {Math.floor(elapsedSeconds / 60)}:{String(elapsedSeconds % 60).padStart(2, '0')}
            </span>
          )}
          <div ref={micGroupRef} style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
            <button
              onClick={toggleRecording}
              disabled={disabled || voiceState === 'transcribing' || meetingActive}
              aria-label={voiceState === 'recording' ? 'Stop recording' : voiceState === 'transcribing' ? 'Transcribing…' : 'Record voice message'}
              title={meetingActive
                ? 'A meeting transcription is already running'
                : voiceState === 'recording' ? 'Stop recording' : voiceState === 'transcribing' ? 'Transcribing…' : 'Voice input (tap to dictate)'}
              style={{
                width: 32, height: 32,
                background: voiceState === 'recording' ? 'var(--eb-status-error-bg, #fef2f2)' : 'transparent',
                color: voiceState === 'recording'
                  ? 'var(--eb-status-error-text, #dc2626)'
                  : (voiceState === 'transcribing' || meetingActive)
                    ? 'var(--eb-text-muted)'
                    : 'var(--eb-text-secondary)',
                border: 'none',
                borderRadius: 'var(--eb-radius-md)',
                cursor: (disabled || voiceState === 'transcribing' || meetingActive) ? 'not-allowed' : 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                flexShrink: 0,
                animation: voiceState === 'recording' ? 'stt-pulse 1.5s ease-in-out infinite' : 'none',
              }}
            >
              {voiceState === 'recording'
                ? <Square size={14} />
                : voiceState === 'transcribing'
                  ? <Loader2 size={14} style={{ animation: 'spin 0.8s linear infinite' }} />
                  : <Mic size={14} />}
            </button>
            {/* Meeting-mode chevron (#1296). Only when the host wires meetings. */}
            {onStartMeeting && (
              <button
                onClick={() => setMeetingMenuOpen(o => !o)}
                aria-label="Meeting transcription options"
                aria-haspopup="menu"
                aria-expanded={meetingMenuOpen}
                title="Meeting transcription"
                style={{
                  width: 16, height: 32,
                  background: 'transparent',
                  color: 'var(--eb-text-secondary)',
                  border: 'none', borderRadius: 'var(--eb-radius-md)',
                  cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  flexShrink: 0, padding: 0,
                }}
              >
                <ChevronDown size={12} />
              </button>
            )}
            {meetingMenuOpen && onStartMeeting && (
              <div
                role="menu"
                style={{
                  position: 'absolute',
                  bottom: 'calc(100% + 6px)',
                  right: 0,
                  minWidth: 240,
                  background: 'var(--eb-bg-surface)',
                  border: '1px solid var(--eb-border-default)',
                  borderRadius: 'var(--eb-radius-md)',
                  boxShadow: 'var(--eb-shadow-lg, 0 8px 24px rgba(0,0,0,0.24))',
                  padding: 'var(--eb-space-1)',
                  zIndex: 20,
                }}
              >
                <button
                  role="menuitem"
                  disabled={meetingActive}
                  onClick={() => { setMeetingMenuOpen(false); onStartMeeting(); }}
                  title={meetingActive ? 'A meeting transcription is already running' : undefined}
                  style={{
                    display: 'flex', alignItems: 'flex-start', gap: 8, width: '100%',
                    background: 'transparent', border: 'none', textAlign: 'left',
                    padding: 'var(--eb-space-2)', borderRadius: 'var(--eb-radius-sm)',
                    cursor: meetingActive ? 'not-allowed' : 'pointer',
                    color: meetingActive ? 'var(--eb-text-muted)' : 'var(--eb-text-primary)',
                    fontFamily: 'inherit', fontSize: 'var(--eb-text-sm)',
                  }}
                  onMouseEnter={e => { if (!meetingActive) e.currentTarget.style.background = 'var(--eb-bg-hover)'; }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                >
                  <Radio size={15} style={{ marginTop: 1, flexShrink: 0 }} />
                  <span style={{ minWidth: 0 }}>
                    <span style={{ display: 'block', fontWeight: 'var(--eb-font-medium)' }}>
                      Record meeting{agentDisplayName ? ` for ${agentDisplayName}` : ''}
                    </span>
                    <span style={{ display: 'block', fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', lineHeight: 1.35 }}>
                      {meetingActive
                        ? 'A meeting transcription is already running'
                        : 'Keeps recording as you move around Agent Studio; the transcript is sent here when you stop.'}
                    </span>
                  </span>
                </button>
              </div>
            )}
          </div>
        </div>
        <button
          onClick={showStop ? (() => primary.enabled && onStop?.()) : submit}
          disabled={!primary.enabled}
          aria-label={showStop ? (loopRunning ? 'Stop the running loop' : 'Stop the running turn') : 'Send message'}
          title={showStop
            ? (loopRunning ? 'Stop the running loop' : 'Stop the running turn')
            : (sendKeybinding === 'chat' ? 'Send (Enter)' : 'Send (Cmd/Ctrl + Enter)')}
          style={{
            width: 32, height: 32,
            background: showStop
              ? 'var(--eb-status-error-bg, #fef2f2)'
              : primary.enabled ? 'var(--eb-accent-primary)' : 'var(--eb-bg-active)',
            color: showStop
              ? 'var(--eb-status-error-text, #dc2626)'
              : primary.enabled ? 'var(--eb-text-inverted)' : 'var(--eb-text-muted)',
            border: 'none',
            borderRadius: 'var(--eb-radius-md)',
            cursor: primary.enabled ? 'pointer' : 'not-allowed',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            flexShrink: 0,
            transition: 'background var(--eb-transition-fast)',
            animation: (showStop && primary.enabled) ? 'stt-pulse 1.6s ease-in-out infinite' : 'none',
          }}
        >
          {showStop
            ? (stopBusy
                ? <Loader2 size={14} style={{ animation: 'spin 0.8s linear infinite' }} />
                : <Square size={14} />)
            : <Send size={14} />}
        </button>
      </div>

      <div style={{
        fontSize: 'var(--eb-text-xs)',
        color: voiceError ? 'var(--eb-status-error-text, #dc2626)' : 'var(--eb-text-muted)',
        marginTop: 'var(--eb-space-1)',
        paddingLeft: 'var(--eb-space-1)',
        transition: 'color var(--eb-transition-fast)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 'var(--eb-space-2)',
      }}>
        <span>
          {voiceError
            ? voiceError
            : voiceState === 'transcribing'
              ? 'Transcribing…'
              : uploading
                ? 'Uploading attachment…'
                : onUpload
                  ? <>Markdown supported · attach with <Paperclip size={11} style={{ verticalAlign: '-1px' }} />, drag &amp; drop, or paste (<kbd style={kbdStyle}>⌘</kbd>/<kbd style={kbdStyle}>Ctrl</kbd>+<kbd style={kbdStyle}>V</kbd>) · {renderKbd(keys.send)} to send{loopHint}</>
                  : <>Markdown supported · {renderKbd(keys.send)} to send · {renderKbd(keys.newline)} for newline{loopHint}</>}
        </span>
        {/* Discoverable per-user send-behaviour toggle (#1354). Kept in the
            composer so the hints above always match the live choice. */}
        <label style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0, whiteSpace: 'nowrap' }}>
          <span>Enter:</span>
          <select
            value={sendKeybinding}
            onChange={e => setSendKeybinding(e.target.value)}
            aria-label="Enter key sends or inserts a newline"
            title="Choose what pressing Enter does. IDE style keeps Enter for newlines; Chat style sends on Enter."
            style={selectStyle}
          >
            <option value="ide">{IS_MAC ? '⌘' : 'Ctrl'}+↩ sends</option>
            <option value="chat">↩ sends</option>
          </select>
        </label>
      </div>
    </div>
  );
}

// Render an ordered list of key tokens as <kbd> chips joined by '+'.
function renderKbd(tokens) {
  return tokens.map((k, i) => (
    <React.Fragment key={`${k}-${i}`}>
      {i > 0 && '+'}
      <kbd style={kbdStyle}>{k}</kbd>
    </React.Fragment>
  ));
}

function autoResize(el) {
  if (!el) return;
  // Reset to min so shrinking works after deletion.
  el.style.height = 'auto';
  // Cap at maxHeight (set in style); CSS will clip the visual height.
  el.style.height = `${Math.min(el.scrollHeight, 320)}px`;
}

const kbdStyle = {
  fontFamily: 'var(--eb-font-mono)',
  fontSize: '0.85em',
  padding: '0 4px',
  background: 'var(--eb-bg-elevated)',
  border: '1px solid var(--eb-border-default)',
  borderRadius: 'var(--eb-radius-sm)',
};

const selectStyle = {
  fontFamily: 'inherit',
  fontSize: 'var(--eb-text-xs)',
  color: 'var(--eb-text-secondary)',
  background: 'var(--eb-bg-elevated)',
  border: '1px solid var(--eb-border-default)',
  borderRadius: 'var(--eb-radius-sm)',
  padding: '1px 4px',
  cursor: 'pointer',
};
