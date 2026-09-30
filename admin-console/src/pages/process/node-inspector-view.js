// Pure view helpers for the Flow editor's NodeInspector (#2660): the two
// data-loss guards the inspector's JSX wires up. Dependency-free so they
// unit-test under `node --test` (#651); the JSX only renders their output.
//
//   1. Unsaved edits. The Details tab batches into one Save (#2295), and the
//      Routing tab's Outcomes block has its own "Save outcomes" draft. Both
//      are lost when the panel closes, and the outcomes draft also dies when
//      the Routing tab unmounts (switching to Details). `unsavedParts` /
//      `leaveGuard` decide when to ask; `discardMessage` words the question.
//   2. Delete agent (draft only). One click used to remove the role and
//      silently cut every hand-off touching it. `roleDeleteImpact` names those
//      connections so the confirmation can list them.

// The Routing tab's header hint. Inputs, hand-off wiring and artifacts are
// graph edits that write on the spot; the Outcomes block is the one exception
// with its own Save — the hint used to claim there was no Save at all.
export const ROUTING_SAVE_HINT = 'Inputs, hand-off wiring and artifacts apply immediately. '
  + 'Outcome edits (mode, titles, conditions, actions) are stored only when you press Save outcomes.';

// Which parts of the inspector hold unsaved edits, in display order.
export function unsavedParts({ detailsDirty = false, outcomesDirty = false } = {}) {
  const parts = [];
  if (detailsDirty) parts.push('Details');
  if (outcomesDirty) parts.push('Outcomes');
  return parts;
}

// Does leaving the current view discard edits? `action` is 'close' (the panel
// goes away: everything unsaved is lost) or 'tab' (switching tabs). Details
// state lives in the inspector itself and survives a tab switch; the outcomes
// draft lives in RoutingSection, which unmounts when the Routing tab is left.
// Returns the parts at risk — empty means leave without asking.
export function leaveGuard({ action, fromTab, toTab, detailsDirty = false, outcomesDirty = false } = {}) {
  if (action === 'close') return unsavedParts({ detailsDirty, outcomesDirty });
  if (action === 'tab') {
    if (fromTab === toTab) return [];
    return fromTab === 'routing' ? unsavedParts({ outcomesDirty }) : [];
  }
  return [];
}

// The confirmation body for a guarded leave.
const PART_LABEL = { Details: 'Details tab', Outcomes: 'Outcomes (Routing tab)' };

export function discardMessage(parts, action) {
  const list = (Array.isArray(parts) ? parts : []).map(p => PART_LABEL[p] || p);
  const what = list.length > 1
    ? `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`
    : (list[0] || 'inspector');
  const verb = action === 'tab' ? 'Switching tabs' : 'Closing now';
  return `This agent's ${what} ${list.length > 1 ? 'have' : 'has'} unsaved edits. ${verb} discards them.`;
}

// ── Delete impact ────────────────────────────────────────────────────────────

const arr = (v) => (Array.isArray(v) ? v : []);
const optionsOf = (r) => arr(r && r.outcomes && r.outcomes.options);
const outcomeName = (o) => (o && (o.title || o.id)) || 'untitled outcome';
const listensOn = (r, label) => arr(r && r.triggers)
  .some(t => t && typeof t.labelFilter === 'string' && t.labelFilter === label);
const ARTIFACT_NOUN = { pr: 'pull requests', issue: 'issues' };

// Labels a role sets: outcome `setLabel` actions plus legacy flat `emits`,
// each with the outcome it belongs to (null for a flat emit).
function labelsSet(r) {
  const out = [];
  for (const o of optionsOf(r)) {
    for (const a of arr(o && o.actions)) {
      if (a && a.type === 'setLabel' && typeof a.label === 'string' && a.label) out.push({ label: a.label, outcome: o });
    }
  }
  for (const l of arr(r && r.emits)) {
    if (typeof l === 'string' && l && !out.some(x => x.label === l)) out.push({ label: l, outcome: null });
  }
  return out;
}

function wakeTargets(r) {
  const out = [];
  for (const o of optionsOf(r)) {
    for (const a of arr(o && o.actions)) {
      const to = a && a.type === 'wakeAgent' && typeof a.to === 'string' ? a.to.trim() : '';
      if (to) out.push({ to, outcome: o });
    }
  }
  return out;
}

/**
 * Every connection that breaks when the draft role `roleId` is deleted, as
 * human-readable lines, grouped:
 *   incoming — hand-offs and dependencies that lead INTO this agent (their
 *              producers keep pointing at nothing afterwards);
 *   outgoing — hand-offs and dependencies this agent feeds into others;
 *   children — agents nested under it (they become top-level).
 * `roles` is the draft bundle's role list (the same list `deleteRole` edits).
 * Duplicate lines are collapsed; a self-reference is ignored.
 */
export function roleDeleteImpact(roleId, roles) {
  const all = arr(roles).filter(r => r && r.id);
  const self = all.find(r => r.id === roleId);
  const empty = { incoming: [], outgoing: [], children: [], total: 0 };
  if (!self) return empty;
  const others = all.filter(r => r.id !== roleId);
  const nameOf = (r) => r.displayName || r.id;
  const selfName = nameOf(self);
  const incoming = new Set();
  const outgoing = new Set();
  const children = new Set();

  for (const r of others) {
    const rn = nameOf(r);
    // Into this agent.
    for (const w of wakeTargets(r)) {
      if (w.to === roleId) incoming.add(`${rn} → ${selfName}: outcome “${outcomeName(w.outcome)}” (direct hand-off)`);
    }
    for (const { label, outcome } of labelsSet(r)) {
      if (listensOn(self, label)) {
        incoming.add(`${rn} → ${selfName}: label “${label}”${outcome ? ` (outcome “${outcomeName(outcome)}”)` : ''}`);
      }
    }
    // Out of this agent.
    for (const w of wakeTargets(self)) {
      if (w.to === r.id) outgoing.add(`${selfName} → ${rn}: outcome “${outcomeName(w.outcome)}” (direct hand-off)`);
    }
    for (const { label, outcome } of labelsSet(self)) {
      if (listensOn(r, label)) {
        outgoing.add(`${selfName} → ${rn}: label “${label}”${outcome ? ` (outcome “${outcomeName(outcome)}”)` : ''}`);
      }
    }
    for (const c of arr(r.channels)) {
      if (c && c.from === roleId) outgoing.add(`${rn} reacts to ${selfName}'s ${ARTIFACT_NOUN[c.artifact] || c.artifact}`);
    }
    if (arr(r.dependsOn).includes(roleId)) outgoing.add(`${rn} depends on ${selfName}`);
    if (r.parent === roleId) children.add(`${rn} (becomes top-level)`);
  }
  for (const c of arr(self.channels)) {
    const from = others.find(r => r.id === c?.from);
    if (from) incoming.add(`${selfName} reacts to ${nameOf(from)}'s ${ARTIFACT_NOUN[c.artifact] || c.artifact}`);
  }
  for (const d of arr(self.dependsOn)) {
    const dep = others.find(r => r.id === d);
    if (dep) incoming.add(`${selfName} depends on ${nameOf(dep)}`);
  }

  const out = { incoming: [...incoming], outgoing: [...outgoing], children: [...children] };
  out.total = out.incoming.length + out.outgoing.length + out.children.length;
  return out;
}

// The confirmation's lead sentence for a role delete.
export function deleteRoleSummary(name, impact) {
  const n = impact && impact.total ? impact.total : 0;
  const base = `Delete “${name}” from this draft, including its prompt? This cannot be undone.`;
  if (!n) return `${base} It has no connections to other agents.`;
  return `${base} ${n === 1 ? 'This connection is' : `These ${n} connections are`} lost:`;
}
