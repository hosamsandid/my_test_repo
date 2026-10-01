// test-fakes.js — shared adapter fakes for the wiring-engine / review-gate
// test suites (#1002/#1005). Draft-like mutates a bundle in place (makeDraftOps
// shapes); live-like is a per-agent config store with server-side id stamping
// (the HTTP adapter shapes). Both use the REAL pure helpers the shipped
// adapters use, and `project` normalises persisted state (trigger ids dropped,
// deterministic order) so assembly orders and adapters compare on WHAT was
// persisted. Not a *.test.js file — node --test does not execute it.

import assert from 'node:assert/strict';
import { upsertChannel, removeChannelFrom, editChannel } from './channel-ops.js';
import {
  humansAfterUpsert, humanAfterConsumeAdd, humanAfterConsumeRemove,
  humanAfterEmitAdd, humanAfterEmitRemove,
} from './humans-registry-ops.js';

export const clone = (x) => JSON.parse(JSON.stringify(x));
export const artKey = (a) => (typeof a === 'string' ? a : (a && (a.name || a.path))) || '';

// ── two adapter fakes, mirroring the real edit-adapters semantics ───────────
// Draft-like: mutates a bundle's roles/humans in place (makeDraftOps shapes).
// Live-like: a store of per-agent configs written via read-modify-write, with
// server-side id stamping (the HTTP adapter shapes). Both use the REAL pure
// helpers (channel-ops, humans-registry-ops) the shipped adapters use.

export function makeDraftLike(bundle) {
  let n = 0;
  const role = (id) => {
    const r = (bundle.roles || []).find(x => x.id === id);
    if (!r) throw new Error(`role ${id} not found`);
    return r;
  };
  const ops = {
    mode: 'draft',
    listTriggers: async (id) => (role(id).triggers || []).slice(),
    createTrigger: async (id, body) => {
      const r = role(id);
      r.triggers = r.triggers || [];
      const t = { enabled: true, ...body };
      if (!t.id) t.id = `d${++n}`;
      r.triggers.push(t);
      return t;
    },
    updateTrigger: async (id, tid, patch) => {
      const t = (role(id).triggers || []).find(x => x.id === tid);
      if (t) Object.assign(t, patch);
    },
    deleteTrigger: async (id, tid) => {
      const r = role(id);
      r.triggers = (r.triggers || []).filter(x => x.id !== tid);
    },
    getRoleOutcomes: async (id) => role(id).outcomes || null,
    setRoleOutcomes: async (id, o) => { const r = role(id); if (o) r.outcomes = o; else delete r.outcomes; },
    getRoleGithub: async (id) => role(id).github || {},
    setGithubProduces: async (id, { pr, issue, prAudience, issueAudience }) => {
      role(id).github = {
        producesPr: !!pr, producesIssue: !!issue,
        ...(pr && prAudience === 'human' ? { prAudience: 'human' } : {}),
        ...(issue && issueAudience === 'human' ? { issueAudience: 'human' } : {}),
      };
    },
    addChannel: async (id, spec) => {
      if (!spec.from || spec.from === id) return;
      const r = role(id);
      r.channels = upsertChannel(r.channels || [], spec);
    },
    updateChannel: async (id, spec, { prevLabel } = {}) => {
      if (!spec.from || spec.from === id) return;
      const r = role(id);
      r.channels = editChannel(r.channels || [], prevLabel !== undefined ? prevLabel : spec.label, spec);
    },
    removeChannel: async (id, spec) => {
      const r = role(id);
      r.channels = removeChannelFrom(r.channels || [], spec);
    },
    addArtifact: async (id, { direction, name, hint, path, description }) => {
      const r = role(id);
      const k = direction === 'output' ? 'outputs' : 'inputs';
      r[k] = r[k] || [];
      const nm = String(name || '').trim(); const p = String(path || '').trim();
      const key = nm || p;
      if (key && !r[k].some(a => artKey(a) === key)) {
        r[k].push({
          ...(nm ? { name: nm } : {}), ...(String(hint || '').trim() ? { hint: String(hint).trim() } : {}),
          ...(p ? { path: p } : {}), ...(description ? { description } : {}),
        });
      }
    },
    removeArtifact: async (id, { direction, name, path }) => {
      const r = role(id);
      const k = direction === 'output' ? 'outputs' : 'inputs';
      const key = String(name || path || '').trim();
      r[k] = (r[k] || []).filter(a => artKey(a) !== key);
    },
    addDependency: async (to, from) => {
      const r = role(to);
      r.dependsOn = r.dependsOn || [];
      if (!r.dependsOn.includes(from)) r.dependsOn.push(from);
    },
  };
  const humanOps = {
    getHuman: async (id) => (bundle.humans || []).find(h => h && h.id === id) || null,
    addHumanEmit: async (id, label) => {
      const h = (bundle.humans || []).find(x => x && x.id === id) || { id, name: id };
      bundle.humans = humansAfterUpsert(bundle.humans, humanAfterEmitAdd(h, label));
    },
    removeHumanEmit: async (id, label) => {
      const h = (bundle.humans || []).find(x => x && x.id === id);
      if (!h) return;
      bundle.humans = humansAfterUpsert(bundle.humans, humanAfterEmitRemove(h, label));
    },
    wireHumanConsume: async (id, entry) => {
      const h = (bundle.humans || []).find(x => x && x.id === id) || { id, name: id };
      bundle.humans = humansAfterUpsert(bundle.humans, humanAfterConsumeAdd(h, entry));
    },
    unwireHumanConsume: async (id, entry) => {
      const h = (bundle.humans || []).find(x => x && x.id === id);
      if (!h) return;
      bundle.humans = humansAfterUpsert(bundle.humans, humanAfterConsumeRemove(h, entry));
    },
  };
  return { ops, humanOps };
}

export function makeLiveLike(store) {
  let n = 0;
  const agent = (id) => {
    if (!store.agents[id]) throw new Error(`agent ${id} not found`);
    return store.agents[id];
  };
  const draft = makeDraftLike({ get roles() { return Object.values(store.agents); }, humans: store.humans });
  // Same store semantics as draft-like, EXCEPT: server-side id stamping on
  // trigger create (id first, body may not override a falsy id) and a humans
  // registry living on the team store — the shapes liveOps produces.
  const ops = {
    ...draft.ops,
    mode: 'live',
    createTrigger: async (id, body) => {
      const a = agent(id);
      a.triggers = a.triggers || [];
      const t = { id: `t${++n}`, ...body };
      if (!t.id) t.id = `t${++n}`;
      a.triggers.push(t);
      return t;
    },
  };
  const humanOps = {
    getHuman: async (id) => (store.humans || []).find(h => h && h.id === id) || null,
    addHumanEmit: async (id, label) => {
      const h = (store.humans || []).find(x => x && x.id === id) || { id, name: id };
      store.humans = humansAfterUpsert(store.humans, humanAfterEmitAdd(h, label));
    },
    removeHumanEmit: async (id, label) => {
      const h = (store.humans || []).find(x => x && x.id === id);
      if (!h) return;
      store.humans = humansAfterUpsert(store.humans, humanAfterEmitRemove(h, label));
    },
    wireHumanConsume: async (id, entry) => {
      const h = (store.humans || []).find(x => x && x.id === id) || { id, name: id };
      store.humans = humansAfterUpsert(store.humans, humanAfterConsumeAdd(h, entry));
    },
    unwireHumanConsume: async (id, entry) => {
      const h = (store.humans || []).find(x => x && x.id === id);
      if (!h) return;
      store.humans = humansAfterUpsert(store.humans, humanAfterConsumeRemove(h, entry));
    },
  };
  return { ops, humanOps };
}

// Logical projection of persisted state, trigger ids normalised away, so two
// assembly orders (or two adapters) compare on WHAT was persisted, not on
// generated ids or write order.
export function project(rolesById, humans) {
  const norm = {};
  for (const [id, r] of Object.entries(rolesById)) {
    norm[id] = {
      triggers: (r.triggers || [])
        .map(({ id: _drop, ...t }) => t)
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      outcomes: r.outcomes || null,
      github: r.github || null,
      channels: r.channels || [],
      outputs: r.outputs || [],
      inputs: r.inputs || [],
      dependsOn: r.dependsOn || [],
    };
  }
  return { roles: norm, humans: humans || [] };
}

export const freshBundle = () => ({
  roles: [
    { id: 'ba', name: 'Business Analyst' },
    { id: 'dev', name: 'Developer' },
  ],
  humans: [{ id: 'p', name: 'BA Human' }],
});
export const freshStore = () => ({
  agents: {
    ba: { id: 'ba', name: 'Business Analyst' },
    dev: { id: 'dev', name: 'Developer' },
  },
  humans: [{ id: 'p', name: 'BA Human' }],
});

// Run one scenario against BOTH adapter shapes and assert the projected state
// is identical — the engine may not depend on adapter internals.
export async function onBoth(fn) {
  const bundle = freshBundle();
  const draft = makeDraftLike(bundle);
  await fn(draft);
  const store = freshStore();
  const live = makeLiveLike(store);
  await fn(live);
  const a = project(Object.fromEntries(bundle.roles.map(r => [r.id, r])), bundle.humans);
  const b = project(store.agents, store.humans);
  assert.deepEqual(a, b, 'draft-like and live-like adapters persisted different logical state');
  return a;
}

