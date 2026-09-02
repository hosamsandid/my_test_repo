'use strict';

// ─── §3.4 baseline gate over every shipped topic (E16 #1891, epic #1870) ──────
//
// `help-topics-content.test.js` guards the *content* of individual topics (the
// concepts a deleted page used to explain must survive). This file guards the
// *floor* every topic has to clear, whoever wrote it:
//
//     what-it-is · 2–3 key tasks · seeAlso · askPrompts
//
// E16's job is "no page gets a single moved sentence dressed up as help", and a
// per-topic checklist in a ticket cannot enforce that — the next topic authored
// after the ticket closes would not be checked. So the gate runs over the whole
// help-topics/ directory instead of a list: a topic that lands later (or a topic
// someone trims down later) is held to the same bar automatically.
//
// Deliberately structural, never stylistic. Every threshold below is set well
// under the shipped topics so it catches a *stub*, not a terse author.

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadRegistry, baselineProblems, OVERVIEW_ID } = require('./help-registry');
const { KNOWN_ROUTE_PATHS, PAGE_ROUTES, CONTEXT_KEYS, isContextKey } = require('./help-routes');

const registry = loadRegistry();

// A topic body is "real help" when it is sectioned and long enough to explain
// something. The thinnest shipped topic is several times these numbers; a
// one-line box moved verbatim clears neither.
const MIN_BODY_CHARS = 500;
const MIN_HEADINGS = 2;
const MIN_ASK_PROMPTS = 2;

test('the topic set is non-empty (the loader found help-topics/)', () => {
  assert.ok(registry.all.length > 0, 'no topics loaded — check help-topics/ and parseTopic');
});

for (const topic of registry.all) {
  const where = `help-topics/${topic.id}.md`;

  test(`${where}: meets the parser-level baseline shape`, () => {
    assert.deepEqual(baselineProblems(topic), []);
    assert.ok(topic.summary.trim(), 'a topic needs a one-line summary for the panel header');
    // "One line" is a promise to the panel header, which does not wrap well.
    assert.ok(
      !/\r?\n/.test(topic.summary),
      'the summary must be a single line (it renders as the panel subtitle)',
    );
  });

  test(`${where}: is real help, not a moved sentence`, () => {
    const headings = (topic.body.match(/^##\s+\S/gm) || []).length;
    assert.ok(
      topic.body.length >= MIN_BODY_CHARS,
      `body is ${topic.body.length} chars, the §3.4 baseline needs at least ${MIN_BODY_CHARS}`,
    );
    assert.ok(
      headings >= MIN_HEADINGS,
      `body has ${headings} section heading(s), the §3.4 baseline needs at least ${MIN_HEADINGS} `
      + '(what-it-is + key tasks)',
    );
  });

  test(`${where}: offers page-scoped questions and related links`, () => {
    assert.ok(
      topic.askPrompts.length >= MIN_ASK_PROMPTS,
      `${topic.askPrompts.length} askPrompt(s) — the baseline needs at least ${MIN_ASK_PROMPTS} `
      + '(they are the escalation path into Ask)',
    );
    for (const p of topic.askPrompts) {
      assert.ok(p.trim().length > 10, `askPrompt "${p}" is too short to be a question`);
    }
    assert.ok(topic.seeAlso.length > 0, 'a topic needs at least one related link');
    for (const link of topic.seeAlso) {
      assert.ok(link.label, 'a related link needs a label');
      assert.ok(
        KNOWN_ROUTE_PATHS.has(link.to),
        `seeAlso "${link.label}" → ${link.to} is not a route the help system knows`,
      );
    }
  });

  test(`${where}: claims routes the help system knows, and owns each of them`, () => {
    if (topic.id === OVERVIEW_ID) {
      // The Overview is the no-route fallback face (concept §2) — it must claim
      // none, or it would shadow a real page.
      assert.deepEqual(topic.routes, [], 'the Overview topic must not claim a route');
      return;
    }
    assert.ok(topic.routes.length > 0, 'a page topic must declare at least one route');
    for (const route of topic.routes) {
      // A topic keys on a page route, or — since E17 (#1892) — on a registered
      // non-route help context (an overlay/wizard-step key). Either way the key
      // must be classified in help-routes.js, never invented at the topic.
      assert.ok(
        isContextKey(route)
          ? Object.prototype.hasOwnProperty.call(CONTEXT_KEYS, route)
          : PAGE_ROUTES.has(route),
        `${route} must be a PAGE_ROUTES or CONTEXT_KEYS entry in help-routes.js`,
      );
      assert.equal(
        registry.topicForRoute(route)?.id, topic.id,
        `${route} resolves to another topic — two topics are claiming the same route`,
      );
    }
  });
}

test('no two topics share an id (a duplicate would silently lose one)', () => {
  assert.equal(registry.byId.size, registry.all.length);
});
