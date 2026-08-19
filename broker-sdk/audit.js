'use strict';

// ─── Broker SDK: audit writer (plugin system Phase 4, #1520) ─────────────────
//
// Every broker call is one append-only JSONL line (§4.7): who (scopeId +
// agentId), what (subcommand), how it ended (outcome), when (ts). The broker
// holds the single backend credential and mints per-scope tokens in front of
// it, so this log is the only place a call is attributable — a governance
// obligation, not a convenience.
//
// The pure shape + retention core below is byte-identical (contract) to
// `orchestrator/plugin-audit.js`, which was authored in Phase 2 already noting
// it is "shared by every broker (and by the SDK in Phase 4)". A broker's Docker
// build context can't require across directories (the podman-token.js
// convention), so this SDK copy carries the core; `auditWriter(dir)` adds the
// fs append + retention rotation that "lives in the broker runtime".
//
// scopeId vs agentId: at 'team' granularity many agents share one scopeId, so
// the pair distinguishes which member made the call; at 'agent' granularity the
// two COINCIDE by construction — kept, not deduplicated, so a line reads the
// same way at either granularity.

const fs = require('fs');
const path = require('path');

const OUTCOMES = Object.freeze(['ok', 'domain-error', 'usage-error', 'unreachable', 'denied']);

function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

// Build one normalised audit record. Returns null when a required field is
// missing (a malformed call is never silently logged as a valid one). `ts` is
// supplied by the caller (ISO 8601) so this stays pure/clock-free.
function buildPluginAuditLine({ ts, pluginId, scopeId, agentId, subcommand, outcome, detail } = {}) {
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
  return line;
}

// Serialise a record to a single JSONL string (no trailing newline — the
// append writer owns the separator).
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

// Broker-runtime fs writer over the pure core. `dir` is the audit directory
// (created lazily); `file` defaults to `audit.jsonl`. `retentionMs` (optional)
// rotates on write: after each append, records older than the window are
// dropped and the file rewritten. Retention is applied on append rather than on
// a timer so a broker needs no background job.
//
// Clock injection: `now` (default () => Date.now()) keeps the writer testable
// with a frozen clock.
function auditWriter(dir, { file = 'audit.jsonl', retentionMs = null, now = () => Date.now() } = {}) {
  if (!isNonEmptyString(dir)) throw new Error('auditWriter requires a dir');
  const filePath = path.join(dir, file);

  function ensureDir() {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Append one call record. Returns the written record, or null if the record
  // was malformed (never writes a partial/invalid line). Best-effort: an fs
  // error is thrown to the caller, which decides whether audit failure blocks
  // the op (§4.7 leaves that to the broker).
  function write(entry) {
    const record = buildPluginAuditLine(entry);
    if (!record) return null;
    ensureDir();
    fs.appendFileSync(filePath, `${serializeAuditLine(record)}\n`, 'utf8');
    if (Number.isFinite(retentionMs) && retentionMs > 0) rotate();
    return record;
  }

  // Read all current (non-pruned when retention is set) records.
  function read() {
    let text;
    try { text = fs.readFileSync(filePath, 'utf8'); } catch { return []; }
    const records = parseAuditLines(text);
    if (Number.isFinite(retentionMs) && retentionMs > 0) {
      return pruneAuditLines(records, retentionMs, now());
    }
    return records;
  }

  // Rewrite the file with only the records inside the retention window.
  function rotate() {
    if (!(Number.isFinite(retentionMs) && retentionMs > 0)) return;
    let text;
    try { text = fs.readFileSync(filePath, 'utf8'); } catch { return; }
    const kept = pruneAuditLines(parseAuditLines(text), retentionMs, now());
    ensureDir();
    fs.writeFileSync(filePath, kept.map((r) => `${serializeAuditLine(r)}\n`).join(''), 'utf8');
  }

  return { filePath, write, read, rotate };
}

module.exports = {
  OUTCOMES,
  buildPluginAuditLine,
  serializeAuditLine,
  parseAuditLines,
  pruneAuditLines,
  auditWriter,
};
