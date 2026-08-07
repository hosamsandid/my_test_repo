'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildHillClimbAnalystRequest, parseHillClimbCards } = require('./hill-climb-analyst');

test('buildHillClimbAnalystRequest embeds the digest and demands JSON', () => {
  const digest = { teamId: 'acme', totalRuns: 40, metrics: { runSuccessRate: 0.8 } };
  const req = buildHillClimbAnalystRequest(digest);
  assert.equal(req.messages.length, 1);
  assert.equal(req.messages[0].role, 'user');
  const content = req.messages[0].content;
  assert.match(content, /acme/);
  assert.match(content, /targetMetric/);
  assert.match(content, /ONLY a JSON object/);
  assert.ok(req.max_tokens > 0);
});

test('parseHillClimbCards reads a {cards:[...]} wrapper', () => {
  const reply = 'Here are my findings:\n{"cards":[{"class":"trigger-hygiene","object":{"kind":"trigger","id":"dev/x"},"title":"t","targetMetric":"waste.wasteRuns","evidence":[{"type":"metric","value":"dev/x"}]}]}';
  const cards = parseHillClimbCards(reply);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].class, 'trigger-hygiene');
});

test('parseHillClimbCards reads a fenced JSON block', () => {
  const reply = '```json\n{"cards":[{"class":"flow-wiring","object":{"kind":"label","id":"foo"},"title":"t","targetMetric":"m","evidence":[{"type":"metric","value":"foo"}]}]}\n```';
  const cards = parseHillClimbCards(reply);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].object.id, 'foo');
});

test('parseHillClimbCards accepts a bare array', () => {
  const reply = '[{"class":"threshold-tuning","object":{"kind":"team","id":"acme"},"title":"t","targetMetric":"m","evidence":[{"type":"metric","value":1}]}]';
  const cards = parseHillClimbCards(reply);
  assert.equal(cards.length, 1);
});

test('parseHillClimbCards returns [] on garbage or empty input', () => {
  assert.deepEqual(parseHillClimbCards('no json here'), []);
  assert.deepEqual(parseHillClimbCards(''), []);
  assert.deepEqual(parseHillClimbCards(null), []);
});

test('parseHillClimbCards drops non-object array entries', () => {
  const reply = '{"cards":[null, 5, "x", {"class":"flow-wiring","object":{"kind":"label","id":"y"}}]}';
  const cards = parseHillClimbCards(reply);
  assert.equal(cards.length, 1);
});
