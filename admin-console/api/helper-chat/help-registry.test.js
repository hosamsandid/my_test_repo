'use strict';

// Unit tests for the context-help topic registry (#1872).
// Pure parsing + resolution over fixture topics, plus a load of the real
// help-topics/ dir to prove the pilot Overview topic parses end-to-end.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const {
  parseTopic,
  buildRegistry,
  foldTopics,
  contextTopics,
  foldTopicsForContext,
  groundingContexts,
  worstCaseFold,
  routeGroundingPointer,
  baselineTopic,
  baselineProblems,
  loadTopics,
  loadRegistry,
  loadPluginTopics,
  pluginTopicsForContext,
  OVERVIEW_ID,
} = require('./help-registry');
const fs = require('fs');
const os = require('os');

// ── front-matter parsing ──────────────────────────────────────────────────────

const SAMPLE = `---
id: agents
routes: ["/agents", "/agents/new"]
title: Agents
summary: One line under the title.
seeAlso:
  - { label: "Working Environments", to: "/environments" }
  - { label: "Access", to: "/teams" }
askPrompts:
  - "What is the difference between an Agent and an Agent Team?"
  - "When should I disable vs delete an agent?"
---

## What is an agent?

An agent is a single AI worker.`;

test('parseTopic reads front-matter fields and body', () => {
  const t = parseTopic(SAMPLE, 'fallback');
  assert.equal(t.id, 'agents');
  assert.deepEqual(t.routes, ['/agents', '/agents/new']);
  assert.equal(t.title, 'Agents');
  assert.equal(t.summary, 'One line under the title.');
  assert.deepEqual(t.seeAlso, [
    { label: 'Working Environments', to: '/environments' },
    { label: 'Access', to: '/teams' },
  ]);
  assert.equal(t.askPrompts.length, 2);
  assert.match(t.askPrompts[0], /difference between an Agent/);
  assert.match(t.body, /^## What is an agent\?/);
});

test('parseTopic falls back to the filename id and handles empty arrays', () => {
  const t = parseTopic('---\ntitle: X\nroutes: []\naskPrompts:\n  - "q"\n---\nbody', 'stem');
  assert.equal(t.id, 'stem');
  assert.deepEqual(t.routes, []);
});

test('parseTopic returns null without front-matter', () => {
  assert.equal(parseTopic('no front matter here', 'x'), null);
});

// ── `actions` CTAs (#1874) ────────────────────────────────────────────────────

test('parseTopic reads the actions block as navigation + panel-verb CTAs', () => {
  const t = parseTopic([
    '---',
    'id: overview',
    'title: Welcome',
    'actions:',
    '  - { label: "Create a single agent", to: "/quickstart", primary: true }',
    '  - { label: "Set up a team", to: "/team-setup" }',
    '  - { label: "Take the Tour", action: "tour" }',
    '---',
    'body',
  ].join('\n'), 'overview');
  assert.deepEqual(t.actions, [
    { label: 'Create a single agent', to: '/quickstart', action: '', primary: true },
    { label: 'Set up a team', to: '/team-setup', action: '' },
    { label: 'Take the Tour', to: '', action: 'tour' },
  ]);
});

test('parseTopic drops CTAs that could only render a dead button', () => {
  const t = parseTopic([
    '---',
    'id: x',
    'title: X',
    'actions:',
    '  - { to: "/quickstart" }',              // no label
    '  - { label: "Nowhere" }',               // neither to nor action
    '  - { label: "Bogus", action: "wipe" }', // unknown panel verb
    '  - plain string item',                  // not an object
    '  - { label: "Ok", to: "/models" }',
    '---',
    'body',
  ].join('\n'), 'x');
  assert.deepEqual(t.actions, [{ label: 'Ok', to: '/models', action: '' }]);
});

test('parseTopic defaults actions to an empty list and keeps other blocks intact', () => {
  const t = parseTopic(SAMPLE, 'fallback');
  assert.deepEqual(t.actions, []);
  assert.equal(t.seeAlso.length, 2); // the actions key does not disturb seeAlso
});

// ── route resolution (static / dynamic / alias / redirect) ────────────────────

function fixtureRegistry() {
  return buildRegistry([
    { id: OVERVIEW_ID, routes: [], title: 'Overview', summary: 'home', seeAlso: [], askPrompts: ['hi'], body: 'overview body' },
    { id: 'agents', routes: ['/agents'], title: 'Agents', summary: 'agents', seeAlso: [], askPrompts: ['a'], body: 'agents body' },
    { id: 'chat', routes: ['/chats'], title: 'Agent Chat', summary: 'chat', seeAlso: [], askPrompts: ['c'], body: 'chat body' },
    { id: 'team', routes: ['/team-setup'], title: 'Team Wizard', summary: 'team', seeAlso: [], askPrompts: ['t'], body: 'team body' },
    { id: 'flows', routes: ['/flows'], title: 'Flows', summary: 'flows', seeAlso: [], askPrompts: ['f'], body: 'flows body' },
  ]);
}

test('topicForRoute resolves a static route', () => {
  assert.equal(fixtureRegistry().topicForRoute('/agents').id, 'agents');
});

test('topicForRoute resolves a dynamic child route to its parent', () => {
  assert.equal(fixtureRegistry().topicForRoute('/chats/agent-42').id, 'chat');
});

test('topicForRoute resolves an alias route', () => {
  assert.equal(fixtureRegistry().topicForRoute('/wizard/team').id, 'team');
});

test('topicForRoute resolves a redirect source to its destination topic', () => {
  const reg = fixtureRegistry();
  assert.equal(reg.topicForRoute('/').id, 'chat');            // / → /chats
  assert.equal(reg.topicForRoute('/blueprints').id, 'chat'); // /blueprints → /chats (#1930)
  assert.equal(reg.topicForRoute('/process/team-x').id, 'flows'); // dynamic redirect → /flows
});

test('topicForRoute returns null for a route with no topic (Overview fallback)', () => {
  assert.equal(fixtureRegistry().topicForRoute('/skills'), null);
  assert.equal(fixtureRegistry().topicForRoute('/plugins/foo/view'), null); // allowlisted viewer
});

test('registry exposes the overview topic by id', () => {
  assert.equal(fixtureRegistry().overview.id, OVERVIEW_ID);
});

// ── corpus fold + grounding ───────────────────────────────────────────────────

test('foldTopics concatenates titles, summaries and bodies', () => {
  const folded = foldTopics([
    { id: 'a', routes: ['/a'], title: 'A', summary: 'sa', body: 'body a' },
    { id: 'b', routes: [], title: 'B', summary: '', body: 'body b' },
  ]);
  assert.match(folded, /## A \(routes: \/a\)/);
  assert.match(folded, /sa/);
  assert.match(folded, /body a/);
  assert.match(folded, /## B\n/);
  assert.match(folded, /body b/);
});

// ── route-scoped grounding fold (#2006) ───────────────────────────────────────

// A fixture set with real seeAlso wiring: `a` links to `b` (a topic) and to
// `/nowhere` (a route no topic claims — the "skip it, do not fail" edge case).
function scopedRegistry() {
  return buildRegistry([
    { id: OVERVIEW_ID, routes: [], title: 'Overview', summary: '', seeAlso: [{ label: 'A', to: '/a' }], askPrompts: ['hi'], body: 'overview body' },
    { id: 'a', routes: ['/a'], title: 'A', summary: '', body: 'body a', askPrompts: ['q'], seeAlso: [{ label: 'B', to: '/b' }, { label: 'Nope', to: '/nowhere' }] },
    { id: 'b', routes: ['/b'], title: 'B', summary: '', body: 'body b', askPrompts: ['q'], seeAlso: [] },
    { id: 'c', routes: ['/c'], title: 'C', summary: '', body: 'body c', askPrompts: ['q'], seeAlso: [] },
    // Two routes, one topic (credentials.md's shape) + an aliased context key.
    { id: 'creds', routes: ['/ssh-keys', '/github-tokens'], title: 'Creds', summary: '', body: 'body creds', askPrompts: ['q'], seeAlso: [{ label: 'C', to: '/c' }] },
  ]);
}

test('contextTopics returns the route topic plus its seeAlso neighbours', () => {
  const reg = scopedRegistry();
  assert.deepEqual(contextTopics(reg, '/a').map((t) => t.id), ['a', 'b']);
  // The unrelated topic is not in the set — that is the whole point.
  assert.ok(!contextTopics(reg, '/a').some((t) => t.id === 'c'));
});

test('a seeAlso pointing at a route with no topic is skipped, not an error', () => {
  const reg = scopedRegistry();
  // `/nowhere` is claimed by nobody; the fold still contains `a` and `b`.
  const folded = foldTopicsForContext(reg, '/a');
  assert.match(folded, /body a/);
  assert.match(folded, /body b/);
  assert.doesNotMatch(folded, /body c/);
});

test('an unresolvable context falls back to the Overview topic and its neighbours', () => {
  const reg = scopedRegistry();
  for (const ctx of [null, undefined, '', '/not-a-route', { route: '/not-a-route' }]) {
    assert.deepEqual(contextTopics(reg, ctx).map((t) => t.id), [OVERVIEW_ID, 'a'],
      `unresolvable context ${JSON.stringify(ctx)} must take the Overview fallback`);
  }
});

test('a registry with no topics at all folds to an empty block', () => {
  // Fail-soft: a missing help-topics dir must leave the docs corpus unchanged.
  assert.deepEqual(contextTopics(buildRegistry([]), '/a'), []);
  assert.equal(foldTopicsForContext(buildRegistry([]), '/a'), '');
});

test('every route of a multi-route topic grounds on the same topic set', () => {
  // credentials.md is claimed by three routes; a reader arriving from any of them
  // must get the grounding the panel would show, not a route-order accident.
  const reg = scopedRegistry();
  assert.equal(foldTopicsForContext(reg, '/ssh-keys'), foldTopicsForContext(reg, '/github-tokens'));
  assert.deepEqual(contextTopics(reg, '/ssh-keys').map((t) => t.id), ['creds', 'c']);
});

test('a dynamic child route and a redirect source ground like their canonical route', () => {
  const reg = buildRegistry([
    { id: OVERVIEW_ID, routes: [], title: 'Overview', summary: '', seeAlso: [], askPrompts: ['hi'], body: 'overview body' },
    { id: 'chat', routes: ['/chats'], title: 'Chat', summary: '', body: 'chat body', askPrompts: ['q'], seeAlso: [] },
  ]);
  assert.deepEqual(contextTopics(reg, '/chats/agent-42').map((t) => t.id), ['chat']);
  assert.deepEqual(contextTopics(reg, '/').map((t) => t.id), ['chat']); // / → /chats
});

test('an overlay with no topic and no alias falls through to the page underneath', () => {
  // `modal:skill-detail` is registered for the z-index lift only (#1990), so a
  // question asked with it open is grounded on the page's topic.
  const reg = scopedRegistry();
  assert.deepEqual(
    contextTopics(reg, { route: '/a', overlay: 'modal:skill-detail' }).map((t) => t.id),
    ['a', 'b'],
  );
});

test('groundingContexts covers the fallback plus every claimed key', () => {
  const contexts = groundingContexts(scopedRegistry());
  assert.equal(contexts[0], null, 'the no-route fallback is a measured context');
  for (const key of ['/a', '/b', '/c', '/ssh-keys', '/github-tokens']) {
    assert.ok(contexts.includes(key), `${key} must be measured`);
  }
});

test('worstCaseFold names the largest context; an unlinked new topic does not enlarge it', () => {
  // Sized like the real set (one dense page plus its neighbour, small others) so
  // the new topic's own context cannot itself be the largest — in the shipped
  // registry the worst neighbourhood is ~66 000 chars, far above one page.
  const topics = [
    { id: OVERVIEW_ID, routes: [], title: 'Overview', summary: '', seeAlso: [], askPrompts: ['hi'], body: 'overview body' },
    { id: 'a', routes: ['/a'], title: 'A', summary: '', askPrompts: ['q'], seeAlso: [{ label: 'B', to: '/b' }], body: 'x'.repeat(40_000) },
    { id: 'b', routes: ['/b'], title: 'B', summary: '', askPrompts: ['q'], seeAlso: [], body: 'body b' },
    { id: 'c', routes: ['/c'], title: 'C', summary: '', askPrompts: ['q'], seeAlso: [], body: 'body c' },
  ];
  const before = worstCaseFold(buildRegistry(topics));
  assert.equal(before.context, '/a', 'the densest neighbourhood is the worst case');

  // A new page nobody links to: its own context is a new candidate, but a small
  // one — the worst case does not move at all.
  const added = { id: 'new', routes: ['/new'], title: 'New', summary: '', body: 'x'.repeat(10_000), askPrompts: ['q'], seeAlso: [] };
  assert.equal(worstCaseFold(buildRegistry([...topics, added])).length, before.length);

  // The honest limit of the mechanism, stated as a test rather than left to be
  // discovered: EXPANDING a topic the worst context links to does enlarge it — by
  // that topic's growth, not by the sum of every topic's.
  const grown = topics.map((t) => (t.id === 'b' ? { ...t, body: 'x'.repeat(10_000) } : t));
  const after = worstCaseFold(buildRegistry(grown));
  assert.equal(after.context, '/a');
  assert.equal(after.length - before.length, 10_000 - 'body b'.length);
});

test('routeGroundingPointer points at the resolved topic, empty otherwise', () => {
  const reg = fixtureRegistry();
  assert.match(routeGroundingPointer(reg, '/agents'), /help topic "Agents"/);
  assert.equal(routeGroundingPointer(reg, '/skills'), ''); // no topic → no pointer
  assert.equal(routeGroundingPointer(reg, undefined), '');
});

// ── baseline template (§3.4) ──────────────────────────────────────────────────

test('baselineTopic produces a valid what-it-is + key-tasks topic', () => {
  const t = baselineTopic({
    id: 'about', routes: ['/about'], title: 'About', summary: 'Version info.',
    keyTasks: ['Read the version', 'Check the licence'],
    askPrompts: ['What version am I on?'],
  });
  assert.equal(baselineProblems(t).length, 0);
  assert.match(t.body, /## What is About\?/);
  assert.match(t.body, /- Read the version/);
});

test('baselineTopic caps key tasks at three', () => {
  const t = baselineTopic({ id: 'x', title: 'X', keyTasks: ['1', '2', '3', '4'], askPrompts: ['q'] });
  assert.equal((t.body.match(/^- /gm) || []).length, 3);
});

test('baselineProblems flags a topic missing an askPrompt', () => {
  const problems = baselineProblems({ id: 'x', title: 'X', body: 'b', seeAlso: [], askPrompts: [] });
  assert.ok(problems.some((p) => /askPrompt/.test(p)));
});

test('baselineTopic requires id and title', () => {
  assert.throws(() => baselineTopic({ title: 'no id' }));
});

// ── real pilot topic loads end-to-end ─────────────────────────────────────────

test('the real help-topics dir loads and includes the Overview pilot', () => {
  const reg = loadRegistry(path.join(__dirname, 'help-topics'));
  assert.ok(reg.overview, 'the Overview topic must be present');
  assert.equal(reg.overview.id, OVERVIEW_ID);
  assert.ok(reg.overview.askPrompts.length > 0, 'Overview must carry askPrompts');
  assert.ok(reg.foldTopics().length > 0, 'topics must fold into a grounding block');
});

// G1 (#1874) folded the retired Getting Started page into the Overview face: the
// six concepts became its body/related links and the "where to go next" row plus
// the Take-the-Tour button became its CTAs. Guard both so the page's content
// cannot silently be lost now that the page itself is gone.
test('the Overview topic carries the former Getting Started concepts and CTAs', () => {
  const reg = loadRegistry(path.join(__dirname, 'help-topics'));
  const body = reg.overview.body;
  for (const concept of ['Agents', 'Administration', 'Flows', 'Environment', 'Knowledge', 'Model Providers']) {
    assert.match(body, new RegExp(`\\*\\*${concept}\\*\\*`), `Overview body must explain ${concept}`);
  }
  const linked = reg.overview.seeAlso.map((s) => s.to);
  // `/agents` was in this list until #1930 removed the page; the **Agents**
  // concept above still has to be explained (it is a thing, not a page), but
  // the link now points at `/chats`, which is where you meet one.
  // `/teams` was in this list until #2085 dissolved the Access page; the concept
  // it stood for is now **Administration**, and the link points at `/users`.
  // `/environments` was in this list until #2170 retired the page; the concept
  // it stood for is now **Environment**, and the link points at the
  // System-Admin Environment Templates catalog that replaced it.
  for (const to of ['/chats', '/users', '/flows', '/environment-templates', '/knowledge', '/models']) {
    assert.ok(linked.includes(to), `Overview must link to ${to}`);
  }
  const ctas = reg.overview.actions;
  assert.deepEqual(ctas.filter((c) => c.to).map((c) => c.to), ['/quickstart', '/team-setup', '/models']);
  assert.ok(ctas.some((c) => c.action === 'tour'), 'Overview must keep a Take-the-Tour CTA');
  assert.equal(ctas.filter((c) => c.primary).length, 1, 'exactly one CTA is the primary action');
});

test('loadTopics is fail-soft on a missing dir', () => {
  assert.deepEqual(loadTopics(path.join(__dirname, 'does-not-exist')), []);
});

// ── plugin-contributed topics ────────────────────────────────────────────────
//
// An installed plugin may ship `help/*.md` topics in the same format. They are
// folded into the grounding of the contexts they name as NEIGHBOURS — after the
// page's own topic and its seeAlso — and never claim a route as its primary
// topic, so the "This page" face and the corpus budget of every page stay
// exactly what the built-in topics make them.

const JIRA_TOPIC = { id: 'jira', routes: ['/a', '/plugins/jira/view'], title: 'Jira plugin', summary: 'j', body: 'body jira', askPrompts: ['q'], seeAlso: [] };

test('pluginTopicsForContext: a plugin topic is picked for the routes it names, canonical/alias-aware', () => {
  const list = [JIRA_TOPIC, { ...JIRA_TOPIC, id: 'other', routes: ['/c'] }];
  assert.deepEqual(pluginTopicsForContext(list, '/a').map((t) => t.id), ['jira']);
  // a dynamic child route resolves to its canonical route
  assert.deepEqual(pluginTopicsForContext(list, '/plugins/jira/view').map((t) => t.id), ['jira']);
  assert.deepEqual(pluginTopicsForContext(list, '/b'), []);
  assert.deepEqual(pluginTopicsForContext([], '/a'), []);
  assert.deepEqual(pluginTopicsForContext(null, '/a'), []);
});

test('a plugin topic never becomes the primary topic of a route it names', () => {
  const reg = buildRegistry(scopedRegistry().all, [JIRA_TOPIC]);
  assert.equal(reg.topicForRoute('/a').id, 'a');
  // …even for a route no built-in topic claims: the panel keeps its Overview fallback
  assert.equal(reg.topicForRoute('/plugins/jira/view'), null);
});

test('contextTopics appends the matching plugin topics after the page topic and its neighbours', () => {
  const reg = buildRegistry(scopedRegistry().all, [JIRA_TOPIC]);
  assert.deepEqual(contextTopics(reg, '/a').map((t) => t.id), ['a', 'b', 'jira']);
  assert.deepEqual(contextTopics(reg, '/c').map((t) => t.id), ['c']);
  assert.match(foldTopicsForContext(reg, '/a'), /body jira/);
  assert.doesNotMatch(foldTopicsForContext(reg, '/c'), /body jira/);
});

test('groundingContexts covers the routes only a plugin topic names, so the budget sweep sees them', () => {
  const reg = buildRegistry(scopedRegistry().all, [JIRA_TOPIC]);
  assert.ok(groundingContexts(reg).includes('/plugins/jira/view'));
});

test('a plugin-only route (no built-in topic) grounds on the plugin topic + Overview, not the Overview neighbours', () => {
  // /plugins/jira/view is claimed by the Jira plugin but by no built-in topic.
  // Without the slim it would inherit the Overview fallback's seeAlso fold — in
  // production that is ~every page (~141k chars). With it, the fold is just the
  // plugin's own topic plus the Overview topic itself (general orientation).
  const reg = buildRegistry(scopedRegistry().all, [JIRA_TOPIC]);
  assert.deepEqual(contextTopics(reg, '/plugins/jira/view').map((t) => t.id), [OVERVIEW_ID, 'jira']);
  // The Overview neighbour `a` rides along on the generic no-route fallback (see
  // the 'unresolvable context' test) but must NOT here — that is the saving.
  assert.ok(!contextTopics(reg, '/plugins/jira/view').some((t) => t.id === 'a'));
  // A route NO plugin names still takes the full Overview-plus-neighbours fallback.
  assert.deepEqual(contextTopics(reg, '/not-a-route').map((t) => t.id), [OVERVIEW_ID, 'a']);
});

test('loadPluginTopics reads <dir>/<plugin>/help/*.md, tags the plugin id, and is fail-soft', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aee-plugin-help-'));
  fs.mkdirSync(path.join(dir, 'jira', 'help'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'echo'), { recursive: true }); // no help dir → nothing
  fs.mkdirSync(path.join(dir, '_credentials'), { recursive: true }); // not a plugin
  fs.writeFileSync(path.join(dir, 'jira', 'help', 'jira.md'), SAMPLE.replace('id: agents', 'id: jira'));
  fs.writeFileSync(path.join(dir, 'jira', 'help', 'broken.md'), 'no front-matter here');
  fs.writeFileSync(path.join(dir, 'jira', 'help', 'notes.txt'), 'ignored');
  const topics = loadPluginTopics(dir);
  assert.deepEqual(topics.map((t) => [t.id, t.pluginId]), [['jira', 'jira']]);
  assert.deepEqual(topics[0].routes, ['/agents', '/agents/new']);
  assert.deepEqual(loadPluginTopics(path.join(dir, 'missing')), []);
});
