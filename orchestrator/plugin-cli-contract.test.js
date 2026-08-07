'use strict';

// End-to-end CLI-contract enforcement (plugin system Phase 2, #1518).
//
// The concept (§4.5) makes the seeded CLI facade a hard contract: a
// dependency-free single file, `--json` on every subcommand, exit codes
// 0 ok / 1 domain error / 2 usage / 3 broker unreachable, and `--help` carrying
// the agent-readable docs. Phase 2 is where that contract is *enforced*, so we
// drive the reference plugin's actual CLI (plugins/dummy-echo) through it —
// python3 is present in the agent image and the test host — reading its config
// from the exact `.aee/plugins/<id>.json` shape plugin-sync.js plans.

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
  fs.mkdirSync(path.join(dir, '.aee', 'plugins'), { recursive: true });
  const cfg = pluginConfigFile({
    pluginId: 'dummy-echo', scopeId: 't1', endpoint: 'http://aee-plugin-dummy-echo:8080',
    token: 'dummy-echo.t1.SIG', cliName: 'aee-echo',
  });
  fs.writeFileSync(path.join(dir, '.aee', 'plugins', 'dummy-echo.json'), JSON.stringify(cfg), { mode: 0o600 });
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
