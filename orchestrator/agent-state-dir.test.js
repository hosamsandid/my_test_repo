'use strict';

// Behavioural tests for the per-agent state-dir resolver + one-time migration
// (#1549). The module is duplicated byte-identically in admin-console/api/, so
// this suite also asserts the two copies never drift.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { STATE_DIR, LEGACY_STATE_DIR, resolveAgentStateDir } = require('./agent-state-dir');

function mkbase() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'statedir-'));
}

test('STATE_DIR/LEGACY_STATE_DIR are the expected names', () => {
  assert.equal(STATE_DIR, '.agent-studio');
  assert.equal(LEGACY_STATE_DIR, '.aee');
});

test('a fresh agent resolves to .agent-studio without creating anything', () => {
  const base = mkbase();
  try {
    const dir = resolveAgentStateDir(base);
    assert.equal(dir, path.join(base, '.agent-studio'));
    assert.ok(!fs.existsSync(dir)); // resolver never mkdirs — the caller does
    assert.ok(!fs.existsSync(path.join(base, '.aee')));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('a legacy .aee/ is atomically migrated to .agent-studio/ preserving contents', () => {
  const base = mkbase();
  try {
    fs.mkdirSync(path.join(base, '.aee', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(base, '.aee', 'seeded-skills.json'), '{"s":1}');
    const dir = resolveAgentStateDir(base);
    assert.equal(dir, path.join(base, '.agent-studio'));
    assert.ok(fs.existsSync(path.join(dir, 'bin')));
    assert.equal(fs.readFileSync(path.join(dir, 'seeded-skills.json'), 'utf8'), '{"s":1}');
    assert.ok(!fs.existsSync(path.join(base, '.aee')));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('when both dirs exist the new one wins and the legacy is left untouched', () => {
  const base = mkbase();
  try {
    fs.mkdirSync(path.join(base, '.agent-studio'), { recursive: true });
    fs.writeFileSync(path.join(base, '.agent-studio', 'keep'), 'new');
    fs.mkdirSync(path.join(base, '.aee'), { recursive: true });
    fs.writeFileSync(path.join(base, '.aee', 'old'), 'old');
    const dir = resolveAgentStateDir(base);
    assert.equal(dir, path.join(base, '.agent-studio'));
    assert.ok(fs.existsSync(path.join(base, '.aee', 'old'))); // untouched
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('resolution is idempotent', () => {
  const base = mkbase();
  try {
    fs.mkdirSync(path.join(base, '.aee'), { recursive: true });
    fs.writeFileSync(path.join(base, '.aee', 'f'), 'x');
    const a = resolveAgentStateDir(base);
    const b = resolveAgentStateDir(base);
    assert.equal(a, b);
    assert.equal(fs.readFileSync(path.join(a, 'f'), 'utf8'), 'x');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('an injected fs/path is honoured (matches the prompt-history io shape)', () => {
  const base = mkbase();
  try {
    fs.mkdirSync(path.join(base, '.aee'), { recursive: true });
    const dir = resolveAgentStateDir(base, { fs, path });
    assert.equal(dir, path.join(base, '.agent-studio'));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('the admin-console copy is byte-identical (no drift)', () => {
  const here = fs.readFileSync(path.join(__dirname, 'agent-state-dir.js'), 'utf8');
  const there = fs.readFileSync(
    path.join(__dirname, '..', 'admin-console', 'api', 'agent-state-dir.js'),
    'utf8',
  );
  assert.equal(here, there);
});
