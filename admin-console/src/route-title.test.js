import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pageNameForPath, documentTitleForPath, APP_NAME, ROUTE_TITLES } from './route-title.js';

test('static routes resolve to their sidebar label', () => {
  assert.equal(pageNameForPath('/token-usage'), 'Token Usage');
  assert.equal(pageNameForPath('/skills'), 'Skills');
  assert.equal(pageNameForPath('/teams'), 'Access');
  assert.equal(pageNameForPath('/chats'), 'Agent Chat');
  // Must match Shell.jsx BREADCRUMBS exactly (lowercase 'a') — the tab title
  // has to read the same as the in-app breadcrumb the user navigated to.
  assert.equal(pageNameForPath('/quickstart'), 'One assistant');
});

test('full document title is "<Page> · Agent Studio"', () => {
  assert.equal(documentTitleForPath('/token-usage'), 'Token Usage · Agent Studio');
  assert.equal(documentTitleForPath('/skills'), 'Skills · Agent Studio');
});

test('root path is labelled for its redirect destination (/chats)', () => {
  assert.equal(pageNameForPath('/'), 'Agent Chat');
  assert.equal(documentTitleForPath('/'), 'Agent Chat · Agent Studio');
});

test('a specific agent chat drops the agent id — just "Agent Chat" (#1921)', () => {
  // The selected agent is already highlighted in the page's left-rail list, so
  // the id is noise in the tab title; it must read the same as the header.
  assert.equal(pageNameForPath('/chats/release-manager'), 'Agent Chat');
  assert.equal(documentTitleForPath('/chats/release-manager'), 'Agent Chat · Agent Studio');
  // trailing slash / empty id resolves to the same base name
  assert.equal(pageNameForPath('/chats/'), 'Agent Chat');
  // and matches the no-agent-selected route exactly
  assert.equal(pageNameForPath('/chats/release-manager'), pageNameForPath('/chats'));
});

test('a plugin viewer keeps the plugin id', () => {
  assert.equal(pageNameForPath('/plugins/netzplan/view'), 'Plugins / netzplan');
  assert.equal(documentTitleForPath('/plugins/netzplan/view'), 'Plugins / netzplan · Agent Studio');
  // the registry route itself stays the plain label
  assert.equal(pageNameForPath('/plugins'), 'Plugins');
});

test('unknown / unauthenticated routes fall back to the bare app name, never a raw path', () => {
  assert.equal(pageNameForPath('/login'), null);
  assert.equal(documentTitleForPath('/login'), APP_NAME);
  assert.equal(documentTitleForPath('/some/unmapped/route'), APP_NAME);
});

test('bad input is handled without throwing', () => {
  assert.equal(pageNameForPath(''), null);
  assert.equal(pageNameForPath(null), null);
  assert.equal(pageNameForPath(undefined), null);
  assert.equal(documentTitleForPath(undefined), APP_NAME);
});

test('every mapped title is a non-empty string (no accidental blanks)', () => {
  for (const [route, label] of Object.entries(ROUTE_TITLES)) {
    assert.ok(route.startsWith('/'), `route ${route} should start with /`);
    assert.ok(typeof label === 'string' && label.length > 0, `label for ${route} must be non-empty`);
  }
});
