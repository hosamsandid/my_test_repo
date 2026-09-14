'use strict';

// ============================================================
// AEE_POOLS_ENABLED — the agent-pool parallelism/autoscaling kill switch (#2302)
// ============================================================
//
// The pool parallelism/autoscaling mechanism (#2270-#2296) still needs
// teardown/reaping polish before it is production-ready. Until then the
// platform stays stable by default: the flag is OFF unless explicitly set,
// exactly like AUTH_ENABLED (auth-mode.js) — a stack that pulls a new image
// must not find new behaviour without a deliberate operator act.
//
// OFF (the DEFAULT): the Flow Editor's Parallelism button/panel are hidden,
//   and the per-role Scaling controls (Agent Chat Settings, NodeInspector)
//   render disabled with a "Coming Soon" badge rather than disappearing —
//   so the feature stays visible and isn't forgotten.
// ON: current behaviour, unchanged.
//
// Read once at boot (api.js), reused for both the env-flag itself and the
// `GET /api/pools-mode` endpoint the SPA polls once on load.

const { ON_TOKENS, OFF_TOKENS } = require('./auth-mode');

function resolvePoolsEnabled(env = {}) {
  return describePoolsMode(env).enabled;
}

// Anything unrecognised reads as OFF — a typo in the flag must not silently
// turn on a feature the operator hasn't reviewed.
function describePoolsMode(env = {}) {
  const raw = env && env.AEE_POOLS_ENABLED;
  const token = String(raw === undefined || raw === null ? '' : raw).trim().toLowerCase();
  if (ON_TOKENS.includes(token)) return { enabled: true, raw, recognised: true };
  if (OFF_TOKENS.includes(token)) return { enabled: false, raw, recognised: true };
  return { enabled: false, raw, recognised: false };
}

function poolsModeLogLine(env = {}) {
  const mode = describePoolsMode(env);
  const state = mode.enabled ? 'enabled' : 'disabled (default)';
  if (!mode.recognised) {
    return `AEE_POOLS_ENABLED='${mode.raw}' is not a recognised boolean — agent pools ${state}`;
  }
  return `Agent pools: ${state}`;
}

module.exports = {
  resolvePoolsEnabled,
  describePoolsMode,
  poolsModeLogLine,
};
