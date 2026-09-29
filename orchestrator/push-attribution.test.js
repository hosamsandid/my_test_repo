'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  attributionKey, normalizePushedBy, producerFilterVerdict, derivedUpstreamFromId,
  migrateDataFlowProducerFilter, PushAttributionStore, TTL_MS, MAX_ENTRIES, FILE_NAME,
} = require('./push-attribution');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'push-attr-'));
}

const SPEC = { agentId: 't1-spec', teamId: 't1' };

test('attributionKey: case-insensitive repo + sha, bare branch == full ref', () => {
  assert.equal(
    attributionKey({ repo: 'Org/Repo', ref: 'main', head: 'ABC' }),
    attributionKey({ repo: 'org/repo', ref: 'refs/heads/main', head: 'abc' }),
  );
  assert.equal(attributionKey({ repo: 'org/repo', ref: 'main', head: '' }), null);
  assert.equal(attributionKey({ repo: '', ref: 'main', head: 'abc' }), null);
});

test('normalizePushedBy: non-array / empty → null (any push), dedup + trim', () => {
  assert.equal(normalizePushedBy(undefined), null);
  assert.equal(normalizePushedBy('t1-spec'), null);
  assert.equal(normalizePushedBy([]), null);
  assert.equal(normalizePushedBy(['', '  ']), null);
  assert.deepEqual(normalizePushedBy([' t1-spec ', 't1-spec', 3, 't1-dev']), ['t1-spec', 't1-dev']);
});

test('producerFilterVerdict: no filter passes every push (AC1)', () => {
  assert.equal(producerFilterVerdict(null, 't1', null).ok, true);
  assert.equal(producerFilterVerdict(null, 't1', { agentId: 'x', teamId: 't9' }).ok, true);
});

test('producerFilterVerdict: named same-team producer passes; others drop (AC2)', () => {
  assert.deepEqual(producerFilterVerdict(['t1-spec'], 't1', SPEC), { ok: true, producer: 't1-spec' });
  assert.deepEqual(producerFilterVerdict(['t1-spec'], 't1', { agentId: 't1-dev', teamId: 't1' }), { ok: false, producer: 't1-dev' });
  // Unknown producer (human push, raw git push, KB sync, zero-commit / deletion).
  assert.deepEqual(producerFilterVerdict(['t1-spec'], 't1', null), { ok: false, producer: null });
});

test('producerFilterVerdict: same id recorded under another team never matches (AC3)', () => {
  assert.equal(producerFilterVerdict(['t1-spec'], 't1', { agentId: 't1-spec', teamId: 't2' }).ok, false);
  assert.equal(producerFilterVerdict(['t1-spec'], null, SPEC).ok, false);
});

test('producerFilterVerdict: pool instance matches via poolOf, not an id prefix (AC4)', () => {
  const inst = { agentId: 't1-spec-i42', teamId: 't1', poolOf: 't1-spec' };
  assert.deepEqual(producerFilterVerdict(['t1-spec'], 't1', inst), { ok: true, producer: 't1-spec-i42' });
  // `t1-spec-infra` is a different role whose id merely shares the prefix.
  assert.equal(producerFilterVerdict(['t1-spec'], 't1', { agentId: 't1-spec-infra', teamId: 't1' }).ok, false);
});

test('derivedUpstreamFromId: full member ids and materialised role-key ids', () => {
  const agents = { 't1-spec': 't1', 't1-dev': 't1', 't2-spec': 't2' };
  const teamOfAgent = (id) => agents[id] || null;
  const ctx = { memberId: 't1-dev', teamId: 't1', teamOfAgent };
  assert.equal(derivedUpstreamFromId('t1-dev-on-push-t1-spec', ctx), 't1-spec');
  assert.equal(derivedUpstreamFromId('dev-on-push-spec', ctx), 't1-spec');
  // Unresolvable / other-team / self upstreams are left alone.
  assert.equal(derivedUpstreamFromId('dev-on-push-ghost', ctx), null);
  assert.equal(derivedUpstreamFromId('t1-dev-on-push-t2-spec', ctx), null);
  assert.equal(derivedUpstreamFromId('t1-dev-on-push-t1-dev', ctx), null);
  assert.equal(derivedUpstreamFromId('my-push-trigger', ctx), null);
});

test('migrateDataFlowProducerFilter: fills derived triggers only, keeps manual ones (AC6)', () => {
  const teamOfAgent = (id) => ({ 't1-spec': 't1', 't1-dev': 't1' })[id] || null;
  const triggers = [
    { id: 'dev-on-push-spec', type: 'github-event', events: ['push'], dataFlow: true, prompt: 'p' },
    { id: 't1-dev-on-push-t1-spec', type: 'github-event', events: ['push'], dataFlow: true, activatedAt: 'A', prompt: 'p' },
    { id: 'manual', type: 'github-event', events: ['push'], prompt: 'p' },
    { id: 'already', type: 'github-event', events: ['push'], dataFlow: true, pushedBy: [], prompt: 'p' },
    { id: 'nightly', type: 'cron', cron: '0 1 * * *', prompt: 'p' },
  ];
  const before = JSON.stringify(triggers);
  const { triggers: out, changed } = migrateDataFlowProducerFilter(triggers, {
    memberId: 't1-dev', teamId: 't1', teamOfAgent, horizon: '2026-09-01T00:00:00.000Z',
  });
  assert.equal(JSON.stringify(triggers), before, 'input is not mutated');
  assert.deepEqual(changed, ['dev-on-push-spec', 't1-dev-on-push-t1-spec']);
  assert.deepEqual(out[0].pushedBy, ['t1-spec']);
  assert.equal(out[0].activatedAt, '2026-09-01T00:00:00.000Z', 'unstamped trigger keeps its old horizon');
  assert.equal(out[1].activatedAt, 'A', 'an existing stamp is never moved');
  assert.equal(out[2], triggers[2]);
  assert.equal(out[3], triggers[3]);
  assert.equal(out[4], triggers[4]);
  // Idempotent.
  assert.deepEqual(migrateDataFlowProducerFilter(out, { memberId: 't1-dev', teamId: 't1', teamOfAgent }).changed, []);
});

test('PushAttributionStore: record → lookup, persisted across instances', () => {
  const dir = tmpDir();
  const s = new PushAttributionStore({ dir });
  assert.equal(s.record({ repo: 'Org/Repo', branch: 'feat/x', head: 'abc', ...SPEC }), true);
  assert.deepEqual(s.lookup({ repo: 'org/repo', ref: 'refs/heads/feat/x', head: 'abc' }), SPEC);
  assert.equal(s.lookup({ repo: 'org/repo', ref: 'refs/heads/feat/x', head: 'def' }), null);
  const s2 = new PushAttributionStore({ dir });
  assert.deepEqual(s2.lookup({ repo: 'org/repo', ref: 'feat/x', head: 'abc' }), SPEC);
  assert.ok(fs.existsSync(path.join(dir, FILE_NAME)));
});

test('PushAttributionStore: later push of the same head re-attributes; poolOf round-trips', () => {
  const s = new PushAttributionStore({ dir: tmpDir() });
  s.record({ repo: 'o/r', branch: 'b', head: 'h', ...SPEC });
  s.record({ repo: 'o/r', branch: 'b', head: 'h', agentId: 't1-spec-i7', teamId: 't1', poolOf: 't1-spec' });
  assert.deepEqual(s.lookup({ repo: 'o/r', ref: 'b', head: 'h' }), { agentId: 't1-spec-i7', teamId: 't1', poolOf: 't1-spec' });
});

test('PushAttributionStore: TTL expiry and entry cap', () => {
  let now = 1_000_000;
  const s = new PushAttributionStore({ dir: tmpDir(), now: () => now });
  s.record({ repo: 'o/r', branch: 'b', head: 'old', ...SPEC });
  now += TTL_MS + 1;
  assert.equal(s.lookup({ repo: 'o/r', ref: 'b', head: 'old' }), null);
  for (let i = 0; i < MAX_ENTRIES + 5; i++) {
    now += 1;
    s.record({ repo: 'o/r', branch: 'b', head: `h${i}`, ...SPEC });
  }
  assert.equal(Object.keys(s.entries).length, MAX_ENTRIES);
  assert.equal(s.lookup({ repo: 'o/r', ref: 'b', head: 'h0' }), null, 'oldest evicted');
  assert.ok(s.lookup({ repo: 'o/r', ref: 'b', head: `h${MAX_ENTRIES + 4}` }));
});

test('PushAttributionStore: bad input and unreadable file never throw', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, FILE_NAME), '{not json');
  const s = new PushAttributionStore({ dir });
  assert.equal(s.lookup({ repo: 'o/r', ref: 'b', head: 'h' }), null);
  assert.equal(s.record({ repo: 'o/r', branch: 'b', head: 'h', agentId: '' }), false);
  assert.equal(s.record({ repo: 'o/r', branch: 'b', head: 'h', ...SPEC }), true);
});
