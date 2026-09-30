'use strict';

// ─── who is a plugin call acting for? (#2562) ────────────────────────────────
//
// A plugin broker that holds per-PERSON credentials (Jira: each member's own
// Atlassian token) must know, for every CLI call an agent makes, whether that
// call belongs to a live chat turn — and whose — or to an autonomous run. The
// answer must be unforgeable from inside the agent container (D6): the older
// `AEE_ACTING_SENDER` env var (#2175) is overwritable by any Bash command, so
// it is NOT consulted here at all.
//
// The trust chain, all server-side except step 1:
//
//   1. The agent RUNNER (agent-entrypoint.py, the process that reads Matrix)
//      fetches a per-container RUN KEY once at startup, before any Claude run
//      exists, and keeps it in non-dumpable process memory — never env, never
//      disk. The first request per container generation wins; ANY second
//      request in that generation revokes the key (fail closed), so a copy a
//      tool call tried to mint later can never coexist with the real one.
//   2. The runner DECLARES every Claude run with that key: `chat` (the Matrix
//      room + event id of the message that started it) or `autonomous`. For a
//      chat run the orchestrator fetches the event from the homeserver with
//      the agent's own Matrix token and takes the sender from the SERVER's
//      copy — the runner only names the event, it cannot name a person.
//   3. A plugin CLI call carries the agent's CALLER TOKEN (an HMAC over the
//      agent id — it says which agent, not which human). The broker forwards
//      it, with its own scope token, to `POST /internal/plugin-credential-
//      grant`; the orchestrator looks up that agent's ONE active declaration.
//
// No active declaration, two of them, a revoked key or a bad token → refuse.
// There is deliberately no "fall back to the service account" branch: that is
// what keeps a chat turn from ever running under the team credential (AC6).
//
// Pure except for the injected clock / randomness; the orchestrator adapter
// does the Matrix fetch and the store reads.

const crypto = require('crypto');

const CALLER_TOKEN_PREFIX = 'aeecall1';
const CALLER_TOKEN_CONTEXT = 'aee-plugin-caller-v1\n';

// A declaration older than this is treated as gone (a runner that crashed
// mid-run never sends its end). Longer than any sane Claude run timeout.
const DEFAULT_RUN_TTL_MS = 6 * 60 * 60 * 1000;
// A chat declaration must name a recent message: a replayed months-old event id
// is not a live turn.
const CHAT_EVENT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

// ── caller token: "this request comes from agent X's container" ─────────────
function mintCallerToken(agentId, secret) {
  if (!agentId || !secret) return null;
  const sig = crypto.createHmac('sha256', String(secret))
    .update(CALLER_TOKEN_CONTEXT + String(agentId)).digest('base64url');
  return `${CALLER_TOKEN_PREFIX}.${Buffer.from(String(agentId)).toString('base64url')}.${sig}`;
}

// → agentId | null
function verifyCallerToken(token, secret) {
  if (typeof token !== 'string' || !secret) return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== CALLER_TOKEN_PREFIX) return null;
  let agentId;
  try { agentId = Buffer.from(parts[1], 'base64url').toString('utf8'); } catch { return null; }
  if (!agentId) return null;
  const expected = mintCallerToken(agentId, secret);
  return expected && safeEqual(expected, token) ? agentId : null;
}

// ── the per-agent run registry ──────────────────────────────────────────────
class RunRegistry {
  constructor({ now = () => Date.now(), randomBytes = (n) => crypto.randomBytes(n), ttlMs = DEFAULT_RUN_TTL_MS } = {}) {
    this.now = now;
    this.randomBytes = randomBytes;
    this.ttlMs = ttlMs;
    this.agents = new Map(); // agentId -> { keyHash, revoked, runs: Map(runId -> run) }
  }

  _hash(key) {
    return crypto.createHash('sha256').update(String(key)).digest('hex');
  }

  // A new container generation (spawn / stop): forget the key and every run.
  resetAgent(agentId) {
    this.agents.delete(String(agentId));
  }

  // → { ok: true, key } | { ok: false, reason }
  issueKey(agentId) {
    const id = String(agentId);
    const state = this.agents.get(id);
    if (state) {
      // A second request in one generation: either the runner restarted
      // without a respawn (not a supported path) or something else in the
      // container is trying to mint its own key. Revoke — never hand out a
      // second key and never keep the first valid alongside a contender.
      state.revoked = true;
      state.runs.clear();
      return { ok: false, reason: 'key-already-issued' };
    }
    const key = this.randomBytes(32).toString('hex');
    this.agents.set(id, { keyHash: this._hash(key), revoked: false, runs: new Map() });
    return { ok: true, key };
  }

  _authorize(agentId, key) {
    const state = this.agents.get(String(agentId));
    if (!state) return { ok: false, reason: 'no-run-key' };
    if (state.revoked) return { ok: false, reason: 'run-key-revoked' };
    if (!key || !safeEqual(this._hash(key), state.keyHash)) return { ok: false, reason: 'bad-run-key' };
    return { ok: true, state };
  }

  // Declare a run. `run` = { kind: 'chat', roomId, eventId, sender } (sender
  // already resolved from the homeserver by the caller) | { kind: 'autonomous' }.
  // → { ok: true, runId } | { ok: false, reason }
  begin(agentId, key, run) {
    const auth = this._authorize(agentId, key);
    if (!auth.ok) return auth;
    const kind = run && run.kind;
    if (kind !== 'chat' && kind !== 'autonomous') return { ok: false, reason: 'bad-kind' };
    if (kind === 'chat' && !(run.sender && run.roomId && run.eventId)) return { ok: false, reason: 'bad-chat-run' };
    const runId = this.randomBytes(12).toString('hex');
    auth.state.runs.set(runId, {
      runId,
      kind,
      ...(kind === 'chat' ? { roomId: String(run.roomId), eventId: String(run.eventId), sender: String(run.sender) } : {}),
      startedAt: this.now(),
    });
    return { ok: true, runId };
  }

  end(agentId, key, runId) {
    const auth = this._authorize(agentId, key);
    if (!auth.ok) return auth;
    return { ok: auth.state.runs.delete(String(runId)) };
  }

  // The ONE active run a plugin call from this agent belongs to.
  // → { ok: true, run } | { ok: false, reason }
  active(agentId) {
    const state = this.agents.get(String(agentId));
    if (!state) return { ok: false, reason: 'no-active-run' };
    if (state.revoked) return { ok: false, reason: 'run-key-revoked' };
    const now = this.now();
    for (const [runId, run] of state.runs) {
      if (now - run.startedAt > this.ttlMs) state.runs.delete(runId);
    }
    const runs = [...state.runs.values()];
    if (runs.length === 0) return { ok: false, reason: 'no-active-run' };
    if (runs.length > 1) return { ok: false, reason: 'ambiguous-run' };
    return { ok: true, run: runs[0] };
  }
}

// ── pure: is this homeserver event a live chat message from someone else? ────
// `event` is the homeserver's JSON for GET /rooms/{room}/event/{id}.
// → { ok: true, sender } | { ok: false, reason }
function chatSenderFromEvent(event, { roomId, agentMatrixId, now = Date.now(), maxAgeMs = CHAT_EVENT_MAX_AGE_MS } = {}) {
  if (!event || typeof event !== 'object') return { ok: false, reason: 'event-not-found' };
  if (event.type !== 'm.room.message') return { ok: false, reason: 'not-a-message' };
  if (roomId && event.room_id && event.room_id !== roomId) return { ok: false, reason: 'room-mismatch' };
  const sender = typeof event.sender === 'string' ? event.sender : '';
  if (!sender) return { ok: false, reason: 'no-sender' };
  if (agentMatrixId && sender === agentMatrixId) return { ok: false, reason: 'sender-is-agent' };
  const ts = Number(event.origin_server_ts);
  if (!Number.isFinite(ts) || now - ts > maxAgeMs) return { ok: false, reason: 'event-too-old' };
  return { ok: true, sender };
}

// ── pure: the credential decision for one plugin call ───────────────────────
// Inputs (all resolved by the adapter, fresh per call):
//   active            — registry.active(agentId)
//   senderUserId      — the chat sender's platform user id if resolvable AND
//                       trusted for this agent (isActingSenderTrusted), else null
//   personalValues    — that user's stored personal values for the plugin, or null
//   personalKeys      — the manifest's personalCredentials[] (required keys matter)
//   pagePath          — where a person adds their token (for the message)
//   pluginName        — "Jira"
// → { ok: true, mode: 'service', interactive: false }
//   { ok: true, mode: 'personal', interactive: true, userId, values }
//   { ok: false, status, code, message }
function decideCredentialGrant({ active, senderUserId, personalValues, personalKeys, pagePath = '/plugin-tokens', pluginName = 'this plugin' }) {
  if (!active || !active.ok) {
    const reason = (active && active.reason) || 'no-active-run';
    return {
      ok: false,
      status: 403,
      code: reason,
      message: reason === 'ambiguous-run'
        ? `Refused: more than one run is active for this agent, so the ${pluginName} identity is ambiguous.`
        : `Refused: this ${pluginName} call does not belong to a run the platform started (${reason}).`,
    };
  }
  const run = active.run;
  if (run.kind === 'autonomous') return { ok: true, mode: 'service', interactive: false };
  if (!senderUserId) {
    return {
      ok: false,
      status: 403,
      code: 'untrusted-sender',
      message: `Refused: the person who sent this chat message is not a member of this agent's team (or cannot be resolved to a platform account), so no ${pluginName} credential may be used for them.`,
    };
  }
  const values = personalValues && typeof personalValues === 'object' ? personalValues : {};
  const required = (Array.isArray(personalKeys) ? personalKeys : []).filter((k) => k && k.required === true).map((k) => k.key);
  const missing = required.filter((k) => !(typeof values[k] === 'string' && values[k].trim()));
  if (missing.length > 0 || Object.keys(values).length === 0) {
    return {
      ok: false,
      status: 424,
      code: 'personal-credential-required',
      message: `You have no personal ${pluginName} credential yet. In a chat, ${pluginName} runs under YOUR own account — add your ${pluginName} e-mail and API token in the Admin Console under Connections → Plugin Tokens (${pagePath}), then ask again. Nothing was sent to ${pluginName}.`,
    };
  }
  return { ok: true, mode: 'personal', interactive: true, userId: senderUserId, values: { ...values } };
}

module.exports = {
  CALLER_TOKEN_PREFIX,
  DEFAULT_RUN_TTL_MS,
  CHAT_EVENT_MAX_AGE_MS,
  mintCallerToken,
  verifyCallerToken,
  RunRegistry,
  chatSenderFromEvent,
  decideCredentialGrant,
};
