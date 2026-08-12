// Pure derivations over the shared /api/agents/statuses payload (#1677).
//
// The endpoint is polled once by AgentStatusesProvider; each surface derives
// its own view from the same list here. Kept dependency-free and unit-tested
// (admin-console-src CI job) per the #651 convention — the JSX consumers stay
// thin.

// Shell nav badge (#503): number of busy agents, and of "unread" agents — those
// that have responded more recently than the user last viewed them. Disabled /
// offline agents never count as unread.
export function computeChatCounts(list, viewed) {
  let busy = 0;
  let unread = 0;
  if (!Array.isArray(list)) return { busy, unread };
  const v = viewed || {};
  for (const { id, activityState, lastResponseAt } of list) {
    if (activityState === 'busy') {
      busy++;
    } else if (activityState !== 'disabled' && activityState !== 'offline') {
      if (lastResponseAt && new Date(lastResponseAt).getTime() > (v[id] || 0)) {
        unread++;
      }
    }
  }
  return { busy, unread };
}

// Agent-Chat list: effective per-agent display state
// ('busy'|'unread'|'active'|'idle'|'disabled'|'offline'). `active` (blue) means
// the agent has done work — a live DM session pointer, or it responded at least
// once (covers per-invocation agents that keep no session pointer, #1119).
export function computeAgentStatusMap(list, viewed) {
  const map = {};
  if (!Array.isArray(list)) return map;
  const v = viewed || {};
  for (const { id, activityState, lastResponseAt, hasSession } of list) {
    let effective;
    if (activityState === 'disabled') {
      effective = 'disabled';
    } else if (activityState === 'offline') {
      effective = 'offline';
    } else if (activityState === 'busy') {
      effective = 'busy';
    } else if (lastResponseAt && new Date(lastResponseAt).getTime() > (v[id] || 0)) {
      effective = 'unread';
    } else if (hasSession || lastResponseAt) {
      effective = 'active';
    } else {
      effective = 'idle';
    }
    map[id] = effective;
  }
  return map;
}
