import React, { useEffect, useRef, useState } from 'react';
import { Send } from 'lucide-react';

/**
 * Auto-resizing textarea with a send button.
 *
 * Keys:
 *   - Cmd/Ctrl + Enter   ⇒ submit
 *   - Plain Enter        ⇒ newline (default behaviour)
 *
 * Auto-resize: line height ~20 px, min 1 row, max 8 rows; we measure via
 * scrollHeight after each input event and clamp.
 *
 * @param {(text:string)=>void} onSend
 * @param {boolean} [disabled]
 * @param {string}  [agentDisplayName]   used in placeholder
 */
export default function MessageInput({ onSend, disabled = false, agentDisplayName }) {
  const [value, setValue] = useState('');
  const taRef = useRef(null);
  // Track IME composition: pressing Enter while a Japanese/Chinese/Korean
  // (or any IME) candidate is active must NOT submit the message — that
  // Enter is consumed by the IME to commit the candidate.
  const composingRef = useRef(false);

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

  const placeholder = agentDisplayName
    ? `Message ${agentDisplayName}…  (⌘↩ to send)`
    : 'Message…  (⌘↩ to send)';

  return (
    <div style={{
      borderTop: '1px solid var(--eb-border-default)',
      padding: 'var(--eb-space-3) var(--eb-space-4)',
      background: 'var(--eb-bg-surface)',
      flexShrink: 0,
    }}>
      <div style={{
        display: 'flex',
        alignItems: 'flex-end',
        gap: 'var(--eb-space-2)',
        background: 'var(--eb-bg-elevated)',
        border: '1px solid var(--eb-border-default)',
        borderRadius: 'var(--eb-radius-md)',
        padding: 'var(--eb-space-2)',
      }}>
        <textarea
          ref={taRef}
          value={value}
          disabled={disabled}
          onChange={e => setValue(e.target.value)}
          onKeyDown={handleKey}
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
        color: 'var(--eb-text-muted)',
        marginTop: 'var(--eb-space-1)',
        paddingLeft: 'var(--eb-space-1)',
      }}>
        Markdown supported · <kbd style={kbdStyle}>⌘</kbd>+<kbd style={kbdStyle}>↩</kbd> to send · <kbd style={kbdStyle}>↩</kbd> for newline
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
