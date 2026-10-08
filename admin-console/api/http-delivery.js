'use strict';

// HTTP delivery of the admin console (#2919): response compression plus the
// cache policy for the built SPA. Without these every navigation re-downloaded
// or re-validated ~150 uncompressed files, so a warm reload was no faster than
// a cold one — the dominant page-load cost on a VPN / home-office link.

const compression = require('compression');

// Long-lived streams must reach the browser line by line. The compression
// middleware buffers inside zlib until a flush, so it would hold back SSE
// events (`text/event-stream` counts as compressible) and NDJSON progress
// lines. Matched on the Content-Type the handler set before its first write.
const STREAMING_CONTENT_TYPES = ['text/event-stream', 'application/x-ndjson'];

function isStreamingContentType(contentType) {
  const type = String(contentType || '').split(';')[0].trim().toLowerCase();
  return STREAMING_CONTENT_TYPES.includes(type);
}

// Compress what the default filter deems compressible (JS, CSS, JSON, HTML,
// SVG, …) — except streams. `Cache-Control: no-transform` is honoured by the
// middleware itself, and an upstream that already set Content-Encoding (e.g. a
// proxied plugin UI) is passed through untouched.
function shouldCompress(req, res) {
  if (isStreamingContentType(res.getHeader('Content-Type'))) return false;
  return compression.filter(req, res);
}

function createCompressionMiddleware() {
  return compression({ filter: shouldCompress });
}

// Vite emits content-hashed file names under /assets/, so a given URL never
// changes content: cache it for a year without revalidation. index.html names
// the current hashes and must be revalidated on every load so a deploy takes
// effect immediately.
const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';
const INDEX_CACHE_CONTROL = 'no-cache';

function isHashedAssetPath(urlPath) {
  return String(urlPath || '').startsWith('/assets/');
}

// `setHeaders` hook for express.static over the dist/ directory. Anything else
// in dist/ (favicon, …) keeps express.static's default revalidation.
function setStaticCacheHeaders(res, filePath) {
  const urlPath = res.req?.path;
  if (isHashedAssetPath(urlPath)) {
    res.setHeader('Cache-Control', IMMUTABLE_CACHE_CONTROL);
  } else if (/(^|[\\/])index\.html$/.test(filePath)) {
    res.setHeader('Cache-Control', INDEX_CACHE_CONTROL);
  }
}

module.exports = {
  STREAMING_CONTENT_TYPES,
  IMMUTABLE_CACHE_CONTROL,
  INDEX_CACHE_CONTROL,
  isStreamingContentType,
  shouldCompress,
  createCompressionMiddleware,
  isHashedAssetPath,
  setStaticCacheHeaders,
};
