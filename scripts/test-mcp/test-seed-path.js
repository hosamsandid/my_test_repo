#!/usr/bin/env node
'use strict';

// Validates seedAgentMcpServers in orchestrator/orchestrator.js by running it
// against a temporary workspace. Loads the function via vm.runInThisContext
// after rewriting its hard-coded /workspace paths to point at our tmpdir,
// since the orchestrator process can't be booted in-place (it needs Matrix
// + the workspace volume to come up first).

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

let pass = 0, fail = 0;
function ok(msg)   { pass++; console.log(`  [32mok[0m  ${msg}`); }
function bad(msg, err) { fail++; console.log(`  [31mfail[0m ${msg}\n      ${err}`); }

// Build a sandbox that has the same require + global it needs and exposes
// the seed function we want to exercise. We pull the orchestrator source,
// trim it to just the function we test plus its closure deps, and rewrite
// the absolute paths to live under our tmpdir.
function loadSeedFn(tmpRoot) {
  const orchestratorSrc = fs.readFileSync(
    path.resolve(__dirname, '..', '..', 'orchestrator', 'orchestrator.js'),
    'utf8'
  );

  // Pull out the function body together with the path constants it depends
  // on. The match handles surrounding whitespace conservatively.
  const startIdx = orchestratorSrc.indexOf('function seedAgentMcpServers(');
  if (startIdx < 0) throw new Error('seedAgentMcpServers not found in orchestrator.js');
  // Find the matching closing brace at column 0.
  const endRe = /\n\}\n/g;
  endRe.lastIndex = startIdx;
  const endMatch = endRe.exec(orchestratorSrc);
  if (!endMatch) throw new Error('end of seedAgentMcpServers not found');
  const fnSrc = orchestratorSrc.slice(startIdx, endMatch.index + 3);

  // Stub the constants the function references.
  const preamble = `
    const fs = require('fs');
    const path = require('path');
    const MCP_SERVERS_DIR = ${JSON.stringify(path.join(tmpRoot, 'mcp-servers'))};
    const MCP_CREDENTIALS_KEYS_DIR = ${JSON.stringify(path.join(tmpRoot, 'mcp-credentials', '_keys'))};
  `;
  const wrapped = `${preamble}\n${fnSrc}\nmodule.exports = seedAgentMcpServers;`;

  const tmpModule = path.join(tmpRoot, '_seed-shim.js');
  fs.writeFileSync(tmpModule, wrapped);
  return require(tmpModule);
}

function setupRegistry(tmpRoot) {
  // server: requires credential
  fs.mkdirSync(path.join(tmpRoot, 'mcp-servers', 'wiki'), { recursive: true });
  fs.writeFileSync(path.join(tmpRoot, 'mcp-servers', 'wiki', 'server.json'), JSON.stringify({
    id: 'wiki', name: 'Wiki', transport: 'stdio',
    command: 'node', args: ['/template-workspace/mcp-servers/wiki/server.js'],
    env: { WIKI_BASE_URL: 'https://wiki/api', WIKI_TOKEN: '${credential}' },
  }, null, 2));

  // server: no credential placeholder
  fs.mkdirSync(path.join(tmpRoot, 'mcp-servers', 'noauth'), { recursive: true });
  fs.writeFileSync(path.join(tmpRoot, 'mcp-servers', 'noauth', 'server.json'), JSON.stringify({
    id: 'noauth', name: 'Public', transport: 'stdio',
    command: 'node', args: ['/some/server.js'],
    env: { READ_ONLY: 'true' },
  }, null, 2));

  // server: http transport — auth lives in headers, not env
  fs.mkdirSync(path.join(tmpRoot, 'mcp-servers', 'remote'), { recursive: true });
  fs.writeFileSync(path.join(tmpRoot, 'mcp-servers', 'remote', 'server.json'), JSON.stringify({
    id: 'remote', name: 'Remote', transport: 'http',
    url: 'https://mcp.example/api',
    headers: { Authorization: 'Bearer ${credential}' },
  }, null, 2));

  // server: sse transport (same shape as http)
  fs.mkdirSync(path.join(tmpRoot, 'mcp-servers', 'sse-remote'), { recursive: true });
  fs.writeFileSync(path.join(tmpRoot, 'mcp-servers', 'sse-remote', 'server.json'), JSON.stringify({
    id: 'sse-remote', name: 'SSE Remote', transport: 'sse',
    url: 'https://mcp.example/sse',
    headers: { Authorization: 'Bearer ${credential}', 'X-Source': 'aee' },
  }, null, 2));

  // credential
  fs.mkdirSync(path.join(tmpRoot, 'mcp-credentials', '_keys'), { recursive: true });
  fs.writeFileSync(path.join(tmpRoot, 'mcp-credentials', '_keys', 'wiki-secret'), 'TOP_SECRET\n');
  fs.writeFileSync(path.join(tmpRoot, 'mcp-credentials', '_keys', 'remote-key'), 'remote-bearer\n');
}

function readSettings(dest) {
  return JSON.parse(fs.readFileSync(path.join(dest, '.claude', 'settings.json'), 'utf8'));
}

function freshAgent(tmpRoot, name) {
  const dest = path.join(tmpRoot, 'agents', name);
  fs.mkdirSync(path.join(dest, '.claude'), { recursive: true });
  return dest;
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aee-seed-test-'));
console.log(`tmp: ${tmpRoot}`);

try {
  setupRegistry(tmpRoot);
  const seed = loadSeedFn(tmpRoot);

  // Test 1: empty refs → no settings written, no warnings.
  {
    const dest = freshAgent(tmpRoot, 'a1');
    const warnings = [];
    const out = seed(dest, [], warnings);
    try {
      assert.deepStrictEqual(out, [], 'returns empty array');
      assert.strictEqual(warnings.length, 0, 'no warnings');
      assert.ok(!fs.existsSync(path.join(dest, '.claude', 'settings.json')), 'settings.json not created when no refs');
      ok('empty refs → no settings file, no warnings');
    } catch (e) { bad('empty refs', e.message); }
  }

  // Test 2: one server with credential → settings.json contains substituted secret.
  // For stdio servers, Claude Code expects {command, args, env} with NO `type` /
  // `transport` field — stdio is the implicit default. Verify that explicitly so
  // a future regression that adds `transport: "stdio"` back gets caught.
  {
    const dest = freshAgent(tmpRoot, 'a2');
    const warnings = [];
    const out = seed(dest, [{ serverId: 'wiki', credentialId: 'wiki-secret' }], warnings);
    try {
      assert.deepStrictEqual(out, ['wiki']);
      assert.strictEqual(warnings.length, 0, 'no warnings');
      const s = readSettings(dest);
      assert.ok(s.mcpServers?.wiki, 'wiki entry present');
      assert.ok(!('type' in s.mcpServers.wiki), "stdio entry has no `type` field");
      assert.ok(!('transport' in s.mcpServers.wiki), "stdio entry has no `transport` field");
      assert.strictEqual(s.mcpServers.wiki.command, 'node');
      assert.deepStrictEqual(s.mcpServers.wiki.args, ['/template-workspace/mcp-servers/wiki/server.js']);
      assert.strictEqual(s.mcpServers.wiki.env.WIKI_TOKEN, 'TOP_SECRET');
      assert.strictEqual(s.mcpServers.wiki.env.WIKI_BASE_URL, 'https://wiki/api');
      ok('stdio: credential placeholder substituted into env, no type field emitted');
    } catch (e) { bad('basic substitution', e.message); }
  }

  // Test 3: server without ${credential}, credential bound → warning, credential ignored.
  {
    const dest = freshAgent(tmpRoot, 'a3');
    const warnings = [];
    const out = seed(dest, [{ serverId: 'noauth', credentialId: 'wiki-secret' }], warnings);
    try {
      assert.deepStrictEqual(out, ['noauth']);
      assert.ok(warnings.some(w => /no \$\{credential\} placeholder/.test(w)), 'warns about ignored credential');
      const s = readSettings(dest);
      assert.strictEqual(s.mcpServers.noauth.env.READ_ONLY, 'true');
      assert.ok(!('credential' in s.mcpServers.noauth.env), 'literal placeholder not present');
      ok('credential ignored when server has no placeholder, with warning');
    } catch (e) { bad('credential without placeholder', e.message); }
  }

  // Test 4: server with placeholder, NO credential → key dropped + warning.
  {
    const dest = freshAgent(tmpRoot, 'a4');
    const warnings = [];
    const out = seed(dest, [{ serverId: 'wiki', credentialId: null }], warnings);
    try {
      assert.deepStrictEqual(out, ['wiki']);
      assert.ok(warnings.some(w => /uses \$\{credential\} but no credential/.test(w)), 'warns about missing credential');
      const s = readSettings(dest);
      assert.strictEqual(s.mcpServers.wiki.env.WIKI_BASE_URL, 'https://wiki/api');
      assert.ok(!('WIKI_TOKEN' in s.mcpServers.wiki.env), 'placeholder key dropped, not literal');
      ok('missing credential drops the placeholder key, never leaks ${credential}');
    } catch (e) { bad('missing credential', e.message); }
  }

  // Test 5: http transport — Claude Code expects {type: "http", url, headers},
  // not {transport: "http", url, env}. The placeholder lives in `headers`,
  // gets substituted, and lands in `headers` on the wire.
  {
    const dest = freshAgent(tmpRoot, 'a5');
    const warnings = [];
    const out = seed(dest, [{ serverId: 'remote', credentialId: 'remote-key' }], warnings);
    try {
      assert.deepStrictEqual(out, ['remote']);
      const s = readSettings(dest);
      assert.strictEqual(s.mcpServers.remote.type, 'http', 'type field set to http');
      assert.ok(!('transport' in s.mcpServers.remote), 'no `transport` field on the wire');
      assert.strictEqual(s.mcpServers.remote.url, 'https://mcp.example/api');
      assert.ok(!('command' in s.mcpServers.remote), 'no command field for http');
      assert.ok(!('env' in s.mcpServers.remote), 'no env field for http — auth is in headers');
      assert.strictEqual(s.mcpServers.remote.headers.Authorization, 'Bearer remote-bearer');
      ok('http: emits {type, url, headers} per Claude Code MCP schema');
    } catch (e) { bad('http transport', e.message); }
  }

  // Test 5b: sse transport — same wire shape as http but type=sse.
  {
    const dest = freshAgent(tmpRoot, 'a5b');
    const warnings = [];
    const out = seed(dest, [{ serverId: 'sse-remote', credentialId: 'remote-key' }], warnings);
    try {
      assert.deepStrictEqual(out, ['sse-remote']);
      const s = readSettings(dest);
      assert.strictEqual(s.mcpServers['sse-remote'].type, 'sse');
      assert.strictEqual(s.mcpServers['sse-remote'].url, 'https://mcp.example/sse');
      assert.strictEqual(s.mcpServers['sse-remote'].headers.Authorization, 'Bearer remote-bearer');
      assert.strictEqual(s.mcpServers['sse-remote'].headers['X-Source'], 'aee', 'non-credential headers passed through verbatim');
      ok('sse: emits {type:"sse", url, headers} with non-credential headers preserved');
    } catch (e) { bad('sse transport', e.message); }
  }

  // Test 6: unknown server id → warning, ref skipped.
  {
    const dest = freshAgent(tmpRoot, 'a6');
    const warnings = [];
    const out = seed(dest, [{ serverId: 'no-such', credentialId: null }], warnings);
    try {
      assert.deepStrictEqual(out, []);
      assert.ok(warnings.some(w => /not found in registry/.test(w)), 'warning surfaced');
      ok('unknown server id skipped with warning');
    } catch (e) { bad('unknown server', e.message); }
  }

  // Test 7: invalid serverId (path-traversal try) → warning, ref skipped.
  {
    const dest = freshAgent(tmpRoot, 'a7');
    const warnings = [];
    const out = seed(dest, [{ serverId: '../etc', credentialId: null }], warnings);
    try {
      assert.deepStrictEqual(out, []);
      assert.ok(warnings.some(w => /invalid serverId/.test(w)), 'rejected as invalid');
      ok('serverId path-traversal attempt rejected');
    } catch (e) { bad('serverId traversal', e.message); }
  }

  // Test 8: invalid credentialId (path-traversal try) → warning, ref skipped.
  {
    const dest = freshAgent(tmpRoot, 'a8');
    const warnings = [];
    const out = seed(dest, [{ serverId: 'wiki', credentialId: '../etc/passwd' }], warnings);
    try {
      assert.deepStrictEqual(out, []);
      assert.ok(warnings.some(w => /invalid credentialId/.test(w)), 'rejected as invalid');
      ok('credentialId path-traversal attempt rejected');
    } catch (e) { bad('credentialId traversal', e.message); }
  }

  // Test 9: unknown credential id (passes regex but file missing) → warning, ref skipped.
  {
    const dest = freshAgent(tmpRoot, 'a9');
    const warnings = [];
    const out = seed(dest, [{ serverId: 'wiki', credentialId: 'no-such-cred' }], warnings);
    try {
      assert.deepStrictEqual(out, []);
      assert.ok(warnings.some(w => /cannot read credential/.test(w)), 'cannot-read warning');
      ok('missing credential file surfaces a readable warning');
    } catch (e) { bad('missing credential file', e.message); }
  }

  // Test 10: idempotency — running twice yields same result, replaces stale entry.
  {
    const dest = freshAgent(tmpRoot, 'a10');
    seed(dest, [{ serverId: 'wiki', credentialId: 'wiki-secret' }], []);
    seed(dest, [{ serverId: 'wiki', credentialId: 'remote-key' }], []);
    try {
      const s = readSettings(dest);
      assert.strictEqual(s.mcpServers.wiki.env.WIKI_TOKEN, 'remote-bearer', 'second seed wins');
      ok('re-seeding overwrites the previous credential cleanly');
    } catch (e) { bad('idempotent re-seed', e.message); }
  }

  // Test 11: pre-existing settings.json with unrelated keys → preserved.
  {
    const dest = freshAgent(tmpRoot, 'a11');
    fs.writeFileSync(path.join(dest, '.claude', 'settings.json'), JSON.stringify({
      theme: 'dark',
      mcpServers: { keep: { transport: 'stdio', command: 'echo', args: [], env: {} } },
    }));
    seed(dest, [{ serverId: 'wiki', credentialId: 'wiki-secret' }], []);
    try {
      const s = readSettings(dest);
      assert.strictEqual(s.theme, 'dark', 'unrelated top-level keys preserved');
      assert.ok(s.mcpServers.keep, 'unrelated mcp entries preserved');
      assert.ok(s.mcpServers.wiki, 'new entry added alongside');
      ok('seed merges into existing settings.json without trampling unrelated keys');
    } catch (e) { bad('settings.json merge', e.message); }
  }

} finally {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
