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


/**
 * liveWiringTeam: the review-gate-live journey's precondition (#1010). A
 * MINIMAL live team (Business Analyst + Developer) materialised from an inline
 * bundle on a credential-less env pointing at the in-stack git remote — enough
 * for the Flow editor's live scope to wire a review gate against real member
 * configs, with no GitHub polling (token-less env) and no label chain to run.
 * FIXED ids: setup pre-cleans a leftover team+env; teardown removes both.
 *
 * @param {string} params.teamId - Team slug id to create.
 * @param {string} params.teamName - Team display name (the Flows list row).
 * @param {string} params.envId - Fixture environment id to create.
 * @param {string} params.envName - Fixture environment display name.
 * @param {string} params.repoUrl - Git URL the environment points at.
 * @example
 * fixtures:
 *   - fixture: liveWiringTeam
 *     params:
 *       teamId: wiring-demo
 *       teamName: Wiring Demo
 *       envId: wiring-demo-env
 *       envName: Wiring Demo
 *       repoUrl: "http://git-remote/e2e/fixture.git"
 */
const liveWiringTeam = {
  async setup(ctx, params = {}) {
    const { teamId, teamName, envId, envName, repoUrl, branch = 'main' } = params;
    if (!teamId || !envId || !envName || !repoUrl) {
      throw new Error('liveWiringTeam fixture requires { teamId, envId, envName, repoUrl }');
    }
    await teardown.teardownTeam(ctx, { teamId, envId });
    await env.createFixtureEnv(ctx, { id: envId, name: envName, repoUrl, branch });
    await team.materializeBundleTeam(ctx, {
      teamId, teamName: teamName || teamId, envId,
      bundle: {
        processTemplateVersion: 1,
        name: teamName || teamId,
        level: 'template',
        roles: [
          {
            id: 'business-analyst', displayName: 'Business Analyst', role: 'team-member',
            sessionPolicy: 'persistent',
            systemPrompt: 'You are the Business Analyst. You refine requirements into GitHub issues with acceptance criteria.',
            triggers: [],
            outcomes: { mode: 'anyOf', options: [
              { id: 'opens-issue', title: 'Opens issue', when: 'The issue is authored and ready for review', actions: [{ type: 'openIssue' }] },
            ] },
          },
          {
            id: 'developer', displayName: 'Developer', role: 'team-member',
            sessionPolicy: 'per-invocation',
            systemPrompt: 'You are the Developer. You implement a ready issue and open a pull request.',
            triggers: [],
          },
        ],
        gates: [],
        labels: [],
      },
    });
    return { teamId, envId };
  },
  async teardown(ctx, params = {}) {
    const { teamId, envId } = params;
    if (teamId && envId) await teardown.teardownTeam(ctx, { teamId, envId });
  },
};

/**
 * triggerAgent: the `triggers` journey's precondition (#733). Stands up ONE
 * Business-Analyst agent to hang triggers on, as cheaply as possible: a
 * credential-less Working Environment plus a single-member team. The env's
 * repository URL is deliberately a github.com URL so the trigger panel's repo
 * picker (parseRepoFullName, github.com-only) offers it for the github-event /
 * data-flow trigger types — while the token-less HTTPS clone is refused fast by
 * the orchestrator (no PAT ⇒ no username-prompt hang) and tolerated as a seed
 * warning, so the member still materialises. No token ⇒ the poller ignores the
 * repo, so nothing the journey configures ever fires: the config tour stays
 * deterministic (github-event firing end-to-end is already covered by the
 * iban-story journey). FIXED ids keep it re-runnable: setup pre-cleans a leftover
 * team+env, teardown removes the team (cascades to the member) + env.
 *
 * @param {string} params.teamId - Team slug id (its BA member is `<teamId>-business-analyst`).
 * @param {string} params.envId - Fixture environment id to create.
 * @param {string} params.envName - Fixture environment display name.
 * @param {string} params.repoUrl - github.com repo URL (parseable by the trigger repo picker).
 * @example
 * fixtures:
 *   - fixture: triggerAgent
 *     params:
 *       teamId: triggers-demo
 *       envId: triggers-demo-env
 *       envName: Triggers Demo
 *       repoUrl: "https://github.com/aee-e2e/triggers-demo.git"
 */
const triggerAgent = {
  async setup(ctx, params = {}) {
    const { teamId, envId, envName, repoUrl, branch = 'main' } = params;
    if (!teamId || !envId || !envName || !repoUrl) {
      throw new Error('triggerAgent fixture requires { teamId, envId, envName, repoUrl }');
    }
    await teardown.teardownTeam(ctx, { teamId, envId });
    await env.createFixtureEnv(ctx, { id: envId, name: envName, repoUrl, branch });
    await team.materializeTeam(ctx, {
      teamId, teamName: envName, envId, roles: ['business-analyst'],
    });
    return { teamId, envId };
  },
  async teardown(ctx, params = {}) {
    const { teamId, envId } = params;
    if (teamId && envId) await teardown.teardownTeam(ctx, { teamId, envId });
  },
};

// Delete every process draft carrying a given name (idempotent). Drafts get
// server-generated ids, so the journey renames its draft to a fixed name and the
// fixture cleans by that name — one deterministic, re-runnable surface.
async function deleteDraftsNamed(ctx, name) {
  const res = await ctx.request.get('/api/process/drafts');
  if (!res.ok()) return;
  const body = await res.json();
  const drafts = Array.isArray(body) ? body : (body.drafts || []);
  for (const d of drafts) {
    if (d && d.name === name && d.id) {
      await ctx.request.delete(`/api/process/drafts/${encodeURIComponent(d.id)}`);
    }
  }
}

/**
 * flowsDraft: the `flows-draft` journey's precondition (#733). The journey
 * authors a draft named `draftName` and never materialises it, so there is no
 * team/env/Matrix state — only the draft document. This fixture just pre-/post-
 * cleans any draft with that name so a re-run (or a crashed prior run) starts and
 * ends clean.
 *
 * @param {string} [params.draftName=Simple SDLC] - Draft name the journey renames to.
 * @example
 * fixtures:
 *   - fixture: flowsDraft
 *     params:
 *       draftName: Simple SDLC
 */
const flowsDraft = {
  async setup(ctx, params = {}) {
    const { draftName = 'Simple SDLC' } = params;
    await deleteDraftsNamed(ctx, draftName);
    return { draftName };
  },
  async teardown(ctx, params = {}) {
    const { draftName = 'Simple SDLC' } = params;
    await deleteDraftsNamed(ctx, draftName);
  },
};

const FIXTURES = { teamEnv, ibanStoryTeam, triggerAgent, flowsDraft, liveWiringTeam };

function resolveFixture(name) {
  const fx = FIXTURES[name];
  if (!fx) {
    const known = Object.keys(FIXTURES).sort().join(', ') || '(none)';
    throw new Error(`journey-runner: unknown fixture "${name}". Known fixtures: ${known}`);
  }
  return fx;
}

module.exports = { resolveFixture, FIXTURES };
