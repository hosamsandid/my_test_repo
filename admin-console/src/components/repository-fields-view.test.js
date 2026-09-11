import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTokenTarget, tokenIsElsewhere, shouldShowTokenHint } from './repository-fields-view.js';

test('normalizeTokenTarget: unknown/absent falls back to "form"', () => {
  assert.equal(normalizeTokenTarget('environment'), 'environment');
  assert.equal(normalizeTokenTarget('form'), 'form');
  assert.equal(normalizeTokenTarget(undefined), 'form');
  assert.equal(normalizeTokenTarget('bogus'), 'form');
});

test('tokenIsElsewhere: only "environment" points away from this form', () => {
  assert.equal(tokenIsElsewhere('environment'), true);
  assert.equal(tokenIsElsewhere('form'), false);
  assert.equal(tokenIsElsewhere(undefined), false);
});

// shouldShowTokenHint — the hint appears only on a FAILED probe of an HTTPS
// URL with no token bound through EITHER channel.
test('shouldShowTokenHint: shown only on an https probe failure with no token', () => {
  const failed = { status: 'error' };
  const ok = { status: 'ok' };
  assert.equal(shouldShowTokenHint(failed, 'https://github.com/org/repo.git', ''), true);
  // Not HTTPS — SSH keys apply instead, no token nudge.
  assert.equal(shouldShowTokenHint(failed, 'git@github.com:org/repo.git', ''), false);
  // Probe not in an error state — no nudge needed yet (still pending / ok).
  assert.equal(shouldShowTokenHint(ok, 'https://github.com/org/repo.git', ''), false);
  assert.equal(shouldShowTokenHint({ status: 'pending' }, 'https://github.com/org/repo.git', ''), false);
  // A real token id already carried by the card suppresses it (the form path).
  assert.equal(shouldShowTokenHint(failed, 'https://github.com/org/repo.git', 'gh-1'), false);
});

// #2161 follow-up — `hasEnvironmentToken` is a SEPARATE suppression channel
// from `githubTokenId`, for the agent-scoped surface which must never send a
// client-guessed placeholder id to the live reachability probe (#2161) but
// still needs to suppress the hint when its Working Environment already has a
// real token bound.
test('#2161 follow-up: hasEnvironmentToken suppresses the hint even with an empty githubTokenId', () => {
  const failed = { status: 'error' };
  // The exact #2161 regression shape: githubTokenId is honestly empty (never a
  // placeholder sent to the probe), but the environment DOES have a real token
  // — the hint must not tell the reader to add one they already have.
  assert.equal(shouldShowTokenHint(failed, 'https://github.com/org/repo.git', '', true), false);
  // No environment token → the hint still shows, same as before #2161's follow-up.
  assert.equal(shouldShowTokenHint(failed, 'https://github.com/org/repo.git', '', false), true);
  assert.equal(shouldShowTokenHint(failed, 'https://github.com/org/repo.git', ''), true, 'omitted (undefined) must default to showing, not hiding');
  // hasEnvironmentToken never overrides the OTHER gates — still SSH-only and
  // still probe-status-gated.
  assert.equal(shouldShowTokenHint(failed, 'git@github.com:org/repo.git', '', true), false);
  assert.equal(shouldShowTokenHint({ status: 'ok' }, 'https://github.com/org/repo.git', '', false), false);
});
