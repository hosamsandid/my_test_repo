'use strict';

// ─── jira broker sidecar (plugin) — Phase 0 spike ───────────────────────────
//
// Built ON the Broker SDK (broker-sdk/), like every reference plugin broker.
// This file is wiring; every decision that is pure lives in a sibling module
// (jira-client.js, event-extract.js, watch-store.js, inbox-store.js, poller.js)
// and the shared primitives come from the SDK.
//
// PHASE 0 (docs/jira-plugin-plan.md §8) proves the JQL/changelog/dedup core
// against a real Jira Cloud sandbox with ZERO platform change, via Option A —
// the "content-free doorbell":
//
//   • The poll loop runs inside this sidecar. On a fresh status change it
//     appends the event to the per-scope inbox and rings a doorbell: an HTTP
//     POST to the agent's existing `http` webhook trigger
//     (`POST /hooks/:agentId/:hookId`, `X-Hook-Secret`), which the operator
//     wires by hand and registers here with `PUT /internal/spike-config`.
//   • The wake carries no Jira payload. The agent PULLS it: `aee-jira inbox`
//     drains the per-scope queue the broker holds.
//
// Credentials in Phase 0 come from the sidecar env (JIRA_SITE_URL / JIRA_EMAIL
// / JIRA_API_TOKEN, or a gitignored broker/.env.local) — one install-wide
// credential, exactly as test-mgmt-broker reads TESTMGMT_API_TOKEN today. Phase
// 1 replaces this with the real generic per-scope credential store (§5); Phase
// 2 replaces the doorbell with a generic `plugin-event` wake (§4B).

const http = require('http');
const path = require('path');

const {
  verifyScopeToken,
  mint,
  auditWriter,
  healthEndpoint,
  teardownScopeEndpoint,
  brokerConfig,
} = require('../../../broker-sdk');
const { WatchStore } = require('./watch-store');
const { InboxStore } = require('./inbox-store');
const { JiraPoller } = require('./poller');

const PLUGIN_ID = 'jira';

const cfg = brokerConfig({
  fallbacks: {
    port: ['JIRA_BROKER_PORT'],
    signingSecret: ['JIRA_BROKER_SIGNING_SECRET'],
    stateDir: ['JIRA_STATE_DIR'],
    auditDir: ['JIRA_AUDIT_DIR'],
  },
});
const PORT = cfg.port || 4009;
const SIGNING_SECRET = cfg.signingSecret;
const STATE_DIR = cfg.stateDir || '/state/jira';
const AUDIT_DIR = cfg.auditDir || '/audit';

const watchStore = new WatchStore({ stateDir: STATE_DIR });
const inboxStore = new InboxStore({ stateDir: STATE_DIR, ttlSeconds: cfg.quota.ttlSeconds, maxObjects: cfg.quota.maxObjects });
const audit = auditWriter(AUDIT_DIR, { retentionMs: 30 * 24 * 3600 * 1000 });

// Per-scope Jira credential, pushed by the orchestrator (Phase 1, Jira plan §5):
// `PUT /internal/scope-credentials` with `{ scopes: { <scopeId>: { "site-url",
// "email", "api-token" } } }`. In-memory only (the pattern github-issues uses);
// the orchestrator re-pushes on boot / grant change / credential save. The token
// never touches disk here and never reaches an agent.
const scopeCredentials = new Map(); // scopeId -> { site-url, email, api-token }

function writeAudit(scopeId, actor, subcommand, outcome, detail) {
  try {
    audit.write({ ts: new Date().toISOString(), pluginId: PLUGIN_ID, scopeId, agentId: actor || scopeId, subcommand, outcome, detail });
  } catch { /* best-effort */ }
}

// Resolve a scope's Jira credential from the orchestrator-pushed per-scope map.
// Returns null when the scope has no entry or an incomplete one (the poller
// then logs "no usable credential" and skips it — a granted-but-unconfigured
// team is a normal transient state, not an error).
function resolveCredential(scopeId) {
  const v = scopeCredentials.get(String(scopeId));
  if (!v) return null;
  const siteUrl = (v['site-url'] || '').trim();
  const email = (v.email || '').trim();
  const apiToken = (v['api-token'] || '').trim();
  if (!siteUrl || !email || !apiToken) return null;
  return { siteUrl, email, apiToken };
}

// ── delivery: POST /internal/plugin-event (Jira plan §4B) ───────────────────
// The broker→orchestrator wake channel. A minted scope token carries
// {pluginId: 'jira', scopeId}; the orchestrator verifies it, resolves the scope
// to its team, and fans out to every granted agent with a matching
// `plugin-event` trigger. No doorbell, no `http` trigger to hand-wire — the
// Phase-0 doorbell config is left in place only for the spike (`spike-config`).
function orchestratorUrl() {
  return (process.env.AEE_ORCHESTRATOR_URL || 'http://orchestrator:4002').replace(/\/+$/, '');
}

function summariseEvents(kind, events) {
  if (kind === 'digest') return `${events.length} status changes`;
  const e = events[0] || {};
  const issue = e.issueKey || e.projectKey || '';
  return `${issue}${e.fromStatus && e.toStatus ? `: ${e.fromStatus} → ${e.toStatus}` : ''}`.trim() || 'status change';
}

async function deliver({ scopeId, kind, events }) {
  if (kind === 'throttle-warning') {
    // Nothing to wake an agent about — the throttle already suppressed the
    // events. Record it and move on (the doorbell path posted these too).
    writeAudit(scopeId, scopeId, 'wake', 'throttled', kind);
    return;
  }
  const token = mint(PLUGIN_ID, scopeId, SIGNING_SECRET);
  const first = events[0] || {};
  const body = {
    event: first.event || 'status_changed',
    summary: summariseEvents(kind, events),
    eventId: kind === 'digest' ? null : (first.id || null),
    payload: kind === 'digest'
      ? { kind: 'digest', count: events.length, events: events.slice(0, 20) }
      : first,
  };
  try {
    const res = await fetch(`${orchestratorUrl()}/internal/plugin-event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    const out = await res.json().catch(() => ({}));
    writeAudit(scopeId, scopeId, 'wake', res.ok ? 'ok' : `http-${res.status}`, `${kind}:${out.delivered ?? '?'}`);
    process.stdout.write(
      `[jira-broker] plugin-event ${res.ok ? `ok (${out.delivered ?? '?'} agent(s))` : `HTTP ${res.status}`} `
      + `→ ${scopeId} (${kind}, ${events.length} event(s))\n`,
    );
  } catch (err) {
    writeAudit(scopeId, scopeId, 'wake', 'error', err.message);
    process.stdout.write(`[jira-broker] plugin-event FAILED → ${scopeId}: ${err.message}\n`);
  }
}

const poller = new JiraPoller({
  watchStore,
  inboxStore,
  resolveCredential,
  deliver,
  intervalMs: Number(process.env.JIRA_POLL_INTERVAL_MS) || undefined,
  baseWindowMinutes: Number(process.env.JIRA_POLL_WINDOW_MINUTES) || undefined,
  throttleStatePath: path.join(STATE_DIR, 'throttle-state.json'),
  log: (m) => process.stdout.write(`${m}\n`),
});

// ── small http helpers ─────────────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve) => {
    let s = '';
    req.on('data', (c) => { s += c; });
    req.on('end', () => resolve(s));
    req.on('error', () => resolve(s));
  });
}
function parseJson(s) { try { return JSON.parse(s || '{}'); } catch { return {}; } }
function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}
function query(req) {
  return new URLSearchParams((req.url || '').split('?')[1] || '');
}

// ── the agent CLI surface (scope-token authed) ─────────────────────────────
async function handleCli(req, res, cliPath) {
  const v = verifyScopeToken(req, SIGNING_SECRET);
  if (!v || v.pluginId !== PLUGIN_ID) return sendJson(res, 401, { error: 'unauthorized' });
  const scopeId = v.scopeId;
  const params = query(req);

  if (cliPath === '/whoami' && req.method === 'GET') {
    return sendJson(res, 200, { scopeId, plugin: PLUGIN_ID });
  }

  if (cliPath === '/inbox' && req.method === 'GET') {
    const consume = params.get('consume') === '1';
    const entries = consume ? inboxStore.consume(scopeId) : inboxStore.list(scopeId);
    writeAudit(scopeId, scopeId, 'inbox', 'ok', consume ? `consumed:${entries.length}` : `peeked:${entries.length}`);
    return sendJson(res, 200, { entries, consumed: consume });
  }

  return sendJson(res, 404, { error: 'not found' });
}

// ── Phase-0 spike seam: set a scope's watch + doorbell by hand ──────────────
// Bearer-authed with a minted scope token (the same auth the orchestrator's
// pushes use). Phase 4 replaces this with the /admin UI route + /api/mutate.
async function handleSpikeConfig(req, res) {
  const v = verifyScopeToken(req, SIGNING_SECRET);
  if (!v || v.pluginId !== PLUGIN_ID) return sendJson(res, 401, { error: 'unauthorized' });
  const body = parseJson(await readBody(req));
  const conf = watchStore.setConfig(v.scopeId, {
    watches: body.watches,
    doorbell: body.doorbell,
    setBy: body.setBy || 'spike',
  });
  writeAudit(v.scopeId, body.setBy || 'spike', 'spike-config', 'ok', `watches:${conf.watches.length}`);
  return sendJson(res, 200, { ok: true, scopeId: v.scopeId, watches: conf.watches, doorbell: conf.doorbell });
}

const handleHealth = healthEndpoint(async () => ({
  scopes: watchStore.listScopes().length,
  scopesWithCredential: [...scopeCredentials.keys()].filter((sid) => !!resolveCredential(sid)).length,
}));
const handleTeardown = teardownScopeEndpoint((scopeId) => {
  scopeCredentials.delete(String(scopeId));
  return { reaped: watchStore.teardown(scopeId) + inboxStore.teardown(scopeId) };
}, { secret: SIGNING_SECRET });

// PUT /internal/scope-credentials — the orchestrator's per-scope credential push
// (Jira plan §5). Bearer-authed with any valid jira scope token, like every
// other internal push. Replaces the whole map so a revoked team disappears.
async function handleScopeCredentials(req, res) {
  const v = verifyScopeToken(req, SIGNING_SECRET);
  if (!v || v.pluginId !== PLUGIN_ID) return sendJson(res, 401, { error: 'unauthorized' });
  const body = parseJson(await readBody(req));
  const scopes = body && body.scopes && typeof body.scopes === 'object' ? body.scopes : {};
  scopeCredentials.clear();
  for (const [scopeId, values] of Object.entries(scopes)) {
    if (values && typeof values === 'object') scopeCredentials.set(String(scopeId), values);
  }
  return sendJson(res, 200, {
    ok: true,
    scopes: scopeCredentials.size,
    usable: [...scopeCredentials.keys()].filter((sid) => !!resolveCredential(sid)).length,
  });
}

async function handleRequest(req, res) {
  const urlPath = (req.url || '').split('?')[0];

  if (req.method === 'GET' && urlPath === '/healthz') return void (await handleHealth(req, res));
  if (req.method === 'POST' && urlPath === '/internal/teardown-scope') return void (await handleTeardown(req, res));
  if (req.method === 'PUT' && urlPath === '/internal/scope-credentials') return void (await handleScopeCredentials(req, res));
  if (req.method === 'PUT' && urlPath === '/internal/spike-config') return void (await handleSpikeConfig(req, res));

  // A read-only status endpoint for the spike operator: what the poller sees.
  if (req.method === 'GET' && urlPath === '/internal/status') {
    const v = verifyScopeToken(req, SIGNING_SECRET);
    if (!v || v.pluginId !== PLUGIN_ID) return void sendJson(res, 401, { error: 'unauthorized' });
    const conf = watchStore.loadConfig(v.scopeId);
    return void sendJson(res, 200, {
      scopeId: v.scopeId,
      watches: conf.watches,
      doorbell: conf.doorbell ? { url: conf.doorbell.url, hasSecret: !!conf.doorbell.secret } : null,
      cursors: conf.cursors,
      inbox: inboxStore.count(v.scopeId),
      setBy: conf.setBy,
      setAt: conf.setAt,
      credential: resolveCredential(v.scopeId)
        ? { configured: true, site: resolveCredential(v.scopeId).siteUrl }
        : { configured: false },
    });
  }

  if (urlPath === '/cli' || urlPath.startsWith('/cli/')) {
    const cliPath = urlPath === '/cli' ? '/' : urlPath.slice('/cli'.length) || '/';
    return void (await handleCli(req, res, cliPath));
  }

  return void sendJson(res, 404, { error: 'not found' });
}

const httpServer = http.createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
    try { res.end(JSON.stringify({ error: (err && err.message) || String(err) })); } catch { /* ignore */ }
  });
});

if (require.main === module) {
  httpServer.listen(PORT, () => process.stdout.write(`[jira-broker] listening on :${PORT}\n`));
  poller.start();
}

module.exports = { handleRequest, httpServer, watchStore, inboxStore, poller, resolveCredential, deliver, scopeCredentials, PLUGIN_ID, SIGNING_SECRET };
