// Pure view helpers for Model Provider health status (#1843), kept out of
// ModelRegistry.jsx / ChatPanel.jsx so they can be unit-tested without a
// DOM/React harness (mirrors maintenance-banner.js / llm-probe-state.js).
//
// The health object comes from the API merged onto each endpoint (and onto the
// bound endpoint in GET /api/agents/:id/model-options):
//   { status: 'ok' | 'warning' | 'error' | 'unknown', reason: string|null,
//     checkedAt: ISO|null, httpStatus: number|null, budget: BudgetView|null }
// BudgetView (#2732, admin-console/api/llm-budget.js budgetView):
//   { status: 'ok', source: 'key'|'team', spend, maxBudget, pct, budgetDuration, resetAt }
//   | { status: 'none' } | { status: 'unavailable', reason }

// The Model Providers table cell (AC3). Returns { label, tone } where tone is a
// semantic key the JSX maps to a colour: 'ok' | 'warning' | 'error' | 'muted'.
// 'unknown' (never probed, or the probe can't run) is honest — never a guessed
// green (AC6). 'warning' (#2732) = reachable, but the budget is nearly used up.
export function healthCellModel(health) {
  const status = health && health.status;
  if (status === 'ok') return { label: 'OK', tone: 'ok' };
  if (status === 'warning') return { label: 'Warning', tone: 'warning' };
  if (status === 'error') return { label: 'Error', tone: 'error' };
  return { label: 'Unknown', tone: 'muted' };
}

// The tooltip / secondary detail for the cell: the failure reason on an error,
// the HTTP status on a success, or a "not yet checked" hint on unknown.
export function healthCellDetail(health) {
  const status = health && health.status;
  if (status === 'error') return health.reason || 'Unreachable';
  if (status === 'warning') return health.reason || 'Budget nearly used up';
  if (status === 'ok') return health.httpStatus ? `HTTP ${health.httpStatus}` : 'Reachable';
  return 'Not yet checked';
}

// The Agent-Chat non-blocking warning banner text (AC5). Returns a string only
// when the bound provider is currently red; null otherwise (unknown/ok never
// warn — "warn, do not block", and never warn off a merely-unknown status).
// A provider that is red because its budget is used up (#2732 AC8) says so
// rather than calling a reachable endpoint "unreachable".
export function providerWarningText(health, endpointName) {
  if (!health || health.status !== 'error') return null;
  const name = endpointName ? `“${endpointName}”` : 'the bound Model Provider';
  const reason = health.reason ? ` (${health.reason})` : '';
  if (health.budget && health.budget.status === 'ok' && health.budget.pct >= 100) {
    return `Model Provider ${name} has used up its budget${reason} — starting this agent may fail.`;
  }
  return `Model Provider ${name} is currently unreachable${reason} — starting this agent may fail.`;
}

// #2732 AC9: the orange early warning for a provider in the Warning state —
// shown alongside (never instead of) the red banner above, never blocking.
// Null for every other state, including unknown / no-budget providers.
export function providerBudgetWarningText(health, endpointName) {
  if (!health || health.status !== 'warning') return null;
  const name = endpointName ? `“${endpointName}”` : 'The bound Model Provider';
  const prefix = endpointName ? `Model Provider ${name}` : name;
  const b = health.budget;
  const used = b && b.status === 'ok' && Number.isFinite(b.pct)
    ? `${formatBudgetPct(b.pct)} of its ${b.source === 'team' ? 'team' : 'key'} budget`
    : 'most of its budget';
  return `${prefix} has used ${used} — work stops when it runs out. Ask an admin to raise the budget.`;
}

// "$1,840" / "$291.94" — whole amounts drop the cents (mirrors llm-budget.js
// formatAmount, which builds the server-side Health reason line).
export function formatBudgetAmount(n) {
  const v = Math.round(Number(n) * 100) / 100;
  const whole = Number.isInteger(v);
  return `$${v.toLocaleString('en-US', { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 })}`;
}

// Floored, so "90 %" is only ever shown at or past the 90 % line.
export function formatBudgetPct(pct) {
  return `${Math.floor(pct)} %`;
}

// The Model Providers Budget cell (#2732 AC3–AC5). Returns
//   { text, pct, source, title, tone }   for a provider with an effective budget
//   { text: '—', hint, title }           otherwise (hint only when the read failed)
// `tone` is a semantic key: 'ok' | 'warning' | 'error' (the percent colour). It
// follows the row's Health status rather than re-deriving the threshold here:
// the warn % is server configuration (AEE_LLM_HEALTH_BUDGET_WARN_PCT).
export function budgetCellModel(budget, healthStatus = null) {
  if (!budget || budget.status === 'none') {
    return { text: '—', hint: null, title: 'No budget on this provider (or it has no budget API)' };
  }
  if (budget.status === 'unavailable') {
    return {
      text: '—',
      hint: 'Budget unavailable',
      title: `Budget data could not be read${budget.reason ? ` (${budget.reason})` : ''} — health is not affected`,
    };
  }
  if (budget.status !== 'ok') return { text: '—', hint: null, title: '' };
  const pct = Number(budget.pct) || 0;
  const source = budget.source === 'team' ? 'team' : 'key';
  const reset = budget.resetAt ? formatResetDate(budget.resetAt) : null;
  const titleParts = [`${source === 'team' ? 'Team' : 'Key'} budget`];
  if (budget.budgetDuration) titleParts.push(`period ${budget.budgetDuration}`);
  if (reset) titleParts.push(`resets ${reset}`);
  return {
    text: `${formatBudgetAmount(budget.spend)} / ${formatBudgetAmount(budget.maxBudget)}`,
    pct: formatBudgetPct(pct),
    source,
    reset,
    title: titleParts.join(' · '),
    tone: pct >= 100 ? 'error' : healthStatus === 'warning' ? 'warning' : 'ok',
  };
}

// ISO → "2026-11-01" (date only; the proxy owns the reset, we only display it).
function formatResetDate(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return new Date(t).toISOString().slice(0, 10);
}

// The team-of-one → multi-user advisory (§14 / edge case E10). `notice` is the
// `personalProviderNotice` field from GET /api/agents/:id/model-options:
//   { level: 'warn'|'block', identity: 'api-key'|'oauth', providerName, ownerId }
// or null. Returns { text, tone } for a non-blocking badge, or null when there is
// nothing to say. `tone` is a semantic key the JSX maps to a colour: 'warn' (a
// fragile personal api-key lend — the common case) or 'error' (a personal
// subscription seat backing a multi-member team — a legacy state the
// membership-add guard now prevents, surfaced so an operator can fix it).
export function personalProviderNoticeText(notice) {
  if (!notice || (notice.level !== 'warn' && notice.level !== 'block')) return null;
  const name = notice.providerName ? `“${notice.providerName}”` : 'a member’s personal provider';
  if (notice.level === 'block') {
    return {
      tone: 'error',
      text: `This team runs on ${name}, a personal subscription seat — a single-user seat can’t back a multi-member team. Set a Team or Global provider as the team default.`,
    };
  }
  return {
    tone: 'warn',
    text: `This team runs on ${name}, a member’s personal provider (a lend). It resets if they leave the team — register a Team provider for a durable default.`,
  };
}
