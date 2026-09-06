'use strict';

// ─── Shipped-topic content guard (#1875, epic #1870 Phase 3) ──────────────────
//
// The Phase-3 extraction tickets DELETE the big on-page explainer boxes and move
// their copy into help-topics/*.md. Once the page that carried a concept is gone,
// the only thing standing between that concept and silent rot is an assertion
// over the SHIPPED topic files — parser unit tests (help-registry.test.js) prove
// the format, not the content.
//
// So: for every topic listed below, assert the baseline shape, that its declared
// routes really resolve to it, that its `seeAlso` links point at routes the help
// system knows, and that the concepts lifted from the deleted page survive.
// Later extraction tickets (E2–E15) add one entry per authored topic.

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadRegistry, baselineProblems } = require('./help-registry');
const { KNOWN_ROUTE_PATHS, isKnownHelpKey } = require('./help-routes');

// Concepts each topic must still carry, as case-insensitive substrings of the
// rendered topic text (front-matter summary + body). Deliberately phrased as
// short, stable fragments — a reword is fine, dropping the concept is not.
const TOPIC_CONTENT = [
  {
    id: 'agents',
    routes: ['/agents'],
    // #1875 lifted these from the Agents page: the "what is an agent" box, the
    // role catalogue (incl. the Agent-Team-vs-Team warning), the lifecycle
    // states, and the Disable / Reset-to-stub / Delete distinction.
    concepts: [
      'long-running Claude Code instance',
      'Agent Chat',
      'Agent Team',
      'Team Member',
      'Orchestrator',
      'BriefingPack',
      'access scope',
      'Active',
      'paused',
      'not initialised',
      'Disable',
      'Reset to stub',
      'Delete',
      'System Prompt',
      'Skills',
      'Plugins',
      'Host context folders',
      // #1960: the members' half of the orphan block is gone, and the topic is
      // where that decision (and its reason) is recorded, so the Helper Chat can
      // answer "where did the orphaned-agents list go?".
      'Orphaned agents',
      'takes its members with it',
      'no replacement surface',
      '/api/agents/orphans',
      'idempotent',
    ],
  },
  {
    id: 'flows',
    routes: ['/flows'],
    // #1876 lifted these from the Flows page: the "Welcome to Flows" banner and
    // the page's own help drawer, plus the long concept prose out of the
    // hand-off chooser, the label registry and the human-role registry.
    //
    // #1984 (epic #1981) widened it into a per-surface reference. Each chapter
    // below is the landing target of a "?" on the matching surface except
    // `The flows left list`, whose surface IS the button that opens chapter 1
    // (the flows-list header) — it is one heading further down, deliberately, so
    // that button lands on the definition rather than above it.
    chapters: [
      'What Flows is',
      'The flows left list',
      'The canvas',
      'Wiring hand-offs: the edge chooser',
      'Human gates, brakes and named human roles',
      'Outcomes and inputs, per agent',
      'Stages',
      'Anomalies',
      'Improvements',
      'Describe the flow: the Copilot',
    ],
    concepts: [
      'flow graphs',
      'Drafts',
      'Outcome',
      'Label',
      'Consumer',
      'Materialize',
      'Flow Copilot',
      // #1876 wrote these as one "Import / Export" phrase. They are separate
      // affordances in separate places — Import is a header create action,
      // Export is on the canvas toolbar — so the topic now names them apart and
      // the guard follows the prose rather than the other way round.
      'Import',
      'Export',
      'Label hand-off',
      'Issue channel',
      'Pull-request channel',
      'File artifact',
      'GitHub trigger',
      'Webhook',
      'Dependency',
      'Parent / child',
      'Human gate',
      'Brake',
      'Human roles',
      'exactly one',
      'any of',
      'Inputs',
      'Stages',
      'Anomalies',
      // #1984: the two live-team panels the ticket added chapters for.
      'Improvements',
      'observe-only',
      'improvement cards',
      // Delivery: the third human touchpoint, which is neither gate nor brake.
      'delivery',
      // Internal vs poller delivery, the choice the label edge dialog offers.
      'aee-emit',
      'poller',
      // #1984 corrections to what the page actually shows today — each of these
      // contradicts a premise the ticket or an older doc still carried, so a
      // reword must not quietly restore the old reading.
      'no third section',
      'depends on where you dragged from',
      'BriefingPack',
    ],
  },
  {
    id: 'knowledge',
    routes: ['/knowledge'],
    // #1877 lifted these from the Knowledge page: the "How it works" intro box
    // (Memory vs Knowledge vs Skills, the three-step learning flow, the kinds,
    // digests, the domains/consolidate/distill power tools) and the long
    // autonomy / review / promotion-gate copy out of KnowledgeLearningConfig —
    // which the wizard's Knowledge step renders too, so this is now the only
    // place that explains what a level or a gate does.
    //
    // #1985 (epic #1981) widened it into a per-surface reference: the six areas
    // below are each a chapter, and each is the landing target of a "?" on the
    // matching surface, so the headings are load-bearing rather than decorative.
    chapters: [
      'Memory vs Knowledge vs Skills',
      'How learning works, in three steps',
      'The per-agent digest, and what stays searchable',
      'Autonomy, Review and the promotion gates',
      'Power tools: domains, consolidate and distill',
      'Configuration: forgetting, assist model and storage',
    ],
    concepts: [
      'Memory',
      'Knowledge',
      'Skills',
      'Fact',
      'Entity',
      'Convention',
      'converged',
      'digest',
      'Domains',
      'Consolidate',
      'Distill',
      'playbook',
      'Autonomy',
      'Off',
      'Share',
      'Suggest',
      'Auto-curate',
      'Review',
      'Promotion gates',
      'Knowledge → team skill',
      'Agent skill → team skill',
      'Team skill → all teams',
      'Forgetting',
      'un-retired',
      // #1985 additions. The first two are a CORRECTION, guarded here because
      // the ticket assumed the opposite: the Knowledge page has no client-side
      // admin gate at all, and the API routes behind the Configure panel check
      // `knowledgeTeamVisible` — team *visibility*, not `canManageTeam`. So any
      // member who can see the team can change its autonomy level, and a reword
      // must not quietly restore the "Team-Admin-gated" reading.
      'not restricted to team admins',
      'anyone who can see a team',
      // The two configuration subjects the topic never covered — the page's own
      // blurbs stay (point-of-decision copy), the rationale is here.
      'Assist model',
      'Storage',
    ],
  },
  {
    id: 'skills',
    routes: ['/skills'],
    // #1878 lifted these from the Skills page: the four-paragraph concept intro
    // (what a skill is, the Global/Team/Agent tiers and their resolution order,
    // grant vs seeding/activation vs one-off install, the tier-moving verbs, and
    // Skills vs Knowledge vs Memory) plus the merge dialog's rationale about
    // provenance, carried-over files and migrated grants.
    //
    // #1990 (epic #1981) widened it into a per-surface reference: the six areas
    // below are each a chapter, and each is the landing target of a "?" on the
    // matching surface, so the headings are load-bearing rather than decorative.
    chapters: [
      'What a skill is',
      'The three tiers, and which one an agent gets',
      'Grant, activation and Install into agent',
      'The actions: promote, move, adopt, distill, merge, import and export',
      'Overwrite and merge: what each one replaces',
      'Skills vs Knowledge vs Memory',
    ],
    concepts: [
      'SKILL.md',
      'Global',
      'Team',
      'Agent',
      'read-only',
      'then from the global pool',
      'Grant',
      'activation',
      'Install into agent',
      'workspace reset',
      'Promote to global',
      'Move to global',
      'Adopt',
      'Move to team',
      'Distill',
      'Merge',
      // #1990 renamed this row to the two button labels it actually documents
      // (the page has an "Export ZIP" and an "Import skill" control, never one
      // combined "Import / Export" verb) — the concept is unchanged.
      'Export ZIP',
      'Import skill',
      'replaces the entire',
      'provenance',
      'migrated to the target',
      'Retire source skills',
      'Memory',
      'Knowledge',
      'distilled from the best knowledge',
      // #1990 correction, guarded here because it is the opposite of what this
      // topic said before: POST /api/skills/install delegates to the
      // orchestrator's skill-activation path, which WRITES THE GRANT (an agent's
      // own `skills[]` / a member's `skillsOverride`) — so an install is not a
      // one-off copy that the next re-seed loses.
      'writes the grant',
    ],
  },
  {
    id: 'plugins',
    routes: ['/plugins'],
    // #1879 lifted these from the Plugins page intro AND from the whole
    // standalone /plugin-system page, which the same ticket REMOVED outright
    // (concept §9) — so for the build-a-plugin material this topic is not just
    // the best home, it is the only one left in the product.
    //
    // #1986 (epic #1981) widened it into a per-surface reference. Chapters
    // 1/3/5/7/8 are the deep-link targets of the five surfaces the ticket names
    // (page header → 1, install dialog → 3 of its 2/3/4 span, uninstall dialog
    // → 5, the team-assign control → 7, the deep-dive pointer → 8). Chapters
    // 2/4/6 carry no "?" of their own: install-vs-grant and scope granularity
    // are the story the header and the dialogs land next to, and the UI-bearing
    // chapter has no surface on this page at all (a plugin's own pages are in
    // the sidebar). All three stay separately addressable because the panel
    // renders the WHOLE topic — they are one scroll from wherever a link lands.
    //
    // Open question 1, answered: the deep dive stays ONE chapter with `###`
    // sub-headings rather than splitting into "how it works" + "how to build
    // one". The ticket's own surface table names exactly one deep-dive
    // affordance, so a split would leave a chapter no "?" could reach.
    chapters: [
      'What a plugin is',
      'Install and grant are two different steps',
      'Capabilities and the platform gate',
      'Scope granularity and quota',
      'What activating does — and what uninstalling undoes',
      'Plugins with their own UI',
      'Assigning a plugin to a team on this page',
      'Deep dive: how a plugin works, and how to build one',
    ],
    concepts: [
      'broker',
      'Install',
      'Grant',
      'System Admin',
      'Team Admin',
      'inherited',
      'closed enum',
      'podman-socket',
      'not available on this stack',
      'scope granularity',
      'Per team',
      'Per agent',
      'quota',
      'without respawning',
      'session log',
      'embeds it inside the same window',
      'minRole',
      'agent plugin',
      'plugin.json',
      'requiresApproval',
      'audit log',
      'teardown',
      'broker unreachable',
      'submit → poll',
      'Broker SDK',
      // #1986 additions. Each is a statement the PAGE cannot make for itself —
      // a reword that loses one leaves a surface with a "?" that no longer
      // answers the question it was put there for.
      'uninstalling revokes nothing',
      'Requests no host privileges',
      'Team assignment',
      'team scope only',
      'Global UI',
    ],
  },
  {
    id: 'environments',
    routes: ['/environments'],
    // #1880 lifted the "What is a Working Environment?" box: the reusable-recipe
    // definition, what an agent inherits (repos / token / MCP refs / provider /
    // additional instructions), the shared-recipe-but-own-workspace point, the
    // SSH-vs-token rule, read-only repositories and the cloned-at-creation /
    // Sync-all-agents caveat.
    //
    // #1987 (epic #1981) widened it into a per-surface reference: the seven
    // areas below are each a chapter, and four of them are the landing target of
    // a "?" on the matching surface, so the headings are load-bearing rather
    // than decorative.
    chapters: [
      'What a Working Environment is',
      'Repositories',
      'Credentials',
      'MCP server references',
      'Model provider binding',
      'Additional context',
      'Toolchains',
    ],
    concepts: [
      'reusable workspace recipe',
      'own isolated workspace',
      'Git repositories',
      'GitHub token',
      'MCP servers',
      'Model provider',
      'Additional instructions',
      'no repository at all',
      'SSH key',
      'HTTPS',
      'Read-only',
      'newly created agents',
      'Sync all agents',
      // #1987 additions. The first is a CORRECTION of the page, guarded here
      // because the form's own hint said the opposite: prompt-assembly.js writes
      // the environment name AND description into the agent's CLAUDE.md, so the
      // description is not console-only.
      'read by the agent',
      // The form has no MCP picker at all — E9 (#1989) flagged it from the MCP
      // side; a "?" on THIS page must not imply a control that does not exist.
      'form has no MCP picker',
      // What an environment edit does and does not reach — the page's most
      // surprising behaviour, and the reason the Sync action exists.
      'What an edit reaches',
      'recreates its running agents',
      'never re-clones',
      // Two honest limits of surfaces that look stricter than they are.
      'advice, not a gate',
      'an instruction, not a file permission',
      'refuses the clone',
      // The toolchain half: the panel, and the pin-file-not-image story.
      'Toolchains panel',
      'version manager',
    ],
  },
  {
    id: 'access-users',
    routes: ['/teams'],
    // #1881 lifted the Access & Users intro box: the access-scope ("Team")
    // definition, the explicit *this is not an Agent Team* distinction and the
    // System-Admin / Team-Admin / Team-Member role list. The topic additionally
    // records what a scope actually gates (list filtering, private agents, the
    // 403 on management calls) and the default-team / still-owns-resources
    // delete rules, which the page never spelled out.
    concepts: [
      'access scope',
      'Agent Team',
      'Agent Team Wizard',
      'exactly one',
      'System Admin',
      'Team Admin',
      'Team Member',
      'default',
      'fail-closed',
      'updates their role in place',
      'Lists are filtered',
      'Private agents',
      '403',
      'Manage Users',
      'Resource ownership',
      'reassign',
    ],
  },
  {
    id: 'models',
    routes: ['/models'],
    // #1882 lifted these from the Model Providers page: the intro paragraph, the
    // long `AUTH_TYPE_OPTIONS` rationale and the OAuth box's consequences (the
    // Consumer-Terms rule itself stays on the page — it guards a required tick).
    concepts: [
      'Anthropic Messages API',
      'LiteLLM',
      'catalog',
      'Working Environment',
      'Agent override',
      'api-key',
      'Bearer header',
      '0600',
      'oauth-token',
      'claude setup-token',
      'no Base URL',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'bypasses any proxy',
      'server-side',
      'Consumer Terms',
      'single-user',
      'per-seat Enterprise tokens',
      'Rate limits are shared',
      'assist calls skip subscription providers',
      'Discover models',
      'Health',
      'when it starts',
      'detach it there first',
      // #1988 widened the topic into a per-surface reference. These are the
      // claims the new chapters add that the page no longer states anywhere:
      // what a probe's credential line is *for*, and that `Unknown` is an
      // honest never-measured status rather than a warning.
      'names the credential it used',
      'honest, not a warning',
      'signal, not a gate',
    ],
    // #1988: chapters 1–5 are the landing targets of this page's five "?"
    // buttons (the auth-type one follows the selection, so it addresses 2 or 3).
    // Chapter 6 carries no "?" of its own — the restart-agents dialog and the
    // delete refusal already state their own rules at the point of decision, and
    // the panel renders the whole topic, so it is one scroll from wherever a
    // deep link lands.
    chapters: [
      'What a Model Provider is',
      'API key / proxy authentication',
      'Anthropic subscription authentication',
      'Test connection and Discover models',
      'Health: the poller and the Health column',
      'Changing credentials and deleting',
    ],
  },
  {
    id: 'mcp',
    routes: ['/mcp'],
    // #1883 lifted the MCP Servers intro box (the three-part servers /
    // credentials / Working-Environment-pairing model) and the "where does
    // 'required' come from" InfoTip, and adds what neither said: the seed-time
    // merge into the agent's own settings.json, the dropped-key behaviour when
    // nothing is bound, the per-transport field split, and where the pairing is
    // actually visible today.
    //
    // #1989 (epic #1981) widened it into a per-surface reference. Chapters 1/2/3
    // are the deep-link targets of the four surfaces the ticket names (page
    // header → 1, server panel → 2, credential panel and the *required* column
    // marker → 3). Chapters 4 and 5 carry no "?" of their own: the pairing has
    // no surface on this page at all (the Working Environments form exposes no
    // MCP picker) and deleting happens in a ConfirmDialog that already states
    // the rule. Both stay separately addressable because the panel renders the
    // whole topic — they are one scroll from wherever a deep link lands.
    chapters: [
      'The three-part model',
      'The server registry and its transports',
      'The credential store and `${credential}` substitution',
      'Environment pairing and the seed-time merge',
      'Deleting a server or a credential',
    ],
    concepts: [
      'three-part model',
      '${credential}',
      'requiresCredential',
      'rotated',
      'seed time',
      '.claude/settings.json',
      'merged, not replaced',
      'dropped',
      'stdio',
      'sse',
      'mutually exclusive',
      'Default server',
      'fingerprint',
      'next invocation',
      'Detach it there first',
    ],
  },
  {
    id: 'credentials',
    routes: ['/ssh-keys', '/github-tokens', '/my-credentials'],
    // #1884 lifted the intro boxes and the FOUR duplicated "why both an SSH key
    // and a GitHub token" notes (SSH Keys, GitHub Tokens, My Credentials and the
    // SetupWizard's two credential steps). The topic additionally records what
    // no box said: the three ownership tiers, the strict personal privacy
    // guarantee, the per-operation-class runtime resolution order with
    // refuse-on-missing, and the rotate-in-place vs create-new-and-repoint split.
    //
    // #1993 (epic #1981) widened it into a per-surface reference. This is the
    // first MULTI-ROUTE topic, so the chapters matter more here than anywhere
    // else: three pages share one file, and without them a reader arriving from
    // GitHub Tokens landed at the top of an explanation opening with SSH.
    // Chapters 2/3/4 are the deep-link targets of the three page headers;
    // 1/5/6 are the cross-page story and carry no "?" of their own.
    chapters: [
      'Why both an SSH key and a GitHub token',
      'SSH keys',
      'GitHub tokens',
      'My Credentials',
      'Ownership tiers and privacy',
      'Rotation and runtime resolution',
    ],
    concepts: [
      'SSH key',
      'GitHub token',
      'deploy key',
      'defense-in-depth',
      'blast-radius',
      'GH_TOKEN',
      'fingerprint',
      'Personal',
      'Team',
      'System',
      'only the owner',
      'break-glass',
      'attributed writes',
      'Event polling',
      'preference among tiers',
      'refused',
      'rotate in place',
      'create-new-and-repoint',
      'Used by',
      'read:org',
      'SAML SSO',
    ],
  },
  {
    id: 'token-usage',
    routes: ['/token-usage'],
    // #1885 lifted the Token Usage intro banner (what the page shows + how the
    // two tabs differ), the reasoning behind the tokens-not-costs caveat, and
    // the full attribution-tier explainer out of the `TIER_SIGNAL_HELP` InfoTip
    // — which now carries only the four signal names. The topic additionally
    // records what the banner never said: that only agent runs are recorded,
    // the strongest-signal-wins rule, the shared / flow-mismatch flags, why the
    // unattributed remainder is always reported, and that records are filed
    // under the day the run happened.
    //
    // #1994 (epic #1981) widened it into a per-surface reference on the #1972
    // template: the four areas below are each a chapter, and each is the landing
    // target of a "?" on the matching surface (page header · Statistics tab ·
    // Work items tab · the Signals/Tier attribution columns), so the headings
    // are load-bearing rather than decorative.
    chapters: [
      'What the page shows',
      'The Statistics tab',
      'The Work items tab',
      'How runs are attributed',
    ],
    concepts: [
      'System Admin',
      'Team filter',
      'agent runs',
      'Statistics',
      'Work items',
      'Group by',
      'unknown',
      'raw token count',
      'never reads it',
      'CSV',
      'Input',
      'Output',
      'Cache write',
      'Cache read',
      'closes #N',
      'flow',
      'created',
      'event',
      'branch',
      'strongest signal',
      'shared',
      'flow-mismatch',
      'always',
      'attributed',
      'Invocations',
      'Open session',
    ],
  },
  {
    id: 'github-events',
    routes: ['/github-events'],
    // #1886 lifted the page's multi-clause intro (observational log; Processed
    // events = history vs Pending queue = backlog) and the outcome enumeration
    // out of both tab leads. The topic is now the only place that explains what
    // each outcome means beyond the chip tooltips, plus the delivery mechanics
    // no on-page copy ever stated (polling + its lossiness, the seen-id cursor,
    // the non-poller writers, why a queue backs up, retention, no team scoping).
    //
    // #1995 (epic #1981) widened it into a per-surface reference: the four areas
    // below are each a chapter, and each is the landing target of a "?" on the
    // matching surface, so the headings are load-bearing rather than decorative.
    chapters: [
      'What the GitHub Event Log is',
      'Processed events',
      'Outcomes',
      'Pending queue',
    ],
    concepts: [
      'observational',
      'Processed events',
      'Pending queue',
      'delivered',
      'digested',
      'dropped',
      "nobody's listening",
      'throttle',
      'horizon',
      'label-filter',
      'internal-dedup',
      'wake label',
      'no source filtering',
      'pull_request.synchronize',
      'seen ids',
      'Maintenance Mode',
      'Cancel',
      '7 days',
      'best-effort',
      'not team-scoped',
      // #1995 additions: the table's own columns, the `source` the UI never
      // renders, the polled-vs-never-polled rule and the queue's no-expiry
      // promise are only documented here — no on-page copy states any of them.
      'Work item',
      'Actor',
      'never renders it',
      'When a repository is polled',
      'no expiry',
    ],
  },
  {
    id: 'maintenance-mode',
    routes: ['/maintenance-mode'],
    // #1887 lifted the page intro and the bordered "While active" box (the
    // cron catch-up, the durable http/github-event queue, nothing-force-stopped)
    // and adds what neither said: the console-wide chat lock, the skipped
    // orchestrator passes, the advisory-only session counter, and the fact that
    // the grace period is a display countdown no backend component enforces.
    concepts: [
      'signal, not an action',
      'manual, external step',
      'Nothing auto-deactivates',
      'across every team and user',
      'advisory',
      'Trigger possibly lost',
      'enforcement timer',
      'stays active',
      '24 hours',
      'cron',
      'exactly one',
      'once',
      'loop',
      'github-event',
      'nothing is dropped',
      'not auto-retried',
      'read-only',
      'refuses to send',
      'hill-climb metrics',
      'flow-anomaly history',
      'natural end',
      'End Maintenance Mode',
    ],
  },
  {
    id: 'create',
    routes: ['/create', '/quickstart'],
    // #1888 lifted the launcher's tile prose, the one-assistant intro/detail
    // pair and BOTH "what happens here" branches, and adds what neither said:
    // an existing environment *and* an existing standalone agent are reused, and
    // on the repository path the Name / Model Provider fields are not used.
    //
    // #1992 (epic #1981) re-cut it into a per-surface reference: the four
    // chapters below are each the landing target of a "?" on the matching
    // surface across BOTH routes the topic claims, so the headings are
    // load-bearing rather than decorative.
    chapters: [
      'The entry paths',
      'A single agent is a team of one',
      'The repository fast lane',
      'What you need before you start',
    ],
    concepts: [
      'equally ranked',
      'Describe what you need',
      'Start from a ready-made setup',
      'Build it yourself',
      'one assistant',
      'draft',
      'team of one',
      'Grow into a full team',
      'creates a new team',
      'default branch',
      'reuses',
      'Agent reused',
      'not used',
      'Model Provider',
      'SSH key',
      'GitHub token',
      // #1992 additions. Each is a statement the pages never made and that the
      // chapter behind a "?" now owes its surface — a reword that drops one
      // leaves that surface's deep link pointing at prose that no longer
      // answers the question it was mounted for.
      'materialise',
      'chat history',
      'is normalised',
      'blocks the button',
    ],
  },
  {
    id: 'team-setup',
    routes: ['/team-setup'],
    // #1888 lifted the wizard's header restatement + the Agent-Team-vs-access-
    // scope line, the Working-Environment step intro, the Knowledge step's
    // long prose and the go-live notice's follow-up advice.
    concepts: [
      'Agent Team',
      'Access page',
      'Process',
      'Working Environment',
      'Team ID',
      'Knowledge',
      'Review',
      'global-pool',
      'read-only',
      'team-member',
      'per-invocation',
      'direct-message room',
      'go live',
      'Label suffix',
      'extend',
      'rolled back',
      'Retry',
      'create-only',
      'Add role',
    ],
  },
  {
    id: 'role-templates',
    routes: ['/role-templates'],
    // #1888 lifted the Agent Templates intro paragraph and the invocation-mode
    // field help, and adds the role-type / origin-badge / prompt-template
    // detail the page only ever hinted at.
    concepts: [
      'Agent Template',
      'Built-in',
      'Edited',
      'Custom',
      'Save as template',
      'future',
      'independent copy',
      'chat',
      'reactive',
      'pattern',
      'persistent',
      'per-invocation',
      'autonomous',
      'promptTemplate',
      'Advanced',
      'intrinsic',
      'System Admin',
    ],
  },
  {
    id: 'agent-chat',
    routes: ['/chats'],
    // #1889 lifted the Agent Chat side-panel explainers: the trigger-type concept
    // banners (loop, data-flow, the flow-verifier rationale), what a structured
    // outcome is, and why retiring a learning is a reversible archive. It also
    // writes down what no panel said: a loop is a launched run and therefore never
    // appears in the Triggers list, the workspace gate that makes everything else
    // wait while a loop holds it, and that an entry backing a promoted skill
    // cannot be retired at all.
    //
    // #1972 widened it from "the three side panels" to the WHOLE page: the agent
    // list, the header, the composer and the right rail each gained a chapter,
    // and each chapter is the landing target of a "?" on that surface. The
    // `chapters` list below is therefore load-bearing, not decorative — the
    // heading is what the deep-link resolves against.
    chapters: [
      'What the Agent Chat page is',
      'The agent list',
      'The chat header',
      'The message composer',
      'The right rail',
      'Triggers — when the agent wakes on its own',
      'Outcomes — what the agent signals when a run ends',
      'Knowledge — what this agent has learned',
      'Settings — configuring the agent',
    ],
    concepts: [
      'one long-running Claude session',
      'Reset Session',
      'one workspace',
      'wake instruction',
      'Cron (recurring)',
      'Once (one-shot)',
      'HTTP webhook',
      'X-Hook-Secret',
      'GitHub event',
      'Data flow (agent dependency)',
      'Loop (re-run until done)',
      'container clock',
      "the agent's own pushes",
      '[PASS]',
      'claim',
      'not a subscription',
      'fresh context window',
      'exhausted',
      'paused',
      'stopped',
      'separate',
      'durably queued',
      'Stop always works',
      'Maintenance Mode',
      'Outcome → Label → Consumer',
      'exactly one',
      'any of',
      'read-only on purpose',
      'flat labels',
      'digest',
      'Propose as skill',
      'reversible',
      'committed to git',
      'un-retired',
      'backs a promoted skill',
      'validity window',
      // #1972 — the surfaces the topic did not cover before.
      'show disabled agents',
      'Mark as unread',
      'Reset to stub',
      'learning badge',
      'context window',
      'restarts the agent',
      'About this chat',
      'Clear History',
      'Settings → Behavior',
      'slash command',
      'Stop',
      'meeting',
      'reference in chat',
      'context folder',
      'read-write',
      'Sessions',
      'TODO',
      'Cmd/Ctrl+Shift+L',
      'unsaved changes',
      // #1957 — the not-yet-materialized members the rail could not show at all
      // before. The stub-vs-paused distinction is the point of the section, so
      // it must survive a reword as much as the section's own name does.
      'Not materialized yet',
      'Not initialised',
      'Materialize',
      'never provisioned at all',
      // #1958 — the other half of the same state: how a stub gets CREATED from
      // the rail. The checkbox default and the do-not-use-Disable warning are
      // the load-bearing parts (a disabled member is the state this ticket
      // exists to stop people reaching for), so they are pinned individually.
      'Materialize now',
      'ticked by default',
      'assembling a team over several sittings',
      'already cloned',
    ],
  },
  {
    id: 'users',
    routes: ['/users'],
    // #1891 (E16) — the route E7 left uncovered. The topic absorbed the Users
    // page intro box (records vs memberships, the global System-Admin flag) and
    // adds what no surface said: the immutable subject, the user-store-then-env
    // login order, and that Delete is an offboarding which pauses the person's
    // agents and deletes their personal credentials first.
    concepts: [
      'Subject',
      'immutable',
      'System Admin',
      'Team Admin',
      'membership',
      'fail-closed',
      'password',
      'ADMIN_USERNAME',
      'offboarding',
      'paused',
      'personal SSH keys',
      'best-effort',
      'Access',
    ],
  },
  {
    id: 'about',
    routes: ['/about'],
    // #1891 (E16) — a net-new baseline topic for a page that never had help.
    // What the version string actually is, how the contributor list is derived
    // (and why a name can be missing), the CC-BY-4.0 attribution obligation,
    // and where to take a problem report given there is no feedback form.
    concepts: [
      'git commit',
      'not a release number',
      '-dirty',
      'unknown',
      'build time',
      'agents.local',
      'commit count',
      'Parakeet',
      'CC-BY-4.0',
      'no in-app feedback form',
      'GitHub Event Log',
    ],
  },
  {
    id: 'settings',
    routes: ['modal:settings'],
    // #1892 authored this from the dialog itself (the first topic keyed on a
    // non-route context). The load-bearing facts: assist model != agent model,
    // and which preferences are browser-local vs on the user record.
    concepts: [
      'Behavior',
      'Model',
      'Display',
      'send keybinding',
      'IDE style',
      'Chat style',
      'Assist model',
      'not the model your agents run on',
      'Flow Copilot',
      'oauth-token',
      'single-user',
      'Theme',
      'Chat font size',
      'in this browser only',
      'user record',
    ],
  },
  // Append point — every Phase-3 extraction ticket adds its entry at this tail,
  // so two tickets in flight always conflict here. Resolve by keeping BOTH sides
  // in ticket order (E1 agents, E2 flows, E3 knowledge, E4 skills, E5 plugins,
  // E6 environments, E7 access-users, E8 models, E9 mcp, E10 credentials,
  // E11 token-usage, E12 github-events, E13 maintenance-mode, E14 create /
  // team-setup / role-templates, E15 agent-chat, E16 users / about, E17 settings
  // …), never by dropping one.
];

const registry = loadRegistry();

for (const spec of TOPIC_CONTENT) {
  const topic = registry.byId.get(spec.id);

  test(`topic ${spec.id}: exists and meets the baseline shape`, () => {
    assert.ok(topic, `help-topics/${spec.id}.md must define topic id "${spec.id}"`);
    assert.deepEqual(baselineProblems(topic), []);
    assert.ok(topic.summary.trim(), 'a topic needs a one-line summary for the panel header');
  });

  test(`topic ${spec.id}: claims exactly its declared routes, and they resolve`, () => {
    assert.deepEqual(topic.routes, spec.routes);
    for (const route of spec.routes) {
      // Since E17 (#1892) a topic may also claim a non-route help context key
      // (`modal:settings`, `/team-setup#process`), so the check is "a key the
      // help system knows" rather than "a pathname".
      assert.ok(isKnownHelpKey(route), `${route} must be classified in help-routes.js`);
      assert.equal(registry.topicForRoute(route)?.id, spec.id);
    }
  });

  test(`topic ${spec.id}: every seeAlso link points at a known route`, () => {
    for (const link of topic.seeAlso) {
      assert.ok(link.label, 'a related link needs a label');
      assert.ok(
        KNOWN_ROUTE_PATHS.has(link.to),
        `seeAlso "${link.label}" → ${link.to} is not a route the help system knows`,
      );
    }
  });

  // Optional (#1972): a topic whose chapters are deep-link targets declares
  // them, and each one must stay a top-level `## ` heading. A reworded heading
  // does not throw at runtime — the panel silently renders from the top — so a
  // test is the only thing that notices.
  if (spec.chapters) {
    test(`topic ${spec.id}: every deep-linked chapter is still a heading`, () => {
      const headings = (topic.body.match(/^##\s+(.+?)\s*$/gm) || [])
        .map((h) => h.replace(/^##\s+/, '').trim());
      const missing = spec.chapters.filter((c) => !headings.includes(c));
      assert.deepEqual(
        missing, [],
        `help-topics/${spec.id}.md lost the chapter heading(s): ${missing.join(' · ')} — `
        + 'a "?" on the page deep-links to these by heading, so a reword breaks the '
        + `link silently. Headings found: ${headings.join(' · ')}`,
      );
    });
  }

  test(`topic ${spec.id}: the concepts lifted from the page survive`, () => {
    const hay = `${topic.summary}\n${topic.body}`.toLowerCase();
    const lost = spec.concepts.filter((c) => !hay.includes(c.toLowerCase()));
    assert.deepEqual(
      lost, [],
      `help-topics/${spec.id}.md no longer mentions: ${lost.join(', ')} — `
      + 'the page that used to explain these is gone, so the topic is the only home left.',
    );
  });
}
