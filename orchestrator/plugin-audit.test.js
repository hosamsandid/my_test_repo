'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  buildPluginAuditLine,
  serializeAuditLine,
  parseAuditLines,
  pruneAuditLines,
} = require('./plugin-audit');

const BASE = { ts: '2026-08-07T12:00:00.000Z', pluginId: 'dummy-echo', scopeId: 't1', agentId: 't1-dev', subcommand: 'echo' };

test('builds a normalised record with the full who/what/how/when tuple', () => {
  assert.deepEqual(buildPluginAuditLine({ ...BASE, outcome: 'ok' }), {
    ts: '2026-08-07T12:00:00.000Z',
    pluginId: 'dummy-echo',
    scopeId: 't1',
    agentId: 't1-dev',
    subcommand: 'echo',
    outcome: 'ok',
  });
});

test('an unknown outcome coerces to "ok"; an optional detail is kept', () => {
  const r = buildPluginAuditLine({ ...BASE, outcome: 'bogus', detail: 'note' });
  assert.equal(r.outcome, 'ok');
  assert.equal(r.detail, 'note');
});

test('a missing required field yields null (never a half-logged line)', () => {
  assert.equal(buildPluginAuditLine({ ...BASE, agentId: '' }), null);
  assert.equal(buildPluginAuditLine({ ...BASE, ts: undefined }), null);
  assert.equal(buildPluginAuditLine({}), null);
});

test('at agent granularity scopeId and agentId coincide and BOTH are kept', () => {
  const r = buildPluginAuditLine({ ...BASE, scopeId: 't1-dev', agentId: 't1-dev', outcome: 'denied' });
  assert.equal(r.scopeId, 't1-dev');
  assert.equal(r.agentId, 't1-dev');
});

test('round-trips through serialize/parse and skips corrupt lines', () => {
  const a = buildPluginAuditLine({ ...BASE });
  const b = buildPluginAuditLine({ ...BASE, subcommand: 'whoami', outcome: 'unreachable' });
  const text = [serializeAuditLine(a), '', 'not json', serializeAuditLine(b)].join('\n');
  assert.deepEqual(parseAuditLines(text), [a, b]);
});

test('retention drops lines older than the window (and undatable lines)', () => {
  const now = Date.parse('2026-08-07T12:00:00.000Z');
  const day = 24 * 3600 * 1000;
  const recs = [
    { ts: '2026-08-07T11:00:00.000Z' }, // 1h ago — kept
    { ts: '2026-08-01T12:00:00.000Z' }, // 6d ago — dropped (7d window edge is 30d here)
    { ts: 'garbage' },                  // undatable — dropped
  ];
  const kept = pruneAuditLines(recs, 2 * day, now);
  assert.deepEqual(kept, [{ ts: '2026-08-07T11:00:00.000Z' }]);
});
