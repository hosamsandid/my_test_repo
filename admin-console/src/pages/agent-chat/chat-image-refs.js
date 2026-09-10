// Pure parser for @-referenced images in a human-authored Agent Chat message
// (#2146). Detection is a client-side EXTENSION filter only — the real
// authority is the `/api/agents/:id/workspace/image` endpoint (magic-byte
// gated, `admin-console/api/image-type.js`), which is what the thumbnail
// component ultimately fetches; a wrong guess here (a mislabeled file) just
// falls back to the plain `@<path>` text via that endpoint's own refusal.
// Kept React-free so it is unit-testable without a DOM.

// Mirrors the four raster formats `detectRasterImageType` recognizes (PNG,
// JPEG, GIF, WebP). SVG is deliberately excluded — same reason the workspace
// preview excludes it: it carries no raster magic and is a text/XSS surface.
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);

// An `@<path>` token: '@' preceded by start-of-string or whitespace, followed
// by a run of non-whitespace characters (a workspace-relative path never
// contains a space in this app — uploads are slugged, and a user-typed
// reference follows the same `@<path>` convention `insertRefs` produces).
const REF_TOKEN_RE = /(^|\s)@(\S+)/g;

function extOf(path) {
  const idx = path.lastIndexOf('.');
  if (idx < 0 || idx === path.length - 1) return '';
  return path.slice(idx + 1).toLowerCase();
}

// Whether `path` is a candidate for inline-thumbnail treatment. A leading `/`
// marks a `/context` host-mount key (#1286) rather than a workspace-relative
// path — out of scope for #2146 (the mount has its own, different image
// route), so it is never treated as an image reference here.
export function isImageRefCandidate(path) {
  if (!path || path.startsWith('/')) return false;
  return IMAGE_EXTENSIONS.has(extOf(path));
}

// Splits a message body into an alternating list of segments:
//   { type: 'text', value }               — rendered through the normal
//                                            markdown pipeline, unchanged
//   { type: 'ref', raw: '@<path>', path }  — an image-candidate reference
//
// Only image-candidate tokens are split out; every other `@token` (a
// non-image reference, or plain `@` text that isn't a reference at all) stays
// part of its surrounding text segment, so it renders exactly as it did
// before #2146 (AC5).
export function parseMessageSegments(body) {
  const text = String(body || '');
  const segments = [];
  let lastIndex = 0;
  let m;
  REF_TOKEN_RE.lastIndex = 0;
  while ((m = REF_TOKEN_RE.exec(text)) !== null) {
    const leading = m[1];
    const path = m[2];
    if (!isImageRefCandidate(path)) continue;
    const tokenStart = m.index + leading.length;
    if (tokenStart > lastIndex) {
      segments.push({ type: 'text', value: text.slice(lastIndex, tokenStart) });
    }
    segments.push({ type: 'ref', raw: `@${path}`, path });
    lastIndex = tokenStart + 1 + path.length;
  }
  if (lastIndex < text.length) {
    segments.push({ type: 'text', value: text.slice(lastIndex) });
  }
  return segments;
}

// Whether a parsed segment list contains at least one image reference — the
// gate the renderer uses to fall back to the single, unchanged
// `<SafeMarkdown body={message.body} />` render for the (overwhelmingly
// common) case of a message with no image reference at all.
export function hasImageRef(segments) {
  return segments.some(s => s.type === 'ref');
}
