'use strict';

// Source-shape guard for personal Model-Provider OWNER persistence (#2358).
//
// PR2 (#2353) enabled creating a `scope: 'personal'` provider but never
// persisted `ownership.userId` onto the endpoint record — so the provider had
// no owner, which meant `ownsPersonalCredential` (reads `c.userId`) matched
// nobody: the owner could neither see nor manage their own provider, offboarding
// could not find it, and PR4's personal-provider lend could never resolve. This
// pins that the create AND update routes now write `userId`, the same way the
// SSH-key / GitHub-token indexes always have. Route handlers live in api.js,
// which boots on require and cannot be imported — so this reads its source, the
// tiered-resource-routes.test.js technique.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, 'api.js'), 'utf8');

// One route handler body, from its `app.<verb>('<route>'` opening to the next
// top-level `\napp.` (comment-free enough for these positive assertions).
function routeBody(opening) {
  const start = SRC.indexOf(opening);
  assert.ok(start > 0, `'${opening}' not found — re-point this guard`);
  const end = SRC.indexOf('\napp.', start + opening.length);
  assert.ok(end > start, `end of '${opening}' not found`);
  return SRC.slice(start, end);
}

test('POST /api/llm-endpoints persists the personal owner (userId) on the record', () => {
  const body = routeBody("app.post('/api/llm-endpoints'");
  assert.match(body, /userId: ownership\.userId \|\| null,/,
    'the created entry must carry ownership.userId (null for non-personal tiers)');
});

test('PUT /api/llm-endpoints keeps userId in step with the tier (personal keeps owner, else cleared)', () => {
  const body = routeBody("app.put('/api/llm-endpoints/:id'");
  assert.match(
    body,
    /next\.userId = ownership\.scope === 'personal' \? \(ownership\.userId \|\| current\.userId \|\| null\) : null;/,
    'a re-tiered provider must not carry a dangling former owner; a personal one keeps its owner',
  );
});

test('PUT /api/llm-endpoints stamps the owner when SWITCHING a provider TO personal (#2360 regression)', () => {
  const body = routeBody("app.put('/api/llm-endpoints/:id'");
  // The bug: the V2 tier switch built `ownership = { scope: 'personal', ... }` by
  // hand with NO userId, so `next.userId` fell back to null and the provider
  // vanished from the owner-only list (and became unmanageable). The switch must
  // resolve ownership through the acting caller (resolveCredentialOwnership stamps
  // userId), exactly as the create path does — not build it by hand.
  assert.match(
    body,
    /desiredTier === 'personal'[\s\S]*?resolveCredentialOwnership\(\{ scope: 'personal', userId: b\.userId \}, scope\.userId\)/,
    'switching a provider to the personal tier must resolve (and stamp) the owner via the acting caller',
  );
});
