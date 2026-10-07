// Legacy trigger problems (#2626) — the console half of the GET annotation in
// admin-console/api/trigger-validate.js `annotateTriggerList`. The server never
// rewrites a stored triggers.json; it flags an entry the write guard would now
// reject with `invalid` (the reason) and, when several entries share its id,
// `position` (its index in the stored array). Pure so `node --test` covers it.

// The warning text for a flagged row, or null.
export function triggerIssue(trigger) {
  const s = trigger && typeof trigger.invalid === 'string' ? trigger.invalid.trim() : '';
  return s || null;
}

// The CRUD path for one trigger. A duplicated id is addressed by its stored
// position so Edit/Delete/toggle act on exactly that row, not the first match.
export function triggerPath(agentId, triggerId, position) {
  const base = `/api/agents/${agentId}/triggers/${encodeURIComponent(triggerId)}`;
  return Number.isInteger(position) && position >= 0 ? `${base}?position=${position}` : base;
}

// A React key that stays unique when two rows share an id.
export function triggerRowKey(trigger, index) {
  if (!trigger || !trigger.id) return `#${index}`;
  return Number.isInteger(trigger.position) ? `${trigger.id}@${trigger.position}` : trigger.id;
}
