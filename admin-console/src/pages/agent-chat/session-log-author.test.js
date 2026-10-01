import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildAuthorDirectory,
  describeMessageAuthor,
  receivedMessageAuthorName,
} from './message-author.js';

/**
 * Session-log author of a human chat message (#2715).
 *
 * The runner records the raw Matrix `sender` as `from` — for a console user
 * without a personal Matrix identity that is the shared admin account, a
 * colleague's handle. The log must name the person the transcript names, or
 * nobody, and never show `from`.
 */

const SHARED_ADMIN = '@k-zyskowski_accent:local';
const AGENT = '@agent-x:local';
const DIRECTORY = buildAuthorDirectory([
  { id: 'u-kj', subject: 'kj@example.com', displayName: 'Klaas-Jan Jongsma' },
  { id: 'u-ann', subject: 'ann@example.com', displayName: 'Ann Lee' },
]);

function received(extra) {
  return { type: 'message.received', correlationId: '$e', body: 'hi', ...extra };
}

test('provisioned human: the stamped author is named, not their Matrix id (AC1, AC4)', () => {
  const ev = received({ from: '@kj:local', author: { userId: 'u-kj', subject: 'kj@example.com' } });
  assert.equal(receivedMessageAuthorName(ev, DIRECTORY), 'Klaas-Jan Jongsma');
});

test('shared-admin fallback with an author stamp names the real author (AC2, AC7)', () => {
  const ev = received({ from: SHARED_ADMIN, author: { userId: 'u-kj', subject: 'kj@example.com' } });
  const name = receivedMessageAuthorName(ev, DIRECTORY);
  assert.equal(name, 'Klaas-Jan Jongsma');
  assert.ok(!name.includes('zyskowski'));
});

test('the log names the same person as the transcript bubble (AC3)', () => {
  for (const stamp of [{ userId: 'u-ann' }, { subject: 'ann@example.com' }, { subject: 'env-admin' }]) {
    const fromLog = receivedMessageAuthorName(received({ from: SHARED_ADMIN, author: stamp }), DIRECTORY);
    const bubble = describeMessageAuthor({
      message: { sender: SHARED_ADMIN, 'io.aee.author': stamp }, agentUserId: AGENT, directory: DIRECTORY,
    });
    assert.equal(fromLog, bubble.badge.name);
  }
});

test('env single-admin (no user record) is named by its login subject', () => {
  const ev = received({ from: SHARED_ADMIN, author: { subject: 'admin' } });
  assert.equal(receivedMessageAuthorName(ev, DIRECTORY), 'admin');
});

test('missing author stamp shows no author, never the sender (AC5)', () => {
  for (const author of [undefined, null, {}, 'junk', { userId: '  ' }]) {
    assert.equal(receivedMessageAuthorName(received({ from: SHARED_ADMIN, author }), DIRECTORY), '');
  }
  // A human's own Matrix client sends no stamp either — omitted, not a raw id.
  assert.equal(receivedMessageAuthorName(received({ from: '@ann:local' }), DIRECTORY), '');
});

test('historic row recorded by the shared admin shows no author (AC6)', () => {
  const historic = { ts: '2026-10-01T09:33:02.000Z', type: 'message.received', correlationId: '$h', from: SHARED_ADMIN, body: 'Can you tell me…' };
  assert.equal(receivedMessageAuthorName(historic, DIRECTORY), '');
  assert.equal(receivedMessageAuthorName(historic), '');
});

test('junk input never throws', () => {
  for (const ev of [null, undefined, 'x', 3, []]) assert.equal(receivedMessageAuthorName(ev, DIRECTORY), '');
});

/* ── wiring guard: JSX is not unit-tested (#651) ─────────────────────────── */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOG_EVENT = fs.readFileSync(path.join(HERE, 'LogEvent.jsx'), 'utf8');
const PANEL = fs.readFileSync(path.join(HERE, 'SessionLogPanel.jsx'), 'utf8');

test('LogEvent never renders the raw Matrix sender (AC7)', () => {
  assert.doesNotMatch(LOG_EVENT, /event\.from/);
  assert.match(LOG_EVENT, /receivedMessageAuthorName\(event, authorDirectory\)/);
});

test('SessionLogPanel hands every row the user directory', () => {
  assert.match(PANEL, /useApi\('\/api\/admin\/users'\)/);
  assert.match(PANEL, /<LogEvent event=\{ev\} authorDirectory=\{authorDirectory\} \/>/);
});
