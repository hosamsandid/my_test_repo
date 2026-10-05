import test from 'node:test';
import assert from 'node:assert/strict';
import { isStatusNote, lastTurnMessage, statusNoteMarkdown, STATUS_NOTE_FIELD } from './status-note.js';

const note = {
  event_id: '$n', sender: '@agent:local', msgtype: 'm.notice',
  body: 'Pull request #2838 (https://github.com/o/n/pull/2838) is open — waiting for CI to finish (up to 20 min).',
  [STATUS_NOTE_FIELD]: { kind: 'ci-wait', repo: 'o/n', pr: 2838, attempt: 1, correlationId: 'c1' },
};
const user = { event_id: '$u', sender: '@kj:local', msgtype: 'm.text', body: 'merge it' };
const reply = { event_id: '$r', sender: '@agent:local', msgtype: 'm.text', body: 'done' };

test('isStatusNote: only m.notice with the structured payload', () => {
  assert.equal(isStatusNote(note), true);
  assert.equal(isStatusNote({ ...note, msgtype: 'm.text' }), false);
  assert.equal(isStatusNote({ ...note, [STATUS_NOTE_FIELD]: null }), false);
  assert.equal(isStatusNote({ msgtype: 'm.notice', 'io.aee.trigger': {} }), false);
  assert.equal(isStatusNote(null), false);
});

test('lastTurnMessage skips status notes, so the turn still reads as running', () => {
  assert.equal(lastTurnMessage([user, note]), user);
  assert.equal(lastTurnMessage([user, note, note]), user);
  // The final reply still ends the turn — the note never replaces it.
  assert.equal(lastTurnMessage([user, note, reply]), reply);
  assert.equal(lastTurnMessage([note]), undefined);
  assert.equal(lastTurnMessage([]), undefined);
  assert.equal(lastTurnMessage(null), undefined);
});

test('statusNoteMarkdown links the PR number', () => {
  assert.equal(statusNoteMarkdown(note),
    'Pull request [#2838](https://github.com/o/n/pull/2838) is open — waiting for CI to finish (up to 20 min).');
  const de = { ...note, body: 'Pull Request #5 (https://ghe.example.com/a/b/pull/5) ist offen.' };
  assert.equal(statusNoteMarkdown(de), 'Pull Request [#5](https://ghe.example.com/a/b/pull/5) ist offen.');
  assert.equal(statusNoteMarkdown({ body: 'plain' }), 'plain');
  assert.equal(statusNoteMarkdown({}), '');
});
