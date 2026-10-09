'use strict';

/*
 * Tiny in-memory TTL cache with in-flight de-duplication (#1683).
 *
 * The admin-console API is polled hard for git state — ChatPanel refetches
 * git-info every 30s and the DiffView polls git-status/git-diff every 5s. Each
 * of those used to shell out to git synchronously on the request path, freezing
 * the single Node event loop the console proxies through. Making the git calls
 * async fixes the freeze; this cache additionally cuts the *number* of spawns:
 *
 *   - `getOrCompute` collapses concurrent callers for the same key onto a single
 *     in-flight promise, so N browser tabs polling the same agent trigger one
 *     git process, not N.
 *   - A short TTL serves a recently-computed result without re-spawning.
 *
 * Kept as a pure module (no fs / no git / no express, injectable clock) so the
 * expiry and de-dup behaviour is unit-testable without an HTTP harness — the
 * #651 convention. api.js is the thin adapter that wires it to the git helpers.
 */

// `staleMs` (default 0 = off) keeps an expired entry around for that long so
// `getStaleWhileRevalidate` can still serve it while a refresh runs (#2923).
function createTtlCache({ ttlMs = 5000, now = Date.now, maxEntries = 500, staleMs = 0 } = {}) {
  // key -> { value, expiresAt }
  const store = new Map();
  // key -> Promise (compute in flight); never expires on its own, cleared on settle.
  // A compute only owns its key while it is still the entry here: one detached
  // by clear()/deleteWhere() settles into a world that has moved on, so it must
  // neither cache its (possibly pre-mutation) value nor delete a newer
  // in-flight entry for the same key.
  const inflight = new Map();

  function get(key) {
    const entry = store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= now()) {
      if (entry.expiresAt + staleMs <= now()) store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  // An expired value still inside the `staleMs` window, else undefined.
  function getStale(key) {
    const entry = store.get(key);
    if (!entry || entry.expiresAt + staleMs <= now()) return undefined;
    return entry.value;
  }

  function set(key, value) {
    // Bound memory: when full and adding a new key, evict the oldest insertion
    // (Map preserves insertion order). Overwriting an existing key never evicts.
    if (!store.has(key) && store.size >= maxEntries) {
      const oldest = store.keys().next().value;
      if (oldest !== undefined) store.delete(oldest);
    }
    store.set(key, { value, expiresAt: now() + ttlMs });
    return value;
  }

  // Return a cached value if fresh; otherwise run `compute()` (may be async),
  // cache and return its result. Concurrent calls for the same key share one
  // compute. A rejected compute is not cached and its rejection propagates.
  function getOrCompute(key, compute) {
    const cached = get(key);
    if (cached !== undefined) return Promise.resolve(cached);

    const pending = inflight.get(key);
    if (pending) return pending;

    const p = Promise.resolve()
      .then(compute)
      .then(
        (value) => {
          if (inflight.get(key) === p) {
            inflight.delete(key);
            set(key, value);
          }
          return value;
        },
        (err) => {
          if (inflight.get(key) === p) inflight.delete(key);
          throw err;
        },
      );
    inflight.set(key, p);
    return p;
  }

  // Stale-while-revalidate (#2923): a fresh value is returned as-is; an expired
  // one still inside the `staleMs` window is returned at once while a single
  // background refresh (shared with any in-flight compute) replaces it — a
  // failed refresh keeps the stale value and is swallowed. Only a miss (never
  // computed, or older than ttlMs + staleMs) waits for `compute()`.
  function getStaleWhileRevalidate(key, compute) {
    const cached = get(key);
    if (cached !== undefined) return Promise.resolve(cached);
    const stale = getStale(key);
    if (stale === undefined) return getOrCompute(key, compute);
    getOrCompute(key, compute).catch(() => {});
    return Promise.resolve(stale);
  }

  // Drop every cached value and detach in-flight computes: callers already
  // awaiting one still get its result, but it is not cached, and the next
  // getOrCompute starts a fresh compute.
  function clear() {
    store.clear();
    inflight.clear();
  }

  // clear(), narrowed to the keys `predicate(key)` accepts (#571): the same
  // drop-and-detach, every other entry and compute untouched.
  function deleteWhere(predicate) {
    for (const key of [...store.keys()]) if (predicate(key)) store.delete(key);
    for (const key of [...inflight.keys()]) if (predicate(key)) inflight.delete(key);
  }

  return { get, set, getOrCompute, getStaleWhileRevalidate, clear, deleteWhere, get size() { return store.size; } };
}

// A cache TTL from an env var. Unset, blank or invalid ⇒ `fallback`; an
// explicit `0` is honoured (caching off) instead of collapsing to the fallback
// the way `Number(raw) || fallback` does.
function ttlMsFromEnv(raw, fallback) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

module.exports = { createTtlCache, ttlMsFromEnv };
