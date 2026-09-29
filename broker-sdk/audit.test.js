'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  buildPluginAuditLine,
  serializeAuditLine,
  parseAuditLines,
  pruneAuditLines,
  auditWriter,
} = require('./audit');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'broker-sdk-audit-'));
}

test('buildPluginAuditLine requires who/what/when, defaults outcome to ok', () => {
  const line = buildPluginAuditLine({
    ts: '2026-08-07T00:00:00Z', pluginId: 'podman-sandbox', scopeId: 'team-abc',
    agentId: 'team-abc-dev', subcommand: 'compose_up',
  });
  assert.deepEqual(line, {
    ts: '2026-08-07T00:00:00Z', pluginId: 'podman-sandbox', scopeId: 'team-abc',
    agentId: 'team-abc-dev', subcommand: 'compose_up', outcome: 'ok',
  });
  assert.equal(buildPluginAuditLine({ ts: 'x' }), null); // missing fields
  assert.equal(buildPluginAuditLine({}), null);
});

test('agent-granularity line keeps scopeId==agentId (not deduplicated)', () => {
  const line = buildPluginAuditLine({
    ts: '2026-08-07T00:00:00Z', pluginId: 'podman-sandbox', scopeId: 'agent-aaaa',
    agentId: 'agent-aaaa', subcommand: 'container_list', outcome: 'ok',
  });
  assert.equal(line.scopeId, 'agent-aaaa');
  assert.equal(line.agentId, 'agent-aaaa');
});

test('auditWriter appends one JSONL line per call and reads them back', () => {
  const dir = tmpDir();
  const w = auditWriter(dir);
  w.write({ ts: '2026-08-07T00:00:00Z', pluginId: 'p', scopeId: 's', agentId: 'a', subcommand: 'compose_up' });
  w.write({ ts: '2026-08-07T00:01:00Z', pluginId: 'p', scopeId: 's', agentId: 'a', subcommand: 'compose_down', outcome: 'domain-error' });
  const raw = fs.readFileSync(w.filePath, 'utf8');
  assert.equal(raw.split('\n').filter(Boolean).length, 2);
  const records = w.read();
  assert.equal(records.length, 2);
  assert.equal(records[1].outcome, 'domain-error');
});

test('auditWriter skips a malformed record without writing a partial line', () => {
  const dir = tmpDir();
  const w = auditWriter(dir);
  assert.equal(w.write({ ts: 'only' }), null);
  assert.equal(fs.existsSync(w.filePath), false); // nothing written, dir not even touched by a bad line
});

test('auditWriter rotates out records older than the retention window on write', () => {
  const dir = tmpDir();
  // Freeze "now" at a fixed instant; retention = 1 hour.
  const NOW = Date.parse('2026-08-07T12:00:00Z');
  const w = auditWriter(dir, { retentionMs: 3600_000, now: () => NOW });
  // Old (2h ago) — should be rotated out; recent (10m ago) — kept.
  fs.writeFileSync(w.filePath, [
    serializeAuditLine({ ts: '2026-08-07T10:00:00Z', pluginId: 'p', scopeId: 's', agentId: 'a', subcommand: 'old', outcome: 'ok' }),
    '',
  ].join('\n'));
  w.write({ ts: '2026-08-07T11:50:00Z', pluginId: 'p', scopeId: 's', agentId: 'a', subcommand: 'recent' });
  const kept = w.read();
  assert.deepEqual(kept.map((r) => r.subcommand), ['recent']);
});

test('parseAuditLines tolerates blank/corrupt tail', () => {
  const text = '{"ts":"t","a":1}\n\nnot json\n{"ts":"u","b":2}';
  assert.deepEqual(parseAuditLines(text), [{ ts: 't', a: 1 }, { ts: 'u', b: 2 }]);
});

test('pruneAuditLines drops old + unparseable-ts records', () => {
  const now = Date.parse('2026-08-07T12:00:00Z');
  const records = [
    { ts: '2026-08-07T11:59:00Z' }, // kept
    { ts: '2026-08-07T00:00:00Z' }, // old, dropped
    { ts: 'garbage' }, // unparseable, dropped
  ];
  assert.deepEqual(pruneAuditLines(records, 3600_000, now), [{ ts: '2026-08-07T11:59:00Z' }]);
});

test('buildPluginAuditLine carries identity + interactive when given (#2562), omits them otherwise', () => {
  const base = { ts: '2026-09-30T00:00:00Z', pluginId: 'jira', scopeId: 'team-1', agentId: 'team-1-dev', subcommand: 'comment' };
  assert.deepEqual(buildPluginAuditLine({ ...base, identity: 'alice', interactive: true }),
    { ...base, outcome: 'ok', identity: 'alice', interactive: true });
  assert.deepEqual(buildPluginAuditLine({ ...base, identity: 'service-account', interactive: 'yes' }),
    { ...base, outcome: 'ok', identity: 'service-account', interactive: false });
  assert.equal('identity' in buildPluginAuditLine({ ...base, interactive: true }), false);
  assert.equal('interactive' in buildPluginAuditLine(base), false);
});
