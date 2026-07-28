// Pure, framework-free helpers for parsing / building / describing a 5-field
// cron expression. Extracted from TriggersPanel.jsx (#866) so the Flow-Editor
// Inputs list can render the same plain-language schedule summary the chat
// Triggers panel uses — one source of truth, no drift, unit-testable without a
// React/DOM runtime.

export const DOW_LABELS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Parse a cron string into the builder's UI state. An unrecognised shape falls
// back to `custom` carrying the raw expression, so a hand-edited cron always
// round-trips.
export function parseCronState(cron) {
  const def = { hour: '9', minute: '0', interval: '5', dow: '1', dom: '1', raw: '' };
  if (!cron) return { mode: 'daily', ...def };
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return { mode: 'custom', ...def, raw: cron };
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
  return { mode: 'custom', ...def, raw: cron };
}

export function buildCron(s) {
  const m = String(parseInt(s.minute) || 0);
  const h = String(parseInt(s.hour) || 0);
  switch (s.mode) {
    case 'minutely': return `*/${parseInt(s.interval) || 5} * * * *`;
    case 'hourly':   return `${m} * * * *`;
    case 'daily':    return `${m} ${h} * * *`;
    case 'weekly':   return `${m} ${h} * * ${s.dow || 1}`;
    case 'monthly':  return `${m} ${h} ${parseInt(s.dom) || 1} * *`;
    case 'custom':   return s.raw || '';
    default:         return '';
  }
}

export function describeCron(s) {
  const pad = n => String(parseInt(n) || 0).padStart(2, '0');
  const time = `${pad(s.hour)}:${pad(s.minute)}`;
  switch (s.mode) {
    case 'minutely': return `Every ${parseInt(s.interval) || 5} minute${(parseInt(s.interval) || 5) === 1 ? '' : 's'}`;
    case 'hourly':   return `Every hour at :${pad(s.minute)}`;
    case 'daily':    return `Every day at ${time}`;
    case 'weekly':   return `Every ${DOW_LABELS[parseInt(s.dow)] ?? 'Monday'} at ${time}`;
    case 'monthly':  return `Day ${parseInt(s.dom) || 1} of every month at ${time}`;
    default:         return '';
  }
}
