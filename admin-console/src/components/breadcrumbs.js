// Route → human-readable label map, shared between the Shell breadcrumb bar and
// the Helper Chat context (#1735), which sends the current route's friendly
// label to the assistant so it can ground its answer on the page you are on.
// Single source of truth — do not duplicate this map.

export const BREADCRUMBS = {
  '/create':       'Create',
  '/quickstart':   'One assistant',
  '/team-setup':   'Agent Team Wizard',
  // The `/wizard/team` alias renders the identical page (App.jsx) — without its
  // own entry the breadcrumb and the Helper-Chat `currentRouteLabel` fell back to
  // the raw path there, so the assistant was told the user is on "/wizard/team"
  // (#1891).
  '/wizard/team':  'Agent Team Wizard',
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
  '/maintenance-mode': 'Maintenance Mode',
  '/about':        'About',
};

// Resolve a pathname to its breadcrumb label, handling the two dynamic route
// shapes (Agent-Chat room, plugin viewer). Falls back to the raw pathname.
export function breadcrumbFor(pathname) {
  if (BREADCRUMBS[pathname]) return BREADCRUMBS[pathname];
  // `/chats/:agentId` reads plainly "Agent Chat" (#1921): which agent is
  // selected is already shown — highlighted — in the page's own left-rail list,
  // so repeating the id in the header only added noise. Reuse the static label
  // so the two forms of the route can never drift apart.
  if (pathname.startsWith('/chats/')) return BREADCRUMBS['/chats'];
  const pluginView = pathname.match(/^\/plugins\/([^/]+)\/view$/);
  if (pluginView) return `Plugins / ${pluginView[1]}`;
  return pathname;
}
