// Pure, dependency-free helpers for the GitHub-channel `channels` port, shared by
// the live + draft edit adapters (edit-adapters.js) and unit-tested directly.
//
// #828 keying relaxation: the channel key moved from (artifact, from) to
// (artifact, from, label) so a single producer can feed one consumer through
// DIFFERENTLY-labelled channels — switch fan-in (e.g. a reviewer's PR routed to
// the merger on `ready-to-merge` and to the reworker on `revisions-required`).

export function chLabelKey(label) {
  return typeof label === 'string' && label.trim() ? label.trim() : '';
}

// Upsert a channel into a list, keyed on (artifact, from, label). Re-drawing the
// same (artifact, from, label) edits in place (updates the gate/wake-prompt); a
// new label adds a sibling channel. The whole port is rebuilt from the known
// fields, so a legacy `transport` key (removed in #2578) is dropped on write.
export function upsertChannel(list, { artifact, from, label, gate, wakePrompt, autoClaim }) {
  const art = artifact === 'issue' ? 'issue' : 'pr';
  const lbl = chLabelKey(label);
  const wp = typeof wakePrompt === 'string' && wakePrompt.trim() ? wakePrompt.trim() : '';
  const next = {
    artifact: art, from,
    ...(lbl ? { label: lbl } : {}),
    ...(gate === 'human' ? { gate: 'human' } : {}),
    // Optional authored wake-prompt override (#868) — carried on the port so the
    // reconciler feeds it into the regenerated derived listener's prompt.
    ...(wp ? { wakePrompt: wp } : {}),
    // Claim opt-out (#958) — the port is the durable authoring point, since the
    // derived listener itself is regenerated on every reconcile. Only the
    // non-default (`false`) is persisted; anything else means "auto-claim on".
    ...(autoClaim === false ? { autoClaim: false } : {}),
  };
  const out = (Array.isArray(list) ? list : []).slice();
  const i = out.findIndex(c => c.artifact === art && c.from === from && chLabelKey(c.label) === lbl);
  if (i >= 0) out[i] = next; else out.push(next);
  return out;
}

// Remove a channel from a list. When a `label` is supplied (present in the spec,
// including the empty string), the match is the full (artifact, from, label) key
// so switch fan-in siblings are removed individually; a legacy caller that omits
// `label` entirely drops every channel with that (artifact, from).
export function removeChannelFrom(list, { artifact, from, label }) {
  const art = artifact === 'issue' ? 'issue' : 'pr';
  const hasLabel = label !== undefined;
  const lbl = chLabelKey(label);
  return (Array.isArray(list) ? list : []).filter(c =>
    !(c.artifact === art && c.from === from && (!hasLabel || chLabelKey(c.label) === lbl)));
}
