'use strict';

// The signed viewer-identity scheme (plugin-ui-proxy.js §4.8) is copied into
// every UI-bearing broker's `viewer-headers.js`, because a broker's Docker
// build context cannot reach admin-console/api/. Sign and verify are ONE
// contract: a copy that drifts (say, a broker still verifying the three-field
// canonical string after the proxy started signing the per-team role map)
// rejects every proxied request with a bare 401 — or, worse, verifies a
// weaker form. This pins the shared block byte-identical across all copies.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const PROXY = path.join(__dirname, 'plugin-ui-proxy.js');
const PLUGINS = path.join(ROOT, 'plugins');

function sharedBlock(src, file) {
  const start = src.indexOf('const HDR = Object.freeze({');
  const endMarker = 'function roleForTeam(viewer, teamId) {';
  const endAt = src.indexOf(endMarker);
  assert.notEqual(start, -1, `${file}: HDR block not found`);
  assert.notEqual(endAt, -1, `${file}: roleForTeam not found`);
  const close = src.indexOf('\n}\n', endAt);
  return src.slice(start, close + 3);
}

test('every broker viewer-headers.js carries the proxy\'s sign/verify block byte-identical', () => {
  const expected = sharedBlock(fs.readFileSync(PROXY, 'utf8'), 'plugin-ui-proxy.js');
  assert.ok(expected.includes('x-aee-plugin-team-roles'), 'the proxy block signs the per-team role map');
  const copies = fs.readdirSync(PLUGINS)
    .map((id) => path.join(PLUGINS, id, 'broker', 'viewer-headers.js'))
    .filter((p) => fs.existsSync(p));
  assert.ok(copies.length >= 5, `expected the reference brokers' copies, found ${copies.length}`);
  for (const file of copies) {
    const got = sharedBlock(fs.readFileSync(file, 'utf8'), path.relative(ROOT, file));
    assert.equal(got, expected, `${path.relative(ROOT, file)} drifted from plugin-ui-proxy.js`);
  }
});
