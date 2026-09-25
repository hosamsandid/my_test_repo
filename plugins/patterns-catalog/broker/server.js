'use strict';

// ─── patterns-catalog broker sidecar (UI-only, privilege-less plugin) ────────
//
// The simplest possible broker built ON the Broker SDK (broker-sdk/). It holds
// NO credential and reaches nothing outside itself (manifest `capabilities: []`,
// `credentials: []`). Its only job is to serve a set of static catalog pages
// into the console, which proxies them into an iframe through the §4.8 UI-
// extension stack.
//
// Unlike netzplan there is no per-team document and no agent write path, so this
// broker has no `/mcp` tool surface and no state store: the `aee-patterns` CLI
// is fully self-contained. What remains is the shared broker contract:
//
//   • healthEndpoint / teardownScopeEndpoint — the two REST routes the
//     orchestrator calls on every broker. Teardown is a no-op (nothing is
//     persisted per scope) but is wired for contract completeness.
//   • verifyViewerHeaders (copied §4.8 scheme, viewer-headers.js) — the signed
//     console-user identity + role on the UI path. The broker re-enforces the
//     ui.routes minRole (team-member) a second time, after the console proxy,
//     so a request reaching the sidecar directly cannot bypass access control.
//
// Static assets live under ui/ and are served with a path-containment guard so
// nothing outside ui/ can ever be read.

const http = require('http');
const fs = require('fs');
const path = require('path');

const {
  withUnexpectedErrors,
  healthEndpoint,
  teardownScopeEndpoint,
  brokerConfig,
} = require('../../../broker-sdk');
const { verifyViewerHeaders, requiredRoleForPath, roleAllows } = require('./viewer-headers');

const PLUGIN_ID = 'patterns-catalog';
const UI_DIR = path.join(__dirname, 'ui');

// The orchestrator's env contract (§4.8 / broker-config.js). `fallbacks` lets an
// operator run the broker standalone with PATTERNS_CATALOG_* names while
// developing. No stateDir is needed (nothing is persisted).
const cfg = brokerConfig({
  fallbacks: {
    port: ['PATTERNS_CATALOG_BROKER_PORT'],
    signingSecret: ['PATTERNS_CATALOG_BROKER_SIGNING_SECRET'],
  },
});
const PORT = cfg.port || 4007;
const SIGNING_SECRET = cfg.signingSecret;

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function contentType(p) {
  if (p.endsWith('.html')) return 'text/html; charset=utf-8';
  if (p.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (p.endsWith('.css')) return 'text/css; charset=utf-8';
  if (p.endsWith('.svg')) return 'image/svg+xml';
  if (p.endsWith('.png')) return 'image/png';
  if (p.endsWith('.json')) return 'application/json; charset=utf-8';
  return 'application/octet-stream';
}

// The served catalog UI. Every request carries signed viewer headers (stamped by
// the console proxy); the broker verifies them and re-enforces the minRole.
function handleUi(req, res, uiPath) {
  const viewer = verifyViewerHeaders(req, SIGNING_SECRET);
  if (!viewer) return sendJson(res, 401, { error: 'unsigned viewer' });
  const need = requiredRoleForPath(uiPath);
  if (!roleAllows(viewer.role, need)) {
    return sendJson(res, 403, { error: `route ${uiPath} requires ${need}; viewer is ${viewer.role}` });
  }

  // static assets: / → index.html, else a file under ui/
  const rel = uiPath === '/' || uiPath === '' ? 'index.html' : uiPath.replace(/^\/+/, '');
  const abs = path.join(UI_DIR, rel);
  // containment: never serve outside ui/
  if (abs !== UI_DIR && !abs.startsWith(UI_DIR + path.sep)) {
    return sendJson(res, 404, { error: 'not found' });
  }
  fs.readFile(abs, (err, data) => {
    if (err) return sendJson(res, 404, { error: 'not found' });
    res.writeHead(200, { 'Content-Type': contentType(abs) });
    res.end(data);
  });
}

const handleHealth = healthEndpoint(async () => ({ uiDir: fs.existsSync(UI_DIR) }));
// Nothing is persisted per scope, so teardown reaps nothing — but the route is
// wired so the orchestrator's uniform teardown call succeeds on this broker too.
const handleTeardown = teardownScopeEndpoint(() => ({ reaped: 0 }), { secret: SIGNING_SECRET });

async function handleRequest(req, res) {
  const urlPath = (req.url || '').split('?')[0];

  if (req.method === 'GET' && urlPath === '/healthz') return void (await handleHealth(req, res));
  if (req.method === 'POST' && urlPath === '/internal/teardown-scope') return void (await handleTeardown(req, res));

  // The catalog UI (viewer-header authed).
  if (urlPath === '/ui' || urlPath.startsWith('/ui/')) {
    const uiPath = urlPath === '/ui' ? '/' : urlPath.slice('/ui'.length) || '/';
    return void handleUi(req, res, uiPath);
  }

  return void sendJson(res, 404, { error: 'not found' });
}

const httpServer = http.createServer(withUnexpectedErrors('patterns-catalog-broker', handleRequest));

if (require.main === module) {
  httpServer.listen(PORT, () => process.stdout.write(`[patterns-catalog-broker] listening on :${PORT}\n`));
}

module.exports = { handleRequest, PLUGIN_ID };
