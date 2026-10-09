'use strict';

// Scheduling + timing helpers for the orchestrator's 60 s sweep ticks (#569).

// The five sweep ticks (admission, pool reap, provisioning reap, flow
// supervisor, recurring pool) all ran on 60 s intervals started in the same
// event-loop turn, so they fired together and their synchronous parts summed
// into one stall. Each now runs in its own slot.
//
// The default gap between two neighbouring slots — wide enough for one tick's
// synchronous fleet read to finish before the next one starts.
const SWEEP_TICK_SLOT_MS = 6_000;

// `intervalsMs[i]` — tick i's (env-overridable) interval, in slot order.
// Returns, per tick, `{ intervalMs, firstRunMs }`: run first after
// `firstRunMs`, then every `intervalMs`.
//
// The slots are fixed steps on ONE common base (#569 review), not fractions
// of each tick's own interval — those drift apart from the intended spacing
// as soon as two intervals differ. Tick i first runs at
// `interval_i − (n−1−i)·slotMs`: with equal intervals (the default, all
// 60 s) the ticks stay exactly `slotMs` apart forever, and the last slot
// keeps the un-staggered "one interval after start-up" first run while every
// other runs a little earlier — no first run is ever delayed past its own
// interval. `slotMs` is bounded by the smallest interval / n, so the spread
// always fits inside every tick's interval and every first run is > 0.
function sweepTickSchedule(intervalsMs, { maxSlotMs = SWEEP_TICK_SLOT_MS } = {}) {
  const list = (Array.isArray(intervalsMs) ? intervalsMs : []).map((ms) => {
    const n = Number(ms);
    return Number.isFinite(n) && n > 0 ? n : 0;
  });
  const n = list.length;
  const valid = list.filter((ms) => ms > 0);
  const cap = Number(maxSlotMs);
  const slotMs = valid.length && Number.isFinite(cap) && cap > 0
    ? Math.min(cap, Math.floor(Math.min(...valid) / n))
    : 0;
  return list.map((intervalMs, i) => ({
    intervalMs,
    firstRunMs: Math.max(0, intervalMs - (n - 1 - i) * slotMs),
  }));
}

// `AEE_PERF_LOG=0` disables the slow-tick line; `AEE_SLOW_REQUEST_MS` sets
// its threshold (default 500 ms, a non-positive / unparsable value keeps the
// default). Same variables and semantics as the request-timing `[perf]` logs,
// so one threshold governs both where those are present.
const DEFAULT_SLOW_TICK_MS = 500;
function slowTickConfigFromEnv(env = {}) {
  const enabled = String(env.AEE_PERF_LOG ?? '').trim() !== '0';
  const n = Number.parseInt(env.AEE_SLOW_REQUEST_MS, 10);
  const slowMs = Number.isFinite(n) && n > 0 ? n : DEFAULT_SLOW_TICK_MS;
  return { enabled, slowMs };
}

function formatSlowTickLine({ name, ms }) {
  return `[perf] tick=${name} ms=${Math.round(ms)}`;
}

// `(name, startedAt) => void`: logs one `[perf] tick=<name> ms=<n>` line when
// a tick ran at least `slowMs` (the AEE_SLOW_REQUEST_MS threshold the request
// timing uses), so a post-deploy `[perf]` grep can attribute a stall per tick.
// Wall time, awaits included — a tick that is slow because it waited on GitHub
// reads slow too, which the loop-delay line next to it disambiguates.
function createSlowTickLogger({ enabled = true, slowMs, now = Date.now, log = console.log } = {}) {
  return (name, startedAt) => {
    if (!enabled) return;
    const ms = now() - startedAt;
    if (Number.isFinite(ms) && ms >= slowMs) log(formatSlowTickLine({ name, ms }));
  };
}

module.exports = {
  SWEEP_TICK_SLOT_MS,
  DEFAULT_SLOW_TICK_MS,
  sweepTickSchedule,
  slowTickConfigFromEnv,
  formatSlowTickLine,
  createSlowTickLogger,
};
