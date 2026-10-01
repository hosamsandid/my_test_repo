import React, { useState } from 'react';
import { X, Loader2, RotateCw, ImageOff } from 'lucide-react';
import { ChatImagePreviewModal } from './chat-image-thumbnail.jsx';

const CARD = 64;

/**
 * Preview tray above the composer's input row (#2567): one card per image
 * attached to the current draft, in attach order. The picture comes from the
 * local file's object URL (`previewUrl`), so it shows the moment the file is
 * attached — before, during and regardless of the upload. State per card:
 *   uploading — dimmed picture + spinner
 *   uploaded  — plain picture; a click opens the existing fullscreen viewer
 *               (`ChatImagePreviewModal`, the one #2146 uses) served by the
 *               workspace image endpoint — no second image-serving path
 *   failed    — red frame, "Upload failed" + Retry
 * Every card has a Remove (×) control. A file the browser can't decode shows
 * a neutral file card instead of a broken-image icon.
 *
 * Renders nothing for an empty list, so the composer is unchanged without
 * attachments (AC13). State transitions live in `composer-attachments.js`.
 *
 * @param {Array<{id, name, status, ref, previewUrl}>} attachments
 * @param {?string} agentId
 * @param {(id)=>void} onRemove
 * @param {(id)=>void} onRetry
 */
export default function ComposerAttachments({ attachments, agentId, onRemove, onRetry }) {
  const [openRef, setOpenRef] = useState(null);
  if (!attachments.length) return null;
  return (
    <>
      <div
        role="list"
        aria-label="Attached images"
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 'var(--eb-space-2)',
          marginBottom: 'var(--eb-space-2)',
        }}
      >
        {attachments.map(a => (
          <AttachmentCard
            key={a.id}
            attachment={a}
            onOpen={a.status === 'uploaded' && a.ref && agentId ? () => setOpenRef(a.ref) : null}
            onRemove={() => onRemove(a.id)}
            onRetry={() => onRetry(a.id)}
          />
        ))}
      </div>
      {openRef && (
        <ChatImagePreviewModal agentId={agentId} path={openRef} onClose={() => setOpenRef(null)} />
      )}
    </>
  );
}

function AttachmentCard({ attachment, onOpen, onRemove, onRetry }) {
  const { name, status, previewUrl } = attachment;
  const [undecodable, setUndecodable] = useState(false);
  const failed = status === 'failed';
  const uploading = status === 'uploading';
  const label = failed ? `${name} — upload failed` : uploading ? `${name} — uploading` : name;

  return (
    <div
      role="listitem"
      title={label}
      style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, width: CARD }}
    >
      <div style={{ position: 'relative', width: CARD, height: CARD }}>
        <button
          type="button"
          onClick={onOpen || undefined}
          disabled={!onOpen}
          aria-label={onOpen ? `Open image ${name}` : label}
          style={{
            width: '100%', height: '100%',
            padding: 0,
            border: `1px solid ${failed ? 'var(--eb-status-error-text)' : 'var(--eb-border-default)'}`,
            borderRadius: 'var(--eb-radius-sm)',
            background: 'var(--eb-bg-surface)',
            cursor: onOpen ? 'pointer' : 'default',
            overflow: 'hidden',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: 'var(--eb-text-muted)',
          }}
        >
          {undecodable || !previewUrl ? (
            // Neutral file card for an image the browser can't decode.
            <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, padding: 4 }}>
              <ImageOff size={18} />
              <span style={{ fontSize: 10, maxWidth: CARD - 8, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {name}
              </span>
            </span>
          ) : (
            // Size-constrained: a huge image never stretches the composer.
            <img
              src={previewUrl}
              alt={name}
              onError={() => setUndecodable(true)}
              style={{
                display: 'block', width: '100%', height: '100%',
                objectFit: 'cover',
                opacity: uploading || failed ? 0.5 : 1,
              }}
            />
          )}
        </button>
        {uploading && (
          <span
            aria-hidden="true"
            style={{
              position: 'absolute', inset: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: 'var(--eb-text-primary)', pointerEvents: 'none',
            }}
          >
            <Loader2 size={18} style={{ animation: 'spin 0.8s linear infinite' }} />
          </span>
        )}
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${name}`}
          title="Remove"
          style={{
            position: 'absolute', top: -6, right: -6,
            width: 18, height: 18, padding: 0,
            borderRadius: '50%',
            border: '1px solid var(--eb-border-default)',
            background: 'var(--eb-bg-elevated)',
            color: 'var(--eb-text-secondary)',
            cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
        >
          <X size={11} />
        </button>
      </div>
      {failed && (
        <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', fontSize: 10, lineHeight: 1.3 }}>
          <span style={{ color: 'var(--eb-status-error-text)', whiteSpace: 'nowrap' }}>Upload failed</span>
          <button
            type="button"
            onClick={onRetry}
            aria-label={`Retry uploading ${name}`}
            style={{
              display: 'flex', alignItems: 'center', gap: 2,
              padding: 0, border: 'none', background: 'none',
              color: 'var(--eb-accent-primary)', cursor: 'pointer',
              fontSize: 10, fontFamily: 'inherit',
            }}
          >
            <RotateCw size={10} /> Retry
          </button>
        </span>
      )}
    </div>
  );
}
