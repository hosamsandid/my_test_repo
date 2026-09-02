// Route → human-readable label map, shared between the Shell breadcrumb bar and
// the Helper Chat context (#1735), which sends the current route's friendly
// label to the assistant so it can ground its answer on the page you are on.
// Single source of truth — do not duplicate this map.

export const BREADCRUMBS = {
  '/create':       'Create',
  '/quickstart':   'One assistant',
  '/team-setup':   'Agent Team Wizard',
  '/agents':       'Agents',
  '/flows':        'Flows',
  '/knowledge':    'Knowledge',
  '/chats':        'Agent Chat',
  '/environments': 'Working Environments',
  '/ssh-keys':     'SSH Keys',
  '/github-tokens': 'GitHub Tokens',
  '/my-credentials': 'My Credentials',
  '/skills':       'Skills Registry',
  '/role-templates': 'Agent Templates',
  '/github-events': 'GitHub Event Log',
  '/token-usage':  'Token Usage',
  '/models':       'Model Providers',
  '/mcp':          'MCP Servers',
  '/plugins':      'Plugins',
  '/teams':        'Access',
  '/users':        'Users',
  '/orchestrator-wizard': 'Orchestrator Wizard',
  '/maintenance-mode': 'Maintenance Mode',
};

// Resolve a pathname to its breadcrumb label, handling the two dynamic route
// shapes (Agent-Chat room, plugin viewer). Falls back to the raw pathname.
export function breadcrumbFor(pathname) {
  if (BREADCRUMBS[pathname]) return BREADCRUMBS[pathname];
  if (pathname.startsWith('/chats/')) {
    const id = pathname.slice('/chats/'.length);
    return `Agent Chat / ${id}`;
  }
  const pluginView = pathname.match(/^\/plugins\/([^/]+)\/view$/);
  if (pluginView) return `Plugins / ${pluginView[1]}`;
  return pathname;
}
