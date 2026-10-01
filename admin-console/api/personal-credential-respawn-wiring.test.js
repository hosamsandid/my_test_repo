'use strict';

// Source guard (#2655): every owner-respawn call site in api.js is gated on
// `ownerRespawnNeeded`, and both credential lists mark the active personal row.
// Run: node --test admin-console/api/personal-credential-respawn-wiring.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, 'api.js'), 'utf8');

test('each personal create/rotate respawn is gated on ownerRespawnNeeded', () => {
  const calls = [...src.matchAll(/notifyOwnerCredentialChange\(([^)]*)\)/g)]
    .filter(m => !/^ownerId, reason$/.test(m[1]));
  // ssh create, ssh generate, ssh rotate, token create, token rotate
  assert.equal(calls.length, 5);
  for (const m of calls) {
    const before = src.slice(Math.max(0, m.index - 400), m.index);
    assert.match(before, /ownerRespawnNeeded\(|if \(ownerAgentsRestarted\) $/, `ungated respawn: ${m[0]}`);
  }
});

test('GET /api/ssh-keys and /api/github-tokens mark the active personal credential', () => {
  for (const route of ["app.get('/api/ssh-keys',", "app.get('/api/github-tokens',"]) {
    const at = src.indexOf(route);
    assert.ok(at >= 0, route);
    const body = src.slice(at, src.indexOf('\n});', at));
    assert.match(body, /markActivePersonal\(/, route);
  }
});
