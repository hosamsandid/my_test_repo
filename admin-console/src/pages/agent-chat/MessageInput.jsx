import React, { useEffect, useRef, useState } from 'react';
import { Send, Paperclip, Loader2, Mic, Square, Repeat, ChevronDown, Radio } from 'lucide-react';
import useVoiceRecorder from '../../hooks/useVoiceRecorder.js';
import LoopSummaryCard from './LoopSummaryCard';
import Tooltip from '../../components/Tooltip.jsx';
import PageHelpButton from '../../components/PageHelpButton';
import { AGENT_CHAT_HELP_SECTIONS } from './agent-chat-help-sections.js';
import {
  isMacPlatform,
  loadSendKeybinding,
  decideSendKey,
  placeholderSendHint,
  SEND_KEYBINDING_CHANGED_EVENT,
} from './message-send-keybinding.js';
import { loadDraft, saveDraft, clearDraft, restoreUnsentText } from './message-draft.js';
import { decideComposerAction } from './composer-action.js';
import { commandQuery, filterCommands, commandInsertion, nextIndex } from './command-palette.js';
import { apiCall } from '../../hooks/useApi.js';
import ComposerAttachments from './ComposerAttachments.jsx';
import {
  partitionFiles,
  createAttachment,
  addAttachments,
  markUploading,
  markUploaded,
  markFailed,
  removeAttachment,
  anyUploading,
  removeRefToken,
  pruneToDraft,
} from './composer-attachments.js';

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
 * Image previews (#2567): each attached raster image also gets a card in a
 * tray above the input row, shown from the local file straight away, with
 * uploading / uploaded / failed (Retry) states and a Remove control. Images
 * upload one request each so every card has its own outcome; other files are
 * uploaded as one batch, as before. The tray follows the draft: deleting an
 * uploaded image's `@chat-uploads/<name>` token drops its card, removing the
 * card drops the token, and a send clears it. Send is blocked while any
 * attachment is still uploading. Model: composer-attachments.js.
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
 * @param {(text:string)=>(void|boolean|Promise<void|boolean>)} onSend  resolves false when the text was not sent
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
  // Per-user send-keybinding preset ('ide' | 'chat'), persisted in localStorage.
  // Defaults to 'ide' so existing users keep the historic Cmd/Ctrl+Enter
  // behaviour (#1354 AC). The preset is now *configured* in Settings → Behavior
  // (#1804) — the composer is a read-only consumer that re-reads it on the
  // same-tab change signal (AC3, immediate effect without reload) and on the
  // cross-tab `storage` event, so the send behaviour, placeholder hint and Send
  // tooltip (UX-2, AC5) always reflect the chosen mode.
  const [sendKeybinding, setSendKeybinding] = useState(() => loadSendKeybinding());
  useEffect(() => {
    const sync = () => setSendKeybinding(loadSendKeybinding());
    window.addEventListener(SEND_KEYBINDING_CHANGED_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(SEND_KEYBINDING_CHANGED_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);
  // Slash-command autocomplete (#1797). The commands provisioned in the selected
  // agent's workspace, fetched from `GET /api/agents/:id/commands` (name +
  // optional description). Refetched whenever the agent changes (AC4); starts
  // empty so an agent with no commands never flashes an empty palette. Fail-soft:
  // a failed/aborted fetch simply leaves the palette dormant.
  const [commands, setCommands] = useState([]);
  useEffect(() => {
    if (!agentId) { setCommands([]); return undefined; }
    let alive = true;
    setCommands([]); // clear stale commands from the previous agent before refetch
    apiCall('GET', `/api/agents/${encodeURIComponent(agentId)}/commands`)
      .then(resp => { if (alive) setCommands(Array.isArray(resp?.commands) ? resp.commands : []); })
      .catch(() => { if (alive) setCommands([]); });
    return () => { alive = false; };
  }, [agentId]);

  // Palette derivation (pure decisions in command-palette.js). The palette opens
  // only when the whole composer value is a leading `/token` (AC2) — never for a
  // slash typed mid-message. `paletteDismissed` lets Esc close it without wiping
  // the typed text; it re-arms as soon as the query changes.
  const query = disabled ? null : commandQuery(value);
  const matches = React.useMemo(
    () => (query != null ? filterCommands(commands, query) : []),
    [query, commands],
  );
  const [activeIdx, setActiveIdx] = useState(0);
  const [paletteDismissed, setPaletteDismissed] = useState(false);
  const paletteOpen = query != null && matches.length > 0 && !paletteDismissed;
  // A new query resets the highlight to the top and re-arms a dismissed palette.
  useEffect(() => { setActiveIdx(0); setPaletteDismissed(false); }, [query]);
  const activeRowRef = useRef(null);
  useEffect(() => {
    if (paletteOpen) activeRowRef.current?.scrollIntoView({ block: 'nearest' });
  }, [activeIdx, paletteOpen]);

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

  // Image attachments of the current draft (#2567). The list holds the
  // serialisable card state; the local File and its object URL live in
  // `attachmentFiles` (id → { file, previewUrl }) and are released when a card
  // goes away. The composer remounts per agent, so nothing leaks across agents.
  const [attachments, setAttachments] = useState([]);
  const attachmentFiles = useRef(new Map());
  const nextAttachmentId = useRef(0);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    const files = attachmentFiles.current;
    return () => {
      mountedRef.current = false;
      for (const { previewUrl } of files.values()) revokePreviewUrl(previewUrl);
      files.clear();
    };
  }, []);

  function releaseAttachment(id) {
    const entry = attachmentFiles.current.get(id);
    if (!entry) return;
    revokePreviewUrl(entry.previewUrl);
    attachmentFiles.current.delete(id);
  }

  // AC10: an uploaded image whose token the user deleted from the text loses
  // its card. Runs after the render that changed either side, so a freshly
  // inserted token and its 'uploaded' mark (set in the same batch) agree.
  useEffect(() => {
    const next = pruneToDraft(attachments, value);
    if (next === attachments) return;
    for (const a of attachments) if (!next.includes(a)) releaseAttachment(a.id);
    setAttachments(next);
  }, [value, attachments]);

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
    if (!text || disabled || attachmentsUploading) return;
    // A refused send (onSend resolves false — e.g. the chat identity is not
    // ready yet, #2721 AC5) gives the typed text back instead of losing it.
    Promise.resolve(onSend(text)).then((sent) => {
      if (sent === false) setValue(v => restoreUnsentText(v, text));
    }, () => {});
    setValue('');
    // The sent draft's attachment previews go with it (AC9).
    for (const a of attachments) releaseAttachment(a.id);
    setAttachments([]);
    // Drop the persisted draft immediately so the composer doesn't re-populate
    // after a send (AC2). The value effect would also clear it, but doing it
    // here keeps intent explicit and avoids relying on effect timing.
    clearDraft(agentId);
    // Refocus right away — clearing the value won't move focus on its own.
    requestAnimationFrame(() => taRef.current?.focus());
  }

  // Replace the leading `/token` with the picked command's invocation + a
  // trailing space, caret positioned for arguments (AC3). Closing is implicit —
  // the inserted trailing space makes `commandQuery` return null.
  function chooseCommand(cmd) {
    if (!cmd) return;
    const { value: next, caret } = commandInsertion(cmd);
    setValue(next);
    setPaletteDismissed(true);
    requestAnimationFrame(() => {
      const ta = taRef.current;
      if (ta) { ta.focus(); ta.setSelectionRange(caret, caret); }
    });
  }

  function handleKey(e) {
    // Command palette owns the arrow/Enter/Esc/Tab keys while it is open (AC5),
    // so it must run BEFORE the send decision — otherwise the 'chat' preset's
    // plain-Enter-to-send would fire instead of selecting the highlighted
    // command. The IME guard mirrors `decideSendKey` so an Enter that commits a
    // composition candidate never selects.
    if (paletteOpen) {
      const composing = composingRef.current || (e.nativeEvent && e.nativeEvent.isComposing);
      if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIdx(i => nextIndex(i, 1, matches.length)); return; }
      if (e.key === 'ArrowUp')   { e.preventDefault(); setActiveIdx(i => nextIndex(i, -1, matches.length)); return; }
      if (e.key === 'Escape')    { e.preventDefault(); setPaletteDismissed(true); return; }
      if ((e.key === 'Enter' || e.key === 'Tab') && !composing) {
        e.preventDefault();
        chooseCommand(matches[activeIdx] || matches[0]);
        return;
      }
    }
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
    const { images, others } = partitionFiles(list);
    // Cards appear before any upload starts (AC2), in attach order (AC7).
    const added = images.map(file => {
      const id = ++nextAttachmentId.current;
      attachmentFiles.current.set(id, { file, previewUrl: createPreviewUrl(file) });
      return createAttachment(id, file);
    });
    if (added.length) setAttachments(prev => addAttachments(prev, added));
    if (others.length) {
      const uploaded = await onUpload(others);
      if (Array.isArray(uploaded) && uploaded.length) insertRefs(uploaded);
    }
    // One request per image, sequentially, so each card gets its own outcome
    // and the references land in attach order.
    for (const a of added) await uploadAttachment(a.id);
  }

  async function uploadAttachment(id) {
    const entry = attachmentFiles.current.get(id);
    if (!entry || !onUpload) return;
    const uploaded = await onUpload([entry.file]);
    // Removed while uploading, or the composer unmounted (agent switch):
    // drop the result rather than insert a reference nobody asked for.
    if (!mountedRef.current || !attachmentFiles.current.has(id)) return;
    const first = Array.isArray(uploaded) ? uploaded[0] : null;
    if (first?.ref) {
      insertRefs([first]);
      setAttachments(prev => markUploaded(prev, id, first.ref));
    } else {
      setAttachments(prev => markFailed(prev, id));
    }
  }

  function retryAttachment(id) {
    if (!onUpload || disabled) return;
    setAttachments(prev => markUploading(prev, id));
    uploadAttachment(id);
  }

  function removeAttachmentCard(id) {
    const card = attachments.find(a => a.id === id);
    releaseAttachment(id);
    setAttachments(prev => removeAttachment(prev, id));
    // AC6: an uploaded image's reference leaves the draft with its card.
    if (card?.status === 'uploaded' && card.ref) setValue(prev => removeRefToken(prev, card.ref));
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
  const canAttach = !!onUpload && !disabled && !uploading;
  // AC11: no send while any attachment (batch or image card) is uploading.
  const attachmentsUploading = uploading || anyUploading(attachments);
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
    uploading: attachmentsUploading,
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
      <ComposerAttachments
        attachments={attachments.map(a => ({ ...a, previewUrl: attachmentFiles.current.get(a.id)?.previewUrl ?? null }))}
        agentId={agentId}
        onRemove={removeAttachmentCard}
        onRetry={retryAttachment}
      />
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

        {/* Slash-command palette (#1797). Opens upward (the composer sits at the
            bottom of the chat), filters as the user types after `/`, and inserts
            `/<command> ` on select. Rows are mouse-selectable (onMouseDown +
            preventDefault so the textarea keeps focus). Long lists scroll. */}
        {paletteOpen && (
          <div
            role="listbox"
            aria-label="Slash commands"
            style={{
              position: 'absolute',
              bottom: 'calc(100% + 6px)',
              left: 0,
              right: 0,
              maxHeight: 260,
              overflowY: 'auto',
              background: 'var(--eb-bg-surface)',
              border: '1px solid var(--eb-border-default)',
              borderRadius: 'var(--eb-radius-md)',
              boxShadow: 'var(--eb-shadow-lg, 0 8px 24px rgba(0,0,0,0.24))',
              padding: 'var(--eb-space-1)',
              zIndex: 30,
            }}
          >
            {matches.map((cmd, i) => {
              const active = i === activeIdx;
              return (
                <div
                  key={cmd.command || cmd.invocation || i}
                  ref={active ? activeRowRef : null}
                  role="option"
                  aria-selected={active}
                  onMouseDown={(e) => { e.preventDefault(); chooseCommand(cmd); }}
                  onMouseEnter={() => setActiveIdx(i)}
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 1,
                    padding: 'var(--eb-space-2)',
                    borderRadius: 'var(--eb-radius-sm)',
                    cursor: 'pointer',
                    background: active ? 'var(--eb-bg-hover)' : 'transparent',
                  }}
                >
                  <span style={{
                    fontFamily: 'var(--eb-font-mono, monospace)',
                    fontSize: 'var(--eb-text-sm)',
                    color: 'var(--eb-text-primary)',
                    fontWeight: 'var(--eb-font-medium)',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}>
                    {cmd.invocation || `/${cmd.command}`}
                  </span>
                  {cmd.description && (
                    <span style={{
                      fontSize: 'var(--eb-text-xs)',
                      color: 'var(--eb-text-muted)',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}>
                      {cmd.description}
                    </span>
                  )}
                </div>
              );
            })}
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
            <Tooltip label={IS_MAC ? 'Attach file — drag & drop or paste (⌘+V)' : 'Attach file — drag & drop or paste (Ctrl+V)'}>
              <button
                onClick={() => fileRef.current?.click()}
                disabled={!canAttach}
                aria-label={IS_MAC ? 'Attach file — drag & drop or paste (⌘+V)' : 'Attach file — drag & drop or paste (Ctrl+V)'}
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
            </Tooltip>
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
          <Tooltip label={
            loopRunning ? 'A loop is running — use Stop to end it' :
            busy ? 'Agent is busy — wait for the turn to finish' :
            'Run a loop — repeats until the goal is met'
          }>
            <button
              onClick={() => canLoop && onLoopClick()}
              disabled={!canLoop}
              aria-label={
                loopRunning ? 'A loop is running — use Stop to end it' :
                busy ? 'Agent is busy — wait for the turn to finish' :
                'Run a loop — repeats until the goal is met'
              }
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
          </Tooltip>
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
            <Tooltip label={
              meetingActive ? 'A transcription is already running' :
              voiceState === 'recording' ? 'Stop recording' :
              voiceState === 'transcribing' ? 'Transcribing…' :
              'Dictate message'
            }>
            <button
              onClick={toggleRecording}
              disabled={disabled || voiceState === 'transcribing' || meetingActive}
              aria-label={
                voiceState === 'recording' ? 'Stop recording' :
                voiceState === 'transcribing' ? 'Transcribing…' :
                meetingActive ? 'A transcription is already running' :
                'Dictate message'
              }
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
            </Tooltip>
            {/* Meeting-mode chevron (#1296). Only when the host wires meetings. */}
            {onStartMeeting && (
              <button
                onClick={() => setMeetingMenuOpen(o => !o)}
                aria-label="Transcription options"
                aria-haspopup="menu"
                aria-expanded={meetingMenuOpen}
                title="Transcription"
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
                  title={meetingActive ? 'A transcription is already running' : undefined}
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
                      Record transcript{agentDisplayName ? ` for ${agentDisplayName}` : ''}
                    </span>
                    <span style={{ display: 'block', fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', lineHeight: 1.35 }}>
                      {meetingActive
                        ? 'A transcription is already running'
                        : 'Keeps recording as you move around Agent Studio; the transcript is sent here when you stop.'}
                    </span>
                  </span>
                </button>
              </div>
            )}
          </div>
        </div>
        <Tooltip label={
          showStop
            ? (loopRunning ? 'Stop the running loop' : 'Stop the running turn')
            : sendKeybinding === 'chat' ? 'Send — ↵' : IS_MAC ? 'Send — ⌘+↵' : 'Send — Ctrl+↵'
        }>
          <button
            onClick={showStop ? (() => primary.enabled && onStop?.()) : submit}
            disabled={!primary.enabled}
            aria-label={
              showStop
                ? (loopRunning ? 'Stop the running loop' : 'Stop the running turn')
                : sendKeybinding === 'chat' ? 'Send — ↵' : IS_MAC ? 'Send — ⌘+↵' : 'Send — Ctrl+↵'
            }
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
        </Tooltip>
      </div>

      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--eb-space-2)',
        fontSize: 'var(--eb-text-xs)',
        color: voiceError ? 'var(--eb-status-error-text, #dc2626)' : 'var(--eb-text-muted)',
        marginTop: 'var(--eb-space-1)',
        paddingLeft: 'var(--eb-space-1)',
        transition: 'color var(--eb-transition-fast)',
        minHeight: '1em',
      }}>
        {/* Status line (transcribing / uploading / voice error). The send-on-Enter
            selector that used to sit here (#1354) moved to Settings → Behavior (#1804). */}
        <span style={{ flex: 1, minWidth: 0 }}>
          {voiceError
            ? voiceError
            : voiceState === 'transcribing'
              ? 'Transcribing…'
              : uploading
                ? 'Uploading attachment…'
                : null}
        </span>
        {/* #1972: the composer's "?" — sending, drafts, the slash-command
            palette, Stop, loops, dictation vs the note-taker, attachments and
            @-references are one surface with one chapter. It rides the status
            row rather than the icon cluster so it never competes with the
            controls it explains. */}
        <PageHelpButton
          label="What the composer can do"
          size={13}
          section={AGENT_CHAT_HELP_SECTIONS.composer}
          style={{ padding: 0, flexShrink: 0 }}
        />
      </div>
    </div>
  );
}

// Local preview of an attached image (#2567 AC2) — never fetched from the
// server. Null where the browser offers no object URLs; the card then shows
// its neutral file face.
function createPreviewUrl(file) {
  try {
    return typeof URL !== 'undefined' && URL.createObjectURL ? URL.createObjectURL(file) : null;
  } catch {
    return null;
  }
}

function revokePreviewUrl(url) {
  if (url) {
    try { URL.revokeObjectURL(url); } catch { /* already released */ }
  }
}

function autoResize(el) {
  if (!el) return;
  // Reset to min so shrinking works after deletion.
  el.style.height = 'auto';
  // Cap at maxHeight (set in style); CSS will clip the visual height.
  el.style.height = `${Math.min(el.scrollHeight, 320)}px`;
}

// The composer's short-label tooltips now use the shared, canonical
// `Tooltip` component (#1850) — a local `ButtonTooltip` used to live here.
