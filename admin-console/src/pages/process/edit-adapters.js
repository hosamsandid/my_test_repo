// edit-adapters.js — write-target abstraction for the Process Canvas editing UI
// (Process Canvas v2, #345).
//
// The same dialogs/inspector edit either a LIVE agent (writes through to the
// running agent via the HTTP API) or a DRAFT bundle (mutates an in-memory
// process-template bundle and persists it via the drafts API). Both expose the
// same surface so the UI doesn't branch on mode.

import { apiCall } from '../../hooks/useApi';

// Live mode — every op is an HTTP call against the running agent.
export const liveOps = {
  mode: 'live',
  listTriggers: (roleId) => apiCall('GET', `/api/agents/${roleId}/triggers`),
  createTrigger: (roleId, body) => apiCall('POST', `/api/agents/${roleId}/triggers`, body),
  updateTrigger: (roleId, tid, body) => apiCall('PUT', `/api/agents/${roleId}/triggers/${tid}`, body),
  deleteTrigger: (roleId, tid) => apiCall('DELETE', `/api/agents/${roleId}/triggers/${tid}`),
  setEmits: (roleId, tid, emits) => apiCall('PUT', `/api/agents/${roleId}/triggers/${tid}/emits`, { emits }),
};

const clone = (x) => JSON.parse(JSON.stringify(x));
const uid = () => `t${Date.now()}${Math.floor(Math.random() * 1000)}`;

function slugRole(name, taken) {
  let base = String(name || 'role').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'role';
  let id = base, n = 2;
  while (taken.has(id)) { id = `${base}-${n++}`; }
  return id;
}

/**
 * Draft mode — every op mutates the bundle and persists it.
 * @param {() => object} getBundle  returns the *current* bundle (use a ref to avoid staleness)
 * @param {(next:object) => Promise<void>} persist  PUTs the bundle and updates state
 */
export function makeDraftOps(getBundle, persist) {
  const role = (b, id) => (b.roles || []).find(r => r.id === id);

  return {
    mode: 'draft',

    // ── triggers (shape-compatible with the live API) ──
    listTriggers: async (roleId) => {
      const r = role(getBundle(), roleId);
      return r ? (r.triggers || []).slice() : [];
    },
    createTrigger: async (roleId, body) => {
      const b = clone(getBundle());
      const r = role(b, roleId);
      if (!r) throw new Error(`role ${roleId} not found`);
      r.triggers = r.triggers || [];
      r.triggers.push({ id: uid(), enabled: true, ...body });
      await persist(b);
    },
    updateTrigger: async (roleId, tid, patch) => {
      const b = clone(getBundle());
      const t = (role(b, roleId)?.triggers || []).find(x => x.id === tid);
      if (t) Object.assign(t, patch);
      await persist(b);
    },
    deleteTrigger: async (roleId, tid) => {
      const b = clone(getBundle());
      const r = role(b, roleId);
      if (r) r.triggers = (r.triggers || []).filter(x => x.id !== tid);
      await persist(b);
    },
    setEmits: async (roleId, tid, emits) => {
      const b = clone(getBundle());
      const t = (role(b, roleId)?.triggers || []).find(x => x.id === tid);
      if (t) t.emits = emits;
      await persist(b);
    },

    // ── roles (draft-only; no live equivalent) ──
    addRole: async ({ displayName, systemPrompt, sessionPolicy, kind }) => {
      const b = clone(getBundle());
      b.roles = b.roles || [];
      const id = slugRole(displayName, new Set(b.roles.map(r => r.id)));
      b.roles.push({
        id, displayName: displayName || id, role: 'team-member',
        ...(kind === 'pr-review' ? { kind: 'pr-review', review: {} } : {}),
        sessionPolicy: kind === 'pr-review' ? 'per-invocation' : (sessionPolicy || 'persistent'),
        systemPrompt: systemPrompt || '', triggers: [],
      });
      await persist(b);
      return id;
    },
    patchRole: async (roleId, patch) => {
      const b = clone(getBundle());
      const r = role(b, roleId);
      if (r) Object.assign(r, patch);
      await persist(b);
    },
    renameRole: async (roleId, displayName) => {
      const b = clone(getBundle());
      const r = role(b, roleId);
      if (r) r.displayName = displayName;
      await persist(b);
    },
    setPrompt: async (roleId, systemPrompt) => {
      const b = clone(getBundle());
      const r = role(b, roleId);
      if (r) r.systemPrompt = systemPrompt;
      await persist(b);
    },
    deleteRole: async (roleId) => {
      const b = clone(getBundle());
      b.roles = (b.roles || []).filter(r => r.id !== roleId);
      await persist(b);
    },
  };
}
