// Journey fixture registry (docs/journey-spec-concept.md §2.1 `fixtures:`, #705).
//
// A fixture is code that establishes a named precondition and can undo it — the
// journey YAML only names it (`- fixture: teamEnv`) and passes params. Fixtures
// are deliberately SEPARATE from the `action`/`assert` step vocabulary: they run
// once before the steps and their teardown always runs after (even on failure),
// so a journey leaves no state behind and can re-run on the same stack. They
// compose the existing #667 step modules (env, teardown) — no duplicate logic.
const env = require('../steps/env');
const teardown = require('../steps/teardown');
const gh = require('../steps/gh');
const team = require('../steps/team');

/**
 * teamEnv: the Team-Setup pilot's precondition. Seeds a credential-less Working
 * Environment pointing at the in-stack git remote, so the wizard can materialise
 * a team with zero external dependencies. Because the journey uses FIXED ids
 * (for screenshot determinism, §7), setup first tears down any leftover team+env
 * from a crashed prior run, and teardown removes the team this journey creates
 * plus the fixture env — one deterministic, idempotent surface.
 *
 * @param {string} params.teamId - Team slug id the journey will create (pre-cleaned).
 * @param {string} params.envId - Fixture environment id to create.
 * @param {string} params.envName - Fixture environment display name.
 * @param {string} params.repoUrl - Git URL the environment points at.
 * @param {string} [params.branch=main] - Branch to track.
 * @example
 * fixtures:
 *   - fixture: teamEnv
 *     params:
 *       teamId: agentic-demos
 *       envId: agentic-demos-env
 *       envName: Agentic Demos
 *       repoUrl: "http://git-remote/e2e/fixture.git"
 */
const teamEnv = {
  async setup(ctx, params = {}) {
    const { teamId, envId, envName, repoUrl, branch = 'main' } = params;
    if (!teamId || !envId || !envName || !repoUrl) {
      throw new Error('teamEnv fixture requires { teamId, envId, envName, repoUrl }');
    }
    // Pre-clean: absorb a leftover team/env so a re-run starts from a clean slate.
    await teardown.teardownTeam(ctx, { teamId, envId });
    await env.createFixtureEnv(ctx, { id: envId, name: envName, repoUrl, branch });
    return { teamId, envId };
  },
  async teardown(ctx, params = {}) {
    const { teamId, envId } = params;
    if (teamId && envId) await teardown.teardownTeam(ctx, { teamId, envId });
  },
};

/**
 * ibanStoryTeam: the IBAN-story journey's precondition (#711). Stands up the WHOLE
 * label-chain stack in one atomic precondition so the journey body only drives
 * the hops: it (1) resets fake-github so the run starts from clean GitHub state,
 * (2) creates a fake GitHub token so the poller actually polls the fixture repo
 * (a token-less env is ignored by the poller), (3) creates a credential-carrying
 * Working Environment pointing at the in-stack git remote, and (4) materialises a
 * full Core SDLC team FROM THE PROCESS-TEMPLATE BUNDLE — so `POST /api/teams`
 * runs `expandGithubChannels` and the Developer/Code-Reviewer get the derived
 * github-event channel triggers (issues.labeled=`ready`, pull_request.labeled=
 * `ready-for-review`) that carry the label chain. Bare `roles` would materialise
 * the same agents WITHOUT those channels.
 *
 * FIXED ids keep the journey re-runnable on the same stack: setup pre-cleans any
 * leftover team+env+token from a crashed prior run, and teardown removes the
 * team, env and token this journey created — one deterministic, idempotent surface.
 *
 * @param {string} params.teamId - Team slug id to create (also its member prefix).
 * @param {string} params.teamName - Team display name.
 * @param {string} params.envId - Fixture environment id to create.
 * @param {string} params.envName - Fixture environment display name.
 * @param {string} params.repoUrl - Git URL the environment points at (the in-stack git remote).
 * @param {string} params.tokenId - Fixture GitHub-token id (referenced by the env).
 * @param {string} [params.branch=main] - Branch to track.
 * @param {string} [params.templateId=core-sdlc] - Process template to materialise.
 * @example
 * fixtures:
 *   - fixture: ibanStoryTeam
 *     params:
 *       teamId: iban-demo
 *       teamName: IBAN Demo
 *       envId: iban-demo-env
 *       envName: IBAN Demo
 *       repoUrl: "http://git-remote/e2e/fixture.git"
 *       tokenId: iban-demo-token
 */
const ibanStoryTeam = {
  async setup(ctx, params = {}) {
    const {
      teamId, teamName, envId, envName, repoUrl, tokenId, branch = 'main', templateId = 'core-sdlc',
    } = params;
    if (!teamId || !envId || !envName || !repoUrl || !tokenId) {
      throw new Error('ibanStoryTeam fixture requires { teamId, envId, envName, repoUrl, tokenId }');
    }
    // Pre-clean so a re-run starts from a clean slate (team+env, then token).
    await teardown.teardownTeam(ctx, { teamId, envId });
    await env.deleteFixtureToken(ctx, tokenId);
    // Clean GitHub state for this run — the chain asserts on freshly-created
    // issues/PRs/comments, number-agnostic, so a leftover feed must not linger.
    await gh.reset(ctx);
    // Token must exist BEFORE the env references it.
    await env.createFixtureToken(ctx, { id: tokenId, name: `${teamName || teamId} token` });
    await env.createFixtureEnv(ctx, {
      id: envId, name: envName, repoUrl, branch, githubTokenId: tokenId,
    });
    await team.materializeCoreSdlcTeam(ctx, {
      teamId, teamName: teamName || teamId, envId, templateId,
    });
    return { teamId, envId, tokenId };
  },
  async teardown(ctx, params = {}) {
    const { teamId, envId, tokenId } = params;
    if (teamId && envId) await teardown.teardownTeam(ctx, { teamId, envId });
    if (tokenId) await env.deleteFixtureToken(ctx, tokenId);
  },
};

const FIXTURES = { teamEnv, ibanStoryTeam };

function resolveFixture(name) {
  const fx = FIXTURES[name];
  if (!fx) {
    const known = Object.keys(FIXTURES).sort().join(', ') || '(none)';
    throw new Error(`journey-runner: unknown fixture "${name}". Known fixtures: ${known}`);
  }
  return fx;
}

module.exports = { resolveFixture, FIXTURES };
