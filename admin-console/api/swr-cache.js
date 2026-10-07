'use strict';

/*
 * Single-key stale-while-revalidate cache (#570).
 *
 * `GET /api/agents/statuses` is polled by every open console tab on a 5 s beat,
 * and each build waits on the orchestrator's `/internal/agents/processes` hop.
 * Under load that hop was seen queueing behind the orchestrator's once-a-minute
 * stall: p90 5–15 s per request, 30–92 s of request time a minute. A plain TTL
 * makes every poll that lands just after expiry wait for the next build; SWR
 * answers it from the last good value and rebuilds in the background.
 *
 *   age <  freshMs                → the cached value
 *   freshMs <= age < maxStaleMs   → the cached value, plus ONE background rebuild
 *   no value, or age >= maxStaleMs → wait for a rebuild
 *
 * - `builtAt` is stamped when a build SETTLES, not when it starts, so a slow
 *   build doesn't arrive already half-expired.
 * - A failed build never replaces a good value. A waiting caller sees its
 *   rejection. A failure streak is reported once (`onError`, on its first
 *   failure) and its end once (`onRecover`), not once per poll.
 * - Failure backoff: within `failureBackoffMs` of a failed build no new build
 *   starts — a stale read is answered from the value, a waiting caller gets
 *   the same rejection again. A lasting outage then costs one build per
 *   backoff window, not one per poll.
 * - One build at a time: concurrent callers share it, and nothing (an
 *   invalidation included) starts a second one beside it.
 * - `invalidate()` marks the value stale without dropping it: the next read is
 *   still answered from it and starts a revalidation. A build already in
 *   flight is from before the change, so its result is stored stale-on-arrival
 *   (it is still the newest data we have) and the read after it revalidates
 *   again; a caller that has to wait is never handed it, but waits for a build
 *   started after the invalidation. Invalidation also lifts a failure backoff.
 * - `freshMs <= 0` turns caching off: every call builds.
 *
 * Pure (injectable clock, no I/O) per the #651 convention.
 */

const noop = () => {};

function createSwrCache({
  freshMs = 5000,
  maxStaleMs = 30_000,
  failureBackoffMs = 0,
  now = Date.now,
  onError = noop,
  onRecover = noop,
} = {}) {
  let hasValue = false;
  let value;
  let builtAt = 0;
  let mustRevalidate = false; // set by invalidate(): servable, but never fresh
  let inflight = null; // { promise, gen } — at most one build at a time
  let generation = 0; // bumped by invalidate()
  let lastFailure = null; // { err, at } — the latest post-invalidation failure (backoff)
  let failures = 0; // consecutive failed builds, for the once-per-streak report

  // `since` is younger than `ms`. A clock that stepped backwards is never young.
  function within(since, ms) {
    const age = now() - since;
    return age >= 0 && age < ms;
  }

  function backingOff() {
    return !!lastFailure && within(lastFailure.at, failureBackoffMs);
  }

  function start(compute) {
    const gen = generation;
    const settle = () => { if (inflight && inflight.promise === promise) inflight = null; };
    const promise = Promise.resolve()
      .then(compute)
      .then(
        (v) => {
          settle();
          value = v;
          builtAt = now();
          hasValue = true;
          mustRevalidate = gen !== generation; // invalidated mid-flight → stale on arrival
          if (gen === generation) lastFailure = null;
          if (failures > 0) {
            const n = failures;
            failures = 0;
            onRecover({ failures: n });
          }
          return v;
        },
        (err) => {
          settle();
          failures++;
          if (failures === 1) onError(err);
          if (gen === generation) lastFailure = { err, at: now() };
          throw err;
        },
      );
    inflight = { promise, gen };
    return promise;
  }

  // A caller that needs a value now: join the current build, never one from
  // before the last invalidation, and never start one inside a backoff.
  function waitForBuild(compute) {
    if (inflight) {
      if (inflight.gen === generation) return inflight.promise;
      return inflight.promise.then(noop, noop).then(() => waitForBuild(compute));
    }
    if (backingOff()) return Promise.reject(lastFailure.err);
    return start(compute);
  }

  function get(compute) {
    if (!(freshMs > 0)) return Promise.resolve().then(compute);
    if (hasValue && within(builtAt, Math.max(freshMs, maxStaleMs))) {
      if (!mustRevalidate && within(builtAt, freshMs)) return Promise.resolve(value);
      // Stale or invalidated: answer from the value, revalidate in the
      // background. The failure is reported by start(), once per streak.
      if (!inflight && !backingOff()) start(compute).catch(noop);
      return Promise.resolve(value);
    }
    return waitForBuild(compute);
  }

  function invalidate() {
    generation++;
    mustRevalidate = true;
    lastFailure = null;
  }

  function peek() {
    return hasValue ? { value, builtAt, stale: mustRevalidate } : null;
  }

  return { get, invalidate, peek };
}

module.exports = { createSwrCache };
