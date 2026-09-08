// Journey fixture registry (docs/journey-spec-concept.md §2.1 `fixtures:`, #705).
//
// A fixture is code that establishes a named precondition and can undo it — the
// journey YAML only names it (`- fixture: teamEnv`) and passes params. Fixtures
// are deliberately SEPARATE from the `action`/`assert` step vocabulary: they run
// once before the steps and their teardown always runs after (even on failure),
// so a journey leaves no state behind and can re-run on the same stack. They
// compose the existing #667 step modules (env, teardown) — no duplicate logic.
const { execFileSync } = require('child_process');
const env = require('../steps/env');
const teardown = require('../steps/teardown');
const gh = require('../steps/gh');
const team = require('../steps/team');
const context = require('../steps/context');
const knowledge = require('../steps/knowledge');

/**
 * teamEnv: the Team-Setup pilot's precondition. Seeds a credential-less Working
 * Environment pointing at the in-stack git remote, so the wizard can materialise
 * a team with zero external dependencies. Because the journey uses FIXED ids
 * (for screenshot determinism, §7), setup first tears down any leftover team+env
 * from a crashed prior run, and teardown removes the team this journey creates
 * plus the fixture env — one deterministic, idempotent surface.
 *
 * @param {string} params.teamId - Team slug id the journey will create (pre-cleaned).
 * @param {string} params.envId - Fixture environment id to create.
 * @param {string} params.envName - Fixture environment display name.
 * @param {string} params.repoUrl - Git URL the environment points at.
 * @param {string} [params.branch=main] - Branch to track.
 * @example
 * fixtures:
 *   - fixture: teamEnv
 *     params:
 *       teamId: agentic-demos
 *       envId: agentic-demos-env
 *       envName: Agentic Demos
 *       repoUrl: "http://git-remote/e2e/fixture.git"
 */
const teamEnv = {
  async setup(ctx, params = {}) {
    const { teamId, envId, envName, repoUrl, branch = 'main' } = params;
    if (!teamId || !envId || !envName || !repoUrl) {
      throw new Error('teamEnv fixture requires { teamId, envId, envName, repoUrl }');
    }
    // Pre-clean: absorb a leftover team/env so a re-run starts from a clean slate.
    await teardown.teardownTeam(ctx, { teamId, envId });
    await env.createFixtureEnv(ctx, { id: envId, name: envName, repoUrl, branch });
    return { teamId, envId };
  },
  async teardown(ctx, params = {}) {
    const { teamId, envId } = params;
    if (teamId && envId) await teardown.teardownTeam(ctx, { teamId, envId });
  },
};

/**
 * ibanStoryTeam: the IBAN-story journey's precondition (#711). Stands up the WHOLE
 * label-chain stack in one atomic precondition so the journey body only drives
 * the hops: it (1) resets fake-github so the run starts from clean GitHub state,
 * (2) creates a fake GitHub token so the poller actually polls the fixture repo
 * (a token-less env is ignored by the poller), (3) creates a credential-carrying
 * Working Environment pointing at the in-stack git remote, and (4) materialises a
 * full Core SDLC team FROM THE PROCESS-TEMPLATE BUNDLE — so `POST /api/teams`
 * runs `expandGithubChannels` and the Developer/Code-Reviewer get the derived
 * github-event channel triggers (issues.labeled=`ready`, pull_request.labeled=
 * `ready-for-review`) that carry the label chain. Bare `roles` would materialise
 * the same agents WITHOUT those channels.
 *
 * FIXED ids keep the journey re-runnable on the same stack: setup pre-cleans any
 * leftover team+env+token from a crashed prior run, and teardown removes the
 * team, env and token this journey created — one deterministic, idempotent surface.
 *
 * @param {string} params.teamId - Team slug id to create (also its member prefix).
 * @param {string} params.teamName - Team display name.
 * @param {string} params.envId - Fixture environment id to create.
 * @param {string} params.envName - Fixture environment display name.
 * @param {string} params.repoUrl - Git URL the environment points at (the in-stack git remote).
 * @param {string} params.tokenId - Fixture GitHub-token id (referenced by the env).
 * @param {string} [params.branch=main] - Branch to track.
 * @param {string} [params.templateId=core-sdlc] - Process template to materialise.
 * @example
 * fixtures:
 *   - fixture: ibanStoryTeam
 *     params:
 *       teamId: iban-demo
 *       teamName: IBAN Demo
 *       envId: iban-demo-env
 *       envName: IBAN Demo
 *       repoUrl: "http://git-remote/e2e/fixture.git"
 *       tokenId: iban-demo-token
 */
const ibanStoryTeam = {
  async setup(ctx, params = {}) {
    const {
      teamId, teamName, envId, envName, repoUrl, tokenId, branch = 'main', templateId = 'core-sdlc',
    } = params;
    if (!teamId || !envId || !envName || !repoUrl || !tokenId) {
      throw new Error('ibanStoryTeam fixture requires { teamId, envId, envName, repoUrl, tokenId }');
    }
    // Pre-clean so a re-run starts from a clean slate (team+env, then token).
    await teardown.teardownTeam(ctx, { teamId, envId });
    await env.deleteFixtureToken(ctx, tokenId);
    // Clean GitHub state for this run — the chain asserts on freshly-created
    // issues/PRs/comments, number-agnostic, so a leftover feed must not linger.
    await gh.reset(ctx);
    // Token must exist BEFORE the env references it.
    await env.createFixtureToken(ctx, { id: tokenId, name: `${teamName || teamId} token` });
    await env.createFixtureEnv(ctx, {
      id: envId, name: envName, repoUrl, branch, githubTokenId: tokenId,
    });
    await team.materializeCoreSdlcTeam(ctx, {
      teamId, teamName: teamName || teamId, envId, templateId,
    });
    return { teamId, envId, tokenId };
  },
  async teardown(ctx, params = {}) {
    const { teamId, envId, tokenId } = params;
    if (teamId && envId) await teardown.teardownTeam(ctx, { teamId, envId });
    if (tokenId) await env.deleteFixtureToken(ctx, tokenId);
  },
};


/**
 * liveWiringTeam: the review-gate-live journey's precondition (#1010). A
 * MINIMAL live team (Business Analyst + Developer) materialised from an inline
 * bundle on a credential-less env pointing at the in-stack git remote — enough
 * for the Flow editor's live scope to wire a review gate against real member
 * configs, with no GitHub polling (token-less env) and no label chain to run.
 * FIXED ids: setup pre-cleans a leftover team+env; teardown removes both.
 *
 * @param {string} params.teamId - Team slug id to create.
 * @param {string} params.teamName - Team display name (the Flows list row).
 * @param {string} params.envId - Fixture environment id to create.
 * @param {string} params.envName - Fixture environment display name.
 * @param {string} params.repoUrl - Git URL the environment points at.
 * @example
 * fixtures:
 *   - fixture: liveWiringTeam
 *     params:
 *       teamId: wiring-demo
 *       teamName: Wiring Demo
 *       envId: wiring-demo-env
 *       envName: Wiring Demo
 *       repoUrl: "http://git-remote/e2e/fixture.git"
 */
const liveWiringTeam = {
  async setup(ctx, params = {}) {
    const { teamId, teamName, envId, envName, repoUrl, branch = 'main' } = params;
    if (!teamId || !envId || !envName || !repoUrl) {
      throw new Error('liveWiringTeam fixture requires { teamId, envId, envName, repoUrl }');
    }
    await teardown.teardownTeam(ctx, { teamId, envId });
    await env.createFixtureEnv(ctx, { id: envId, name: envName, repoUrl, branch });
    await team.materializeBundleTeam(ctx, {
      teamId, teamName: teamName || teamId, envId,
      bundle: {
        processTemplateVersion: 1,
        name: teamName || teamId,
        level: 'template',
        roles: [
          {
            id: 'business-analyst', displayName: 'Business Analyst', role: 'team-member',
            sessionPolicy: 'persistent',
            systemPrompt: 'You are the Business Analyst. You refine requirements into GitHub issues with acceptance criteria.',
            triggers: [],
            outcomes: { mode: 'anyOf', options: [
              { id: 'opens-issue', title: 'Opens issue', when: 'The issue is authored and ready for review', actions: [{ type: 'openIssue' }] },
            ] },
          },
          {
            id: 'developer', displayName: 'Developer', role: 'team-member',
            sessionPolicy: 'per-invocation',
            systemPrompt: 'You are the Developer. You implement a ready issue and open a pull request.',
            triggers: [],
          },
        ],
        gates: [],
        labels: [],
      },
    });
    return { teamId, envId };
  },
  async teardown(ctx, params = {}) {
    const { teamId, envId } = params;
    if (teamId && envId) await teardown.teardownTeam(ctx, { teamId, envId });
  },
};

/**
 * triggerAgent: the `triggers` journey's precondition (#733). Stands up ONE
 * Business-Analyst agent to hang triggers on, as cheaply as possible: a
 * credential-less Working Environment plus a single-member team. The env's
 * repository URL is deliberately a github.com URL so the trigger panel's repo
 * picker (parseRepoFullName, github.com-only) offers it for the github-event /
 * data-flow trigger types — while the token-less HTTPS clone is refused fast by
 * the orchestrator (no PAT ⇒ no username-prompt hang) and tolerated as a seed
 * warning, so the member still materialises. No token ⇒ the poller ignores the
 * repo, so nothing the journey configures ever fires: the config tour stays
 * deterministic (github-event firing end-to-end is already covered by the
 * iban-story journey). FIXED ids keep it re-runnable: setup pre-cleans a leftover
 * team+env, teardown removes the team (cascades to the member) + env.
 *
 * @param {string} params.teamId - Team slug id (its BA member is `<teamId>-business-analyst`).
 * @param {string} params.envId - Fixture environment id to create.
 * @param {string} params.envName - Fixture environment display name.
 * @param {string} params.repoUrl - github.com repo URL (parseable by the trigger repo picker).
 * @example
 * fixtures:
 *   - fixture: triggerAgent
 *     params:
 *       teamId: triggers-demo
 *       envId: triggers-demo-env
 *       envName: Triggers Demo
 *       repoUrl: "https://github.com/aee-e2e/triggers-demo.git"
 */
const triggerAgent = {
  async setup(ctx, params = {}) {
    const { teamId, envId, envName, repoUrl, branch = 'main' } = params;
    if (!teamId || !envId || !envName || !repoUrl) {
      throw new Error('triggerAgent fixture requires { teamId, envId, envName, repoUrl }');
    }
    await teardown.teardownTeam(ctx, { teamId, envId });
    await env.createFixtureEnv(ctx, { id: envId, name: envName, repoUrl, branch });
    await team.materializeTeam(ctx, {
      teamId, teamName: envName, envId, roles: ['business-analyst'],
    });
    return { teamId, envId };
  },
  async teardown(ctx, params = {}) {
    const { teamId, envId } = params;
    if (teamId && envId) await teardown.teardownTeam(ctx, { teamId, envId });
  },
};

// Delete every process draft carrying a given name (idempotent). Drafts get
// server-generated ids, so the journey renames its draft to a fixed name and the
// fixture cleans by that name — one deterministic, re-runnable surface.
//
// #2068 made the list per-user, which does NOT narrow this: the journey runner
// signs in as the env single-admin, whose scope is `all`, so it still sees and
// can delete every draft on the stack — including one a crashed prior run left
// behind under a different identity. It also means the drafts this fixture
// creates are stamped ownerless (the env admin has no user record) and are
// reachable only through that same admin path, which is exactly what keeps a
// re-run starting from a clean state.
async function deleteDraftsNamed(ctx, name) {
  const res = await ctx.request.get('/api/process/drafts');
  if (!res.ok()) return;
  const body = await res.json();
  const drafts = Array.isArray(body) ? body : (body.drafts || []);
  for (const d of drafts) {
    if (d && d.name === name && d.id) {
      await ctx.request.delete(`/api/process/drafts/${encodeURIComponent(d.id)}`);
    }
  }
}

/**
 * flowsDraft: the `flows-draft` journey's precondition (#733). The journey
 * authors a draft named `draftName` and never materialises it, so there is no
 * team/env/Matrix state — only the draft document. This fixture just pre-/post-
 * cleans any draft with that name so a re-run (or a crashed prior run) starts and
 * ends clean.
 *
 * @param {string} [params.draftName=Simple SDLC] - Draft name the journey renames to.
 * @example
 * fixtures:
 *   - fixture: flowsDraft
 *     params:
 *       draftName: Simple SDLC
 */
const flowsDraft = {
  async setup(ctx, params = {}) {
    const { draftName = 'Simple SDLC' } = params;
    await deleteDraftsNamed(ctx, draftName);
    return { draftName };
  },
  async teardown(ctx, params = {}) {
    const { draftName = 'Simple SDLC' } = params;
    await deleteDraftsNamed(ctx, draftName);
  },
};

/**
 * contextMountAgent: the context-mount journey's precondition (#1319).
 * KIND-LANE ONLY — the mount is a k8s hostPath, so "host" is the kind node
 * container: setup shells into it (docker/podman exec from the Playwright
 * host, the same engine that runs the kind provider) to seed the folder, then
 * stands up one standalone agent on a repo-less env and sets a READ-WRITE
 * multi-folder context mount via the real PATCH route (#1290 shape — the
 * folder gets a slug and mounts at /context/<slug> in the agent pod).
 * The agent is enabled last; the journey's first browse poll absorbs the pod
 * startup window.
 *
 * ENSURE, NEVER DELETE: deleting an agent deactivates its Matrix user, and a
 * conduwuit deactivation is permanent — recreating the same fixed id then
 * fails with M_USER_DEACTIVATED. So setup treats an existing agent/env as
 * reusable (409 = fine) and teardown only DISABLES the agent (pod gone, node
 * folder removable) — same lifecycle as stack-up.sh's standalone e2e-agent.
 * The pre-clean also disables first: re-seeding the node folder while a live
 * pod bind-mounts it would leave that pod staring at the deleted inode.
 *
 * @param {string} params.agentId - Standalone agent id to create.
 * @param {string} params.envId - Repo-less fixture environment id.
 * @param {string} params.envName - Environment display name.
 * @param {string} params.hostDir - Absolute folder path INSIDE the kind node.
 * @param {string} params.mountName - Mount display name (also its slug).
 * @param {string} params.seedFile - File seeded into the folder before mount.
 * @param {string} params.seedContent - Its content (asserted in the viewer).
 * @example
 * fixtures:
 *   - fixture: contextMountAgent
 *     params:
 *       agentId: ctx-demo-agent
 *       envId: ctx-demo-env
 *       envName: Context Demo
 *       hostDir: /opt/e2e-context/specs
 *       mountName: specs
 *       seedFile: brief.md
 *       seedContent: "Context briefing — seeded on the kind node."
 */
const contextMountAgent = {
  async setup(ctx, params = {}) {
    const { agentId, envId, envName, hostDir, mountName, seedFile, seedContent } = params;
    if (!agentId || !envId || !envName || !hostDir || !mountName || !seedFile) {
      throw new Error('contextMountAgent fixture requires { agentId, envId, envName, hostDir, mountName, seedFile }');
    }
    // Pre-clean: stop a leftover pod BEFORE recreating the node folder it
    // bind-mounts, then re-seed fresh. 404 (never existed) is fine.
    await ctx.request.put(`/api/agents/${encodeURIComponent(agentId)}`, { data: { enabled: false } });
    context.removeHostDir(hostDir);
    context.seedHostDir(hostDir, seedFile, seedContent || '');

    // Repo-less env (no clone, no poller) — the mount is the point here.
    // 409 = left over from a prior run, reused as-is.
    const envRes = await ctx.request.post('/api/environments', { data: { id: envId, name: envName } });
    if (!envRes.ok() && envRes.status() !== 409) {
      throw new Error(`contextMountAgent: create env ${envId} failed HTTP ${envRes.status()}: ${await envRes.text()}`);
    }
    const agentRes = await ctx.request.post('/api/agents', {
      data: {
        id: agentId,
        displayName: envName,
        role: 'agent',
        environmentId: envId,
        systemPrompt: 'You are a test agent with a mounted context folder.',
      },
    });
    if (!agentRes.ok() && agentRes.status() !== 409) {
      throw new Error(`contextMountAgent: create agent ${agentId} failed HTTP ${agentRes.status()}: ${await agentRes.text()}`);
    }
    // The rw mount, set BEFORE enabling — it is baked at pod spawn time.
    const mountRes = await ctx.request.patch(`/api/agents/${encodeURIComponent(agentId)}/context-mount`, {
      data: { mounts: [{ path: hostDir, name: mountName, readWrite: true }] },
    });
    if (!mountRes.ok()) {
      throw new Error(`contextMountAgent: set context mount failed HTTP ${mountRes.status()}: ${await mountRes.text()}`);
    }
    const enableRes = await ctx.request.put(`/api/agents/${encodeURIComponent(agentId)}`, {
      data: { enabled: true },
    });
    if (!enableRes.ok()) {
      throw new Error(`contextMountAgent: enable agent failed HTTP ${enableRes.status()}: ${await enableRes.text()}`);
    }
    return { agentId, envId, hostDir };
  },
  async teardown(ctx, params = {}) {
    const { agentId, hostDir } = params;
    // Disable only (see the ensure-never-delete note above); agent + env stay
    // for the next run to reuse. Folder removal is safe once the pod is gone.
    if (agentId) await ctx.request.put(`/api/agents/${encodeURIComponent(agentId)}`, { data: { enabled: false } });
    if (hostDir) context.removeHostDir(hostDir);
  },
};

// ── usageData helpers (#1505) ───────────────────────────────────────────────
// The Token Usage figures are read by the admin-console from JSONL day files on
// the shared /workspace volume (admin-console/api/usage-log.js → /workspace/usage).
// There is no HTTP ingest on the console side (agents post usage to the
// orchestrator's internal API, unreachable from the Playwright host), so the
// fixture seeds the files by exec-ing into the compose admin-console container —
// the same podman/docker vantage point the context fixture uses for the kind node.
const USAGE_PROJECT = process.env.E2E_COMPOSE_PROJECT || 'aee-e2e';

// Resolve the running admin-console container (compose sets a fixed
// container_name `<project>-admin-console`). Probe podman then docker, mirroring
// the engine fallback the context step uses.
function usageConsoleContainer() {
  let lastErr;
  for (const engine of ['podman', 'docker']) {
    try {
      const out = execFileSync(engine, ['ps', '--format', '{{.Names}}'], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      });
      const name = out.split('\n').map((s) => s.trim())
        .find((n) => n.startsWith(USAGE_PROJECT) && n.includes('admin-console'));
      if (name) return { engine, name };
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(
    `usageData fixture: no running ${USAGE_PROJECT}*admin-console container found via podman or docker`
    + (lastErr ? `: ${lastErr.message}` : ''),
  );
}

function execInConsole(argv) {
  const { engine, name } = usageConsoleContainer();
  return execFileSync(engine, ['exec', name, ...argv], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
}

// Two fixed record dates (deliberately historical, so the figures only appear
// under the "All time" range — insulating them from the default 7-day window
// and from anything the live stack logs today).
const USAGE_DAYS = ['2024-06-01', '2024-06-02'];

// Deterministic seed: three invocations across two agents, all under `teamId`.
// Totals — input 3,900 · output 1,400 · cache-write 600 · cache-read 1,100 ·
// grand total 7,000 · 3 invocations; per-agent totals alpha 6,000 / beta 1,000.
function usageSeed(teamId) {
  const rec = (ts, agentId, input, output, cacheWrite, cacheRead) => JSON.stringify({
    ts,
    agentId,
    teamId,
    provider: 'anthropic',
    model: 'claude-sonnet-5',
    tokens: {
      input, output, cacheCreationInput: cacheWrite, cacheReadInput: cacheRead,
    },
  });
  return {
    '2024-06-01': `${rec('2024-06-01T09:00:00.000Z', 'token-usage-alpha', 1000, 500, 200, 300)}\n`,
    '2024-06-02': `${[
      rec('2024-06-02T09:00:00.000Z', 'token-usage-alpha', 2000, 800, 400, 800),
      rec('2024-06-02T10:00:00.000Z', 'token-usage-beta', 900, 100, 0, 0),
    ].join('\n')}\n`,
  };
}

function seedUsageFile(day, content) {
  // Content is a single argv element (execFileSync — no shell), so its quotes
  // and newlines pass through untouched; `printf %s` writes them verbatim.
  execInConsole(['sh', '-c',
    'mkdir -p /workspace/usage && printf %s "$2" > "/workspace/usage/usage-$1.jsonl"',
    'sh', day, content]);
}

function removeUsageFiles() {
  execInConsole(['sh', '-c',
    'for d in "$@"; do rm -f "/workspace/usage/usage-$d.jsonl"; done',
    'sh', ...USAGE_DAYS]);
}

/**
 * usageData: the Token Usage journey's precondition (#1505). Seeds deterministic
 * usage records under a dedicated human Team and creates that Team, so the page's
 * Team filter can narrow to it and the figures stay stable across re-runs on the
 * same stack (other usage the stack logs carries a different teamId and is
 * filtered out). Setup pre-cleans a leftover team + seed files; teardown removes
 * both — one idempotent, re-runnable surface.
 *
 * @param {string} params.teamId - Team slug id to create and tag the seeded records with.
 * @param {string} params.teamName - Team display name (shown in the page's Team filter).
 * @example
 * fixtures:
 *   - fixture: usageData
 *     params:
 *       teamId: token-usage-demo
 *       teamName: Token Usage Demo
 */
const usageData = {
  async setup(ctx, params = {}) {
    const { teamId, teamName } = params;
    if (!teamId || !teamName) {
      throw new Error('usageData fixture requires { teamId, teamName }');
    }
    // Pre-clean: drop leftover seed files and any leftover team from a crashed run.
    removeUsageFiles();
    await ctx.request.delete(`/api/admin/teams/${encodeURIComponent(teamId)}`);
    const res = await ctx.request.post('/api/admin/teams', { data: { id: teamId, name: teamName } });
    if (!res.ok() && res.status() !== 409) {
      throw new Error(`usageData: create team ${teamId} failed HTTP ${res.status()}: ${await res.text()}`);
    }
    for (const [day, content] of Object.entries(usageSeed(teamId))) {
      seedUsageFile(day, content);
    }
    return { teamId };
  },
  async teardown(ctx, params = {}) {
    const { teamId } = params;
    removeUsageFiles();
    if (teamId) await ctx.request.delete(`/api/admin/teams/${encodeURIComponent(teamId)}`);
  },
};

/**
 * knowledgeTeam: the Knowledge-chapter journey's precondition (#1784). Gives the
 * /knowledge page deterministic content to show WITHOUT depending on any agent
 * having actually run (a fresh team has learned nothing yet): it (1) seeds a
 * global-pool skill so the team-flow's skills lane and the activation beat have a
 * real skill to activate, (2) creates a credential-less Working Environment on
 * the in-stack git remote (no external deps), and (3) materialises a small
 * two-member team (BA + Developer) so the page shows a real team with real
 * members — enough to prove member-level activation on the activation beat.
 *
 * Composes the existing #668 fixture steps (knowledge.createGlobalSkill,
 * env.createFixtureEnv, team.materializeTeam) — no duplicate logic. FIXED ids
 * keep the screenshots deterministic (§7): setup pre-cleans a leftover team+env
 * and the pool skill from a crashed prior run, and teardown removes the team,
 * env and skill this journey created — one idempotent, re-runnable surface.
 *
 * @param {string} params.teamId - Team slug id to create (also its member prefix).
 * @param {string} params.envId - Fixture environment id to create.
 * @param {string} params.envName - Fixture environment display name.
 * @param {string} params.repoUrl - Git URL the environment points at (the in-stack git remote).
 * @param {string} params.skillName - Global-pool skill to seed and activate on the team.
 * @param {string} [params.branch=main] - Branch to track.
 * @param {string[]} [params.roles=[business-analyst, developer]] - Catalog role ids for the members.
 * @example
 * fixtures:
 *   - fixture: knowledgeTeam
 *     params:
 *       teamId: knowledge-demo
 *       envId: knowledge-demo-env
 *       envName: Knowledge Demo
 *       repoUrl: "http://git-remote/e2e/fixture.git"
 *       skillName: iban-validation
 */
const knowledgeTeam = {
  async setup(ctx, params = {}) {
    const {
      teamId, envId, envName, repoUrl, skillName, branch = 'main',
      roles = ['business-analyst', 'developer'],
    } = params;
    if (!teamId || !envId || !envName || !repoUrl || !skillName) {
      throw new Error('knowledgeTeam fixture requires { teamId, envId, envName, repoUrl, skillName }');
    }
    // Pre-clean so a re-run starts from a clean slate (team+env, then the pool skill).
    await teardown.teardownTeam(ctx, { teamId, envId });
    await knowledge.deleteGlobalSkill(ctx, { name: skillName });
    // Seed the global skill BEFORE the team so the activation beat has a candidate.
    await knowledge.createGlobalSkill(ctx, { name: skillName });
    await env.createFixtureEnv(ctx, { id: envId, name: envName, repoUrl, branch });
    await team.materializeTeam(ctx, { teamId, envId, roles });
    return { teamId, envId, skillName, memberCount: roles.length };
  },
  async teardown(ctx, params = {}) {
    const { teamId, envId, skillName } = params;
    // Team first (drops the grant + member copies), then the now-unreferenced skill.
    if (teamId && envId) await teardown.teardownTeam(ctx, { teamId, envId });
    if (skillName) await knowledge.deleteGlobalSkill(ctx, { name: skillName });
  },
};

const FIXTURES = {
  teamEnv, ibanStoryTeam, triggerAgent, flowsDraft, liveWiringTeam, contextMountAgent, usageData,
  knowledgeTeam,
};

function resolveFixture(name) {
  const fx = FIXTURES[name];
  if (!fx) {
    const known = Object.keys(FIXTURES).sort().join(', ') || '(none)';
    throw new Error(`journey-runner: unknown fixture "${name}". Known fixtures: ${known}`);
  }
  return fx;
}

module.exports = { resolveFixture, FIXTURES };
