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

// teamEnv: the Team-Setup pilot's precondition. Seeds a credential-less Working
// Environment pointing at the in-stack git remote, so the wizard can materialise
// a team with zero external dependencies. Because the journey uses FIXED ids
// (for screenshot determinism, §7), setup first tears down any leftover team+env
// from a crashed prior run, and teardown removes the team this journey creates
// plus the fixture env — one deterministic, idempotent surface.
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

const FIXTURES = { teamEnv };

function resolveFixture(name) {
  const fx = FIXTURES[name];
  if (!fx) {
    const known = Object.keys(FIXTURES).sort().join(', ') || '(none)';
    throw new Error(`journey-runner: unknown fixture "${name}". Known fixtures: ${known}`);
  }
  return fx;
}

module.exports = { resolveFixture, FIXTURES };
