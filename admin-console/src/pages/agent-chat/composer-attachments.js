// Pure model for the composer's image-attachment preview tray (#2567).
//
// The composer (MessageInput.jsx) shows one card per image the user attached
// to the current draft — pasted, dropped or picked — from the moment the file
// is attached, independent of the upload's progress or outcome. This module
// owns the attachment list transitions and the draft-text bookkeeping so they
// are unit-testable without a DOM (#651); the JSX stays a thin renderer.
//
// An attachment is `{ id, name, status, ref }`:
//   status — 'uploading' | 'uploaded' | 'failed'
//   ref    — the workspace-relative `chat-uploads/<name>` once uploaded, else null
// The local `File` and its object URL live beside the list in the component
// (they are not serialisable and must be revoked there).
//
// Kept React-free.

import { isImageRefCandidate } from './chat-image-refs.js';

// MIME types of the four raster formats `isImageRefCandidate` accepts, for a
// pasted clipboard file whose name carries no usable extension.
const IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

// Whether an attached file gets a preview card (AC1). The extension decides
// when there is one — the same set `isImageRefCandidate` accepts — so an
// `.svg` or `.pdf` keeps today's plain-reference behaviour (AC12). A file with
// no extension falls back to its MIME type.
export function isImageAttachment(file) {
  if (!file) return false;
  const name = String(file.name || '');
  if (isImageRefCandidate(name)) return true;
  const hasExt = /\.[^./]+$/.test(name);
  return !hasExt && IMAGE_MIME_TYPES.has(String(file.type || '').toLowerCase());
}

// Splits attached files into image files (one card + one upload each) and the
// rest (uploaded as one batch, exactly as before #2567). Order is preserved.
export function partitionFiles(files) {
  const images = [];
  const others = [];
  for (const f of Array.from(files || [])) (isImageAttachment(f) ? images : others).push(f);
  return { images, others };
}

export function createAttachment(id, file) {
  return { id, name: String(file?.name || 'image'), status: 'uploading', ref: null };
}

// Appends in attach order (AC7).
export function addAttachments(list, attachments) {
  return [...list, ...attachments];
}

function patch(list, id, changes) {
  return list.map(a => (a.id === id ? { ...a, ...changes } : a));
}

export function markUploading(list, id) {
  return patch(list, id, { status: 'uploading' });
}

export function markUploaded(list, id, ref) {
  return patch(list, id, { status: 'uploaded', ref });
}

export function markFailed(list, id) {
  return patch(list, id, { status: 'failed' });
}

export function removeAttachment(list, id) {
  return list.filter(a => a.id !== id);
}

export function hasAttachment(list, id) {
  return list.some(a => a.id === id);
}

// Send guard (AC11): true while any attachment's upload is still in flight.
export function anyUploading(list) {
  return list.some(a => a.status === 'uploading');
}

// Whether `text[i]` may follow a `@<ref>` token — end of text, whitespace, or
// punctuation that cannot continue a filename. A '.' only counts when it ends
// the text or precedes whitespace (a sentence full stop), so `@a.png` is not
// mistaken for a prefix of `@a.png.bak`.
function isTokenEnd(text, i) {
  const ch = text[i];
  if (ch === undefined || /\s/.test(ch)) return true;
  if (ch === '.') return i + 1 >= text.length || /\s/.test(text[i + 1]);
  return !/[\w\-/()[\]]/.test(ch);
}

// Start/end indices of every `@<ref>` token in `text`: the '@' must open the
// text or follow whitespace, and the ref must be followed by a token end.
// Plain indexOf scan — the ref may contain spaces or regex metacharacters
// (`image (2).png`, #2453), so it is never compiled into a RegExp.
function tokenRanges(text, ref) {
  const needle = `@${ref}`;
  const ranges = [];
  if (!ref) return ranges;
  let from = 0;
  for (;;) {
    const i = text.indexOf(needle, from);
    if (i < 0) break;
    const end = i + needle.length;
    if ((i === 0 || /\s/.test(text[i - 1])) && isTokenEnd(text, end)) ranges.push([i, end]);
    from = i + 1;
  }
  return ranges;
}

export function hasRefToken(text, ref) {
  return tokenRanges(String(text || ''), ref).length > 0;
}

// Removes every `@<ref>` token from the draft (AC6), together with one
// adjoining space so the text does not keep a double gap where
// `insertRefs` padded the token.
export function removeRefToken(text, ref) {
  let out = String(text || '');
  const ranges = tokenRanges(out, ref);
  for (let k = ranges.length - 1; k >= 0; k--) {
    let [start, end] = ranges[k];
    if (out[end] === ' ') end += 1;
    else if (start > 0 && out[start - 1] === ' ') start -= 1;
    out = out.slice(0, start) + out.slice(end);
  }
  return out;
}

// Drops every uploaded attachment whose `@<ref>` token is no longer in the
// draft (AC10), so the tray never shows an image the message won't reference.
// Uploading/failed cards have no token yet and are kept. Returns the same list
// instance when nothing changed, so a state setter can bail out cheaply.
export function pruneToDraft(list, text) {
  const next = list.filter(a => a.status !== 'uploaded' || hasRefToken(text, a.ref));
  return next.length === list.length ? list : next;
}
