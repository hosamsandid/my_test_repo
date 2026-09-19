// ─── Agent Chat help chapters (#1972) ────────────────────────────────────────
//
// The "?" next to each Agent Chat surface opens the /chats help topic AT the
// chapter that explains that surface. A chapter is addressed by the slug of its
// heading (see sectionSlug in context/page-help-view.js), so this file is the
// one place the slugs are written down — every call site imports from here, and
// agent-chat-help-extraction.test.js asserts each value is really a heading in
// help-topics/agent-chat.md.
//
// A slug that no longer matches is not a crash: the panel just opens the topic
// from the top. That is also the deliberate behaviour for a surface a given
// agent does not have (no context folders, no slash commands, no team) — the
// chapter documents the function generally and the "?" is never empty.

export const AGENT_CHAT_HELP_SECTIONS = {
  // 1 — what the page is
  page: 'what-the-agent-chat-page-is',
  // 2 — the left rail
  agentList: 'the-agent-list',
  // 3 — the chat header
  header: 'the-chat-header',
  // 4 — the composer (and the loop launcher's own chapter)
  composer: 'the-message-composer',
  loops: 'a-loop-is-a-run-not-a-subscription',
  // 5 — the right rail
  rightRail: 'the-right-rail',
  sessions: 'sessions-watching-a-run',
  sessionLog: 'the-session-log-and-the-todo-panel',
  workspace: 'workspace-browsing-the-files',
  // 6 — the panels that already had chapters
  triggers: 'triggers-when-the-agent-wakes-on-its-own',
  // the plugin-event form's two filters (Which event / Only when…)
  pluginEvent: 'plugin-event-which-event-vs-only-when',
  outcomes: 'outcomes-what-the-agent-signals-when-a-run-ends',
  knowledge: 'knowledge-what-this-agent-has-learned',
  settings: 'settings-configuring-the-agent',
  // 7 — sharing a team (#2082): who may open it, and who may change it
  shareTeam: 'sharing-a-team-who-can-open-it-and-who-can-change-it',
  // 8 — the team's configuration tabs, and the save-time propagation offer
  // (#2170/#2236, folded in from the retired environments.md/Working
  // Environments page). Sub-sections of Settings — configuring the agent.
  teamEnvironment: 'the-team-s-configuration-tabs-in-detail',
  bringingAgentsUpToDate: 'bringing-existing-agents-up-to-date',
  // 9 — General/Skills/Plugins tabs of a team's flat configuration row
  // (#2236) point at the same field-by-field chapter the ordinary (non-team)
  // Settings form already had.
  formFields: 'what-the-form-fields-control',
};

export default AGENT_CHAT_HELP_SECTIONS;
