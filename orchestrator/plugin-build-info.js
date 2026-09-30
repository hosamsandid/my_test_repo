'use strict';

// ─── running broker build identity (#2646) ──────────────────────────────────
//
// Every broker image carries the git commit it was built from, and its /healthz
// body reports it as `build: { commit, dirty, commitTime }`
// (broker-sdk/build-info.js). Asking the LIVE sidecar — rather than inspecting
// the `:latest` image in the local store or a Kubernetes node cache — is what
// makes the answer honest: a rebuilt image next to an old running container
// still reports the old commit until the sidecar is recreated.
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
  return { commit, dirty, commitTime };
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

module.exports = { normalizeBuildInfo, probeBrokerBuild, probeRunningBrokerBuilds, PROBE_TIMEOUT_MS };
