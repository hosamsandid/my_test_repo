'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { resolveScopeGithubCredentials, teamScopeIdsFromGrants, unique, buildTeamFlowLabels } = require('./plugin-github-creds');

// A stand-in "owner/name" parser matching the poller's contract (returns a full
// name string or null); rejects non-GitHub junk.
function parseRepoFullName(url) {
  if (typeof url !== 'string') return null;
  const m = url.match(/github\.com[:/]([^/]+)\/([^/.]+)(?:\.git)?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

test('unique preserves first-seen order and drops nullish', () => {
  assert.deepEqual(unique(['a', 'b', 'a', null, 'c', undefined]), ['a', 'b', 'c']);
});

test('resolveScopeGithubCredentials maps team → env token + repos', () => {
  const envs = {
    'team-a': { githubTokenId: 'tok-a', repositories: [
      { url: 'git@github.com:acme/widgets.git', branch: 'main' },
      { url: 'https://github.com/acme/tools', branch: 'dev' },
    ] },
    'team-b': { githubTokenId: 'tok-b', repositories: [{ url: 'git@github.com:acme/other.git' }] },
  };
  const tokens = { 'tok-a': '  ghp_a  ', 'tok-b': 'ghp_b' };

  const out = resolveScopeGithubCredentials(['team-a', 'team-b'], {
    envForScope: (id) => envs[id] || null,
    readToken: (id) => tokens[id] || null,
    parseRepoFullName,
  });

  assert.equal(out['team-a'].token, 'ghp_a'); // trimmed
  assert.deepEqual(out['team-a'].repos, [
    { fullName: 'acme/widgets', defaultBranch: 'main' },
    { fullName: 'acme/tools', defaultBranch: 'dev' },
  ]);
  assert.equal(out['team-b'].token, 'ghp_b');
  assert.deepEqual(out['team-b'].repos, [{ fullName: 'acme/other', defaultBranch: 'main' }]);
});

test('a scope with no env / no token / no repos still gets a present-but-empty entry', () => {
  const out = resolveScopeGithubCredentials(['team-none', 'team-notoken'], {
    envForScope: (id) => (id === 'team-notoken' ? { githubTokenId: null, repositories: [{ url: 'git@github.com:a/b.git' }] } : null),
    readToken: () => null,
    parseRepoFullName,
  });
  assert.deepEqual(out['team-none'], { token: '', repos: [] });
  assert.equal(out['team-notoken'].token, '');
  assert.deepEqual(out['team-notoken'].repos, [{ fullName: 'a/b', defaultBranch: 'main' }]);
});

test('resolver de-dups repos and tolerates a throwing collaborator', () => {
  const out = resolveScopeGithubCredentials(['team-a', 'team-a'], {
    envForScope: () => ({ githubTokenId: 'x', repositories: [
      { url: 'git@github.com:a/b.git' }, { url: 'https://github.com/a/b' }, { url: 'not-a-repo' },
    ] }),
    readToken: () => { throw new Error('token file missing'); },
    parseRepoFullName,
  });
  assert.equal(Object.keys(out).length, 1);
  assert.equal(out['team-a'].token, ''); // readToken threw → empty, not a crash
  assert.deepEqual(out['team-a'].repos, [{ fullName: 'a/b', defaultBranch: 'main' }]);
});

test('resolver requires its collaborators', () => {
  assert.throws(() => resolveScopeGithubCredentials(['x'], {}), /envForScope is required/);
});

test('buildTeamFlowLabels unions registry → wake → emits, order-stable and deduped', () => {
  const { flowLabels } = buildTeamFlowLabels({
    teamLabels: [{ name: 'ready', humanGate: true }, { name: 'ready-to-merge' }],
    members: [
      { displayName: 'Developer', enabled: true, triggers: [
        { type: 'github-event', events: ['pull_request.opened'], repo: 'acme/widgets' }, // not *.labeled
        { type: 'github-event', events: ['issues.labeled'], labelFilter: 'ready', repo: 'acme/widgets' }, // dup of registry
      ], emits: ['revisions-required'] },
      { displayName: 'Reviewer', enabled: true, triggers: [
        { type: 'github-event', events: ['pull_request.labeled'], labelFilter: 'ready-for-review', repo: 'acme/widgets' },
      ], emits: ['ready-to-merge'] }, // dup of registry
    ],
  });
  // registry first, then new wake labels, then new emits; no duplicates
  assert.deepEqual(flowLabels, ['ready', 'ready-to-merge', 'ready-for-review', 'revisions-required']);
});

test('buildTeamFlowLabels builds a per-repo label→agent preview (AC6–8)', () => {
  const { labelAgents } = buildTeamFlowLabels({
    teamLabels: [],
    members: [
      { displayName: 'Developer', enabled: true, triggers: [
        { type: 'github-event', events: ['pull_request.labeled'], labelFilter: 'revisions-required', repo: 'acme/widgets' },
      ] },
      { displayName: 'Code Reviewer', enabled: true, triggers: [
        { type: 'github-event', events: ['pull_request.opened', 'pull_request.labeled'], labelFilter: 'ready-for-review', repo: 'acme/widgets' },
      ] },
      { displayName: 'Security Reviewer', enabled: true, triggers: [
        // same label wakes a second agent → both listed (AC7)
        { type: 'github-event', events: ['pull_request.labeled'], labelFilter: 'ready-for-review', repo: 'acme/widgets' },
        // a different repo is kept separate (AC8 repo-scoped)
        { type: 'github-event', events: ['issues.labeled'], labelFilter: 'ready-for-review', repo: 'acme/tools' },
      ] },
    ],
  });
  assert.deepEqual(labelAgents['acme/widgets']['ready-for-review'], ['Code Reviewer', 'Security Reviewer']);
  assert.deepEqual(labelAgents['acme/widgets']['revisions-required'], ['Developer']);
  assert.deepEqual(labelAgents['acme/tools']['ready-for-review'], ['Security Reviewer']);
});

test('buildTeamFlowLabels records a blank labelFilter as an any-label listener under ""', () => {
  const { labelAgents } = buildTeamFlowLabels({
    teamLabels: [],
    members: [
      { displayName: 'Catch-all', enabled: true, triggers: [
        { type: 'github-event', events: ['issues.labeled'], repo: 'acme/widgets' }, // no labelFilter
      ] },
    ],
  });
  assert.deepEqual(labelAgents['acme/widgets'][''], ['Catch-all']);
});

test('buildTeamFlowLabels ignores disabled agents/triggers', () => {
  const { flowLabels, labelAgents } = buildTeamFlowLabels({
    teamLabels: [],
    members: [
      { displayName: 'Off', enabled: false, triggers: [
        { type: 'github-event', events: ['issues.labeled'], labelFilter: 'nope', repo: 'acme/widgets' },
      ] },
      { displayName: 'On', enabled: true, triggers: [
        { type: 'github-event', enabled: false, events: ['issues.labeled'], labelFilter: 'disabled-trig', repo: 'acme/widgets' },
        { type: 'github-event', events: ['issues.labeled'], labelFilter: 'live', repo: 'acme/widgets' },
      ] },
    ],
  });
  assert.deepEqual(flowLabels, ['live']);
  assert.deepEqual(labelAgents, { 'acme/widgets': { live: ['On'] } });
});

test('buildTeamFlowLabels tolerates empty / missing input', () => {
  assert.deepEqual(buildTeamFlowLabels(), { flowLabels: [], labelAgents: {}, labelUsage: {} });
  assert.deepEqual(buildTeamFlowLabels({}), { flowLabels: [], labelAgents: {}, labelUsage: {} });
});

test('buildTeamFlowLabels classifies label usage (humanGate vs agentEmitted) for colour-coding (#1730)', () => {
  const { labelUsage } = buildTeamFlowLabels({
    teamLabels: [{ name: 'ready', humanGate: true }, { name: 'ready-to-merge' }],
    members: [
      { displayName: 'Developer', enabled: true, triggers: [
        { type: 'github-event', events: ['issues.labeled'], labelFilter: 'ready', repo: 'acme/widgets' },
      ], emits: ['ready-for-review'] },
      { displayName: 'Code Reviewer', enabled: true, triggers: [
        { type: 'github-event', events: ['pull_request.labeled'], labelFilter: 'ready-for-review', repo: 'acme/widgets' },
      ], emits: ['revisions-required'] },
    ],
  });
  // registry humanGate flag → human gate; a member's emits → agent-set.
  assert.equal(labelUsage['ready'], 'humanGate');
  assert.equal(labelUsage['ready-for-review'], 'agentEmitted');
  assert.equal(labelUsage['revisions-required'], 'agentEmitted');
  // a plain registry label that is neither gate-flagged nor emitted stays
  // unclassified (the UI degrades it to a neutral button).
  assert.equal(labelUsage['ready-to-merge'], undefined);
});

test('buildTeamFlowLabels lets a humanGate flag win over an emit (gate-violation truth, #1730)', () => {
  const { labelUsage } = buildTeamFlowLabels({
    teamLabels: [{ name: 'ready', humanGate: true }],
    members: [
      { displayName: 'Rogue', enabled: true, triggers: [], emits: ['ready'] },
    ],
  });
  assert.equal(labelUsage['ready'], 'humanGate');
});

test('buildTeamFlowLabels ignores disabled members when classifying usage (#1730)', () => {
  const { labelUsage } = buildTeamFlowLabels({
    teamLabels: [],
    members: [
      { displayName: 'Off', enabled: false, triggers: [], emits: ['ghost'] },
    ],
  });
  assert.equal(labelUsage['ghost'], undefined);
});

test('teamScopeIdsFromGrants extracts unique team ids and skips agent-granularity', () => {
  const grants = [
    { agentId: 'team-a-dev', teamId: 'team-a', scopeGranularity: 'team' },
    { agentId: 'team-a-ba', teamId: 'team-a', scopeGranularity: 'team' },
    { agentId: 'team-b-dev', teamId: 'team-b', scopeGranularity: 'team' },
    { agentId: 'solo', teamId: 'solo', scopeGranularity: 'agent' },
  ];
  assert.deepEqual(teamScopeIdsFromGrants(grants), ['team-a', 'team-b']);
  assert.deepEqual(teamScopeIdsFromGrants([]), []);
});
