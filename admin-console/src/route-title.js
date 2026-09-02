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
  '/agents': 'Agents',
  '/flows': 'Flows',
  '/role-templates': 'Agent Templates',
  '/skills': 'Skills',
  '/knowledge': 'Knowledge',
  '/models': 'Model Providers',
  '/ssh-keys': 'SSH Keys',
  '/github-tokens': 'GitHub Tokens',
  '/my-credentials': 'My Credentials',
  '/mcp': 'MCP Servers',
  '/environments': 'Working Environments',
  '/github-events': 'GitHub Event Log',
  '/teams': 'Access',
  '/users': 'Users',
  '/token-usage': 'Token Usage',
  '/plugins': 'Plugins',
  '/maintenance-mode': 'Maintenance Mode',
  '/create': 'Create',
  '/quickstart': 'One assistant',
  '/team-setup': 'Agent Team Wizard',
  '/wizard/team': 'Agent Team Wizard',
  '/orchestrator-wizard': 'Orchestrator Wizard',
  '/about': 'About',
};

// Resolve a pathname to a human page name, handling the dynamic child routes the
// same way the breadcrumb does: `/plugins/:id/view` carries its id so two plugin
// tabs stay distinguishable, while `/chats/:agentId` deliberately does not (#1921
// — the selected agent is already highlighted in that page's own left rail).
// Returns null for a route we don't recognise, so the caller can fall back cleanly.
export function pageNameForPath(pathname) {
  if (!pathname || typeof pathname !== 'string') return null;
  if (ROUTE_TITLES[pathname]) return ROUTE_TITLES[pathname];
  // "/" redirects to /chats — label the tab for the destination, not the raw slash.
  if (pathname === '/') return ROUTE_TITLES['/chats'];
  // `/chats/:agentId` reads plainly "Agent Chat" (#1921) — same as the
  // breadcrumb/header, which dropped the agent id because the selected agent is
  // already highlighted in the page's left-rail list.
  if (pathname.startsWith('/chats/')) return ROUTE_TITLES['/chats'];
  const pluginView = pathname.match(/^\/plugins\/([^/]+)\/view$/);
  if (pluginView) return `Plugins / ${pluginView[1]}`;
  return null;
}

// The full document.title for a pathname: "<Page> · Agent Studio", or just the
// app name for an unknown route (login screen, wizard sub-steps, 404) — we never
// surface a raw path in the tab.
export function documentTitleForPath(pathname) {
  const name = pageNameForPath(pathname);
  return name ? `${name} · ${APP_NAME}` : APP_NAME;
}
