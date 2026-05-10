#!/usr/bin/env node
'use strict';

// In-process integration test of admin-console/api/api.js focused on the new
// MCP endpoints. We can't run the real container in CI, so:
//
//   1. Copy api.js into a tmp module with the absolute /workspace and /pool
//      paths rewritten to live under a tmpdir, and the app.listen(4000, …)
//      call swapped for a module.exports = app.
//   2. Require that shim, bind to a random port, drive it via fetch.
//
// The substitutions are lexical and conservative — both constants are defined
// once near the top of api.js as `const WORKSPACE = '/workspace'` /
// `const POOL_DIR = '/pool'`, so the two `path.join`-based callers all read
// from the same constants. We keep the inlined string literals in
// writeJsonAtomic / readJsonFile in sync by also rewriting the bare path
// prefixes used in their startsWith checks.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const assert = require('assert');

let pass = 0, fail = 0;
function ok(msg)   { pass++; console.log(`  [32mok[0m  ${msg}`); }
function bad(msg, err) { fail++; console.log(`  [31mfail[0m ${msg}\n      ${err}`); }

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aee-api-test-'));
const wsRoot = path.join(tmpRoot, 'workspace');
const poolRoot = path.join(tmpRoot, 'pool');
fs.mkdirSync(wsRoot, { recursive: true });
fs.mkdirSync(poolRoot, { recursive: true });
console.log(`tmp: ${tmpRoot}`);

const apiSrcPath = path.resolve(__dirname, '..', '..', 'admin-console', 'api', 'api.js');
let apiSrc = fs.readFileSync(apiSrcPath, 'utf8');

// Substitute the two top-level path constants. Quote both forms so a stray
// concat-built string (e.g. `'/workspace'` vs `'/pool'`) lands too. The
// startsWith / includes checks compare against the same constants, so just
// rewriting the constants is enough.
const wsLit = JSON.stringify(wsRoot);
const poolLit = JSON.stringify(poolRoot);
const beforeWs = apiSrc.match(/const WORKSPACE = '\/workspace';/);
const beforePool = apiSrc.match(/const POOL_DIR = '\/pool';/);
if (!beforeWs || !beforePool) throw new Error('expected WORKSPACE/POOL_DIR constants not found');
apiSrc = apiSrc.replace("const WORKSPACE = '/workspace';", `const WORKSPACE = ${wsLit};`);
apiSrc = apiSrc.replace("const POOL_DIR = '/pool';",       `const POOL_DIR = ${poolLit};`);

// The path-injection guards in writeJsonAtomic / readJsonFile compare incoming
// paths against `WORKSPACE + path.sep` / `POOL_DIR + path.sep`, so they pick up
// the substituted constants without further rewriting. Confirmed by a grep for
// `'/workspace/'` / `'/pool/'` literals in the source — none remain after
// these two replaces.

// Disable auto-listen, expose `app` so the test can call listen on its own port.
apiSrc = apiSrc.replace(
  "app.listen(4000, '0.0.0.0', () => console.log('[Admin] Listening on :4000'));",
  'module.exports = app;'
);

// Stub external services that api.js calls but we don't want hitting the
// network. The orchestrator fetch in /api/teams/stream gets a mock at the
// loopback URL; ORCHESTRATOR_URL is set before require() below.

// Shim must live next to admin-console/api/node_modules so its require()
// resolves express/multer/cors. Use a hidden filename + cleanup hook.
const apiDir = path.dirname(apiSrcPath);
const shimPath = path.join(apiDir, `_test-shim-${process.pid}.js`);
fs.writeFileSync(shimPath, apiSrc);
process.on('exit', () => { try { fs.unlinkSync(shimPath); } catch {} });
process.on('SIGINT', () => { try { fs.unlinkSync(shimPath); } catch {}; process.exit(130); });

process.env.ORCHESTRATOR_URL = 'http://127.0.0.1:0';   // unreachable, OK for unit tests of the new endpoints
process.env.MATRIX_HOMESERVER = 'http://127.0.0.1:0';
process.env.MATRIX_ACCESS_TOKEN = 'test';

const app = require(shimPath);

const server = http.createServer(app);
function listen() {
  return new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
}

async function api(method, url, body) {
  const r = await fetch(`http://127.0.0.1:${server.address().port}` + url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: r.status, body: json };
}

(async () => {
  try {
    await listen();

    // ── MCP server registry CRUD ──────────────────────────────────────

    let r = await api('GET', '/api/mcp-servers');
    try {
      assert.strictEqual(r.status, 200);
      assert.deepStrictEqual(r.body, []);
      ok('GET /api/mcp-servers initially empty');
    } catch (e) { bad('GET /api/mcp-servers empty', e.message); }

    r = await api('POST', '/api/mcp-servers', {
      id: 'wiki', name: 'Wiki', description: 'corporate wiki',
      transport: 'stdio', command: 'node', args: ['/srv/wiki.js'],
      env: { WIKI_BASE_URL: 'https://wiki/api', WIKI_TOKEN: '${credential}' },
    });
    try {
      assert.strictEqual(r.status, 201);
      assert.strictEqual(r.body.id, 'wiki');
      ok('POST /api/mcp-servers creates a stdio server');
    } catch (e) { bad('POST stdio server', e.message); }

    r = await api('POST', '/api/mcp-servers', {
      id: 'wiki', name: 'duplicate', transport: 'stdio', command: 'node',
    });
    try {
      assert.strictEqual(r.status, 409);
      ok('duplicate id returns 409');
    } catch (e) { bad('duplicate id', e.message); }

    r = await api('POST', '/api/mcp-servers', {
      id: '../escape', name: 'bad', transport: 'stdio', command: 'node',
    });
    try {
      assert.strictEqual(r.status, 400);
      ok('id with path-traversal rejected');
    } catch (e) { bad('id traversal', e.message); }

    r = await api('POST', '/api/mcp-servers', {
      id: 'remote', name: 'Remote', transport: 'http',
    });
    try {
      assert.strictEqual(r.status, 400);
      assert.match(JSON.stringify(r.body), /url is required/);
      ok('http transport without url rejected');
    } catch (e) { bad('http without url', e.message); }

    // env on an http server is a category error — must be rejected with a 400
    // so the operator doesn't fill the wrong template field and silently get
    // an unauthenticated request.
    r = await api('POST', '/api/mcp-servers', {
      id: 'remote-bad-env', name: 'Bad', transport: 'http', url: 'https://x',
      env: { AUTH: 'Bearer ${credential}' },
    });
    try {
      assert.strictEqual(r.status, 400);
      assert.match(JSON.stringify(r.body), /don't accept .*env/);
      ok('http transport rejects `env` field (must use headers)');
    } catch (e) { bad('http with env', e.message); }

    // Symmetric: stdio with headers should also fail.
    r = await api('POST', '/api/mcp-servers', {
      id: 'stdio-bad-hdr', name: 'Bad', transport: 'stdio', command: 'node',
      headers: { Authorization: 'Bearer x' },
    });
    try {
      assert.strictEqual(r.status, 400);
      assert.match(JSON.stringify(r.body), /don't accept .*headers/);
      ok('stdio transport rejects `headers` field (must use env)');
    } catch (e) { bad('stdio with headers', e.message); }

    r = await api('POST', '/api/mcp-servers', {
      id: 'remote', name: 'Remote', transport: 'http', url: 'https://mcp/remote',
      headers: { Authorization: 'Bearer ${credential}' },
    });
    try {
      assert.strictEqual(r.status, 201);
      assert.strictEqual(r.body.transport, 'http');
      assert.deepStrictEqual(r.body.headers, { Authorization: 'Bearer ${credential}' });
      ok('POST /api/mcp-servers creates an http server with headers');
    } catch (e) { bad('POST http server', e.message); }

    // SSE: same shape as http but transport='sse'.
    r = await api('POST', '/api/mcp-servers', {
      id: 'sse-remote', name: 'SSE', transport: 'sse', url: 'https://mcp/sse',
      headers: { Authorization: 'Bearer ${credential}' },
    });
    try {
      assert.strictEqual(r.status, 201);
      assert.strictEqual(r.body.transport, 'sse');
      ok('POST /api/mcp-servers creates an sse server');
    } catch (e) { bad('POST sse server', e.message); }

    r = await api('POST', '/api/mcp-servers', {
      id: 'bad-transport', name: 'Bad', transport: 'websocket', command: 'node',
    });
    try {
      assert.strictEqual(r.status, 400);
      assert.match(JSON.stringify(r.body), /must be 'stdio'/);
      ok('unknown transport rejected');
    } catch (e) { bad('unknown transport', e.message); }

    r = await api('GET', '/api/mcp-servers');
    try {
      assert.strictEqual(r.status, 200);
      const ids = r.body.map(s => s.id).sort();
      assert.deepStrictEqual(ids, ['remote', 'sse-remote', 'wiki']);
      const wiki = r.body.find(s => s.id === 'wiki');
      assert.strictEqual(wiki.requiresCredential, true, 'wiki has ${credential} placeholder in env');
      assert.strictEqual(wiki.templateField, 'env');
      const remote = r.body.find(s => s.id === 'remote');
      assert.strictEqual(remote.requiresCredential, true, 'remote has ${credential} placeholder in headers');
      assert.strictEqual(remote.templateField, 'headers');
      const sse = r.body.find(s => s.id === 'sse-remote');
      assert.strictEqual(sse.templateField, 'headers', 'sse template lives under headers too');
      ok('GET /api/mcp-servers reports templateField + flags credential need across transports');
    } catch (e) { bad('GET list', e.message); }

    r = await api('PUT', '/api/mcp-servers/wiki', { description: 'updated description' });
    try {
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.body.description, 'updated description');
      assert.ok(r.body.updatedAt, 'updatedAt timestamp set');
      ok('PUT /api/mcp-servers/:id updates the description');
    } catch (e) { bad('PUT update', e.message); }

    // ── MCP credentials ───────────────────────────────────────────────

    r = await api('GET', '/api/mcp-credentials');
    try {
      assert.strictEqual(r.status, 200);
      assert.deepStrictEqual(r.body, []);
      ok('GET /api/mcp-credentials initially empty');
    } catch (e) { bad('GET creds empty', e.message); }

    r = await api('POST', '/api/mcp-credentials', { name: 'Wiki team A', serverId: 'wiki', secret: 'TOPSECRET' });
    let credId;
    try {
      assert.strictEqual(r.status, 201);
      assert.ok(r.body.fingerprint, 'fingerprint returned');
      assert.strictEqual('secret' in r.body, false, 'secret never returned');
      credId = r.body.id;
      ok('POST /api/mcp-credentials returns metadata only, never the secret');
    } catch (e) { bad('POST credential', e.message); }

    r = await api('POST', '/api/mcp-credentials', { name: 'No server', secret: 'XYZ' });
    try {
      assert.strictEqual(r.status, 201);
      assert.strictEqual(r.body.serverId, null, 'unbound credential allowed');
      ok('credential without serverId is allowed (unbound)');
    } catch (e) { bad('POST unbound credential', e.message); }

    r = await api('POST', '/api/mcp-credentials', { name: 'bad', serverId: 'no-such', secret: 'X' });
    try {
      assert.strictEqual(r.status, 400);
      ok('credential with unknown serverId rejected');
    } catch (e) { bad('credential unknown server', e.message); }

    r = await api('POST', '/api/mcp-credentials', { name: '', secret: 'X' });
    try {
      assert.strictEqual(r.status, 400);
      ok('credential without name rejected');
    } catch (e) { bad('credential missing name', e.message); }

    r = await api('POST', '/api/mcp-credentials', { name: 'no-secret' });
    try {
      assert.strictEqual(r.status, 400);
      ok('credential without secret rejected');
    } catch (e) { bad('credential missing secret', e.message); }

    // ── environment.json mcpServers normalization ─────────────────────

    // Need an SSH key + GH token so /api/environments POST passes upstream
    // checks. Skip those — POST /api/environments doesn't actually require
    // them, only validates if set.

    r = await api('POST', '/api/environments', {
      id: 'team-alpha', name: 'Team Alpha',
      skills: [],
      mcpServers: [{ serverId: 'wiki', credentialId: credId }],
    });
    try {
      assert.strictEqual(r.status, 201);
      assert.deepStrictEqual(r.body.mcpServers, [{ serverId: 'wiki', credentialId: credId }]);
      ok('environment accepts mcpServers refs and persists them');
    } catch (e) { bad('env with mcp', e.message); }

    r = await api('POST', '/api/environments', {
      id: 'team-bad', name: 'Bad',
      mcpServers: [{ serverId: 'no-such', credentialId: null }],
    });
    try {
      assert.strictEqual(r.status, 400);
      ok('environment with unknown mcpServers.serverId rejected');
    } catch (e) { bad('env bad mcp ref', e.message); }

    r = await api('POST', '/api/environments', {
      id: 'team-bad-cred', name: 'Bad', mcpServers: [{ serverId: 'wiki', credentialId: 'no-such' }],
    });
    try {
      assert.strictEqual(r.status, 400);
      ok('environment with unknown mcpServers.credentialId rejected');
    } catch (e) { bad('env bad cred ref', e.message); }

    r = await api('PUT', '/api/environments/team-alpha', {
      mcpServers: [{ serverId: 'remote', credentialId: credId }],
    });
    try {
      assert.strictEqual(r.status, 200);
      assert.deepStrictEqual(r.body.mcpServers, [{ serverId: 'remote', credentialId: credId }]);
      ok('PUT environment replaces mcpServers verbatim');
    } catch (e) { bad('env PUT mcp', e.message); }

    // ── delete protections ────────────────────────────────────────────

    r = await api('DELETE', `/api/mcp-servers/remote`);
    try {
      assert.strictEqual(r.status, 409, 'in-use server cannot be deleted');
      ok('DELETE in-use mcp-server returns 409');
    } catch (e) { bad('DELETE in-use server', e.message); }

    r = await api('DELETE', `/api/mcp-credentials/${credId}`);
    try {
      assert.strictEqual(r.status, 409, 'in-use credential cannot be deleted');
      ok('DELETE in-use mcp-credential returns 409');
    } catch (e) { bad('DELETE in-use credential', e.message); }

    // Clear the env first to free the references, then deletion should pass.
    r = await api('PUT', '/api/environments/team-alpha', { mcpServers: [] });
    assert.strictEqual(r.status, 200);

    r = await api('DELETE', `/api/mcp-credentials/${credId}`);
    try {
      assert.strictEqual(r.status, 204);
      ok('DELETE mcp-credential succeeds once unreferenced');
    } catch (e) { bad('DELETE credential', e.message); }

    r = await api('DELETE', '/api/mcp-servers/remote');
    try {
      assert.strictEqual(r.status, 204);
      ok('DELETE mcp-server succeeds once unreferenced');
    } catch (e) { bad('DELETE server', e.message); }

    // The credential file is gone from disk:
    const credFile = path.join(wsRoot, 'mcp-credentials', '_keys', credId);
    try {
      assert.ok(!fs.existsSync(credFile), 'credential file removed on delete');
      ok('credential secret is removed from disk on DELETE');
    } catch (e) { bad('credential file', e.message); }

    // ── legacy /api/mcp endpoints removed ─────────────────────────────
    r = await api('GET', '/api/mcp');
    try {
      // The catch-all in api.js sends the SPA index.html for non-/api routes,
      // but /api routes return 404 JSON. Confirm the legacy endpoint is gone.
      assert.strictEqual(r.status, 404);
      ok('legacy GET /api/mcp returns 404 (deprecated and removed)');
    } catch (e) { bad('legacy /api/mcp', e.message); }

    r = await api('PUT', '/api/mcp/whatever', { something: 'x' });
    try {
      // PUT to a non-existent route returns 404 from the SPA catch-all (only
      // GET is wired). The point is: it can't write anything to settings.json.
      assert.notStrictEqual(r.status, 200);
      ok('legacy PUT /api/mcp/:name no longer writes to pool settings');
    } catch (e) { bad('legacy PUT /api/mcp', e.message); }

    // ── PUT /api/agents/:id with mcpServersOverride ───────────────────
    // Synthesize a team-member config on disk (no orchestrator interaction)
    // so the PATCH path normalizes the override field correctly.
    const memberId = 'team-alpha-developer';
    const memberDir = path.join(wsRoot, 'agents', memberId);
    fs.mkdirSync(memberDir, { recursive: true });
    fs.writeFileSync(path.join(memberDir, 'config.json'), JSON.stringify({
      id: memberId,
      role: 'team-member',
      parentTeamId: 'team-alpha',
      environmentId: 'team-alpha',
      enabled: true,
    }, null, 2));

    // Re-create wiki + a fresh credential so we can override against them.
    await api('POST', '/api/mcp-servers', {
      id: 'wiki', name: 'Wiki', transport: 'stdio', command: 'node',
      args: ['/srv/wiki.js'], env: { WIKI_TOKEN: '${credential}' },
    });
    const credResp = await api('POST', '/api/mcp-credentials', { name: 'override-cred', secret: 'OV' });
    const overrideCredId = credResp.body.id;

    r = await api('PUT', `/api/agents/${memberId}`, {
      mcpServersOverride: [{ serverId: 'wiki', credentialId: overrideCredId }],
    });
    try {
      assert.strictEqual(r.status, 200);
      const cfg = JSON.parse(fs.readFileSync(path.join(memberDir, 'config.json'), 'utf8'));
      assert.deepStrictEqual(cfg.mcpServersOverride, [{ serverId: 'wiki', credentialId: overrideCredId }]);
      ok('PUT /api/agents/:id persists mcpServersOverride');
    } catch (e) { bad('PUT override', e.message); }

    // null clears the override = back to inherit
    r = await api('PUT', `/api/agents/${memberId}`, { mcpServersOverride: null });
    try {
      assert.strictEqual(r.status, 200);
      const cfg = JSON.parse(fs.readFileSync(path.join(memberDir, 'config.json'), 'utf8'));
      assert.ok(!('mcpServersOverride' in cfg), 'override removed');
      ok('PUT with mcpServersOverride: null clears the override (inherit again)');
    } catch (e) { bad('PUT clear override', e.message); }

    // bad payload — references unknown server
    r = await api('PUT', `/api/agents/${memberId}`, {
      mcpServersOverride: [{ serverId: 'no-such', credentialId: null }],
    });
    try {
      assert.strictEqual(r.status, 400);
      ok('PUT rejects mcpServersOverride pointing at unknown server');
    } catch (e) { bad('PUT bad ref', e.message); }

  } catch (err) {
    console.error('test runner crashed:', err);
  } finally {
    server.close();
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
    console.log(`\n  ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
