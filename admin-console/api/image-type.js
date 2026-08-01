'use strict';

// Magic-byte sniffing for the raster image formats the workspace previewer
// supports inline (PNG, JPEG, GIF, WebP). Detection is deliberately by file
// content, not extension, so a mislabeled file (a .png that is really a JPEG,
// or a .bin that is a real PNG) is classified correctly and an SVG or arbitrary
// binary is never served as an image. SVG is intentionally excluded (it is text,
// carries no raster magic, and would be an XSS surface if rendered inline).

const IMAGE_CONTENT_TYPES = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

// Returns 'png' | 'jpeg' | 'gif' | 'webp' | null for the given file-header bytes.
function detectRasterImageType(buf) {
  if (!buf || buf.length < 12) return null;

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  ) {
    return 'png';
  }

  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'jpeg';
  }

  // GIF: "GIF87a" or "GIF89a"
  if (
    buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38 &&
    (buf[4] === 0x37 || buf[4] === 0x39) && buf[5] === 0x61
  ) {
    return 'gif';
  }

  // WebP: "RIFF" .... "WEBP"
  if (
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) {
    return 'webp';
  }

  return null;
}

function imageContentType(type) {
  return IMAGE_CONTENT_TYPES[type] || null;
}

module.exports = { detectRasterImageType, imageContentType, IMAGE_CONTENT_TYPES };
