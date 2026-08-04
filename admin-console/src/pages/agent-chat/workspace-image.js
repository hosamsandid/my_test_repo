// Pure helpers for the workspace file viewer's inline image preview.
// Kept React-free so they can be unit-tested without a DOM/node_modules.

import { workspaceUrl } from './workspace-source.js';

// True when the /file response describes a supported raster image the viewer
// should render inline (backend flags it via magic-byte detection — see
// admin-console/api/image-type.js), rather than the "binary file" placeholder.
export function isImageData(data) {
  return !!(data && data.binary && typeof data.imageType === 'string' && data.imageType);
}

// URL of the inline image-bytes endpoint for a tree node. Routes to whichever
// source the node belongs to — the agent's workspace or the read-only host
// context mount (#1286) — with every component encoded so paths with spaces /
// special chars round-trip safely.
export function imageSrcUrl(agentId, relPath) {
  if (!agentId || !relPath) return null;
  return workspaceUrl(agentId, relPath, 'image');
}
