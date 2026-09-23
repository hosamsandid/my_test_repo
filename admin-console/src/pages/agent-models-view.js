// Pure view logic for the Token Usage → Agent → Model tab (#2439). The JSX is
// uncovered per the #651 convention; every decision (row shaping, the model
// filter's option list, the model→rows match, and which models are "current")
// lives here and is unit-tested.

// Turn the /api/usage/agent-models payload into flat table rows. Column keys are
// plain strings/numbers so DataTable's built-in text filter and column sort work
// without custom comparators; the arrays ride alongside for chip rendering.
export function toRows(payload) {
  const agents = payload && Array.isArray(payload.agents) ? payload.agents : [];
  return agents.map((a) => {
    const models = Array.isArray(a.models) ? a.models : [];
    const modelNames = models.map((m) => m && m.model).filter(Boolean);
    const currentModels = Array.isArray(a.currentModels) ? a.currentModels : [];
    return {
      agentId: a.agentId || 'unknown',
      // '' (not null) so DataTable's String()-based filter/sort treat a missing
      // team/role as an empty cell rather than the literal "null".
      teamId: a.teamId || '',
      roleId: a.roleId || '',
      // String mirrors are what DataTable filters and sorts on.
      current: currentModels.join(', '),
      models: modelNames.join(', '),
      lastUsed: a.lastUsed || '',
      // Raw arrays for the cell renderers (chips, current-model emphasis).
      currentModels,
      modelList: models,
      modelNames,
    };
  });
}

// Distinct model names across every agent, sorted — the model-filter dropdown.
// Prefer the payload's own `models` list (already de-duped + sorted server-side)
// and fall back to deriving it from the agents so the filter still works if that
// field is ever absent.
export function modelOptions(payload) {
  if (payload && Array.isArray(payload.models) && payload.models.length) {
    return [...payload.models];
  }
  const set = new Set();
  const agents = payload && Array.isArray(payload.agents) ? payload.agents : [];
  for (const a of agents) {
    for (const m of Array.isArray(a.models) ? a.models : []) {
      if (m && m.model) set.add(m.model);
    }
  }
  return [...set].sort();
}

// Rows whose agent used the given model at any point in the window. '' = no
// filter (all rows). Answers "which agents use model X".
export function filterRowsByModel(rows, model) {
  if (!model) return Array.isArray(rows) ? rows : [];
  return (Array.isArray(rows) ? rows : []).filter((r) => (r.modelNames || []).includes(model));
}

// Is `model` one of the row's current (most-recently-used) models? Drives the
// visual emphasis that separates the live model from older ones.
export function isCurrentModel(row, model) {
  return !!row && (row.currentModels || []).includes(model);
}
