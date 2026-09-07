import test from 'node:test';
import assert from 'node:assert/strict';

import {
  hasRepoUrl,
  quickstartEndpoint,
  quickstartBody,
  repoPrerequisitesMet,
  showRepoPrerequisites,
  canSubmitQuickstart,
  quickstartSubmitReasons,
  QUICKSTART_COPY,
  fastLaneCopyForcesModeChoice,
} from './quickstart-view.js';

// --- hasRepoUrl: the single fork predicate ---------------------------------

test('hasRepoUrl: empty / whitespace / non-string are repo-less', () => {
  assert.equal(hasRepoUrl(''), false);
  assert.equal(hasRepoUrl('   '), false);
  assert.equal(hasRepoUrl(undefined), false);
  assert.equal(hasRepoUrl(null), false);
  assert.equal(hasRepoUrl(42), false);
});

test('hasRepoUrl: any non-blank string is a repo', () => {
  assert.equal(hasRepoUrl('https://github.com/org/repo'), true);
  assert.equal(hasRepoUrl('  git@github.com:o/r.git '), true);
});

// --- quickstartEndpoint: routing (AC3 / AC4 / AC8) -------------------------

test('quickstartEndpoint: repo URL → repo path', () => {
  assert.equal(quickstartEndpoint('https://github.com/org/repo'), '/api/quickstart');
});

test('quickstartEndpoint: empty URL → LLM-only path', () => {
  assert.equal(quickstartEndpoint(''), '/api/quickstart/llm');
  assert.equal(quickstartEndpoint('   '), '/api/quickstart/llm');
});

// --- quickstartBody --------------------------------------------------------

test('quickstartBody: repo path trims the URL and passes optional pickers', () => {
  assert.deepEqual(
    quickstartBody({ url: '  https://github.com/o/r ', tokenId: 't1', sshKeyId: 'k1' }),
    { url: 'https://github.com/o/r', githubTokenId: 't1', sshKeyId: 'k1' },
  );
});

test('quickstartBody: repo path with default (unset) pickers → undefined, not empty string', () => {
  assert.deepEqual(
    quickstartBody({ url: 'https://github.com/o/r', tokenId: '', sshKeyId: '' }),
    { url: 'https://github.com/o/r', githubTokenId: undefined, sshKeyId: undefined },
  );
});

test('quickstartBody: LLM path carries only name + provider (no token / ssh)', () => {
  const body = quickstartBody({ url: '', displayName: '  My Assistant ', llmEndpointId: 'ep1' });
  assert.deepEqual(body, { displayName: 'My Assistant', llmEndpointId: 'ep1' });
  assert.ok(!('githubTokenId' in body));
  assert.ok(!('sshKeyId' in body));
});

// --- prerequisites: enforced only with a repo (AC5) ------------------------

test('repoPrerequisitesMet: needs both a token and an SSH key', () => {
  assert.equal(repoPrerequisitesMet({ hasTokens: true, hasSshKeys: true }), true);
  assert.equal(repoPrerequisitesMet({ hasTokens: true, hasSshKeys: false }), false);
  assert.equal(repoPrerequisitesMet({ hasTokens: false, hasSshKeys: true }), false);
});

test('showRepoPrerequisites: hidden until a repo URL is entered', () => {
  assert.equal(showRepoPrerequisites(''), false);
  assert.equal(showRepoPrerequisites('https://github.com/o/r'), true);
});

// --- canSubmitQuickstart ---------------------------------------------------

test('canSubmit: repo-less needs provider + name, NOT token / ssh (AC4 / AC5)', () => {
  const base = { url: '', hasTokens: false, hasSshKeys: false, hasLlmEndpoints: true };
  assert.equal(canSubmitQuickstart({ ...base, displayName: 'A', selectedLlmId: 'ep1' }), true);
  // Missing name blocks.
  assert.equal(canSubmitQuickstart({ ...base, displayName: '  ', selectedLlmId: 'ep1' }), false);
  // Missing selected provider blocks.
  assert.equal(canSubmitQuickstart({ ...base, displayName: 'A', selectedLlmId: '' }), false);
  // No providers at all blocks.
  assert.equal(
    canSubmitQuickstart({ ...base, hasLlmEndpoints: false, displayName: 'A', selectedLlmId: 'ep1' }),
    false,
  );
});

test('canSubmit: repo path requires the GitHub prerequisites, independent of name', () => {
  const repo = { url: 'https://github.com/o/r', hasLlmEndpoints: false, displayName: '', selectedLlmId: '' };
  assert.equal(canSubmitQuickstart({ ...repo, hasTokens: true, hasSshKeys: true }), true);
  assert.equal(canSubmitQuickstart({ ...repo, hasTokens: true, hasSshKeys: false }), false);
  assert.equal(canSubmitQuickstart({ ...repo, hasTokens: false, hasSshKeys: true }), false);
});

// --- QUICKSTART_COPY: Phase D framing (#1667, decision D5) ------------------

test('#1667 AC3: the fast-lane heading drops the "Single Agent" mode label', () => {
  assert.equal(typeof QUICKSTART_COPY.heading, 'string');
  assert.ok(QUICKSTART_COPY.heading.length > 0);
  // The old heading was the mode label "Single Agent"; the reframe removes it.
  assert.notEqual(QUICKSTART_COPY.heading, 'Single Agent');
  assert.doesNotMatch(QUICKSTART_COPY.heading, /\bvs\b/i);
});

test('#2045: the team-of-one note and its Grow CTA are gone from the copy', () => {
  // The footer card that carried them was removed, so keeping the strings would
  // be dead data that only a guard still reads. The framing lives on the
  // launcher hero and in help-topics/create.md.
  assert.deepEqual(Object.keys(QUICKSTART_COPY).sort(), ['heading', 'intro']);
  assert.ok(!('teamOfOneNote' in QUICKSTART_COPY));
  assert.ok(!('growCtaLabel' in QUICKSTART_COPY));
  assert.ok(
    !/team of one|grow into/i.test(Object.values(QUICKSTART_COPY).join(' ')),
    'no remaining page copy may re-introduce the footer wording',
  );
});

test('#1667 AC1/AC3: no launcher-path copy forces an agent-vs-team choice', () => {
  assert.equal(fastLaneCopyForcesModeChoice(), false);
  // Regression guards: reinstating any removed wrong-mode phrasing must trip it.
  assert.equal(
    fastLaneCopyForcesModeChoice({
      ...QUICKSTART_COPY,
      note: 'Need a full development team instead?',
    }),
    true,
  );
  assert.equal(
    fastLaneCopyForcesModeChoice({
      ...QUICKSTART_COPY,
      detail: 'use the Agent Team Wizard for that.',
    }),
    true,
  );
  // Since #2045 the guard no longer demands the "team of one" wording — the
  // surface that carried it is gone, and requiring it would keep a string
  // alive for the guard's sake alone.
  assert.equal(fastLaneCopyForcesModeChoice({ heading: 'Chat with one assistant' }), false);
});

// --- quickstartSubmitReasons: explain the disabled submit button -----------

// The hard invariant: the checklist and the button gate can never disagree.
test('quickstartSubmitReasons: canSubmit matches canSubmitQuickstart across cases', () => {
  const cases = [
    // repo-less
    { url: '', hasTokens: false, hasSshKeys: false, hasLlmEndpoints: false, displayName: '', selectedLlmId: '' },
    { url: '', hasTokens: false, hasSshKeys: false, hasLlmEndpoints: true, displayName: '', selectedLlmId: '' },
    { url: '', hasTokens: false, hasSshKeys: false, hasLlmEndpoints: true, displayName: 'Bot', selectedLlmId: '' },
    { url: '', hasTokens: false, hasSshKeys: false, hasLlmEndpoints: true, displayName: 'Bot', selectedLlmId: 'ep1' },
    { url: '  ', hasTokens: false, hasSshKeys: false, hasLlmEndpoints: true, displayName: '   ', selectedLlmId: 'ep1' },
    // repo path
    { url: 'https://github.com/o/r', hasTokens: false, hasSshKeys: false, hasLlmEndpoints: false, displayName: 'x', selectedLlmId: '' },
    { url: 'https://github.com/o/r', hasTokens: true, hasSshKeys: false, hasLlmEndpoints: false, displayName: 'x', selectedLlmId: '' },
    { url: 'https://github.com/o/r', hasTokens: false, hasSshKeys: true, hasLlmEndpoints: false, displayName: 'x', selectedLlmId: '' },
    { url: 'https://github.com/o/r', hasTokens: true, hasSshKeys: true, hasLlmEndpoints: false, displayName: 'x', selectedLlmId: '' },
  ];
  for (const c of cases) {
    assert.equal(
      quickstartSubmitReasons(c).canSubmit,
      canSubmitQuickstart(c),
      `parity mismatch for ${JSON.stringify(c)}`,
    );
  }
});

test('quickstartSubmitReasons: repo-less lists name + provider, in form order', () => {
  const { canSubmit, reasons } = quickstartSubmitReasons({
    url: '', hasTokens: false, hasSshKeys: false, hasLlmEndpoints: false,
    displayName: '', selectedLlmId: '',
  });
  assert.equal(canSubmit, false);
  assert.deepEqual(reasons.map(r => r.field), ['name', 'provider']);
  assert.match(reasons[1].message, /model provider/i);
});

test('quickstartSubmitReasons: repo-less with providers but none selected → choose', () => {
  const { reasons } = quickstartSubmitReasons({
    url: '', hasTokens: false, hasSshKeys: false, hasLlmEndpoints: true,
    displayName: 'My Assistant', selectedLlmId: '',
  });
  assert.deepEqual(reasons.map(r => r.field), ['provider']);
  assert.match(reasons[0].message, /choose/i);
});

test('quickstartSubmitReasons: a fully-ready repo-less form has no reasons', () => {
  const { canSubmit, reasons } = quickstartSubmitReasons({
    url: '', hasTokens: false, hasSshKeys: false, hasLlmEndpoints: true,
    displayName: 'My Assistant', selectedLlmId: 'ep1',
  });
  assert.equal(canSubmit, true);
  assert.equal(reasons.length, 0);
});

test('quickstartSubmitReasons: repo path lists missing GitHub prerequisites (ssh before token)', () => {
  const { canSubmit, reasons } = quickstartSubmitReasons({
    url: 'https://github.com/o/r', hasTokens: false, hasSshKeys: false,
    hasLlmEndpoints: true, displayName: 'x', selectedLlmId: 'ep1',
  });
  assert.equal(canSubmit, false);
  assert.deepEqual(reasons.map(r => r.field), ['ssh-key', 'github-token']);
});

test('quickstartSubmitReasons: repo path with both prerequisites met has no reasons', () => {
  const { canSubmit, reasons } = quickstartSubmitReasons({
    url: 'https://github.com/o/r', hasTokens: true, hasSshKeys: true,
    hasLlmEndpoints: false, displayName: '', selectedLlmId: '',
  });
  assert.equal(canSubmit, true);
  assert.equal(reasons.length, 0);
});
