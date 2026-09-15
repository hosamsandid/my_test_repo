'use strict';

// ─── a plugin broker may wake an agent (Jira plan §4B) ──────────────────────
//
// The one platform capability with no existing precedent. Until now every
// broker is a pure server — the orchestrator pushes to it and nothing calls
// back. `POST /internal/plugin-event` is the callback channel, and it is
// GENERIC to plugins, not to Jira (§D5): the platform learns "a plugin may wake
// an agent it is granted to, with a payload" and nothing about Jira.
//
//   POST /internal/plugin-event
//   Authorization: Bearer <plugin scope token>        ← pluginId + scopeId here
//   { "event": "status_changed",                      ← the broker's vocabulary,
//     "summary": "PROJ-42: Login flow — In Progress → Ready for Dev",
//     "payload": { … }, "eventId": "PROJ-42:10431" }
//   The consumer's trigger may also carry `payloadFilter: { key: value }` — see below.
//
// The token is the authorisation: pluginId and scopeId are read from it, never
// from the body, so a plugin can only ever fire events for its own id in its
// own scope. The grant is the second gate — the orchestrator enqueues only into
// agents the plugin is actually granted to.
//
// Delivery reuses the #2030 machinery: a `kind: 'plugin-event'` pending entry
// drained through the same `_execute` chokepoint (inheriting the #1157
// WorkspaceGate and the #611 backstop), the payload arriving in an
// `<external-event source="plugin:<id>">` envelope parallel to the existing
// `source="github"` one, and one `source: 'internal-plugin'` event-log row per
// wake.
//
// Like `wake-agent.js` / `flow-emit.js`, this module is fs-free so the delivery
// contract is unit-testable: request validation, target resolution and the
// queue-entry shape. All I/O stays in orchestrator.js.

// The consumer-side listener type in `triggers.json` and the pending-entry
// `kind`. Deliberately NOT `http`/`github-event` (§4B's four touch points): a
// `plugin-event` trigger must be invisible to `pollerSubscribes` and must not
// misdescribe an edge with no webhook and no GitHub event behind it. Nothing
// schedules this type — it fires only from the queue, exactly like `wake-agent`.
const PLUGIN_EVENT_TRIGGER_TYPE = 'plugin-event';
const PLUGIN_EVENT_PENDING_KIND = 'plugin-event';

// The event-log key. A separate map entry in the console's trigger-summary.js
// INTERNAL_EVENT_LABELS (like `handoff.wake`), never in GITHUB_EVENT_OPTIONS —
// that array is the trigger editor's `<select>` and must not offer a key no
// poller can subscribe to.
const PLUGIN_EVENT_EVENT_KEY = 'plugin.event';

const SUMMARY_MAX = 400;

// Refusal reasons → HTTP status, one per distinct status the route answers, so a
// broker can tell a rejection apart from a transport failure.
const PLUGIN_EVENT_REFUSALS = {
  'bad-token': 401,
  'no-grant': 404,       // the plugin is not granted to any agent in its scope
};

function clampSummary(summary) {
  if (typeof summary !== 'string') return '';
  const s = summary.trim();
  if (Array.from(s).length <= SUMMARY_MAX) return s;
  return Array.from(s).slice(0, SUMMARY_MAX - 1).join('') + '…';
}

// Validate the request body → `{ok, value}` / `{ok:false, error}`. pluginId and
// scopeId are NOT in the body — they come from the verified scope token.
function validatePluginEventRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'body must be an object' };
  }
  const event = body.event;
  if (typeof event !== 'string' || !event.trim()) {
    return { ok: false, error: 'event must be a non-empty string' };
  }
  // `!= null` treats an explicit `null` like an omitted field — a broker that
  // has no value for an optional key may send either (the Jira broker sends
  // `eventId: null` for a burst digest). A wrong TYPE is still rejected.
  if (body.summary != null && typeof body.summary !== 'string') {
    return { ok: false, error: 'summary must be a string when present' };
  }
  if (body.eventId != null && typeof body.eventId !== 'string') {
    return { ok: false, error: 'eventId must be a string when present' };
  }
  if (body.payload != null && (typeof body.payload !== 'object' || Array.isArray(body.payload))) {
    return { ok: false, error: 'payload must be an object when present' };
  }
  return {
    ok: true,
    value: {
      event: event.trim(),
      summary: clampSummary(body.summary),
      eventId: typeof body.eventId === 'string' && body.eventId.trim() ? body.eventId.trim() : null,
      payload: body.payload && typeof body.payload === 'object' ? body.payload : null,
    },
  };
}

// ── payloadFilter ──────────────────────────────────────────────────────────
// An optional `{ key: value }` on the trigger, matched against the delivered
// payload's TOP-LEVEL STRING fields — all keys must match, exactly and
// case-sensitively (the `labelFilter` rule). Absent / empty / malformed = no
// filter. Deliberately generic: the platform does not know that a Jira payload
// carries `toStatus`; the plugin's docs say which keys exist (§D5). Only string
// fields compare, because JS and Python stringify booleans and numbers
// differently and the agent runtime mirrors this rule.
function normalizePayloadFilter(filter) {
  if (!filter || typeof filter !== 'object' || Array.isArray(filter)) return null;
  const out = {};
  for (const [k, v] of Object.entries(filter)) {
    const key = String(k).trim();
    if (!key || typeof v !== 'string' || !v.trim()) continue;
    out[key] = v.trim();
  }
  return Object.keys(out).length ? out : null;
}

function payloadFieldsMatch(filter, payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  return Object.entries(filter).every(([k, v]) => typeof payload[k] === 'string' && payload[k] === v);
}

// A burst digest (`{kind:'digest', events:[…]}`, the Jira broker's shape)
// matches when ANY of its events would have matched on its own — a digest that
// folds one wanted transition in with four others must still wake the agent.
function matchesPayloadFilter(filter, payload) {
  const f = normalizePayloadFilter(filter);
  if (!f) return true;
  if (payload && typeof payload === 'object' && payload.kind === 'digest' && Array.isArray(payload.events)) {
    return payload.events.some((e) => payloadFieldsMatch(f, e));
  }
  return payloadFieldsMatch(f, payload);
}

// Does one trigger listen for this plugin event? `plugin-event` type, matching
// `pluginId`, enabled, either no `eventFilter` (any event) or an exact match on
// the event name, and — when the trigger carries a `payloadFilter` — a payload
// that satisfies it. `eventFilter` and the filter keys are opaque to the
// platform — they are the broker's vocabulary (§4B).
function matchesPluginEventTrigger(trigger, { pluginId, event, payload } = {}) {
  if (!trigger || typeof trigger !== 'object') return false;
  if (trigger.type !== PLUGIN_EVENT_TRIGGER_TYPE) return false;
  if (trigger.enabled === false) return false;
  if (trigger.pluginId !== pluginId) return false;
  const filter = typeof trigger.eventFilter === 'string' ? trigger.eventFilter.trim() : '';
  if (filter && filter !== event) return false;
  return matchesPayloadFilter(trigger.payloadFilter, payload);
}

// Resolve which agents to wake. `agents` is `[{agentId, inScope, granted,
// triggers}]` — the orchestrator resolves `inScope` (resolveScopeId ===
// scopeId) and `granted` (effectivePlugins includes pluginId) per agent, and
// this pure core does the trigger match. Returns `[{agentId, triggerId}]` (the
// first matching trigger per agent — a producer fires one event, the consumer
// runs once).
function resolvePluginEventTargets({ pluginId, event, payload = null }, agents) {
  const out = [];
  for (const a of Array.isArray(agents) ? agents : []) {
    if (!a || typeof a.agentId !== 'string' || !a.agentId) continue;
    if (!a.inScope || !a.granted) continue;
    const match = (Array.isArray(a.triggers) ? a.triggers : [])
      .find((t) => matchesPluginEventTrigger(t, { pluginId, event, payload }));
    if (match) out.push({ agentId: a.agentId, triggerId: match.id || null });
  }
  return out;
}

// The pending-queue entry. `receivedAt`/`id` are stamped by `enqueuePending`.
// `source: 'internal-plugin'` matches the label fast-path so log readers can
// tell the delivery path apart. The payload rides along and is clamped
// python-side (`_clamp_event_deep`) before it reaches the prompt.
function buildPluginEventEntry({ pluginId, event, summary, payload, eventId, triggerId }) {
  return {
    kind: PLUGIN_EVENT_PENDING_KIND,
    source: 'internal-plugin',
    pluginId,
    event,
    ...(summary ? { summary } : {}),
    ...(eventId ? { eventId } : {}),
    ...(payload && typeof payload === 'object' ? { payload } : {}),
    ...(triggerId ? { triggerId } : {}),
  };
}

// Synthesize the transparency-log event. `buildEventEntry` is GitHub-shaped, so
// a plugin event has no repo, no label and no work item — those columns render
// `—`; the `plugin.event` key is what makes the Event column read in plain
// language via the console's `eventLabel` helper.
function buildPluginEventLogEvent({ pluginId, event, summary, eventId, now }) {
  return {
    id: eventId || `plugin:${pluginId}:${event}`,
    actor: { login: `plugin:${pluginId}` },
    repo: { name: null },
    created_at: now,
    payload: { action: event, ...(summary ? { summary } : {}) },
  };
}

module.exports = {
  PLUGIN_EVENT_TRIGGER_TYPE,
  PLUGIN_EVENT_PENDING_KIND,
  PLUGIN_EVENT_EVENT_KEY,
  PLUGIN_EVENT_REFUSALS,
  SUMMARY_MAX,
  clampSummary,
  validatePluginEventRequest,
  matchesPluginEventTrigger,
  resolvePluginEventTargets,
  buildPluginEventEntry,
  buildPluginEventLogEvent,
  normalizePayloadFilter,
  matchesPayloadFilter,
};
