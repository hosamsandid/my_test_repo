'use strict';

// #2679 — `PUT /api/agents/:id` must refuse a blank or whitespace-only
// display name and persist the trimmed value. api.js cannot be `require`d in a
// unit test (it boots Express), so the route-wiring half reads the route's
// source — the same technique pool-member-write.test.js uses.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { normalizeDisplayName } = require('./agent-display-name');

test('an absent displayName leaves the field untouched', () => {
  assert.deepEqual(normalizeDisplayName(undefined), {});
});

test('a blank or whitespace-only displayName is refused', () => {
  for (const v of ['', '   ', '\t\n ']) {
    assert.ok(normalizeDisplayName(v).error, JSON.stringify(v));
    assert.equal(normalizeDisplayName(v).value, undefined);
  }
});

test('a non-string displayName is refused', () => {
  for (const v of [null, 42, {}, ['x']]) assert.ok(normalizeDisplayName(v).error);
});

test('a valid displayName is trimmed', () => {
  assert.deepEqual(normalizeDisplayName('  Dev Agent  '), { value: 'Dev Agent' });
  assert.deepEqual(normalizeDisplayName('Dev'), { value: 'Dev' });
});

test('PUT /api/agents/:id answers 400 on an invalid name before writing, and persists the trimmed value', () => {
  const src = fs.readFileSync(path.join(__dirname, 'api.js'), 'utf8');
  const start = src.indexOf("app.put('/api/agents/:id',");
  assert.ok(start > 0, 'route not found');
  const route = src.slice(start, src.indexOf('\napp.', start + 1));
  const guard = route.indexOf('if (normDisplayName.error) return res.status(400)');
  assert.ok(guard > 0, 'route must refuse an invalid displayName with 400');
  // The guard runs before the first write the route can make.
  const firstWrite = route.search(/writeJsonFile|fetch\(/);
  assert.ok(firstWrite > guard, 'guard must precede any write');
  assert.match(route, /fresh\.displayName = normDisplayName\.value;/);
  assert.doesNotMatch(route, /fresh\.displayName = displayName;/);
});
