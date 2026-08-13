// Guarded loader for the Helper Chat guided-tour manifest (#1737, Phase 2.2).
//
// The manifest itself (admin-console/api/helper-chat/tour-manifest.json) is a
// build artifact GENERATED and vendored by #1736 (Phase 2.1). This ticket's
// endpoint (GET /api/helper/tour-manifest) only serves it. Rather than a bare
// `require('./tour-manifest.json')` — which throws at startup if the file is not
// present (e.g. on a checkout where #1736 has not merged yet) — we read it
// defensively and degrade to an empty manifest so the tour panel renders an
// honest "no chapters yet" state instead of the whole API failing to boot.
//
// The path is a fixed constant (never user input), so there is no path-injection
// surface here.

const fs = require('fs');
const path = require('path');

const DEFAULT_MANIFEST_PATH = path.join(__dirname, 'tour-manifest.json');

// The shape served when the generated file is absent or unreadable.
const EMPTY_MANIFEST = { chapters: [] };

// Read + validate the manifest from disk. Never throws — any error (missing
// file, bad JSON, unexpected shape) yields the empty manifest.
function readTourManifest(manifestPath = DEFAULT_MANIFEST_PATH) {
  let raw;
  try {
    raw = fs.readFileSync(manifestPath, 'utf8');
  } catch {
    return EMPTY_MANIFEST;
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.chapters)) {
      return parsed;
    }
    return EMPTY_MANIFEST;
  } catch {
    return EMPTY_MANIFEST;
  }
}

module.exports = { readTourManifest, DEFAULT_MANIFEST_PATH, EMPTY_MANIFEST };
