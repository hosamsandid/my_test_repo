'use strict';

/*
 * The orchestrator runtime view behind GET /api/agents/statuses (#570).
 *
 * Every statuses build needs the orchestrator's `/internal/agents/processes`
 * answer (which containers are up). Under load that hop takes 5–15 s at p90 and
 * can queue behind an orchestrator event-loop stall for up to ~60 s. Two failure
 * modes to avoid:
 *
 *   - Abandon a slow-but-working orchestrator early, and every agent reads
 *     offline although nothing is wrong.
 *   - Abort and re-ask on every poll beat: an aborted request is still queued
 *     on the orchestrator, so a 60 s stall would end with a dozen queued
 *     requests executing at once.
 *
 * So the REQUEST and the WAIT are separate:
 *
 *   - At most one request is outstanding. A build joins it rather than issuing
 *     another; the adapter bounds it only by a hard deadline (`timeoutMs`),
 *     which is there for a hung socket, not for slowness.
 *   - A build waits at most `waitMs` for it. If the request is still running
 *     then, the build uses the last good view, and the request carries on and
 *     refreshes that view whenever it lands.
 *
 * Which view a build uses — `pickRuntimeView`, the one decision:
 *
 *   fresh answer (an array)                      → it
 *   last good view younger than `viewMaxMs`      → the last view
 *   request still outstanding (orchestrator just
 *     slow), started while the last view was
 *     younger than `viewMaxMs`, and inside its
 *     deadline                                   → the last view
 *   otherwise                                    → none (agents read offline)
 *
 * The pending clause is what keeps a slow orchestrator from ageing the view
 * out: the outstanding request vouches for it until it answers or hits its
 * deadline. A failed answer (error, non-2xx, non-array body, deadline) vouches
 * for nothing, so a down orchestrator falls back for `viewMaxMs` only.
 *
 * Pure decision + injectable clock and fetch, per the #651 convention.
 */

// `since` is younger than `ms` at `now`; a clock that stepped back is not.
function younger(since, now, ms) {
  const age = now - since;
  return age >= 0 && age < ms;
}

function isView(v) {
  return !!v && Array.isArray(v.processes) && typeof v.at === 'number';
}

// outcome: 'fresh' (the request answered with an array, passed as
// `processes`), 'pending' (still running after the wait; `pendingSince` = when
// it started) or 'failed'. Returns `{ processes, source }`, source one of
// 'fresh' | 'last-view' | 'none' (processes null).
function pickRuntimeView({ outcome, processes, lastView, pendingSince, now, viewMaxMs, timeoutMs }) {
  if (outcome === 'fresh' && Array.isArray(processes)) return { processes, source: 'fresh' };
  if (isView(lastView)) {
    if (younger(lastView.at, now, viewMaxMs)) return { processes: lastView.processes, source: 'last-view' };
    if (outcome === 'pending' && typeof pendingSince === 'number'
        && younger(pendingSince, now, timeoutMs)
        && younger(lastView.at, pendingSince, viewMaxMs)) {
      return { processes: lastView.processes, source: 'last-view' };
    }
  }
  return { processes: null, source: 'none' };
}

const PENDING = Symbol('pending');

// Resolve with the promise's value, or PENDING after `ms` (a non-positive `ms`
// waits for the promise itself). `promise` never rejects here.
function waitAtMost(promise, ms) {
  if (!(ms > 0)) return promise;
  let timer;
  const expiry = new Promise((resolve) => {
    timer = setTimeout(() => resolve(PENDING), ms);
  });
  return Promise.race([promise, expiry]).finally(() => clearTimeout(timer));
}

// `fetchProcesses()` → the parsed body, or null for a non-2xx answer; it may
// reject. The adapter applies `timeoutMs` as its hard deadline.
function createProcessesSource({ fetchProcesses, waitMs, timeoutMs, viewMaxMs, now = Date.now }) {
  let lastView = null; // { processes, at } — the last good answer
  let outstanding = null; // { promise, since } — the one request in flight

  function request() {
    if (outstanding) return outstanding;
    const since = now();
    const promise = Promise.resolve()
      .then(fetchProcesses)
      .then((v) => (Array.isArray(v) ? v : null), () => null)
      .then((v) => {
        if (v) lastView = { processes: v, at: now() };
        if (outstanding && outstanding.promise === promise) outstanding = null;
        return v;
      });
    outstanding = { promise, since };
    return outstanding;
  }

  async function read() {
    const req = request();
    const answer = await waitAtMost(req.promise, waitMs);
    const outcome = answer === PENDING ? 'pending' : (answer ? 'fresh' : 'failed');
    return pickRuntimeView({
      outcome,
      processes: answer === PENDING ? null : answer,
      lastView,
      pendingSince: req.since,
      now: now(),
      viewMaxMs,
      timeoutMs,
    });
  }

  return { read, peek: () => ({ lastView, outstanding: !!outstanding }) };
}

module.exports = { pickRuntimeView, createProcessesSource };
