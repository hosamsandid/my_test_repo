import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SEND_KEYBINDINGS,
  DEFAULT_SEND_KEYBINDING,
  SEND_KEYBINDING_KEY,
  normalizeSendKeybinding,
  isMacPlatform,
  loadSendKeybinding,
  saveSendKeybinding,
  decideSendKey,
  sendModifierLabel,
  placeholderSendHint,
} from './message-send-keybinding.js';

// A minimal localStorage stand-in.
function makeStore(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    _map: map,
  };
}

test('presets and default', () => {
  assert.deepEqual(SEND_KEYBINDINGS, ['ide', 'chat']);
  assert.equal(DEFAULT_SEND_KEYBINDING, 'ide');
});

test('normalizeSendKeybinding coerces unknown/legacy to default', () => {
  assert.equal(normalizeSendKeybinding('ide'), 'ide');
  assert.equal(normalizeSendKeybinding('chat'), 'chat');
  assert.equal(normalizeSendKeybinding('slack'), 'ide');
  assert.equal(normalizeSendKeybinding(undefined), 'ide');
  assert.equal(normalizeSendKeybinding(null), 'ide');
});

test('isMacPlatform detects Mac via platform or userAgent', () => {
  assert.equal(isMacPlatform({ platform: 'MacIntel' }), true);
  assert.equal(isMacPlatform({ platform: '', userAgent: 'iPhone' }), true);
  assert.equal(isMacPlatform({ platform: 'Win32' }), false);
  assert.equal(isMacPlatform({ platform: 'Linux x86_64' }), false);
  assert.equal(isMacPlatform(undefined), false);
});

test('load/save round-trip through a store', () => {
  const store = makeStore();
  assert.equal(loadSendKeybinding(store), 'ide'); // empty → default
  saveSendKeybinding('chat', store);
  assert.equal(store._map.get(SEND_KEYBINDING_KEY), 'chat');
  assert.equal(loadSendKeybinding(store), 'chat');
  // Garbage in the store normalizes on read.
  saveSendKeybinding('nonsense', store);
  assert.equal(store._map.get(SEND_KEYBINDING_KEY), 'ide');
  assert.equal(loadSendKeybinding(store), 'ide');
});

test('load/save never throw when storage is unavailable', () => {
  const throwing = { getItem: () => { throw new Error('nope'); }, setItem: () => { throw new Error('nope'); } };
  assert.equal(loadSendKeybinding(throwing), 'ide');
  assert.doesNotThrow(() => saveSendKeybinding('chat', throwing));
});

test('decideSendKey — IDE style: only Cmd/Ctrl+Enter sends', () => {
  assert.equal(decideSendKey({ key: 'Enter', metaKey: true }, 'ide'), 'send');
  assert.equal(decideSendKey({ key: 'Enter', ctrlKey: true }, 'ide'), 'send');
  // Plain Enter is a newline (ignore → composer lets the textarea handle it).
  assert.equal(decideSendKey({ key: 'Enter' }, 'ide'), 'ignore');
  assert.equal(decideSendKey({ key: 'Enter', shiftKey: true }, 'ide'), 'ignore');
});

test('decideSendKey — chat style: plain Enter sends, Shift+Enter newline', () => {
  assert.equal(decideSendKey({ key: 'Enter' }, 'chat'), 'send');
  assert.equal(decideSendKey({ key: 'Enter', shiftKey: true }, 'chat'), 'newline');
  // Cmd/Ctrl+Enter still sends (harmless superset).
  assert.equal(decideSendKey({ key: 'Enter', metaKey: true }, 'chat'), 'send');
  assert.equal(decideSendKey({ key: 'Enter', ctrlKey: true, shiftKey: false }, 'chat'), 'send');
});

test('decideSendKey — non-Enter keys are ignored', () => {
  assert.equal(decideSendKey({ key: 'a', ctrlKey: true }, 'chat'), 'ignore');
  assert.equal(decideSendKey({ key: 'Tab' }, 'ide'), 'ignore');
  assert.equal(decideSendKey(null, 'chat'), 'ignore');
});

test('decideSendKey — IME composition never sends', () => {
  // chat style would normally send on plain Enter; composition suppresses it.
  assert.equal(decideSendKey({ key: 'Enter', isComposing: true }, 'chat'), 'ignore');
  assert.equal(decideSendKey({ key: 'Enter', keyCode: 229 }, 'chat'), 'ignore');
  assert.equal(decideSendKey({ key: 'Enter' }, 'chat', /* composing */ true), 'ignore');
  // And for IDE style with the accelerator held.
  assert.equal(decideSendKey({ key: 'Enter', metaKey: true, isComposing: true }, 'ide'), 'ignore');
});

test('decideSendKey — unknown preset behaves as IDE (default)', () => {
  assert.equal(decideSendKey({ key: 'Enter', metaKey: true }, 'weird'), 'send');
  assert.equal(decideSendKey({ key: 'Enter' }, 'weird'), 'ignore');
});

test('sendModifierLabel is OS-aware', () => {
  assert.equal(sendModifierLabel(true), '⌘');
  assert.equal(sendModifierLabel(false), 'Ctrl');
});

test('placeholderSendHint reflects OS and preset', () => {
  assert.equal(placeholderSendHint('ide', true), '⌘↩ to send');
  assert.equal(placeholderSendHint('ide', false), 'Ctrl+↩ to send');
  assert.equal(placeholderSendHint('chat', true), '↩ to send');
  assert.equal(placeholderSendHint('chat', false), '↩ to send');
});
