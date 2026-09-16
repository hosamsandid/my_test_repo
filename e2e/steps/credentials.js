// Credentials + Working-Environment step library (#668, docs/journey-spec-
// concept.md §2.2). Drives the SSH Keys (/ssh-keys) and Working Environments
// (/environments) admin pages through the real UI, and carries the assertion
// helpers for F3's secret-handling contract: the private key is NEVER returned
// by the API — only a fingerprint (docs/e2e-testing-concept.md §2 F3; the
// contract is documented in the repo CLAUDE.md → Working Environments).
//
// No data-testids exist — selectors are heading text, placeholders, ARIA
// labels, button text and DataTable rows, verified against SshKeys.jsx and
// WorkingEnvironments.jsx.
const { expect } = require('@playwright/test');

// Field names a leaked private key could hide behind in a JSON response. The
// contract is that none of these ever appear, and no PEM header leaks either.
const SECRET_FIELDS = ['privateKey', 'private_key', 'privateKeyPem', 'value', 'key', 'secret'];

// Assert an SSH-key API payload (create response or a list entry) exposes only
// the fingerprint, never any private-key material.
function expectFingerprintOnly(entry, where) {
  expect(entry.fingerprint, `${where}: fingerprint present`).toMatch(/^SHA256:/);
  for (const f of SECRET_FIELDS) {
    expect(entry[f], `${where}: secret field '${f}' must be absent`).toBeUndefined();
  }
  const blob = JSON.stringify(entry);
  expect(blob, `${where}: no PEM private-key header in payload`).not.toContain('PRIVATE KEY');
}

// Create an SSH key through the UI's server-side GENERATE flow (no private key
// ever leaves the server) and return the captured POST response. The generate
// path is the strongest test of the secret contract: the server mints the
// keypair and returns only { fingerprint, publicKey, … } — the private half is
// written to disk and never serialised.
async function generateSshKey(ctx, { name, keyId }) {
  const { page } = ctx;
  await page.goto('/ssh-keys');
  await expect(page.getByRole('heading', { name: 'SSH Keys' })).toBeVisible();
  await page.getByRole('button', { name: 'New Key' }).click();

  // "Generate new keypair" is the default mode; click it defensively in case a
  // prior interaction left "Paste existing key" selected. Since #2165 the
  // generate/paste selector is a radiogroup (ModeToggle), so the two options are
  // radios, not buttons.
  await page.getByRole('radio', { name: 'Generate new keypair' }).click();
  await page.getByPlaceholder('e.g. GitHub Deploy Key').fill(name);
  await page.getByPlaceholder('e.g. github-deploy-key').fill(keyId);

  const respPromise = page.waitForResponse(
    (r) => r.url().includes('/api/ssh-keys/generate') && r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Generate keypair' }).click();
  const resp = await respPromise;
  const body = await resp.json();

  // The reveal panel shows the PUBLIC key only; confirm the private half is not
  // rendered anywhere and dismiss it.
  await expect(page.getByText(/Keypair generated/i)).toBeVisible();
  await expect(page.locator('body')).not.toContainText('PRIVATE KEY');
  await page.getByRole('button', { name: 'Done' }).click();

  return { status: resp.status(), body };
}

// Assert the created key shows up in the list with its fingerprint (and, again,
// no private material anywhere on the page).
async function expectKeyListed(ctx, { name, fingerprint }) {
  const { page } = ctx;
  const row = page.getByRole('row').filter({ hasText: name });
  await expect(row).toBeVisible();
  await expect(row).toContainText(fingerprint);
  await expect(page.locator('body')).not.toContainText('PRIVATE KEY');
}

// API-level list read (for the "absent from all responses" half of the contract).
async function listSshKeys(ctx) {
  const res = await ctx.request.get('/api/ssh-keys');
  expect(res.ok(), `GET /api/ssh-keys expected 2xx, got HTTP ${res.status()}`).toBeTruthy();
  return res.json();
}

// Idempotent teardown for a generated key. 204 (deleted) / 404 (gone) succeed;
// 409 (still referenced) is tolerated — the env teardown removes the reference.
async function deleteSshKey(ctx, keyId) {
  await ctx.request.delete(`/api/ssh-keys/${encodeURIComponent(keyId)}`);
}

// ── Working Environments ────────────────────────────────────────────────────

// Seed a fixture environment via the API. #2168 A2 removed the standalone
// "create environment" UI entry point, and #2170 (epic #2166 A4) retired the
// general-purpose Working Environments page outright, replacing it with the
// System-Admin Environment Templates catalog (which DOES offer a UI create
// action, scoped to `isTemplate: true` records only) — so a fixture for the
// rename/delete UI coverage below still comes in via the still-live
// `POST /api/environments` route (System-Admin/Team-Admin-authorized, same as
// before), now carrying `isTemplate: true` so the seeded record is one this
// page's list actually shows.
async function createEnv(ctx, { envId, name, repoUrl, branch = 'main' }) {
  const res = await ctx.request.post('/api/environments', {
    data: { id: envId, name, repositories: [{ url: repoUrl, branch }], isTemplate: true },
  });
  expect(res.ok(), `POST /api/environments expected 2xx, got HTTP ${res.status()}`).toBeTruthy();
  const { page } = ctx;
  await page.goto('/environment-templates');
  await expect(page.getByRole('heading', { name: 'Environment Templates' })).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: envId })).toBeVisible();
}

// Edit a template's display name through the UI (the id is immutable).
async function renameEnv(ctx, { envId, newName }) {
  const { page } = ctx;
  await page.goto('/environment-templates');
  await page.getByRole('row').filter({ hasText: envId }).getByRole('button', { name: 'Edit' }).click();
  await expect(page.getByRole('heading', { name: /^Edit:/ })).toBeVisible();
  // exact — see createEnv: the Project-context textarea placeholder also
  // contains "COBOL migration" and getByPlaceholder matches substrings.
  const nameInput = page.getByPlaceholder('COBOL Migration', { exact: true });
  await nameInput.fill(newName);
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('row').filter({ hasText: newName })).toBeVisible();
}

// Delete a template through the UI, confirming the dialog.
async function deleteEnvViaUi(ctx, { envId }) {
  const { page } = ctx;
  await page.goto('/environment-templates');
  await page.getByRole('row').filter({ hasText: envId }).getByRole('button', { name: 'Delete' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Delete template')).toBeVisible();
  await dialog.getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByRole('row').filter({ hasText: envId })).toHaveCount(0);
}

// API reads for cross-checking UI mutations against persisted state.
async function getEnv(ctx, envId) {
  const res = await ctx.request.get(`/api/environments/${encodeURIComponent(envId)}`);
  return { status: res.status(), body: res.ok() ? await res.json() : null };
}

module.exports = {
  expectFingerprintOnly,
  generateSshKey,
  expectKeyListed,
  listSshKeys,
  deleteSshKey,
  createEnv,
  renameEnv,
  deleteEnvViaUi,
  getEnv,
};
