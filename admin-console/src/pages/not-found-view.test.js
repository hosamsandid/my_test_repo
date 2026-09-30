import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { NOT_FOUND_COPY, HOME_ROUTE, requestedPathLabel } from './not-found-view.js';
import { NOT_FOUND_LABEL, BREADCRUMBS } from '../components/breadcrumbs.js';

test('the page heading and the header title are the same label', () => {
  assert.equal(NOT_FOUND_COPY.title, NOT_FOUND_LABEL);
});

test('the way back leads to Agent Chat, the landing page', () => {
  assert.equal(HOME_ROUTE, '/chats');
  assert.match(NOT_FOUND_COPY.home, new RegExp(BREADCRUMBS[HOME_ROUTE]));
  assert.match(NOT_FOUND_COPY.hint, /sidebar/);
});

test('requestedPathLabel shows path + query and caps long URLs', () => {
  assert.equal(requestedPathLabel('/does-not-exist-xyz'), '/does-not-exist-xyz');
  assert.equal(requestedPathLabel('/chat', '?x=1'), '/chat?x=1');
  assert.equal(requestedPathLabel(''), '/');
  const long = requestedPathLabel('/' + 'a'.repeat(500));
  assert.equal(long.length, 201);
  assert.ok(long.endsWith('…'));
});

test('NotFound.jsx renders the copy, the path, the home link and the Help button', () => {
  const src = readFileSync(fileURLToPath(new URL('./NotFound.jsx', import.meta.url)), 'utf8');
  assert.match(src, /NOT_FOUND_COPY\.title/);
  assert.match(src, /requestedPathLabel\(pathname, search\)/);
  assert.match(src, /<Link\s+to=\{HOME_ROUTE\}/);
  assert.match(src, /openHelpFor\(\)/);
});
