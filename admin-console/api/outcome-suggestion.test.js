'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  heuristicOutcomeSuggestion, buildOutcomeSuggestionRequest, parseOutcomeSuggestion,
  scoreShape, harvestLabels, wakePeerList,
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
// Gate-ness is CONFIGURATION (#928): a token is dropped because the registry
// flags it `humanGate`, never because of how it is spelled.
test('harvestLabels: pulls backtick label tokens, drops flagged human-gate labels', () => {
  const registry = { labels: [{ name: 'approved-for-dispatch', humanGate: true }] };
  const text = 'apply `ready-to-merge`, else `revisions-required`; never `approved-for-dispatch`';
  assert.deepEqual(harvestLabels(text, registry), ['ready-to-merge', 'revisions-required']);
});
test('harvestLabels: an unflagged `human:`-looking token is a plain label now (#928 AC8)', () => {
  assert.deepEqual(harvestLabels('apply `human:approve` then `hold`'), ['human:approve', 'hold']);
});
test('harvestLabels: a brake label is NOT dropped — a brake is agent-appliable (#928 AC3)', () => {
  const registry = { labels: [{ name: 'human-decision-required', brake: true }] };
  assert.deepEqual(harvestLabels('escalate with `human-decision-required`', registry),
    ['human-decision-required']);
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
test('parse: rejects a FLAGGED gate label (data-model validator is the gate)', () => {
  const txt = JSON.stringify({ mode: 'anyOf', options: [{ id: 'g', actions: [{ type: 'setLabel', label: 'approved-for-dispatch' }] }] });
  assert.equal(parseOutcomeSuggestion(txt, { labels: [{ name: 'approved-for-dispatch', humanGate: true }] }), null);
  // Without the flag the very same label is a legitimate agent outcome (#928 AC8).
  assert.ok(parseOutcomeSuggestion(txt));
});
test('buildOutcomeSuggestionRequest names the flagged gate labels the model must avoid (#928)', () => {
  const req = buildOutcomeSuggestionRequest('Dispatcher', 'routes work',
    [{ name: 'approved-for-dispatch', humanGate: true }, { name: 'ready-for-review', humanGate: false }]);
  const text = req.messages[0].content;
  assert.match(text, /"approved-for-dispatch"/);
  assert.ok(!text.includes('"ready-for-review"'), 'a non-gate label must not be forbidden');
  assert.ok(!text.includes('human:'), 'the retired name convention must not be taught to the model');
});
test('parse: rejects garbage / non-JSON / missing mode', () => {
  assert.equal(parseOutcomeSuggestion('not json'), null);
  assert.equal(parseOutcomeSuggestion(''), null);
  assert.equal(parseOutcomeSuggestion('{"options":[]}'), null);
  assert.equal(parseOutcomeSuggestion('{"mode":"nope","options":[]}'), null);
});

// ── wakeAgent in the action enum (#2032, concept §4.3) ──────────────────────

test('wakePeerList keeps agents, drops actors, humans, self and duplicates', () => {
  // On a LIVE team the peer list is the graph's node list, which also carries
  // the actor pseudo-nodes (@github / @external / @timer, kind 'actor') and the
  // named human roles — none of which has a pending queue, so none can be
  // handed off to. A draft role carries no `kind` at all and stays eligible.
  const peers = wakePeerList([
    { id: 'rev', displayName: 'Reviewer', kind: 'agent' },
    { id: 'docs' },
    { id: '@github', kind: 'actor' },
    { id: 'lead', displayName: 'Tech Lead', kind: 'human' },
    { id: 'rev', displayName: 'Reviewer again', kind: 'agent' },
    { id: 'dev', kind: 'agent' },
    { id: '   ' },
    null,
    'nope',
  ], 'dev');
  assert.deepEqual(peers, [
    { id: 'rev', name: 'Reviewer' },
    { id: 'docs', name: 'docs' },
  ]);
});

test('wakePeerList is safe on junk input', () => {
  assert.deepEqual(wakePeerList(undefined, undefined), []);
  assert.deepEqual(wakePeerList('nope', 'x'), []);
});

test('buildOutcomeSuggestionRequest teaches wakeAgent only with a peer list', () => {
  const withPeers = buildOutcomeSuggestionRequest('Developer', 'implements issues', undefined, {
    peers: [{ id: 'rev', displayName: 'Reviewer' }, { id: 'docs' }], roleId: 'dev',
  }).messages[0].content;
  assert.match(withPeers, /"type":"wakeAgent"/);
  assert.match(withPeers, /"rev" \(Reviewer\)/);
  assert.match(withPeers, /"docs"/);
  assert.ok(!/Do NOT use a "wakeAgent" action/.test(withPeers));
});

test('buildOutcomeSuggestionRequest FORBIDS wakeAgent when no peers are known', () => {
  // Told nothing, the model would have to guess a role id — and a guess is
  // rejected by validateOutcomes, which sinks the WHOLE suggestion back to the
  // heuristic. An unusable action type is worse than an absent one.
  const text = buildOutcomeSuggestionRequest('Developer', 'implements issues').messages[0].content;
  assert.ok(!text.includes('"type":"wakeAgent"'));
  assert.match(text, /Do NOT use a "wakeAgent" action/);
  // The four original action types are untouched either way.
  for (const t of ['setLabel', 'openPr', 'openIssue', 'none']) {
    assert.ok(text.includes(t), t);
  }
});

test('parse: accepts a wakeAgent naming a real peer, and keeps to + note', () => {
  const txt = JSON.stringify({ mode: 'anyOf', options: [{
    id: 'handed-off', title: 'Handed off',
    actions: [{ type: 'wakeAgent', to: 'rev', note: 'mind step 3' }],
  }] });
  const port = parseOutcomeSuggestion(txt, { agents: [{ id: 'rev' }], roleId: 'dev' });
  assert.ok(port);
  assert.deepEqual(port.options[0].actions, [{ type: 'wakeAgent', to: 'rev', note: 'mind step 3' }]);
});

test('parse: an INVENTED hand-off target sinks the whole suggestion', () => {
  // This is why the route must thread the same peer list into both halves: the
  // enum in the prompt and the `agents` source here. Without the source a
  // hallucinated id would validate and persist as an edge into nothing.
  const txt = JSON.stringify({ mode: 'anyOf', options: [{
    id: 'h', actions: [{ type: 'wakeAgent', to: 'ghost' }],
  }] });
  assert.equal(parseOutcomeSuggestion(txt, { agents: [{ id: 'rev' }], roleId: 'dev' }), null);
  // A self-hand-off is refused the same way (delivery answers it 403).
  const selfTxt = JSON.stringify({ mode: 'anyOf', options: [{
    id: 'h', actions: [{ type: 'wakeAgent', to: 'dev' }],
  }] });
  assert.equal(parseOutcomeSuggestion(selfTxt, { agents: [{ id: 'dev' }, { id: 'rev' }], roleId: 'dev' }), null);
});
