// Pure narration-extraction tests (#744) — no Playwright, run with `node --test`.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { stepKey, stepAudioId, journeyNarration } = require('./narration');

test('stepKey prefers screenshot, falls back to id, else null', () => {
  assert.equal(stepKey({ screenshot: 'shot', id: 'sid' }), 'shot');
  assert.equal(stepKey({ id: 'sid' }), 'sid');
  assert.equal(stepKey({}), null);
  assert.equal(stepKey(null), null);
});

test('stepAudioId namespaces the key by journey id', () => {
  assert.equal(stepAudioId('team-setup', { screenshot: 'review-step' }), 'team-setup-review-step');
  assert.equal(stepAudioId('iban-story', { id: 'intro' }), 'iban-story-intro');
  assert.equal(stepAudioId('team-setup', {}), null);
});

test('journeyNarration collects voiceover steps in document order', () => {
  const doc = {
    id: 'team-setup',
    steps: [
      { kind: 'narrative-only', id: 'intro', voiceover: '  Welcome to Team Setup.  ' },
      { action: { do: 'wizard.open' } }, // no voiceover — skipped
      { id: 'process-step', screenshot: 'process-step-core-sdlc', voiceover: 'Pick Core SDLC.' },
      { assert: { do: 'x.y' }, screenshot: 'no-vo' }, // screenshot but no voiceover — skipped
    ],
  };
  assert.deepEqual(journeyNarration(doc), [
    { id: 'team-setup-intro', text: 'Welcome to Team Setup.' }, // trimmed
    { id: 'team-setup-process-step-core-sdlc', text: 'Pick Core SDLC.' }, // screenshot wins over id
  ]);
});

test('journeyNarration ignores blank/whitespace voiceover and returns [] when none', () => {
  assert.deepEqual(journeyNarration({ id: 'j', steps: [{ id: 's', voiceover: '   ' }] }), []);
  assert.deepEqual(journeyNarration({ id: 'j', steps: [{ action: { do: 'a.b' } }] }), []);
  assert.deepEqual(journeyNarration({ id: 'j' }), []);
});
