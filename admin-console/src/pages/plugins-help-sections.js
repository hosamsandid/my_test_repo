// ─── Plugins help chapters (#1986, epic #1981) ───────────────────────────────
//
// `help-topics/plugins.md` (E5 #1879) is the longest topic on any admin page —
// it carries the plain-language install/grant story AND the whole build-a-plugin
// reference, because the same ticket removed the standalone `/plugin-system`
// page outright. Behind a single page-level "?" that meant a reader standing in
// the install confirm, deciding whether to hand a broker the host container
// runtime, opened a document whose first screen is "what a plugin is".
//
// The topic is now eight headed chapters and each surface opens the one written
// for it. A chapter is addressed by the slug of its heading (see sectionSlug in
// context/page-help-view.js), so this file is the one place the slugs are
// written down — every call site imports from here, and
// plugins-help-extraction.test.js asserts each value is really a heading in the
// topic.
//
// A slug that no longer matches is not a crash: the panel just opens the topic
// from the top. That is also the deliberate behaviour for a surface that is not
// rendered at all — the install/uninstall dialogs only exist for a System Admin,
// and their "?" comes and goes with them.
//
// It lives flat beside the page's other pure modules (plugin-registry-view.js,
// plugin-grant-view.js, plugin-team-assign-view.js) rather than in the
// `pages/plugins/` directory the ticket's Scope-in names — that directory does
// not exist, and creating it for ONE file while the page's three other pure
// modules stay flat is the odd-one-out the #1990/#1993/#1994/#1989 tickets all
// declined. AC3 only requires the module to export one slug per chapter.

export const PLUGINS_HELP_SECTIONS = {
  // 1 — what it is, the use cases, and platform-plugin vs Claude Code agent plugin
  what: 'what-a-plugin-is',
  // 2 — the split the page is built around: who installs, who grants, who inherits
  installVsGrant: 'install-and-grant-are-two-different-steps',
  // 3 — the closed capability enum, the risk colouring, the `platforms` gate
  capabilities: 'capabilities-and-the-platform-gate',
  // 4 — team vs agent scope, and reading the quota per scope
  scope: 'scope-granularity-and-quota',
  // 5 — the live additive sync, and the other half: what uninstalling leaves behind
  activating: 'what-activating-does-and-what-uninstalling-undoes',
  // 6 — plugins that serve their own embedded pages, and the global-UI opt-in
  ui: 'plugins-with-their-own-ui',
  // 7 — the PluginTeamAssign control on an installed card
  teamAssignment: 'assigning-a-plugin-to-a-team-on-this-page',
  // 8 — broker+CLI internals, plugin.json, the broker's obligations, the SDK
  deepDive: 'deep-dive-how-a-plugin-works-and-how-to-build-one',
};

export default PLUGINS_HELP_SECTIONS;
