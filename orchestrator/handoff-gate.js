'use strict';

// #2795: the per-hand-off CI and merge-conflict gate.
//
// A PR hand-off (a github-event trigger on `pull_request.labeled` /
// `opened` / `reopened`) may carry `readinessGate: { ci, conflict,
// failureLabel, timeoutMinutes }`. When the poller would wake such a trigger,
// it HOLDS the wake instead (state.json `holds`) and decides on every
// readiness pass, from the #2794 verdicts of the PR's CURRENT head commit:
//
//   release  — every enabled gate is satisfied (CI `passed`/`none`, merge
//              `clean`): the consumer is woken now.
//   fail     — CI `failed`, or `conflict` with the conflict gate on: the wake
//              label is removed, the failure label set, a comment names why;
//              the consumer is not woken (the failure label wakes its own
//              listeners through the normal Events-API path).
//   timeout  — still pending after `timeoutMinutes` from the hold: the wake
//              label is removed, `needs-human` set, a comment names the gate.
//   cancel   — the PR is closed/merged or the wake label is gone: nobody woken.
//   wait     — otherwise.
//
// A verdict is only ever read for the PR's current head: the readiness entry
// is used only when its `sha` is the head the open-PR list reports, so a
// verdict for a superseded commit can neither release nor fail a hold. A push
// during a hold therefore waits for the new head; the timeout keeps counting
// from the original hold. Pure — no I/O; the poller does the GitHub writes.

const DEFAULT_FAILURE_LABEL = 'revisions-required';
const DEFAULT_TIMEOUT_MINUTES = 60;
const MIN_TIMEOUT_MINUTES = 1;
const MAX_TIMEOUT_MINUTES = 7 * 24 * 60;
const TIMEOUT_LABEL = 'needs-human';
const COMMENT_MARKER = '<!-- aee:handoff-gate -->';

// The wake keys a gate applies to: the PR hand-off events. Anything else (an
// issue hand-off, a push, a readiness event itself) is never held.
const GATED_EVENT_KEYS = ['pull_request.labeled', 'pull_request.opened', 'pull_request.reopened'];

// How each gate reads in the log, on the board and in comments.
const GATE_TEXT = { ci: 'CI', conflict: 'conflict-free' };

function cleanLabel(v) {
  return typeof v === 'string' && v.trim() && v.trim().length <= 50 ? v.trim() : null;
}

function cleanTimeout(v) {
  return Number.isInteger(v) && v >= MIN_TIMEOUT_MINUTES && v <= MAX_TIMEOUT_MINUTES ? v : null;
}

// A trigger's `readinessGate` → `{ ci, conflict, failureLabel, timeoutMinutes }`
// with the defaults filled in, or null when no gate is on (absent, malformed,
// or both toggles off — the hand-off wakes immediately, as before #2795).
function normalizeGate(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const ci = raw.ci === true;
  const conflict = raw.conflict === true;
  if (!ci && !conflict) return null;
  return {
    ci,
    conflict,
    failureLabel: cleanLabel(raw.failureLabel) || DEFAULT_FAILURE_LABEL,
    timeoutMinutes: cleanTimeout(raw.timeoutMinutes) || DEFAULT_TIMEOUT_MINUTES,
  };
}

function gateApplies(gate, key) {
  return !!gate && GATED_EVENT_KEYS.includes(key);
}

// The enabled gates, in display order.
function enabledGates(gate) {
  const out = [];
  if (gate && gate.ci) out.push('ci');
  if (gate && gate.conflict) out.push('conflict');
  return out;
}

// "CI", "conflict-free", "CI / conflict-free".
function gatesText(gates) {
  return (Array.isArray(gates) ? gates : []).map((g) => GATE_TEXT[g] || g).join(' / ');
}

function holdKey(triggerId, number) {
  return `${triggerId}#${number}`;
}

// A compact copy of the event that is delivered on release: what `_enqueue`
// reads, nothing else, so state.json stays small.
function storedEvent(ghEvent) {
  return {
    id: ghEvent.id,
    type: ghEvent.type,
    actor: ghEvent.actor && ghEvent.actor.login ? { login: ghEvent.actor.login } : null,
    repo: ghEvent.repo && ghEvent.repo.name ? { name: ghEvent.repo.name } : null,
    created_at: ghEvent.created_at,
    payload: ghEvent.payload,
  };
}

function newHold({ sub, key, ghEvent, number, wakeLabel = null, now = Date.now() }) {
  const gate = normalizeGate(sub.readinessGate);
  return {
    agentId: sub.agentId,
    triggerId: sub.triggerId,
    number,
    key,
    wakeLabel: wakeLabel || null,
    gate,
    heldAt: new Date(now).toISOString(),
    headSha: (ghEvent.payload && ghEvent.payload.pull_request && ghEvent.payload.pull_request.head
      && ghEvent.payload.pull_request.head.sha) || null,
    event: storedEvent(ghEvent),
    // Per-step completion of a fail/timeout resolution, so a retry after a
    // GitHub error (or a restart) never repeats a step that already happened.
    resolution: null,
  };
}

// The enabled gates not yet satisfied by `entry` (null entry = all pending).
function pendingGates(gate, entry) {
  const out = [];
  if (gate.ci && !(entry && (entry.ci === 'passed' || entry.ci === 'none'))) out.push('ci');
  if (gate.conflict && !(entry && entry.merge === 'clean')) out.push('conflict');
  return out;
}

/**
 * Decide one hold.
 * @param hold          a `newHold` record
 * @param pr            the PR from the open-PR list (`parseOpenPrs` shape, with
 *                      `labels`), or null when it is not in the list
 * @param listComplete  the open-PR list was not truncated — a missing PR is closed
 * @param entry         the readiness entry for this PR (`evaluateReadiness` state)
 * @returns {{action:'release'|'fail'|'timeout'|'cancel'|'wait', …}}
 */
function evaluateHold(hold, { pr = null, listComplete = true, entry = null, now = Date.now() } = {}) {
  const gate = normalizeGate(hold && hold.gate);
  if (!gate) return { action: 'release', sha: pr ? pr.sha : null };
  if (!pr && listComplete) return { action: 'cancel', reason: 'closed' };
  if (pr && hold.wakeLabel && Array.isArray(pr.labels) && !pr.labels.includes(hold.wakeLabel)) {
    return { action: 'cancel', reason: 'label-removed' };
  }
  // Only the current head's verdicts count (AC8).
  const current = pr && entry && entry.sha === pr.sha ? entry : null;
  if (current) {
    if (gate.ci && current.ci === 'failed') {
      return {
        action: 'fail', gate: 'ci', sha: current.sha,
        failingChecks: Array.isArray(current.failingChecks) ? current.failingChecks.slice() : [],
      };
    }
    if (gate.conflict && current.merge === 'conflict') {
      return { action: 'fail', gate: 'conflict', sha: current.sha, baseRef: pr.baseRef || null };
    }
  }
  const pending = pendingGates(gate, current);
  if (pending.length === 0) return { action: 'release', sha: current.sha };
  const heldAt = Date.parse(hold.heldAt);
  if (Number.isFinite(heldAt) && now - heldAt >= gate.timeoutMinutes * 60_000) {
    return { action: 'timeout', pending, sha: pr ? pr.sha : null };
  }
  return { action: 'wait', pending, sha: pr ? pr.sha : null };
}

function shortSha(sha) {
  return typeof sha === 'string' ? sha.slice(0, 7) : '';
}

function code(s) {
  return `\`${String(s).replace(/`/g, "'")}\``;
}

// What happened to the labels and the consumer, shared by both comments.
function consequence({ wakeLabel, setLabel, consumer }) {
  const labels = wakeLabel ? `${code(wakeLabel)} was removed and ${code(setLabel)} set` : `${code(setLabel)} was set`;
  return `${labels} — ${consumer ? code(consumer) : 'the next agent'} was not woken.`;
}

// The PR comment for a failed gate: the failing checks, or the merge conflict.
function failureComment({ decision, hold, consumer = null }) {
  const gate = normalizeGate(hold.gate);
  const lines = [COMMENT_MARKER];
  if (decision.gate === 'conflict') {
    const base = decision.baseRef ? code(decision.baseRef) : 'the base branch';
    lines.push(`**Hand-off held back: merge conflict with ${base}** (head ${code(shortSha(decision.sha))}).`);
  } else {
    lines.push(`**Hand-off held back: CI failed** on ${code(shortSha(decision.sha))}.`);
    const checks = Array.isArray(decision.failingChecks) ? decision.failingChecks : [];
    if (checks.length) {
      lines.push('', 'Failing checks:');
      for (const c of checks) lines.push(`- ${code(c)}`);
    }
  }
  lines.push('', consequence({ wakeLabel: hold.wakeLabel, setLabel: gate.failureLabel, consumer }));
  return lines.join('\n');
}

// The PR comment for a hold that ran out of time.
function timeoutComment({ decision, hold, consumer = null }) {
  const gate = normalizeGate(hold.gate);
  const pending = Array.isArray(decision.pending) && decision.pending.length ? decision.pending : enabledGates(gate);
  return [
    COMMENT_MARKER,
    `**Hand-off timed out after ${gate.timeoutMinutes} min — still waiting for ${gatesText(pending)}.**`,
    '',
    consequence({ wakeLabel: hold.wakeLabel, setLabel: TIMEOUT_LABEL, consumer }),
  ].join('\n');
}

module.exports = {
  DEFAULT_FAILURE_LABEL,
  DEFAULT_TIMEOUT_MINUTES,
  MIN_TIMEOUT_MINUTES,
  MAX_TIMEOUT_MINUTES,
  TIMEOUT_LABEL,
  COMMENT_MARKER,
  GATED_EVENT_KEYS,
  GATE_TEXT,
  normalizeGate,
  gateApplies,
  enabledGates,
  gatesText,
  holdKey,
  newHold,
  pendingGates,
  evaluateHold,
  failureComment,
  timeoutComment,
};
