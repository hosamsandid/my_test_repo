import React, { useState } from 'react';
import { imageSrcUrl } from './workspace-image.js';
import { FileViewerModal, useWorkspaceFileData } from './WorkspaceBrowser.jsx';

function baseName(path) {
  const idx = path.lastIndexOf('/');
  return idx >= 0 ? path.slice(idx + 1) : path;
}

// Fullscreen preview for a chat-referenced image (#2146 AC2) — literally the
// SAME `FileViewerModal` the Workspace tab's file tree opens (Escape-to-close,
// backdrop-click-to-close, fit-to-window), fed by the same `/file` metadata
// fetch a tree click makes (`useWorkspaceFileData`), so this is not a second
// viewer — it is the existing one, opened from a different trigger.
function ChatImagePreviewModal({ agentId, path, onClose }) {
  const { data, loading, error } = useWorkspaceFileData(agentId, path);
  return (
    <FileViewerModal
      agentId={agentId}
      relPath={path}
      data={data}
      loading={loading}
      error={error}
      viewMode="raw"
      onToggleViewMode={() => {}}
      onClose={onClose}
    />
  );
}

/**
 * Inline thumbnail for a human-authored `@<path>` image reference (#2146).
 *
 * Loads through the same `/api/agents/:id/workspace/image` endpoint (and
 * therefore the same magic-byte format gate, `admin-console/api/image-type.js`)
 * the Workspace tab's own preview uses (AC8) — never a second image-serving
 * path. A load failure (deleted file, unreadable, or a mislabeled extension
 * the server's magic-byte check rejects) degrades to the original plain
 * `@<path>` text rather than a broken-image icon (AC6); this is also what
 * makes AC5 hold for a candidate that turns out not to actually be an image.
 *
 * Only ever mounted for a HUMAN message (Message.jsx gates on author) — an
 * agent-authored `@<path>` never reaches this component and triggers no
 * fetch (AC4, the security boundary).
 */
export default function ChatImageThumbnail({ agentId, path, raw }) {
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const src = agentId ? imageSrcUrl(agentId, path) : null;

  if (failed || !src) {
    // Graceful degradation (AC6): the original text reference, never a
    // broken-image icon.
    return <>{raw}</>;
  }

  const name = baseName(path);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={name}
        aria-label={`Open image ${name}`}
        style={{
          display: 'inline-block',
          padding: 0,
          margin: '2px 4px 2px 0',
          border: '1px solid var(--eb-border-default)',
          borderRadius: 'var(--eb-radius-sm)',
          background: 'none',
          cursor: 'pointer',
          verticalAlign: 'top',
          lineHeight: 0,
        }}
      >
        {/* Size-capped in the bubble (edge case: very large images); the
            fullscreen modal opened on click serves the full resolution via
            the same /image endpoint, uncapped. */}
        <img
          src={src}
          alt={name}
          onError={() => setFailed(true)}
          style={{
            display: 'block',
            maxWidth: 160,
            maxHeight: 160,
            borderRadius: 'var(--eb-radius-sm)',
            objectFit: 'contain',
          }}
        />
      </button>
      {open && (
        <ChatImagePreviewModal agentId={agentId} path={path} onClose={() => setOpen(false)} />
      )}
    </>
  );
}
