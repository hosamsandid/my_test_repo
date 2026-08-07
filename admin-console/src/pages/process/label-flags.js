// label-flags.js — client-side gate/brake classification (#928).
//
// Whether a routing label is a human approval gate or a brake is CONFIGURATION,
// not a naming convention. The authoritative sources are the persisted flags,
// which the graph endpoints hand back on every response:
//
//   graph.labels: [ { name, humanGate, brake } ]   ← the label registry
//   channel port: { label, gate: 'human' }         ← an inline channel gate
//
// The former client-side `label.startsWith('human:')` match and the hardcoded
// `hold` / `needs:human` brake set are gone — a label with no flag is a plain
// agent label, whatever it is called (that is what lets the vocabulary rename,
// #927, give human-applied labels ordinary names like `approved-for-dispatch`).
//
// This is the deliberate client mirror of `makeLabelClassifier` in
// admin-console/api/process-graph.js: the server is the authority for the graph
// it renders, this module is what the edit dialogs warn on, and the two must
// agree. Keep the rule (and its precedence) in step when either side changes.

/**
 * The flags of one label, from the graph's label registry.
 * @param {Array} labels - graph.labels: [{ name, humanGate, brake }]
 * @param {string} name - the label to look up (trimmed before comparing)
 * @returns {{ humanGate: boolean, brake: boolean }} both false when unknown
 */
export function labelFlags(labels, name) {
  const key = typeof name === 'string' ? name.trim() : '';
  if (!key) return { humanGate: false, brake: false };
  for (const l of (Array.isArray(labels) ? labels : [])) {
    if (!l || typeof l.name !== 'string' || l.name.trim() !== key) continue;
    return { humanGate: !!l.humanGate, brake: !!l.brake };
  }
  return { humanGate: false, brake: false };
}

/**
 * Is this label a human approval gate — only a person may apply it?
 * True when the registry flags it `humanGate`, or when any channel port in
 * `channels` routes on it behind a `gate: 'human'`.
 * @param {Array} labels - graph.labels
 * @param {string} name - the label
 * @param {Array} [channels] - channel ports to also consider: [{ label, gate }]
 */
export function isGateLabel(labels, name, channels) {
  if (labelFlags(labels, name).humanGate) return true;
  const key = typeof name === 'string' ? name.trim() : '';
  if (!key) return false;
  return (Array.isArray(channels) ? channels : []).some(ch =>
    ch && ch.gate === 'human' && typeof ch.label === 'string' && ch.label.trim() === key);
}

/**
 * Is this label a brake — it pauses the loop pending a human decision?
 * A brake may be AGENT-applied (e.g. the reworker setting
 * `human-decision-required`), so it is not a gate and never a gate violation.
 */
export function isBrakeLabel(labels, name) {
  return labelFlags(labels, name).brake;
}

/**
 * The classification of a label for the edit dialogs: 'gate' | 'brake' | 'agent'.
 * Gate wins when a label carries both flags — mirrors the server's precedence.
 */
export function classifyLabel(labels, name, channels) {
  if (isGateLabel(labels, name, channels)) return 'gate';
  if (isBrakeLabel(labels, name)) return 'brake';
  return 'agent';
}
