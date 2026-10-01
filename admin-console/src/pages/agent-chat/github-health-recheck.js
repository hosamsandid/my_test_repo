// Pure state + view decisions for the GitHub integration box's Recheck button
// (#2712, follow-up to #2324).
//
// `useApi`'s refetch deliberately never flips `loading` back to true once data
// was loaded (so other consumers are not unmounted on refetch), which left the
// Recheck button without any busy state, and an unchanged result looked like
// "nothing happened". The badge therefore runs its own recheck request and
// tracks it here — `useApi` itself stays untouched for every other consumer.
//
// State: { data, checkedAt, busy, failed }
//   data      — the latest recheck result (null → the badge shows useApi's
//               initial result)
//   checkedAt — epoch ms of the last SUCCESSFUL check (initial load or recheck)
//   busy      — a recheck is in flight (the button is disabled)
//   failed    — the last recheck failed; the shown result is NOT fresh

// Minimum time the busy state stays on screen, so a near-instant response is
// still a perceivable "Checking…" rather than a sub-frame flash (AC6).
export const RECHECK_MIN_BUSY_MS = 600;

export const initialRecheckState = Object.freeze({ data: null, checkedAt: null, busy: false, failed: false });

export function recheckReducer(state, action) {
  switch (action.type) {
    // The initial useApi load completed — it counts as a check.
    case 'loaded':
      return { ...initialRecheckState, checkedAt: action.at };
    case 'start':
      // Never overlap rechecks (rapid repeated clicks).
      if (state.busy) return state;
      return { ...state, busy: true, failed: false };
    case 'success':
      return { data: action.data, checkedAt: action.at, busy: false, failed: false };
    case 'failure':
      return { ...state, busy: false, failed: true };
    case 'reset':
      return initialRecheckState;
    default:
      return state;
  }
}

// How long to hold the busy state after a response, given when it started.
export function remainingBusyMs(startedAt, now, min = RECHECK_MIN_BUSY_MS) {
  return Math.max(0, startedAt + min - now);
}

// Wall-clock time with seconds, so two rechecks a few seconds apart produce a
// visibly different indicator even when the result itself is unchanged.
export function formatCheckedTime(ms) {
  return new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function describeRecheck(state, formatTime = formatCheckedTime) {
  const buttonLabel = state.busy ? 'Checking…' : 'Recheck';
  let note = null;
  if (state.failed) {
    // The last known result stays visible, but must not read as fresh.
    note = {
      tone: 'error',
      text: state.checkedAt != null
        ? `Recheck failed — try again. Showing the result from ${formatTime(state.checkedAt)}.`
        : 'Recheck failed — try again.',
    };
  } else if (state.checkedAt != null) {
    note = { tone: 'muted', text: `Last checked ${formatTime(state.checkedAt)}` };
  }
  return { buttonLabel, disabled: state.busy, note };
}
