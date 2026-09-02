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
