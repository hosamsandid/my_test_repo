'use strict';

// ============================================================
// AUTH_ENABLED — the single-user ⇄ multi-user switch (#1457, epic #2076 P0)
// ============================================================
//
// The teams data model (#299) and the scope filter (#302) shipped *live* but
// inert: on a single-operator stack the only principal is the env admin, who
// gets `all: true`, so nothing is ever filtered. #1457 makes that state an
// explicit, named mode instead of an accident of there being one login.
//
//   AUTH_ENABLED off (the DEFAULT)  — single-user compatibility. Whoever is
//     signed in is the operator: `computeScope` short-circuits to the implicit
//     System-Admin scope and every list filter and management gate is a no-op.
//     An existing stack that upgrades sees no behavioural change at all.
//   AUTH_ENABLED on                 — multi-user. Scope is computed from the
//     user record and its memberships, exactly as `scope.js` already does.
//
// **Why off is the default.** This is a migration flag. An operator who pulls a
// new image must not find their console suddenly filtered because a user record
// exists; activation is a deliberate act. The mirror-image concern — that a
// stack which HAS named users could be reverted to single-user and hand them all
// full visibility — is real, which is why `singleUserElevationWarning` exists
// and is logged at boot rather than left to be discovered.
//
// **Note the deliberate asymmetry with `computeScope`'s parameter default.**
// The env resolves to *off*; the `authEnabled` parameter of `computeScope`
// defaults to *on*. A missing argument must never silently grant `all: true`, so
// the pure predicate fails closed while the operator-facing flag stays
// backwards-compatible. api.js is the one place that joins them.
//
// This module is admin-console-only and needs no orchestrator twin:
// authorization is computed exclusively in the console (`getScope`), and the
// orchestrator's Default-Team adoption runs unconditionally — it is data
// preparation, so flipping the flag on later needs no migration step.

const ON_TOKENS = Object.freeze(['1', 'true', 'yes', 'on']);
const OFF_TOKENS = Object.freeze(['', '0', 'false', 'no', 'off']);

// Read the raw flag. Anything unrecognised is treated as OFF (see
// `describeAuthMode` for why it is also reported): a typo must not lock an
// operator out of the resources they were looking at a minute ago.
function resolveAuthEnabled(env = {}) {
  return describeAuthMode(env).enabled;
}

// The same decision, with enough detail to log honestly: `raw` as configured,
// and `recognised: false` when the value is neither an on- nor an off-token.
function describeAuthMode(env = {}) {
  const raw = env && env.AUTH_ENABLED;
  const token = String(raw === undefined || raw === null ? '' : raw).trim().toLowerCase();
  if (ON_TOKENS.includes(token)) return { enabled: true, raw, recognised: true };
  if (OFF_TOKENS.includes(token)) return { enabled: false, raw, recognised: true };
  return { enabled: false, raw, recognised: false };
}

// One line for the container log at boot, so the mode is never a guess.
function authModeLogLine(env = {}) {
  const mode = describeAuthMode(env);
  const state = mode.enabled ? 'multi-user' : 'single-user (compatibility)';
  if (!mode.recognised) {
    return `AUTH_ENABLED='${mode.raw}' is not a recognised boolean — running in ${state} mode`;
  }
  return `Authorization mode: ${state}`;
}

// The footgun, made visible. In single-user mode every principal who can sign in
// is the operator, so a stack that already carries named user records is granting
// each of them full visibility. Returns null when there is nothing to warn about
// (multi-user mode, or no user records — the genuine single-user case).
function singleUserElevationWarning(users = [], env = {}) {
  if (resolveAuthEnabled(env)) return null;
  const list = Array.isArray(users) ? users.filter(u => u && typeof u === 'object') : [];
  if (list.length === 0) return null;
  const nonAdmins = list.filter(u => !u.systemAdmin).length;
  if (nonAdmins === 0) return null;
  return `AUTH_ENABLED is off (single-user compatibility) but ${nonAdmins} non-admin user record(s) exist — `
    + 'every one of them signs in with full visibility. Set AUTH_ENABLED=true to enforce team scoping.';
}

module.exports = {
  resolveAuthEnabled,
  describeAuthMode,
  authModeLogLine,
  singleUserElevationWarning,
  ON_TOKENS,
  OFF_TOKENS,
};
