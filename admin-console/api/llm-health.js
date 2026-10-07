'use strict';

// Pure logic for the Model Provider background health poller (#1843).
//
// A background pass in api.js probes every configured Model Provider on an
// interval (reusing probeLlmEndpointTest) and persists the last-known status
// per provider. This module holds every *decision* — backoff curve, which
// endpoints are due this tick, how a probe result folds into a persisted
// record, when a record is stale enough to re-probe on agent selection, and the
// honest client-facing view — kept free of I/O, fetch and Express so it can be
// unit-tested directly (the admin-api suite has no HTTP harness). The impure
// loop + fs live in api.js.
//
// Health is stored in a SEPARATE file (/workspace/llm-endpoints/health.json),
// never inside the config index.json, so a frequent status rewrite never races
// the CRUD read-modify-write of the endpoint list.
//
// #2732 adds the provider's spending budget (llm-budget.js): the record carries
// the last budget lookup, and the view derives a 'warning' (orange) state when
// the effective budget is ≥ the warn threshold, 'error' at ≥ 100 %.

const llmBudget = require('./llm-budget');

// ~5 min baseline probe cadence (AC1: default ~5 min, configurable).
const DEFAULT_INTERVAL_MS = 5 * 60_000;
// First-failure backoff step; doubles per consecutive failure (AC2).
const DEFAULT_BACKOFF_BASE_MS = 5 * 60_000;
// Cap: a persistently-dead endpoint is probed at most once an hour, never
// hammered every cycle (AC2).
const DEFAULT_BACKOFF_MAX_MS = 60 * 60_000;
// AC5: on agent selection, a last-known status older than this triggers a fresh
// on-demand probe so the warning isn't shown off a very stale reading.
const DEFAULT_STALE_MS = 2 * 60_000;

function coerceMs(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Exponential backoff on consecutive failures, mirroring github-poller.js:
//   min(base * 2^(failures-1), max)
// failures <= 0 (a healthy endpoint) → 0 (no extra backoff; the plain interval
// governs cadence instead).
function backoffMs(consecutiveFailures, opts = {}) {
  const baseMs = coerceMs(opts.baseMs, DEFAULT_BACKOFF_BASE_MS);
  const maxMs = coerceMs(opts.maxMs, DEFAULT_BACKOFF_MAX_MS);
  const f = Math.floor(Number(consecutiveFailures) || 0);
  if (f <= 0) return 0;
  return Math.min(baseMs * Math.pow(2, f - 1), maxMs);
}

// Fold a probe result ({ ok, status, error } from probeLlmEndpointTest) into the
// new persisted health record. `prev` is the prior record (or null/undefined).
// `budget` is the llm-budget.js lookup taken alongside the probe (#2732); it
// never affects ok/consecutiveFailures, so a budget Warning never makes the
// poller back off (AC10) and a failed budget read never fails the probe (AC5).
function applyProbeResult(prev, probe, nowMs = Date.now(), budget = undefined) {
  const ok = Boolean(probe && probe.ok);
  const priorFailures = prev && Number.isFinite(prev.consecutiveFailures)
    ? prev.consecutiveFailures
    : 0;
  return {
    ok,
    status: probe && Number.isFinite(probe.status) ? probe.status : 0,
    // Honest failure reason (already human-readable via describeProbeFailure);
    // null on success.
    reason: ok ? null : (probe && probe.error ? String(probe.error) : 'request failed'),
    checkedAt: new Date(nowMs).toISOString(),
    consecutiveFailures: ok ? 0 : priorFailures + 1,
    ...(budget ? { budget } : {}),
  };
}

// When is a record next due for a probe? A healthy record → checkedAt + interval;
// a failing record → checkedAt + backoff(failures). A missing/blank record → due
// immediately (0), so a never-probed endpoint is picked up on the first tick.
function nextDueMs(record, opts = {}) {
  if (!record || !record.checkedAt) return 0;
  const checked = Date.parse(record.checkedAt);
  if (!Number.isFinite(checked)) return 0;
  const intervalMs = coerceMs(opts.intervalMs, DEFAULT_INTERVAL_MS);
  const failures = Number(record.consecutiveFailures) || 0;
  const wait = failures > 0 ? backoffMs(failures, opts) : intervalMs;
  return checked + wait;
}

function isDue(record, nowMs = Date.now(), opts = {}) {
  return nowMs >= nextDueMs(record, opts);
}

// AC5: a record is "stale" (worth an on-demand re-probe on agent selection) when
// it is missing or older than staleMs.
function isStale(record, nowMs = Date.now(), staleMs = DEFAULT_STALE_MS) {
  if (!record || !record.checkedAt) return true;
  const checked = Date.parse(record.checkedAt);
  if (!Number.isFinite(checked)) return true;
  return (nowMs - checked) >= coerceMs(staleMs, DEFAULT_STALE_MS);
}

// The endpoint ids due for a probe this tick, given the current health map.
function selectDueEndpointIds(endpoints, healthMap = {}, nowMs = Date.now(), opts = {}) {
  return (Array.isArray(endpoints) ? endpoints : [])
    .filter(ep => ep && ep.id)
    .filter(ep => isDue(healthMap[ep.id], nowMs, opts))
    .map(ep => ep.id);
}

// The client-facing view merged onto an endpoint (AC3/AC6). No record → 'unknown'
// (honest; never a guessed green — mirrors the sidecarRunning:null precedent
// called out in AC6).
//
// #2732: a reachable provider whose effective budget is ≥ warnPct shows
// 'warning'; ≥ 100 % shows 'error' (the proxy rejects requests from there on).
// The reason names the budget either way. `budget` is the Budget-column view.
function healthView(record, opts = {}) {
  if (!record || !record.checkedAt) {
    return { status: 'unknown', reason: null, checkedAt: null, httpStatus: null, budget: null };
  }
  const budget = llmBudget.budgetView(record.budget);
  let status = record.ok ? 'ok' : 'error';
  let reason = record.ok ? null : (record.reason || 'request failed');
  if (record.ok && budget && budget.status === 'ok') {
    const warnPct = llmBudget.coercePct(opts.warnPct);
    if (budget.pct >= 100) status = 'error';
    else if (budget.pct >= warnPct) status = 'warning';
    if (status !== 'ok') reason = llmBudget.budgetReason(record.budget.budget);
  }
  return {
    status,
    reason,
    checkedAt: record.checkedAt,
    httpStatus: Number.isFinite(record.status) ? record.status : null,
    budget,
  };
}

module.exports = {
  DEFAULT_INTERVAL_MS,
  DEFAULT_BACKOFF_BASE_MS,
  DEFAULT_BACKOFF_MAX_MS,
  DEFAULT_STALE_MS,
  coerceMs,
  backoffMs,
  applyProbeResult,
  nextDueMs,
  isDue,
  isStale,
  selectDueEndpointIds,
  healthView,
};
