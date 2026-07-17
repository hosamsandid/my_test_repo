// Working-Environment step library (#667, docs/journey-spec-concept.md §2.2).
//
// API-level fixture helpers — a Working Environment is a precondition for the
// wizard, seeded via the real REST API (no UI), exactly as the journey format's
// `fixtures:` block will resolve it. Every function takes (ctx, params) where
// ctx bundles at least { page, request } (Playwright's authenticated fixtures).
const { expect } = require('@playwright/test');

// Create a Working Environment pointing at the in-stack git-remote fixture repo.
// Credential-less on purpose: no sshKeyId, no githubTokenId — the orchestrator
// clones `http://git-remote/…` anonymously and the poller ignores a token-less
// env, so the team materialises with zero external dependencies.
async function createFixtureEnv(ctx, { id, name, repoUrl, branch = 'main' }) {
  const res = await ctx.request.post('/api/environments', {
    data: { id, name, repositories: [{ url: repoUrl, branch }] },
  });
  expect(
    res.ok(),
    `createFixtureEnv(${id}) expected 2xx, got HTTP ${res.status()}: ${await res.text()}`,
  ).toBeTruthy();
  return res.json();
}

// Idempotent teardown — 204 (deleted) and 404 (already gone) are both success,
// so a re-run or a partially-failed spec leaves no environment behind.
async function deleteEnv(ctx, id) {
  const res = await ctx.request.delete(`/api/environments/${encodeURIComponent(id)}`);
  expect(
    [204, 404].includes(res.status()),
    `deleteEnv(${id}) expected 204/404, got HTTP ${res.status()}: ${await res.text()}`,
  ).toBeTruthy();
}

module.exports = { createFixtureEnv, deleteEnv };
