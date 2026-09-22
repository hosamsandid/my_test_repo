// Pure view helpers for Model Provider health status (#1843), kept out of
// ModelRegistry.jsx / ChatPanel.jsx so they can be unit-tested without a
// DOM/React harness (mirrors maintenance-banner.js / llm-probe-state.js).
//
// The health object comes from the API merged onto each endpoint (and onto the
// bound endpoint in GET /api/agents/:id/model-options):
//   { status: 'ok' | 'error' | 'unknown', reason: string|null,
//     checkedAt: ISO|null, httpStatus: number|null }

// The Model Providers table cell (AC3). Returns { label, tone } where tone is a
// semantic key the JSX maps to a colour: 'ok' | 'error' | 'muted'. 'unknown'
// (never probed, or the probe can't run) is honest — never a guessed green (AC6).
export function healthCellModel(health) {
  const status = health && health.status;
  if (status === 'ok') return { label: 'OK', tone: 'ok' };
  if (status === 'error') return { label: 'Error', tone: 'error' };
  return { label: 'Unknown', tone: 'muted' };
}

// The tooltip / secondary detail for the cell: the failure reason on an error,
// the HTTP status on a success, or a "not yet checked" hint on unknown.
export function healthCellDetail(health) {
  const status = health && health.status;
  if (status === 'error') return health.reason || 'Unreachable';
  if (status === 'ok') return health.httpStatus ? `HTTP ${health.httpStatus}` : 'Reachable';
  return 'Not yet checked';
}

// The Agent-Chat non-blocking warning banner text (AC5). Returns a string only
// when the bound provider is currently red; null otherwise (unknown/ok never
// warn — "warn, do not block", and never warn off a merely-unknown status).
export function providerWarningText(health, endpointName) {
  if (!health || health.status !== 'error') return null;
  const name = endpointName ? `“${endpointName}”` : 'the bound Model Provider';
  const reason = health.reason ? ` (${health.reason})` : '';
  return `Model Provider ${name} is currently unreachable${reason} — starting this agent may fail.`;
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
