'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  heuristicOutcomeSuggestion, buildOutcomeSuggestionRequest, parseOutcomeSuggestion,
  scoreShape, harvestLabels,
} = require('./outcome-suggestion');
const { validateOutcomes } = require('./outcomes');

// ── scoreShape ───────────────────────────────────────────────────────────────
test('scoreShape: reviewer-like text classifies as reviewer', () => {
  assert.equal(scoreShape('Code Reviewer — review the PR and approve or request revisions'), 'reviewer');
});
test('scoreShape: dispatcher-like text classifies as dispatcher', () => {
  assert.equal(scoreShape('Dispatcher — route each incoming task to a developer'), 'dispatcher');
});
test('scoreShape: reviewer wins a review+route tie', () => {
  assert.equal(scoreShape('review the change and route feedback'), 'reviewer');
});
test('scoreShape: unremarkable text is generic', () => {
  assert.equal(scoreShape('Documentation writer that keeps the wiki current'), 'generic');
});

// ── harvestLabels ──────────────────────────────────────────────────────────────
test('harvestLabels: pulls backtick label tokens, drops gate/brake labels', () => {
  const labels = harvestLabels('apply `ready-to-merge`, else `revisions-required`; never `hold` or `human:approve`');
  assert.deepEqual(labels, ['ready-to-merge', 'revisions-required']);
});
test('harvestLabels: dedups and caps at 6', () => {
  const labels = harvestLabels('`a` `a` `b` `c` `d` `e` `f` `g` `h`');
  assert.equal(labels.length, 6);
  assert.deepEqual(labels, ['a', 'b', 'c', 'd', 'e', 'f']);
});

// ── heuristicOutcomeSuggestion ─────────────────────────────────────────────────
test('heuristic: reviewer → exactlyOne accepted/revisions, harvested labels used', () => {
  const s = heuristicOutcomeSuggestion({
    roleName: 'Code Reviewer',
    prompt: 'Review the PR. If clean apply `ready-to-merge`, otherwise apply `revisions-required`.',
  });
  assert.equal(s.mode, 'exactlyOne');
  assert.equal(s.options.length, 2);
  assert.deepEqual(s.options.map(o => o.id), ['accepted', 'revisions-required']);
  assert.equal(s.options[0].actions[0].label, 'ready-to-merge');
  assert.equal(s.options[1].actions[0].label, 'revisions-required');
  assert.ok(validateOutcomes(s).ok);
});
test('heuristic: reviewer with no labels falls back to sensible defaults', () => {
  const s = heuristicOutcomeSuggestion({ roleName: 'QA reviewer', prompt: 'review and approve work' });
  assert.equal(s.mode, 'exactlyOne');
  assert.equal(s.options[0].actions[0].label, 'ready-to-merge');
  assert.equal(s.options[1].actions[0].label, 'revisions-required');
});
test('heuristic: dispatcher → exactlyOne route/hold, hold is a terminal none', () => {
  const s = heuristicOutcomeSuggestion({ roleName: 'Dispatcher', prompt: 'route each task; label it `ready`' });
  assert.equal(s.mode, 'exactlyOne');
  assert.deepEqual(s.options.map(o => o.id), ['route', 'hold']);
  assert.equal(s.options[0].actions[0].label, 'ready');
  assert.equal(s.options[1].actions[0].type, 'none');
  assert.ok(validateOutcomes(s).ok);
});
test('heuristic: generic with harvested labels → anyOf over them', () => {
  const s = heuristicOutcomeSuggestion({ roleName: 'Labeler', prompt: 'set `bug` and `docs` as appropriate' });
  assert.equal(s.mode, 'anyOf');
  assert.deepEqual(s.options.map(o => o.actions[0].label), ['bug', 'docs']);
});
test('heuristic: nothing to go on → single anyOf completed outcome', () => {
  const s = heuristicOutcomeSuggestion({ roleName: 'Helper', prompt: '' });
  assert.equal(s.mode, 'anyOf');
  assert.equal(s.options.length, 1);
  assert.equal(s.options[0].id, 'completed');
  assert.equal(s.options[0].actions[0].type, 'none');
  assert.ok(validateOutcomes(s).ok);
});
test('heuristic output always validates', () => {
  for (const rn of ['Code Reviewer', 'Dispatcher', 'Docs bot', '']) {
    assert.ok(validateOutcomes(heuristicOutcomeSuggestion({ roleName: rn, prompt: 'x' })).ok, rn);
  }
});

// ── buildOutcomeSuggestionRequest ──────────────────────────────────────────────
test('buildOutcomeSuggestionRequest: single user message with role + JSON schema', () => {
  const req = buildOutcomeSuggestionRequest('Code Reviewer', 'review PRs');
  assert.equal(req.messages.length, 1);
  assert.equal(req.messages[0].role, 'user');
  assert.ok(req.messages[0].content.includes('Code Reviewer'));
  assert.ok(req.messages[0].content.includes('exactlyOne'));
  assert.ok(typeof req.max_tokens === 'number');
});

// ── parseOutcomeSuggestion ─────────────────────────────────────────────────────
test('parse: valid JSON → normalized port', () => {
  const txt = JSON.stringify({
    mode: 'exactlyOne',
    options: [
      { id: 'accepted', title: 'Accepted', when: 'clean', actions: [{ type: 'setLabel', label: 'ready-to-merge' }] },
      { id: 'rej', title: 'Revisions', when: 'not clean', actions: [{ type: 'setLabel', label: 'revisions-required' }] },
    ],
  });
  const s = parseOutcomeSuggestion(txt);
  assert.equal(s.mode, 'exactlyOne');
  assert.equal(s.options.length, 2);
  assert.ok(validateOutcomes(s).ok);
});
test('parse: tolerates prose/fences around the JSON', () => {
  const txt = 'Sure! Here you go:\n```json\n{"mode":"anyOf","options":[{"id":"done","actions":[{"type":"none"}]}]}\n```\nHope that helps.';
  const s = parseOutcomeSuggestion(txt);
  assert.equal(s.mode, 'anyOf');
  assert.equal(s.options[0].id, 'done');
});
test('parse: derives ids from title when id missing, keeps them unique', () => {
  const txt = JSON.stringify({
    mode: 'anyOf',
    options: [
      { title: 'Route to Developer', actions: [{ type: 'setLabel', label: 'ready' }] },
      { title: 'Route to Developer', actions: [{ type: 'setLabel', label: 'ready-2' }] },
    ],
  });
  const s = parseOutcomeSuggestion(txt);
  assert.equal(s.options.length, 2);
  assert.notEqual(s.options[0].id, s.options[1].id);
});
test('parse: missing actions default to a terminal none', () => {
  const s = parseOutcomeSuggestion('{"mode":"anyOf","options":[{"id":"x","title":"X"}]}');
  assert.equal(s.options[0].actions[0].type, 'none');
});
test('parse: rejects a forbidden gate label (data-model validator is the gate)', () => {
  const txt = JSON.stringify({ mode: 'anyOf', options: [{ id: 'g', actions: [{ type: 'setLabel', label: 'human:approve' }] }] });
  assert.equal(parseOutcomeSuggestion(txt), null);
});
test('parse: rejects garbage / non-JSON / missing mode', () => {
  assert.equal(parseOutcomeSuggestion('not json'), null);
  assert.equal(parseOutcomeSuggestion(''), null);
  assert.equal(parseOutcomeSuggestion('{"options":[]}'), null);
  assert.equal(parseOutcomeSuggestion('{"mode":"nope","options":[]}'), null);
});
