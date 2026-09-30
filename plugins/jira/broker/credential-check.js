'use strict';

// ─── jira broker: "does the team's saved credential work?" (#2640) ──────────
//
// Backs `POST /internal/test-scope-credential` (plugins/CONTRACT.md): the
// console's "Test connection" asks the orchestrator, the orchestrator asks the
// broker, and the broker makes ONE cheap read with the credential it already
// holds. The result is a short status for the Credentials form — never the
// token, never a raw Jira body.
//
//   • site + service account → GET /myself as the service account
//     ("Connected as …" / "Token rejected (401)").
//   • site only             → GET /serverInfo, anonymous (the site is right;
//     chat turns use each member's own token, which is not the team's to test).
//   • no site               → nothing to test.
//
// `client` is injected ({ whoAmI, serverInfo } from jira-client.js) so the
// mapping unit-tests without a network.

// Map a failed Jira call to { state, message, httpStatus }. `err.status` is set
// by jira-client for an HTTP error; `err.transport` for DNS/TLS/timeout.
function failureResult(err, { withAccount }) {
  const httpStatus = err && Number.isInteger(err.status) ? err.status : null;
  if (err && err.transport) {
    return { ok: false, state: 'unreachable', httpStatus: null, message: 'Could not reach the Jira site — check the site.' };
  }
  if (httpStatus === 401) {
    return withAccount
      ? { ok: false, state: 'rejected', httpStatus, message: 'Token rejected (401) — check the service-account e-mail and API token.' }
      : { ok: false, state: 'rejected', httpStatus, message: 'The Jira site refused an anonymous check (401).' };
  }
  if (httpStatus === 403) {
    return { ok: false, state: 'forbidden', httpStatus, message: 'Token accepted, but not allowed to read its own account (403) — check the token\'s permissions.' };
  }
  if (httpStatus === 404) {
    return { ok: false, state: 'not-found', httpStatus, message: 'Jira site not found (404) — check the site.' };
  }
  if (httpStatus) {
    return { ok: false, state: 'error', httpStatus, message: `Jira answered with HTTP ${httpStatus}.` };
  }
  return { ok: false, state: 'error', httpStatus: null, message: 'The check failed unexpectedly.' };
}

// `site` = resolveSiteSettings(scopeId) (null when no site is set);
// `cred` = resolveCredential(scopeId) (null when the service account is incomplete).
async function checkScopeCredential({ site, cred }, { client, env } = {}) {
  const checkedAt = new Date().toISOString();
  if (!site) {
    return { ok: false, state: 'not-configured', httpStatus: null, account: null, message: 'No Jira site set — nothing to test.', checkedAt };
  }
  if (cred) {
    try {
      const me = await client.whoAmI(cred, { env });
      const account = me.displayName || me.emailAddress || me.accountId || null;
      if (me.active === false) {
        return { ok: false, state: 'inactive', httpStatus: null, account, message: `Signed in as ${account || 'the service account'}, but that Atlassian account is deactivated.`, checkedAt };
      }
      return { ok: true, state: 'connected', httpStatus: null, account, message: `Connected as ${account || 'the service account'}.`, checkedAt };
    } catch (err) {
      return { ...failureResult(err, { withAccount: true }), account: null, checkedAt };
    }
  }
  try {
    await client.serverInfo(site.siteUrl, { env });
    return {
      ok: true,
      state: 'site-reachable',
      httpStatus: null,
      account: null,
      message: 'Jira site reachable. No service account set, so there is no token to test — chat turns use each member\'s own token.',
      checkedAt,
    };
  } catch (err) {
    return { ...failureResult(err, { withAccount: false }), account: null, checkedAt };
  }
}

module.exports = { checkScopeCredential, failureResult };
