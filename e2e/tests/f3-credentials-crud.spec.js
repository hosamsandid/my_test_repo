// F3 — Working Environment + credential CRUD (docs/e2e-testing-concept.md §2 F3;
// #668). Two self-contained flows against the real admin UI + API:
//   1. SSH key: server-generate a keypair and verify the secret-handling
//      contract — the response (and the list) expose only a fingerprint, never
//      any private-key material, and nothing private renders in the UI.
//   2. Working Environment: seed via the API (#2168 A2 removed the standalone
//      "create environment" UI entry point — team creation is the only UI path
//      that mints one now) → edit → delete through the UI, cross-checked
//      against the persisted API state at each step.
//
// Independent of the team/git-remote fixture (pure UI → API → orchestrator file
// state), so it is the cheapest flow and needs no materialised team.
const { test, expect } = require('@playwright/test');
const cred = require('../steps/credentials');

const FIXTURE_REPO_URL = process.env.E2E_FIXTURE_REPO_URL || 'http://git-remote/e2e/fixture.git';

function makeRunId() {
  const stamp = `${Date.now().toString(36)}${(process.pid % 1000).toString(36)}`;
  return `e2e-${stamp}`.slice(0, 24);
}

test.describe('F3: environment + credential CRUD', () => {
  let keyId;
  let envId;

  test.afterEach(async ({ page, request }) => {
    const ctx = { page, request };
    // Reverse-order best-effort teardown: the env references the key, so drop
    // the env first, then the key. Both idempotent.
    if (envId) {
      await request.delete(`/api/environments/${encodeURIComponent(envId)}`);
    }
    if (keyId) {
      await cred.deleteSshKey(ctx, keyId);
    }
  });

  test('SSH key create returns fingerprint only — private key never leaves the server', async ({ page, request }) => {
    const ctx = { page, request };
    const runId = makeRunId();
    keyId = `${runId}-key`;

    const { status, body } = await cred.generateSshKey(ctx, {
      name: `${runId} deploy key`,
      keyId,
    });

    await test.step('create response exposes only the fingerprint', async () => {
      expect(status, 'generate returns 201').toBe(201);
      cred.expectFingerprintOnly(body, 'POST /api/ssh-keys/generate');
      // The public key is returned once (to paste into GitHub); that is public
      // by definition and is the only key material allowed in the response.
      expect(body.publicKey, 'public key returned once').toMatch(/^ssh-/);
    });

    await test.step('the key is listed with its fingerprint, and no secret leaks in the API list', async () => {
      await cred.expectKeyListed(ctx, { name: `${runId} deploy key`, fingerprint: body.fingerprint });
      const keys = await cred.listSshKeys(ctx);
      const entry = keys.find((k) => k.id === keyId);
      expect(entry, 'created key present in list').toBeTruthy();
      cred.expectFingerprintOnly(entry, 'GET /api/ssh-keys entry');
      expect(entry.publicKey, 'list never re-exposes even the public key').toBeUndefined();
    });
  });

  test('Working Environment seed (API) → edit → delete through the UI', async ({ page, request }) => {
    const ctx = { page, request };
    const runId = makeRunId();
    envId = `${runId}-env`;
    const name = `${runId} env`;
    const renamed = `${runId} env renamed`;

    await test.step('seeded fixture persists the id, name and repository', async () => {
      await cred.createEnv(ctx, { envId, name, repoUrl: FIXTURE_REPO_URL, branch: 'main' });
      const { status, body } = await cred.getEnv(ctx, envId);
      expect(status).toBe(200);
      expect(body.name).toBe(name);
      expect(body.repositories?.[0]?.url).toBe(FIXTURE_REPO_URL);
    });

    await test.step('edit updates the persisted name (id immutable)', async () => {
      await cred.renameEnv(ctx, { envId, newName: renamed });
      const { body } = await cred.getEnv(ctx, envId);
      expect(body.name).toBe(renamed);
      expect(body.id).toBe(envId);
    });

    await test.step('delete removes it from the UI and the API', async () => {
      await cred.deleteEnvViaUi(ctx, { envId });
      const { status } = await cred.getEnv(ctx, envId);
      expect(status, 'env is gone from the API').toBe(404);
      envId = null; // deleted — skip teardown
    });
  });
});
