'use strict';

// Trigger write validation (#2626): cron expressions and trigger ids. Pure, so
// `node --test` covers it; wired into `rawTriggerError` (process-template.js)
// and the trigger CRUD routes in api.js.
//
// The cron grammar is a deliberately STRICTER subset of what croniter (the
// agent-side scheduler, agent-entrypoint.py `_sync`) accepts: anything valid
// here is valid there, so a stored expression never ends up skipped on the
// agent. Supported:
//   - exactly 5 fields: minute hour day-of-month month day-of-week
//   - per field: `*`, `n`, `a-b`, `*/n`, `a/n`, `a-b/n` and comma lists of them
//   - month names JAN–DEC, weekday names SUN–SAT (any case); weekday 7 = Sunday
//   - `L` (last day of the month) in day-of-month, `d#n` (n-th weekday) in
//     day-of-week
//   - the croniter macros @yearly, @annually, @monthly, @weekly, @daily,
//     @midnight and @hourly (@reboot has no meaning for a scheduler and is
//     rejected)
// Rejected although croniter would take them: a step wider than the field
// (`*/60`, `*/100` — they fire once per cycle and read like a mistake),
// descending ranges (`5-2`), 6/7-field (seconds/year) forms, and a day-of-month
// that no listed month has (`0 9 30 2 *` can never fire).

const CRON_MACROS = new Set(['@yearly', '@annually', '@monthly', '@weekly', '@daily', '@midnight', '@hourly']);

const MONTH_NAMES = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const DOW_NAMES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

const CRON_FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31, allowLast: true },
  { name: 'month', min: 1, max: 12, names: MONTH_NAMES, nameBase: 1 },
  // 7 is croniter's alias for Sunday; a step may span at most the 7 real days.
  { name: 'day of week', min: 0, max: 7, names: DOW_NAMES, nameBase: 0, allowNth: true, span: 7 },
];

// Days in each month (Feb counted with 29 — a leap-year schedule is valid).
const MONTH_DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function fieldValue(raw, f) {
  if (/^\d+$/.test(raw)) return Number(raw);
  if (f.names) {
    const i = f.names.indexOf(raw.toUpperCase());
    if (i !== -1) return i + f.nameBase;
  }
  return null;
}

function rangeText(f) {
  const base = `${f.min}–${f.max}`;
  if (!f.names) return base;
  return `${base} or ${f.names[0]}–${f.names[f.names.length - 1]}`;
}

// Validate one comma-list entry of a field; returns the set of values it
// selects (for the can-never-fire check) or an error string.
function cronPartError(part, f) {
  if (part === '') return { error: `${f.name} has an empty list entry` };
  if (f.allowLast && part.toUpperCase() === 'L') return { values: null, last: true };
  if (f.allowNth && part.includes('#')) {
    const m = part.match(/^([^#]+)#(\d+)$/);
    const d = m ? fieldValue(m[1], f) : null;
    if (d === null || d < f.min || d > f.max || Number(m[2]) < 1 || Number(m[2]) > 5) {
      return { error: `${f.name} "${part}" must be <weekday>#<1–5>` };
    }
    return { values: null };
  }
  const [rangePart, stepPart, ...extra] = part.split('/');
  if (extra.length) return { error: `${f.name} "${part}" has more than one "/"` };
  let lo = f.min;
  let hi = f.max;
  let single = false;
  if (rangePart !== '*') {
    const bounds = rangePart.split('-');
    if (bounds.length > 2 || bounds.some(b => b === '')) {
      return { error: `${f.name} "${part}" is not a number, range or step (negative values are not allowed)` };
    }
    const nums = bounds.map(b => fieldValue(b, f));
    if (nums.some(n => n === null)) {
      return { error: `${f.name} "${part}" is not a valid value — ${f.name} must be ${rangeText(f)}` };
    }
    for (const n of nums) {
      if (n < f.min || n > f.max) return { error: `${f.name} must be ${rangeText(f)} (got ${n})` };
    }
    lo = nums[0];
    hi = nums.length === 2 ? nums[1] : nums[0];
    single = nums.length === 1;
    if (lo > hi) return { error: `${f.name} range "${rangePart}" runs backwards` };
    // `a/n` means "from a to the end of the field in steps of n".
    if (single && stepPart !== undefined) hi = f.max;
  }
  let step = 1;
  if (stepPart !== undefined) {
    if (!/^\d+$/.test(stepPart) || Number(stepPart) < 1) {
      return { error: `${f.name} step "/${stepPart}" must be a whole number of at least 1` };
    }
    step = Number(stepPart);
    const maxStep = (f.span || (f.max - f.min + 1)) - 1;
    if (step > maxStep) {
      return { error: `${f.name} step "/${step}" is wider than the field — use 1–${maxStep}` };
    }
  }
  const values = [];
  for (let v = lo; v <= hi; v += step) values.push(v);
  return { values };
}

// Returns an actionable error string, or null when `expr` is a valid cron
// expression the agent will schedule.
function cronExpressionError(expr) {
  if (typeof expr !== 'string' || !expr.trim()) return 'a cron trigger needs a cron expression';
  const trimmed = expr.trim();
  const bad = (why) => `Invalid cron expression "${trimmed}": ${why}`;
  if (trimmed.startsWith('@')) {
    return CRON_MACROS.has(trimmed.toLowerCase())
      ? null
      : bad(`unknown macro — use one of ${[...CRON_MACROS].join(', ')}`);
  }
  const fields = trimmed.split(/\s+/);
  if (fields.length !== 5) {
    return bad(`expected 5 fields (minute hour day-of-month month day-of-week), got ${fields.length}`);
  }
  const selected = [];
  for (let i = 0; i < 5; i++) {
    const f = CRON_FIELDS[i];
    const vals = new Set();
    let any = false;
    for (const part of fields[i].split(',')) {
      const r = cronPartError(part, f);
      if (r.error) return bad(r.error);
      if (r.values === null) any = true;
      else r.values.forEach(v => vals.add(v));
    }
    selected.push({ raw: fields[i], values: vals, any });
  }
  // Can-never-fire: a day-of-month restriction that no listed month has. Only
  // when day-of-week is `*` — with both restricted, cron fires on EITHER.
  const [, , dom, month, dow] = selected;
  if (dom.raw !== '*' && dow.raw === '*' && !dom.any && month.raw !== '*') {
    const firstDay = Math.min(...dom.values);
    const fits = [...month.values].some(m => firstDay <= MONTH_DAYS[m - 1]);
    if (!fits) return bad(`day ${firstDay} never occurs in the selected month(s), so it can never fire`);
  }
  return null;
}

// Trigger ids name a webhook path segment (`/hooks/<agent>/<id>`) and address
// the trigger in the CRUD routes, so they are kept URL- and filename-safe.
const TRIGGER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function triggerIdError(id) {
  if (typeof id === 'string' && TRIGGER_ID_RE.test(id)) return null;
  const shown = typeof id === 'string' ? `"${id}"` : String(id);
  return `Invalid trigger id ${shown}: use 1–64 letters, digits, ".", "_" or "-", starting with a letter or digit`;
}

// The POST guard for a new trigger's id: a well-formed shape (400) that no
// stored trigger already uses (409). Returns { status, error } or null.
function newTriggerIdError(existing, id) {
  const shape = triggerIdError(id);
  if (shape) return { status: 400, error: shape };
  if ((Array.isArray(existing) ? existing : []).some(t => t && t.id === id)) {
    return { status: 409, error: `A trigger with id "${id}" already exists on this agent. Choose another id.` };
  }
  return null;
}

// Legacy data (#2626 AC4): a stored triggers.json is never rewritten, but the
// GET route flags what the write guard would now reject so the console can show
// it. Returns a NEW array; flagged entries get `invalid` (the reason) and, when
// their id is shared, `position` (their index in the stored array) so PUT /
// DELETE can address exactly that row. Unflagged entries are returned as-is.
function annotateTriggerList(triggers) {
  const list = Array.isArray(triggers) ? triggers : [];
  const counts = new Map();
  for (const t of list) {
    if (t && typeof t.id === 'string') counts.set(t.id, (counts.get(t.id) || 0) + 1);
  }
  return list.map((t, position) => {
    if (!t || typeof t !== 'object') return t;
    const reasons = [];
    const dupes = typeof t.id === 'string' ? counts.get(t.id) : 0;
    if (dupes > 1) reasons.push(`Duplicate trigger id "${t.id}" — ${dupes} triggers share it; only one of them runs`);
    if (t.type === 'cron') {
      const ce = cronExpressionError(t.cron);
      if (ce) reasons.push(`${ce} — the agent skips this trigger`);
    }
    if (!reasons.length) return t;
    return { ...t, invalid: reasons.join('. '), ...(dupes > 1 ? { position } : {}) };
  });
}

// The GET annotations are view-only — never persist them back.
function stripTriggerAnnotations(t) {
  if (t && typeof t === 'object') {
    delete t.invalid;
    delete t.position;
  }
  return t;
}

// Which stored entry a PUT/DELETE addresses (#2626): the one at `position`
// when given (it must carry `triggerId`), else the FIRST entry with that id.
// Returns { index } or { status, error }.
function resolveTriggerIndex(triggers, triggerId, position) {
  const list = Array.isArray(triggers) ? triggers : [];
  if (position === undefined || position === null || position === '') {
    const index = list.findIndex(t => t && t.id === triggerId);
    return index === -1 ? { status: 404, error: 'Trigger not found' } : { index };
  }
  const index = typeof position === 'number' ? position : (/^\d+$/.test(String(position)) ? Number(position) : NaN);
  if (!Number.isInteger(index)) return { status: 400, error: 'position must be a non-negative integer' };
  const t = list[index];
  if (!t || t.id !== triggerId) return { status: 404, error: `Trigger "${triggerId}" is not at position ${index}` };
  return { index };
}

module.exports = {
  cronExpressionError, triggerIdError, newTriggerIdError, annotateTriggerList, stripTriggerAnnotations, resolveTriggerIndex,
  TRIGGER_ID_RE, CRON_MACROS,
};
