'use strict';

// Source-reading drift guard (#2032) over the `POST /api/agent-outcomes/suggest`
// route in api.js — too large to import, and the route is I/O around the pure
// module `outcome-suggestion.test.js` already covers behaviourally.
//
// The route has to thread the SAME peer list into both halves, and each half
// fails silently on its own:
//   * missing from `buildOutcomeSuggestionRequest` → the model is never taught
//     the action type, so a hand-off is simply never proposed;
//   * missing from `parseOutcomeSuggestion` → an invented target validates
//     (`wakeTargetIndex` reads "no agents source" as "forbid nothing") and is
//     persisted as an outcome the canvas draws no edge for and delivery
//     refuses with a 404 nobody sees.
//
// Run: node --test admin-console/api/outcome-suggest-wake-wiring.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, 'api.js'), 'utf8');
// Comments explain the wiring; they must not be able to satisfy an assertion
// about it.
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

function routeBody() {
  const start = CODE.indexOf("app.post('/api/agent-outcomes/suggest'");
  assert.ok(start !== -1, 'the suggest route is still declared here');
  const rest = CODE.slice(start);
  const end = rest.indexOf("app.get('/api/mcp-servers'");
  return end === -1 ? rest : rest.slice(0, end);
}

test('the comment strip left the route intact', () => {
  assert.ok(CODE.includes("app.post('/api/agent-outcomes/suggest'"));
  assert.ok(!routeBody().includes('#2032'), 'the ticket reference lives only in comments');
});

test('the route resolves the peer list through wakePeerList', () => {
  // Re-filtered server-side rather than trusted: the client sends the whole
  // graph node list, actor pseudo-nodes and human roles included.
  assert.match(CODE, /wakePeerList[^\n]*require\('\.\/outcome-suggestion'\)|wakePeerList \}/);
  const body = routeBody();
  assert.match(body, /wakePeerList\(req\.body\?\.peers, req\.body\?\.roleId\)/);
});

test('the peer list reaches the PROMPT so the enum is taught', () => {
  assert.match(routeBody(), /buildOutcomeSuggestionRequest\(roleName, prompt, undefined, \{[\s\S]*peers: suggestPeers/);
});

test('the peer list reaches the VALIDATOR so an invented target is refused', () => {
  const body = routeBody();
  assert.match(body, /parseOutcomeSuggestion\(extractMessageText\(result\.body\), suggestSources\)/);
  assert.match(body, /const suggestSources = \{ agents: suggestPeers/);
  assert.match(body, /roleId: suggestRoleId/,
    'roleId is what makes validateWakeAction refuse a self-hand-off');
});

test('an older client that sends neither field still works', () => {
  // Both reads are optional-chained and both helpers are junk-safe, so a
  // body-less request degrades to "no wakeAgent offered" rather than a 500.
  const body = routeBody();
  assert.match(body, /req\.body\?\.peers/);
  assert.match(body, /typeof req\.body\?\.roleId === 'string'/);
});
