import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CONTEXT_ROOT_KEY,
  isContextKey,
  contextRelOf,
  isReadOnlyKey,
  workspaceUrl,
  contextRootItem,
  withContextRoot,
  childKey,
} from './workspace-source.js';

test('context keys are exactly the mount root and its descendants', () => {
  assert.equal(isContextKey('/context'), true);
  assert.equal(isContextKey('/context/docs/note.md'), true);
  assert.equal(isContextKey(''), false);
  assert.equal(isContextKey('memory/log.md'), false);
  // A real workspace folder called `context` must NOT be mistaken for the mount.
  assert.equal(isContextKey('context'), false);
  assert.equal(isContextKey('context/notes.md'), false);
  assert.equal(isContextKey('repo/context'), false);
  assert.equal(isContextKey(null), false);
});

test('the relative path strips the virtual root', () => {
  assert.equal(contextRelOf('/context'), '');
  assert.equal(contextRelOf('/context/110_Meetings/notes.md'), '110_Meetings/notes.md');
  assert.equal(contextRelOf('memory/log.md'), null);
});

test('everything under the mount is read-only, the workspace is not', () => {
  assert.equal(isReadOnlyKey('/context'), true);
  assert.equal(isReadOnlyKey('/context/a/b.txt'), true);
  assert.equal(isReadOnlyKey(''), false);
  assert.equal(isReadOnlyKey('context/a.txt'), false);
});

test('URLs route to the matching source and encode their path', () => {
  assert.equal(
    workspaceUrl('a1', 'memory/log.md', 'file'),
    '/api/agents/a1/workspace/file?path=memory%2Flog.md',
  );
  assert.equal(
    workspaceUrl('a1', '/context', 'tree'),
    '/api/agents/a1/context/tree?path=',
  );
  assert.equal(
    workspaceUrl('a1', '/context/My Docs/report.pdf', 'download'),
    '/api/agents/a1/context/download?path=My%20Docs%2Freport.pdf',
  );
  assert.equal(workspaceUrl(null, '/context', 'tree'), null);
});

test('the virtual root is prepended only when a mount exists', () => {
  const items = [{ name: 'memory', type: 'dir' }];
  assert.deepEqual(withContextRoot(items, { enabled: false }), items);
  assert.deepEqual(withContextRoot(items, null), items);

  const withRoot = withContextRoot(items, { enabled: true, hostPath: '/host/sync' });
  assert.equal(withRoot.length, 2);
  assert.equal(withRoot[0].key, CONTEXT_ROOT_KEY);
  assert.equal(withRoot[0].type, 'dir');
  assert.equal(withRoot[0].hostPath, '/host/sync');
  assert.equal(withRoot[1], items[0]);
});

test('the virtual root is never added twice', () => {
  const status = { enabled: true, hostPath: '/host/sync' };
  const once = withContextRoot([{ name: 'memory', type: 'dir' }], status);
  assert.deepEqual(withContextRoot(once, status), once);
});

test('child keys inherit their source from the parent', () => {
  assert.equal(childKey('', { name: 'memory' }), 'memory');
  assert.equal(childKey('memory', { name: 'log.md' }), 'memory/log.md');
  assert.equal(childKey('/context', { name: 'docs' }), '/context/docs');
  assert.equal(childKey('/context/docs', { name: 'note.md' }), '/context/docs/note.md');
  // An item carrying its own key (the virtual root) wins over derivation.
  assert.equal(childKey('', contextRootItem(null)), CONTEXT_ROOT_KEY);
});
