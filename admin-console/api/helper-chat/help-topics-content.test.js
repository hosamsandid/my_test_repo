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
const { KNOWN_ROUTE_PATHS } = require('./help-routes');

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
    ],
  },
  {
    id: 'flows',
    routes: ['/flows'],
    // #1876 lifted these from the Flows page: the "Welcome to Flows" banner and
    // the page's own help drawer, plus the long concept prose out of the
    // hand-off chooser, the label registry and the human-role registry.
    concepts: [
      'flow graphs',
      'Drafts',
      'Outcome',
      'Label',
      'Consumer',
      'Materialize',
      'Flow Copilot',
      'Import / Export',
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
      'BriefingPack',
      'Briefings Path',
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
      'Import / Export',
      'replaces the entire',
      'provenance',
      'migrated to the target',
      'Retire source skills',
      'Memory',
      'Knowledge',
      'distilled from the best knowledge',
    ],
  },
  {
    id: 'plugins',
    routes: ['/plugins'],
    // #1879 lifted these from the Plugins page intro AND from the whole
    // standalone /plugin-system page, which the same ticket REMOVED outright
    // (concept §9) — so for the build-a-plugin material this topic is not just
    // the best home, it is the only one left in the product.
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
  // Append point — every Phase-3 extraction ticket adds its entry at this tail,
  // so two tickets in flight always conflict here. Resolve by keeping BOTH sides
  // in ticket order (E1 agents, E2 flows, E3 knowledge, E4 skills, E5 plugins,
  // E6 environments, E7 access-users, E8 models, E9 mcp, E10 credentials,
  // E11 token-usage, E12 github-events, E13 maintenance-mode …), never by
  // dropping one.
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
      assert.ok(KNOWN_ROUTE_PATHS.has(route), `${route} must be classified in help-routes.js`);
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
