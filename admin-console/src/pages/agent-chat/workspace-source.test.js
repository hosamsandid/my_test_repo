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
  contextMounts,
  mountForKey,
  sameWritableSource,
  writeApiBase,
  apiRelOf,
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

test('the zip kind builds a per-directory workspace download URL (#2318)', () => {
  assert.equal(
    workspaceUrl('a1', 'repo/src', 'zip'),
    '/api/agents/a1/workspace/zip?path=repo%2Fsrc',
  );
  // A directory name with spaces / non-ASCII stays encoded in the path (AC18).
  assert.equal(
    workspaceUrl('a1', 'Ordner Ümläute', 'zip'),
    '/api/agents/a1/workspace/zip?path=Ordner%20%C3%9Cml%C3%A4ute',
  );
  assert.equal(workspaceUrl(null, 'repo/src', 'zip'), null);
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

test('one root per folder is prepended for a multi-folder mount (#1290 AC3)', () => {
  const items = [{ name: 'memory', type: 'dir' }];
  const status = {
    enabled: true,
    mounts: [
      { name: 'Requirements', key: '/context/requirements', hostPath: '/host/req', readWrite: false },
      { name: 'Design', key: '/context/design', hostPath: '/host/design', readWrite: true },
    ],
  };
  const withRoots = withContextRoot(items, status);
  assert.equal(withRoots.length, 3);
  assert.equal(withRoots[0].key, '/context/requirements');
  assert.equal(withRoots[0].name, 'Requirements');
  assert.equal(withRoots[0].readWrite, false);
  assert.equal(withRoots[1].key, '/context/design');
  assert.equal(withRoots[1].name, 'Design');
  assert.equal(withRoots[1].readWrite, true);
  assert.equal(withRoots[2], items[0]);
});

test('multi-folder roots route each to their own subtree via the slug', () => {
  // A /context/<slug> key strips to `<slug>` for the browse API — no per-folder
  // branch needed on the server.
  assert.equal(contextRelOf('/context/requirements'), 'requirements');
  assert.equal(contextRelOf('/context/design/spec.pdf'), 'design/spec.pdf');
  assert.equal(
    workspaceUrl('a1', '/context/requirements', 'tree'),
    '/api/agents/a1/context/tree?path=requirements',
  );
  assert.equal(isReadOnlyKey('/context/design/spec.pdf'), true);
});

test('multi-folder roots are never added twice (idempotent)', () => {
  const status = {
    enabled: true,
    mounts: [
      { name: 'A', key: '/context/a', hostPath: '/host/a' },
      { name: 'B', key: '/context/b', hostPath: '/host/b' },
    ],
  };
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

/* ─── Read-write mount awareness (write support) ────────────────────────── */

const RO_STATUS = {
  enabled: true,
  mounts: [{ key: '/context', hostPath: '/host/docs', readWrite: false }],
};
const RW_STATUS = {
  enabled: true,
  mounts: [{ key: '/context', hostPath: '/host/docs', readWrite: true }],
};
const MULTI_STATUS = {
  enabled: true,
  mounts: [
    { key: '/context/read', hostPath: '/host/ro', readWrite: false },
    { key: '/context/edit', hostPath: '/host/rw', readWrite: true },
  ],
};

test('isReadOnlyKey is mount-aware: RW mount keys are writable', () => {
  // Workspace keys are always writable.
  assert.equal(isReadOnlyKey('memory/log.md', RW_STATUS), false);
  // A read-write mount → its keys are writable.
  assert.equal(isReadOnlyKey('/context', RW_STATUS), false);
  assert.equal(isReadOnlyKey('/context/a/b.txt', RW_STATUS), false);
  // A read-only mount → read-only.
  assert.equal(isReadOnlyKey('/context/a.txt', RO_STATUS), true);
  // Fail-closed: no status → a context key is read-only.
  assert.equal(isReadOnlyKey('/context/a.txt'), true);
});

test('isReadOnlyKey resolves per-folder in a multi-folder set', () => {
  assert.equal(isReadOnlyKey('/context/read/x.txt', MULTI_STATUS), true);
  assert.equal(isReadOnlyKey('/context/edit/x.txt', MULTI_STATUS), false);
});

test('contextMounts falls back to legacy top-level fields', () => {
  const legacy = { enabled: true, hostPath: '/host/legacy', readWrite: true };
  assert.deepEqual(contextMounts(legacy), [
    { key: '/context', readWrite: true, hostPath: '/host/legacy' },
  ]);
  assert.deepEqual(contextMounts({ enabled: false }), []);
  assert.deepEqual(contextMounts(null), []);
});

test('mountForKey finds the owning mount, null for workspace/unknown', () => {
  assert.equal(mountForKey('memory/log.md', RW_STATUS), null);
  assert.equal(mountForKey('/context/edit/a.txt', MULTI_STATUS).key, '/context/edit');
  assert.equal(mountForKey('/context/read', MULTI_STATUS).key, '/context/read');
});

test('sameWritableSource gates drag-move to one filesystem', () => {
  // Two workspace keys → always allowed.
  assert.equal(sameWritableSource('a/x.txt', 'b', RW_STATUS), true);
  // Same RW mount → allowed.
  assert.equal(sameWritableSource('/context/a.txt', '/context/sub', RW_STATUS), true);
  // Same RO mount → refused.
  assert.equal(sameWritableSource('/context/a.txt', '/context/sub', RO_STATUS), false);
  // Cross-source (workspace ↔ context) → refused.
  assert.equal(sameWritableSource('a/x.txt', '/context/sub', RW_STATUS), false);
  // Two different mounts → refused even if both writable.
  assert.equal(sameWritableSource('/context/read/x', '/context/edit', MULTI_STATUS), false);
});

test('writeApiBase + apiRelOf route to the right endpoint and relativise', () => {
  assert.equal(writeApiBase('a1', 'memory/log.md'), '/api/agents/a1/workspace');
  assert.equal(writeApiBase('a1', '/context/docs/n.md'), '/api/agents/a1/context');
  // Workspace keys pass through unchanged; context keys drop the /context prefix.
  assert.equal(apiRelOf('memory/log.md'), 'memory/log.md');
  assert.equal(apiRelOf('/context/docs/n.md'), 'docs/n.md');
  assert.equal(apiRelOf('/context'), '');
  assert.equal(apiRelOf('/context/edit/a.txt'), 'edit/a.txt');
});
