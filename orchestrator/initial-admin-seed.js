'use strict';

// The configured initial user, resolved from environment config (#2059,
// concept `docs/decentralised-access-concept.md` / #2041 D13).
//
// Before #2059 the deployment's `ADMIN_USERNAME`/`ADMIN_PASSWORD` pair WAS a
// login: the console string-compared against it and issued a session with no
// user record behind it, so the only principal on a fresh stack had no id. It is
// now a **seed** — consumed exactly once, on a stack with zero user records, to
// create a real System-Admin record — and never consulted again. The consuming
// half is `teamsStore.seedInitialSystemAdmin` (which owns the zero-users gate);
// this module owns only the two decisions above it: which configured input wins,
// and what the audit trail says about the seeding.
//
// Kept pure and separate from `orchestrator.js` because `bootstrapTeams()` is
// not exported from that 14k-line module and therefore cannot be unit-tested;
// every judgement worth asserting lives here instead.

const fs = require('node:fs');
const path = require('node:path');

// The shipped defaults, mirroring what `admin-console/api/auth.js` used to
// accept so a stack that never set the pair keeps the documented `admin`/`admin`
// first-boot credential — as a real record now, which the release note calls
// out: after this change the password lives in the record, so rotating the
// variable in `.env` no longer revokes the account (only the Users page does).
const DEFAULT_ADMIN_USERNAME = 'admin';
const DEFAULT_ADMIN_PASSWORD = 'admin';

// Which configured input describes the first administrator, and how they will
// authenticate. Returns null only when the deployment has explicitly blanked
// the password pair AND named no bootstrap subject — a stack that wants no
// seeded record at all (an SSO deployment provisioning its admin by hand).
//
// `BOOTSTRAP_SYSTEM_ADMIN_SUBJECT` wins when set: it is the explicit, opt-in
// input for SSO stacks, it carries no password (the person authenticates
// through the identity-aware proxy), and it can name a corporate identity that
// is not a legal `ADMIN_USERNAME`. It was documented in
// `docs/teams-data-model.md` long before this ticket but reached no shipped
// config, so it had never once run.
function resolveInitialAdminSeed(env = process.env) {
  const bootstrapSubject = str(env.BOOTSTRAP_SYSTEM_ADMIN_SUBJECT);
  if (bootstrapSubject) {
    return {
      source: 'bootstrap-subject',
      subject: bootstrapSubject,
      password: '',
      email: str(env.BOOTSTRAP_SYSTEM_ADMIN_EMAIL),
      displayName: str(env.BOOTSTRAP_SYSTEM_ADMIN_NAME),
    };
  }

  // `ADMIN_USERNAME`/`ADMIN_PASSWORD`: absent means "unset", so the shipped
  // default applies; present-but-blank is a deliberate opt-out, because an
  // operator who empties the password does not want a password-login account.
  const subject = env.ADMIN_USERNAME === undefined
    ? DEFAULT_ADMIN_USERNAME
    : str(env.ADMIN_USERNAME);
  const password = env.ADMIN_PASSWORD === undefined
    ? DEFAULT_ADMIN_PASSWORD
    : str(env.ADMIN_PASSWORD);
  if (!subject || !password) return null;

  return {
    source: 'admin-username',
    subject,
    password,
    email: '',
    displayName: '',
  };
}

// One audit entry for the seeding (#2059 AC1), in the shape
// `admin-console/api/audit.js` writes for every mutating request — the audit
// trail is a JSONL directory contract on the shared volume, not a module both
// containers can import, so the shape is reproduced here and pinned by a test
// that diffs the key set against the console's own `buildEvent`.
//
// `method: 'BOOTSTRAP'` rather than a faked `POST` because no request happened:
// an access review reading this line should see that the platform created this
// account at first boot, not a human. The password is of course never included
// — only whether one was seeded.
function buildSeedAuditEvent({ seed, user, at = new Date() } = {}) {
  const subject = (user && user.subject) || (seed && seed.subject) || null;
  return {
    ts: at.toISOString(),
    actor: subject,
    action: 'BOOTSTRAP /internal/admin/users',
    method: 'BOOTSTRAP',
    resource: '/internal/admin/users',
    teamId: null,
    status: 201,
    outcome: 'success',
    ip: null,
    seed: {
      reason: 'initial-system-admin',
      source: (seed && seed.source) || null,
      subject,
      userId: (user && user.id) || null,
      hasPassword: !!(user && user.hasPassword),
    },
  };
}

// Append one event to the audit trail. Best-effort with the same contract as
// the console's writer: a seeding must never fail because the audit volume is
// unwritable, so every error is swallowed and reported to the caller as false.
function recordSeedAudit(dir, event) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const day = String(event.ts).slice(0, 10);
    fs.appendFileSync(path.join(dir, `audit-${day}.jsonl`), `${JSON.stringify(event)}\n`);
    return true;
  } catch {
    return false;
  }
}

function str(v) {
  return typeof v === 'string' ? v.trim() : '';
}

module.exports = {
  resolveInitialAdminSeed,
  buildSeedAuditEvent,
  recordSeedAudit,
  DEFAULT_ADMIN_USERNAME,
  DEFAULT_ADMIN_PASSWORD,
};
