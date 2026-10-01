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
  launchBlockReason,
  buildLaunchBody,
  launchSubmitLabel,
  launchResultMessage,
  launchFailure,
  agentChatTargetFor,
  splitNdjson,
  runLaunchStream,
  TEAM_ID_RE,
  SUFFIX_RE,
  TEAM_ID_HINT,
  SUFFIX_HINT,
  NO_PROVIDER_ERROR,
  NEW_REPO_LESS_ENV,
  NEW_REPO_LESS_ENV_LABEL,
  PICK_ENVIRONMENT_ERROR,
  ENVIRONMENTS_PENDING_ERROR,
  environmentChoiceRequired,
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

test('validateLaunch: slug / name / suffix, and repo-less/env-less are both allowed', () => {
  assert.equal(
    validateLaunch({ teamId: 'team', teamName: 'Team', environmentId: 'env' }),
    null,
  );
  // repo-less env is still launchable (AC6) — no repo field is consulted.
  assert.equal(
    validateLaunch({ teamId: 'team', teamName: 'Team', environmentId: 'repoless-env' }),
    null,
  );
  // #2168 A2: no environment picked at all is launchable too — falls through to
  // POST /api/teams's own repo-less auto-create (env id = team id).
  assert.equal(
    validateLaunch({ teamId: 'team', teamName: 'Team', environmentId: '' }),
    null,
  );
  assert.match(validateLaunch({ teamId: 'Bad Id', teamName: 'x', environmentId: 'e' }), /team id/i);
  assert.match(validateLaunch({ teamId: 'ok', teamName: '   ', environmentId: 'e' }), /name/i);
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

// #2157 AC4 — launchBlockReason is the SINGLE source for the LaunchStep
// primary button's disabled state and its visible reason, replacing the old
// `envBlocking` boolean that decided disabled-ness independently of
// validateLaunch's message.
test('launchBlockReason: same reason validateLaunch gives, on the settled team id', () => {
  assert.equal(launchBlockReason({ teamId: 'team', teamName: 'Team', environmentId: 'env' }), null);
  // #2168 A2: no environment is a launchable state, not a blocker.
  assert.equal(launchBlockReason({ teamId: 'ok', teamName: 'x', environmentId: '' }), null);
  // '---' is all-dash, so even after settling (normalizeTeamId strips leading/
  // trailing dashes) it collapses to an empty id — genuinely invalid, unlike
  // 'Bad Id' or a trailing-dash value, both of which settle to something legal.
  assert.match(launchBlockReason({ teamId: '---', teamName: 'x', environmentId: 'e' }), /team id/i);
  assert.match(launchBlockReason({ teamId: 'ok', teamName: '   ', environmentId: 'e' }), /name/i);
});

test('launchBlockReason: a trailing dash mid-edit does not flicker the reason to "team id" (the #2157 trap)', () => {
  // `acme-` fails TEAM_ID_RE raw (a trailing dash is legal only while typing,
  // #1934 AC1) but settles to `acme`, which is a fine id — and #2168 A2 means a
  // missing environment blocks nothing either, so this is fully launchable.
  assert.equal(launchBlockReason({ teamId: 'acme-', teamName: 'Acme', environmentId: '' }), null);
  // Picking an environment changes nothing about that.
  assert.equal(launchBlockReason({ teamId: 'acme-', teamName: 'Acme', environmentId: 'e' }), null);
});

test('launchBlockReason: null values object does not throw', () => {
  assert.match(launchBlockReason({}), /team id/i);
  assert.doesNotThrow(() => launchBlockReason(undefined));
});

// #2179: a platform with no registered model provider blocks team creation —
// mirrored client-side so the button disables before the server 400s.
test('validateLaunch: hasProvider defaults to true (does not block) and only an explicit false blocks', () => {
  const base = { teamId: 'team', teamName: 'Team', environmentId: 'env' };
  assert.equal(validateLaunch(base), null);
  assert.equal(validateLaunch({ ...base, hasProvider: true }), null);
  assert.equal(validateLaunch({ ...base, hasProvider: undefined }), null);
  assert.equal(validateLaunch({ ...base, hasProvider: false }), NO_PROVIDER_ERROR);
});

test('launchBlockReason: propagates hasProvider: false as the block reason', () => {
  assert.equal(
    launchBlockReason({ teamId: 'team', teamName: 'Team', environmentId: '', hasProvider: false }),
    NO_PROVIDER_ERROR,
  );
  // A genuinely invalid team id is still reported ahead of the provider check.
  assert.match(
    launchBlockReason({ teamId: '---', teamName: 'x', environmentId: 'e', hasProvider: false }),
    /team id/i,
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

test('buildLaunchBody: acknowledgeNoToken set only on strict true, dropped otherwise', () => {
  // #2323 reference-only opt-out — the flag must not leak from a truthy non-true
  // value or an `extra` carry-over, only from an explicit true.
  assert.equal(
    buildLaunchBody({ teamId: 't', teamName: 'T', acknowledgeNoToken: true }).acknowledgeNoToken,
    true,
  );
  assert.equal(
    'acknowledgeNoToken' in buildLaunchBody({ teamId: 't', teamName: 'T' }),
    false,
  );
  assert.equal(
    'acknowledgeNoToken' in buildLaunchBody({ teamId: 't', teamName: 'T', acknowledgeNoToken: 'yes' }),
    false,
  );
  assert.equal(
    'acknowledgeNoToken' in buildLaunchBody({ teamId: 't', teamName: 'T', extra: { acknowledgeNoToken: true } }),
    false,
  );
});

test('runLaunchStream: a non-ok response WITH a body is an error, not a stream (carries its code)', async () => {
  // #2323 answers /api/teams/stream's guard with `res.status(409).json(...)`, a
  // buffered JSON error whose `res.body` is a (non-null) ReadableStream. It must
  // be surfaced as an error, never read as NDJSON — so the body's reader must
  // never be touched on a non-ok response.
  const fetchImpl = async () => ({
    ok: false,
    status: 409,
    body: { getReader: () => { throw new Error('must not read the body of a non-ok response'); } },
    json: async () => ({ error: 'repo needs a token', code: 'github_token_required' }),
  });
  await assert.rejects(
    () => runLaunchStream({ body: {}, onEvent: () => {}, fetchImpl }),
    (e) => {
      assert.equal(e.code, 'github_token_required');
      assert.equal(e.serverMessage, 'repo needs a token');
      assert.equal(e.status, 409);
      return true;
    },
  );
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

// ─── agentChatTargetFor (#2521) ──────────────────────────────────────────────

test('agentChatTargetFor: the first role of the bundle, as the server names its member', () => {
  const bundle = { roles: [{ id: 'developer' }, { id: 'reviewer' }] };
  assert.deepEqual(agentChatTargetFor(bundle, 'acme'), {
    path: '/chats/acme-developer',
    state: { revealAgentId: 'acme-developer' },
  });
});

test('agentChatTargetFor: role order decides, not alphabetical order (AC2)', () => {
  const bundle = { roles: [{ id: 'zeta' }, { id: 'alpha' }] };
  assert.equal(agentChatTargetFor(bundle, 'acme').state.revealAgentId, 'acme-zeta');
});

test('agentChatTargetFor: never routes to the Flow Editor (AC1/AC7)', () => {
  for (const [b, t] of [[{ roles: [{ id: 'dev' }] }, 'acme'], [{ roles: [] }, 'acme'], [null, 'acme'], [null, '']]) {
    const { path } = agentChatTargetFor(b, t);
    assert.match(path, /^\/chats(\/|$)/);
    assert.doesNotMatch(path, /\/process\//);
  }
});

test('agentChatTargetFor: degrades to the team, then to the chat overview', () => {
  // No usable first role: the team's own configuration surface (#2235).
  assert.deepEqual(agentChatTargetFor({ roles: [] }, 'acme'), { path: '/chats/acme', state: { revealAgentId: 'acme' } });
  assert.equal(agentChatTargetFor({ roles: [{}] }, 'acme').path, '/chats/acme');
  assert.equal(agentChatTargetFor(undefined, 'acme').path, '/chats/acme');
  // No team id at all: plain Agent Chat, nothing to reveal.
  assert.deepEqual(agentChatTargetFor({ roles: [{ id: 'dev' }] }, ''), { path: '/chats', state: null });
  assert.deepEqual(agentChatTargetFor({ roles: [{ id: 'dev' }] }, undefined), { path: '/chats', state: null });
});

test('agentChatTargetFor: the path segment is URL-encoded, the state id is not', () => {
  const r = agentChatTargetFor({ roles: [{ id: 'a b' }] }, 'acme');
  assert.equal(r.path, '/chats/acme-a%20b');
  assert.equal(r.state.revealAgentId, 'acme-a b');
});

// ─── launchFailure (#2658) ───────────────────────────────────────────────────

test('launchFailure: a refusal before the plan created nothing — no rollback claim', () => {
  const f = launchFailure({ message: 'Team name required', steps: null });
  assert.deepEqual(f, { message: 'Team name required', rolledBack: false });
  // A plan that never started a step is the same case.
  assert.equal(launchFailure({ message: 'x', steps: [{ id: 'env', status: 'pending' }] }).rolledBack, false);
});

test('launchFailure: once a step ran, the rollback sentence applies', () => {
  const steps = [{ id: 'env', status: 'done' }, { id: 'team', status: 'error' }];
  assert.equal(launchFailure({ message: 'boom', steps }).rolledBack, true);
  assert.equal(launchFailure({ message: 'boom', steps: [{ id: 'env', status: 'running' }] }).rolledBack, true);
});

test('launchFailure: the extend-missing-team API refusal is translated into UI terms', () => {
  const f = launchFailure({ message: `Cannot extend: team 'acme' does not exist yet. Use mode: "create" first.` });
  assert.equal(f.message, 'There is no team \'acme\' to add agents to yet — untick “Add to an existing team” to create it instead.');
  assert.doesNotMatch(f.message, /mode:/);
  assert.equal(launchFailure({}).message, '');
});

// #2737 — the Create-team dialog must not launch onto an environment the user
// never chose. `requireEnvironment` blocks an empty pick; the explicit
// "New repo-less environment" choice keeps the #2168 A2 path reachable.
test('validateLaunch: requireEnvironment blocks an empty pick, accepts any explicit one', () => {
  const base = { teamId: 'team', teamName: 'Team' };
  assert.equal(validateLaunch({ ...base, environmentId: '', requireEnvironment: true }), PICK_ENVIRONMENT_ERROR);
  assert.equal(validateLaunch({ ...base, requireEnvironment: true }), PICK_ENVIRONMENT_ERROR);
  assert.equal(validateLaunch({ ...base, environmentId: 'env', requireEnvironment: true }), null);
  assert.equal(validateLaunch({ ...base, environmentId: NEW_REPO_LESS_ENV, requireEnvironment: true }), null);
  // Opt-in: every other caller keeps the #2168 A2 behaviour.
  assert.equal(validateLaunch({ ...base, environmentId: '' }), null);
  // The reason names the way out, so a blocked button is never a dead end.
  assert.ok(PICK_ENVIRONMENT_ERROR.includes(NEW_REPO_LESS_ENV_LABEL));
});

test('launchBlockReason: carries requireEnvironment through to the shown reason', () => {
  const values = { teamId: 'team', teamName: 'Team', environmentId: '' };
  assert.equal(launchBlockReason({ ...values, requireEnvironment: true }), PICK_ENVIRONMENT_ERROR);
  assert.equal(launchBlockReason(values), null);
});

test('buildLaunchBody: the explicit repo-less choice sends the same body as no environment', () => {
  const chosen = buildLaunchBody({ teamId: 't', teamName: 'T', environmentId: NEW_REPO_LESS_ENV });
  const none = buildLaunchBody({ teamId: 't', teamName: 'T', environmentId: '' });
  assert.equal('environmentId' in chosen, false);
  assert.deepEqual(chosen, none);
  assert.equal(buildLaunchBody({ teamId: 't', teamName: 'T', environmentId: 'env' }).environmentId, 'env');
});

// #2737 review B1 — the gate must hold while the environment list is loading or
// failed to load (MaterializeDialog keeps envsLoaded false on a failed fetch,
// #2157 AC6); only a confirmed-empty platform lifts it (#2168 A2).
test('environmentChoiceRequired: lifted only for a loaded, empty environment list', () => {
  const on = { requireEnvironmentChoice: true, hasEnvironmentField: true };
  assert.equal(environmentChoiceRequired({ ...on, envsLoaded: false, envCount: 0 }), true, 'loading / fetch failed');
  assert.equal(environmentChoiceRequired({ ...on, envsLoaded: true, envCount: 2 }), true, 'list to pick from');
  assert.equal(environmentChoiceRequired({ ...on, envsLoaded: true, envCount: 0 }), false, 'empty platform');
  assert.equal(environmentChoiceRequired({ ...on, hasEnvironmentField: false, envsLoaded: true, envCount: 2 }), false);
  assert.equal(environmentChoiceRequired({ hasEnvironmentField: true, envsLoaded: false, envCount: 0 }), false, 'opt-in');
});

test('launchBlockReason: blocks with a loading-specific reason while environments are pending', () => {
  const values = { teamId: 'team', teamName: 'Team', environmentId: '' };
  assert.equal(launchBlockReason({ ...values, requireEnvironment: true, environmentsPending: true }), ENVIRONMENTS_PENDING_ERROR);
  assert.equal(validateLaunch({ ...values, requireEnvironment: true, environmentsPending: true }), ENVIRONMENTS_PENDING_ERROR);
  // Pending alone never blocks a caller that does not require a choice.
  assert.equal(launchBlockReason({ ...values, environmentsPending: true }), null);
});
