import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyUserPreferencePatch } from './auth-user-preferences.js';

test('applyUserPreferencePatch: merges the preference into the session user', () => {
  const user = { username: 'alice', userId: 'u-a', chatNotifyOnBack: false };
  const next = applyUserPreferencePatch(user, { chatNotifyOnBack: true });
  assert.equal(next.chatNotifyOnBack, true);
  assert.equal(next.username, 'alice'); // other fields preserved
  assert.equal(next.userId, 'u-a');
});

test('applyUserPreferencePatch: returns a new object (does not mutate)', () => {
  const user = { username: 'alice', chatFontSize: 12 };
  const next = applyUserPreferencePatch(user, { chatFontSize: 16 });
  assert.notEqual(next, user);          // fresh identity → context consumers re-render
  assert.equal(user.chatFontSize, 12);  // original untouched
  assert.equal(next.chatFontSize, 16);
});

test('applyUserPreferencePatch: patches multiple preferences at once', () => {
  const user = { username: 'alice', chatNotifyOnBack: false, chatFontSize: 12 };
  const next = applyUserPreferencePatch(user, { chatNotifyOnBack: true, chatFontSize: 18 });
  assert.equal(next.chatNotifyOnBack, true);
  assert.equal(next.chatFontSize, 18);
});

test('applyUserPreferencePatch: no user in session is a no-op (never synthesises a record)', () => {
  assert.equal(applyUserPreferencePatch(null, { chatNotifyOnBack: true }), null);
  assert.equal(applyUserPreferencePatch(undefined, { chatFontSize: 16 }), undefined);
});

test('applyUserPreferencePatch: an empty / missing patch returns the user unchanged', () => {
  const user = { username: 'alice', chatNotifyOnBack: true };
  assert.equal(applyUserPreferencePatch(user, null), user);
  assert.equal(applyUserPreferencePatch(user, undefined), user);
  assert.deepEqual(applyUserPreferencePatch(user, {}), user);
});
