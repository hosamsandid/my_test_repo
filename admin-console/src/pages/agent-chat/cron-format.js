// Pure, framework-free helpers for parsing / building / describing a 5-field
// cron expression. Extracted from TriggersPanel.jsx (#866) so the Flow-Editor
// Inputs list can render the same plain-language schedule summary the chat
// Triggers panel uses — one source of truth, no drift, unit-testable without a
// React/DOM runtime.

export const DOW_LABELS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// ── Validation (#2625) ────────────────────────────────────────────────────
// The agent runtime schedules with croniter, which silently skips an invalid
// expression (logging only to stderr) — so the form must refuse one before it
// is saved. Pure and dependency-free so the server-side check can share it.

// [min, max] and optional names per field, in cron order.
const CRON_FIELDS = [
  { label: 'minute',       min: 0, max: 59 },
  { label: 'hour',         min: 0, max: 23 },
  { label: 'day of month', min: 1, max: 31 },
  { label: 'month',        min: 1, max: 12,
    names: ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'], nameBase: 1 },
  { label: 'weekday',      min: 0, max: 7,
    names: ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'], nameBase: 0 },
];

// Macros croniter accepts in place of the five fields.
const CRON_MACROS = new Set(['@yearly', '@annually', '@monthly', '@weekly', '@daily', '@midnight', '@hourly']);

function fieldValue(tok, f) {
  if (/^\d+$/.test(tok)) return Number(tok);
  const i = f.names ? f.names.indexOf(tok.toUpperCase()) : -1;
  return i >= 0 ? i + f.nameBase : NaN;
}

// One comma-separated item: `*`, `n`, `a-b`, each optionally `/step` (step ≥ 1).
function cronItemError(item, f) {
  const [base, step, extra] = item.split('/');
  if (extra !== undefined || base === '') return `invalid ${f.label} "${item}"`;
  if (step !== undefined && (!/^\d+$/.test(step) || Number(step) < 1)) {
    return `${f.label} step must be a whole number of at least 1`;
  }
  if (base === '*') return null;
  const bounds = base.split('-');
  if (bounds.length > 2) return `invalid ${f.label} "${item}"`;
  const nums = bounds.map(b => fieldValue(b, f));
  if (nums.some(Number.isNaN)) return `invalid ${f.label} "${item}"`;
  if (nums.some(n => n < f.min || n > f.max)) return `${f.label} must be between ${f.min} and ${f.max}`;
  if (nums.length === 2 && nums[0] > nums[1]) return `${f.label} range "${base}" runs backwards`;
  return null;
}

// Error message for a cron expression, or null when it is valid.
export function cronExpressionError(cron) {
  const expr = String(cron ?? '').trim();
  if (!expr) return 'Cron expression is required.';
  if (expr.startsWith('@')) {
    return CRON_MACROS.has(expr.toLowerCase()) ? null : `Unknown shortcut "${expr}".`;
  }
  const parts = expr.split(/\s+/);
  if (parts.length !== 5) {
    return `A cron expression has 5 fields (minute hour day month weekday) — found ${parts.length}.`;
  }
  for (let i = 0; i < 5; i++) {
    for (const item of parts[i].split(',')) {
      const err = cronItemError(item, CRON_FIELDS[i]);
      if (err) return err.charAt(0).toUpperCase() + err.slice(1) + '.';
    }
  }
  return null;
}

const isInt = v => /^\d+$/.test(String(v ?? '').trim());
const inRange = (v, min, max) => isInt(v) && Number(v) >= min && Number(v) <= max;

// Per-field errors for the builder's UI state: `{ ok, errors }`, where each
// key of `errors` names the input it belongs to (interval / minute / time /
// dom / raw). No silent defaults — an empty or out-of-range field is an error.
export function validateCronState(s) {
  const errors = {};
  const needsTime = s.mode === 'daily' || s.mode === 'weekly' || s.mode === 'monthly';
  if (s.mode === 'minutely' && !inRange(s.interval, 1, 59)) {
    errors.interval = 'Enter a whole number of minutes from 1 to 59.';
  }
  if (s.mode === 'hourly' && !inRange(s.minute, 0, 59)) {
    errors.minute = 'Enter a minute from 0 to 59.';
  }
  if (needsTime && (!inRange(s.hour, 0, 23) || !inRange(s.minute, 0, 59))) {
    errors.time = 'Choose a time.';
  }
  if (s.mode === 'weekly' && !inRange(s.dow, 0, 7)) {
    errors.dow = 'Choose a weekday.';
  }
  if (s.mode === 'monthly' && !inRange(s.dom, 1, 31)) {
    errors.dom = 'Enter a day of the month from 1 to 31.';
  }
  if (s.mode === 'custom') {
    const err = cronExpressionError(s.raw);
    if (err) errors.raw = err;
  }
  return { ok: Object.keys(errors).length === 0, errors };
}

// Parse a cron string into the builder's UI state. An unrecognised shape — or
// a preset shape with out-of-range values, e.g. `75 * * * *` — falls back to
// `custom` carrying the raw expression, so a hand-edited cron always
// round-trips and an invalid one is shown (and flagged) as typed.
export function parseCronState(cron) {
  const def = { hour: '9', minute: '0', interval: '5', dow: '1', dom: '1', raw: '' };
  if (!cron) return { mode: 'daily', ...def };
  const preset = parsePreset(cron, def);
  if (preset && validateCronState(preset).ok) return preset;
  return { mode: 'custom', ...def, raw: cron };
}

function parsePreset(cron, def) {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [min, hr, dom, month, dow] = parts;
  const everyMin = min.match(/^\*\/(\d+)$/);
  if (everyMin && hr === '*' && dom === '*' && month === '*' && dow === '*')
    return { mode: 'minutely', ...def, interval: everyMin[1] };
  if (/^\d+$/.test(min) && hr === '*' && dom === '*' && month === '*' && dow === '*')
    return { mode: 'hourly', ...def, minute: min };
  if (/^\d+$/.test(min) && /^\d+$/.test(hr) && dom === '*' && month === '*' && dow === '*')
    return { mode: 'daily', ...def, hour: hr, minute: min };
  if (/^\d+$/.test(min) && /^\d+$/.test(hr) && dom === '*' && month === '*' && /^[0-6]$/.test(dow))
    return { mode: 'weekly', ...def, hour: hr, minute: min, dow };
  if (/^\d+$/.test(min) && /^\d+$/.test(hr) && /^\d+$/.test(dom) && month === '*' && dow === '*')
    return { mode: 'monthly', ...def, hour: hr, minute: min, dom };
  return null;
}

// Build the expression from the UI state, verbatim: a whole number is
// normalised (`09` → `9`), anything else is emitted as typed so that
// cronExpressionError rejects it — never replaced by a default (#2625).
export function buildCron(s) {
  const n = v => { const t = String(v ?? '').trim(); return isInt(t) ? String(Number(t)) : t; };
  const m = n(s.minute);
  const h = n(s.hour);
  switch (s.mode) {
    case 'minutely': return `*/${n(s.interval)} * * * *`;
    case 'hourly':   return `${m} * * * *`;
    case 'daily':    return `${m} ${h} * * *`;
    case 'weekly':   return `${m} ${h} * * ${n(s.dow)}`;
    case 'monthly':  return `${m} ${h} ${n(s.dom)} * *`;
    case 'custom':   return s.raw || '';
    default:         return '';
  }
}

// Plain-language summary of a valid preset state; '' for custom or invalid
// state (the caller falls back to the raw expression).
export function describeCron(s) {
  if (s.mode === 'custom' || !validateCronState(s).ok) return '';
  const pad = v => String(Number(v)).padStart(2, '0');
  const time = `${pad(s.hour)}:${pad(s.minute)}`;
  const interval = Number(s.interval);
  switch (s.mode) {
    case 'minutely': return `Every ${interval} minute${interval === 1 ? '' : 's'}`;
    case 'hourly':   return `Every hour at :${pad(s.minute)}`;
    case 'daily':    return `Every day at ${time}`;
    case 'weekly':   return `Every ${DOW_LABELS[Number(s.dow) % 7]} at ${time}`;
    case 'monthly':  return `Day ${Number(s.dom)} of every month at ${time}`;
    default:         return '';
  }
}

// True when the state's hour + minute form a valid time of day (the builder's
// <input type="time"> shows '' otherwise).
export function inCronTime(s) {
  return inRange(s.hour, 0, 23) && inRange(s.minute, 0, 59);
}

// The builder's next state when the Schedule dropdown changes. Switching to
// Custom pre-fills the text field with the current expression, so the value
// is never '' and the user edits what they already had (#2625).
export function switchCronMode(s, mode) {
  if (mode === s.mode) return s;
  if (mode === 'custom') return { ...s, mode, raw: buildCron(s) };
  return { ...s, mode };
}
