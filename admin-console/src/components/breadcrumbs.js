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
  '/flow-control': 'Flow Control',
  '/knowledge':    'Knowledge',
  '/chats':        'Agent Chat',
  // `/environments` carries no entry any more (#2170): the page is gone and
  // the route is a bare redirect, exactly like `/teams` below.
  '/environment-templates': 'Environment Templates',
  '/ssh-keys':     'SSH Keys',
  '/github-tokens': 'GitHub Tokens',
  '/plugin-tokens': 'Plugin Tokens',
  '/skills':       'Skills Registry',
  '/role-templates': 'Agent Templates',
  '/github-events': 'GitHub Event Log',
  '/token-usage':  'Token Usage',
  '/models':       'Model Providers',
  '/mcp':          'MCP Servers',
  '/plugins':      'Plugins',
  // `/teams` carries no entry any more: #2085 retired the page and the route is
  // a redirect to `/users`, which is the single **Administration** surface.
  '/users':        'Administration',
  '/maintenance-mode': 'Maintenance Mode',
  '/about':        'About',
};

// Label for a path that matches no route (#2615). App.jsx renders the NotFound
// page for the same paths via its `path="*"` catch-all, so the header and the
// content area agree instead of the header echoing the raw pathname.
export const NOT_FOUND_LABEL = 'Page not found';

// React Router matches case-insensitively and ignores a trailing slash, so
// `/SSH-Keys/` renders the SSH Keys page — resolve the label the same way or
// such a URL would show the right page under a "Page not found" header.
function normalize(pathname) {
  const p = String(pathname || '/').replace(/\/+$/, '') || '/';
  return p.toLowerCase();
}

// Resolve a pathname to its breadcrumb label, handling the dynamic route
// shapes (Agent-Chat room, plugin viewer). A path that matches no route
// reads NOT_FOUND_LABEL — never the raw pathname (#2615). `pluginTitles`
// ({ [pluginId]: displayName }, #2650) names a plugin viewer by its display
// name; an id without an entry still reads as the raw id.
export function breadcrumbFor(pathname, pluginTitles = {}) {
  const p = normalize(pathname);
  if (BREADCRUMBS[p]) return BREADCRUMBS[p];
  // "/" redirects to /chats — label it for the destination (as route-title.js
  // does) so the landing frame never reads "Page not found". Other redirect-only
  // aliases stay unnamed here on purpose (the removal guards forbid it); they
  // render for a single frame before <Navigate> fires.
  if (p === '/') return BREADCRUMBS['/chats'];
  // `/chats/:agentId` reads plainly "Agent Chat" (#1921): which agent is
  // selected is already shown — highlighted — in the page's own left-rail list,
  // so repeating the id in the header only added noise. Reuse the static label
  // so the two forms of the route can never drift apart.
  if (/^\/chats\/[^/]+$/.test(p)) return BREADCRUMBS['/chats'];
  // Match on the original casing so the plugin id is shown as typed.
  const pluginView = String(pathname || '').replace(/\/+$/, '').match(/^\/plugins\/([^/]+)\/view$/i);
  if (pluginView) return `Plugins / ${(pluginTitles && pluginTitles[pluginView[1]]) || pluginView[1]}`;
  return NOT_FOUND_LABEL;
}
