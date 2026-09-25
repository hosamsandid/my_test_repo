// Pure derivations over the shared /api/agents/statuses payload (#1677).
//
// The endpoint is polled once by AgentStatusesProvider; each surface derives
// its own view from the same list here. Kept dependency-free and unit-tested
// (admin-console-src CI job) per the #651 convention — the JSX consumers stay
// thin.

// Normalise the manually-messaged signal (a Set, an array, or nullish) to a Set
// of ids. #2429: an unread response only counts as "awaiting you" (solid green,
// nav-badged) when it belongs to an agent the current user manually messaged;
// everything else is auto-triggered activity (hollow green, un-badged).
function toIdSet(manuallyMessaged) {
  if (manuallyMessaged instanceof Set) return manuallyMessaged;
  if (Array.isArray(manuallyMessaged)) return new Set(manuallyMessaged);
  return new Set();
}

// Shell nav badge (#503/#2429): number of busy agents, and of agents with a
// reply *awaiting the user* — an unread response (responded more recently than
// the user last viewed them) from an agent the user manually messaged. Unread
// output from an auto-triggered run (label / schedule / event) is deliberately
// NOT counted in any nav badge (#2429 AC8). Disabled / offline agents never
// count as unread.
export function computeChatCounts(list, viewed, manuallyMessaged) {
  let busy = 0;
  let unread = 0;
  if (!Array.isArray(list)) return { busy, unread };
  const v = viewed || {};
  const manual = toIdSet(manuallyMessaged);
  for (const { id, activityState, lastResponseAt } of list) {
    if (activityState === 'busy') {
      busy++;
    } else if (activityState !== 'disabled' && activityState !== 'offline') {
      if (
        manual.has(id) &&
        lastResponseAt &&
        new Date(lastResponseAt).getTime() > (v[id] || 0)
      ) {
        unread++;
      }
    }
  }
  return { busy, unread };
}

// Agent-Chat list: effective per-agent display state
// ('busy'|'unread'|'unread-auto'|'idle'|'disabled'|'offline'). #2429 reshaped
// this to a four-colour model expressed as five states:
//   - 'busy'        → amber, pulsing (working)
//   - 'unread'      → solid green: a reply awaiting you (unread response from an
//                     agent you manually messaged)
//   - 'unread-auto' → hollow green: FYI activity from a run you did not start
//   - 'idle'        → neutral grey (folds in today's blue `active`: a live
//                     session or a past response is no longer a distinct colour)
//   - 'disabled'    → neutral grey (no longer amber)
//   - 'offline'     → red (a real problem)
// Solid green takes precedence over hollow when an agent qualifies as both (AC7).
export function computeAgentStatusMap(list, viewed, manuallyMessaged) {
  const map = {};
  if (!Array.isArray(list)) return map;
  const v = viewed || {};
  const manual = toIdSet(manuallyMessaged);
  for (const { id, activityState, lastResponseAt } of list) {
    let effective;
    if (activityState === 'disabled') {
      effective = 'disabled';
    } else if (activityState === 'offline') {
      effective = 'offline';
    } else if (activityState === 'busy') {
      effective = 'busy';
    } else if (lastResponseAt && new Date(lastResponseAt).getTime() > (v[id] || 0)) {
      // An unread response: solid green when the user manually messaged this
      // agent (AC5/AC7), hollow green for auto-triggered activity (AC6).
      effective = manual.has(id) ? 'unread' : 'unread-auto';
    } else {
      // Everything else — a live session, a viewed past response, or nothing at
      // all — reads as the same neutral idle dot (AC1: no more blue `active`).
      effective = 'idle';
    }
    map[id] = effective;
  }
  return map;
}

// Agent-Chat collapsed team header (#2430): roll the *attention-worthy* member
// states up onto the collapsed header so the user can spot which team needs them
// without expanding it. Only two of the #2429 states demand the user's
// attention and therefore surface here:
//   - 'unread' (solid green) → a reply awaiting you    → hasReply
//   - 'busy'   (amber)       → an agent is working      → hasBusy
// Everything else stays quiet: 'idle'/'disabled' (grey), 'offline' (red) and
// 'unread-auto' (hollow green FYI) do NOT roll up (AC4) — collapsing a team must
// stay a way to reduce noise, and auto-triggered activity never demands you. The
// two flags are independent so a team with both is shown with both markers (AC3);
// neither hides the other. `memberIds` is the flat set of the team's members
// whose state the poll tracks (active members + their pool instances); stubs are
// not-initialised and carry no poll status, so they contribute nothing.
export function computeTeamAttention(memberIds, statusMap) {
  let hasReply = false;
  let hasBusy = false;
  if (!Array.isArray(memberIds) || !statusMap) return { hasReply, hasBusy };
  for (const id of memberIds) {
    const s = statusMap[id];
    if (s === 'unread') hasReply = true;
    else if (s === 'busy') hasBusy = true;
    if (hasReply && hasBusy) break;
  }
  return { hasReply, hasBusy };
}
