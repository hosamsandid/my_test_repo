// Tests for the shared Launch decision core (#1668).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  slugify,
  sanitizeTeamIdInput,
  normalizeTeamId,
  sanitizeLabelSuffixInput,
  teamIdError,
  labelSuffixError,
  reposForEnv,
  isRepoLessEnv,
  validateLaunch,
  buildLaunchBody,
  launchSubmitLabel,
  launchResultMessage,
  splitNdjson,
  runLaunchStream,
  TEAM_ID_RE,
  SUFFIX_RE,
  TEAM_ID_HINT,
  SUFFIX_HINT,
} from './launch-team.js';

test('slugify: lowercase, dash runs, trim dashes, 40-char cap', () => {
  assert.equal(slugify('Acme Demo'), 'acme-demo');
  assert.equal(slugify('  --Hello, World!! --'), 'hello-world');
  assert.equal(slugify('a'.repeat(60)).length, 40);
  assert.equal(slugify(null), '');
  assert.equal(slugify('Foo___Bar'), 'foo-bar');
});

// #1934 AC3 — the 40-char cap must be applied BEFORE the trailing-dash strip,
// or truncating a long multi-word name re-introduces a dash at position 40 that
// the server then rejects with an opaque 400.
test('slugify: truncation can never leave a trailing dash', () => {
  // 39 chars, then a space: the naive strip-then-slice order produced "…-".
  const name = `${'a'.repeat(39)} beta`;
  const slug = slugify(name);
  assert.equal(slug.length <= 40, true);
  assert.equal(slug.endsWith('-'), false);
  assert.match(slug, TEAM_ID_RE);
  // Every prefix length around the cap stays submittable.
  for (let n = 36; n <= 44; n++) {
    const s = slugify(`${'x'.repeat(n)} team`);
    assert.match(s, TEAM_ID_RE, `slugify of a ${n}-char word must stay valid, got '${s}'`);
  }
});

// #1934 AC1 — typing `acme-web` character by character must leave `acme-web`
// in the field. The old sanitiser stripped the trailing dash on every keystroke,
// so the hyphen was deleted the moment it was the last character typed.
test('sanitizeTeamIdInput: keeps a dash that is currently the last character', () => {
  const typed = 'acme-web';
  let field = '';
  for (const ch of typed) field = sanitizeTeamIdInput(field + ch);
  assert.equal(field, 'acme-web');
  // Intermediate state is preserved verbatim, dash included.
  assert.equal(sanitizeTeamIdInput('acme-'), 'acme-');
  // Mid-string editing keeps the dash too.
  assert.equal(sanitizeTeamIdInput('acme-b'), 'acme-b');
  // What can never be legal is still dropped live.
  assert.equal(sanitizeTeamIdInput('ACME Web'), 'acme-web');
  assert.equal(sanitizeTeamIdInput('-acme'), 'acme');
  assert.equal(sanitizeTeamIdInput('acme_web!'), 'acme-web-');
  assert.equal(sanitizeTeamIdInput('a'.repeat(60)).length, 40);
  assert.equal(sanitizeTeamIdInput(null), '');
});

test('normalizeTeamId: settles a mid-edit value, idempotently', () => {
  assert.equal(normalizeTeamId('acme-'), 'acme');
  assert.equal(normalizeTeamId('-acme-'), 'acme');
  assert.equal(normalizeTeamId('acme-web'), 'acme-web');
  assert.equal(normalizeTeamId(normalizeTeamId('acme-')), 'acme');
  assert.equal(normalizeTeamId(`${'a'.repeat(39)}-b`).endsWith('-'), false);
  assert.equal(normalizeTeamId(null), '');
});

// #1934 AC2 — the client rule IS the server rule (api.js TEAM_ID_RE). The old
// client regex /^[a-z0-9-]{1,40}$/ blessed `-acme`, `acme-` and `---`, which the
// API then refused.
test('TEAM_ID_RE: same rule as the server, no leading/trailing dash', () => {
  for (const ok of ['a', 'acme', 'acme-web', 'a-b-c', '9x', `${'a'.repeat(40)}`]) {
    assert.match(ok, TEAM_ID_RE, `'${ok}' should be valid`);
  }
  for (const bad of ['', '-acme', 'acme-', '---', 'Acme', 'acme web', 'a'.repeat(41)]) {
    assert.doesNotMatch(bad, TEAM_ID_RE, `'${bad}' should be rejected`);
  }
});

// #1934 AC4/AC5 — hyphens are accepted in the label suffix, but only as single
// inner ones: a leading/trailing/doubled hyphen would yield `ready--x` /
// `ready-x-` on GitHub.
test('SUFFIX_RE: single inner hyphens accepted, misplaced ones rejected', () => {
  for (const ok of ['k3f9', 'a', 'team-1', 'stack-a', 'pre-prod', 'abcd1234', 'a-b-c-d']) {
    assert.match(ok, SUFFIX_RE, `'${ok}' should be valid`);
  }
  for (const bad of ['', '-x', 'x-', 'a--b', '-', 'TEAM-1', 'team 1', 'abcdefghi', 'stack-alpha']) {
    assert.doesNotMatch(bad, SUFFIX_RE, `'${bad}' should be rejected`);
  }
});

test('sanitizeLabelSuffixInput: lets a hyphen through so validation can explain it', () => {
  assert.equal(sanitizeLabelSuffixInput('Team-1'), 'team-1');
  assert.equal(sanitizeLabelSuffixInput('pre_prod!'), 'preprod');
  assert.equal(sanitizeLabelSuffixInput('a--b'), 'a--b'); // kept, then flagged inline
  assert.equal(sanitizeLabelSuffixInput('abcdefghij'), 'abcdefgh');
  assert.equal(sanitizeLabelSuffixInput(null), '');
});

// #1934 AC9 — the inline messages and the field hints describe the rule that is
// actually enforced, and stay quiet for an empty (not yet filled) field.
test('field errors: quiet when empty or valid, and the hints name the hyphen', () => {
  assert.equal(teamIdError(''), null);
  assert.equal(teamIdError('acme-web'), null);
  // A dash that is only *currently* trailing is settled on blur, so the field
  // must not nag about it while the word is still being typed (AC1).
  assert.equal(teamIdError('acme-'), null);
  // A value that can never settle into a valid id is still reported.
  assert.match(teamIdError('---'), /dash/i);
  assert.equal(labelSuffixError(''), null);
  assert.equal(labelSuffixError('team-1'), null);
  assert.match(labelSuffixError('a--b'), /dash/i);
  assert.match(TEAM_ID_HINT, /dash/i);
  assert.match(SUFFIX_HINT, /dash/i);
  assert.match(SUFFIX_HINT, /team-1/);
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
  assert.match(validateLaunch({ teamId: 'Bad Id', teamName: 'x', environmentId: 'e' }), /team id/i);
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

// #1934 AC1/AC2 — a hyphenated slug is launchable, and the values the old
// client regex wrongly blessed are refused here rather than by the API.
test('validateLaunch: hyphenated team id accepted, misplaced dashes refused', () => {
  assert.equal(validateLaunch({ teamId: 'acme-web', teamName: 'Acme Web', environmentId: 'e' }), null);
  for (const bad of ['-acme', 'acme-', '---']) {
    assert.match(
      validateLaunch({ teamId: bad, teamName: 'x', environmentId: 'e' }),
      /team id/i,
      `'${bad}' must not be blessed by the client`,
    );
  }
  // #1934 AC4 — the suffix rule agrees with the server's on both sides.
  for (const ok of ['team-1', 'stack-a', 'pre-prod']) {
    assert.equal(
      validateLaunch({ teamId: 'ok', teamName: 'x', environmentId: 'e', labelSuffix: ok }),
      null,
      `'${ok}' should be an accepted suffix`,
    );
  }
  for (const bad of ['-x', 'x-', 'a--b']) {
    assert.match(
      validateLaunch({ teamId: 'ok', teamName: 'x', environmentId: 'e', labelSuffix: bad }),
      /suffix/i,
      `'${bad}' should be a rejected suffix`,
    );
  }
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

// ─── launchResultMessage (#1955) ─────────────────────────────────────────────

test('launchResultMessage: a stub launch is not reported as a ready team', () => {
  const stub = launchResultMessage({ teamName: 'Acme', created: ['a-dev', 'a-qa'], materialized: false });
  assert.match(stub, /created/);
  assert.match(stub, /2 agent\(s\) as stubs/);
  assert.doesNotMatch(stub, /ready/); // nothing is cloned or running yet
  assert.match(stub, /Enable a member to materialize it/); // says how to finish
});

test('launchResultMessage: materialized (or a pre-#1955 payload) keeps the ready wording', () => {
  const now = 'Team Acme ready — 2 agent(s) created.';
  assert.equal(launchResultMessage({ teamName: 'Acme', created: ['a', 'b'], materialized: true }), now);
  // No `materialized` key at all: read as the backend default (materialize-now),
  // never guessed as a stub — an older stream payload must not be relabelled.
  assert.equal(launchResultMessage({ teamName: 'Acme', created: ['a', 'b'] }), now);
  assert.equal(launchResultMessage({ teamName: 'Acme' }), 'Team Acme ready — 0 agent(s) created.');
});

test('launchResultMessage: an explicit server message still wins in either mode', () => {
  for (const materialized of [true, false, undefined]) {
    assert.equal(
      launchResultMessage({ teamName: 'Acme', message: 'extended', materialized }),
      'Team Acme: extended',
    );
  }
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
