import React, { useEffect, useRef, useState } from 'react';
import { Send, Paperclip, Loader2, Mic, Square } from 'lucide-react';
import useVoiceRecorder from '../../hooks/useVoiceRecorder.js';

/**
 * Auto-resizing textarea with a send button and inline file attachments.
 *
 * Keys:
 *   - Cmd/Ctrl + Enter   ⇒ submit
 *   - Plain Enter        ⇒ newline (default behaviour)
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
 * @param {(text:string)=>void} onSend
 * @param {boolean} [disabled]
 * @param {string}  [agentDisplayName]   used in placeholder
 * @param {(files:FileList|File[])=>Promise<Array<{name:string,ref:string}>>} [onUpload]
 *        Uploads files and resolves to the uploaded descriptors (empty on failure).
 * @param {boolean} [uploading]          true while an upload is in flight
 */
export default function MessageInput({ onSend, disabled = false, agentDisplayName, onUpload, uploading = false }) {
  const [value, setValue] = useState('');
  const [dragging, setDragging] = useState(false);
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

  // Auto-focus on mount and when re-enabled.
  useEffect(() => {
    if (!disabled) taRef.current?.focus();
  }, [disabled]);

  function submit() {
    const text = value.trim();
    if (!text || disabled) return;
    onSend(text);
    setValue('');
    // Refocus right away — clearing the value won't move focus on its own.
    requestAnimationFrame(() => taRef.current?.focus());
  }

  function handleKey(e) {
    // Skip the accelerator while composing; the IME owns this Enter.
    // Some browsers also surface `e.isComposing === true` and `keyCode === 229`;
    // we honour both for safety.
    if (composingRef.current || e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
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

  const placeholder = agentDisplayName
    ? `Message ${agentDisplayName}…  (⌘↩ to send)`
    : 'Message…  (⌘↩ to send)';

  const canAttach = !!onUpload && !disabled && !uploading;

  return (
    <div style={{
      borderTop: '1px solid var(--eb-border-default)',
      padding: 'var(--eb-space-3) var(--eb-space-4)',
      background: 'var(--eb-bg-surface)',
      flexShrink: 0,
    }}>
      {voiceState === 'recording' && (
        <style>{'@keyframes stt-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }'}</style>
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
          <button
            onClick={toggleRecording}
            disabled={disabled || voiceState === 'transcribing'}
            aria-label={voiceState === 'recording' ? 'Stop recording' : voiceState === 'transcribing' ? 'Transcribing…' : 'Record voice message'}
            title={voiceState === 'recording' ? 'Stop recording' : voiceState === 'transcribing' ? 'Transcribing…' : 'Voice input'}
            style={{
              width: 32, height: 32,
              background: voiceState === 'recording' ? 'var(--eb-status-error-bg, #fef2f2)' : 'transparent',
              color: voiceState === 'recording'
                ? 'var(--eb-status-error-text, #dc2626)'
                : voiceState === 'transcribing'
                  ? 'var(--eb-text-muted)'
                  : 'var(--eb-text-secondary)',
              border: 'none',
              borderRadius: 'var(--eb-radius-md)',
              cursor: (disabled || voiceState === 'transcribing') ? 'not-allowed' : 'pointer',
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
        </div>
        <button
          onClick={submit}
          disabled={disabled || !value.trim()}
          aria-label="Send message"
          title="Send (Cmd/Ctrl + Enter)"
          style={{
            width: 32, height: 32,
            background: (!value.trim() || disabled) ? 'var(--eb-bg-active)' : 'var(--eb-accent-primary)',
            color: (!value.trim() || disabled) ? 'var(--eb-text-muted)' : 'var(--eb-text-inverted)',
            border: 'none',
            borderRadius: 'var(--eb-radius-md)',
            cursor: (!value.trim() || disabled) ? 'not-allowed' : 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            flexShrink: 0,
            transition: 'background var(--eb-transition-fast)',
          }}
        >
          <Send size={14} />
        </button>
      </div>

      <div style={{
        fontSize: 'var(--eb-text-xs)',
        color: voiceError ? 'var(--eb-status-error-text, #dc2626)' : 'var(--eb-text-muted)',
        marginTop: 'var(--eb-space-1)',
        paddingLeft: 'var(--eb-space-1)',
        transition: 'color var(--eb-transition-fast)',
      }}>
        {voiceError
          ? voiceError
          : voiceState === 'transcribing'
            ? 'Transcribing…'
            : uploading
              ? 'Uploading attachment…'
              : onUpload
                ? <>Markdown supported · attach with <Paperclip size={11} style={{ verticalAlign: '-1px' }} />, drag &amp; drop, or paste (<kbd style={kbdStyle}>⌘</kbd>/<kbd style={kbdStyle}>Ctrl</kbd>+<kbd style={kbdStyle}>V</kbd>) · <kbd style={kbdStyle}>⌘</kbd>+<kbd style={kbdStyle}>↩</kbd> to send</>
                : <>Markdown supported · <kbd style={kbdStyle}>⌘</kbd>+<kbd style={kbdStyle}>↩</kbd> to send · <kbd style={kbdStyle}>↩</kbd> for newline</>}
      </div>
    </div>
  );
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
