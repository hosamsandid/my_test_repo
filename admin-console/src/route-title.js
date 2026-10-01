// Pure, framework-free resolver for the browser tab title (document.title).
//
// Every console page rendered the static index.html `<title>Agent Studio</title>`
// unchanged, so a user with several tabs open (Teams, Token Usage, Skills, …)
// saw an identical, uninformative "Agent Studio" on each — the browser tab bar,
// the history menu and a saved bookmark all gave no hint which page was which.
// This maps the active route to a human page name (mirroring the Shell sidebar
// labels / breadcrumb names the user already sees, so the naming stays
// consistent with the in-app navigation) and produces "<Page> · Agent Studio".
//
// Kept pure + React-free per the #651 convention: the resolution + fallback are
// unit-tested here, and App.jsx just runs it in a one-line useEffect. When a
// route is unknown the title falls back to the bare app name — never a raw
// pathname.

export const APP_NAME = 'Agent Studio';

// Page names mirror the Shell sidebar labels (Shell.jsx NAV_GROUPS) and the
// breadcrumb map so the tab title reads the same word the user clicked in the
// nav. Keep this in step with the sidebar when a route is renamed or added.
export const ROUTE_TITLES = {
  '/chats': 'Agent Chat',
  '/flows': 'Flows',
  '/flow-control': 'Flow Control',
  '/role-templates': 'Agent Templates',
  '/skills': 'Skills',
  '/knowledge': 'Knowledge',
  '/models': 'Model Providers',
  '/ssh-keys': 'SSH Keys',
  '/github-tokens': 'GitHub Tokens',
  '/plugin-tokens': 'Plugin Tokens',
  '/mcp': 'MCP Servers',
  // No `/environments`: #2170 retired the page and made the route a redirect.
  '/environment-templates': 'Environment Templates',
  '/github-events': 'GitHub Event Log',
  // No `/teams`: #2085 retired the Access page and made the route a redirect.
  '/users': 'Administration',
  '/token-usage': 'Token Usage',
  '/plugins': 'Plugins',
  '/maintenance-mode': 'Maintenance Mode',
  '/create': 'Create',
  '/quickstart': 'One assistant',
  '/team-setup': 'Agent Team Wizard',
  '/wizard/team': 'Agent Team Wizard',
  '/about': 'About',
};

// Own keys only: a plain-object map would resolve ids like `constructor` or
// `toString` to built-in functions and print their source (#2650).
function pluginTitleOf(pluginTitles, id) {
  return (pluginTitles && Object.hasOwn(pluginTitles, id) && pluginTitles[id]) || id;
}

// Resolve a pathname to a human page name, handling the dynamic child routes the
// same way the breadcrumb does: `/plugins/:id/view` carries its id so two plugin
// tabs stay distinguishable, while `/chats/:agentId` deliberately does not (#1921
// — the selected agent is already highlighted in that page's own left rail).
// Returns null for a route we don't recognise, so the caller can fall back cleanly.
// `pluginTitles` ({ [pluginId]: displayName }, #2650) names a plugin viewer by
// its display name; an id without an entry still reads as the raw id.
export function pageNameForPath(pathname, pluginTitles = {}) {
  if (!pathname || typeof pathname !== 'string') return null;
  // React Router ignores a trailing slash, so `/plugins/x/view/` renders the
  // same page as `/plugins/x/view` — resolve the title the same way (#2650).
  pathname = pathname.replace(/(.)\/+$/, '$1');
  // React Router also matches static segments case-insensitively (`caseSensitive`
  // defaults to false), so `/Chats` or `/USERS` render the page — compare the
  // static parts lowercased (#2697). Only the plugin id below keeps its case,
  // since it is a route param and the display-name lookup is keyed by the id.
  const lower = pathname.toLowerCase();
  if (ROUTE_TITLES[lower]) return ROUTE_TITLES[lower];
  // "/" redirects to /chats — label the tab for the destination, not the raw slash.
  if (pathname === '/') return ROUTE_TITLES['/chats'];
  // `/chats/:agentId` reads plainly "Agent Chat" (#1921) — same as the
  // breadcrumb/header, which dropped the agent id because the selected agent is
  // already highlighted in the page's left-rail list.
  if (lower.startsWith('/chats/')) return ROUTE_TITLES['/chats'];
  const pluginView = pathname.match(/^\/plugins\/([^/]+)\/view$/i);
  if (pluginView) return `Plugins / ${pluginTitleOf(pluginTitles, pluginView[1])}`;
  return null;
}

// The full document.title for a pathname: "<Page> · Agent Studio", or just the
// app name for an unknown route (login screen, wizard sub-steps, 404) — we never
// surface a raw path in the tab.
export function documentTitleForPath(pathname, pluginTitles = {}) {
  const name = pageNameForPath(pathname, pluginTitles);
  return name ? `${name} · ${APP_NAME}` : APP_NAME;
}
