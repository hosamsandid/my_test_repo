// node-inspector-save.js — the batched "Details" save for the shared node
// inspector (#692), extracted as a pure, React-free async routine so the
// order-sensitive rules can be unit-tested against a mock ops adapter.
//
// Both draft and live modes run through this one function; behavioural
// differences are mode-aware, not duplicated:
//   - Display name is saved in both modes (live: PUT /api/agents/:id
//     { displayName }; draft: bundle rename) — parity of the first page.
//   - The Agent prompt is batched here ONLY in draft mode; a live agent's
//     prompt has its own editor (inherit/override + file path) that persists
//     separately, so we never touch it here (AC7).
//   - A brand-new stage typed inline is registered on the ordered stage list
//     (ops.addStage) BEFORE being assigned (ops.setStage), so it lands in the
//     layout order and never leaves a phantom stage (AC2).
//   - The Agent id is renamed LAST and ONLY in draft mode: it rewires
//     references and re-keys the selection, so every op above still resolves
//     the role by its old id. A live agent's id is immutable (AC6).

export async function applyDetailsSave(ops, node, fields, opts = {}) {
  const mode = opts.mode === 'live' ? 'live' : 'draft';
  const currentName = node.displayName ?? node.id;
  const name = fields.name;
  const newStage = String(fields.newStage || '').trim();

  if (name !== currentName && ops.renameRole) {
    await ops.renameRole(node.id, name);
  }

  if (mode === 'draft' && ops.setPrompt && fields.prompt !== (node.systemPrompt || '')) {
    await ops.setPrompt(node.id, fields.prompt);
  }

  // Register a freshly-typed stage before assigning it (no phantom stage).
  let targetStage = fields.stage;
  if (newStage) {
    if (ops.addStage) await ops.addStage(newStage);
    targetStage = newStage;
  }
  if (ops.setStage && targetStage !== (node.stage || '')) {
    await ops.setStage(node.id, targetStage);
  }

  // Id rename last, draft only.
  if (mode === 'draft' && fields.id !== node.id && ops.renameRoleId) {
    const renamedId = await ops.renameRoleId(node.id, fields.id);
    return { renamedId, stage: targetStage };
  }
  return { renamedId: null, stage: targetStage };
}
