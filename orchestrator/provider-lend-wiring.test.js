'use strict';

// Run: node --test orchestrator/provider-lend-wiring.test.js
//
// Source-shape guard for the §14 / E10 membership-add block (#2360): orchestrator.js
// boots a server on require and cannot be imported, so this reads its source (the
// unified-access-ui-routes.test.js technique). The behavioural rule itself is
// covered by provider-lend-policy.test.js; this guards the wiring.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, 'orchestrator.js'), 'utf8');

test('the pure transition policy is required from the byte-mirrored module', () => {
  assert.match(SRC, /const \{ personalDefaultTransitionRisk \} = require\("\.\/provider-lend-policy"\);/);
});

test('personalOauthLendBlockOnMembershipAdd is flag-gated and fails open', () => {
  const start = SRC.indexOf('function personalOauthLendBlockOnMembershipAdd(');
  assert.ok(start > 0, 'personalOauthLendBlockOnMembershipAdd not found');
  const body = SRC.slice(start, SRC.indexOf('\n}', start));
  assert.match(body, /if \(!RESOURCE_ACCESS_V2 \|\| !teamId \|\| !newUserId\) return null;/);
  // The transition fires only once the squad would have ≥2 humans.
  assert.match(body, /if \(after < 2\) return null;/);
  // Single-sourced through the pure policy; only a 'block' refuses.
  assert.match(body, /personalDefaultTransitionRisk\(\{ provider: ep, humanMemberCount: after \}\)/);
  assert.match(body, /risk\.level !== "block"/);
  // Fail-open: any read error skips the guard, never breaks a legit add.
  assert.match(body, /catch \{\s*return null;\s*\}/);
});

test('the membership POST branch calls the guard and throws a 409-tagged refusal', () => {
  const marker = 'teamsStore.setMembership(body)';
  const at = SRC.indexOf(marker);
  assert.ok(at > 0, 'membership POST branch not found');
  // Look at the lines immediately preceding the setMembership call.
  const window = SRC.slice(at - 700, at + marker.length);
  assert.match(window, /personalOauthLendBlockOnMembershipAdd\(body && body\.teamId, body && body\.userId\)/);
  assert.match(window, /e\.statusHint = 409;/);
  assert.match(window, /e\.code = 'oauth_personal_lend_blocked';/);
});
