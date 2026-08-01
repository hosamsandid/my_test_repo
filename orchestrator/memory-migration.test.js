'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseLegacyFacts,
  parseLegacyEntities,
  hasLegacyContent,
  buildMigrationEntries,
} = require('./memory-migration');

test('parseLegacyFacts: dated + undated bullets, skips headings/prose', () => {
  const facts = parseLegacyFacts([
    '# Facts',
    '',
    '- [2026-05-01] CI runs on Node 22.',
    '- Undated fact without a stamp',
    '* Star bullet works too',
    'A prose line that is not a bullet',
    '- ',
  ].join('\n'));
  assert.deepEqual(facts, [
    { text: 'CI runs on Node 22.', date: '2026-05-01' },
    { text: 'Undated fact without a stamp', date: null },
    { text: 'Star bullet works too', date: null },
  ]);
});

test('parseLegacyFacts: empty / boilerplate yields nothing', () => {
  assert.deepEqual(parseLegacyFacts('# Facts\n'), []);
  assert.deepEqual(parseLegacyFacts(''), []);
  assert.deepEqual(parseLegacyFacts(null), []);
});

test('parseLegacyEntities: one entry per H2/H3 section, flattened + capped', () => {
  const entities = parseLegacyEntities([
    '# Entities',
    '',
    '## github-poller',
    '---',
    'type: service',
    '---',
    'Polls the Events API every 30s.',
    '',
    '### agent-studio',
    'The local Matrix stack.',
    '',
    '## empty-section',
  ].join('\n'));
  assert.equal(entities.length, 3);
  assert.equal(entities[0].text, 'github-poller: type: service Polls the Events API every 30s.');
  assert.equal(entities[1].text, 'agent-studio: The local Matrix stack.');
  assert.equal(entities[2].text, 'empty-section');
});

test('parseLegacyEntities caps at 300 chars with ellipsis', () => {
  const long = 'x'.repeat(400);
  const [e] = parseLegacyEntities(`## big\n${long}`);
  assert.equal(e.text.length, 300);
  assert.ok(e.text.endsWith('…'));
});

test('hasLegacyContent: headings-only is value-less, real content is not', () => {
  assert.equal(hasLegacyContent('# Facts\n'), false);
  assert.equal(hasLegacyContent(''), false);
  assert.equal(hasLegacyContent('# Facts\n- [2026-01-01] A fact'), true);
  assert.equal(hasLegacyContent('## section heading only'), false);
});

test('buildMigrationEntries: validated entries with migration provenance', () => {
  let n = 0;
  const idGen = () => `${String(++n).padStart(12, '0')}`.replace(/[^0-9a-f]/g, '0');
  const now = () => '2026-07-13T10:00:00Z';
  const entries = buildMigrationEntries({
    agentId: 'dev-1',
    teamId: 'squad-a',
    facts: [{ text: 'CI runs on Node 22.', date: '2026-05-01' }, { text: 'Undated', date: null }],
    entities: [{ text: 'github-poller: polls every 30s' }],
    now,
    idGen,
  });
  assert.equal(entries.length, 3);
  for (const e of entries) {
    assert.equal(e.originAgent, 'dev-1');
    assert.equal(e.teamId, 'squad-a');
    assert.equal(e.correlationId, 'migration:dev-1');
    assert.deepEqual(e.convergence, ['dev-1']);
    assert.equal(e.status, 'active');
  }
  // Dated fact keeps its date as createdAt; undated gets now().
  assert.equal(entries[0].createdAt, '2026-05-01T00:00:00Z');
  assert.equal(entries[1].createdAt, '2026-07-13T10:00:00Z');
  assert.equal(entries[2].kind, 'entity');
});
