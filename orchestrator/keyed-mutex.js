'use strict';

// A per-key async mutex. Tasks submitted for the SAME key run one-at-a-time in
// submission order; tasks for DIFFERENT keys run concurrently. Pure (no I/O) —
// the caller supplies the async task, so it is unit-testable without git or a
// network (repo convention: pure cores are the tested surface).
//
// Motivation (#perf): the team Knowledge-Base push (orchestrator.js
// `agentKnowledgePush`) used to run git synchronously AND with no cross-agent
// coordination, so concurrent agents on one team all fetched/rebased/pushed the
// same shared branch at once — losing the fast-forward race (non-fast-forward
// reject → retry storm) and piling up git subprocesses. Serializing the push
// per team keeps the pushes conflict-free and the git work bounded, while the
// async git keeps the orchestrator event loop free.
function createKeyedMutex() {
  const tails = new Map(); // key -> Promise that settles when the queue drains

  function runExclusive(key, task) {
    const prev = tails.get(key) || Promise.resolve();
    // Run `task` only after the previous holder for this key settles. Swallow
    // the previous outcome so one task's rejection cannot reject the next.
    const result = prev.then(() => task(), () => task());
    // The tail advances regardless of THIS task's outcome, so the queue never
    // wedges on a rejection.
    const tail = result.then(() => {}, () => {});
    tails.set(key, tail);
    // Drop the map entry once this task was the last in line, so a long-lived
    // process cycling through many one-off keys does not leak Map entries.
    tail.finally(() => { if (tails.get(key) === tail) tails.delete(key); });
    return result; // caller observes the task's real resolution/rejection
  }

  // Introspection hook for tests / diagnostics: number of keys with a live queue.
  runExclusive.activeKeys = () => tails.size;
  return runExclusive;
}

module.exports = { createKeyedMutex };
