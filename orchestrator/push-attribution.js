'use strict';

// Push attribution + the optional "pushed by agent" producer filter on push
// triggers (#2571).
//
// THE PROBLEM. A data-flow hand-off drawn in the Flow editor ("the Clarifier
// wakes when the Specifier pushes") is a plain `github-event` push trigger, and
// the poller had no notion of who produced a push — so any push to the repo
// (another role, another Agent Team on the same repo, a human, a knowledge-base
// sync) fired it (#2566).
//
// WHY NOT THE EVENT. All agents share one GitHub PAT, so a PushEvent's `actor`
// is the same account for every agent. Commit authorship is not usable either:
// the Events API's PushEvent no longer carries `commits`, a push can mix human
// and agent commits (a merged upstream branch), and a commit authored by one
// agent can be pushed by another.
//
// THE RECORD. Every agent push goes through the platform: `gh-as-agent push`
// and `gh-as-agent pr` ask the orchestrator to run the network step
// (agentGitPush / agentCreatePr). At that moment the orchestrator knows exactly
// which agent pushed which branch at which head commit. That is recorded here as
// `(repo, ref, head sha) → producer`, and the poller looks the same triple up
// from the PushEvent (`payload.ref` / `payload.head`) — or from the synthetic
// PR-open push (#2529), which carries the PR's head ref/sha. So a push is
// attributed to the agent that PUSHED it, regardless of who authored its
// commits. Anything that did not go through `gh-as-agent` (a human push, a raw
// `git push`, the platform's own knowledge-base sync to `agent-knowledge`, a
// branch deletion) has no record and is "producer unknown".
//
// THE FILTER. A trigger's optional `pushedBy: [agentId, …]` lists same-team
// agents. Empty/absent = any push (unchanged). Set = the push must be recorded
// as produced by one of them — or by a pool instance of one of them (#2246,
// via the instance's `poolOf`) — AND by an agent of the subscriber's own team at
// push time, so a re-created agent that reuses an id in another team never
// satisfies a stale filter.

const fs = require('fs');
const path = require('path');

// Same persistence home as the poller's state.json: the poller is the only
// reader, the orchestrator (same process) the only writer.
const DEFAULT_DIR = process.env.PUSH_ATTRIBUTION_DIR || '/workspace/github-poller';
const FILE_NAME = 'push-attribution.json';

// A PushEvent normally surfaces within a poll or two; the generous TTL covers a
// poller that was down for days (the same horizon as the #2529 push-head memory).
const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 2000;

// The agent's team, as wake-agent.js `teamOf` reads it (a member carries
// `parentTeamId`; `teamId` covers the older shape).
function teamOf(cfg) {
  if (!cfg || typeof cfg !== 'object') return null;
  return cfg.parentTeamId || cfg.teamId || null;
}

// `refs/heads/<branch>` for a bare branch name; a full ref passes through.
function toRef(branchOrRef) {
  if (typeof branchOrRef !== 'string' || !branchOrRef) return null;
  return branchOrRef.startsWith('refs/') ? branchOrRef : `refs/heads/${branchOrRef}`;
}

// Stable lookup key. Repo names are case-insensitive on GitHub, and the env's
// clone URL need not match the Events API's casing.
function attributionKey({ repo, ref, head }) {
  const r = typeof repo === 'string' ? repo.trim().toLowerCase() : '';
  const f = toRef(ref);
  const h = typeof head === 'string' ? head.trim().toLowerCase() : '';
  if (!r || !f || !h) return null;
  return JSON.stringify([r, f, h]);
}

// The trigger's filter as a clean list of agent ids, or null for "any push".
function normalizePushedBy(value) {
  if (!Array.isArray(value)) return null;
  const out = [];
  for (const v of value) {
    if (typeof v !== 'string') continue;
    const id = v.trim();
    if (id && !out.includes(id)) out.push(id);
  }
  return out.length ? out : null;
}

/**
 * Does a push satisfy a subscriber's producer filter? Pure.
 *
 * @param {string[]|null} pushedBy - normalized filter (null = no filter)
 * @param {string|null} subscriberTeamId - the trigger owner's team
 * @param {{agentId:string, teamId?:string|null, poolOf?:string|null}|null} producer
 * @returns {{ok:boolean, producer:string|null}} `producer` is the attributed
 *   agent id (null when unknown) — the Event Log names it on a drop.
 */
function producerFilterVerdict(pushedBy, subscriberTeamId, producer) {
  if (!pushedBy || pushedBy.length === 0) return { ok: true, producer: producer ? producer.agentId : null };
  if (!producer || typeof producer.agentId !== 'string' || !producer.agentId) {
    return { ok: false, producer: null };
  }
  const named = pushedBy.includes(producer.agentId)
    || (typeof producer.poolOf === 'string' && pushedBy.includes(producer.poolOf));
  const sameTeam = !!subscriberTeamId && producer.teamId === subscriberTeamId;
  return { ok: named && sameTeam, producer: producer.agentId };
}

// The data-flow upstream a derived trigger names in its id (AC6 migration).
// Two id shapes exist on live agents: the reconciler's full member ids
// (`<member>-on-push-<upstreamMember>`) and the materialiser's role keys
// (`<role>-on-push-<upstreamRole>`, member ids being `<team>-<role>`). Returns
// the upstream MEMBER id when it resolves to a known agent of the same team,
// else null (left untouched).
function derivedUpstreamFromId(triggerId, { memberId, teamId, teamOfAgent }) {
  if (typeof triggerId !== 'string' || !memberId || !teamId) return null;
  const candidates = [];
  const full = `${memberId}-on-push-`;
  if (triggerId.startsWith(full)) candidates.push(triggerId.slice(full.length));
  const prefix = `${teamId}-`;
  if (memberId.startsWith(prefix)) {
    const short = `${memberId.slice(prefix.length)}-on-push-`;
    if (triggerId.startsWith(short)) {
      const up = triggerId.slice(short.length);
      candidates.push(up, `${prefix}${up}`);
    }
  }
  for (const c of candidates) {
    if (c && c !== memberId && teamOfAgent(c) === teamId) return c;
  }
  return null;
}

/**
 * One-shot migration (AC6): give every DERIVED data-flow trigger (`dataFlow:
 * true`, `<consumer>-on-push-<upstream>` id) that has no `pushedBy` yet a filter
 * naming exactly its upstream. Manually-authored push triggers (no `dataFlow`
 * marker) and anything whose upstream cannot be resolved are left untouched.
 *
 * A rewrite of triggers.json moves the poller's legacy mtime horizon, so a
 * migrated trigger that carries no `activatedAt`/`createdAt` stamp is pinned to
 * the horizon it already had (`horizon`, the file's previous mtime) instead.
 *
 * @returns {{triggers: object[], changed: string[]}} a new array (input is not
 *   mutated) and the ids of the triggers that received a filter.
 */
function migrateDataFlowProducerFilter(triggers, { memberId, teamId, teamOfAgent, horizon = null }) {
  const list = Array.isArray(triggers) ? triggers : [];
  const changed = [];
  const out = list.map((t) => {
    if (!t || t.type !== 'github-event' || t.dataFlow !== true) return t;
    if (Array.isArray(t.pushedBy)) return t; // already carries a filter (possibly [] = any)
    const up = derivedUpstreamFromId(t.id, { memberId, teamId, teamOfAgent });
    if (!up) return t;
    changed.push(t.id);
    const next = { ...t, pushedBy: [up] };
    if (!next.activatedAt && !next.createdAt && horizon) next.activatedAt = horizon;
    return next;
  });
  return { triggers: out, changed };
}

/**
 * The persisted `(repo, ref, head) → producer` record. One instance per
 * process (see `defaultStore`); tests construct their own with a temp dir.
 */
class PushAttributionStore {
  constructor({ dir = DEFAULT_DIR, now = () => Date.now() } = {}) {
    this.file = path.join(dir, FILE_NAME);
    this.now = now;
    this.entries = null; // lazy — loaded on first use
  }

  _load() {
    if (this.entries) return this.entries;
    let parsed = {};
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) parsed = raw;
    } catch { /* absent / unreadable → start empty */ }
    this.entries = parsed;
    return this.entries;
  }

  _gc() {
    const entries = this._load();
    const now = this.now();
    for (const [k, v] of Object.entries(entries)) {
      if (!v || !Number.isFinite(v.ts) || now - v.ts > TTL_MS) delete entries[k];
    }
    const keys = Object.keys(entries);
    if (keys.length > MAX_ENTRIES) {
      keys.sort((a, b) => entries[a].ts - entries[b].ts);
      for (const k of keys.slice(0, keys.length - MAX_ENTRIES)) delete entries[k];
    }
  }

  // Best-effort: a failed write only loses attribution for a restart window.
  _save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.entries));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error(`[push-attribution] could not persist ${this.file}: ${err.message}`);
    }
  }

  /**
   * Record a push the platform made on behalf of an agent. Never throws.
   * @param {{repo:string, branch:string, head:string, agentId:string,
   *          teamId?:string|null, poolOf?:string|null}} rec
   */
  record({ repo, branch, head, agentId, teamId = null, poolOf = null }) {
    try {
      const key = attributionKey({ repo, ref: branch, head });
      if (!key || typeof agentId !== 'string' || !agentId) return false;
      const entries = this._load();
      entries[key] = {
        agentId,
        teamId: teamId || null,
        ...(poolOf ? { poolOf } : {}),
        ts: this.now(),
      };
      this._gc();
      this._save();
      return true;
    } catch {
      return false;
    }
  }

  // `{agentId, teamId, poolOf?}` or null when the push was not made through
  // the platform (or has aged out).
  lookup({ repo, ref, head }) {
    const key = attributionKey({ repo, ref, head });
    if (!key) return null;
    const hit = this._load()[key];
    if (!hit || !Number.isFinite(hit.ts) || this.now() - hit.ts > TTL_MS) return null;
    return { agentId: hit.agentId, teamId: hit.teamId || null, ...(hit.poolOf ? { poolOf: hit.poolOf } : {}) };
  }
}

let _default = null;
function defaultStore() {
  if (!_default) _default = new PushAttributionStore();
  return _default;
}

module.exports = {
  FILE_NAME,
  TTL_MS,
  MAX_ENTRIES,
  teamOf,
  attributionKey,
  normalizePushedBy,
  producerFilterVerdict,
  derivedUpstreamFromId,
  migrateDataFlowProducerFilter,
  PushAttributionStore,
  defaultStore,
};
