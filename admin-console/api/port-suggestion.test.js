'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { heuristicPortSuggestion, parsePortSuggestion, classifyPatternRole } = require('./port-suggestion');

test('heuristic classifies common roles', () => {
  assert.equal(classifyPatternRole('Developer'), 'author');
  assert.equal(classifyPatternRole('Code Reviewer'), 'companion'); // review beats code
  assert.equal(classifyPatternRole('Security Auditor'), 'companion');
  assert.equal(classifyPatternRole('Requirements Analyst'), 'intake');
  assert.equal(classifyPatternRole('Issue Triage'), 'intake');
  assert.equal(classifyPatternRole('Evidence Scout'), 'scout');
  assert.equal(classifyPatternRole('Release Notes Bard'), 'standalone');
  assert.equal(classifyPatternRole('COBOL Migration Engineer'), 'author');
});

test('heuristic suggestion carries pattern-implied ports + session policy', () => {
  const dev = heuristicPortSuggestion({ roleName: 'Java Developer' });
  assert.equal(dev.patternRole, 'author');
  assert.equal(dev.sessionPolicy, 'per-invocation');
  assert.deepEqual(dev.ports.produces, { pr: true, issue: false });
  assert.deepEqual(dev.ports.consumes, []);

  const rev = heuristicPortSuggestion({ roleName: 'Design Reviewer' });
  assert.equal(rev.patternRole, 'companion');
  assert.equal(rev.sessionPolicy, 'persistent');
  assert.deepEqual(rev.ports.consumes, [{ artifact: 'pr', fromSlot: 'stage-author' }]);

  const ba = heuristicPortSuggestion({ roleName: 'Business Analyst', notes: 'refines requirements' });
  assert.equal(ba.patternRole, 'intake');
  assert.deepEqual(ba.ports.produces, { pr: false, issue: true });
});

test('parsePortSuggestion accepts plain, fenced and prose-wrapped JSON', () => {
  const plain = parsePortSuggestion('{"patternRole":"author","sessionPolicy":"per-invocation","produces":{"pr":true,"issue":false}}');
  assert.equal(plain.patternRole, 'author');
  assert.deepEqual(plain.ports.produces, { pr: true, issue: false });

  const fenced = parsePortSuggestion('```json\n{"patternRole":"companion","sessionPolicy":"persistent","produces":{"pr":false,"issue":false}}\n```');
  assert.equal(fenced.patternRole, 'companion');
  assert.deepEqual(fenced.ports.consumes, [{ artifact: 'pr', fromSlot: 'stage-author' }]);

  const prose = parsePortSuggestion('Here you go: {"patternRole":"scout","sessionPolicy":"per-invocation","produces":{}}');
  assert.equal(prose.patternRole, 'scout');
  assert.deepEqual(prose.ports.consumes, [{ artifact: 'issue', fromSlot: 'stage-entry' }]);
});

test('parsePortSuggestion rejects garbage and unknown pattern roles', () => {
  assert.equal(parsePortSuggestion('no json here'), null);
  assert.equal(parsePortSuggestion('{"patternRole":"wizard"}'), null);
  assert.equal(parsePortSuggestion(''), null);
  assert.equal(parsePortSuggestion('{broken'), null);
});
