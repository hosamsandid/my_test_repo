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
// same (artifact, from, label) edits in place (updates the gate); a new label
// adds a sibling channel.
export function upsertChannel(list, { artifact, from, label, gate }) {
  const art = artifact === 'issue' ? 'issue' : 'pr';
  const lbl = chLabelKey(label);
  const next = {
    artifact: art, from,
    ...(lbl ? { label: lbl } : {}),
    ...(gate === 'human' ? { gate: 'human' } : {}),
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
