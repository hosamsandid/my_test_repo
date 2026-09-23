// Pure, framework-free helpers for the Shell sidebar navigation (#1595).
//
// The nav is re-cut by user task into collapsible accordion groups plus small
// always-visible bottom clusters. Icons + the section data live in Shell.jsx
// (they need lucide components); everything decidable — role gating, active-route
// matching, and the per-user collapse state — lives here so it can be unit-tested
// (the #651 "pure logic in a sibling module" convention; JSX stays uncovered).

// A single item is visible when the caller clears its role gate. Mirrors the
// gating that used to be inline in Shell.jsx: `adminOnly` → System Admin only,
// `credAdmin` → System Admin or Team Admin (credential self-service), else all.
export function itemVisible(item, { admin, canSeeCreds }) {
  if (item.adminOnly) return !!admin;
  if (item.credAdmin) return !!canSeeCreds;
  return true;
}

// Filter an item list by the caller's role gate.
export function filterItems(items, gate) {
  return (items || []).filter(item => itemVisible(item, gate));
}

// Credential-page consolidation (#2360, behind AEE_RESOURCE_ACCESS_V2). Once the
// unified resource-access model is on, the personal-credential self-service page
// (`/my-credentials`) is DISSOLVED: its function folds into the per-type pages,
// which open to every authenticated user (a plain member manages their own
// personal keys/tokens there, row-filtered server-side by `visibleCredential`).
// So under v2 this drops the My Credentials entry and strips the `credAdmin` gate
// from SSH Keys / GitHub Tokens. Off the flag it is a no-op — byte-identical to
// the static nav. (`/models` stays gated for now; providers open separately.)
// Pure so it can be unit-tested alongside the other nav helpers.
export function consolidateCredentialNav(sections, { v2 = false } = {}) {
  if (!v2) return sections || [];
  const OPEN = new Set(['/ssh-keys', '/github-tokens']);
  return (sections || []).map(section => ({
    ...section,
    items: (section.items || [])
      .filter(item => item.path !== '/my-credentials')
      .map(item => (OPEN.has(item.path) && item.credAdmin ? { ...item, credAdmin: false } : item)),
  }));
}

// Apply the role gate to a list of { key, items } sections and drop any that end
// up empty — so a group (or bottom cluster) with no visible items for the current
// role renders no header at all (AC9, "no empty groups").
export function filterSections(sections, gate) {
  return (sections || [])
    .map(section => ({ ...section, items: filterItems(section.items, gate) }))
    .filter(section => section.items.length > 0);
}

// Whether a route path is "active" for the given location — exact match or a
// nested child route (e.g. /chats/foo activates /chats). Shared by the active-
// group lookup and the button active styling so they can never disagree.
export function isPathActive(pathname, path) {
  return pathname === path || pathname.startsWith(path + '/');
}

// Among a set of candidate nav paths, the single most specific (longest) one that
// is active for the current location, else null. This disambiguates overlapping
// prefixes: a plugin viewer route /plugins/foo/view matches both the admin
// registry item /plugins (prefix) and its own exact entry — the exact, longer
// path must win, so clicking a plugin never lights up (and auto-expands) the
// Connections group's Plugins registry item (#1595 follow-up).
export function mostSpecificActivePath(paths, pathname) {
  let best = null;
  for (const path of paths || []) {
    if (isPathActive(pathname, path) && (best === null || path.length > best.length)) {
      best = path;
    }
  }
  return best;
}

// The key of the group whose items contain the active route, else null (a route
// that lives in the ungrouped top or a bottom cluster yields null — nothing to
// auto-expand). Resolution is specificity-aware: the most specific matching item
// across ALL groups wins, so a /plugins/:id/view route resolves to the dynamic
// plugins group rather than the Connections group that merely holds /plugins.
export function activeGroupKey(groups, pathname) {
  const allPaths = (groups || []).flatMap(group => (group.items || []).map(item => item.path));
  const best = mostSpecificActivePath(allPaths, pathname);
  if (best === null) return null;
  for (const group of groups || []) {
    if ((group.items || []).some(item => item.path === best)) return group.key;
  }
  return null;
}

// The default collapse map: every group collapsed except the one that should be
// open on a first-ever load (Agent Setup). `true` === collapsed.
export function defaultCollapsed(groupKeys, expandedKey) {
  const out = {};
  for (const key of groupKeys || []) out[key] = key !== expandedKey;
  return out;
}

// Reconcile a persisted collapse map with the current set of group keys: unknown
// or malformed stored values fall back to the default, and a newly-introduced
// group gets a sane default rather than undefined. Keeps only boolean entries.
export function mergeCollapsed(stored, groupKeys, expandedKey) {
  const base = defaultCollapsed(groupKeys, expandedKey);
  if (!stored || typeof stored !== 'object') return base;
  const out = { ...base };
  for (const key of groupKeys || []) {
    if (typeof stored[key] === 'boolean') out[key] = stored[key];
  }
  return out;
}
