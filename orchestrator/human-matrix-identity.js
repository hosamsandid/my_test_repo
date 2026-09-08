'use strict';

// Per-human Matrix identity — the localpart grammar (#1458, epic #2076 P1).
//
// Today the stack has exactly ONE human Matrix account: the shared admin whose
// token lives in `MATRIX_ACCESS_TOKEN`. Every DM room is 1:1 between an agent
// and *that* account, so one admin token reads every human's chat with every
// agent (docs/governance-concept.md §11 names this as the live risk, and
// docs/multi-user-concept.md §4 as the design of record for the fix).
//
// This module owns the first half of that fix: the deterministic mapping from a
// human's stable identity onto a Matrix localpart, and the rule that tells a
// human account apart from a service account. It is deliberately pure (no fs,
// no network, no clock) so both the mapping and the reservation can be
// unit-tested without a homeserver.
//
// ── Why derive from `subject`, not from the user record's `id` ──────────────
// `user.id` is a `crypto.randomUUID()` minted when the record is created, so a
// human who is off-boarded and later re-onboarded would get a *different*
// localpart and lose every room they had. `subject` is the stable identifier of
// the corporate identity (the OIDC subject claim / corporate email — see
// `teams-store.js` `getUserBySubject`), so deriving from it makes the Matrix
// account survive a record being re-created. That matches how an agent's Matrix
// account survives a delete→recreate of the same agent id today.
//
// The subject is normalised exactly the way `getUserBySubject` compares it
// (trim + lowercase), so two records that the user store considers the same
// identity can never resolve to two different Matrix accounts.
//
// ── Why a hash rather than the subject itself ──────────────────────────────
// A corporate subject is usually an email; a Matrix localpart may not contain
// `@` and is world-readable to every room member. Hashing keeps the localpart
// legal, fixed-length, and free of personal data. The display name — set on the
// Matrix profile at provisioning time — is what humans actually read.

const crypto = require('crypto');

// Reserved prefix for human identities. Per docs/multi-user-concept.md §2 the
// separation between humans and service accounts (the admin bot, the per-agent
// users) is what lets the audit trail answer "human or machine?" for every
// action, so it has to be structural, not a convention.
const HUMAN_LOCALPART_PREFIX = 'u-';

// 8 bytes / 16 hex chars of SHA-256. 64 bits is far more than a user directory
// needs (a collision would require ~5 billion distinct subjects for a 1-in-a-
// billion chance) and keeps the localpart short enough to read in a log line.
const HUMAN_LOCALPART_HASH_BYTES = 8;

// The exact shape a human localpart has. Anchored and lowercase-only so it can
// double as the *reservation* predicate below: nothing else in the stack may
// occupy a localpart of this shape.
const HUMAN_LOCALPART_RE = /^u-[0-9a-f]{16}$/;

// Matrix server name of this stack. Every id in the codebase is `@<x>:local`
// (`docker-compose.yml` sets `CONTINUWUITY_SERVER_NAME: local`); kept as a
// parameter default rather than hard-coded so a federated deployment has one
// place to change.
const DEFAULT_SERVER_NAME = 'local';

// Normalise a subject the way the user store compares it, so "A@x.com" and
// " a@X.com " are one identity here too.
function normalizeSubject(subject) {
  if (typeof subject !== 'string') return '';
  return subject.trim().toLowerCase();
}

// Deterministic Matrix localpart for a human's stable subject.
// Throws on a blank subject — a caller with no stable identity must not get a
// Matrix account at all (fail closed; the alternative is silently minting one
// shared "empty subject" account that several humans would then share).
function humanMatrixLocalpart(subject) {
  const normalized = normalizeSubject(subject);
  if (!normalized) throw new Error('human Matrix localpart requires a non-empty subject');
  const digest = crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
  return HUMAN_LOCALPART_PREFIX + digest.slice(0, HUMAN_LOCALPART_HASH_BYTES * 2);
}

// Full Matrix user id for a human's stable subject, e.g. `@u-1f3c…:local`.
function humanMatrixUserId(subject, serverName = DEFAULT_SERVER_NAME) {
  return `@${humanMatrixLocalpart(subject)}:${serverName}`;
}

// Is this localpart one of ours — i.e. minted by `humanMatrixLocalpart`?
function isHumanMatrixLocalpart(localpart) {
  return typeof localpart === 'string' && HUMAN_LOCALPART_RE.test(localpart);
}

// Same question for a full `@localpart:server` id. A malformed id is not a
// human id (fail closed).
function isHumanMatrixUserId(userId) {
  if (typeof userId !== 'string' || !userId.startsWith('@')) return false;
  const colon = userId.indexOf(':');
  if (colon < 0) return false;
  return isHumanMatrixLocalpart(userId.slice(1, colon));
}

// The complement: the admin bot (`@admin:local`) and every per-agent account
// (`@<agentId>:local`) are service identities. Expressed as "not a human" on
// purpose — the human shape is the narrow, reserved one, so anything that does
// not match it is by definition not issued by the human-provisioning path.
function isServiceMatrixUserId(userId) {
  return !isHumanMatrixUserId(userId);
}

// Reservation guard. Agent ids are free-form slugs (`AGENT_ID_RE` in
// orchestrator.js allows `[A-Za-z0-9_-]`), so nothing structurally stops an
// operator from creating an agent literally called `u-0123456789abcdef` and
// thereby taking over a human's Matrix account. This predicate is what the
// single Matrix-account choke point (`ensureMatrixUser`) uses to refuse that.
//
// It is deliberately as NARROW as the human shape: an agent called `u-payments`
// or `u-2` is unaffected, so the reservation cannot break an existing agent.
function isReservedHumanLocalpart(localpart) {
  return isHumanMatrixLocalpart(localpart);
}

module.exports = {
  HUMAN_LOCALPART_PREFIX,
  HUMAN_LOCALPART_RE,
  HUMAN_LOCALPART_HASH_BYTES,
  DEFAULT_SERVER_NAME,
  normalizeSubject,
  humanMatrixLocalpart,
  humanMatrixUserId,
  isHumanMatrixLocalpart,
  isHumanMatrixUserId,
  isServiceMatrixUserId,
  isReservedHumanLocalpart,
};
