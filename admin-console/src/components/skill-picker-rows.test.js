import test from 'node:test';
import assert from 'node:assert/strict';
import { tierOf, buildRows, driftLineageHref, rowDetailLines } from './skill-picker-rows.js';

test('tierOf maps team → team and everything else → global', () => {
  assert.equal(tierOf('team'), 'team');
  assert.equal(tierOf('pool'), 'global');
  assert.equal(tierOf('agent'), 'global');
  assert.equal(tierOf(undefined), 'global');
});

test('buildRows collapses one row per name, sorted', () => {
  const rows = buildRows(
    [
      { name: 'zebra', source: 'pool' },
      { name: 'alpha', source: 'pool' },
    ],
    [],
  );
  assert.deepEqual(rows.map(r => r.name), ['alpha', 'zebra']);
  assert.equal(rows[0].tier, 'global');
  assert.equal(rows[0].unknown, false);
});

test('buildRows: a team skill shadows the global of the same name (team-first)', () => {
  const rows = buildRows(
    [
      { name: 'lint', source: 'pool', description: 'global one' },
      { name: 'lint', source: 'team', teamId: 't1', description: 'team one' },
    ],
    [],
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tier, 'team');
  assert.equal(rows[0].teamId, 't1');
  assert.equal(rows[0].shadowsGlobal, true);
  assert.equal(rows[0].description, 'team one');
});

test('buildRows carries version + drift from the effective copy', () => {
  const rows = buildRows(
    [{ name: 'x', source: 'team', teamId: 't1', version: 3, drift: 'behind' }],
    [],
  );
  assert.equal(rows[0].version, 3);
  assert.equal(rows[0].drift, 'behind');
  // in-sync collapses to no drift flag
  const clean = buildRows([{ name: 'y', source: 'pool', drift: 'in-sync' }], []);
  assert.equal(clean[0].drift, null);
});

test('buildRows keeps a selected-but-unknown grant as a flagged row (AC4)', () => {
  const rows = buildRows([{ name: 'known', source: 'pool' }], ['known', 'ghost']);
  const ghost = rows.find(r => r.name === 'ghost');
  assert.ok(ghost);
  assert.equal(ghost.unknown, true);
  // known rows precede unknown ones
  assert.equal(rows[rows.length - 1].name, 'ghost');
});

test('buildRows tolerates junk input', () => {
  assert.deepEqual(buildRows(null, null), []);
  assert.deepEqual(buildRows([null, { source: 'pool' }, 3], []), []);
});

test('driftLineageHref deep-links a global row to the Copies & origin tab', () => {
  const href = driftLineageHref({ name: 'my skill', tier: 'global', drift: 'behind' });
  const url = new URL(href, 'http://x');
  assert.equal(url.pathname, '/skills');
  assert.equal(url.searchParams.get('skill'), 'my skill');
  assert.equal(url.searchParams.get('tier'), 'pool');
  assert.equal(url.searchParams.get('tab'), 'copies');
  assert.equal(url.searchParams.get('team'), null);
});

test('driftLineageHref carries teamId for a team row', () => {
  const href = driftLineageHref({ name: 'lint', tier: 'team', teamId: 't1', drift: 'ahead' });
  const url = new URL(href, 'http://x');
  assert.equal(url.searchParams.get('tier'), 'team');
  assert.equal(url.searchParams.get('team'), 't1');
  assert.equal(url.searchParams.get('tab'), 'copies');
});

test('driftLineageHref returns null without a name', () => {
  assert.equal(driftLineageHref({}), null);
  assert.equal(driftLineageHref(null), null);
});

test('rowDetailLines: a plain known row with no flags has nothing to expand into', () => {
  assert.deepEqual(rowDetailLines({ name: 'x', tier: 'global', unknown: false }), []);
  assert.deepEqual(rowDetailLines(null), []);
});

test('rowDetailLines: unknown row explains itself and nothing else', () => {
  const lines = rowDetailLines({ name: 'ghost', unknown: true, shadowsGlobal: true, drift: 'behind' });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /matches no skill in the current pool/);
});

test('rowDetailLines: shadowsGlobal, version and drift each contribute one sentence', () => {
  const lines = rowDetailLines({
    name: 'lint', unknown: false, shadowsGlobal: true, version: 3, drift: 'ahead',
  });
  assert.equal(lines.length, 3);
  assert.match(lines[0], /shadows the global skill/);
  assert.match(lines[1], /Manifest version 3/);
  assert.match(lines[2], /drifted from its source skill \(ahead\)/);
});
