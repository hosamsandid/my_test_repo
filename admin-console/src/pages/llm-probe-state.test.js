import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveProbeState,
  probeBlockedMessage,
  probeNote,
  probeTitle,
  probeRequest,
  probeResultMessage,
  OAUTH_AUTH_TYPE,
} from './llm-probe-state.js';

// An oauth provider being edited, token on file — the shape from the #912 repro.
const storedOauth = {
  authType: OAUTH_AUTH_TYPE,
  endpointAuthType: OAUTH_AUTH_TYPE,
  isEdit: true,
  hasStoredToken: true,
  endpointId: 'claude-enterprise',
};

/* ── the #912 case: completed but unsaved login ─────────────────────────── */

test('completed-but-unsaved login blocks the probe instead of testing the old token', () => {
  const s = resolveProbeState({ ...storedOauth, oauthFlowId: 'abc123' });
  assert.equal(s.pendingLogin, true);
  assert.equal(s.canProbe, false);
  assert.equal(s.blocked, 'unsaved-login');
});

test('the block message names save as the next step, for both probe kinds', () => {
  const s = resolveProbeState({ ...storedOauth, oauthFlowId: 'abc123' });
  assert.match(probeBlockedMessage(s, 'test'), /save first to test the newly issued token/);
  assert.match(probeBlockedMessage(s, 'discover'), /save first to discover the newly issued token/);
  // and it explains what the probe *would* have hit
  assert.match(probeBlockedMessage(s, 'test'), /previously stored token/);
});

test('a pending login blocks even when no token is stored yet (create mode)', () => {
  const s = resolveProbeState({
    authType: OAUTH_AUTH_TYPE, endpointAuthType: 'api-key',
    isEdit: false, oauthFlowId: 'abc123',
  });
  assert.equal(s.blocked, 'unsaved-login');
  assert.equal(s.canProbe, false);
});

test('a pasted token wins over a pending login — probe allowed, paste is probed', () => {
  const form = { ...storedOauth, oauthFlowId: 'abc123', pastedToken: '  sk-ant-oat-new  ' };
  const s = resolveProbeState(form);
  assert.equal(s.canProbe, true);
  assert.equal(s.tokenSource, 'pasted');
  assert.equal(probeBlockedMessage(s, 'test'), null);
  // mirrors save precedence: paste > oauthFlowId > keep stored
  assert.deepEqual(probeRequest(form, 'test'), {
    path: '/api/llm-endpoints/probe-test',
    body: { authType: OAUTH_AUTH_TYPE, baseUrl: '', authToken: 'sk-ant-oat-new' },
  });
});

test('a stale oauthFlowId left over after switching to api-key does not block', () => {
  const s = resolveProbeState({
    authType: 'api-key', endpointAuthType: OAUTH_AUTH_TYPE,
    isEdit: true, hasStoredToken: true, oauthFlowId: 'abc123',
    baseUrl: 'https://litellm.example/v1',
  });
  assert.equal(s.pendingLogin, false);
  assert.equal(s.canProbe, true);
});

/* ── unchanged behaviour: which credential a probe uses ─────────────────── */

test('oauth edit without a pending login probes the stored token', () => {
  const s = resolveProbeState(storedOauth);
  assert.equal(s.canProbe, true);
  assert.equal(s.tokenSource, 'stored');
  assert.equal(s.usesStored, true);
  assert.deepEqual(probeRequest({ ...storedOauth }, 'test'), {
    path: '/api/llm-endpoints/claude-enterprise/test', body: undefined,
  });
  assert.deepEqual(probeRequest({ ...storedOauth }, 'discover'), {
    path: '/api/llm-endpoints/claude-enterprise/discover-models', body: undefined,
  });
});

test('oauth without any token cannot probe', () => {
  const s = resolveProbeState({ authType: OAUTH_AUTH_TYPE, endpointAuthType: 'api-key' });
  assert.equal(s.blocked, 'no-token');
  assert.match(probeBlockedMessage(s, 'test'), /paste one, or save and test afterwards/);
  assert.match(probeBlockedMessage(s, 'discover'), /paste one, or save and discover afterwards/);
});

test('oauth edit whose provider was api-key cannot probe the stored token', () => {
  // switching an api-key provider over to subscription auth: the stored value is
  // an api key, not an oauth token, so the stored route is not offered
  const s = resolveProbeState({
    authType: OAUTH_AUTH_TYPE, endpointAuthType: 'api-key',
    isEdit: true, hasStoredToken: true,
  });
  assert.equal(s.usesStored, false);
  assert.equal(s.blocked, 'no-token');
});

test('api-key mode needs a base URL', () => {
  const empty = resolveProbeState({ authType: 'api-key', baseUrl: '   ' });
  assert.equal(empty.blocked, 'no-base-url');
  assert.equal(probeBlockedMessage(empty, 'test'), 'Enter a Base URL first.');
  const ok = resolveProbeState({ authType: 'api-key', baseUrl: 'https://litellm.example/v1' });
  assert.equal(ok.canProbe, true);
});

test('api-key create probes the form values unauthenticated when no token typed', () => {
  const form = { authType: 'api-key', baseUrl: ' https://litellm.example/v1 ' };
  assert.equal(resolveProbeState(form).tokenSource, 'none');
  assert.deepEqual(probeRequest(form, 'test'), {
    path: '/api/llm-endpoints/probe-test',
    body: { authType: 'api-key', baseUrl: 'https://litellm.example/v1', authToken: '' },
  });
});

test('api-key edit with no token typed probes the stored token', () => {
  const form = {
    authType: 'api-key', endpointAuthType: 'api-key', isEdit: true,
    hasStoredToken: true, endpointId: 'litellm-prod', baseUrl: 'https://litellm.example/v1',
  };
  const s = resolveProbeState(form);
  assert.equal(s.tokenSource, 'stored');
  assert.deepEqual(probeRequest(form, 'discover'), {
    path: '/api/llm-endpoints/litellm-prod/discover-models', body: undefined,
  });
});

test('api-key edit without a stored token still uses the stored route (unauthenticated)', () => {
  const form = {
    authType: 'api-key', endpointAuthType: 'api-key', isEdit: true,
    hasStoredToken: false, endpointId: 'litellm-prod', baseUrl: 'https://litellm.example/v1',
  };
  const s = resolveProbeState(form);
  assert.equal(s.usesStored, true);
  assert.equal(s.tokenSource, 'none');
  assert.equal(probeRequest(form, 'test').path, '/api/llm-endpoints/litellm-prod/test');
});

test('"remove stored token on save" switches to a stateless, tokenless probe', () => {
  const form = {
    authType: 'api-key', endpointAuthType: 'api-key', isEdit: true,
    hasStoredToken: true, clearToken: true, pastedToken: 'ignored',
    endpointId: 'litellm-prod', baseUrl: 'https://litellm.example/v1',
  };
  assert.equal(resolveProbeState(form).usesStored, false);
  assert.deepEqual(probeRequest(form, 'test'), {
    path: '/api/llm-endpoints/probe-test',
    body: { authType: 'api-key', baseUrl: 'https://litellm.example/v1', authToken: '' },
  });
});

test('whitespace-only paste counts as no token', () => {
  const s = resolveProbeState({ ...storedOauth, pastedToken: '   \n ' });
  assert.equal(s.hasPasted, false);
  assert.equal(s.tokenSource, 'stored');
});

/* ── copy: the note/tooltip always say which credential is probed ───────── */

test('probeNote names the credential under test', () => {
  assert.match(probeNote(resolveProbeState(storedOauth)), /token currently stored/);
  assert.match(probeNote(resolveProbeState({ ...storedOauth, pastedToken: 'sk-x' })), /pasted above/);
  assert.match(
    probeNote(resolveProbeState({ authType: 'api-key', baseUrl: 'https://x/v1' })),
    /unauthenticated/,
  );
});

test('probeNote surfaces the blocking reason when the probe is unavailable', () => {
  assert.match(probeNote(resolveProbeState({ ...storedOauth, oauthFlowId: 'f1' })), /save first/);
});

test('probeTitle distinguishes test from discover and names the credential', () => {
  const s = resolveProbeState(storedOauth);
  assert.match(probeTitle(s, 'test'), /^Send GET \/v1\/models.*stored for this provider$/);
  assert.match(probeTitle(s, 'discover'), /^Fetch \/v1\/models.*stored for this provider$/);
  assert.match(probeTitle(resolveProbeState({ ...storedOauth, oauthFlowId: 'f1' }), 'test'), /save first/);
});

test('resolveProbeState tolerates an empty form (create dialog, nothing typed)', () => {
  const s = resolveProbeState();
  assert.equal(s.isOauth, false);
  assert.equal(s.canProbe, false);
  assert.equal(s.blocked, 'no-base-url');
});

/* ── probeResultMessage: plain, actionable probe verdicts (#2460) ─────────── */

test('probeResultMessage: success is plain, with no placeholder model and no raw URL', () => {
  const m = probeResultMessage({ ok: true, status: 200, url: 'https://api.anthropic.com/v1/messages/count_tokens' }, 'test');
  assert.equal(m.ok, true);
  assert.doesNotMatch(m.text, /__aee-probe-placeholder__/);
  assert.doesNotMatch(m.text, /https?:\/\//);
  assert.doesNotMatch(m.text, /HTTP \d/);
  assert.equal(m.detail, null);
});

test('probeResultMessage: OAuth success notes manual model entry (noModelList)', () => {
  const m = probeResultMessage({ ok: true, noModelList: true }, 'test', { isOauth: true });
  assert.equal(m.ok, true);
  assert.match(m.text, /manually/i);
});

test('probeResultMessage: an auth failure is actionable and auth-type specific (AC5)', () => {
  const oauth = probeResultMessage({ ok: false, reason: 'auth', error: 'HTTP 401' }, 'test', { isOauth: true });
  assert.equal(oauth.ok, false);
  assert.match(oauth.text, /setup token|re-run the login/i);
  const apiKey = probeResultMessage({ ok: false, reason: 'auth', error: 'HTTP 403' }, 'test', { isOauth: false });
  assert.match(apiKey.text, /API key/i);
  // A bare "HTTP 401" adds nothing over the plain message → dropped as detail.
  assert.equal(oauth.detail, null);
});

test('probeResultMessage: unreachable phrasing differs for OAuth (fixed base) vs api-key', () => {
  assert.match(probeResultMessage({ ok: false, reason: 'unreachable' }, 'test', { isOauth: true }).text, /Anthropic API/);
  assert.match(probeResultMessage({ ok: false, reason: 'unreachable' }, 'test', { isOauth: false }).text, /Base URL/);
});

test('probeResultMessage: base-url failure points at the Base URL', () => {
  const m = probeResultMessage({ ok: false, reason: 'base-url', error: 'HTTP 404' }, 'test');
  assert.match(m.text, /Base URL/);
});

test('probeResultMessage: an unexpected http error keeps the meaningful proxy body as detail (AC7)', () => {
  const m = probeResultMessage({ ok: false, reason: 'http-error', error: 'HTTP 400 — Budget has been exceeded!' }, 'test');
  assert.equal(m.ok, false);
  assert.match(m.text, /unexpected/i);
  assert.equal(m.detail, 'HTTP 400 — Budget has been exceeded!');
});

test('probeResultMessage: an unrecognised failure (thrown error, no code) leads with the raw message', () => {
  const m = probeResultMessage({ ok: false, error: 'network down' }, 'test');
  assert.equal(m.ok, false);
  assert.equal(m.text, 'network down');
});
