// Pure probe-availability helpers for the Model Provider form (#912).
//
// "Test connection" / "Discover models" can probe three different credentials,
// and the form has to pick one *before* anything is saved:
//
//   pasted  — a token typed into the setup-token field (sent to the stateless
//             /api/llm-endpoints/probe-* routes together with the form values)
//   stored  — the token already persisted for this endpoint (probed via the
//             /api/llm-endpoints/:id/* routes; the raw value never reaches the
//             browser, so this is the only way to test it)
//   none    — nothing to authenticate with
//
// The subtlety these helpers exist for: a *completed but unsaved* subscription
// login (`oauthFlowId`) holds the freshly minted token server-side and only
// claims it on save, so it cannot be probed. Before #912 the form fell back to
// the `stored` route in that state, i.e. it tested the OLD token — a stale 401
// then read as "my brand-new login failed" and users re-ran the wizard instead
// of just saving. So a pending login now *blocks* the probe and says why.
//
// Kept pure (no React, no fetch) so ModelRegistry.jsx derives the button state
// and the request target from one place — they used to be two independent
// conditions that could disagree — and so it is unit-tested in
// llm-probe-state.test.js.

export const OAUTH_AUTH_TYPE = 'oauth-token';

const trimmed = v => String(v ?? '').trim();

/**
 * Resolve which credential a probe would use, and whether it may run at all.
 *
 * @param form.authType         auth type currently selected in the form
 * @param form.endpointAuthType auth type of the saved endpoint ('api-key' on create)
 * @param form.isEdit           editing an existing endpoint
 * @param form.hasStoredToken   the saved endpoint has a token on file
 * @param form.pastedToken      raw value of the token textarea
 * @param form.clearToken       "remove stored token on save" is ticked
 * @param form.oauthFlowId      id of a completed-but-unsaved login flow
 * @param form.baseUrl          raw value of the Base URL field
 */
export function resolveProbeState(form = {}) {
  const {
    authType = 'api-key',
    endpointAuthType = 'api-key',
    isEdit = false,
    hasStoredToken = false,
    pastedToken = '',
    clearToken = false,
    oauthFlowId = null,
    baseUrl = '',
  } = form;

  const isOauth = authType === OAUTH_AUTH_TYPE;
  const hasPasted = !!trimmed(pastedToken);
  const sameAuthType = authType === endpointAuthType;
  // Hitting the stored-id route is only meaningful while the form still
  // describes the saved endpoint: no new token typed, none being removed, and
  // the auth type unchanged. It does NOT require hasStoredToken — an api-key
  // endpoint without a token is probed unauthenticated on purpose (the form
  // warns about it).
  const usesStored = isEdit && !hasPasted && !clearToken && sameAuthType;
  const tokenSource = hasPasted
    ? 'pasted'
    : (usesStored && hasStoredToken ? 'stored' : 'none');

  // A pending login only exists for subscription auth, and a pasted token wins
  // over it on save — so it only blocks when the paste field is empty.
  const pendingLogin = isOauth && !!oauthFlowId;
  const blocked = pendingLogin && !hasPasted
    ? 'unsaved-login'
    : isOauth
      ? (tokenSource === 'none' ? 'no-token' : null)
      : (trimmed(baseUrl) ? null : 'no-base-url');

  return {
    isOauth,
    pendingLogin,
    hasPasted,
    usesStored,
    tokenSource,
    blocked,
    canProbe: !blocked,
  };
}

/**
 * Why a probe cannot run, phrased for the given probe kind ('test' | 'discover').
 * Returns null when the probe is available.
 */
export function probeBlockedMessage(state, kind = 'test') {
  const verb = kind === 'discover' ? 'discover' : 'test';
  switch (state?.blocked) {
    case 'unsaved-login':
      return `Login completed — save first to ${verb} the newly issued token. `
        + 'The token is claimed on save and cannot be probed before that; '
        + `probing now would ${verb} the previously stored token.`;
    case 'no-token':
      return `No token available to ${verb} — paste one, or save and ${verb} afterwards.`;
    case 'no-base-url':
      return 'Enter a Base URL first.';
    default:
      return null;
  }
}

/**
 * One-line note rendered next to the probe buttons: names the credential that
 * would be probed, so "Failed: HTTP 401" is never ambiguous.
 */
export function probeNote(state) {
  const blockedMsg = probeBlockedMessage(state, 'test');
  if (blockedMsg) return blockedMsg;
  switch (state?.tokenSource) {
    case 'stored':  return 'Probes the token currently stored for this provider.';
    case 'pasted':  return 'Probes the token pasted above (not saved yet).';
    default:        return 'No token — probes the Base URL unauthenticated.';
  }
}

/** Tooltip for a probe button. */
export function probeTitle(state, kind = 'test') {
  const blockedMsg = probeBlockedMessage(state, kind);
  if (blockedMsg) return blockedMsg;
  const what = kind === 'discover'
    ? 'Fetch /v1/models'
    : 'Send GET /v1/models to verify connectivity';
  switch (state?.tokenSource) {
    case 'stored': return `${what} using the token stored for this provider`;
    case 'pasted': return `${what} using the token pasted above`;
    default:       return `${what} (no token — unauthenticated)`;
  }
}

/**
 * Turn a probe result into operator-facing text (#2460). The backend returns
 * `{ ok, reason, status, error, noModelList, ... }`, where `reason` is a stable
 * machine code (see llm-probe-fallback.js PROBE_REASON) and `error` is the raw
 * HTTP detail. This renders the code as plain, actionable language and keeps the
 * raw detail as a SECONDARY line (`detail`), never the primary — and never
 * leaks the internal placeholder model or a bare HTTP status as the headline.
 *
 * @param result  probe result (or, on a discover 502, `{ ok:false, reason, error }`
 *                assembled from the thrown apiCall error)
 * @param kind    'test' | 'discover' — only affects success phrasing
 * @param opts.isOauth  the provider uses subscription (OAuth) auth — tunes the
 *                      auth/unreachable remedy (setup token vs API key; fixed
 *                      Anthropic base vs operator Base URL)
 * @returns { ok, text, detail } — `detail` is null when there is nothing useful
 *          to add beyond the primary line.
 */
export function probeResultMessage(result = {}, kind = 'test', opts = {}) {
  const isOauth = !!opts.isOauth;
  const ok = !!result.ok;
  // The raw detail worth keeping as a secondary line. `error` already has the
  // placeholder model redacted server-side; drop a bare "HTTP <status>" that
  // adds nothing over the plain message.
  const raw = typeof result.error === 'string' ? result.error.trim() : '';
  const detail = raw && !/^HTTP\s+\d+$/i.test(raw) ? raw : null;

  if (ok) {
    const base = kind === 'discover'
      ? 'Connected — the provider is reachable and the credentials are valid.'
      : 'Connection successful — the provider is reachable and the credentials are valid.';
    const suffix = result.noModelList
      ? ' Automatic model discovery isn’t available for this provider — enter the model name(s) manually.'
      : '';
    return { ok: true, text: base + suffix, detail: null };
  }

  let text;
  switch (result.reason) {
    case 'auth':
      text = isOauth
        ? 'Authentication failed — the subscription token was rejected. Re-run the login or paste a new setup token, then try again.'
        : 'Authentication failed — the API key was rejected. Check the key (or paste a new one) and try again.';
      break;
    case 'unreachable':
      text = isOauth
        ? 'Couldn’t reach the Anthropic API — check your network connection and try again.'
        : 'Couldn’t reach the endpoint — check the Base URL and your network connection, then try again.';
      break;
    case 'base-url':
      text = 'Reached the server, but the API route wasn’t found — check the Base URL.';
      break;
    case 'http-error':
      text = 'The provider returned an unexpected error — see the details below.';
      break;
    default:
      // No recognised code (e.g. an unrelated thrown error) — lead with the raw
      // detail if we have one, else a safe generic.
      text = detail || 'The connection check failed.';
      return { ok: false, text, detail: detail && text !== detail ? detail : null };
  }
  return { ok: false, text, detail };
}

/**
 * Route + payload for a probe. Stored-token probes go to the per-endpoint
 * routes; everything else to the stateless probe routes with the form values.
 */
export function probeRequest(form = {}, kind = 'test') {
  const state = resolveProbeState(form);
  if (state.usesStored) {
    const suffix = kind === 'test' ? 'test' : 'discover-models';
    return { path: `/api/llm-endpoints/${form.endpointId}/${suffix}`, body: undefined };
  }
  const suffix = kind === 'test' ? 'probe-test' : 'probe-discover-models';
  return {
    path: `/api/llm-endpoints/${suffix}`,
    body: {
      authType: form.authType ?? 'api-key',
      baseUrl: state.isOauth ? '' : trimmed(form.baseUrl),
      authToken: form.clearToken ? '' : trimmed(form.pastedToken),
    },
  };
}
