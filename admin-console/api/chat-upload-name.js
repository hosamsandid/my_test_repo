'use strict';

// Filenames for Agent Chat attachments (`POST /api/agents/:agentId/chat-upload`, #2568).
//
// Browsers name every clipboard image generically — `image.png`, or nothing at
// all — so before this module every pasted screenshot became `image.png`,
// `image (2).png` … `image (13).png`: names with spaces and parentheses (the
// `@`-reference parser has to special-case them, #2453) that don't sort in paste
// order (`image (10).png` < `image (2).png`). Two changes, both pure so they are
// unit-testable without a request:
//
//   1. chatUploadBaseName: a generic pasted-image name becomes
//      `image-YYYYMMDD-HHMMSS.<ext>` (UTC, so the order doesn't depend on the
//      user's timezone). Any other name is returned as-is — a dragged
//      `architecture-diagram.png` keeps its (already sanitised) name.
//   2. uniqueFileName: the collision suffix is `<base>-<n>.<ext>` instead of
//      `<base> (<n>).<ext>`, for every chat upload.
//
// Existing `name (n).ext` files are left alone (no migration); the reference
// parser still handles them.

const fs = require('fs');
const path = require('path');

// Raster formats a clipboard can plausibly carry. A generic `image.<ext>` with
// any other extension (e.g. `image.pdf`) is not a pasted image and keeps its name.
const PASTED_IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif']);

// Extension for a pasted image that arrives without any name, from its MIME type.
const IMAGE_MIME_EXTENSIONS = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/avif': 'avif',
};

// Browser-generated names only: `image.<ext>`, case-insensitive. The name is
// expected to be the sanitised basename (trimmed, no directory part).
function isGenericPastedImageName(name) {
  const m = /^image\.([a-z0-9]+)$/i.exec(String(name || ''));
  return !!m && PASTED_IMAGE_EXTENSIONS.has(m[1].toLowerCase());
}

// `YYYYMMDD-HHMMSS` in UTC.
function utcStamp(date) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}`
    + `-${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}`;
}

/**
 * The name a chat upload should be stored under, before collision handling.
 *
 * @param {string} safeName  sanitised basename of the client's filename ('' when
 *                           the client sent none)
 * @param {string} [mimetype] the part's Content-Type (used only for a nameless file)
 * @param {Date}   [now]
 * @returns {string} the name to store, or '' when there is nothing usable
 *                   (a nameless file that isn't a known image type)
 */
function chatUploadBaseName(safeName, mimetype, now = new Date()) {
  if (safeName) {
    if (!isGenericPastedImageName(safeName)) return safeName;
    return `image-${utcStamp(now)}${path.extname(safeName)}`;
  }
  const ext = IMAGE_MIME_EXTENSIONS[String(mimetype || '').toLowerCase()];
  return ext ? `image-${utcStamp(now)}.${ext}` : '';
}

// Return a filename that doesn't yet exist in `dir`, appending "-<n>" before the
// extension on collision, so a second upload of `report.pdf` becomes
// `report-2.pdf` rather than clobbering the first — no spaces or parentheses.
function uniqueFileName(dir, name, exists = fs.existsSync) {
  if (!exists(path.join(dir, name))) return name;
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  for (let n = 2; n < 10000; n++) {
    const candidate = `${base}-${n}${ext}`;
    if (!exists(path.join(dir, candidate))) return candidate;
  }
  return `${base}-${Date.now()}${ext}`;
}

module.exports = { isGenericPastedImageName, chatUploadBaseName, uniqueFileName };
