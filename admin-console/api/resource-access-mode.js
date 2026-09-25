'use strict';

// ============================================================
// AEE_RESOURCE_ACCESS_V2 — the unified resource-access model switch (#2356)
// ============================================================
//
// The unified resource-access redesign (concept #2349,
// docs/unified-resource-access-concept.md) replaces the ad-hoc
// `{scope, teamId, assignedTeamIds, userId}` tier split across Model Providers,
// SSH keys and GitHub tokens with one identity-vs-tier model applied to all
// three classes.
//
// ON (the DEFAULT, since the model shipped — #2360): the new identity/scope model
//   is enforced end-to-end. This is now the reviewed, shipped behaviour, so a
//   fresh stack gets it without a manual opt-in.
// OFF: an explicit opt-OUT (a kill switch) that restores today's legacy
//   behaviour for a stack not ready to move. Flag-off is still kept byte-identical
//   to the pre-redesign world. The flag itself is scheduled for removal once the
//   opt-out is no longer needed (tracked separately).
//
// **Why ON is now the default.** While the PR chain (PR4–PR7) was landing, the
// flag defaulted OFF so the changes stayed "dark" — merged but inert — exactly
// like AUTH_ENABLED / AEE_POOLS_ENABLED. Now that the model is complete and has
// been exercised end to end, the default flips: the reviewed behaviour ships by
// default, and an operator who needs the old world opts OUT with a recognised OFF
// token (0/false/no/off).
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
const OFF_TOKENS = Object.freeze(['0', 'false', 'no', 'off']);

function resolveResourceAccessV2(env = {}) {
  return describeResourceAccessMode(env).enabled;
}

// Empty / unset → ON: the unified model is now the default. An operator opts OUT
// explicitly with a recognised OFF token; anything unrecognised (a typo) also
// falls back to the ON default rather than silently disabling the shipped model,
// and is flagged `recognised: false` so the boot log surfaces it.
function describeResourceAccessMode(env = {}) {
  const raw = env && env.AEE_RESOURCE_ACCESS_V2;
  const token = String(raw === undefined || raw === null ? '' : raw).trim().toLowerCase();
  if (token === '') return { enabled: true, raw, recognised: true };
  if (OFF_TOKENS.includes(token)) return { enabled: false, raw, recognised: true };
  if (ON_TOKENS.includes(token)) return { enabled: true, raw, recognised: true };
  return { enabled: true, raw, recognised: false };
}

// One line for the container log at boot, so the mode is never a guess.
function resourceAccessModeLogLine(env = {}) {
  const mode = describeResourceAccessMode(env);
  const state = mode.enabled ? 'enabled (default)' : 'disabled (explicit opt-out)';
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
