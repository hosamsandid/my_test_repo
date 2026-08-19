'use strict';

// Authored-prompt version history (#990, docs/prompt-version-history-concept.md).
//
// A bounded, newest-first history of an agent's *authored* system prompt — the
// standalone `agent`/`team-member` prompt (config.systemPrompt / AGENT-PROMPT.md)
// or a `team`'s `systemPromptTemplate`. It mirrors the shape/semantics of
// orchestrator/skill-manifest.js (monotonic version, hash-gated bump, newest-
// first, bounded) but stores FULL content snapshots — unlike a skill manifest
// (which hashes the on-disk directory), a prompt rollback needs the actual text,
// and a prompt is small enough (KB) to snapshot in full.
//
// Console-only: every human prompt edit funnels through the admin-console PUT
// handlers (where `req.user` is available), so there is no orchestrator mirror
// and no two-sided fixture — a single copy lives here.
//
// Only Node builtins (crypto/fs/path). The pure functions accept plain data; the
// thin IO wrappers take an injectable fs/path for testing. Every call site wraps
// this best-effort so stamping never breaks the primary prompt write.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { STATE_DIR, resolveAgentStateDir } = require('./agent-state-dir');

const HISTORY_V = 1;
const HISTORY_LIMIT = 20;
const HASH_LEN = 12; // 12-hex prefix of the SHA-256
const HISTORY_FILENAME = 'prompt-history.json';
// The per-agent state directory (`.agent-studio`, migrated from the legacy
// `.aee` on first touch, #1549). Kept as a named export for back-compat.
const HISTORY_SUBDIR = STATE_DIR;

// The closed set of history actions. `baseline` = the pre-existing prompt seeded
// on the first capture; `edited` = a normal edit; `inherited` = a team-member
// switched its override back to the team template (content cleared); `reverted`
// = a rollback to an earlier version (itself a new head, never destructive).
const ACTIONS = new Set(['baseline', 'edited', 'inherited', 'reverted']);

// Content hash: SHA-256 (12-hex prefix) of the UTF-8 prompt text. A prompt is a
// single string, so no framing is needed (cf. skill-manifest's multi-file hash).
function hashContent(content) {
  return crypto
    .createHash('sha256')
    .update(String(content == null ? '' : content), 'utf8')
    .digest('hex')
    .slice(0, HASH_LEN);
}

// Stamp the next history object. Given the existing history (or null) and the
// pre-/post-edit content, return the next `{ v, field, history }`.
//
//   - On the FIRST capture (empty history) a `baseline` v1 is seeded from
//     `oldContent`, so even the first edit leaves a prior version to revert to.
//   - Idempotent: when the new content hashes to the current head, nothing is
//     appended (re-saving an identical prompt is a no-op — no version bump).
//   - Otherwise a new head is unshifted with `version = head.version + 1`.
//   - History is newest-first and bounded to `limit` (default HISTORY_LIMIT).
function stampPromptHistory(existing, opts) {
  const o = opts || {};
  const at = o.at || new Date().toISOString();
  const by = o.by || 'unknown';
  const action = ACTIONS.has(o.action) ? o.action : 'edited';
  const limit = Number.isInteger(o.limit) && o.limit > 0 ? o.limit : HISTORY_LIMIT;
  const prev = (existing && typeof existing === 'object') ? existing : null;
  const field = o.field || (prev && prev.field) || 'systemPrompt';
  const newContent = String(o.newContent == null ? '' : o.newContent);
  const newHash = hashContent(newContent);

  const history = (prev && Array.isArray(prev.history)) ? prev.history.slice() : [];

  // Seed the baseline from the pre-edit content on the first capture.
  if (history.length === 0) {
    const oldContent = String(o.oldContent == null ? '' : o.oldContent);
    history.unshift({
      version: 1,
      at: o.baselineAt || at,
      by: o.baselineBy || 'unknown',
      action: 'baseline',
      hash: hashContent(oldContent),
      content: oldContent,
    });
  }

  const head = history[0];
  // Idempotent no-op when the content is unchanged from the current head.
  if (head && head.hash === newHash) {
    return { v: HISTORY_V, field, history: history.slice(0, limit) };
  }

  const version = (head && Number.isInteger(head.version) ? head.version : 0) + 1;
  const entry = { version, at, by, action, hash: newHash, content: newContent };
  if (o.note != null && o.note !== '') entry.note = o.note;
  history.unshift(entry);

  return { v: HISTORY_V, field, history: history.slice(0, limit) };
}

// Find a version's stored content, or null when the version isn't retained
// (pruned past the bound, or never existed). Used by the rollback path.
function findVersion(existing, version) {
  const history = (existing && Array.isArray(existing.history)) ? existing.history : [];
  const v = Number(version);
  return history.find(e => e && e.version === v) || null;
}

// A compact, content-free view for the list API (drops the full `content` of
// each entry, keeps a short preview). Keeps large payloads out of list responses.
function summarize(existing, previewLen = 160) {
  const history = (existing && Array.isArray(existing.history)) ? existing.history : [];
  const head = history[0];
  return {
    v: HISTORY_V,
    field: (existing && existing.field) || 'systemPrompt',
    currentVersion: head && Number.isInteger(head.version) ? head.version : 0,
    history: history.map(e => ({
      version: e.version,
      at: e.at,
      by: e.by,
      action: e.action,
      ...(e.note != null ? { note: e.note } : {}),
      hash: e.hash,
      contentPreview: String(e.content == null ? '' : e.content).slice(0, previewLen),
      contentLength: String(e.content == null ? '' : e.content).length,
    })),
  };
}

/* ─── Thin IO wrappers (fs/path injectable for tests) ────────────────────── */

function historyPath(agentDir, io = {}) {
  const pathImpl = io.path || path;
  // Resolve `.agent-studio/` — migrating a legacy `.aee/` on first touch — so an
  // upgraded agent's history is read/written under the new name (#1549).
  return pathImpl.join(resolveAgentStateDir(agentDir, io), HISTORY_FILENAME);
}

// Read an agent's prompt-history sidecar, or null when absent/unparseable.
function readPromptHistory(agentDir, io = {}) {
  const fsImpl = io.fs || fs;
  try {
    const obj = JSON.parse(fsImpl.readFileSync(historyPath(agentDir, io), 'utf8'));
    return (obj && typeof obj === 'object') ? obj : null;
  } catch {
    return null;
  }
}

// Write an agent's prompt-history sidecar (atomic tmp+rename, pretty JSON).
function writePromptHistory(agentDir, obj, io = {}) {
  const fsImpl = io.fs || fs;
  const pathImpl = io.path || path;
  const dir = resolveAgentStateDir(agentDir, io);
  fsImpl.mkdirSync(dir, { recursive: true });
  const file = pathImpl.join(dir, HISTORY_FILENAME);
  const tmp = file + '.tmp';
  fsImpl.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fsImpl.renameSync(tmp, file);
  return obj;
}

module.exports = {
  HISTORY_V, HISTORY_LIMIT, HASH_LEN, HISTORY_FILENAME, HISTORY_SUBDIR, ACTIONS,
  hashContent, stampPromptHistory, findVersion, summarize,
  historyPath, readPromptHistory, writePromptHistory,
};
