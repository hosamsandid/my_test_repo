'use strict';

// ─── plugin source build identity (#2646) ────────────────────────────────────
//
// `make seed-plugins` stamps every plugin it copies into the pool with a
// `build-info.json` — `{ commit, dirty, commitTime }`, the checkout's git
// identity in the same shape the console's own version display uses (#483,
// #1741), plus the nearest release tag and distance (`tag`, `tagDistance`,
// #2893; empty strings when no release tag was reachable). Install copies the pool dir verbatim, so the REGISTRY copy keeps the
// commit its manifest + CLI were installed from, even after the pool moves on.
// GET /api/plugins returns it as `sourceBuild` next to the running broker's
// `brokerBuild` (probed by the orchestrator) and `imageBuild` (the broker
// image's labels), and the Plugins page compares them.
//
// A pool or registry copy seeded before #2646 has no file → null → the page
// says "unknown". Plugins installed that way keep working unchanged.
//
// normalizeBuildInfo is the SAME rule as orchestrator/plugin-build-info.js (the
// two build contexts are disjoint — see the plugin-manifest.js note); keep them
// in step.

const fs = require('fs');
const path = require('path');

const BUILD_INFO_FILE = 'build-info.json';
const COMMIT_RE = /^[0-9a-f]{4,64}$/i;
const COMMIT_TIME_MAX = 64;
// Release tags only (#2893, the rule of scripts/git-release-tag.sh) and a plain
// commit count — anything else is dropped, never rendered.
const RELEASE_TAG_RE = /^v\d{1,9}\.\d{1,9}\.\d{1,9}$/;
const TAG_DISTANCE_RE = /^\d{1,9}$/;

// `{ tag, tagDistance }` from a raw build, or null when there is no usable
// pair. The distance arrives as a string (build-info.json, image labels) or a
// number (/healthz); an empty tag means "no release tag was reachable".
function normalizeTag(raw) {
  const tag = typeof raw.tag === 'string' ? raw.tag.trim() : '';
  const d = raw.tagDistance;
  const distance = typeof d === 'number' ? String(d) : typeof d === 'string' ? d.trim() : '';
  if (!RELEASE_TAG_RE.test(tag) || !TAG_DISTANCE_RE.test(distance)) return null;
  return { tag, tagDistance: Number(distance) };
}

function normalizeBuildInfo(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const commit = typeof raw.commit === 'string' && COMMIT_RE.test(raw.commit.trim())
    ? raw.commit.trim()
    : 'unknown';
  const dirty = commit !== 'unknown' && raw.dirty === 'dirty' ? 'dirty' : '';
  const commitTime = typeof raw.commitTime === 'string' && raw.commitTime.length <= COMMIT_TIME_MAX
    ? raw.commitTime.trim()
    : '';
  const out = { commit, dirty, commitTime };
  // Only a build with a known commit carries a version; a build without tag
  // info (none reachable, or recorded before #2893) keeps the #2646 shape.
  const tag = commit !== 'unknown' ? normalizeTag(raw) : null;
  return tag ? { ...out, ...tag } : out;
}

// `baseDir/<id>/build-info.json`, normalised, or null when absent/unreadable.
// `id` must already be a validated plugin id (listPluginDirs / PLUGIN_ID_RE).
function readPluginBuildInfo(baseDir, id) {
  try {
    return normalizeBuildInfo(JSON.parse(fs.readFileSync(path.join(baseDir, id, BUILD_INFO_FILE), 'utf8')));
  } catch {
    return null;
  }
}

module.exports = { BUILD_INFO_FILE, normalizeBuildInfo, readPluginBuildInfo };
