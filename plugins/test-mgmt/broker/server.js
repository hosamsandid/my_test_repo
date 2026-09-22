'use strict';

// ─── test-mgmt broker sidecar (plugin system Phase 5, #1521) ─────────────────
//
// Plugin #2's broker, built ON the Broker SDK (broker-sdk/) — the proof that a
// credential-backed broker is thin. It holds the ONE vendor credential
// (TESTMGMT_API_TOKEN) and exposes a small MCP tool surface for test-management;
// everything security-shaped comes from the SDK, so this file is mostly wiring:
//
//   • verifyScopeToken   — bearer `{pluginId, scopeId}`; granularity-agnostic.
//   • authorizeAction    — per-scope policy (create-case = flow-final agent
//                           only) via test-mgmt-broker/broker-policy.js.
//   • approvalHoldingPen — destructive ops (data-delete) are PARKED for a
//                           human's DM confirmation before they run.
//   • scopeFilter        — every artifact carries aee.plugin.owner=<scopeId>,
//                           so one team's test artifacts are invisible to
//                           another's (vendor-client stamps the label).
//   • auditWriter        — one JSONL line per call.
//   • maskSecretsOrDefault — vendor responses are redacted before return.
//   • healthEndpoint / teardownScopeEndpoint — the two REST routes the
//                           orchestrator calls on every broker.
//
// The vendor API + its credential are isolated in vendor-client.js. The scope
// registry (which scopeId is a team vs an agent, and — for flow-position rules
// — whether an agent is the flow-final one whose cross-checks passed) is pushed
// by the orchestrator to PUT /internal/scope-registry (§4.8: brokers get the
// scope list server-side); the broker fails closed on an unregistered scope.
//
// Least privilege: this process gets ONLY the vendor token + the signing
// secret. It never mounts the workspace or reads any other credential.

const http = require('http');

const {
  withUnexpectedErrors,
  verifyScopeToken,
  auditWriter,
  maskSecretsOrDefault,
  healthEndpoint,
  teardownScopeEndpoint,
  approvalHoldingPen,
} = require('../../../broker-sdk');
const vendor = require('./vendor-client');
const { decide, REQUIRES_APPROVAL } = require('./broker-policy');

const PORT = Number(process.env.TESTMGMT_BROKER_PORT) || 4005;
const SIGNING_SECRET = process.env.TESTMGMT_BROKER_SIGNING_SECRET || '';
const AUDIT_DIR = process.env.TESTMGMT_AUDIT_DIR || '/workspace/plugin-audit/test-mgmt';

const PLUGIN_ID = 'test-mgmt';

// The MCP SDK is only needed for the live tool surface; kept in a lazy require
// so the pure modules (vendor-client / broker-policy) unit-test with no deps.
let McpServer, StreamableHTTPServerTransport, ListToolsRequestSchema, CallToolRequestSchema;
try {
  ({ Server: McpServer } = require('@modelcontextprotocol/sdk/server/index.js'));
  ({ StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js'));
  ({ ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js'));
} catch { /* absent in unit-test host; the live sidecar image bundles it */ }

// Scope registry pushed by the orchestrator (fail-closed until populated).
const scopeRegistry = new Map();

// Approval holding pen (SDK) bound to this plugin's requiresApproval list.
const pen = approvalHoldingPen({ requiresApproval: REQUIRES_APPROVAL });

// Audit writer (SDK) — one JSONL line per call.
const audit = auditWriter(AUDIT_DIR, { retentionMs: 30 * 24 * 3600 * 1000 });

function writeAudit(scopeId, subcommand, outcome) {
  try {
    audit.write({ pluginId: PLUGIN_ID, scopeId, agentId: scopeId, subcommand, outcome });
  } catch { /* audit is best-effort, never gates a call */ }
}

// The tool surface. Descriptions/schemas are the vendor-neutral domain verbs;
// the CLI (aee-test) is the only place agents meet them.
const TOOLS = [
  { name: 'test_case_create', description: 'Create a test case (flow-final agent only).' },
  { name: 'test_run_submit', description: 'Submit a test run.' },
  { name: 'test_run_status', description: 'Status of a test run.' },
  { name: 'test_data_list', description: 'List test-data fixtures owned by the caller.' },
  { name: 'test_data_set', description: 'Create/update a test-data fixture.' },
  { name: 'test_data_delete', description: 'Delete a test-data fixture (destructive → approval).' },
];

// Run one tool call for a scope. Returns an MCP result object.
async function runTool(scopeId, name, args) {
  const verdict = decide(name, scopeId, scopeRegistry);
  if (!verdict.allow) {
    writeAudit(scopeId, verdict.subcommand, 'denied');
    return { content: [{ type: 'text', text: `refused: ${verdict.reason} [${verdict.code}]` }], isError: true };
  }

  if (verdict.needsApproval) {
    // Park the op instead of running it; the orchestrator asks a human over DM
    // and calls POST /internal/approvals/:id/resolve. v1 = DM-confirm gate.
    const id = `${scopeId}:${verdict.subcommand}:${args && args.key ? args.key : ''}`;
    pen.park({ id, subcommand: verdict.subcommand, scopeId, name, args });
    writeAudit(scopeId, verdict.subcommand, 'parked');
    return { content: [{ type: 'text', text: JSON.stringify({ status: 'pending-approval', approvalId: id }) }] };
  }

  return execVendor(scopeId, verdict.subcommand, name, args);
}

async function execVendor(scopeId, subcommand, name, args) {
  try {
    const body = await vendor.call(name, args || {}, scopeId, {
      baseUrl: process.env.TESTMGMT_API_URL,
      token: process.env.TESTMGMT_API_TOKEN,
    });
    // Redact the vendor credential from anything echoed back, per §4.9.
    // (raw, fallback, secrets) — the token belongs in the third argument. As
    // the second it became the fallback, so an empty body would have returned
    // the API token to the caller, and nothing was masked either.
    const masked = maskSecretsOrDefault(
      JSON.stringify(body), '(no body)', [process.env.TESTMGMT_API_TOKEN],
    );
    writeAudit(scopeId, subcommand, 'ok');
    return { content: [{ type: 'text', text: masked }] };
  } catch (err) {
    writeAudit(scopeId, subcommand, 'error');
    return { content: [{ type: 'text', text: `Error: ${(err && err.message) || err}` }], isError: true };
  }
}

function scopeFromAuth(req) {
  const v = verifyScopeToken(req, SIGNING_SECRET);
  return v && v.pluginId === PLUGIN_ID ? v.scopeId : null;
}

// Reap a scope's vendor artifacts on teardown (best-effort). The SDK guarantees
// this runs while the token is still valid, before the orchestrator invalidates
// it (#1287 teardown ordering).
async function teardownScope(scopeId) {
  try {
    const listed = await vendor.call('test_data_list', {}, scopeId, {});
    return { reaped: Array.isArray(listed && listed.items) ? listed.items.length : 0 };
  } catch (err) {
    return { reaped: 0, error: (err && err.message) || String(err) };
  }
}

const handleHealth = healthEndpoint(async () => ({ vendor: !!process.env.TESTMGMT_API_URL }));
const handleTeardown = teardownScopeEndpoint((scopeId) => teardownScope(scopeId), { secret: SIGNING_SECRET });

function buildMcpServer(scopeId) {
  const server = new McpServer({ name: PLUGIN_ID, version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map(({ name, description }) => ({
      name, description, inputSchema: { type: 'object', additionalProperties: true },
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params || {};
    return runTool(scopeId, name, args || {});
  });
  return server;
}

async function handleRequest(req, res) {
  if (req.method === 'GET' && req.url === '/healthz') return void (await handleHealth(req, res));
  if (req.method === 'POST' && req.url === '/internal/teardown-scope') return void (await handleTeardown(req, res));

  // The orchestrator pushes the scope registry (§4.8), bearer-authed with the
  // signing secret so nothing else can rewrite the authorization facts.
  if (req.method === 'PUT' && req.url === '/internal/scope-registry') {
    const v = verifyScopeToken(req, SIGNING_SECRET);
    if (!v) { res.writeHead(401); return void res.end('unauthorized'); }
    const body = await readBody(req);
    try {
      const parsed = JSON.parse(body || '{}');
      scopeRegistry.clear();
      for (const [scopeId, ctx] of Object.entries(parsed.scopes || {})) scopeRegistry.set(scopeId, ctx);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return void res.end(JSON.stringify({ ok: true, scopes: scopeRegistry.size }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return void res.end(JSON.stringify({ ok: false, error: (err && err.message) || String(err) }));
    }
  }

  // Resolve a parked destructive op after a human's DM confirmation.
  if (req.method === 'POST' && req.url && req.url.startsWith('/internal/approvals/')) {
    const v = verifyScopeToken(req, SIGNING_SECRET);
    if (!v) { res.writeHead(401); return void res.end('unauthorized'); }
    const id = decodeURIComponent(req.url.slice('/internal/approvals/'.length).split('/')[0]);
    const body = await readBody(req);
    const approved = (() => { try { return JSON.parse(body || '{}').approved === true; } catch { return false; } })();
    const op = pen.resolve(id, approved);
    if (!op) { res.writeHead(200, { 'Content-Type': 'application/json' }); return void res.end(JSON.stringify({ ok: true, ran: false })); }
    const result = await execVendor(op.scopeId, op.subcommand, op.name, op.args);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return void res.end(JSON.stringify({ ok: true, ran: true, isError: !!result.isError }));
  }

  if (req.url !== '/mcp') { res.writeHead(404, { 'Content-Type': 'application/json' }); return void res.end(JSON.stringify({ error: 'not found' })); }
  if (!McpServer) { res.writeHead(501, { 'Content-Type': 'application/json' }); return void res.end(JSON.stringify({ error: 'mcp sdk not installed' })); }

  const scopeId = scopeFromAuth(req);
  if (!scopeId) { res.writeHead(401, { 'Content-Type': 'application/json' }); return void res.end(JSON.stringify({ error: 'unauthorized' })); }

  const mcpServer = buildMcpServer(scopeId);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => { transport.close(); mcpServer.close(); });
  await mcpServer.connect(transport);
  await transport.handleRequest(req, res);
}

function readBody(req) {
  return new Promise((resolve) => {
    let s = '';
    req.on('data', (c) => { s += c; });
    req.on('end', () => resolve(s));
    req.on('error', () => resolve(s));
  });
}

const httpServer = http.createServer(withUnexpectedErrors('test-mgmt-broker', handleRequest));

if (require.main === module) {
  httpServer.listen(PORT, () => process.stdout.write(`[test-mgmt-broker] listening on :${PORT}\n`));
}

module.exports = { runTool, execVendor, teardownScope, scopeFromAuth, scopeRegistry, TOOLS };
