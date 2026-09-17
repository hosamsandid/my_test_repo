// Pure decisions for the plugin-event trigger's two filters:
//
//   `eventFilter`   — WHICH EVENT: the plugin's own event name (`status_changed`),
//                     matched exactly by orchestrator/plugin-event.js. Blank =
//                     every event the plugin sends.
//   `payloadFilter` — ONLY WHEN: `{ key: value }` conditions on the event's
//                     top-level string fields; every one must match exactly
//                     (case-sensitive). Null = every matching event.
//
// The two are easy to confuse (a status is NOT an event name — #jira-test), so
// the form renders both from the vocabulary the plugin declares in its manifest
// (`events[]`, plugin-manifest.js): a select of event names and a picker of
// payload keys. Nothing here knows what a key means — the vocabulary is the
// plugin's; the platform only carries and matches it. A plugin that declares no
// vocabulary degrades to free-text fields with the same wire shape.
//
// No React, no fetch — unit-tested under the admin-console-src job.

export const ANY_EVENT_LABEL = 'Any event this plugin sends';
export const UNDECLARED_EVENT_SUFFIX = ' — not an event this plugin declares';

function str(v) { return typeof v === 'string' ? v.trim() : ''; }

// The declared vocabulary of one installed plugin (GET /api/plugins →
// body.installed entry's manifest.events), or [] when the plugin is unknown,
// invalid or declares none.
export function pluginEvents(installed, pluginId) {
  const id = str(pluginId);
  const entry = (Array.isArray(installed) ? installed : [])
    .find(p => p && p.ok !== false && p.id === id);
  const events = entry && entry.manifest && Array.isArray(entry.manifest.events) ? entry.manifest.events : [];
  return events.filter(e => e && str(e.name));
}

// `<select>` rows for "Which event": "any" first, then each declared event as
// `name — description`. A stored value the plugin does not declare (an older
// trigger, a plugin whose vocabulary changed, or the very mistake this form
// exists to prevent) stays selectable so the edit round-trips it — flagged, so
// the author sees it is not going to match anything.
export function eventChoices(events, current) {
  const list = Array.isArray(events) ? events : [];
  const rows = [{ value: '', label: ANY_EVENT_LABEL }];
  for (const e of list) {
    const name = str(e.name);
    const desc = str(e.description);
    rows.push({ value: name, label: desc ? `${name} — ${desc}` : name });
  }
  const cur = str(current);
  if (cur && !list.some(e => str(e.name) === cur)) {
    rows.push({ value: cur, label: `${cur}${UNDECLARED_EVENT_SUFFIX}` });
  }
  return rows;
}

function fieldRow(p) {
  const row = { key: str(p.key) };
  if (str(p.description)) row.description = str(p.description);
  if (str(p.example)) row.example = str(p.example);
  return row;
}

// The payload keys an "Only when…" condition may name: the chosen event's
// fields, or — with no event chosen — the union across every declared event
// (first declaration of a key wins). An undeclared event name yields [].
export function payloadKeyChoices(events, eventName) {
  const list = Array.isArray(events) ? events : [];
  const name = str(eventName);
  const scope = name ? list.filter(e => str(e.name) === name) : list;
  const seen = new Set();
  const out = [];
  for (const e of scope) {
    for (const p of Array.isArray(e.payload) ? e.payload : []) {
      if (!p || !str(p.key) || seen.has(str(p.key))) continue;
      seen.add(str(p.key));
      out.push(fieldRow(p));
    }
  }
  return out;
}

const EMPTY_ROW = () => ({ key: '', value: '' });

function entries(filter) {
  if (!filter || typeof filter !== 'object' || Array.isArray(filter)) return [];
  return Object.entries(filter)
    .filter(([k, v]) => String(k).trim() && typeof v === 'string' && v.trim())
    .map(([k, v]) => [String(k).trim(), v.trim()]);
}

// Wire object → the form's editable rows (one empty row when there is none, so
// the editor always shows where a condition goes).
export function conditionsFromFilter(filter) {
  const rows = entries(filter).map(([key, value]) => ({ key, value }));
  return rows.length ? rows : [EMPTY_ROW()];
}

// Editable rows → wire object. Fully empty rows are ignored; a half-filled row
// is an error naming the row so the form can point at it. No rows → null.
export function conditionsToFilter(rows) {
  const out = {};
  const list = Array.isArray(rows) ? rows : [];
  for (let i = 0; i < list.length; i += 1) {
    const key = str(list[i] && list[i].key);
    const value = str(list[i] && list[i].value);
    if (!key && !value) continue;
    if (!key) return { ok: false, error: `Condition ${i + 1} needs a field` };
    if (!value) return { ok: false, error: `Condition ${i + 1} needs a value` };
    out[key] = value;
  }
  return { ok: true, value: Object.keys(out).length ? out : null };
}

// The trigger row's one-line copy for a filtered listener.
export function payloadFilterSummary(filter) {
  return entries(filter).map(([k, v]) => `${k}=${v}`).join(' · ');
}
