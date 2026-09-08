'use strict';

// ─── jira broker: write-authorisation glue (Phase 4, D3) ─────────────────────
//
// Reads (`projects` / `list` / `show` / `inbox`) are open to any granted agent.
// The two writes (`comment` / `transition`) are **role-gated, not
// confirmation-gated** (docs/jira-plugin-plan.md D3): moving a ticket is routine
// and reversible, and an approval pen on it would stall every unattended run at
// the first transition. The gate is enforced HERE, server-side, so a prompt
// cannot talk an unauthorised agent past it; every write is audited with the
// calling scope.
//
// jira declares `scopes: ["team"]` only (a Jira site binding is a team-level
// fact — §6.1), so every caller resolves to `kind: 'team'`. The manifest's
// `policy` rules (`{ comment|transition: { scopes: ["team"] } }`) therefore pass
// for any granted team's agent — which IS D3's intent. The value of routing
// through `authorizeAction` anyway: the enforcement path exists, so tightening a
// rule later (e.g. an agent-granularity restriction, or a `requiresApproval`
// entry for a future destructive op) is a manifest edit, not a broker change.
//
// `requiresApproval` stays deliberately EMPTY in v1 rather than removed from the
// design (D3) — it is the right mechanism the day a genuinely destructive Jira
// op is added (bulk transition, delete).

const { authorizeAction } = require('../../../broker-sdk');

// Mirror of plugins/jira/plugin.json's `policy` (a broker cannot read the
// registry — the podman-token.js discipline). Keep in sync.
const POLICY = Object.freeze({
  comment: { scopes: ['team'] },
  transition: { scopes: ['team'] },
});

// Wired but empty — see the header.
const REQUIRES_APPROVAL = Object.freeze([]);

// Decide whether a write subcommand may run. jira is team-only, so the caller
// kind is fixed. Returns `{ allow }` or `{ allow:false, code, reason }`.
function authorizeWrite(subcommand) {
  const authz = authorizeAction(POLICY, subcommand, { kind: 'team' });
  return authz.allowed ? { allow: true } : { allow: false, code: authz.code, reason: authz.reason };
}

module.exports = { POLICY, REQUIRES_APPROVAL, authorizeWrite };
