'use strict';

// ============================================================
// AEE_RESOURCE_ACCESS_V2 — the unified resource-access model switch (#2356)
// ============================================================
//
// The unified resource-access redesign (concept #2349,
// docs/unified-resource-access-concept.md) replaces the ad-hoc
// `{scope, teamId, assignedTeamIds, userId}` tier split across Model Providers,
// SSH keys and GitHub tokens with one identity-vs-tier model applied to all
// three classes. It lands as a sequence of PRs (PR4–PR7) that change
// enforcement, visibility and runtime resolution; this flag lets those PRs land
// "dark" — merged but inert — until an operator opts in explicitly.
//
// OFF (the DEFAULT): today's behaviour, unchanged. An upgraded stack sees no
//   difference in how resources are scoped, selected or consumed.
// ON: the new identity/scope model is enforced end-to-end.
//
// **Why off is the default.** Exactly the reasoning behind AUTH_ENABLED
// (auth-mode.js) and AEE_POOLS_ENABLED (pools-mode.js): a stack that pulls a new
// image must not find its access rules quietly rewritten. Activation is a
// deliberate act.
//
// This module is intentionally self-contained (it inlines its own token sets
// rather than importing them from auth-mode.js) so it can be kept **byte-
// identical** on both sides of the orchestrator/admin-console mirror — the
// redesign gates code in both container images (admin-console `scope.js` and
// route handlers; orchestrator `credential-resolution.js`, offboarding), and the
// two images cannot require across the package boundary. A two-sided guard test
// asserts the copies never drift. Read once at boot (api.js), reused for both the
// env flag and the `GET /api/resource-access-mode` endpoint the SPA polls once on
// load.

const ON_TOKENS = Object.freeze(['1', 'true', 'yes', 'on']);
const OFF_TOKENS = Object.freeze(['', '0', 'false', 'no', 'off']);

function resolveResourceAccessV2(env = {}) {
  return describeResourceAccessMode(env).enabled;
}

// Anything unrecognised reads as OFF — a typo in the flag must not silently
// switch the whole access model over to a behaviour the operator hasn't reviewed.
function describeResourceAccessMode(env = {}) {
  const raw = env && env.AEE_RESOURCE_ACCESS_V2;
  const token = String(raw === undefined || raw === null ? '' : raw).trim().toLowerCase();
  if (ON_TOKENS.includes(token)) return { enabled: true, raw, recognised: true };
  if (OFF_TOKENS.includes(token)) return { enabled: false, raw, recognised: true };
  return { enabled: false, raw, recognised: false };
}

// One line for the container log at boot, so the mode is never a guess.
function resourceAccessModeLogLine(env = {}) {
  const mode = describeResourceAccessMode(env);
  const state = mode.enabled ? 'enabled (unified model)' : 'disabled (default)';
  if (!mode.recognised) {
    return `AEE_RESOURCE_ACCESS_V2='${mode.raw}' is not a recognised boolean — unified resource access ${state}`;
  }
  return `Unified resource access: ${state}`;
}

module.exports = {
  resolveResourceAccessV2,
  describeResourceAccessMode,
  resourceAccessModeLogLine,
  ON_TOKENS,
  OFF_TOKENS,
};
