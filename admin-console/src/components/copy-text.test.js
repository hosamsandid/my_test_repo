import { test } from 'node:test';
import assert from 'node:assert/strict';

import { copyText, COPY_FAILED_HINT } from './copy-text.js';

// Minimal fake DOM: records the textarea it was handed and what execCommand saw.
function fakeDocument({ execResult = true, execThrows = false } = {}) {
  const log = { appended: [], removed: [], selected: null, commands: [] };
  const doc = {
    body: {
      appendChild: (el) => log.appended.push(el),
      removeChild: (el) => log.removed.push(el),
    },
    createElement: () => {
      const el = { value: '', style: {}, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } };
      el.select = () => { log.selected = el.value; };
      return el;
    },
    execCommand: (cmd) => {
      log.commands.push(cmd);
      if (execThrows) throw new Error('nope');
      return execResult;
    },
  };
  return { doc, log };
}

test('uses the async clipboard API when available', async () => {
  const written = [];
  const { doc, log } = fakeDocument();
  const ok = await copyText('ssh-ed25519 AAA', {
    navigator: { clipboard: { writeText: async (t) => { written.push(t); } } },
    document: doc,
  });
  assert.equal(ok, true);
  assert.deepEqual(written, ['ssh-ed25519 AAA']);
  assert.deepEqual(log.commands, [], 'no legacy fallback when the API worked');
});

test('falls back to execCommand when navigator.clipboard is undefined (plain http)', async () => {
  const { doc, log } = fakeDocument();
  const ok = await copyText('ssh-ed25519 AAA', { navigator: {}, document: doc });
  assert.equal(ok, true);
  assert.equal(log.selected, 'ssh-ed25519 AAA');
  assert.deepEqual(log.commands, ['copy']);
  assert.equal(log.removed.length, 1, 'the helper textarea is cleaned up');
  assert.equal(log.removed[0], log.appended[0]);
});

test('falls back when the clipboard API rejects', async () => {
  const { doc, log } = fakeDocument();
  const ok = await copyText('x', {
    navigator: { clipboard: { writeText: async () => { throw new Error('denied'); } } },
    document: doc,
  });
  assert.equal(ok, true);
  assert.deepEqual(log.commands, ['copy']);
});

test('reports failure when neither path works', async () => {
  const refused = fakeDocument({ execResult: false });
  assert.equal(await copyText('x', { navigator: {}, document: refused.doc }), false);
  const throwing = fakeDocument({ execThrows: true });
  assert.equal(await copyText('x', { navigator: {}, document: throwing.doc }), false);
  assert.equal(throwing.log.removed.length, 1, 'cleaned up even when execCommand throws');
  assert.equal(await copyText('x', { navigator: undefined, document: undefined }), false);
});

test('the failure hint tells the user how to copy by hand', () => {
  assert.match(COPY_FAILED_HINT, /Ctrl\+C/);
});
