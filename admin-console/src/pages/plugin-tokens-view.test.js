import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  describePluginTokenStatus, teamConnectionNote, initialFormValues, valuesToSubmit, submitBlockers,
} from './plugin-tokens-view.js';

// #2562 — the Plugin Tokens page (a member's own Jira e-mail + API token).

const credentials = [
  { key: 'email', required: true, secret: false },
  { key: 'api-token', required: true, secret: true },
];
const unset = { pluginId: 'jira', name: 'Jira', credentials, keys: { email: { set: false, value: '' }, 'api-token': { set: false, preview: null } }, complete: false, setAt: null };
const set = { ...unset, keys: { email: { set: true, value: 'me@x.io' }, 'api-token': { set: true, preview: 'AT…9f2c' } }, complete: true, setAt: '2026-09-30T10:00:00Z' };

test('status: set / incomplete / unset', () => {
  assert.equal(describePluginTokenStatus(set).state, 'set');
  assert.equal(describePluginTokenStatus(set).setAt, '2026-09-30T10:00:00Z');
  assert.equal(describePluginTokenStatus(unset).state, 'unset');
  assert.match(describePluginTokenStatus(unset).label, /refused/);
  const partial = { ...unset, keys: { ...unset.keys, email: { set: true, value: 'me@x.io' } } };
  assert.equal(describePluginTokenStatus(partial).state, 'incomplete');
});

test('teamConnectionNote: warns only when no granted team has the site set', () => {
  // no teamConnection field (older payload / no site concept) → no note
  assert.equal(teamConnectionNote(set), null);
  // granted but site not configured anywhere → warn, pointing at Team Settings
  const noSite = { ...set, teamConnection: { granted: true, configured: false } };
  assert.match(teamConnectionNote(noSite), /site isn't set yet/);
  assert.match(teamConnectionNote(noSite), /Team Admin/);
  // configured somewhere → suppress (avoids a false alarm)
  assert.equal(teamConnectionNote({ ...set, teamConnection: { granted: true, configured: true } }), null);
  // not granted to any of the caller's teams → a distinct note
  assert.match(teamConnectionNote({ ...set, teamConnection: { granted: false, configured: false } }), /not granted to any of your teams/);
});

test('form: non-secret values pre-fill, secrets never do', () => {
  assert.deepEqual(initialFormValues(set), { email: 'me@x.io', 'api-token': '' });
});

test('save: an empty secret keeps the stored one (omitted); typed values are trimmed', () => {
  assert.deepEqual(valuesToSubmit(set, { email: ' me@x.io ', 'api-token': '' }), { email: 'me@x.io' });
  assert.deepEqual(valuesToSubmit(set, { email: 'me@x.io', 'api-token': ' new ' }), { email: 'me@x.io', 'api-token': 'new' });
});

test('blockers: a first save needs every required field; a rotation needs no new token', () => {
  assert.deepEqual(submitBlockers(unset, { email: '', 'api-token': '' }), ['email', 'api-token']);
  assert.deepEqual(submitBlockers(unset, { email: 'a@b', 'api-token': 't' }), []);
  assert.deepEqual(submitBlockers(set, { email: 'me@x.io', 'api-token': '' }), []);
  assert.deepEqual(submitBlockers(set, { email: '', 'api-token': '' }), ['email']);
});

// The console API routes are source-guarded (JSX/express wiring is otherwise
// uncovered, #651): they must take the user from the session, never from the
// request, and forward nothing but `values`.
test('API: /api/me/plugin-credentials is always the caller\'s own entry', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, '../../api/api.js'), 'utf8');
  const start = src.indexOf('async function proxyMyPluginCredentials');
  assert.ok(start > 0, 'proxy helper exists');
  const body = src.slice(start, src.indexOf('\n}\n', start));
  assert.match(body, /getScope\(req\)/);
  assert.match(body, /scope\.userId/);
  assert.doesNotMatch(body, /req\.(params|query|body)\.userId/);
  assert.match(body, /JSON\.stringify\(\{ values:/);
  for (const m of ['get', 'put', 'delete']) {
    assert.match(src, new RegExp(`app\\.${m}\\('/api/me/plugin-credentials`), m);
  }
});
