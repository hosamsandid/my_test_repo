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

// BP mode (#362 UI rework Phase D) — edits a BriefingPack's brief.md in the
// orchestrator's workspace via bp-explorer's raw endpoints (GET → modify → PUT,
// which writes + git-commits). v1 supports the body (the node's prompt/content);
// frontmatter editing (depends_on / artifacts) lands in D2.
export function makeBpOps(workspace) {
  const base = '/api/bp-explorer';
  const q = `?workspace=${encodeURIComponent(workspace)}`;

  async function getRaw(bpId) {
    const r = await apiCall('GET', `${base}/bp/${bpId}/raw${q}`);
    return r && typeof r.content === 'string' ? r.content : '';
  }
  async function putRaw(bpId, content, message) {
    return apiCall('PUT', `${base}/bp/${bpId}/raw${q}`, {
      content,
      commit_message: message || `refine(bp:${bpId.slice(0, 6)}): edit brief via Flows`,
    });
  }
  // Split a brief.md into its leading YAML frontmatter block and the body that
  // follows. The body is exactly what bp-explorer returns as `body` (= the
  // node's content), so replacing it round-trips cleanly without touching YAML.
  function splitFrontmatter(content) {
    const m = content.match(/^(---\n[\s\S]*?\n---\n?)([\s\S]*)$/);
    return m ? { fm: m[1], body: m[2] } : { fm: '', body: content };
  }

  const fmEdit = (bpId, op, value) =>
    apiCall('POST', `${base}/bp/${bpId}/frontmatter-edit${q}`, { op, value });

  return {
    mode: 'bp',
    setPrompt: async (bpId, text) => {
      const { fm } = splitFrontmatter(await getRaw(bpId));
      await putRaw(bpId, fm + (text || ''));
    },
    // Frontmatter edits (#362 D2) — structured ops applied server-side + commit.
    // Same signatures as makeDraftOps so the on-type picker (CreateEdgeDialog)
    // works unchanged. Dependency A→B = "B depends on A".
    addDependency: (bpId, dependsOnId) => fmEdit(bpId, 'add-dependency', dependsOnId),
    removeDependency: (bpId, dependsOnId) => fmEdit(bpId, 'remove-dependency', dependsOnId),
    addArtifact: (bpId, { direction, path, description }) =>
      fmEdit(bpId, 'add-artifact', { direction, path, description }),
    removeArtifact: (bpId, { direction, path }) =>
      fmEdit(bpId, 'remove-artifact', { direction, path }),
    setStage: (bpId, stage) => fmEdit(bpId, 'set-stage', stage || ''),
  };
}

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
    setStage: async (roleId, stage) => {
      const b = clone(getBundle());
      const r = role(b, roleId);
      if (r) { if (stage) r.stage = stage; else delete r.stage; }
      await persist(b);
    },
    deleteRole: async (roleId) => {
      const b = clone(getBundle());
      b.roles = (b.roles || []).filter(r => r.id !== roleId);
      // Drop any dependency references to the removed role so no edge dangles.
      for (const r of b.roles) {
        if (Array.isArray(r.dependsOn)) r.dependsOn = r.dependsOn.filter(d => d !== roleId);
      }
      await persist(b);
    },

    // ── unified edges (#367): BP dependency + data-flow, draft-only ──
    // Dependency A→B means "B depends on A" (A upstream), stored on B.dependsOn.
    addDependency: async (roleId, dependsOnId) => {
      const b = clone(getBundle());
      const r = role(b, roleId);
      if (!r) throw new Error(`role ${roleId} not found`);
      r.dependsOn = Array.isArray(r.dependsOn) ? r.dependsOn : [];
      if (dependsOnId && dependsOnId !== roleId && !r.dependsOn.includes(dependsOnId)) {
        r.dependsOn.push(dependsOnId);
      }
      await persist(b);
    },
    removeDependency: async (roleId, dependsOnId) => {
      const b = clone(getBundle());
      const r = role(b, roleId);
      if (r) r.dependsOn = (r.dependsOn || []).filter(d => d !== dependsOnId);
      await persist(b);
    },
    // Data flow: a producer's `outputs` path becomes a consumer's `inputs` path.
    addArtifact: async (roleId, { direction, path, description }) => {
      const b = clone(getBundle());
      const r = role(b, roleId);
      if (!r) throw new Error(`role ${roleId} not found`);
      const key = direction === 'output' ? 'outputs' : 'inputs';
      r[key] = Array.isArray(r[key]) ? r[key] : [];
      const p = String(path || '').trim();
      if (p && !r[key].some(a => (a.path || a) === p)) {
        r[key].push({ path: p, ...(description ? { description } : {}) });
      }
      await persist(b);
    },
    removeArtifact: async (roleId, { direction, path }) => {
      const b = clone(getBundle());
      const r = role(b, roleId);
      if (r) {
        const key = direction === 'output' ? 'outputs' : 'inputs';
        r[key] = (r[key] || []).filter(a => (a.path || a) !== path);
      }
      await persist(b);
    },
  };
}
