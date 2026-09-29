'use strict';

// End-to-end CLI-contract enforcement (plugin system Phase 2, #1518).
//
// The concept (§4.5) makes the seeded CLI facade a hard contract: a
// dependency-free single file, `--json` on every subcommand, exit codes
// 0 ok / 1 domain error / 2 usage / 3 broker unreachable, and `--help` carrying
// the agent-readable docs. Phase 2 is where that contract is *enforced*, so we
// drive the reference plugin's actual CLI (plugins/dummy-echo) through it —
// python3 is present in the agent image and the test host — reading its config
// from the exact `.agent-studio/plugins/<id>.json` shape plugin-sync.js plans.

const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { pluginConfigFile } = require('./plugin-sync');

const CLI = path.join(__dirname, '..', 'plugins', 'dummy-echo', 'bin', 'aee-echo.py');

function run(args, workspace) {
  return spawnSync('python3', [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, AEE_WORKSPACE: workspace },
  });
}

// A granted workspace: the 0600 config plugin-sync would have written.
function grantedWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aee-cli-'));
  fs.mkdirSync(path.join(dir, '.agent-studio', 'plugins'), { recursive: true });
  const cfg = pluginConfigFile({
    pluginId: 'dummy-echo', scopeId: 't1', endpoint: 'http://aee-plugin-dummy-echo:8080',
    token: 'dummy-echo.t1.SIG', cliName: 'aee-echo',
  });
  fs.writeFileSync(path.join(dir, '.agent-studio', 'plugins', 'dummy-echo.json'), JSON.stringify(cfg), { mode: 0o600 });
  return dir;
}

// An ungranted workspace: no config file at all.
function ungrantedWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aee-cli-'));
}

test('the reference CLI is a dependency-free single file (stdlib imports only)', () => {
  const src = fs.readFileSync(CLI, 'utf8');
  const imports = src.split('\n').filter((l) => /^\s*(import|from)\s+/.test(l));
  assert.ok(imports.length > 0);
  const STDLIB = new Set(['argparse', 'json', 'os', 'sys']);
  for (const line of imports) {
    const m = line.match(/^\s*(?:import|from)\s+([a-zA-Z0-9_]+)/);
    assert.ok(m && STDLIB.has(m[1]), `non-stdlib import: ${line.trim()}`);
  }
});

test('no subcommand prints help and exits 2 (usage)', () => {
  const r = run([], ungrantedWorkspace());
  assert.equal(r.status, 2);
  assert.match(r.stdout, /aee-echo/);
});

test('--help exits 0 and carries the agent-readable docs', () => {
  const r = run(['--help'], ungrantedWorkspace());
  assert.equal(r.status, 0);
  assert.match(r.stdout, /echo/);
  assert.match(r.stdout, /whoami/);
});

test('an unknown subcommand exits 2 (usage error)', () => {
  const r = run(['frobnicate'], grantedWorkspace());
  assert.equal(r.status, 2);
});

test('--json is honoured on every subcommand and the output parses', () => {
  const ws = grantedWorkspace();
  for (const args of [['whoami', '--json'], ['echo', 'hello', 'world', '--json']]) {
    const r = run(args, ws);
    assert.equal(r.status, 0, `exit 0 for ${args.join(' ')}`);
    const obj = JSON.parse(r.stdout.trim());
    assert.equal(obj.ok, true);
  }
});

test('echo returns its text and the resolved scope from the seeded config', () => {
  const r = run(['echo', 'hi', '--json'], grantedWorkspace());
  assert.equal(r.status, 0);
  const obj = JSON.parse(r.stdout.trim());
  assert.equal(obj.message, 'hi');
  assert.equal(obj.scopeId, 't1');
});

test('ungranted (no seeded config) → exit 3 broker-unreachable with not-granted error', () => {
  const r = run(['echo', 'x', '--json'], ungrantedWorkspace());
  assert.equal(r.status, 3);
  const obj = JSON.parse(r.stdout.trim());
  assert.equal(obj.ok, false);
  assert.equal(obj.error, 'not-granted');
});

// ── plugin #1: podman-sandbox (Phase 3, #1519) ───────────────────────────────
// The same §4.5 contract, enforced against the real `aee-podman` CLI. Every
// case here is broker-free: `whoami` reads only the seeded config; the
// container/compose verbs point at an unroutable endpoint so a call attempt
// deterministically returns the broker-unreachable exit code (3) rather than
// depending on a live sidecar.
const POD_CLI = path.join(__dirname, '..', 'plugins', 'podman-sandbox', 'bin', 'aee-podman.py');

function runPod(args, workspace) {
  return spawnSync('python3', [POD_CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, AEE_WORKSPACE: workspace },
  });
}

function grantedPodWorkspace(endpoint) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aee-pod-'));
  fs.mkdirSync(path.join(dir, '.agent-studio', 'plugins'), { recursive: true });
  const cfg = pluginConfigFile({
    pluginId: 'podman-sandbox', scopeId: 't1',
    endpoint: endpoint || 'http://127.0.0.1:59371/',   // reserved, unroutable
    token: 'podman-sandbox.t1.SIG', cliName: 'aee-podman',
  });
  fs.writeFileSync(path.join(dir, '.agent-studio', 'plugins', 'podman-sandbox.json'), JSON.stringify(cfg), { mode: 0o600 });
  return dir;
}

test('aee-podman is a dependency-free single file (stdlib imports only)', () => {
  const src = fs.readFileSync(POD_CLI, 'utf8');
  const imports = src.split('\n').filter((l) => /^\s*(import|from)\s+/.test(l));
  assert.ok(imports.length > 0);
  const STDLIB = new Set(['argparse', 'json', 'os', 'sys', 'urllib']);
  for (const line of imports) {
    const m = line.match(/^\s*(?:import|from)\s+([a-zA-Z0-9_]+)/);
    assert.ok(m && STDLIB.has(m[1]), `non-stdlib import: ${line.trim()}`);
  }
});

test('aee-podman: no subcommand → exit 2, --help → 0 with domain verbs', () => {
  assert.equal(runPod([], grantedPodWorkspace()).status, 2);
  const help = runPod(['--help'], grantedPodWorkspace());
  assert.equal(help.status, 0);
  assert.match(help.stdout, /compose/);
  assert.match(help.stdout, /ps/);
});

test('aee-podman: unknown subcommand → exit 2 (usage)', () => {
  assert.equal(runPod(['frobnicate'], grantedPodWorkspace()).status, 2);
});

test('aee-podman: whoami --json resolves the seeded scope (no broker needed)', () => {
  const r = runPod(['whoami', '--json'], grantedPodWorkspace());
  assert.equal(r.status, 0);
  const obj = JSON.parse(r.stdout.trim());
  assert.equal(obj.ok, true);
  assert.equal(obj.scopeId, 't1');
});

test('aee-podman: ungranted → exit 3 with not-granted error', () => {
  const r = runPod(['ps', '--json'], ungrantedWorkspace());
  assert.equal(r.status, 3);
  const obj = JSON.parse(r.stdout.trim());
  assert.equal(obj.ok, false);
  assert.equal(obj.error, 'not-granted');
});

test('aee-podman: a granted verb against an unreachable broker → exit 3', () => {
  const r = runPod(['ps', '--json'], grantedPodWorkspace());
  assert.equal(r.status, 3);
  const obj = JSON.parse(r.stdout.trim());
  assert.equal(obj.ok, false);
  assert.equal(obj.error, 'broker-unreachable');
});

test('aee-podman: compose up with an unreadable file → exit 2 (usage), never a broker call', () => {
  const r = runPod(['compose', 'up', '-f', '/no/such/compose.yml', '--json'], grantedPodWorkspace());
  assert.equal(r.status, 2);
  const obj = JSON.parse(r.stdout.trim());
  assert.equal(obj.error, 'usage');
});

// ── plugin #1: the `run` verb (CLI sugar over compose_up, #1550) ─────────────
// `run` is pure CLI-side sugar: it synthesises a one-service compose document
// and sends it through the existing compose_up tool, so it adds no broker tool
// (AC5). These cases pin the §4.5 contract (help/usage/exit codes) broker-free,
// plus one capturing-broker case that proves the synthesised document's shape —
// the issue's core guarantee that a value can never reshape the document.

test('aee-podman: run --help → 0 and documents the single-service doc + no-egress', () => {
  const r = runPod(['run', '--help'], grantedPodWorkspace());
  assert.equal(r.status, 0);
  assert.match(r.stdout, /compose up/);     // points at compose for >1 service
  assert.match(r.stdout, /internal:true|no outbound|egress/i);  // network constraint
});

test('aee-podman: run --env without = → exit 2 (usage), never a broker call', () => {
  const r = runPod(['run', 'docker.io/library/hello-world', '--env', 'NOEQ', '--json'], grantedPodWorkspace());
  assert.equal(r.status, 2);
  const obj = JSON.parse(r.stdout.trim());
  assert.equal(obj.error, 'usage');
});

test('aee-podman: run ungranted → exit 3 with not-granted error', () => {
  const r = runPod(['run', 'docker.io/library/hello-world', '--json'], ungrantedWorkspace());
  assert.equal(r.status, 3);
  const obj = JSON.parse(r.stdout.trim());
  assert.equal(obj.error, 'not-granted');
});

test('aee-podman: run against an unreachable broker → exit 3 (synthesis then network)', () => {
  const r = runPod(['run', 'docker.io/library/hello-world', '--json'], grantedPodWorkspace());
  assert.equal(r.status, 3);
  const obj = JSON.parse(r.stdout.trim());
  assert.equal(obj.error, 'broker-unreachable');
});

// A minimal MCP-over-HTTP stub that captures the compose_up arguments so the
// synthesised document can be asserted. Speaks just enough: 202 for the
// initialized notification, an SSE `data:` frame for initialize and tools/call.
// `Connection: close` so no keep-alive socket lingers past `server.close()`.
function captureBroker() {
  const http = require('node:http');
  const state = { lastTool: null, lastArgs: null };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let msg = {};
      try { msg = JSON.parse(body); } catch { /* ignore */ }
      res.setHeader('Connection', 'close');
      if (msg.method === 'notifications/initialized') { res.statusCode = 202; res.end(); return; }
      if (msg.method === 'tools/call') {
        state.lastTool = msg.params && msg.params.name;
        state.lastArgs = msg.params && msg.params.arguments;
        const result = { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'project scope-t1-default up' }] } };
        res.setHeader('Content-Type', 'text/event-stream');
        res.end(`data: ${JSON.stringify(result)}\n\n`);
        return;
      }
      // initialize (or anything else): a minimal result frame; the CLI ignores it.
      const result = { jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: {} } };
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Mcp-Session-Id', 'stub-session');
      res.end(`data: ${JSON.stringify(result)}\n\n`);
    });
  });
  return { server, state };
}

// The capturing-broker tests must NOT use spawnSync: it blocks the event loop,
// so the in-process stub server could never answer and the CLI would time out.
// Spawn asynchronously so the loop stays free to serve the broker calls.
function runPodAsync(args, workspace) {
  const { spawn } = require('node:child_process');
  return new Promise((resolve) => {
    const child = spawn('python3', [POD_CLI, ...args], {
      env: { ...process.env, AEE_WORKSPACE: workspace },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

test('aee-podman: run synthesises a single-service compose doc through compose_up', async () => {
  const { server, state } = captureBroker();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = server.address().port;
    const ws = grantedPodWorkspace(`http://127.0.0.1:${port}`);
    const r = await runPodAsync(
      ['run', 'docker.io/library/hello-world', '--name', 'greeter',
       '-e', 'GREETING=hi there', '-e', 'URL=http://x:8080',
       '-p', 'demo', '--json', '--', 'sh', '-c', 'echo hi && sleep 1'],
      ws,
    );
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const obj = JSON.parse(r.stdout.trim());
    assert.equal(obj.ok, true);
    assert.equal(obj.container, 'greeter');   // pinned name returned for logs/rm

    // It reached compose_up (no new broker tool) with a well-formed document.
    assert.equal(state.lastTool, 'compose_up');
    assert.equal(state.lastArgs.projectName, 'demo');
    const doc = JSON.parse(state.lastArgs.composeFile);   // JSON ⊂ YAML
    assert.deepEqual(Object.keys(doc.services), ['greeter']);   // exactly one service
    const svc = doc.services.greeter;
    assert.equal(svc.image, 'docker.io/library/hello-world');
    assert.equal(svc.container_name, 'greeter');
    assert.deepEqual(svc.environment, { GREETING: 'hi there', URL: 'http://x:8080' });
    assert.deepEqual(svc.command, ['sh', '-c', 'echo hi && sleep 1']);   // exec-form list, not reshaped
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('aee-podman: run derives the container name from the image when --name is absent', async () => {
  const { server, state } = captureBroker();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = server.address().port;
    const ws = grantedPodWorkspace(`http://127.0.0.1:${port}`);
    const r = await runPodAsync(['run', 'docker.io/library/hello-world:latest', '--json'], ws);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const obj = JSON.parse(r.stdout.trim());
    assert.equal(obj.container, 'hello-world');
    const doc = JSON.parse(state.lastArgs.composeFile);
    assert.deepEqual(Object.keys(doc.services), ['hello-world']);
    assert.equal(doc.services['hello-world'].image, 'docker.io/library/hello-world:latest');
    // No env / no command override → neither key present.
    assert.equal('environment' in doc.services['hello-world'], false);
    assert.equal('command' in doc.services['hello-world'], false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// ─── plugin #2: aee-test (Phase 5, #1521) ────────────────────────────────────
// The same §4.5 contract against the real `aee-test` CLI. Broker-free: `whoami`
// reads only the seeded config; every broker-touching verb points at an
// unroutable endpoint so a call attempt deterministically returns exit 3 rather
// than depending on a live sidecar. `create-case`'s per-scope POLICY (flow-final
// agent only) is enforced by the broker (broker-sdk/authz.js), not the CLI — the
// CLI is a privilege-less client — so it is unit-tested there, not here.
const TEST_CLI = path.join(__dirname, '..', 'plugins', 'test-mgmt', 'bin', 'aee-test.py');

function runTest(args, workspace) {
  return spawnSync('python3', [TEST_CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, AEE_WORKSPACE: workspace },
  });
}

function grantedTestWorkspace(endpoint) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aee-test-'));
  fs.mkdirSync(path.join(dir, '.agent-studio', 'plugins'), { recursive: true });
  const cfg = pluginConfigFile({
    pluginId: 'test-mgmt', scopeId: 't1',
    endpoint: endpoint || 'http://127.0.0.1:59372/',   // reserved, unroutable
    token: 'test-mgmt.t1.SIG', cliName: 'aee-test',
  });
  fs.writeFileSync(path.join(dir, '.agent-studio', 'plugins', 'test-mgmt.json'), JSON.stringify(cfg), { mode: 0o600 });
  return dir;
}

test('aee-test is a dependency-free single file (stdlib imports only)', () => {
  const src = fs.readFileSync(TEST_CLI, 'utf8');
  const imports = src.split('\n').filter((l) => /^\s*(import|from)\s+/.test(l));
  assert.ok(imports.length > 0);
  const STDLIB = new Set(['argparse', 'json', 'os', 'sys', 'time', 'urllib']);
  for (const line of imports) {
    const m = line.match(/^\s*(?:import|from)\s+([a-zA-Z0-9_]+)/);
    assert.ok(m && STDLIB.has(m[1]), `non-stdlib import: ${line.trim()}`);
  }
});

test('aee-test: no subcommand → exit 2, --help → 0 with domain verbs', () => {
  assert.equal(runTest([], grantedTestWorkspace()).status, 2);
  const help = runTest(['--help'], grantedTestWorkspace());
  assert.equal(help.status, 0);
  assert.match(help.stdout, /create-case/);
  assert.match(help.stdout, /trigger/);
});

test('aee-test: unknown subcommand → exit 2 (usage)', () => {
  assert.equal(runTest(['frobnicate'], grantedTestWorkspace()).status, 2);
});

test('aee-test: whoami --json resolves the seeded scope (no broker needed)', () => {
  const r = runTest(['whoami', '--json'], grantedTestWorkspace());
  assert.equal(r.status, 0);
  const obj = JSON.parse(r.stdout.trim());
  assert.equal(obj.ok, true);
  assert.equal(obj.scopeId, 't1');
});

test('aee-test: ungranted → exit 3 with not-granted error', () => {
  const r = runTest(['trigger', '--plan', 'REGRESSION', '--json'], ungrantedWorkspace());
  assert.equal(r.status, 3);
  const obj = JSON.parse(r.stdout.trim());
  assert.equal(obj.ok, false);
  assert.equal(obj.error, 'not-granted');
});

test('aee-test: a granted verb against an unreachable broker → exit 3', () => {
  const r = runTest(['create-case', '--title', 'x', '--json'], grantedTestWorkspace());
  assert.equal(r.status, 3);
  const obj = JSON.parse(r.stdout.trim());
  assert.equal(obj.ok, false);
  assert.equal(obj.error, 'broker-unreachable');
});

test('aee-test: trigger without --plan/--suite → exit 2 (usage), never a broker call', () => {
  const r = runTest(['trigger', '--json'], grantedTestWorkspace());
  assert.equal(r.status, 2);
  const obj = JSON.parse(r.stdout.trim());
  assert.equal(obj.error, 'usage');
});

test('aee-test: data with no subcommand → exit 2 (usage)', () => {
  assert.equal(runTest(['data'], grantedTestWorkspace()).status, 2);
});

// ─── plugin #3: aee-plan (epic #1554, Phase 3, #1563) ────────────────────────
// The same §4.5 contract against the real `aee-plan` CLI (entrypoint `bin/aee-plan`,
// no .py suffix). Broker-free: `whoami` reads only the seeded config; every
// broker-touching verb points at an unroutable endpoint so a call attempt
// deterministically returns exit 3 rather than depending on a live sidecar. The
// autonomy ladder (show=0, tick>=1, edit>=2) is enforced broker-side
// (plan-doc.js `requiredAutonomy` + broker-sdk/authz.js); the CLI's early
// refusal reads the level via a `show`, so against an unreachable broker a write
// surfaces exit 3 (unreachable) before it can reach the level check.
const PLAN_CLI = path.join(__dirname, '..', 'plugins', 'netzplan', 'bin', 'aee-plan');

function runPlan(args, workspace) {
  return spawnSync('python3', [PLAN_CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, AEE_WORKSPACE: workspace },
  });
}

function grantedPlanWorkspace(endpoint) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aee-plan-'));
  fs.mkdirSync(path.join(dir, '.agent-studio', 'plugins'), { recursive: true });
  const cfg = pluginConfigFile({
    pluginId: 'netzplan', scopeId: 'team-x',
    endpoint: endpoint || 'http://127.0.0.1:59373/',   // reserved, unroutable
    token: 'netzplan.team-x.SIG', cliName: 'aee-plan',
  });
  fs.writeFileSync(path.join(dir, '.agent-studio', 'plugins', 'netzplan.json'), JSON.stringify(cfg), { mode: 0o600 });
  return dir;
}

test('aee-plan is a dependency-free single file (stdlib imports only)', () => {
  const src = fs.readFileSync(PLAN_CLI, 'utf8');
  const imports = src.split('\n').filter((l) => /^\s*(import|from)\s+/.test(l));
  assert.ok(imports.length > 0);
  const STDLIB = new Set(['argparse', 'json', 'os', 'sys', 'urllib']);
  for (const line of imports) {
    const m = line.match(/^\s*(?:import|from)\s+([a-zA-Z0-9_]+)/);
    assert.ok(m && STDLIB.has(m[1]), `non-stdlib import: ${line.trim()}`);
  }
});

test('aee-plan: no subcommand → exit 2, --help → 0 with domain verbs', () => {
  assert.equal(runPlan([], grantedPlanWorkspace()).status, 2);
  const help = runPlan(['--help'], grantedPlanWorkspace());
  assert.equal(help.status, 0);
  assert.match(help.stdout, /show/);
  assert.match(help.stdout, /tick/);
});

test('aee-plan: unknown subcommand → exit 2 (usage)', () => {
  assert.equal(runPlan(['frobnicate'], grantedPlanWorkspace()).status, 2);
});

test('aee-plan: whoami --json resolves the seeded (team) scope (no broker needed)', () => {
  const r = runPlan(['whoami', '--json'], grantedPlanWorkspace());
  assert.equal(r.status, 0);
  const obj = JSON.parse(r.stdout.trim());
  assert.equal(obj.ok, true);
  assert.equal(obj.scopeId, 'team-x');
});

test('aee-plan: ungranted → exit 3 with not-granted error', () => {
  const r = runPlan(['show', '--json'], ungrantedWorkspace());
  assert.equal(r.status, 3);
  const obj = JSON.parse(r.stdout.trim());
  assert.equal(obj.ok, false);
  assert.equal(obj.error, 'not-granted');
});

test('aee-plan: show against an unreachable broker → exit 3', () => {
  const r = runPlan(['show', '--json'], grantedPlanWorkspace());
  assert.equal(r.status, 3);
  const obj = JSON.parse(r.stdout.trim());
  assert.equal(obj.ok, false);
  assert.equal(obj.error, 'broker-unreachable');
});

test('aee-plan: tick against an unreachable broker → exit 3 (early level read is a show)', () => {
  const r = runPlan(['tick', 'lane1-m2', '--json'], grantedPlanWorkspace());
  assert.equal(r.status, 3);
  const obj = JSON.parse(r.stdout.trim());
  assert.equal(obj.ok, false);
  assert.equal(obj.error, 'broker-unreachable');
});

test('aee-plan: edit with invalid JSON → exit 2 (usage), never a broker call', () => {
  const r = runPlan(['edit', 'not-json', '--json'], grantedPlanWorkspace());
  assert.equal(r.status, 2);
  const obj = JSON.parse(r.stdout.trim());
  assert.equal(obj.error, 'usage');
});

test('aee-plan: edit with an op missing a type → exit 2 (usage), never a broker call', () => {
  const r = runPlan(['edit', '{"foo":1}', '--json'], grantedPlanWorkspace());
  assert.equal(r.status, 2);
  const obj = JSON.parse(r.stdout.trim());
  assert.equal(obj.error, 'usage');
});

// ─── jira: aee-jira (Jira plan §6.3, Phase 3) ────────────────────────────────
// The same §4.5 contract against the real `aee-jira` CLI. Broker-free: `whoami`
// reads only the seeded config; every broker-touching verb points at an
// unroutable endpoint so a call attempt deterministically returns exit 3.
const JIRA_CLI = path.join(__dirname, '..', 'plugins', 'jira', 'bin', 'aee-jira.py');

function runJira(args, workspace) {
  return spawnSync('python3', [JIRA_CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, AEE_WORKSPACE: workspace },
  });
}

function grantedJiraWorkspace(endpoint) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aee-jira-'));
  fs.mkdirSync(path.join(dir, '.agent-studio', 'plugins'), { recursive: true });
  const cfg = pluginConfigFile({
    pluginId: 'jira', scopeId: 'team-x',
    endpoint: endpoint || 'http://127.0.0.1:59374/',   // reserved, unroutable
    token: 'jira.team-x.SIG', cliName: 'aee-jira',
  });
  fs.writeFileSync(path.join(dir, '.agent-studio', 'plugins', 'jira.json'), JSON.stringify(cfg), { mode: 0o600 });
  return dir;
}

test('aee-jira is a dependency-free single file (stdlib imports only)', () => {
  const src = fs.readFileSync(JIRA_CLI, 'utf8');
  const imports = src.split('\n').filter((l) => /^\s*(import|from)\s+/.test(l));
  assert.ok(imports.length > 0);
  // base64 + re added for #2399 attachment read-side (binary decode + filename
  // sanitisation) — both Python stdlib, so the dependency-free contract holds.
  const STDLIB = new Set(['argparse', 'base64', 'json', 'os', 're', 'sys', 'urllib']);
  for (const line of imports) {
    const m = line.match(/^\s*(?:import|from)\s+([a-zA-Z0-9_]+)/);
    assert.ok(m && STDLIB.has(m[1]), `non-stdlib import: ${line.trim()}`);
  }
});

test('aee-jira: no subcommand → exit 2, --help → 0 with domain verbs', () => {
  assert.equal(runJira([], grantedJiraWorkspace()).status, 2);
  const help = runJira(['--help'], grantedJiraWorkspace());
  assert.equal(help.status, 0);
  assert.match(help.stdout, /projects/);
  assert.match(help.stdout, /inbox/);
  assert.match(help.stdout, /show/);
  assert.match(help.stdout, /comment/);
  assert.match(help.stdout, /transition/);
  assert.match(help.stdout, /update/);
});

test('aee-jira: unknown subcommand → exit 2 (usage)', () => {
  assert.equal(runJira(['frobnicate'], grantedJiraWorkspace()).status, 2);
});

test('aee-jira: whoami --json resolves the seeded scope (no broker needed)', () => {
  const r = runJira(['whoami', '--json'], grantedJiraWorkspace());
  assert.equal(r.status, 0);
  const obj = JSON.parse(r.stdout.trim());
  assert.equal(obj.ok, true);
  assert.equal(obj.scopeId, 'team-x');
});

test('aee-jira: ungranted → exit 3 with not-granted error', () => {
  const r = runJira(['projects', '--json'], ungrantedWorkspace());
  assert.equal(r.status, 3);
  const obj = JSON.parse(r.stdout.trim());
  assert.equal(obj.ok, false);
  assert.equal(obj.error, 'not-granted');
});

test('aee-jira: a granted verb against an unreachable broker → exit 3', () => {
  const verbs = [
    ['projects'], ['list', '--project', 'KAN'], ['show', 'KAN-1'], ['inbox'],
    ['comment', 'KAN-1', '--body', 'x'], ['transition', 'KAN-1', '--to', 'Done'],
  ];
  for (const args of verbs) {
    const r = runJira([...args, '--json'], grantedJiraWorkspace());
    assert.equal(r.status, 3, args.join(' '));
    const obj = JSON.parse(r.stdout.trim());
    assert.equal(obj.error, 'broker-unreachable');
  }
});

test('aee-jira: list without --project / comment without --body → exit 2 (usage), never a broker call', () => {
  assert.equal(runJira(['list', '--json'], grantedJiraWorkspace()).status, 2);
  assert.equal(runJira(['comment', 'KAN-1', '--json'], grantedJiraWorkspace()).status, 2);
  assert.equal(runJira(['transition', 'KAN-1', '--json'], grantedJiraWorkspace()).status, 2);
  assert.equal(runJira(['update', 'KAN-1', '--json'], grantedJiraWorkspace()).status, 2);
});

test('aee-jira: update against an unreachable broker → exit 3 (the verb is wired to a broker call)', () => {
  const r = runJira(['update', 'KAN-1', '--description', 'x', '--json'], grantedJiraWorkspace());
  assert.equal(r.status, 3);
  assert.equal(JSON.parse(r.stdout).error, 'broker-unreachable');
});

test('aee-jira: inbox --consume without ids → exit 2 (usage), never a broker call', () => {
  const r = runJira(['inbox', '--consume', '--json'], grantedJiraWorkspace());
  assert.equal(r.status, 2);
  // argparse's own message names the argument; the help text says where the ids come from
  assert.match(r.stderr, /--consume/);
});

test('aee-jira: inbox --consume <ids> is wired to a broker call (unreachable → exit 3) and inbox --help names the id source', () => {
  const r = runJira(['inbox', '--consume', 'KAN-1:10', 'KAN-2:11', '--json'], grantedJiraWorkspace());
  assert.equal(r.status, 3);
  assert.equal(JSON.parse(r.stdout).error, 'broker-unreachable');
  const h = runJira(['inbox', '--help'], grantedJiraWorkspace());
  assert.equal(h.status, 0);
  assert.match(h.stdout, /EVENT_ID/);
  assert.match(h.stdout, /events\[\]\.id/);
});

test('aee-jira: attachment add with no paths → exit 2 (usage); a nonexistent path → exit 1, never a broker call', () => {
  const ws = grantedJiraWorkspace();
  assert.equal(runJira(['attachment', 'add', 'KAN-1', '--json'], ws).status, 2); // argparse: paths required
  const missing = runJira(['attachment', 'add', 'KAN-1', '/no/such/file.pdf', '--json'], ws);
  assert.equal(missing.status, 1); // client-side path validation, before any upload
  const obj = JSON.parse(missing.stdout.trim());
  assert.equal(obj.ok, false);
  assert.equal(obj.error, 'invalid-path');
  assert.match(obj.message, /\/no\/such\/file\.pdf/);
});

test('aee-jira: attachment add of a real file against an unreachable broker → exit 3 (wired to a broker call)', () => {
  const ws = grantedJiraWorkspace();
  const file = path.join(ws, 'upload-me.txt');
  fs.writeFileSync(file, 'hello');
  const r = runJira(['attachment', 'add', 'KAN-1', file, '--json'], ws);
  assert.equal(r.status, 3, r.stdout + r.stderr);
  const obj = JSON.parse(r.stdout.trim());
  assert.equal(obj.ok, false);
  assert.equal(obj.result.failed, 1);
  assert.equal(obj.result.uploaded, 0);
});

function runJiraAsync(args, workspace, extraEnv = {}) {
  const { spawn } = require('node:child_process');
  return new Promise((resolve) => {
    const child = spawn('python3', [JIRA_CLI, ...args], {
      env: { ...process.env, AEE_WORKSPACE: workspace, ...extraEnv },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

test('aee-jira: a broker 4xx surfaces its `message`, not just the bare `error` code', async () => {
  // A stub broker in-process; spawnSync would block the event loop and the
  // CLI's request could never be answered (see captureBroker() above) — spawn
  // asynchronously instead.
  const http = require('node:http');
  const server = http.createServer((req, res) => {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      error: 'consume-requires-ids',
      message: 'consume takes the event ids you were woken for: aee-jira inbox --consume <event-id>',
    }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    const r = await runJiraAsync(['inbox', '--consume', 'KAN-1:1', '--json'], grantedJiraWorkspace(`http://127.0.0.1:${port}/`));
    assert.equal(r.status, 1, r.stdout + r.stderr);
    const obj = JSON.parse(r.stdout.trim());
    assert.equal(obj.ok, false);
    assert.match(obj.message, /--consume <event-id>/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('aee-jira forwards the agent caller token (#2562) and surfaces a refusal message verbatim', async () => {
  const http = require('node:http');
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(req.headers['x-aee-agent-token']);
    res.statusCode = 424;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      code: 'personal-credential-required',
      error: 'You have no personal Jira credential yet. … Connections → Plugin Tokens (/plugin-tokens) … Nothing was sent to Jira.',
    }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    const ws = grantedJiraWorkspace(`http://127.0.0.1:${port}/`);
    const r = await runJiraAsync(['projects', '--json'], ws, { AEE_AGENT_CALLER_TOKEN: 'aeecall1.YWdlbnQ.sig' });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.deepEqual(seen, ['aeecall1.YWdlbnQ.sig']);
    const obj = JSON.parse(r.stdout.trim());
    assert.match(obj.message, /\/plugin-tokens/);
    // without the env var no header is sent (the broker then refuses)
    await runJiraAsync(['projects', '--json'], ws, { AEE_AGENT_CALLER_TOKEN: '' });
    assert.equal(seen[1], undefined);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
