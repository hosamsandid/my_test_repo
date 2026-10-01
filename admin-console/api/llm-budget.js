'use strict';

// Model Provider budget lookup (#2732) — pure logic, kept free of fs/Express so
// it unit-tests directly (the admin-api suite has no HTTP harness). The one I/O
// dependency, an HTTP GET, is injected (api.js passes httpGetJson).
//
// LiteLLM exposes a key's spending budget to the key itself, no admin key
// needed, through two FREE management reads (never a billable request):
//   GET /key/info                    → { info: { max_budget, spend, budget_duration, budget_reset_at, team_id } }
//   GET /team/info?team_id=<team_id> → { team_info: { max_budget, spend, budget_reset_at, … } }
// Both budgets are enforced by the proxy, so the tighter one (the higher usage
// %) is the one that will stop work first — that is the "effective" budget.
// Providers that are not LiteLLM (subscription OAuth, Anthropic direct, Azure AI
// Foundry, other proxies) have no such API: their lookup resolves to 'none'.
//
// A lookup result is one of:
//   { status: 'ok', budget: { source: 'key'|'team', spend, maxBudget, budgetDuration, resetAt } }
//   { status: 'none' }                       — no budget API / no budget set
//   { status: 'unavailable', reason }        — the read failed (timeout, 4xx/5xx)
// None of these ever turns a provider's health to Error on its own (AC4/AC5);
// only the usage % of an 'ok' budget feeds the health view (llm-health.js).

// Health turns orange (Warning) at this usage % (AC6/AC7).
const DEFAULT_WARN_PCT = 90;
// The budget reads are cheap management calls; give up sooner than the 8s probe
// so an unresponsive proxy doesn't double the poller's worst-case pass time.
const BUDGET_TIMEOUT_MS = 5000;

function coercePct(value, fallback = DEFAULT_WARN_PCT) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// LiteLLM's management routes live at the proxy root, not under /v1. Strip
// whatever API-path suffix the provider's Base URL carries.
function budgetRootUrl(baseUrl) {
  let s = String(baseUrl || '').trim().replace(/\/+$/, '');
  s = s.replace(/\/models$/, '').replace(/\/v\d+$/, '').replace(/\/+$/, '');
  return s;
}

function buildKeyInfoUrl(baseUrl) {
  return `${budgetRootUrl(baseUrl)}/key/info`;
}

function buildTeamInfoUrl(baseUrl, teamId) {
  return `${budgetRootUrl(baseUrl)}/team/info?team_id=${encodeURIComponent(teamId)}`;
}

function finiteOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// One budget from a LiteLLM info object. Only a non-null, positive max_budget
// counts (AC2) — anything else is "no budget".
function readBudget(raw, source) {
  if (!raw || typeof raw !== 'object') return null;
  const maxBudget = finiteOrNull(raw.max_budget);
  if (maxBudget === null || maxBudget <= 0) return null;
  const spend = finiteOrNull(raw.spend);
  return {
    source,
    spend: spend === null ? 0 : spend,
    maxBudget,
    budgetDuration: typeof raw.budget_duration === 'string' && raw.budget_duration ? raw.budget_duration : null,
    resetAt: typeof raw.budget_reset_at === 'string' && raw.budget_reset_at ? raw.budget_reset_at : null,
  };
}

// GET /key/info body → { budget, teamId }, or null when the body is not
// LiteLLM-shaped (some other service answered 200 on that path).
function parseKeyInfo(body) {
  const info = body && typeof body === 'object' ? body.info : null;
  if (!info || typeof info !== 'object') return null;
  const teamId = typeof info.team_id === 'string' && info.team_id ? info.team_id : null;
  return { budget: readBudget(info, 'key'), teamId };
}

function parseTeamInfo(body) {
  if (!body || typeof body !== 'object') return null;
  return readBudget(body.team_info, 'team');
}

function usagePct(budget) {
  if (!budget || !(budget.maxBudget > 0)) return null;
  return (budget.spend / budget.maxBudget) * 100;
}

// AC2 + edge cases: whichever of key/team exists; if both, the higher usage %
// wins and a tie goes to the key budget.
function effectiveBudget(keyBudget, teamBudget) {
  if (keyBudget && teamBudget) return usagePct(teamBudget) > usagePct(keyBudget) ? teamBudget : keyBudget;
  return keyBudget || teamBudget || null;
}

function isOk(result) {
  return Boolean(result) && !result.error && result.status >= 200 && result.status < 300;
}

// A route that doesn't exist on this proxy means "no budget API", not a failure.
function isRouteMissing(result) {
  return Boolean(result) && !result.error && (result.status === 404 || result.status === 405);
}

function failureReason(result) {
  if (!result) return 'request failed';
  if (result.error) return String(result.error);
  return result.status ? `HTTP ${result.status}` : 'request failed';
}

// Read the key (and, if it belongs to a team, the team) budget. `get` is
// (url, headers, timeoutMs) → Promise<{ status, body, error }> and never throws.
// The token travels only in the Authorization header; it is never part of the
// result, a reason string or a URL.
async function lookupBudget({ baseUrl, token, authType }, get) {
  // Subscription OAuth talks straight to api.anthropic.com — no budget API.
  if (authType === 'oauth-token' || !baseUrl || !token) return { status: 'none' };
  const headers = { Authorization: `Bearer ${token}` };
  const keyRes = await get(buildKeyInfoUrl(baseUrl), headers, BUDGET_TIMEOUT_MS);
  if (isRouteMissing(keyRes)) return { status: 'none' };
  if (!isOk(keyRes)) return { status: 'unavailable', reason: failureReason(keyRes) };
  const key = parseKeyInfo(keyRes.body);
  if (!key) return { status: 'none' };

  let teamBudget = null;
  let teamFailure = null;
  if (key.teamId) {
    const teamRes = await get(buildTeamInfoUrl(baseUrl, key.teamId), headers, BUDGET_TIMEOUT_MS);
    if (isOk(teamRes)) teamBudget = parseTeamInfo(teamRes.body);
    else if (!isRouteMissing(teamRes)) teamFailure = failureReason(teamRes);
  }
  const budget = effectiveBudget(key.budget, teamBudget);
  if (budget) return { status: 'ok', budget };
  if (teamFailure) return { status: 'unavailable', reason: teamFailure };
  return { status: 'none' };
}

// "$1,840" / "$291.94" — whole amounts drop the cents. LiteLLM reports spend in
// the proxy's configured currency units; it is conventionally USD.
function formatAmount(n) {
  const v = Math.round(Number(n) * 100) / 100;
  const whole = Number.isInteger(v);
  return `$${v.toLocaleString('en-US', { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 })}`;
}

// Floor, so a provider shown as "90 %" really is at or past the 90 % line.
function formatPct(pct) {
  return `${Math.floor(pct)} %`;
}

// The health detail line for a budget-driven Warning/Error (AC6):
//   "Budget 92 % used ($1,840 / $2,000, team)"
function budgetReason(budget) {
  const pct = usagePct(budget);
  return `Budget ${formatPct(pct)} used (${formatAmount(budget.spend)} / ${formatAmount(budget.maxBudget)}, ${budget.source})`;
}

// The client-facing budget view (AC3–AC5). Persisted lookup → what the Budget
// column renders. `null` when the provider was never looked up.
function budgetView(lookup) {
  if (!lookup || !lookup.status) return null;
  if (lookup.status === 'ok' && lookup.budget) {
    const b = lookup.budget;
    return {
      status: 'ok',
      source: b.source,
      spend: b.spend,
      maxBudget: b.maxBudget,
      pct: usagePct(b),
      budgetDuration: b.budgetDuration || null,
      resetAt: b.resetAt || null,
    };
  }
  if (lookup.status === 'unavailable') return { status: 'unavailable', reason: lookup.reason || 'request failed' };
  return { status: 'none' };
}

module.exports = {
  DEFAULT_WARN_PCT,
  BUDGET_TIMEOUT_MS,
  coercePct,
  budgetRootUrl,
  buildKeyInfoUrl,
  buildTeamInfoUrl,
  readBudget,
  parseKeyInfo,
  parseTeamInfo,
  usagePct,
  effectiveBudget,
  lookupBudget,
  formatAmount,
  formatPct,
  budgetReason,
  budgetView,
};
