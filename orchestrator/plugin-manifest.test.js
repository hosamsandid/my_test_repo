'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {
  validatePluginManifest,
  grantableGranularities,
  defaultGranularity,
  assertGranularityGrantable,
  isValidCapability,
} = require('./plugin-manifest');

test('two-sided guard: orchestrator copy is byte-identical to admin-console canonical', () => {
  const here = fs.readFileSync(path.join(__dirname, 'plugin-manifest.js'));
  const there = fs.readFileSync(path.join(__dirname, '..', 'admin-console', 'api', 'plugin-manifest.js'));
  assert.ok(here.equals(there), 'orchestrator/plugin-manifest.js and admin-console/api/plugin-manifest.js must be identical');
});

// A minimal valid manifest we clone-and-mutate per case.
function base() {
  return {
    pluginVersion: 1,
    id: 'podman-sandbox',
    name: 'Podman Container Sandbox',
    description: 'Agents spawn and manage their own compose stacks.',
    sidecar: { image: 'aee-plugin-podman:latest', capabilities: ['podman-socket'], internalPort: 4004 },
    cli: { name: 'aee-podman', entrypoint: 'bin/aee-podman.py', runtime: 'python3' },
    credentials: [{ key: 'api-token', description: 'Backend API token', required: true }],
    platforms: ['podman'],
    scopes: ['team', 'agent'],
    requiresApproval: ['compose up', 'rm'],
    ui: { title: 'Sandbox Dashboard', routes: [{ path: '/', minRole: 'team-member' }, { path: '/admin', minRole: 'team-admin' }] },
    companionSkill: 'batch-parity-testing',
    promptLine: 'You can spawn containers with `aee-podman`.',
  };
}

test('accepts a complete valid manifest and normalizes it', () => {
  const { ok, errors, manifest } = validatePluginManifest(base());
  assert.deepEqual(errors, []);
  assert.equal(ok, true);
  assert.equal(manifest.pluginVersion, 1);
  assert.equal(manifest.id, 'podman-sandbox');
  assert.deepEqual(manifest.scopes, ['team', 'agent']);
  assert.deepEqual(manifest.sidecar.capabilities, ['podman-socket']);
  assert.equal(manifest.ui.routes.length, 2);
  assert.equal(manifest.credentials[0].required, true);
});

test('accepts a minimal manifest and fills defaults', () => {
  const { ok, manifest } = validatePluginManifest({
    pluginVersion: 1,
    id: 'x',
    name: 'X',
    description: 'd',
    sidecar: { image: 'img:1', internalPort: 8080 },
    cli: { name: 'aee-x', entrypoint: 'bin/x.js', runtime: 'node' },
  });
  assert.equal(ok, true);
  assert.deepEqual(manifest.platforms, ['any']);
  assert.deepEqual(manifest.scopes, ['team']);
  assert.deepEqual(manifest.credentials, []);
  assert.deepEqual(manifest.requiresApproval, []);
  assert.deepEqual(manifest.sidecar.capabilities, []);
  assert.equal('ui' in manifest, false);
});

test('rejects non-object input', () => {
  assert.equal(validatePluginManifest(null).ok, false);
  assert.equal(validatePluginManifest('nope').ok, false);
  assert.equal(validatePluginManifest([]).ok, false);
});

test('rejects wrong pluginVersion / bad id / missing name', () => {
  const r = validatePluginManifest({ ...base(), pluginVersion: 2, id: 'Bad Id', name: '' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /pluginVersion/.test(e)));
  assert.ok(r.errors.some((e) => /id must be a slug/.test(e)));
  assert.ok(r.errors.some((e) => /name is required/.test(e)));
});

test('rejects missing/invalid sidecar', () => {
  assert.ok(validatePluginManifest({ ...base(), sidecar: undefined }).errors.some((e) => /sidecar is required/.test(e)));
  const noPort = validatePluginManifest({ ...base(), sidecar: { image: 'i:1' } });
  assert.ok(noPort.errors.some((e) => /internalPort/.test(e)));
  const badPort = validatePluginManifest({ ...base(), sidecar: { image: 'i:1', internalPort: 70000 } });
  assert.ok(badPort.errors.some((e) => /internalPort/.test(e)));
});

test('rejects unknown sidecar capability but accepts host-mount', () => {
  const bad = validatePluginManifest({ ...base(), sidecar: { image: 'i:1', internalPort: 1, capabilities: ['root-fs'] } });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e) => /unknown entries/.test(e)));

  const good = validatePluginManifest({ ...base(), sidecar: { image: 'i:1', internalPort: 1, capabilities: ['host-mount:/srv/data', 'egress'] } });
  assert.equal(good.ok, true);
  assert.deepEqual(good.manifest.sidecar.capabilities, ['host-mount:/srv/data', 'egress']);
});

test('isValidCapability guards host-mount path traversal + relative paths', () => {
  assert.equal(isValidCapability('podman-socket'), true);
  assert.equal(isValidCapability('egress'), true);
  assert.equal(isValidCapability('host-mount:/srv/x'), true);
  assert.equal(isValidCapability('host-mount:relative'), false);
  assert.equal(isValidCapability('host-mount:/a/../etc'), false);
  assert.equal(isValidCapability('host-mount:/'), false);
  assert.equal(isValidCapability('nonsense'), false);
});

test('rejects invalid cli (bad runtime, absolute/traversal entrypoint)', () => {
  assert.ok(validatePluginManifest({ ...base(), cli: { name: 'x', entrypoint: 'bin/x', runtime: 'ruby' } }).errors.some((e) => /cli.runtime/.test(e)));
  assert.ok(validatePluginManifest({ ...base(), cli: { name: 'x', entrypoint: '/etc/passwd', runtime: 'node' } }).errors.some((e) => /entrypoint/.test(e)));
  assert.ok(validatePluginManifest({ ...base(), cli: { name: 'x', entrypoint: '../x', runtime: 'node' } }).errors.some((e) => /entrypoint/.test(e)));
});

// ── ACCEPTANCE: grant-able granularity absent from `scopes` ──────────────────
test('rejects scopes with an unknown granularity', () => {
  const r = validatePluginManifest({ ...base(), scopes: ['team', 'organization'] });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /unknown granularities/.test(e)));
});

test('rejects scopes missing the mandatory "team" default', () => {
  const r = validatePluginManifest({ ...base(), scopes: ['agent'] });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /must include "team"/.test(e)));
});

test('assertGranularityGrantable rejects a granularity absent from scopes', () => {
  const teamOnly = validatePluginManifest({ ...base(), scopes: ['team'] }).manifest;
  assert.equal(assertGranularityGrantable(teamOnly, 'team'), null);
  assert.ok(/does not honour/.test(assertGranularityGrantable(teamOnly, 'agent')));

  const both = validatePluginManifest(base()).manifest;
  assert.equal(assertGranularityGrantable(both, 'agent'), null);

  assert.ok(/unknown scope granularity/.test(assertGranularityGrantable(both, 'galaxy')));
  assert.deepEqual(grantableGranularities(teamOnly), ['team']);
});

// ── ACCEPTANCE: ui.routes entry with an unknown minRole ──────────────────────
test('rejects a ui.routes entry with an unknown minRole', () => {
  const r = validatePluginManifest({ ...base(), ui: { routes: [{ path: '/', minRole: 'superuser' }] } });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /unknown role "superuser"/.test(e)));
});

test('rejects ui.routes path without leading slash and duplicate paths', () => {
  assert.ok(validatePluginManifest({ ...base(), ui: { routes: [{ path: 'admin', minRole: 'team-admin' }] } }).errors.some((e) => /path must be/.test(e)));
  assert.ok(validatePluginManifest({ ...base(), ui: { routes: [{ path: '/', minRole: 'team-member' }, { path: '/', minRole: 'team-admin' }] } }).errors.some((e) => /duplicate ui.routes path/.test(e)));
});

// ── ui.global opt-in visibility flag (#1599) ─────────────────────────────────
test('ui.global true is accepted and preserved', () => {
  const r = validatePluginManifest({ ...base(), ui: { title: 'Catalog', global: true, routes: [{ path: '/', minRole: 'team-member' }] } });
  assert.deepEqual(r.errors, []);
  assert.equal(r.ok, true);
  assert.equal(r.manifest.ui.global, true);
});

test('ui.global absent or false normalizes byte-identically to today (default off)', () => {
  // Absent → no `global` key at all (no regression for existing plugins).
  const absent = validatePluginManifest({ ...base(), ui: { title: 'X', routes: [{ path: '/', minRole: 'team-member' }] } });
  assert.equal(absent.ok, true);
  assert.equal('global' in absent.manifest.ui, false);
  // Explicit false is also dropped, so the normalized shape equals the absent one.
  const off = validatePluginManifest({ ...base(), ui: { title: 'X', global: false, routes: [{ path: '/', minRole: 'team-member' }] } });
  assert.equal(off.ok, true);
  assert.equal('global' in off.manifest.ui, false);
  assert.deepEqual(off.manifest.ui, absent.manifest.ui);
});

test('rejects a non-boolean ui.global', () => {
  const r = validatePluginManifest({ ...base(), ui: { global: 'yes', routes: [{ path: '/', minRole: 'team-member' }] } });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /ui.global must be a boolean/.test(e)));
});

test('rejects duplicate credential keys and non-string env values', () => {
  assert.ok(validatePluginManifest({ ...base(), credentials: [{ key: 'a' }, { key: 'a' }] }).errors.some((e) => /duplicate credential key/.test(e)));
  assert.ok(validatePluginManifest({ ...base(), sidecar: { image: 'i:1', internalPort: 1, env: { N: 5 } } }).errors.some((e) => /env values must all be strings/.test(e)));
});

test('rejects unknown platforms', () => {
  assert.ok(validatePluginManifest({ ...base(), platforms: ['k8s'] }).errors.some((e) => /platforms has unknown/.test(e)));
});

test('accepts kubernetes alone', () => {
  const { ok, errors, manifest } = validatePluginManifest({ ...base(), platforms: ['kubernetes'] });
  assert.deepEqual(errors, []);
  assert.equal(ok, true);
  assert.deepEqual(manifest.platforms, ['kubernetes']);
});

test('accepts podman + kubernetes combined', () => {
  const { ok, errors, manifest } = validatePluginManifest({ ...base(), platforms: ['podman', 'kubernetes'] });
  assert.deepEqual(errors, []);
  assert.equal(ok, true);
  assert.deepEqual(manifest.platforms, ['podman', 'kubernetes']);
});

// ── defaultScopeGranularity (§4.4/§10 decision: per-manifest default) ─────────
test('accepts a defaultScopeGranularity within scopes and normalizes it', () => {
  const { ok, manifest } = validatePluginManifest({ ...base(), defaultScopeGranularity: 'agent' });
  assert.equal(ok, true);
  assert.equal(manifest.defaultScopeGranularity, 'agent');
  assert.equal(defaultGranularity(manifest), 'agent');
});

test('rejects a defaultScopeGranularity outside scopes or unknown', () => {
  const notInScopes = validatePluginManifest({ ...base(), scopes: ['team'], defaultScopeGranularity: 'agent' });
  assert.equal(notInScopes.ok, false);
  assert.ok(notInScopes.errors.some((e) => /not in scopes/.test(e)));

  const unknown = validatePluginManifest({ ...base(), defaultScopeGranularity: 'galaxy' });
  assert.equal(unknown.ok, false);
  assert.ok(unknown.errors.some((e) => /unknown granularity/.test(e)));
});

test('defaultGranularity falls back to team when unset (platform default)', () => {
  const noDefault = validatePluginManifest(base()).manifest;
  assert.equal('defaultScopeGranularity' in noDefault, false);
  assert.equal(defaultGranularity(noDefault), 'team');
  assert.equal(defaultGranularity(null), 'team');
  assert.equal(defaultGranularity({}), 'team');
});

// ── quota (§4.6: per-scope resource cap) ─────────────────────────────────────
test('accepts a valid quota and normalizes it', () => {
  const { ok, manifest } = validatePluginManifest({ ...base(), quota: { maxObjects: 8, ttlSeconds: 86400 } });
  assert.equal(ok, true);
  assert.deepEqual(manifest.quota, { maxObjects: 8, ttlSeconds: 86400 });

  const noTtl = validatePluginManifest({ ...base(), quota: { maxObjects: 3 } }).manifest;
  assert.deepEqual(noTtl.quota, { maxObjects: 3 });

  assert.equal('quota' in validatePluginManifest(base()).manifest, false);
});

test('rejects a malformed quota', () => {
  assert.ok(validatePluginManifest({ ...base(), quota: 5 }).errors.some((e) => /quota must be an object/.test(e)));
  assert.ok(validatePluginManifest({ ...base(), quota: { maxObjects: 0 } }).errors.some((e) => /maxObjects must be a positive integer/.test(e)));
  assert.ok(validatePluginManifest({ ...base(), quota: { maxObjects: 2.5 } }).errors.some((e) => /maxObjects must be a positive integer/.test(e)));
  assert.ok(validatePluginManifest({ ...base(), quota: { maxObjects: 2, ttlSeconds: -1 } }).errors.some((e) => /ttlSeconds must be a positive integer/.test(e)));
});

// ── policy (per-subcommand authorization keyed on scope, #1521) ──────────────
test('accepts a valid policy and normalizes each rule', () => {
  const { ok, errors, manifest } = validatePluginManifest({
    ...base(),
    scopes: ['team', 'agent'],
    policy: {
      'create-case': { scopes: ['agent'], requiresFlowFinal: true },
      'delete-data': { scopes: ['agent'] },
    },
  });
  assert.deepEqual(errors, []);
  assert.equal(ok, true);
  assert.deepEqual(manifest.policy['create-case'], { scopes: ['agent'], requiresFlowFinal: true });
  assert.deepEqual(manifest.policy['delete-data'], { scopes: ['agent'] });
});

test('a manifest without policy has none on the normalized shape', () => {
  const { ok, manifest } = validatePluginManifest(base());
  assert.equal(ok, true);
  assert.equal('policy' in manifest, false);
});

test('rejects policy scopes outside the plugin scopes', () => {
  const r = validatePluginManifest({
    ...base(),
    scopes: ['team'],
    policy: { 'x': { scopes: ['agent'] } },
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /not in the plugin's scopes/.test(e)));
});

test('rejects an unknown policy granularity', () => {
  const r = validatePluginManifest({ ...base(), policy: { 'x': { scopes: ['squad'] } } });
  assert.ok(r.errors.some((e) => /unknown granularities/.test(e)));
});

test('rejects requiresFlowFinal when the rule admits team granularity', () => {
  // Explicitly including team.
  const r1 = validatePluginManifest({
    ...base(), scopes: ['team', 'agent'],
    policy: { 'x': { scopes: ['team', 'agent'], requiresFlowFinal: true } },
  });
  assert.ok(r1.errors.some((e) => /only expressible at agent granularity/.test(e)));
  // No explicit scopes → defaults to all the plugin's scopes, which include team.
  const r2 = validatePluginManifest({
    ...base(), scopes: ['team', 'agent'],
    policy: { 'x': { requiresFlowFinal: true } },
  });
  assert.ok(r2.errors.some((e) => /only expressible at agent granularity/.test(e)));
});

test('rejects malformed policy shapes', () => {
  assert.ok(validatePluginManifest({ ...base(), policy: 5 }).errors.some((e) => /policy must be an object/.test(e)));
  assert.ok(validatePluginManifest({ ...base(), policy: { x: 3 } }).errors.some((e) => /must be an object/.test(e)));
  assert.ok(validatePluginManifest({ ...base(), policy: { x: { requiresFlowFinal: 'yes' } } }).errors.some((e) => /must be a boolean/.test(e)));
  assert.ok(validatePluginManifest({ ...base(), policy: { x: { scopes: [] } } }).errors.some((e) => /non-empty array/.test(e)));
});

// ── ACCEPTANCE: the shipped plugin #1 manifest validates end to end ──────────
test('the shipped podman-sandbox manifest (plugins/podman-sandbox) is valid', () => {
  const p = path.join(__dirname, '..', 'plugins', 'podman-sandbox', 'plugin.json');
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  const { ok, errors, manifest } = validatePluginManifest(raw);
  assert.deepEqual(errors, []);
  assert.equal(ok, true);
  // It is the case that forces the §10 default-granularity decision: agent.
  assert.equal(defaultGranularity(manifest), 'agent');
  assert.deepEqual(manifest.scopes, ['team', 'agent']);
  assert.deepEqual(manifest.sidecar.capabilities, ['podman-socket']);
  assert.equal(manifest.quota.maxObjects >= 1, true);
  assert.equal(manifest.cli.name, 'aee-podman');
});

// ── ACCEPTANCE: the shipped plugin #2 manifest validates end to end ──────────
test('the shipped test-mgmt manifest (plugins/test-mgmt) is valid', () => {
  const p = path.join(__dirname, '..', 'plugins', 'test-mgmt', 'plugin.json');
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  const { ok, errors, manifest } = validatePluginManifest(raw);
  assert.deepEqual(errors, []);
  assert.equal(ok, true);
  // Like the sandbox, it declares agent as the §10 per-manifest default.
  assert.equal(defaultGranularity(manifest), 'agent');
  assert.deepEqual(manifest.scopes, ['team', 'agent']);
  assert.equal(manifest.cli.name, 'aee-test');
  // Phase-5 firsts exercised through the real validator on the real file:
  // (1) authorisation-by-granularity — the per-subcommand `policy` field.
  assert.equal(manifest.policy['create-case'].requiresFlowFinal, true);
  assert.deepEqual(manifest.policy['create-case'].scopes, ['agent']);
  assert.deepEqual(manifest.policy['data-delete'].scopes, ['agent']);
  // (2) the UI-extension surface — `ui.routes[].minRole` reserved contract.
  assert.equal(manifest.ui.routes.length >= 1, true);
  assert.ok(manifest.ui.routes.every((r) => typeof r.minRole === 'string' && r.path.startsWith('/')));
  const adminRoute = manifest.ui.routes.find((r) => r.path === '/admin');
  assert.equal(adminRoute && adminRoute.minRole, 'team-admin');
});

// ── ACCEPTANCE: the shipped plugin #3 manifest validates end to end ──────────
test('the shipped netzplan manifest (plugins/netzplan) is valid', () => {
  const p = path.join(__dirname, '..', 'plugins', 'netzplan', 'plugin.json');
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  const { ok, errors, manifest } = validatePluginManifest(raw);
  assert.deepEqual(errors, []);
  assert.equal(ok, true);
  // netzplan is the first privilege-less plugin — capabilities and credentials are empty:
  assert.deepEqual(manifest.sidecar.capabilities, []);
  assert.deepEqual(manifest.credentials, []);
  // team scope only → team is the §10 per-manifest default granularity:
  assert.deepEqual(manifest.scopes, ['team']);
  assert.equal(defaultGranularity(manifest), 'team');
  assert.equal(manifest.cli.name, 'aee-plan');
  // two ui.routes wired to the right minRole:
  const board = manifest.ui.routes.find((r) => r.path === '/');
  assert.equal(board && board.minRole, 'team-member');
  const admin = manifest.ui.routes.find((r) => r.path === '/admin');
  assert.equal(admin && admin.minRole, 'team-admin');
});

// ── ACCEPTANCE: the shipped patterns-catalog manifest validates end to end ───
test('the shipped patterns-catalog manifest (plugins/patterns-catalog) is valid', () => {
  const p = path.join(__dirname, '..', 'plugins', 'patterns-catalog', 'plugin.json');
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  const { ok, errors, manifest } = validatePluginManifest(raw);
  assert.deepEqual(errors, []);
  assert.equal(ok, true);
  // UI-only, privilege-less reference catalog:
  assert.deepEqual(manifest.sidecar.capabilities, []);
  assert.deepEqual(manifest.credentials, []);
  assert.deepEqual(manifest.scopes, ['team']);
  assert.equal(manifest.cli.name, 'aee-patterns');
  // #1599: opt-in global UI visibility set so the catalog is reachable by every
  // authenticated user once installed, without a team activation. Its single
  // ordinary-user route stays team-member (no elevated route opened up).
  assert.equal(manifest.ui.global, true);
  const board = manifest.ui.routes.find((r) => r.path === '/');
  assert.equal(board && board.minRole, 'team-member');
});

// ── ACCEPTANCE: the shipped dummy-echo manifest validates end to end ──────────
test('the shipped dummy-echo manifest (plugins/dummy-echo) is valid', () => {
  const p = path.join(__dirname, '..', 'plugins', 'dummy-echo', 'plugin.json');
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  const { ok, errors, manifest } = validatePluginManifest(raw);
  assert.deepEqual(errors, []);
  assert.equal(ok, true);
  // No-op reference plugin: no capabilities, no credentials.
  assert.deepEqual(manifest.sidecar.capabilities, []);
  assert.deepEqual(manifest.credentials, []);
  assert.deepEqual(manifest.scopes, ['team', 'agent']);
  assert.equal(manifest.cli.name, 'aee-echo');
});

// ── Command-only plugin (#1798): no sidecar / no cli ─────────────────────────

function commandOnlyBase() {
  return {
    pluginVersion: 1,
    id: 'spec-kit',
    name: 'spec-kit',
    description: 'Spec-driven development toolkit.',
    commands: { namespace: 'speckit' },
    fetch: { source: 'github', repo: 'github/spec-kit', ref: 'main' },
    scopes: ['team'],
  };
}

test('accepts a command-only manifest with commands + fetch (no sidecar / no cli)', () => {
  const { ok, errors, manifest } = validatePluginManifest(commandOnlyBase());
  assert.deepEqual(errors, []);
  assert.equal(ok, true);
  assert.equal('sidecar' in manifest, false);
  assert.equal('cli' in manifest, false);
  assert.deepEqual(manifest.commands, { namespace: 'speckit' });
  assert.deepEqual(manifest.fetch, { source: 'github', repo: 'github/spec-kit', ref: 'main' });
});

test('commands with no explicit namespace is accepted and carries an empty commands object', () => {
  const input = { ...commandOnlyBase() };
  delete input.commands.namespace;
  const { ok, manifest } = validatePluginManifest(input);
  assert.equal(ok, true);
  assert.deepEqual(manifest.commands, {});
});

test('commands.namespace must be a valid slug', () => {
  const r = validatePluginManifest({ ...commandOnlyBase(), commands: { namespace: 'Bad Ns!' } });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /commands.namespace/.test(e)));
});

test('rejects commands as a non-object', () => {
  const r = validatePluginManifest({ ...commandOnlyBase(), commands: 'speckit' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /commands must be an object/.test(e)));
});

test('fetch.source must be a known value', () => {
  const r = validatePluginManifest({ ...commandOnlyBase(), fetch: { source: 'bitbucket', repo: 'x/y', ref: 'main' } });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /fetch.source/.test(e)));
});

test('fetch.repo and fetch.ref are required', () => {
  const noRepo = validatePluginManifest({ ...commandOnlyBase(), fetch: { source: 'github', ref: 'main' } });
  assert.ok(noRepo.errors.some((e) => /fetch.repo is required/.test(e)));

  const noRef = validatePluginManifest({ ...commandOnlyBase(), fetch: { source: 'github', repo: 'x/y' } });
  assert.ok(noRef.errors.some((e) => /fetch.ref is required/.test(e)));
});

test('fetch.commandsDir is accepted when a non-empty string', () => {
  const { ok, manifest } = validatePluginManifest({ ...commandOnlyBase(), fetch: { source: 'github', repo: 'x/y', ref: 'v1', commandsDir: '.claude/commands' } });
  assert.equal(ok, true);
  assert.equal(manifest.fetch.commandsDir, '.claude/commands');
});

test('rejects fetch.commandsDir as an empty string', () => {
  const r = validatePluginManifest({ ...commandOnlyBase(), fetch: { source: 'github', repo: 'x/y', ref: 'v1', commandsDir: '' } });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /fetch.commandsDir/.test(e)));
});

test('rejects fetch as a non-object', () => {
  const r = validatePluginManifest({ ...commandOnlyBase(), fetch: 'github:main' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /fetch must be an object/.test(e)));
});

test('sidecar-only manifest still rejects missing cli', () => {
  const noCli = { ...commandOnlyBase() };
  delete noCli.commands;
  noCli.sidecar = { image: 'img:1', internalPort: 8080 };
  const r = validatePluginManifest(noCli);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /cli is required/.test(e)));
});

test('a full sidecar+cli plugin still includes sidecar and cli on the normalized manifest', () => {
  const { ok, manifest } = validatePluginManifest(base());
  assert.equal(ok, true);
  assert.ok(manifest.sidecar && manifest.sidecar.image);
  assert.ok(manifest.cli && manifest.cli.name);
});

// ── ACCEPTANCE: the shipped spec-kit manifest validates end to end ────────────
test('the shipped spec-kit manifest (plugins/spec-kit) is valid', () => {
  const p = path.join(__dirname, '..', 'plugins', 'spec-kit', 'plugin.json');
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  const { ok, errors, manifest } = validatePluginManifest(raw);
  assert.deepEqual(errors, []);
  assert.equal(ok, true);
  // Command-only: no sidecar, no cli.
  assert.equal('sidecar' in manifest, false);
  assert.equal('cli' in manifest, false);
  // Privilege-less: empty credentials, team scope.
  assert.deepEqual(manifest.credentials, []);
  assert.deepEqual(manifest.scopes, ['team']);
  // Commands and fetch wired up.
  assert.ok(manifest.commands && typeof manifest.commands === 'object');
  assert.equal(manifest.fetch && manifest.fetch.source, 'github');
  assert.ok(manifest.fetch.repo && manifest.fetch.ref);
});

// ── ACCEPTANCE: the shipped github-issues manifest validates end to end ───────
test('the shipped github-issues manifest (plugins/github-issues) is valid', () => {
  const p = path.join(__dirname, '..', 'plugins', 'github-issues', 'plugin.json');
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  const { ok, errors, manifest } = validatePluginManifest(raw);
  assert.deepEqual(errors, []);
  assert.equal(ok, true);
  // A credential-holding, egress broker whose GitHub token is the team's env
  // token (reused, not a plugin-grant secret) → declared credentials stay empty:
  assert.deepEqual(manifest.sidecar.capabilities, ['egress']);
  assert.deepEqual(manifest.credentials, []);
  // Standard team-grant gating (issue #1633): team scope only, NOT ui.global (#1599):
  assert.deepEqual(manifest.scopes, ['team']);
  assert.equal(defaultGranularity(manifest), 'team');
  assert.notEqual(manifest.ui.global, true);
  assert.equal(manifest.cli.name, 'aee-issues');
  // A single team-member UI route — any team member may list/read/label (no admin gate):
  const board = manifest.ui.routes.find((r) => r.path === '/');
  assert.equal(board && board.minRole, 'team-member');
});

// ── ACCEPTANCE: the shipped jira manifest validates end to end ───────────────
test('the shipped jira manifest (plugins/jira) is valid', () => {
  const p = path.join(__dirname, '..', 'plugins', 'jira', 'plugin.json');
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  const { ok, errors, manifest } = validatePluginManifest(raw);
  assert.deepEqual(errors, []);
  assert.equal(ok, true);
  // A credential-holding, egress broker — the Jira {site-url, email, api-token}
  // is a per-scope plugin credential (§5), so unlike github-issues the declared
  // credentials are NOT empty:
  assert.deepEqual(manifest.sidecar.capabilities, ['egress']);
  assert.deepEqual(manifest.credentials.map((c) => c.key), ['site-url', 'email', 'api-token']);
  assert.ok(manifest.credentials.every((c) => c.required === true));
  // Team scope only — a Jira site binding is a team-level fact (§6.1). Podman
  // only for v1 — the agent→broker network path is Podman-only, so a k8s stack
  // would wake agents that then cannot read the ticket (§6.1 corrected):
  assert.deepEqual(manifest.scopes, ['team']);
  assert.equal(defaultGranularity(manifest), 'team');
  assert.deepEqual(manifest.platforms, ['podman']);
  assert.equal(manifest.cli.name, 'aee-jira');
  assert.equal(manifest.quota.maxObjects, 500);
  // Phase 3 read UI (`/` @ team-member) + Phase 4 write config (`/admin` @
  // team-admin); `policy` declares the two writes as governed subcommands
  // (D3 — role-gated, no confirmation pen, so `requiresApproval` stays empty).
  assert.deepEqual(manifest.ui.routes, [
    { path: '/', minRole: 'team-member' },
    { path: '/admin', minRole: 'team-admin' },
  ]);
  assert.notEqual(manifest.ui.global, true);
  assert.deepEqual(Object.keys(manifest.policy).sort(), ['comment', 'transition']);
  assert.deepEqual(manifest.requiresApproval, []);
});
