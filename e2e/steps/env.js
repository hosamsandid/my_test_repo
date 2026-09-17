// Working-Environment step library (#667, docs/journey-spec-concept.md §2.2).
//
// API-level fixture helpers — a Working Environment is a precondition for the
// wizard, seeded via the real REST API (no UI), exactly as the journey format's
// `fixtures:` block will resolve it. Every function takes (ctx, params) where
// ctx bundles at least { page, request } (Playwright's authenticated fixtures).
const { expect } = require('@playwright/test');

/**
 * Create a Working Environment pointing at the in-stack git-remote fixture repo.
 * Credential-less on purpose: no sshKeyId, no githubTokenId — the orchestrator
 * clones `http://git-remote/…` anonymously and the poller ignores a token-less
 * env, so the team materialises with zero external dependencies.
 *
 * @param {string} params.id - Slug id for the new environment.
 * @param {string} params.name - Human-readable environment name.
 * @param {string} params.repoUrl - Git URL the environment points at.
 * @param {string} [params.branch=main] - Branch to track.
 * @example
 * - action:
 *     do: env.createFixtureEnv
 *     id: agentic-demos-env
 *     name: Agentic Demos
 *     repoUrl: "http://git-remote/e2e/fixture.git"
 */
async function createFixtureEnv(ctx, { id, name, repoUrl, branch = 'main', githubTokenId }) {
  const res = await ctx.request.post('/api/environments', {
    // githubTokenId is optional: the F1 team-setup fixture omits it (poller
    // ignores a token-less env); the #711 IBAN-story fixture supplies one so the
    // poller actually polls the fixture repo and the label chain can fire.
    // When token-less, this env is reference-only ON PURPOSE (see above): #2323
    // blocks a repo-backed env with no GitHub token unless the caller confirms
    // the reference-only intent, so opt in explicitly with acknowledgeNoToken.
    data: {
      id,
      name,
      repositories: [{ url: repoUrl, branch }],
      ...(githubTokenId ? { githubTokenId } : { acknowledgeNoToken: true }),
    },
  });
  expect(
    res.ok(),
    `createFixtureEnv(${id}) expected 2xx, got HTTP ${res.status()}: ${await res.text()}`,
  ).toBeTruthy();
  return res.json();
}

/**
 * Create a GitHub token so the poller will poll the fixture repo (#711). The
 * value is a syntactically-valid but fake PAT — the in-stack fake-github ignores
 * auth entirely; it only needs to EXIST so `env.githubTokenId` resolves and the
 * repo enters the poll plan. Idempotent via a fixed id (409 = already there).
 *
 * @param {string} params.id - Slug id for the token (referenced by the env).
 * @param {string} [params.name] - Human-readable name.
 */
async function createFixtureToken(ctx, { id, name }) {
  const res = await ctx.request.post('/api/github-tokens', {
    data: { id, name: name || id, token: 'ghp_e2efakePATforfakegithub0000000000' },
  });
  expect(
    [201, 409].includes(res.status()),
    `createFixtureToken(${id}) expected 201/409, got HTTP ${res.status()}: ${await res.text()}`,
  ).toBeTruthy();
  return { id };
}

/**
 * Idempotent token teardown — 204 (deleted) and 404 (already gone) are success.
 * @param {string} id - Id of the GitHub token to delete.
 */
async function deleteFixtureToken(ctx, id) {
  const res = await ctx.request.delete(`/api/github-tokens/${encodeURIComponent(id)}`);
  expect(
    [204, 404, 200].includes(res.status()),
    `deleteFixtureToken(${id}) expected 200/204/404, got HTTP ${res.status()}: ${await res.text()}`,
  ).toBeTruthy();
}

/**
 * Idempotent teardown — 204 (deleted) and 404 (already gone) are both success,
 * so a re-run or a partially-failed spec leaves no environment behind.
 *
 * @param {string} id - Id of the environment to delete.
 * @example
 * - action:
 *     do: env.deleteEnv
 *     id: agentic-demos-env
 */
async function deleteEnv(ctx, id) {
  const res = await ctx.request.delete(`/api/environments/${encodeURIComponent(id)}`);
  expect(
    [204, 404].includes(res.status()),
    `deleteEnv(${id}) expected 204/404, got HTTP ${res.status()}: ${await res.text()}`,
  ).toBeTruthy();
}

module.exports = { createFixtureEnv, deleteEnv, createFixtureToken, deleteFixtureToken };
