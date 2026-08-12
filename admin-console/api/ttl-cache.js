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

function createTtlCache({ ttlMs = 5000, now = Date.now, maxEntries = 500 } = {}) {
  // key -> { value, expiresAt }
  const store = new Map();
  // key -> Promise (compute in flight); never expires on its own, cleared on settle
  const inflight = new Map();

  function get(key) {
    const entry = store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= now()) {
      store.delete(key);
      return undefined;
    }
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
          inflight.delete(key);
          set(key, value);
          return value;
        },
        (err) => {
          inflight.delete(key);
          throw err;
        },
      );
    inflight.set(key, p);
    return p;
  }

  function clear() {
    store.clear();
    inflight.clear();
  }

  return { get, set, getOrCompute, clear, get size() { return store.size; } };
}

module.exports = { createTtlCache };
