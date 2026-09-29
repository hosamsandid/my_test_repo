'use strict';

// Behavioural tests for the per-agent MCP materialization (#2289): stanza
// resolution (ported from scripts/test-mcp/test-seed-path.js, which used to
// slice the function out of orchestrator.js), the reconciling two-file write,
// and the apply/fan-out decisions.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  MCP_RESEED_PATHS,
  effectiveMcpRefs,
  buildMcpStanzas,
  reconcileMcpConfig,
  readSeededMcp,
  writeAgentMcpConfig,
  describeApplyOutcome,
  planEnvironmentMcpApply,
  summarizeMcpApply,
} = require('./mcp-seed');

function mkRegistry() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-seed-'));
  const serversDir = path.join(root, 'mcp-servers');
  const credentialsKeysDir = path.join(root, 'mcp-credentials', '_keys');
  const server = (id, def) => {
    fs.mkdirSync(path.join(serversDir, id), { recursive: true });
    fs.writeFileSync(path.join(serversDir, id, 'server.json'), JSON.stringify({ id, ...def }));
  };
  server('wiki', {
    transport: 'stdio', command: 'node', args: ['/srv/wiki.js'],
    env: { WIKI_BASE_URL: 'https://wiki/api', WIKI_TOKEN: '${credential}' },
  });
  server('noauth', { transport: 'stdio', command: 'node', args: ['/srv/p.js'], env: { READ_ONLY: 'true' } });
  server('remote', { transport: 'http', url: 'https://mcp.example/api', headers: { Authorization: 'Bearer ${credential}' } });
  server('sse-remote', {
    transport: 'sse', url: 'https://mcp.example/sse',
    headers: { Authorization: 'Bearer ${credential}', 'X-Source': 'aee' },
  });
  server('weird', { transport: 'carrier-pigeon' });
  fs.mkdirSync(credentialsKeysDir, { recursive: true });
  fs.writeFileSync(path.join(credentialsKeysDir, 'wiki-secret'), 'TOP_SECRET\n');
  fs.writeFileSync(path.join(credentialsKeysDir, 'remote-key'), 'remote-bearer\n');
  return { root, dirs: { serversDir, credentialsKeysDir } };
}

function mkAgent(root, name) {
  const dest = path.join(root, 'agents', name);
  fs.mkdirSync(path.join(dest, '.claude'), { recursive: true });
  return { dest, stateDir: path.join(dest, '.agent-studio') };
}

const readJson = p => JSON.parse(fs.readFileSync(p, 'utf8'));

// ── effectiveMcpRefs ────────────────────────────────────────────────────────

test('effectiveMcpRefs: an override wins verbatim, an empty override is kept, else the env list', () => {
  const env = { mcpServers: [{ serverId: 'wiki', credentialId: null }] };
  assert.deepEqual(effectiveMcpRefs({ mcpServersOverride: [{ serverId: 'noauth' }] }, env), [{ serverId: 'noauth' }]);
  assert.deepEqual(effectiveMcpRefs({ mcpServersOverride: [] }, env), [], 'empty override = no servers, not inherit');
  assert.deepEqual(effectiveMcpRefs({}, env), env.mcpServers);
  assert.deepEqual(effectiveMcpRefs({}, null), []);
});

// ── buildMcpStanzas ─────────────────────────────────────────────────────────

test('buildMcpStanzas: stdio substitutes the credential into env and emits no type field', () => {
  const { dirs } = mkRegistry();
  const warnings = [];
  const { stanzas, seeded } = buildMcpStanzas([{ serverId: 'wiki', credentialId: 'wiki-secret' }], dirs, warnings);
  assert.deepEqual(seeded, ['wiki']);
  assert.deepEqual(warnings, []);
  assert.deepEqual(stanzas.wiki, {
    command: 'node', args: ['/srv/wiki.js'],
    env: { WIKI_BASE_URL: 'https://wiki/api', WIKI_TOKEN: 'TOP_SECRET' },
  });
});

test('buildMcpStanzas: http/sse emit {type, url, headers}, non-credential headers pass through', () => {
  const { dirs } = mkRegistry();
  const { stanzas } = buildMcpStanzas([
    { serverId: 'remote', credentialId: 'remote-key' },
    { serverId: 'sse-remote', credentialId: 'remote-key' },
  ], dirs, []);
  assert.deepEqual(stanzas.remote, { type: 'http', url: 'https://mcp.example/api', headers: { Authorization: 'Bearer remote-bearer' } });
  assert.deepEqual(stanzas['sse-remote'], {
    type: 'sse', url: 'https://mcp.example/sse',
    headers: { Authorization: 'Bearer remote-bearer', 'X-Source': 'aee' },
  });
});

test('buildMcpStanzas: a missing credential drops the placeholder key, never leaks ${credential}', () => {
  const { dirs } = mkRegistry();
  const warnings = [];
  const { stanzas } = buildMcpStanzas([{ serverId: 'wiki', credentialId: null }], dirs, warnings);
  assert.deepEqual(stanzas.wiki.env, { WIKI_BASE_URL: 'https://wiki/api' });
  assert.ok(warnings.some(w => /uses \$\{credential\} but no credential/.test(w)));
});

test('buildMcpStanzas: a credential on a template with no placeholder is ignored with a warning', () => {
  const { dirs } = mkRegistry();
  const warnings = [];
  const { stanzas } = buildMcpStanzas([{ serverId: 'noauth', credentialId: 'wiki-secret' }], dirs, warnings);
  assert.deepEqual(stanzas.noauth.env, { READ_ONLY: 'true' });
  assert.ok(warnings.some(w => /no \$\{credential\} placeholder/.test(w)));
});

test('buildMcpStanzas: unresolvable refs are skipped with a warning each', () => {
  const { dirs } = mkRegistry();
  const warnings = [];
  const { stanzas, seeded } = buildMcpStanzas([
    { serverId: 'no-such' },
    { serverId: '../etc' },
    { serverId: 'wiki', credentialId: '../etc/passwd' },
    { serverId: 'wiki', credentialId: 'no-such-cred' },
    { serverId: 'weird' },
  ], dirs, warnings);
  assert.deepEqual(seeded, []);
  assert.deepEqual(stanzas, {});
  for (const re of [/not found in registry/, /invalid serverId/, /invalid credentialId/, /cannot read credential/, /unsupported transport/]) {
    assert.ok(warnings.some(w => re.test(w)), `expected a warning matching ${re}`);
  }
});

// ── reconcileMcpConfig (pure) ───────────────────────────────────────────────

test('reconcileMcpConfig: writes wanted servers and enables them', () => {
  const r = reconcileMcpConfig({ mcpJson: {}, settings: {}, previous: [], stanzas: { wiki: { command: 'x' } } });
  assert.deepEqual(r.mcpJson, { mcpServers: { wiki: { command: 'x' } } });
  assert.deepEqual(r.settings, { enabledMcpjsonServers: ['wiki'] });
  assert.deepEqual(r.seeded, ['wiki']);
});

test('reconcileMcpConfig: a previously seeded server that is no longer wanted is removed (AC7)', () => {
  const r = reconcileMcpConfig({
    mcpJson: { mcpServers: { wiki: { command: 'x' }, graph: { command: 'y' } } },
    settings: { enabledMcpjsonServers: ['wiki', 'graph'] },
    previous: ['wiki', 'graph'],
    stanzas: { wiki: { command: 'x2' } },
  });
  assert.deepEqual(r.mcpJson.mcpServers, { wiki: { command: 'x2' } });
  assert.deepEqual(r.settings.enabledMcpjsonServers, ['wiki']);
  assert.deepEqual(r.removed, ['graph']);
});

test('reconcileMcpConfig: an explicit empty set removes every seeded server (AC8)', () => {
  const r = reconcileMcpConfig({
    mcpJson: { mcpServers: { wiki: {} } },
    settings: { enabledMcpjsonServers: ['wiki'] },
    previous: ['wiki'],
    stanzas: {},
  });
  assert.deepEqual(r.mcpJson, { mcpServers: {} });
  assert.deepEqual(r.settings.enabledMcpjsonServers, []);
});

test('reconcileMcpConfig: never touches entries or keys the platform did not seed (AC11)', () => {
  const r = reconcileMcpConfig({
    mcpJson: { mcpServers: { mine: { command: 'op' }, wiki: {} }, other: 1 },
    settings: { theme: 'dark', permissions: { allow: ['x'] }, enabledMcpjsonServers: ['mine', 'wiki'], mcpServers: { legacy: {} } },
    previous: ['wiki'],
    stanzas: {},
  });
  assert.deepEqual(r.mcpJson, { mcpServers: { mine: { command: 'op' } }, other: 1 });
  assert.deepEqual(r.settings, {
    theme: 'dark', permissions: { allow: ['x'] }, enabledMcpjsonServers: ['mine'], mcpServers: { legacy: {} },
  });
});

test('reconcileMcpConfig: nothing to enable and no key before → the key is not introduced', () => {
  const r = reconcileMcpConfig({ mcpJson: {}, settings: { theme: 'dark' }, previous: [], stanzas: {} });
  assert.deepEqual(r.settings, { theme: 'dark' });
});

test('reconcileMcpConfig: does not mutate its inputs', () => {
  const mcpJson = { mcpServers: { wiki: {} } };
  const settings = { enabledMcpjsonServers: ['wiki'] };
  reconcileMcpConfig({ mcpJson, settings, previous: ['wiki'], stanzas: {} });
  assert.deepEqual(mcpJson, { mcpServers: { wiki: {} } });
  assert.deepEqual(settings, { enabledMcpjsonServers: ['wiki'] });
});

// ── writeAgentMcpConfig (fs) ────────────────────────────────────────────────

test('writeAgentMcpConfig: an agent with no MCP servers gets no .mcp.json and an untouched settings.json', () => {
  const { root } = mkRegistry();
  const { dest, stateDir } = mkAgent(root, 'a0');
  fs.writeFileSync(path.join(dest, '.claude', 'settings.json'), '{"theme":"dark"}');
  const r = writeAgentMcpConfig(dest, {}, [], { stateDir });
  assert.equal(r.ok, true);
  assert.equal(fs.existsSync(path.join(dest, '.mcp.json')), false);
  assert.deepEqual(readJson(path.join(dest, '.claude', 'settings.json')), { theme: 'dark' });
  assert.deepEqual(readSeededMcp(stateDir), [], 'the manifest is written even when empty');
});

test('writeAgentMcpConfig: seed, change, remove — end to end across both files and the manifest', () => {
  const { root, dirs } = mkRegistry();
  const { dest, stateDir } = mkAgent(root, 'a1');
  const settingsPath = path.join(dest, '.claude', 'settings.json');
  const mcpPath = path.join(dest, '.mcp.json');
  fs.writeFileSync(settingsPath, JSON.stringify({ theme: 'dark' }));

  const seed = refs => writeAgentMcpConfig(dest, buildMcpStanzas(refs, dirs, []).stanzas, [], { stateDir });

  assert.equal(seed([{ serverId: 'wiki', credentialId: 'wiki-secret' }, { serverId: 'noauth' }]).ok, true);
  assert.deepEqual(Object.keys(readJson(mcpPath).mcpServers), ['wiki', 'noauth']);
  assert.deepEqual(readJson(settingsPath), { theme: 'dark', enabledMcpjsonServers: ['wiki', 'noauth'] });
  assert.equal(readJson(settingsPath).mcpServers, undefined, 'stanzas no longer go into settings.json');
  assert.deepEqual(readSeededMcp(stateDir), ['wiki', 'noauth']);

  // An operator adds their own server by hand in between.
  const hand = readJson(mcpPath);
  hand.mcpServers.mine = { command: 'op' };
  fs.writeFileSync(mcpPath, JSON.stringify(hand));

  // Credential change on one, the other dropped.
  const r = seed([{ serverId: 'wiki', credentialId: 'remote-key' }]);
  assert.deepEqual(r.removed, ['noauth']);
  assert.equal(readJson(mcpPath).mcpServers.wiki.env.WIKI_TOKEN, 'remote-bearer');
  assert.deepEqual(Object.keys(readJson(mcpPath).mcpServers).sort(), ['mine', 'wiki']);
  assert.deepEqual(readJson(settingsPath).enabledMcpjsonServers, ['wiki']);

  // Explicit empty set: our server goes, the operator's stays, the file stays.
  seed([]);
  assert.deepEqual(readJson(mcpPath).mcpServers, { mine: { command: 'op' } });
  assert.deepEqual(readJson(settingsPath), { theme: 'dark', enabledMcpjsonServers: [] });
  assert.deepEqual(readSeededMcp(stateDir), []);
});

test('writeAgentMcpConfig: a server removed from the registry is dropped from the agent on the next apply', () => {
  const { root, dirs } = mkRegistry();
  const { dest, stateDir } = mkAgent(root, 'a2');
  writeAgentMcpConfig(dest, buildMcpStanzas([{ serverId: 'noauth' }], dirs, []).stanzas, [], { stateDir });
  fs.rmSync(path.join(dirs.serversDir, 'noauth'), { recursive: true });
  const warnings = [];
  writeAgentMcpConfig(dest, buildMcpStanzas([{ serverId: 'noauth' }], dirs, warnings).stanzas, warnings, { stateDir });
  assert.deepEqual(readJson(path.join(dest, '.mcp.json')).mcpServers, {});
  assert.ok(warnings.some(w => /not found in registry/.test(w)));
});

test('writeAgentMcpConfig: an unparseable settings.json or .mcp.json is left alone, not overwritten', () => {
  const { root } = mkRegistry();
  for (const [file, rel] of [['settings', path.join('.claude', 'settings.json')], ['mcp', '.mcp.json']]) {
    const { dest, stateDir } = mkAgent(root, `broken-${file}`);
    fs.writeFileSync(path.join(dest, rel), '{ not json');
    const warnings = [];
    const r = writeAgentMcpConfig(dest, { wiki: { command: 'x' } }, warnings, { stateDir });
    assert.equal(r.ok, false);
    assert.match(r.error, /cannot parse/);
    assert.equal(fs.readFileSync(path.join(dest, rel), 'utf8'), '{ not json');
    assert.equal(fs.existsSync(path.join(stateDir, 'seeded-mcp.json')), false, 'no manifest for a write that did not happen');
    assert.ok(warnings.length > 0);
  }
});

// ── apply outcome + environment fan-out ─────────────────────────────────────

test('MCP_RESEED_PATHS names exactly the two files an apply rewrites', () => {
  assert.deepEqual(MCP_RESEED_PATHS, ['.mcp.json', '.claude/settings.json']);
});

test('describeApplyOutcome: maps the write + volume-mirror result', () => {
  const ok = { ok: true, seeded: ['wiki'] };
  assert.equal(describeApplyOutcome('a', ok, { skipped: 'flag-off' }).status, 'applied', 'shared volume: the file is live');
  assert.equal(describeApplyOutcome('a', ok, { ok: true }).status, 'applied');
  assert.equal(describeApplyOutcome('a', ok, { skipped: 'not-running' }).status, 'stored');
  const failedMirror = describeApplyOutcome('a', ok, { error: 'boom' });
  assert.equal(failedMirror.status, 'failed');
  assert.match(failedMirror.detail, /boom/);
  const failedWrite = describeApplyOutcome('a', { ok: false, error: 'cannot parse x' }, null);
  assert.deepEqual(failedWrite, { id: 'a', status: 'failed', detail: 'cannot parse x' });
});

test('planEnvironmentMcpApply: bound agents only; overrides kept, stubs pending, the team record skipped', () => {
  const plan = planEnvironmentMcpApply([
    { id: 'team', cfg: { role: 'team', environmentId: 'env-a' } },
    { id: 'm1', cfg: { role: 'team-member', environmentId: 'env-a', token: 't' } },
    { id: 'm2', cfg: { role: 'team-member', environmentId: 'env-a', token: 't', mcpServersOverride: [] } },
    { id: 'm3', cfg: { role: 'team-member', environmentId: 'env-a' } },
    { id: 'other', cfg: { role: 'team-member', environmentId: 'env-b', token: 't' } },
    { id: 'broken', cfg: null },
  ], 'env-a');
  assert.deepEqual(plan, [
    { id: 'm1', action: 'apply' },
    { id: 'm2', action: 'keep-override' },
    { id: 'm3', action: 'pending' },
  ]);
});

test('summarizeMcpApply: every agent lands in exactly one bucket, failures keep their reason', () => {
  assert.deepEqual(summarizeMcpApply([
    { id: 'a', status: 'applied' },
    { id: 'b', status: 'stored' },
    { id: 'c', status: 'pending' },
    { id: 'd', status: 'keep-override' },
    { id: 'e', status: 'failed', detail: 'boom' },
  ]), {
    applied: ['a'], stored: ['b'], pending: ['c'], keptOverride: ['d'], failed: [{ id: 'e', error: 'boom' }],
  });
});
