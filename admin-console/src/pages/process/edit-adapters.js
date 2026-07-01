// edit-adapters.js — write-target abstraction for the Process Canvas editing UI
// (Process Canvas v2, #345).
//
// The same dialogs/inspector edit either a LIVE agent (writes through to the
// running agent via the HTTP API) or a DRAFT bundle (mutates an in-memory
// process-template bundle and persists it via the drafts API). Both expose the
// same surface so the UI doesn't branch on mode.

import { apiCall } from '../../hooks/useApi';
import { wouldCreateCycle } from './hierarchy-utils';

// Read the current data-flow port block off a live agent's config as a plain
// {inputs, outputs, dependsOn} shape (read-modify-write helper). The PUT replaces
// the whole `dataFlow` block, matching how a draft persists the whole bundle.
const pathStr = (a) => (typeof a === 'string' ? a : (a && a.path)) || '';
// An artifact port's match key: its logical name when set, else its path (#382).
const artKey = (a) => (typeof a === 'string' ? a : (a && (a.name || a.path))) || '';
async function liveDataFlow(roleId) {
  const a = await apiCall('GET', `/api/agents/${roleId}`);
  const df = (a && typeof a.dataFlow === 'object' && a.dataFlow) || {};
  return {
    inputs: Array.isArray(df.inputs) ? df.inputs.slice() : [],
    outputs: Array.isArray(df.outputs) ? df.outputs.slice() : [],
    dependsOn: Array.isArray(df.dependsOn) ? df.dependsOn.slice() : [],
  };
}

// Live mode — every op is an HTTP call against the running agent. Its surface is
// shape-compatible with makeDraftOps: the editing UI never branches on mode.
// Edge ops write only the declarative ports (dataFlow / parentMemberId / stage);
// the backend re-derives the functional push triggers from those ports.
export const liveOps = {
  mode: 'live',
  listTriggers: (roleId) => apiCall('GET', `/api/agents/${roleId}/triggers`),
  createTrigger: (roleId, body) => apiCall('POST', `/api/agents/${roleId}/triggers`, body),
  updateTrigger: (roleId, tid, body) => apiCall('PUT', `/api/agents/${roleId}/triggers/${tid}`, body),
  deleteTrigger: (roleId, tid) => apiCall('DELETE', `/api/agents/${roleId}/triggers/${tid}`),
  setEmits: (roleId, tid, emits) => apiCall('PUT', `/api/agents/${roleId}/triggers/${tid}/emits`, { emits }),
  // Agent-level emitted labels (label hand-offs) — independent of any trigger.
  getRoleEmits: async (roleId) => {
    const a = await apiCall('GET', `/api/agents/${roleId}`);
    return Array.isArray(a?.emits) ? a.emits : [];
  },
  setRoleEmits: (roleId, emits) => apiCall('PUT', `/api/agents/${roleId}`, { emits }),

  // ── unified edges (#367): dependency + data-flow + hierarchy + stage ──
  // Dependency A→B means "B depends on A" (A upstream), stored on B.dataFlow.dependsOn.
  addDependency: async (roleId, dependsOnId) => {
    if (!dependsOnId || dependsOnId === roleId) return;
    const df = await liveDataFlow(roleId);
    if (!df.dependsOn.includes(dependsOnId)) df.dependsOn.push(dependsOnId);
    await apiCall('PUT', `/api/agents/${roleId}`, { dataFlow: df });
  },
  removeDependency: async (roleId, dependsOnId) => {
    const df = await liveDataFlow(roleId);
    df.dependsOn = df.dependsOn.filter(d => d !== dependsOnId);
    await apiCall('PUT', `/api/agents/${roleId}`, { dataFlow: df });
  },
  // Data flow: a producer's output artifact matches a consumer's input artifact
  // by logical `name` (or `path` when unnamed). `hint` is the informative path.
  addArtifact: async (roleId, { direction, name, hint, path, description }) => {
    const nm = String(name || '').trim();
    const h = String(hint || '').trim();
    const p = String(path || '').trim();
    const key = nm || p;               // a hint alone is not a match key
    if (!key) return;
    const port = {
      ...(nm ? { name: nm } : {}), ...(h ? { hint: h } : {}),
      ...(p ? { path: p } : {}), ...(description ? { description } : {}),
    };
    const df = await liveDataFlow(roleId);
    const k = direction === 'output' ? 'outputs' : 'inputs';
    if (!df[k].some(a => artKey(a) === key)) df[k].push(port);
    await apiCall('PUT', `/api/agents/${roleId}`, { dataFlow: df });
  },
  removeArtifact: async (roleId, { direction, name, path }) => {
    const key = String(name || path || '').trim();
    if (!key) return;
    const df = await liveDataFlow(roleId);
    const k = direction === 'output' ? 'outputs' : 'inputs';
    df[k] = df[k].filter(a => artKey(a) !== key);
    await apiCall('PUT', `/api/agents/${roleId}`, { dataFlow: df });
  },
  // Parent-child hierarchy (#377) — child gets parentMemberId; cleared with falsy.
  setParent: (roleId, parentId) =>
    apiCall('PUT', `/api/agents/${roleId}`, { parentMemberId: parentId || null }),
  // Process stage band — empty clears (inherits from parent).
  setStage: (roleId, stage) => apiCall('PUT', `/api/agents/${roleId}`, { stage: stage || '' }),

  // ── GitHub artifact ports (#380): produce flags + consumed channels ──
  // Produce flags drive the node badge/ports + the producer prompt block.
  getRoleGithub: async (roleId) => {
    const a = await apiCall('GET', `/api/agents/${roleId}`);
    return (a && a.github) || {};
  },
  setGithubProduces: (roleId, { pr, issue }) =>
    apiCall('PUT', `/api/agents/${roleId}`, { github: { producesPr: !!pr, producesIssue: !!issue } }),
  // Channels live on the *consumer*; the backend re-derives the github-event
  // triggers from them (reconcileTeamGithubChannels). Upsert keyed on (artifact, from).
  addChannel: async (roleId, { artifact, from, label, gate }) => {
    if (!from || from === roleId) return;
    const a = await apiCall('GET', `/api/agents/${roleId}`);
    const channels = upsertChannel(Array.isArray(a?.channels) ? a.channels : [], { artifact, from, label, gate });
    await apiCall('PUT', `/api/agents/${roleId}`, { channels });
  },
  updateChannel: async (roleId, spec) => liveOps.addChannel(roleId, spec),
  removeChannel: async (roleId, { artifact, from }) => {
    const a = await apiCall('GET', `/api/agents/${roleId}`);
    const art = artifact === 'issue' ? 'issue' : 'pr';
    const channels = (Array.isArray(a?.channels) ? a.channels : []).filter(c => !(c.artifact === art && c.from === from));
    await apiCall('PUT', `/api/agents/${roleId}`, { channels });
  },
};

// Upsert a channel into a list, keyed on (artifact, from). Pure helper shared by
// the live + draft adapters so a re-drawn edge edits in place rather than dupes.
function upsertChannel(list, { artifact, from, label, gate }) {
  const art = artifact === 'issue' ? 'issue' : 'pr';
  const next = {
    artifact: art, from,
    ...(typeof label === 'string' && label.trim() ? { label: label.trim() } : {}),
    ...(gate === 'human' ? { gate: 'human' } : {}),
  };
  const out = (Array.isArray(list) ? list : []).slice();
  const i = out.findIndex(c => c.artifact === art && c.from === from);
  if (i >= 0) out[i] = next; else out.push(next);
  return out;
}

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
    // Agent-level emitted labels (label hand-offs) — on the role, no trigger.
    getRoleEmits: async (roleId) => {
      const r = role(getBundle(), roleId);
      return Array.isArray(r?.emits) ? r.emits.slice() : [];
    },
    setRoleEmits: async (roleId, emits) => {
      const b = clone(getBundle());
      const r = role(b, roleId);
      if (r) { if (Array.isArray(emits) && emits.length) r.emits = emits; else delete r.emits; }
      await persist(b);
    },

    // ── roles (draft-only; no live equivalent) ──
    addRole: async ({ displayName, systemPrompt, sessionPolicy, github }) => {
      const b = clone(getBundle());
      b.roles = b.roles || [];
      const id = slugRole(displayName, new Set(b.roles.map(r => r.id)));
      b.roles.push({
        id, displayName: displayName || id, role: 'team-member',
        sessionPolicy: sessionPolicy || 'persistent',
        // A PR-reviewer role (#380) is a plain per-invocation agent that consumes a
        // PR channel — the caller wires the channel after creation.
        ...(github && (github.producesPr || github.producesIssue) ? { github } : {}),
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
    // Change a role's *id* (draft-only). The id is a plain bundle key here, so a
    // rename is safe as long as every reference to it is rewired: dependency
    // edges (dependsOn), parent links, and PR-review routing (reviewsPrFrom /
    // onApprove / onChangesRequested). Enforces the slug charset + uniqueness.
    renameRoleId: async (roleId, rawId) => {
      const b = clone(getBundle());
      const r = role(b, roleId);
      if (!r) throw new Error(`role ${roleId} not found`);
      const newId = String(rawId || '').trim().toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
      if (!newId) throw new Error('id must contain a letter or digit');
      if (newId === roleId) return newId;
      if ((b.roles || []).some(x => x.id === newId)) throw new Error(`id "${newId}" is already taken`);
      r.id = newId;
      for (const x of b.roles || []) {
        if (Array.isArray(x.dependsOn)) x.dependsOn = x.dependsOn.map(d => (d === roleId ? newId : d));
        if (x.parent === roleId) x.parent = newId;
        // Rewire GitHub-channel producer references (#380).
        if (Array.isArray(x.channels)) {
          for (const c of x.channels) if (c.from === roleId) c.from = newId;
        }
      }
      await persist(b);
      return newId;
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

    // ── stages (draft-only): the ordered list that drives the layout ──
    listStages: () => (getBundle().stages || []).slice(),
    addStage: async (name) => {
      const b = clone(getBundle());
      const s = String(name || '').trim();
      if (!s) return;
      b.stages = Array.isArray(b.stages) ? b.stages : [];
      if (!b.stages.includes(s)) b.stages.push(s);
      await persist(b);
    },
    renameStage: async (oldName, newName) => {
      const b = clone(getBundle());
      const s = String(newName || '').trim();
      if (!s) return;
      b.stages = (b.stages || []).map(x => (x === oldName ? s : x));
      // keep the list unique after a rename that collides
      b.stages = b.stages.filter((x, i) => b.stages.indexOf(x) === i);
      for (const r of b.roles || []) if (r.stage === oldName) r.stage = s;
      await persist(b);
    },
    removeStage: async (name) => {
      const b = clone(getBundle());
      b.stages = (b.stages || []).filter(x => x !== name);
      for (const r of b.roles || []) if (r.stage === name) delete r.stage;
      await persist(b);
    },
    reorderStages: async (names) => {
      const b = clone(getBundle());
      // Trust the caller's order but keep only stages that still exist.
      const existing = new Set(b.stages || []);
      b.stages = (names || []).filter(n => existing.has(n));
      await persist(b);
    },
    // Parent-child hierarchy (#378). setParent(child, parent) makes `parent` the
    // grouping node of `child`; clear with a falsy parentId. Self-parenting and
    // direct cycles (parent already a descendant) are rejected.
    setParent: async (roleId, parentId) => {
      const b = clone(getBundle());
      const r = role(b, roleId);
      if (!r) throw new Error(`role ${roleId} not found`);
      if (parentId && parentId !== roleId) {
        if (wouldCreateCycle(b.roles, roleId, parentId)) {
          throw new Error('that would create a parent cycle');
        }
        r.parent = parentId;
      } else {
        delete r.parent;
      }
      await persist(b);
    },
    deleteRole: async (roleId) => {
      const b = clone(getBundle());
      b.roles = (b.roles || []).filter(r => r.id !== roleId);
      // Drop references to the removed role so no edge/parent dangles.
      for (const r of b.roles) {
        if (Array.isArray(r.dependsOn)) r.dependsOn = r.dependsOn.filter(d => d !== roleId);
        if (r.parent === roleId) delete r.parent; // orphaned children become roots
        // Drop GitHub channels that consumed the removed producer (#380).
        if (Array.isArray(r.channels)) {
          r.channels = r.channels.filter(c => c.from !== roleId);
          if (!r.channels.length) delete r.channels;
        }
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
    // Data flow: a producer's output artifact matches a consumer's input by
    // logical `name` (or `path` when unnamed); `hint` is the informative path.
    addArtifact: async (roleId, { direction, name, hint, path, description }) => {
      const b = clone(getBundle());
      const r = role(b, roleId);
      if (!r) throw new Error(`role ${roleId} not found`);
      const k = direction === 'output' ? 'outputs' : 'inputs';
      r[k] = Array.isArray(r[k]) ? r[k] : [];
      const nm = String(name || '').trim();
      const h = String(hint || '').trim();
      const p = String(path || '').trim();
      const key = nm || p;
      if (key && !r[k].some(a => artKey(a) === key)) {
        r[k].push({
          ...(nm ? { name: nm } : {}), ...(h ? { hint: h } : {}),
          ...(p ? { path: p } : {}), ...(description ? { description } : {}),
        });
      }
      await persist(b);
    },
    removeArtifact: async (roleId, { direction, name, path }) => {
      const b = clone(getBundle());
      const r = role(b, roleId);
      if (r) {
        const k = direction === 'output' ? 'outputs' : 'inputs';
        const key = String(name || path || '').trim();
        r[k] = (r[k] || []).filter(a => artKey(a) !== key);
      }
      await persist(b);
    },

    // ── GitHub artifact ports (#380): produce flags + consumed channels ──
    getRoleGithub: async (roleId) => {
      const r = role(getBundle(), roleId);
      return (r && r.github) || {};
    },
    setGithubProduces: async (roleId, { pr, issue }) => {
      const b = clone(getBundle());
      const r = role(b, roleId);
      if (r) {
        const g = {};
        if (pr) g.producesPr = true;
        if (issue) g.producesIssue = true;
        if (Object.keys(g).length) r.github = g; else delete r.github;
      }
      await persist(b);
    },
    addChannel: async (roleId, spec) => {
      const b = clone(getBundle());
      const r = role(b, roleId);
      if (!r) throw new Error(`role ${roleId} not found`);
      if (!spec.from || spec.from === roleId) return;
      r.channels = upsertChannel(r.channels, spec);
      await persist(b);
    },
    // Upsert keyed on (artifact, from), so editing a channel's label/gate reuses it.
    updateChannel: async (roleId, spec) => makeDraftOps(getBundle, persist).addChannel(roleId, spec),
    removeChannel: async (roleId, { artifact, from }) => {
      const b = clone(getBundle());
      const r = role(b, roleId);
      if (r) {
        const art = artifact === 'issue' ? 'issue' : 'pr';
        r.channels = (r.channels || []).filter(c => !(c.artifact === art && c.from === from));
        if (!r.channels.length) delete r.channels;
      }
      await persist(b);
    },
  };
}
