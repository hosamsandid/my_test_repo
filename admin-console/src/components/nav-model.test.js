import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  itemVisible,
  filterItems,
  filterSections,
  isPathActive,
  mostSpecificActivePath,
  activeGroupKey,
  defaultCollapsed,
  mergeCollapsed,
  consolidateCredentialNav,
} from './nav-model.js';

const ADMIN = { admin: true, canSeeCreds: true };
const TEAM_ADMIN = { admin: false, canSeeCreds: true };
const MEMBER = { admin: false, canSeeCreds: false };

test('itemVisible honours adminOnly / credAdmin / open gates', () => {
  assert.equal(itemVisible({ path: '/mcp', adminOnly: true }, ADMIN), true);
  assert.equal(itemVisible({ path: '/mcp', adminOnly: true }, TEAM_ADMIN), false);
  assert.equal(itemVisible({ path: '/mcp', adminOnly: true }, MEMBER), false);

  assert.equal(itemVisible({ path: '/ssh-keys', credAdmin: true }, ADMIN), true);
  assert.equal(itemVisible({ path: '/ssh-keys', credAdmin: true }, TEAM_ADMIN), true);
  assert.equal(itemVisible({ path: '/ssh-keys', credAdmin: true }, MEMBER), false);

  // open item — visible to everyone incl. a plain member
  assert.equal(itemVisible({ path: '/agents' }, MEMBER), true);
});

test('filterItems drops gated-out items', () => {
  const items = [
    { path: '/agents' },
    { path: '/mcp', adminOnly: true },
    { path: '/ssh-keys', credAdmin: true },
  ];
  assert.deepEqual(filterItems(items, MEMBER).map(i => i.path), ['/agents']);
  assert.deepEqual(filterItems(items, TEAM_ADMIN).map(i => i.path), ['/agents', '/ssh-keys']);
  assert.deepEqual(filterItems(items, ADMIN).map(i => i.path), ['/agents', '/mcp', '/ssh-keys']);
});

test('filterSections removes sections that become empty for a role (AC9)', () => {
  const sections = [
    { key: 'insights', items: [{ path: '/token-usage', adminOnly: true }, { path: '/github-events' }] },
    { key: 'admin-only-group', items: [{ path: '/maintenance-mode', adminOnly: true }] },
  ];
  // Member: token-usage + maintenance hidden → insights keeps github-events, the
  // admin-only group vanishes entirely (no empty header).
  const member = filterSections(sections, MEMBER);
  assert.equal(member.length, 1);
  assert.equal(member[0].key, 'insights');
  assert.deepEqual(member[0].items.map(i => i.path), ['/github-events']);

  // Admin sees both groups fully.
  const admin = filterSections(sections, ADMIN);
  assert.equal(admin.length, 2);
});

test('isPathActive matches exact and nested child routes', () => {
  assert.equal(isPathActive('/chats', '/chats'), true);
  assert.equal(isPathActive('/chats/agent-1', '/chats'), true);
  assert.equal(isPathActive('/chatsomething', '/chats'), false);
  assert.equal(isPathActive('/agents', '/agent'), false);
});

test('mostSpecificActivePath picks the longest matching path, else null', () => {
  const paths = ['/plugins', '/plugins/github-issues/view', '/agents'];
  // A plugin viewer route matches both /plugins (prefix) and its own exact entry
  // — the longer, exact path wins.
  assert.equal(
    mostSpecificActivePath(paths, '/plugins/github-issues/view'),
    '/plugins/github-issues/view',
  );
  // The bare registry route resolves only to /plugins.
  assert.equal(mostSpecificActivePath(paths, '/plugins'), '/plugins');
  // Nothing matches → null.
  assert.equal(mostSpecificActivePath(paths, '/knowledge'), null);
});

test('activeGroupKey does not mis-expand a prefix group under a more specific route', () => {
  // The real regression (#1595 follow-up): the Connections group holds the admin
  // /plugins registry item; the dynamic plugins group holds /plugins/:id/view.
  // Clicking a plugin must resolve to the plugins group, NOT auto-expand
  // Connections via the /plugins prefix.
  const groups = [
    { key: 'connections', items: [{ path: '/environments' }, { path: '/plugins' }] },
    { key: 'plugins', items: [{ path: '/plugins/github-issues/view' }] },
  ];
  assert.equal(activeGroupKey(groups, '/plugins/github-issues/view'), 'plugins');
  // The registry page itself still resolves to Connections.
  assert.equal(activeGroupKey(groups, '/plugins'), 'connections');
});

test('activeGroupKey finds the containing group, else null', () => {
  const groups = [
    { key: 'agent-setup', items: [{ path: '/agents' }, { path: '/flows' }] },
    { key: 'connections', items: [{ path: '/environments' }, { path: '/ssh-keys' }] },
  ];
  assert.equal(activeGroupKey(groups, '/flows'), 'agent-setup');
  assert.equal(activeGroupKey(groups, '/ssh-keys'), 'connections');
  assert.equal(activeGroupKey(groups, '/environments/new'), 'connections');
  // A top / bottom-cluster route belongs to no group.
  assert.equal(activeGroupKey(groups, '/chats'), null);
  assert.equal(activeGroupKey(groups, '/my-credentials'), null);
});

test('activeGroupKey resolves the dynamic plugins group on a /plugins/:id/view route', () => {
  // The plugins group is appended at runtime; a plugin view route must auto-
  // expand it exactly like a static group (#1595 follow-up).
  const groups = [
    { key: 'agent-setup', items: [{ path: '/agents' }] },
    { key: 'plugins', items: [
      { path: '/plugins/patterns-catalog/view' },
      { path: '/plugins/netzplan/view' },
    ]},
  ];
  assert.equal(activeGroupKey(groups, '/plugins/netzplan/view'), 'plugins');
  // The admin Plugins registry page (/plugins) is NOT a plugin view entry.
  assert.equal(activeGroupKey(groups, '/plugins'), null);
});

test('mergeCollapsed carries the dynamic plugins key — collapsed by default, persisted when stored', () => {
  // Shell passes ALL_GROUP_KEYS = [...NAV_GROUP_KEYS, 'plugins'] so the plugins
  // group participates in the per-user collapse map.
  const keys = ['agent-setup', 'connections', 'insights', 'administration', 'plugins'];

  // No stored state → plugins defaults collapsed (so a full plugin list never
  // blows up the sidebar on first load).
  assert.equal(mergeCollapsed(null, keys, 'agent-setup').plugins, true);

  // A stored expand is honoured across reloads.
  assert.equal(mergeCollapsed({ plugins: false }, keys, 'agent-setup').plugins, false);
});

test('defaultCollapsed collapses all but the expanded key', () => {
  const keys = ['agent-setup', 'connections', 'insights', 'administration'];
  assert.deepEqual(defaultCollapsed(keys, 'agent-setup'), {
    'agent-setup': false,
    connections: true,
    insights: true,
    administration: true,
  });
});

test('mergeCollapsed reconciles persisted state with current keys', () => {
  const keys = ['agent-setup', 'connections', 'insights', 'administration'];

  // No stored state → defaults.
  assert.deepEqual(
    mergeCollapsed(null, keys, 'agent-setup'),
    defaultCollapsed(keys, 'agent-setup'),
  );

  // Stored honoured where present; a newly-added group ('administration') gets its default.
  const stored = { 'agent-setup': true, connections: false, insights: true };
  assert.deepEqual(mergeCollapsed(stored, keys, 'agent-setup'), {
    'agent-setup': true,
    connections: false,
    insights: true,
    administration: true, // default (collapsed) — was absent from stored
  });

  // Non-boolean junk is ignored, falling back to the default.
  assert.deepEqual(mergeCollapsed({ connections: 'yes' }, keys, 'agent-setup'), {
    'agent-setup': false,
    connections: true,
    insights: true,
    administration: true,
  });

  // Malformed stored value → all defaults.
  assert.deepEqual(mergeCollapsed('nope', keys, 'agent-setup'), defaultCollapsed(keys, 'agent-setup'));
});

test('consolidateCredentialNav: off the flag is a no-op (byte-identical)', () => {
  const sections = [
    { key: 'connections', items: [
      { path: '/models', credAdmin: true },
      { path: '/ssh-keys', credAdmin: true },
      { path: '/github-tokens', credAdmin: true },
      { path: '/my-credentials' },
      { path: '/mcp', adminOnly: true },
    ]},
  ];
  assert.deepEqual(consolidateCredentialNav(sections, { v2: false }), sections);
  assert.deepEqual(consolidateCredentialNav(sections, {}), sections);
});

test('consolidateCredentialNav: v2 drops My Credentials and opens SSH/GitHub (models stays gated)', () => {
  const sections = [
    { key: 'connections', items: [
      { path: '/models', credAdmin: true },
      { path: '/ssh-keys', credAdmin: true },
      { path: '/github-tokens', credAdmin: true },
      { path: '/my-credentials' },
      { path: '/mcp', adminOnly: true },
    ]},
  ];
  const out = consolidateCredentialNav(sections, { v2: true });
  const items = out[0].items;
  assert.ok(!items.some(i => i.path === '/my-credentials'), 'My Credentials dissolved');
  assert.equal(items.find(i => i.path === '/ssh-keys').credAdmin, false, 'SSH Keys opened');
  assert.equal(items.find(i => i.path === '/github-tokens').credAdmin, false, 'GitHub Tokens opened');
  assert.equal(items.find(i => i.path === '/models').credAdmin, true, 'Model Providers stays gated');
  assert.equal(items.find(i => i.path === '/mcp').adminOnly, true, 'other gates untouched');
  // A plain member now sees SSH Keys / GitHub Tokens (open), not My Credentials.
  const visible = filterItems(out[0].items, MEMBER).map(i => i.path);
  assert.deepEqual(visible, ['/ssh-keys', '/github-tokens']);
});
