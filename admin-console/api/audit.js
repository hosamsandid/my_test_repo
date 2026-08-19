'use strict';

// Audit trail for mutating actions (#305, part of the multi-user concept #178).
//
// Every mutating /api request (POST/PUT/PATCH/DELETE) produces one append-only
// JSONL entry naming the acting human (from the #276 session) and the affected
// resource. This is deliberately a SEPARATE log from the Matrix chat history,
// which does not capture config mutations.
//
// Safety contract: auditing is strictly best-effort. The middleware logs from a
// `res.on('finish')` handler (after the response is already sent) and every file
// operation is wrapped so a logging failure can NEVER block, delay, or break a
// request. If the audit volume is unwritable, requests still succeed.

const fs = require('fs');
const path = require('path');
const { readLastLinesAcross } = require('./tail-read');

// Persistent location on the shared workspace volume. Overridable for tests.
const AUDIT_DIR = process.env.AUDIT_DIR || '/workspace/audit';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function classifyOutcome(status) {
  if (status < 400) return 'success';
  if (status === 401 || status === 403) return 'denied';
  return 'error';
}

// Build the normalized audit event for a finished request/response pair.
function buildEvent(req, res) {
  const pathOnly = String(req.originalUrl || req.url || '').split('?')[0];
  let actor = (req.user && req.user.username) || null;
  // Login runs before the gate populates req.user — attribute it to the
  // attempted username so failed/successful logins are still named.
  if (!actor && pathOnly === '/api/auth/login') {
    actor = (req.body && typeof req.body.username === 'string') ? req.body.username : null;
  }
  return {
    ts: new Date().toISOString(),
    actor: actor || 'anonymous',
    action: `${req.method} ${pathOnly}`,
    method: req.method,
    resource: pathOnly,
    // Full per-resource team attribution arrives with team scoping (#302); for
    // now record an explicit teamId only when the request body carries one.
    teamId: (req.body && typeof req.body.teamId === 'string') ? req.body.teamId : null,
    status: res.statusCode,
    outcome: classifyOutcome(res.statusCode),
    ip: req.ip || (req.socket && req.socket.remoteAddress) || null,
    // Assist provenance (#1211): resolveAssistTarget stamps req.assistMeta with
    // the { endpointId, model } an AI-helper call billed against, so the audit
    // trail answers "which key paid for this" after the fact. Absent on
    // non-assist mutations.
    ...(req.assistMeta ? { assist: req.assistMeta } : {}),
  };
}

// Append one event as a JSONL line to the current day's file. Never throws.
function record(event) {
  try {
    fs.mkdirSync(AUDIT_DIR, { recursive: true });
    const day = String(event.ts).slice(0, 10); // YYYY-MM-DD
    fs.appendFileSync(path.join(AUDIT_DIR, `audit-${day}.jsonl`), JSON.stringify(event) + '\n');
  } catch {
    // Swallow: auditing must never break or block the request path.
  }
}

// Express middleware. Mount on '/api' BEFORE the auth gate so it sees every
// mutating request (including denied/unauthenticated ones); req.user is read
// lazily at finish-time, by which point the gate has populated it.
function auditMutations(req, res, next) {
  if (!MUTATING.has(req.method)) return next();
  res.on('finish', () => {
    try { record(buildEvent(req, res)); } catch { /* never throw from a finish handler */ }
  });
  next();
}

// Read the most recent entries (newest first). Best-effort; returns [] on error.
// Cost is bounded by `cap` (the requested page size), not by total audit
// history: only the tail of the most recent day files is read (#1684).
function recentEntries(limit = 200) {
  const cap = Number.isFinite(limit) && limit > 0 ? Math.min(limit, 1000) : 200;
  try {
    const files = fs.readdirSync(AUDIT_DIR)
      .filter(f => /^audit-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
      .sort() // chronological by name
      .map(f => path.join(AUDIT_DIR, f));
    // Newest `cap` lines across day files, in chronological order — identical
    // to reading everything and slicing the last `cap`, but without parsing the
    // whole history on every request.
    return readLastLinesAcross(files, cap)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean)
      .reverse();
  } catch {
    return [];
  }
}

module.exports = { auditMutations, record, buildEvent, recentEntries, classifyOutcome, AUDIT_DIR };
