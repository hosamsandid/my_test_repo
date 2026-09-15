// Pure decisions for the plugin-event trigger's optional `payloadFilter`
// (orchestrator/plugin-event.js `matchesPayloadFilter`): the editor holds it as
// `key=value` lines, the wire holds it as a flat `{ key: value }` object of
// strings. Nothing here knows what the keys mean — that is the plugin's
// vocabulary (the Jira docs say `toStatus`, `fromStatus`, …); the platform only
// carries and matches them.
//
// No React, no fetch — unit-tested under the admin-console-src job.

// Editor text → wire object. `{ ok: true, value: null }` for "no filter"; an
// error names the offending line so the form can show it verbatim.
export function parsePayloadFilter(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const out = {};
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    const eq = line.indexOf('=');
    const key = eq > 0 ? line.slice(0, eq).trim() : '';
    const value = eq > 0 ? line.slice(eq + 1).trim() : '';
    if (!key || !value) return { ok: false, error: `Line ${i + 1} must be key=value: "${line}"` };
    out[key] = value;
  }
  return { ok: true, value: Object.keys(out).length ? out : null };
}

function entries(filter) {
  if (!filter || typeof filter !== 'object' || Array.isArray(filter)) return [];
  return Object.entries(filter)
    .filter(([k, v]) => String(k).trim() && typeof v === 'string' && v.trim())
    .map(([k, v]) => [String(k).trim(), v.trim()]);
}

// Wire object → editor text (the initial value of the field on edit).
export function formatPayloadFilter(filter) {
  return entries(filter).map(([k, v]) => `${k}=${v}`).join('\n');
}

// The trigger row's one-line copy for a filtered listener.
export function payloadFilterSummary(filter) {
  return entries(filter).map(([k, v]) => `${k}=${v}`).join(' · ');
}
