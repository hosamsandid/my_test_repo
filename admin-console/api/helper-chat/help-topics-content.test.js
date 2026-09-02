'use strict';

// ─── Shipped-topic content guard (#1875, epic #1870 Phase 3) ──────────────────
//
// The Phase-3 extraction tickets DELETE the big on-page explainer boxes and move
// their copy into help-topics/*.md. Once the page that carried a concept is gone,
// the only thing standing between that concept and silent rot is an assertion
// over the SHIPPED topic files — parser unit tests (help-registry.test.js) prove
// the format, not the content.
//
// So: for every topic listed below, assert the baseline shape, that its declared
// routes really resolve to it, that its `seeAlso` links point at routes the help
// system knows, and that the concepts lifted from the deleted page survive.
// Later extraction tickets (E2–E15) add one entry per authored topic.

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadRegistry, baselineProblems } = require('./help-registry');
const { KNOWN_ROUTE_PATHS } = require('./help-routes');

// Concepts each topic must still carry, as case-insensitive substrings of the
// rendered topic text (front-matter summary + body). Deliberately phrased as
// short, stable fragments — a reword is fine, dropping the concept is not.
const TOPIC_CONTENT = [
  {
    id: 'agents',
    routes: ['/agents'],
    // #1875 lifted these from the Agents page: the "what is an agent" box, the
    // role catalogue (incl. the Agent-Team-vs-Team warning), the lifecycle
    // states, and the Disable / Reset-to-stub / Delete distinction.
    concepts: [
      'long-running Claude Code instance',
      'Agent Chat',
      'Agent Team',
      'Team Member',
      'Orchestrator',
      'BriefingPack',
      'access scope',
      'Active',
      'paused',
      'not initialised',
      'Disable',
      'Reset to stub',
      'Delete',
      'System Prompt',
      'Skills',
      'Plugins',
      'Host context folders',
    ],
  },
  {
    id: 'environments',
    routes: ['/environments'],
    // #1880 lifted the "What is a Working Environment?" box: the reusable-recipe
    // definition, what an agent inherits (repos / token / MCP refs / provider /
    // additional instructions), the shared-recipe-but-own-workspace point, the
    // SSH-vs-token rule, read-only repositories and the cloned-at-creation /
    // Sync-all-agents caveat.
    concepts: [
      'reusable workspace recipe',
      'own isolated workspace',
      'Git repositories',
      'GitHub token',
      'MCP servers',
      'Model provider',
      'Additional instructions',
      'no repository at all',
      'SSH key',
      'HTTPS',
      'Read-only',
      'newly created agents',
      'Sync all agents',
    ],
  },
];

const registry = loadRegistry();

for (const spec of TOPIC_CONTENT) {
  const topic = registry.byId.get(spec.id);

  test(`topic ${spec.id}: exists and meets the baseline shape`, () => {
    assert.ok(topic, `help-topics/${spec.id}.md must define topic id "${spec.id}"`);
    assert.deepEqual(baselineProblems(topic), []);
    assert.ok(topic.summary.trim(), 'a topic needs a one-line summary for the panel header');
  });

  test(`topic ${spec.id}: claims exactly its declared routes, and they resolve`, () => {
    assert.deepEqual(topic.routes, spec.routes);
    for (const route of spec.routes) {
      assert.ok(KNOWN_ROUTE_PATHS.has(route), `${route} must be classified in help-routes.js`);
      assert.equal(registry.topicForRoute(route)?.id, spec.id);
    }
  });

  test(`topic ${spec.id}: every seeAlso link points at a known route`, () => {
    for (const link of topic.seeAlso) {
      assert.ok(link.label, 'a related link needs a label');
      assert.ok(
        KNOWN_ROUTE_PATHS.has(link.to),
        `seeAlso "${link.label}" → ${link.to} is not a route the help system knows`,
      );
    }
  });

  test(`topic ${spec.id}: the concepts lifted from the page survive`, () => {
    const hay = `${topic.summary}\n${topic.body}`.toLowerCase();
    const lost = spec.concepts.filter((c) => !hay.includes(c.toLowerCase()));
    assert.deepEqual(
      lost, [],
      `help-topics/${spec.id}.md no longer mentions: ${lost.join(', ')} — `
      + 'the page that used to explain these is gone, so the topic is the only home left.',
    );
  });
}
