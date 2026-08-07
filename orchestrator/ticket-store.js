"use strict";

// ticket-store.js — pure logic for the parent-ticket binding feature (#1383).
//
// A "ticket" binds an agent chat session (room) to a parent GitHub issue so a
// human can navigate issue ⇄ conversation and running agents can read the
// association at session start. This module owns the branchy input parsing and
// the stored shapes; the fs / GitHub-network adapters live in `orchestrator.js`
// (write `ticket.json`, call `gh api`) and `admin-console/api/api.js` (the
// room-scoped binding file + the `ticket.bound` session-log event).
//
// Kept dependency-free so it lands in the orchestrator `node --test` job (#651),
// mirroring the pure-core / thin-adapter split of `repo-sync.js`.

// A GitHub issue URL, e.g. https://github.com/owner/repo/issues/123 (honours a
// self-hosted host — the host part is ignored, only owner/repo/number matter).
const ISSUE_URL_RE = /^https?:\/\/[^/]+\/([^/\s]+)\/([^/\s]+)\/issues\/(\d+)(?:[?#].*)?$/;
// "owner/repo" — a GitHub full name (no whitespace, exactly one slash).
const REPO_FULL_NAME_RE = /^[^/\s]+\/[^/\s]+$/;

// Parse a user-supplied issue reference into a structured target.
// Accepts a bare positive integer ("123" or "#123") or a GitHub issue URL.
// Returns { kind:'number', number } | { kind:'url', owner, repo, number } | null.
function parseIssueRef(raw) {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s) return null;
  const m = s.match(ISSUE_URL_RE);
  if (m) {
    const number = Number(m[3]);
    if (!Number.isInteger(number) || number < 1) return null;
    return { kind: "url", owner: m[1], repo: m[2], number };
  }
  const bare = s.replace(/^#/, "");
  if (/^\d+$/.test(bare)) {
    const number = Number(bare);
    if (Number.isInteger(number) && number >= 1) return { kind: "number", number };
  }
  return null;
}

// Resolve the "owner/repo" full name a bind action targets.
// A URL ref carries its own owner/repo (always wins); otherwise an explicit
// `repo` (validated) is used, else the environment's first declared repo.
// Returns the full name string, or null when none can be resolved.
function resolveRepoFullName(parsed, { explicitRepo = null, envRepoFullNames = [] } = {}) {
  if (parsed && parsed.kind === "url") return `${parsed.owner}/${parsed.repo}`;
  if (typeof explicitRepo === "string" && REPO_FULL_NAME_RE.test(explicitRepo.trim())) {
    return explicitRepo.trim();
  }
  const list = Array.isArray(envRepoFullNames) ? envRepoFullNames.filter(Boolean) : [];
  return list.length ? list[0] : null;
}

// Normalise a GitHub issue API payload into the stored ticket shape.
// Returns { repo, number, url, title[, state] } or null when the payload is
// missing an issue number.
function ticketFromIssue(issue, repoFullName) {
  if (!issue || typeof issue !== "object") return null;
  const number = Number(issue.number);
  if (!Number.isInteger(number) || number < 1) return null;
  const ticket = {
    repo: repoFullName,
    number,
    url: typeof issue.html_url === "string" ? issue.html_url : "",
    title: typeof issue.title === "string" ? issue.title : "",
  };
  if (typeof issue.state === "string" && issue.state) ticket.state = issue.state;
  return ticket;
}

// Validate a stored ticket shape (read back from disk or an API result).
function isValidTicket(t) {
  return (
    !!t &&
    typeof t === "object" &&
    typeof t.repo === "string" &&
    REPO_FULL_NAME_RE.test(t.repo) &&
    Number.isInteger(t.number) &&
    t.number >= 1
  );
}

// Register a child issue number on a parent ticket (AC6). Returns a NEW ticket
// object with the number appended to a de-duplicated, ascending `children`
// array, or null when the parent is invalid or the child number is malformed.
function addChild(ticket, childNumber) {
  if (!isValidTicket(ticket)) return null;
  const n = Number(childNumber);
  if (!Number.isInteger(n) || n < 1) return null;
  const children = Array.isArray(ticket.children) ? ticket.children.slice() : [];
  if (!children.includes(n)) children.push(n);
  children.sort((a, b) => a - b);
  return { ...ticket, children };
}

module.exports = {
  ISSUE_URL_RE,
  REPO_FULL_NAME_RE,
  parseIssueRef,
  resolveRepoFullName,
  ticketFromIssue,
  isValidTicket,
  addChild,
};
