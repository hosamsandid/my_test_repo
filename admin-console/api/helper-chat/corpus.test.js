'use strict';

// Parity + budget guard for the Helper Chat corpus (#1733).
// Mirrors admin-console/api/flow-copilot.test.js: the vendored docs next to this
// module must stay byte-identical to their repo-root sources (the runtime image
// cannot reach repo-root docs/), and the assembled system prompt must fit the
// char budget before it is ever sent to a model.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const {
  buildSystemPrompt,
  measureSystemPrompt,
  measureWorstCaseSystemPrompt,
  SYSTEM_PROMPT_CHAR_LIMIT,
  CORPUS_FILES,
} = require('./corpus');
const helpRegistry = require('./help-registry');

// docs/ lives at the repo root, two levels up from admin-console/api/helper-chat.
const REPO_DOCS = path.join(__dirname, '..', '..', '..', 'docs');
const VENDORED_DOCS = path.join(__dirname, 'docs');

test('every corpus file is vendored byte-identical to its docs/ source', () => {
  for (const f of CORPUS_FILES) {
    const source = fs.readFileSync(path.join(REPO_DOCS, f), 'utf8');
    const vendored = fs.readFileSync(path.join(VENDORED_DOCS, f), 'utf8');
    assert.equal(vendored, source, `vendored copy of ${f} drifted from docs/${f}`);
  }
});

test('system-prompt.md exists and carries the corpus marker', () => {
  const template = fs.readFileSync(path.join(__dirname, 'system-prompt.md'), 'utf8');
  assert.ok(
    template.includes('[corpus is appended here at runtime]'),
    'system-prompt.md must contain the runtime corpus marker',
  );
});

test('buildSystemPrompt splices the corpus and drops the marker', () => {
  const prompt = buildSystemPrompt(null);
  assert.ok(!prompt.includes('[corpus is appended here at runtime]'), 'marker must be replaced');
  // A doc heading and a term from the glossary prove the corpus was spliced in.
  assert.ok(prompt.includes('### glossary.md'), 'corpus section headings must be present');
});

test('buildSystemPrompt appends the current-page context when given a route label', () => {
  const prompt = buildSystemPrompt('Flows');
  assert.ok(prompt.includes('currently on the **Flows** page'), 'route label must be appended');
  // No route label → no page-context sentence.
  assert.ok(!buildSystemPrompt(null).includes('currently on the'), 'no route → no page context');
});

test('the page-help topics are folded into the grounding prompt (#1872 single source)', () => {
  const prompt = buildSystemPrompt(null);
  // The Overview pilot topic ships in help-topics/ and must be present in the
  // same system prompt the panel serves — this is the "no vendoring" single
  // source in action.
  assert.ok(prompt.includes('### page-help topics'), 'help topics section must be spliced in');
  assert.ok(prompt.includes('Welcome to Agent Studio'), 'the Overview topic title must be present');
});

test('a currentRoute with a topic adds a page-grounding pointer', () => {
  // The Overview topic has no route, so use a label + route pair that resolves
  // to nothing → no pointer; and confirm the label sentence is independent.
  const withLabel = buildSystemPrompt('Skills', '/skills');
  assert.ok(withLabel.includes('currently on the **Skills** page'));
  // No route argument → no page-topic pointer sentence.
  assert.ok(!buildSystemPrompt('Skills').includes('maps to the help topic'));
});

test('measured system prompt is below the char limit', () => {
  const n = measureSystemPrompt();
  assert.ok(
    n < SYSTEM_PROMPT_CHAR_LIMIT,
    `assembled prompt is ${n} chars, over the ${SYSTEM_PROMPT_CHAR_LIMIT} limit`,
  );
});

// ── route-scoped grounding (#2006) ───────────────────────────────────────────

test('the WORST assembled prompt the mechanism can produce is below the char limit', () => {
  // The guard measures a real assembled prompt (the docs corpus plus the biggest
  // page neighbourhood the fold can pick), not the all-topics fold nothing sends
  // any more — AC3. Any context could become the worst one after a topic edit,
  // so the sweep is over every context, not a hardcoded route.
  const worst = measureWorstCaseSystemPrompt();
  assert.ok(worst.length > 0, 'a worst case must be measurable');
  assert.ok(
    worst.length < SYSTEM_PROMPT_CHAR_LIMIT,
    `worst assembled prompt (context ${String(worst.context)}) is ${worst.length} chars, `
    + `over the ${SYSTEM_PROMPT_CHAR_LIMIT} limit`,
  );
  // Every single context must fit, not just the one the sweep named.
  const registry = helpRegistry.loadRegistry();
  for (const context of helpRegistry.groundingContexts(registry)) {
    const n = buildSystemPrompt(context || null, context).length;
    assert.ok(n <= worst.length, `context ${String(context)} (${n}) exceeds the reported worst case`);
  }
});

test('a route with a topic grounds on that topic and its seeAlso neighbours only', () => {
  // /models links to /environments, /chats and /token-usage — and to nothing
  // else, so the unrelated topics must be absent (AC1). The middle link was
  // /agents until #1930 removed that page and its topic.
  const prompt = buildSystemPrompt('Model Providers', '/models');
  const registry = helpRegistry.loadRegistry();
  const included = helpRegistry.contextTopics(registry, '/models').map(t => t.id);
  assert.deepEqual(included, ['models', 'environments', 'agent-chat', 'token-usage']);
  // Assert inside the help-topics block: a topic *title* can legitimately also be
  // a heading in the docs corpus (which is unchanged and always folded in full),
  // so scanning the whole prompt would report a false presence.
  const foldBlock = prompt.slice(prompt.indexOf('### page-help topics'));
  for (const t of registry.all) {
    // foldTopics heads a topic `## <title> (routes: …)`, or `## <title>` when it
    // claims none (the Overview topic) — so the absence check is never vacuous.
    const heading = (t.routes || []).length ? `## ${t.title || t.id} (routes:` : `## ${t.title || t.id}`;
    if (included.includes(t.id)) {
      assert.ok(foldBlock.includes(heading), `${t.id} must be folded in for /models`);
    } else {
      assert.ok(!foldBlock.includes(heading), `${t.id} must NOT be folded in for /models`);
    }
  }
  // Sanity: the set is a real narrowing, not "everything anyway".
  assert.ok(included.length < registry.all.length, 'the fold must be narrower than the whole set');
});

test('no resolvable route still gets grounding: the Overview topic and its neighbours', () => {
  // AC2 — the Ask face opened outside a topic-bearing route, and any caller that
  // passes no route at all.
  const registry = helpRegistry.loadRegistry();
  const fallback = helpRegistry.contextTopics(registry, null).map(t => t.id);
  assert.equal(fallback[0], 'overview', 'the Overview topic leads the fallback');
  assert.ok(fallback.length > 1, 'the fallback carries the Overview neighbours too');
  const prompt = buildSystemPrompt(null);
  assert.ok(prompt.includes('### page-help topics'), 'a grounding block must still be present');
  assert.ok(prompt.includes('### glossary.md'), 'the docs corpus is always present in full');
  // An unknown pathname resolves to nothing and takes the same fallback (it adds
  // no route pointer either, so the prompt is byte-identical to the no-route one).
  assert.equal(
    buildSystemPrompt(null, '/not-a-route'),
    buildSystemPrompt(null),
    'an unresolvable route grounds like no route',
  );
});

test('the prompt states that other pages\' topics are not included', () => {
  // The narrowing is a real limit on what the model has in front of it, so it is
  // declared rather than left to be discovered by an invented answer.
  const prompt = buildSystemPrompt('Skills', '/skills');
  assert.match(prompt, /other pages' topics are not included/);
});

test('one more page topic of typical size does not move the worst case by its size', () => {
  // AC4, demonstrated rather than asserted in prose: build a synthetic registry
  // that is the shipped topic set plus one new ~10 000-char page topic nothing
  // links to, and compare the worst case before and after.
  const topics = helpRegistry.loadTopics();
  const before = helpRegistry.worstCaseFold(helpRegistry.buildRegistry(topics));
  const newTopic = {
    id: 'synthetic-new-page',
    routes: ['/synthetic-new-page'],
    title: 'A New Page',
    summary: 'A new page of typical topic size.',
    seeAlso: [{ label: 'Agent Chat', to: '/chats' }],
    askPrompts: ['What is this?'],
    actions: [],
    body: 'x'.repeat(10_000),
  };
  const after = helpRegistry.worstCaseFold(helpRegistry.buildRegistry([...topics, newTopic]));
  assert.equal(after.length, before.length, 'the worst case must not grow at all');

  // The contrast that makes the point: under the all-topics fold it replaced, the
  // same addition would have cost its full size on EVERY request.
  const foldBefore = helpRegistry.foldTopics(topics).length;
  const foldAfter = helpRegistry.foldTopics([...topics, newTopic]).length;
  assert.ok(foldAfter - foldBefore >= 10_000, 'the old mechanism grew by the topic\'s full size');
});
