'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { KINDS, parseHarvestBlock, stripHarvestBlock } = require('./harvest-block');

// The shared golden fixture is the two-sided contract with the Python mirror
// (parse_harvest_block / strip_harvest_block in
// agent-image/scripts/agent-entrypoint.py): both test suites read the SAME file
// and assert identical entries + stripped text, so the two implementations
// cannot drift apart without a test failing.
const FIXTURE = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'harvest-block.fixture.json'), 'utf8'),
);

test('kinds are fact/entity/convention', () => {
  assert.deepEqual([...KINDS].sort(), ['convention', 'entity', 'fact']);
});

test('golden fixture: parse + strip', () => {
  for (const c of FIXTURE.cases) {
    assert.deepEqual(parseHarvestBlock(c.input), c.expectedEntries, `parse ${c.name}`);
    assert.equal(stripHarvestBlock(c.input), c.expectedStripped, `strip ${c.name}`);
  }
});

test('malformed / non-string input never throws and yields []', () => {
  for (const bad of [null, undefined, 42, {}, [], true]) {
    assert.deepEqual(parseHarvestBlock(bad), []);
  }
});

test('stripHarvestBlock returns non-string input as empty string, string unchanged when no block', () => {
  assert.equal(stripHarvestBlock(null), '');
  assert.equal(stripHarvestBlock(undefined), '');
  assert.equal(stripHarvestBlock(42), '');
  assert.equal(stripHarvestBlock('plain text'), 'plain text');
});

test('a lesson with an unknown kind is dropped, a valid sibling kept', () => {
  const text = [
    'ok',
    '```knowledge',
    '{"kind":"story","text":"nope"}',
    '{"kind":"fact","text":"yes"}',
    '```',
  ].join('\n');
  assert.deepEqual(parseHarvestBlock(text), [{ kind: 'fact', text: 'yes' }]);
});
