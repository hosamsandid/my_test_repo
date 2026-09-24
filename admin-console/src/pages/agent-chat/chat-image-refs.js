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

function extOf(path) {
  const idx = path.lastIndexOf('.');
  if (idx < 0 || idx === path.length - 1) return '';
  return path.slice(idx + 1).toLowerCase();
}

// True when `ch` is undefined (end of string) or not an ASCII alphanumeric —
// i.e. a valid right-hand boundary for a file extension. `_` counts as a
// boundary too: an extension is a plain alphanumeric run.
function isExtBoundary(ch) {
  return ch === undefined || !/[a-z0-9]/i.test(ch);
}

// If `text[dot]` is the '.' of a known image extension terminated by a boundary
// (`image (2).png` → yes; `a.pngx` → no; `a.txt` → no), return the index just
// past the extension; otherwise -1. Iterates a fixed 5-element set, so this is
// O(1) per call and carries no backtracking (js/polynomial-redos safe, #2453).
function imageExtEndAt(text, dot) {
  for (const ext of IMAGE_EXTENSIONS) {
    const end = dot + 1 + ext.length;
    if (text.slice(dot + 1, end).toLowerCase() === ext && isExtBoundary(text[end])) {
      return end;
    }
  }
  return -1;
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
//
// A token is an '@' at start-of-string or after whitespace, and its path runs
// up to and including the FIRST image extension. Anchoring on the extension —
// not on the first whitespace — is what lets a workspace filename contain a
// space, e.g. `image (2).png` minted by the upload de-dupe or `my screenshot.png`
// from a browser (#2453). A whitespace-then-'@' pre-empts an unclosed token, so
// `@a.png @b.png` still yields two refs. The scan is a single linear pass with
// O(1) work per character (no backtracking regex — js/polynomial-redos safe).
export function parseMessageSegments(body) {
  const text = String(body || '');
  const segments = [];
  let lastIndex = 0;     // start of the pending (unemitted) text run
  let tokenStart = -1;   // index of the '@' opening the current candidate, or -1

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    // An '@' at start-of-string or after whitespace opens a candidate. It also
    // pre-empts any still-open candidate (which, being unclosed, held no image
    // extension and therefore stays plain text).
    if (ch === '@' && (i === 0 || /\s/.test(text[i - 1]))) {
      tokenStart = i;
      continue;
    }

    // Inside a candidate, the path ends at the first image-extension boundary.
    if (tokenStart >= 0 && ch === '.') {
      const end = imageExtEndAt(text, i);
      if (end >= 0) {
        const path = text.slice(tokenStart + 1, end);
        if (isImageRefCandidate(path)) {
          if (tokenStart > lastIndex) {
            segments.push({ type: 'text', value: text.slice(lastIndex, tokenStart) });
          }
          segments.push({ type: 'ref', raw: `@${path}`, path });
          lastIndex = end;
          i = end - 1;    // resume right after the extension (loop's ++ lands on `end`)
        }
        tokenStart = -1;  // candidate consumed (emitted, or rejected e.g. a /context key)
      }
    }
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
