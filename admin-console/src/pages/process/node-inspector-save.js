// node-inspector-save.js — the batched "Details" save for the shared node
// inspector (#692), extracted as a pure, React-free async routine so the
// order-sensitive rules can be unit-tested against a mock ops adapter.
//
// #2295 folded three more section-local "Save"s (the live prompt editor, the
// Parent picker's immediate apply, the Scaling section) into this one
// routine, so the Details tab has exactly one save control in every mode.
//
// Both draft and live modes run through this one function; behavioural
// differences are mode-aware, not duplicated:
//   - Display name is saved in both modes (live: PUT /api/agents/:id
//     { displayName }; draft: bundle rename) — parity of the first page.
//   - The Agent prompt is batched here as ONE OF TWO shapes depending on
//     mode: `fields.prompt` (draft's plain textarea) or `fields.livePrompt`
//     (live's inherit/additional/exclusive editor, via `ops.setLivePrompt`)
//     — never both, so the two never collide.
//   - Parent (`ops.setParent`) no longer applies on selection (#2295 AC3): it
//     is batched like everything else, in both modes.
//   - Scaling (`fields.pool`, live pooled roles only) is pre-flighted with
//     `scalingSaveDecision` BEFORE any write runs, so an invalid Scaling
//     input blocks the whole save rather than half-applying it.
//   - A brand-new stage typed inline is registered on the ordered stage list
//     (ops.addStage) BEFORE being assigned (ops.setStage), so it lands in the
//     layout order and never leaves a phantom stage (AC2).
//   - Memory (#2813, both modes), Prompt mode + Model (#2813, draft) are
//     validated/applied here too; the memory value is pre-flighted like
//     Scaling so an invalid size blocks the whole save.
//   - The Agent id is renamed LAST and ONLY in draft mode: it rewires
//     references and re-keys the selection, so every op above still resolves
//     the role by its old id. A live agent's id is immutable (AC6).
//
// Every write is wrapped so a failure names the part that failed (AC5) —
// `parseSaveError` splits that back out for the UI to point at the right
// field, and everything already applied before the failure stays applied
// (ordering is one-way, not transactional — the ops before the failed one
// already committed server-side).

import { scalingSaveDecision, scalingDraftDirty } from './scaling-view.js';
import { memoryLimitError } from '../memory-limit-view.js';

async function step(label, fn) {
  try {
    return await fn();
  } catch (e) {
    throw new Error(`${label}: ${(e && e.message) || e}`);
  }
}

/** Split a `"<Label>: <message>"` save error back into its parts, so a caller
 * can point the message at the field that failed instead of a generic banner.
 * A message with no recognised label (or none at all) reports `label: null`. */
export function parseSaveError(message) {
  const text = message || '';
  const m = /^(Display name|Agent prompt|Prompt mode|Model|Memory|Stage|Parent|Scaling|Agent ID):\s*(.*)$/s.exec(text);
  return m ? { label: m[1], message: m[2] } : { label: null, message: text };
}

/**
 * The success message for a batched save (#2295 AC10 — "after a successful
 * save it states what was saved", not just a generic "Saved."). `parts` is an
 * ordered list of `{label, dirty}` — the same "did this part actually
 * change" the caller already computed for the unsaved-edits banner — so the
 * two never drift out of sync with each other.
 */
export function savedSummary(parts) {
  const applied = (parts || []).filter((p) => p.dirty).map((p) => p.label);
  return applied.length ? `Saved: ${applied.join(', ')}.` : 'Saved.';
}

export async function applyDetailsSave(ops, node, fields, opts = {}) {
  const mode = opts.mode === 'live' ? 'live' : 'draft';
  const currentName = node.displayName ?? node.id;
  const name = fields.name;
  const newStage = String(fields.newStage || '').trim();

  // Pre-flight: Scaling validates before ANYTHING else applies (edge case —
  // "a Save must be blocked with a stated reason rather than half-applying").
  let poolPayload;
  let poolDirty = false;
  if (fields.pool) {
    const decision = scalingSaveDecision(fields.pool.draft, fields.pool.parentWipLimit);
    if (decision.error) throw new Error(`Scaling: ${decision.error}`);
    poolPayload = decision.payload;
    poolDirty = scalingDraftDirty(fields.pool.draft, fields.pool.initialPool);
  }

  // Pre-flight the memory requirement too (#2813 AC4) — empty clears it.
  const mem = fields.memory;
  const memText = mem ? String(mem.value || '').trim() : '';
  const memDirty = !!mem && memText !== String(mem.initial || '').trim();
  if (memDirty) {
    const err = memoryLimitError(memText, { ceiling: mem.ceiling });
    if (err) throw new Error(`Memory: ${err}`);
  }

  if (name !== currentName && ops.renameRole) {
    await step('Display name', () => ops.renameRole(node.id, name));
  }

  if (mode === 'draft' && ops.setPrompt && fields.prompt !== (node.systemPrompt || '')) {
    await step('Agent prompt', () => ops.setPrompt(node.id, fields.prompt));
  }

  if (mode === 'live' && fields.livePrompt && ops.setLivePrompt) {
    const lp = fields.livePrompt;
    const dirty = lp.role === 'member'
      ? (lp.promptMode !== lp.initialPromptMode || lp.text !== lp.initialText)
      : (lp.text !== lp.initialText);
    if (dirty) await step('Agent prompt', () => ops.setLivePrompt(node.id, lp));
  }

  // Portable role settings (#2813). Draft: prompt mode + model ride on the
  // bundle role (empty clears = legacy inference / environment default).
  if (mode === 'draft' && ops.setRoleSettings) {
    if (fields.promptMode !== undefined && fields.promptMode !== (node.promptMode || '')) {
      await step('Prompt mode', () => ops.setRoleSettings(node.id, { promptMode: fields.promptMode }));
    }
    if (fields.model !== undefined && String(fields.model).trim() !== (node.model || '')) {
      await step('Model', () => ops.setRoleSettings(node.id, { model: String(fields.model).trim() }));
    }
  }
  if (memDirty) {
    if (mode === 'draft' && ops.setRoleSettings) {
      await step('Memory', () => ops.setRoleSettings(node.id, { memoryLimit: memText }));
    } else if (mode === 'live' && ops.setMemoryLimit) {
      await step('Memory', () => ops.setMemoryLimit(node.id, memText));
    }
  }

  // Register a freshly-typed stage before assigning it (no phantom stage).
  let targetStage = fields.stage;
  if (newStage) {
    if (ops.addStage) await step('Stage', () => ops.addStage(newStage));
    targetStage = newStage;
  }
  if (ops.setStage && targetStage !== (node.stage || '')) {
    await step('Stage', () => ops.setStage(node.id, targetStage));
  }

  // Parent — static placement, batched like everything else (#2295 AC3: no
  // longer applies immediately on selection). The cycle guard lives
  // server/adapter-side; we just let its rejection surface as a step error.
  if (ops.setParent && fields.parent !== undefined && fields.parent !== (node.parent || '')) {
    await step('Parent', () => ops.setParent(node.id, fields.parent || null));
  }

  if (poolDirty && ops.setPool) {
    await step('Scaling', () => ops.setPool(node.id, poolPayload));
  }

  // Id rename last, draft only.
  if (mode === 'draft' && fields.id !== node.id && ops.renameRoleId) {
    const renamedId = await step('Agent ID', () => ops.renameRoleId(node.id, fields.id));
    return { renamedId, stage: targetStage };
  }
  return { renamedId: null, stage: targetStage };
}
