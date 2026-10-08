import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ITEMS_PAGE_SIZE, ITEMS_RELOAD_MAX, itemsSortFor, itemsQueryKey, itemsQueryUrl, appendItemsPage,
} from './knowledge-items-query.js';

const NO_FILTERS = { q: '', kind: 'all', convergedOnly: false, today: false, showArchived: false };

test('itemsQueryUrl: the unfiltered first page', () => {
  assert.equal(itemsQueryUrl('team-a', { filters: NO_FILTERS }), `/api/knowledge/items?team=team-a&offset=0&limit=${ITEMS_PAGE_SIZE}`);
});

test('itemsQueryUrl: every filter, the agent filter and the sort are forwarded', () => {
  const url = itemsQueryUrl('team-a', {
    filters: { q: ' vite build ', kind: 'convention', convergedOnly: true, today: true, showArchived: true },
    agent: 'dev-1', sort: 'used-asc', offset: 200, limit: 100,
  });
  const p = new URL(url, 'http://x').searchParams;
  assert.equal(p.get('q'), 'vite build');
  assert.equal(p.get('kind'), 'convention');
  assert.equal(p.get('converged'), '1');
  assert.equal(p.get('today'), '1');
  assert.equal(p.get('includeArchived'), '1');
  assert.equal(p.get('agent'), 'dev-1');
  assert.equal(p.get('sort'), 'used-asc');
  assert.equal(p.get('offset'), '200');
});

test('itemsQueryUrl: limit is clamped to the server cap', () => {
  const p = new URL(itemsQueryUrl('t', { limit: 5000 }), 'http://x').searchParams;
  assert.equal(p.get('limit'), String(ITEMS_RELOAD_MAX));
});

test('itemsSortFor maps the Last-used column state', () => {
  assert.equal(itemsSortFor(null), 'created');
  assert.equal(itemsSortFor('desc'), 'used-desc');
  assert.equal(itemsSortFor('asc'), 'used-asc');
});

test('itemsQueryKey changes with what is selected, not with case/whitespace of the search', () => {
  const base = itemsQueryKey('t', { filters: NO_FILTERS });
  assert.equal(itemsQueryKey('t', { filters: { ...NO_FILTERS, q: '  ' } }), base);
  assert.equal(itemsQueryKey('t', { filters: { ...NO_FILTERS, q: 'CI' } }), itemsQueryKey('t', { filters: { ...NO_FILTERS, q: 'ci' } }));
  assert.notEqual(itemsQueryKey('t', { filters: NO_FILTERS, agent: 'a' }), base);
  assert.notEqual(itemsQueryKey('t', { filters: NO_FILTERS, sort: 'used-desc' }), base);
  assert.notEqual(itemsQueryKey('t', { filters: { ...NO_FILTERS, showArchived: true } }), base);
  assert.notEqual(itemsQueryKey('u', { filters: NO_FILTERS }), base);
});

test('appendItemsPage skips rows already in view', () => {
  const prev = [{ id: 'a' }, { id: 'b' }];
  assert.deepEqual(appendItemsPage(prev, [{ id: 'b' }, { id: 'c' }]).map(i => i.id), ['a', 'b', 'c']);
  assert.equal(appendItemsPage(prev, [{ id: 'a' }]), prev);
  assert.deepEqual(appendItemsPage(null, [{ id: 'x' }]).map(i => i.id), ['x']);
});
