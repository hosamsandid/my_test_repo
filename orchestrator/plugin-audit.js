'use strict';

// ─── plugin broker audit line (plugin system Phase 2, #1518) ─────────────────
//
// Every broker call is one append-only JSONL line (docs/plugin-system-concept
// .md §4.7, the "broker audit obligation"): who (scopeId + agentId), what
// (subcommand), how it ended (outcome), when (ts). The broker holds the single
// backend credential and mints per-scope tokens in front of it, so this log is
// the only place a call is attributable — it is a governance obligation, not a
// convenience.
//
// This module is the pure shape + retention core shared by every broker (and by
// the SDK in Phase 4), the same discipline as the other pure plugin modules.
// The fs append lives in the broker runtime.
//
// scopeId vs agentId: at 'team' granularity many agents share one scopeId, so
// the pair distinguishes which member made the call under a shared scope. At
// 'agent' granularity the two COINCIDE by construction — that is expected and
// kept (not deduplicated to one field): keeping both makes a line readable the
// same way at either granularity, and a mixed-granularity backend's log stays
// uniform (§4.6).

const OUTCOMES = Object.freeze(['ok', 'domain-error', 'usage-error', 'unreachable', 'denied']);

function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

// Build one normalised audit record. Returns null when a required field is
// missing (a malformed call is never silently logged as a valid one). `ts` is
// supplied by the caller (ISO 8601) so this stays pure/clock-free.
function buildPluginAuditLine({ ts, pluginId, scopeId, agentId, subcommand, outcome, detail, identity, interactive } = {}) {
  if (!isNonEmptyString(ts)) return null;
  if (!isNonEmptyString(pluginId)) return null;
  if (!isNonEmptyString(scopeId)) return null;
  if (!isNonEmptyString(agentId)) return null;
  if (!isNonEmptyString(subcommand)) return null;
  const line = {
    ts,
    pluginId,
    scopeId,
    agentId,
    subcommand,
    outcome: OUTCOMES.includes(outcome) ? outcome : 'ok',
  };
  if (isNonEmptyString(detail)) line.detail = detail;
  // Optional (#2562): WHOSE credential served the call — a platform user id
  // for a person's own credential, "service-account" for the team's — and
  // whether it was a live chat turn. Absent for brokers without a person tier.
  if (isNonEmptyString(identity)) {
    line.identity = identity;
    line.interactive = interactive === true;
  }
  return line;
}

// Serialise a record to a single JSONL string (no trailing newline — the
// broker's append writer owns the separator).
function serializeAuditLine(record) {
  return JSON.stringify(record);
}

// Parse a JSONL audit file's contents into records, skipping blank/corrupt
// lines (a partially-written tail must never crash a read).
function parseAuditLines(text) {
  return String(text == null ? '' : text)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

// Drop records older than `retentionMs` relative to `nowMs` (both ms). A record
// with an unparseable `ts` is dropped defensively rather than kept forever.
function pruneAuditLines(records, retentionMs, nowMs) {
  const cutoff = nowMs - retentionMs;
  return (Array.isArray(records) ? records : []).filter((r) => {
    const t = r && typeof r.ts === 'string' ? Date.parse(r.ts) : NaN;
    return Number.isFinite(t) && t >= cutoff;
  });
}

module.exports = {
  OUTCOMES,
  buildPluginAuditLine,
  serializeAuditLine,
  parseAuditLines,
  pruneAuditLines,
};
