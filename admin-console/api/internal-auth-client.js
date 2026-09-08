'use strict';

// Control-plane credential for the orchestrator's internal API (#1456,
// GOV-PLATFORM-2, `docs/governance-concept.md` §3.5).
//
// §3.5 says the console sends `INTERNAL_API_TOKEN` "as a bearer header by the
// proxy layer". This console has no proxy layer: it reaches :4002 from **126
// separate raw `fetch` call sites** in `api.js` + `auth.js`, each re-deriving the
// base URL inline through one of three getters. There is no funnel to add a
// header to.
//
// So we make one. `installInternalAuthFetch()` replaces `globalThis.fetch` with a
// wrapper that attaches the bearer header to requests aimed at the orchestrator's
// internal API — and to nothing else. That is a deliberate trade: patching a
// global is a smell, but the alternative is editing 126 call sites, where
// completeness would be a review claim rather than a property, one missed site
// would 401 only in enforce mode (i.e. in production, after the observe week),
// and every future call site would have to remember. Here, a call site cannot
// opt out and a new one is covered the day it is written.
//
// The scoping predicate below is the load-bearing part, because the failure mode
// of getting it wrong is leaking a platform credential to an outside host. It is
// pure, exported, and tested against exactly that.

const crypto = require('crypto');

const INTERNAL_PATH_PREFIX = '/internal/';

function orchestratorOrigin(env = process.env) {
  try {
    return new URL(env.ORCHESTRATOR_URL || 'http://orchestrator:4002').origin;
  } catch {
    return null;
  }
}

/**
 * Should this request carry the control-plane token?
 *
 * BOTH conditions must hold: the exact origin (scheme + host + port) must be the
 * orchestrator's, and the path must be under `/internal/`. Origin alone would be
 * enough today, but the pair is what keeps the credential off anything the
 * orchestrator might serve later, and it makes the intent readable.
 *
 * Returns false for every non-orchestrator URL — api.js also talks to GitHub,
 * Matrix and LLM providers from the same process, and none of them may ever see
 * this token.
 */
function shouldAttachInternalToken(url, origin) {
  if (!origin) return false;
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    return false; // relative or malformed — not an orchestrator call
  }
  if (parsed.origin !== origin) return false;
  return parsed.pathname.startsWith(INTERNAL_PATH_PREFIX);
}

/**
 * Merge the bearer header into a fetch init without disturbing anything the
 * caller set. A caller-supplied Authorization always wins — this wrapper adds a
 * credential, it never overrides one — and the original init object is not
 * mutated, because several api.js call sites build one init and reuse it.
 */
function withInternalAuthHeader(init, token) {
  const next = { ...(init || {}) };
  const headers = new Headers(next.headers || {});
  if (!headers.has('authorization')) headers.set('authorization', `Bearer ${token}`);
  next.headers = headers;
  return next;
}

/**
 * Install the wrapper. Idempotent (a second call is a no-op) and inert when no
 * token is configured, so a stack that has not opted in runs the untouched
 * global `fetch`. Returns a short description for the boot log.
 */
function installInternalAuthFetch({ env = process.env, target = globalThis } = {}) {
  const token = String(env.INTERNAL_API_TOKEN || '').trim();
  if (!token) return { installed: false, reason: 'no INTERNAL_API_TOKEN configured' };
  if (target.fetch && target.fetch.__aeeInternalAuth) {
    return { installed: false, reason: 'already installed' };
  }
  const origin = orchestratorOrigin(env);
  if (!origin) return { installed: false, reason: 'ORCHESTRATOR_URL is not a valid URL' };

  const original = target.fetch;
  const wrapped = function fetchWithInternalAuth(input, init) {
    // `input` may be a string, a URL or a Request. Only the first two forms are
    // used by this codebase; a Request is passed through untouched rather than
    // reconstructed, because rebuilding one is where bodies get lost.
    const url = typeof input === 'string' ? input : (input instanceof URL ? input.href : null);
    if (url !== null && shouldAttachInternalToken(url, origin)) {
      return original.call(target, input, withInternalAuthHeader(init, token));
    }
    return original.call(target, input, init);
  };
  wrapped.__aeeInternalAuth = true;
  target.fetch = wrapped;
  return { installed: true, origin };
}

// The agent-token signing secret is derived from the control-plane token exactly
// as `orchestrator/internal-auth.js` derives it. The console does not mint agent
// tokens — this exists so a future console-side verifier (GOV-PLATFORM-3's audit
// view) reads the same value rather than inventing a second derivation.
const AGENT_SECRET_SALT = 'aee-internal-agent-secret-v1';
function deriveAgentTokenSecret(controlPlaneToken) {
  const t = String(controlPlaneToken || '').trim();
  if (!t) return '';
  return crypto.scryptSync(t, AGENT_SECRET_SALT, 32).toString('hex');
}

module.exports = {
  INTERNAL_PATH_PREFIX,
  AGENT_SECRET_SALT,
  orchestratorOrigin,
  shouldAttachInternalToken,
  withInternalAuthHeader,
  installInternalAuthFetch,
  deriveAgentTokenSecret,
};
