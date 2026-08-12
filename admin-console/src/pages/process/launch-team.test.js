// Tests for the shared Launch decision core (#1668).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  slugify,
  reposForEnv,
  isRepoLessEnv,
  validateLaunch,
  buildLaunchBody,
  launchSubmitLabel,
  splitNdjson,
  runLaunchStream,
} from './launch-team.js';

test('slugify: lowercase, dash runs, trim dashes, 40-char cap', () => {
  assert.equal(slugify('Acme Demo'), 'acme-demo');
  assert.equal(slugify('  --Hello, World!! --'), 'hello-world');
  assert.equal(slugify('a'.repeat(60)).length, 40);
  assert.equal(slugify(null), '');
  assert.equal(slugify('Foo___Bar'), 'foo-bar');
});

test('reposForEnv: modern array, legacy single, and none', () => {
  assert.deepEqual(
    reposForEnv({ repositories: [{ url: 'a' }, { url: '' }, { branch: 'x' }] }),
    [{ url: 'a' }],
  );
  assert.deepEqual(reposForEnv({ repository: { url: 'legacy' } }), [{ url: 'legacy' }]);
  assert.deepEqual(reposForEnv({ repositories: [] }), []);
  assert.deepEqual(reposForEnv(null), []);
});

test('isRepoLessEnv: only when a real env has no usable repo', () => {
  assert.equal(isRepoLessEnv(null), false); // no env selected → not "repo-less"
  assert.equal(isRepoLessEnv({ id: 'e', repositories: [] }), true);
  assert.equal(isRepoLessEnv({ id: 'e', repository: { url: 'x' } }), false);
});

test('validateLaunch: slug / name / env / suffix, and repo-less is allowed', () => {
  assert.equal(
    validateLaunch({ teamId: 'team', teamName: 'Team', environmentId: 'env' }),
    null,
  );
  // repo-less env is still launchable (AC6) — no repo field is consulted.
  assert.equal(
    validateLaunch({ teamId: 'team', teamName: 'Team', environmentId: 'repoless-env' }),
    null,
  );
  assert.match(validateLaunch({ teamId: 'Bad Id', teamName: 'x', environmentId: 'e' }), /slug/);
  assert.match(validateLaunch({ teamId: 'ok', teamName: '   ', environmentId: 'e' }), /name/i);
  assert.match(validateLaunch({ teamId: 'ok', teamName: 'x', environmentId: '' }), /working environment/i);
  assert.match(
    validateLaunch({ teamId: 'ok', teamName: 'x', environmentId: 'e', labelSuffix: 'TOOLONG9' }),
    /suffix/i,
  );
  assert.equal(
    validateLaunch({ teamId: 'ok', teamName: 'x', environmentId: 'e', labelSuffix: 'k3f9' }),
    null,
  );
});

test('buildLaunchBody: canonical shape, explicit materializeMembers, bundle name binding', () => {
  const body = buildLaunchBody({
    teamId: 'my-team',
    teamName: '  My Team  ',
    environmentId: 'env-1',
    mode: 'create',
    labelSuffix: 'k3f9',
    materializeNow: false,
    processTemplate: { name: 'Old Name', roles: [{ id: 'dev' }] },
  });
  assert.equal(body.teamId, 'my-team');
  assert.equal(body.teamName, 'My Team');
  assert.equal(body.mode, 'create');
  assert.equal(body.environmentId, 'env-1');
  assert.equal(body.labelSuffix, 'k3f9');
  assert.equal(body.materializeMembers, false);
  // bundle name bound to the (trimmed) team name at submit time.
  assert.equal(body.processTemplate.name, 'My Team');
  assert.deepEqual(body.processTemplate.roles, [{ id: 'dev' }]);
});

test('buildLaunchBody: materialize-now defaults to true (backend default preserved)', () => {
  assert.equal(buildLaunchBody({ teamId: 't', teamName: 'T', environmentId: 'e' }).materializeMembers, true);
  assert.equal(
    buildLaunchBody({ teamId: 't', teamName: 'T', environmentId: 'e', materializeNow: true }).materializeMembers,
    true,
  );
});

test('buildLaunchBody: shared keys win over extra; blank suffix dropped; env omitted for legacy', () => {
  const body = buildLaunchBody({
    teamId: 't',
    teamName: 'T',
    mode: 'extend',
    labelSuffix: '',
    extra: {
      teamId: 'SHOULD-BE-OVERRIDDEN',
      labelSuffix: 'stale',
      readyLabel: 'ready',
      repository: { url: 'legacy' },
    },
  });
  assert.equal(body.teamId, 't'); // shared key wins over extra
  assert.equal('labelSuffix' in body, false); // blank suffix removed even if extra set it
  assert.equal(body.readyLabel, 'ready'); // pass-through preserved
  assert.deepEqual(body.repository, { url: 'legacy' }); // legacy fallback preserved
  assert.equal('environmentId' in body, false); // no env id → not added
  assert.equal(body.mode, 'extend');
});

test('launchSubmitLabel: extend > materialize-now > create', () => {
  assert.equal(launchSubmitLabel({ extend: true }), 'Extend team');
  assert.equal(launchSubmitLabel({ extend: true, saving: true }), 'Extending…');
  assert.equal(launchSubmitLabel({ saving: true }), 'Creating…');
  assert.equal(launchSubmitLabel({ materializeNow: true }), 'Create team');
  assert.equal(launchSubmitLabel({ materializeNow: false }), 'Create team (stubs)');
  assert.equal(launchSubmitLabel({}), 'Create team'); // default = materialize-now
});

test('splitNdjson: complete lines parsed, partial retained, bad lines collected', () => {
  const r = splitNdjson('{"a":1}\n{"b":2}\n{"c":3');
  assert.deepEqual(r.events, [{ a: 1 }, { b: 2 }]);
  assert.equal(r.rest, '{"c":3');
  assert.equal(r.errors.length, 0);

  const bad = splitNdjson('not-json\n{"ok":true}\n');
  assert.deepEqual(bad.events, [{ ok: true }]);
  assert.equal(bad.errors.length, 1);
  assert.equal(bad.rest, '');
});

// Build a fake fetch returning a streamed NDJSON body, to drive runLaunchStream.
function fakeStreamFetch(chunks, { ok = true } = {}) {
  const enc = new TextEncoder();
  let i = 0;
  return async () => ({
    ok,
    body: {
      getReader() {
        return {
          read() {
            if (i < chunks.length) {
              const value = enc.encode(chunks[i]);
              i += 1;
              return Promise.resolve({ value, done: false });
            }
            return Promise.resolve({ value: undefined, done: true });
          },
        };
      },
    },
  });
}

test('runLaunchStream: dispatches events across chunk boundaries + flushes tail', async () => {
  const seen = [];
  await runLaunchStream({
    body: { teamId: 't' },
    onEvent: (ev) => seen.push(ev),
    // event split across chunks; last line has no trailing newline (tail flush).
    fetchImpl: fakeStreamFetch(['{"type":"pla', 'n"}\n{"type":"step","id":"team"}\n', '{"type":"complete"}']),
  });
  assert.deepEqual(seen, [
    { type: 'plan' },
    { type: 'step', id: 'team' },
    { type: 'complete' },
  ]);
});

test('runLaunchStream: non-ok response with no body throws with status + error', async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 409,
    body: null,
    json: async () => ({ error: 'team id already exists' }),
  });
  await assert.rejects(
    () => runLaunchStream({ body: {}, onEvent: () => {}, fetchImpl }),
    (e) => {
      assert.equal(e.message, 'team id already exists');
      assert.equal(e.status, 409);
      return true;
    },
  );
});
