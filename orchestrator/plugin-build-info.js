'use strict';

// ─── running broker build identity (#2646) ──────────────────────────────────
//
// Every broker image carries the git commit it was built from, and its /healthz
// body reports it as `build: { commit, dirty, commitTime }` — plus
// `{ tag, tagDistance }` when the build recorded a release tag (#2893)
// (broker-sdk/build-info.js). Asking the LIVE sidecar — rather than inspecting
// the `:latest` image in the local store or a Kubernetes node cache — is what
// makes the answer honest: a rebuilt image next to an old running container
// still reports the old commit until the sidecar is recreated. The rebuilt
// image's own identity is read separately (inspectSidecarImageBuilds below), so
// the console can show both and flag the difference.
//
// The probe is best-effort. A broker that is not reachable, answers slowly,
// runs a third-party image with no /healthz (dummy-echo) or predates #2646
// yields `null`, which the console renders as "unknown". It never fails the
// plugin listing it feeds.

const PROBE_TIMEOUT_MS = 2000;

// Hash-like tokens only: a broker controls its own /healthz body, and whatever
// it says is rendered on the Plugins page.
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

// Normalise a reported build into `{ commit, dirty, commitTime }`, or null when
// there is nothing usable. `commit` is "unknown" for a build without git
// metadata — that is a real answer ("this image was built without a commit"),
// distinct from null ("we could not ask").
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

// GET <baseUrl>/healthz and return the normalised `build`, or null.
async function probeBrokerBuild(baseUrl, { fetchImpl = fetch, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  try {
    const resp = await fetchImpl(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!resp.ok) return null;
    const body = await resp.json();
    return normalizeBuildInfo(body && body.build);
  } catch {
    return null;
  }
}

// `{ [pluginId]: build | null }` for every running broker-bearing entry, probed
// in parallel so one slow sidecar costs the listing at most one timeout.
//   entries  : plugin-registry.listPlugins() rows
//   running  : Set of plugin ids with a live sidecar
//   baseUrlOf: manifest → broker base URL (plugin-runtime.brokerBaseUrl)
async function probeRunningBrokerBuilds(entries, running, baseUrlOf, opts = {}) {
  const targets = (entries || []).filter((e) => e && e.ok && e.manifest && e.manifest.sidecar && running.has(e.id));
  const results = await Promise.all(targets.map((e) => probeBrokerBuild(baseUrlOf(e.manifest), opts)));
  const out = {};
  targets.forEach((e, i) => { out[e.id] = results[i]; });
  return out;
}

// ─── the image a sidecar would be recreated from (#2646 AC8) ───────────────
//
// The broker's own /healthz says what the live container runs; the OCI labels
// of `manifest.sidecar.image` in the local store say what a RECREATED sidecar
// would run. After `make plugin-images` on a new commit the two differ, and
// that is the case the mismatch hint exists for: the registry files do not
// move on a rebuild, so comparing against them alone never fires.
//
// Labels written by every reference broker Dockerfile:
const IMAGE_COMMIT_LABEL = 'org.opencontainers.image.revision';
const IMAGE_DIRTY_LABEL = 'aee.build.dirty';
const IMAGE_COMMIT_TIME_LABEL = 'aee.build.commit-time';
// …and, since #2893, the nearest release tag and distance (empty without one).
const IMAGE_TAG_LABEL = 'aee.build.tag';
const IMAGE_TAG_DISTANCE_LABEL = 'aee.build.tag-distance';

// libpod image-inspect body → normalised build, or null when there is no body.
// libpod reports labels top-level and under Config; either is accepted. An
// image without the labels (third-party, pre-#2646) is a real answer:
// `commit: 'unknown'`.
function imageBuildFromInspect(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const labels = (body.Labels && typeof body.Labels === 'object' && body.Labels)
    || (body.Config && body.Config.Labels && typeof body.Config.Labels === 'object' && body.Config.Labels)
    || {};
  return normalizeBuildInfo({
    commit: labels[IMAGE_COMMIT_LABEL],
    dirty: labels[IMAGE_DIRTY_LABEL],
    commitTime: labels[IMAGE_COMMIT_TIME_LABEL],
    tag: labels[IMAGE_TAG_LABEL],
    tagDistance: labels[IMAGE_TAG_DISTANCE_LABEL],
  });
}

// `{ [pluginId]: build | null }` for every installed broker-bearing entry,
// running or not — the image is what the next start uses either way.
//   inspectImage: image ref → libpod inspect body or null
//                 (plugin-runtime.inspectSidecarImage; null on Kubernetes,
//                 where the node's image cache is not reachable from here)
async function inspectSidecarImageBuilds(entries, inspectImage) {
  const targets = (entries || []).filter((e) => e && e.ok && e.manifest && e.manifest.sidecar && e.manifest.sidecar.image);
  const results = await Promise.all(targets.map(async (e) => {
    try { return imageBuildFromInspect(await inspectImage(e.manifest.sidecar.image)); } catch { return null; }
  }));
  const out = {};
  targets.forEach((e, i) => { out[e.id] = results[i]; });
  return out;
}

module.exports = {
  normalizeBuildInfo,
  probeBrokerBuild,
  probeRunningBrokerBuilds,
  imageBuildFromInspect,
  inspectSidecarImageBuilds,
  PROBE_TIMEOUT_MS,
};
