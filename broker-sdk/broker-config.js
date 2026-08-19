'use strict';

// ─── broker runtime config (plugin system Phase 7, #1547) ────────────────────
//
// The env contract between the orchestrator (which runs every plugin's sidecar)
// and the broker inside it. It belongs in the SDK for the same reason the wire
// contract does: the orchestrator is generic — it must not know that plugin #1's
// broker once read `PODMAN_MCP_SIGNING_SECRET` and plugin #2's would read
// something else. It sets ONE set of names for every sidecar it starts, and a
// broker reads them through this helper.
//
//   AEE_PLUGIN_ID                  the plugin's registry id (also in every token)
//   AEE_PLUGIN_PORT                the manifest's sidecar.internalPort
//   AEE_PLUGIN_SIGNING_SECRET      shared scope-token signing secret (§4.6)
//   AEE_PLUGIN_QUOTA_MAX_OBJECTS   manifest quota.maxObjects, per SCOPE (§4.6)
//   AEE_PLUGIN_QUOTA_TTL_SECONDS   manifest quota.ttlSeconds (optional)
//   AEE_PLUGIN_AUDIT_DIR           where auditWriter() should append
//   AEE_PLUGIN_STATE_DIR           the generic per-plugin state volume (§4.8),
//                                  beside the audit volume — where a UI plugin
//                                  keeps its documents. Platform-set and never
//                                  overridable from a manifest's own sidecar.env
//                                  (same discipline as the signing secret/quota).
//
// Quota is deliberately parsed as "absent → no cap" rather than "absent → 0":
// a plugin whose manifest declares no quota is uncapped by design, and a
// mis-set variable must never brick a broker into refusing everything.
//
// `fallbacks` lets a retrofitted broker keep honouring its pre-plugin-system
// variable names for one release without branching in its own code.

const DEFAULTS = Object.freeze({
  id: '',
  port: 4004,
  signingSecret: '',
  quota: Object.freeze({ maxObjects: null, ttlSeconds: null }),
  auditDir: null,
  stateDir: null,
});

function firstDefined(env, names) {
  for (const name of names) {
    const v = env[name];
    if (typeof v === 'string' && v.trim() !== '') return v.trim();
  }
  return null;
}

// A positive integer, or null when absent/unparseable. Never throws, never 0 —
// see the "absent → no cap" note above.
function positiveInt(raw) {
  if (raw === null || raw === undefined) return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return null;
  return n;
}

// Read the broker's runtime config out of an env object (defaults to
// process.env). `fallbacks` maps a config key to legacy variable names tried
// after the standard one:
//   brokerConfig({ fallbacks: { signingSecret: ['PODMAN_MCP_SIGNING_SECRET'] } })
function brokerConfig({ env = process.env, fallbacks = {} } = {}) {
  const pick = (key, standard) => firstDefined(env, [standard, ...(fallbacks[key] || [])]);

  const port = positiveInt(pick('port', 'AEE_PLUGIN_PORT'));
  const maxObjects = positiveInt(pick('quotaMaxObjects', 'AEE_PLUGIN_QUOTA_MAX_OBJECTS'));
  const ttlSeconds = positiveInt(pick('quotaTtlSeconds', 'AEE_PLUGIN_QUOTA_TTL_SECONDS'));

  return {
    id: pick('id', 'AEE_PLUGIN_ID') || DEFAULTS.id,
    port: port === null ? DEFAULTS.port : port,
    signingSecret: pick('signingSecret', 'AEE_PLUGIN_SIGNING_SECRET') || DEFAULTS.signingSecret,
    quota: { maxObjects, ttlSeconds },
    auditDir: pick('auditDir', 'AEE_PLUGIN_AUDIT_DIR') || DEFAULTS.auditDir,
    stateDir: pick('stateDir', 'AEE_PLUGIN_STATE_DIR') || DEFAULTS.stateDir,
  };
}

// Enforce the per-scope object cap. `current` is how many objects this scope
// already owns (the broker counts them with its own scopeFilter — the SDK does
// not know what an "object" is for a given plugin).
// Returns null when the call may proceed, else a caller-facing error string.
// A null cap is "no quota declared" and always passes.
function quotaExceeded(quota, current, { adding = 1 } = {}) {
  const cap = quota && positiveInt(quota.maxObjects);
  if (cap === null) return null;
  const have = Number.isInteger(current) && current > 0 ? current : 0;
  if (have + adding <= cap) return null;
  return `scope quota exceeded: ${have} of ${cap} objects already in use`;
}

module.exports = {
  DEFAULTS,
  brokerConfig,
  positiveInt,
  quotaExceeded,
};
