'use strict';

const {
  MatrixClient,
  SimpleFsStorageProvider,
} = require("matrix-bot-sdk");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { createTeamsStore, DEFAULT_TEAM_ID } = require("./teams-store");
const { resolveAgentTenant, planTenantBackfill } = require("./agent-tenant");
const { needsAdoption, planAdoption, planBootstrapMembership } = require("./default-team-adoption");
const { makeSkillSourceResolver, parseSkillDescription } = require("./skill-source");
const {
  normalizeKnowledgeStore,
  knowledgeAutonomyLevel,
  knowledgeReviewEnabled,
  knowledgeConvergenceConfig,
  resolvePromotionGates,
  knowledgeCurationConfig,
  resolveDecayHorizonDays,
  normalizeLoadTriggers,
  mergeTeamKnowledgeConfig,
  buildDefaultManifest,
  kindFilePath,
  parseEntry: parseKnowledgeEntry,
  serializeEntry: serializeKnowledgeEntry,
  PROMOTION_TRANSITIONS,
  GATE_MODES,
  KINDS: KNOWLEDGE_KINDS,
} = require("./knowledge-store");
const knowledgeSync = require("./knowledge-sync");
const { createKeyedMutex } = require("./keyed-mutex");
const flowEmit = require("./flow-emit");
const wakeAgent = require("./wake-agent");
const labelFastPath = require("./github-label-fastpath");
const { LabelDedupMarkers } = require("./label-dedup-markers");
const githubEventLog = require("./github-event-log");

// Shared in-memory dedup markers for the internal label fast-path (#1858). The
// POST /internal/github-label-applied handler writes a marker per woken
// listener; the poller (given the same instance) consumes it in _fanOutBatch so
// the later Events-API delivery of the same label doesn't wake the agent twice.
const labelDedupMarkers = new LabelDedupMarkers();
const hillClimbMetrics = require("./hill-climb-metrics");
const hillClimbSweep = require("./hill-climb-sweep");
const hillClimbCards = require("./hill-climb-cards");
const hillClimbApply = require("./hill-climb-apply");
const hillClimbVerdict = require("./hill-climb-verdict");
const knowledgeFeed = require("./knowledge-feed");
const { buildKnowledgeDigest, foldVisibleEntries, DIGEST_FILENAME: KNOWLEDGE_DIGEST_FILENAME } = require("./knowledge-digest");
const memoryMigration = require("./memory-migration");
const knowledgeConvergence = require("./knowledge-convergence");
const knowledgeCurator = require("./knowledge-curator");
const knowledgeDomains = require("./knowledge-domains");
const knowledgeRouting = require("./knowledge-routing");
const knowledgeDistillation = require("./knowledge-distillation");
const knowledgeConsolidation = require("./knowledge-consolidation");
const knowledgeCleanup = require("./knowledge-cleanup");
const knowledgeRetrieval = require("./knowledge-retrieval");
const knowledgeDecay = require("./knowledge-decay");
const knowledgeEmbeddings = require("./knowledge-embeddings");
const knowledgeHygiene = require("./knowledge-hygiene");
const skillReconcile = require("./skill-reconcile");
// #1511: three-way team-member prompt modes. Byte-identical twin of
// admin-console/api/prompt-modes.js — the team-prompt propagation path
// (updateTeamPrompt) re-composes inheriting AND additional members through it.
const { PROMPT_MODES, resolvePromptMode, composeMemberPrompt } = require("./prompt-modes");
const { createLlmAuthFlowManager } = require("./llm-auth-flow");
const agentGitOps = require("./agent-git-ops");
const credentialResolution = require("./credential-resolution");
const ownershipMigration = require("./ownership-migration");
const gitPanelOps = require("./git-panel-ops");
const { resolveCloneTarget } = require("./clone-target");
const { assessConversionEligibility, planTeamConversion } = require("./team-conversion");
const { syncAgentRepoPlan, summarizeRepoResults, repoDivergence } = require("./repo-sync");
// Agent-scoped repositories (#2067): a repository attached to ONE agent,
// outside its Working Environment. Every decision — shape, the merged
// environment+agent view, collision/credential refusals, what a removal
// deletes — lives in the pure module; this file is its fs/clone half.
const {
  normalizeAgentRepositories,
  resolveAgentRepositories,
  planAgentRepoAttach,
  planAgentRepoDetach,
  removalFacts,
} = require("./agent-repositories");
const { computeTeamRoster, createVerdictStore } = require("./loop-verify");
const { assembleClaudeMd, buildMemoryHint, SCOPED_KNOWLEDGE_FILENAME } = require("./prompt-assembly");
const { readMaintenanceState } = require("./maintenance-state-reader");
// Browsing the read-only host-folder context mount (#1286): the pure path /
// program / parsing rules, plus the one-shot exec that runs them where the
// folder actually exists — inside the agent's own container.
const {
  CONTEXT_FILE_MAX_BYTES,
  CONTEXT_DOWNLOAD_MAX_BYTES,
  BROWSE_TIMEOUT_MS,
  normalizeContextRel,
  buildListArgv,
  buildReadArgv,
  parseBrowseOutput,
  statusForBrowseCode,
  sortContextItems,
} = require("./context-browse");
// Resolve an agent config to the ordered list of host folders to mount (#1290,
// generalising #1283's single folder) — handles both the multi-folder field and
// the legacy single-folder fields.
const { resolveContextMounts, CONTEXT_MOUNT_TARGET } = require("./context-mount");
const {
  buildDeleteArgv,
  buildMoveArgv,
  buildPrepareUploadArgv,
  statusForWriteCode,
  sanitizeUploadName,
  CONTEXT_UPLOAD_MAX_BYTES,
  WRITE_TIMEOUT_MS,
} = require("./context-write");
const { buildTar } = require("./tar-single");
// In-container exec seam (context browse/write): libpod exec on podman,
// pods/exec on kubernetes — selected the same way as container-runtime.
const { execInAgentContainer, putArchiveToAgentContainer } = require("./container-exec-runtime");
const { effectiveSkills, migrateSkillGrant, planSkillSync, planAgentGrantEdit } = require("./skill-grants");
// Plugin system (#1516). The grant is the sibling of the skill grant — it lives
// on the agent construct, never on the environment — and (de)activation is the
// same additive live file sync, no respawn (#1547).
const { effectivePlugins, planAgentPluginGrantEdit, planPluginSync, pluginGrantFor } = require("./plugin-grants");
const { planWorkspaceSync } = require("./plugin-sync");
const { resolveAgentStateDir } = require("./agent-state-dir");
const { resolveScopeId } = require("./plugin-scope");
const pluginRegistry = require("./plugin-registry");
const pluginRuntime = require("./plugin-runtime");
const { resolveScopeGithubCredentials, buildTeamFlowLabels } = require("./plugin-github-creds");
const { assertGranularityGrantable, defaultGranularity } = require("./plugin-manifest");
const { isTeamDisabled, newMemberFieldsForTeam, planTeamDisable, planTeamEnable, isMemberLockedByTeam, deriveBusyState, httpStatusForAgentActionError, httpStatusForTeamActionError } = require('./team-disable');
const { isAutonomousState, autonomyChanged } = require("./agent-autonomy");
const { isSupportedAgentRole, unsupportedRoleNote } = require("./agent-role-support");
const { buildEnsureUserCommands, buildReactivateCommands } = require("./matrix-admin-commands");
const matrixLoginRetry = require("./matrix-login-retry");
const humanMatrixIdentity = require("./human-matrix-identity");
const { createHumanMatrixStore } = require("./human-matrix-store");
const skillManifest = require("./skill-manifest");
const skillDelivery = require("./skill-delivery");
const skillCommands = require("./skill-commands");
const usageLog = require("./usage-log");
const usageQuery = require("./usage-query");
const prEventsLog = require("./pr-events-log");
const usageRecordsReader = require("./usage-records-reader");
const { workItemDetail } = require("./work-items");
const prTokenComment = require("./pr-token-comment");
const prCommentConfig = require("./pr-comment-config");
const { parseRepoFullName: ghParseRepoFullName } = require("./github-poller");
const ticketStore = require("./ticket-store");
const pendingQueue = require("./pending-queue");
const { buildFlowModel, detectFlowAnomalies } = require("./flow-anomaly-detector");
const flowAnomalySweep = require("./flow-anomaly-sweep");

// ── Read-write context mount helpers (writing into a mounted host folder) ──
// A caller path is RELATIVE to /context. For a single legacy folder the mount
// target is exactly /context, so everything belongs to it; for a multi-folder
// set each target is /context/<slug>, so the rel's first segment names the
// folder. Returns the matching resolved mount (carrying `readWrite`) or null —
// the route refuses a write that resolves to no mount or to a read-only one.
function resolveContextMountForRel(mounts, rel) {
  if (!Array.isArray(mounts) || mounts.length === 0) return null;
  const clean = String(rel == null ? '' : rel).replace(/^\/+/, '');
  for (const m of mounts) {
    if (!m || typeof m.target !== 'string') continue;
    if (m.target === CONTEXT_MOUNT_TARGET) return m; // legacy single folder
    const slug = m.target.slice(CONTEXT_MOUNT_TARGET.length + 1); // strip "/context/"
    if (!slug) continue;
    if (clean === slug || clean.startsWith(slug + '/')) return m;
  }
  return null;
}

// Run one context WRITE_PROGRAM exec and parse it. Resolves { ok:true, result }
// or { ok:false, status, error, code } — never throws for an expected failure,
// mirroring the browse path so the route stays free of exit-code archaeology.
async function runContextWriteExec(id, argv) {
  let out;
  try {
    out = await execInAgentContainer(id, argv, { timeoutMs: WRITE_TIMEOUT_MS, maxBytes: 256 * 1024 });
  } catch (err) {
    const code = err && err.code ? err.code : 'exec-failed';
    const status = code === 'no-container' ? 409 : code === 'timeout' ? 504 : 502;
    const error = code === 'no-container'
      ? 'The agent is not running, so its context folder cannot be modified'
      : `Modifying the context folder failed (${code})`;
    return { ok: false, status, error, code };
  }
  const parsed = parseBrowseOutput(out.stdout);
  if (!parsed.ok) {
    return { ok: false, status: statusForWriteCode(parsed.code), error: parsed.error, code: parsed.code };
  }
  return { ok: true, result: parsed.result };
}

// ============================================================
// Config
// ============================================================
const HOMESERVER = process.env.MATRIX_HOMESERVER;
const CONDUWUIT_ADMIN_TOKEN = process.env.CONDUWUIT_ADMIN_TOKEN;
const CONDUWUIT_ADMIN_ROOM = process.env.CONDUWUIT_ADMIN_ROOM;
// This stack's instance identity. Agent containers are stamped with it
// (`aee.instance` label, see spawn-container.js) so eviction & reconcile scope
// to THIS stack when multiple instances share one Podman store. Configured via
// AEE_INSTANCE_ID in .env, defaulting to COMPOSE_PROJECT_NAME. MUST resolve to
// the same value as spawn-container.js's INSTANCE_ID (identical precedence).
const INSTANCE_ID = process.env.AEE_INSTANCE_ID || process.env.COMPOSE_PROJECT_NAME || 'agent-studio-314092';
const INSTANCE_LABEL_KEY = 'aee.instance';
// The platform's own per-agent label, stamped on every agent container/pod by
// both spawn implementations. It — not the image ancestor — is how this file
// finds agent containers, so a container spawned from a per-environment
// toolchain variant is still found (#1940 AC4). Schema constant; keep in sync
// with AGENT_LABEL_KEY in spawn-container.js / spawn-kubernetes-pod.js.
const AGENT_ID_LABEL_KEY = 'aee.agent.id';

const AGENTS_DIR = "/workspace/agents";
// The filename CLAUDE.md references for the authored prompt. The seeded
// CLAUDE.md carries `@AGENT-PROMPT.md` rather than an inlined copy, so editing
// this file alone re-takes effect on the next session (#510).
const AGENT_PROMPT_FILENAME = "AGENT-PROMPT.md";
// Control-plane state pushed by agents (#185). Lives on a dedicated volume
// mounted only by the orchestrator + admin-console, so monitoring (status,
// session-log) no longer depends on reading an agent's own workspace — the
// prerequisite for giving each agent its own isolated volume.
const CONTROL_DIR = "/control/agents";
// Phase 2 (#185): when per-agent volume isolation is on the orchestrator can no
// longer write control→agent state (triggers, pending-triggers, the pushed
// session-pointer mirror) into the agent's own volume, so the canonical copy
// lives on the control plane and the agent pulls it over HTTP. With the flag off
// (the default) these stay on the shared pool subpath the agent reads directly,
// so the resolver below is a no-op and behavior is byte-identical to today.
const PER_AGENT_VOLUME = process.env.AEE_PER_AGENT_VOLUME === '1';
const BLUEPRINTS_DIR = "/workspace/blueprints";
const WORKSPACE = "/workspace";
// Shared Agent Learning (Phase 2): the orchestrator-maintained canonical KB
// clone per team (aggregator source of truth) + the append-only live-feed file
// the admin-console tails. Both sit on the shared /workspace volume; neither is
// inside a team's git clone.
const KNOWLEDGE_CLONE_ROOT = "/workspace/knowledge";
const KNOWLEDGE_EVENTS_DIR = "/workspace/knowledge-events";
const KNOWLEDGE_EVENTS_FILE = path.join(KNOWLEDGE_EVENTS_DIR, "events.jsonl");
const KNOWLEDGE_REFRESH_MIN_MS = 30_000;
// Per-team promotion-candidate store (Phase 3). One JSON array file per team,
// written by the orchestrator (collector + agent nominations), read + lifecycle-
// updated by the admin-console promotion routes.
const KNOWLEDGE_SUGGESTIONS_DIR = "/workspace/knowledge-suggestions";
// Per-team set of canonical ids the operator archived (Phase 4, non-destructive
// curation). One JSON array file per team; overlaid onto the canonical <kind>.jsonl
// as status:"archived" on every collector pass, so the archive is durable across
// re-projections (shards, the source of truth, are never touched).
const KNOWLEDGE_ARCHIVED_DIR = "/workspace/knowledge-archived";
// Per-team operator review decisions (supervised-review mode). One JSON map per
// team { <canonicalId>: "approved"|"rejected" }; an absent id is "pending".
const KNOWLEDGE_REVIEW_DIR = "/workspace/knowledge-review";
// Per-team bitemporal-validity sidecar (#916). One JSON map per team
// { <canonicalId>: { validTo?, supersededBy? } }, overlaid as FIELDS onto the
// canonical entry at re-projection (status untouched — readers derive "expired").
const KNOWLEDGE_VALIDITY_DIR = "/workspace/knowledge-validity";
// Per-team read-side retrieval aggregate (#915): one compact JSON per team, one
// row per entry (never an unbounded log, never a line in events.jsonl).
const KNOWLEDGE_RETRIEVAL_DIR = "/workspace/knowledge-retrieval";
// Per-team auto-load trigger sidecar (#917): { <canonicalId>: loadTriggers[] },
// overlaid as a FIELD onto the canonical entry at re-projection (like validity).
const KNOWLEDGE_TRIGGERS_DIR = "/workspace/knowledge-triggers";
// Per-team embedding-vector cache (#918): derived artifacts, OUTSIDE the git KB
// (recomputable at will), computed only by the nightly backstop pass.
const KNOWLEDGE_VECTORS_DIR = "/workspace/knowledge-vectors";
const TEMPLATE_WORKSPACE = "/template-workspace";
// Agent id grammar — mirrors AGENT_ID_RE in admin-console/api/api.js. Used to
// validate ids that arrive from outside (e.g. on import).
const AGENT_ID_RE = /^[a-zA-Z0-9_-]+(\.[a-zA-Z0-9_-]+)*$/;
const ENVIRONMENTS_DIR = "/workspace/environments";
const SSH_KEYS_DIR = path.join(ENVIRONMENTS_DIR, "_keys");
const SSH_KEYS_INDEX = path.join(SSH_KEYS_DIR, "index.json");
const GH_TOKENS_DIR = path.join(ENVIRONMENTS_DIR, "_tokens");
const LLM_ENDPOINTS_INDEX = "/workspace/llm-endpoints/index.json";
const LLM_KEYS_DIR = "/workspace/llm-endpoints/_keys";
const MCP_SERVERS_DIR = "/workspace/mcp-servers";
const MCP_CREDENTIALS_KEYS_DIR = "/workspace/mcp-credentials/_keys";

// Teams data model (#299): the human collaboration & visibility scope. Stored
// under /workspace alongside the other persistent collections; the orchestrator
// is the single writer for tenancy/identity data and owns the startup
// bootstrap + ownership backfill below.
const teamsStore = createTeamsStore({ root: WORKSPACE });
// Per-human Matrix credentials (#1458). Deliberately a SEPARATE store from the
// user records above: `sanitizeUser()` is a convention applied at the store
// boundary, and users/index.json is also read directly by the admin-console —
// so a live access token does not belong on that record. See
// human-matrix-store.js for the full reasoning.
const humanMatrixStore = createHumanMatrixStore({ root: WORKSPACE });
// Two-tier skill resolution (#306): owning team's pool wins over the global pool.
const { resolveSkillSourceDir, teamSkillsDir } = makeSkillSourceResolver({
  workspace: WORKSPACE,
  templateWorkspace: TEMPLATE_WORKSPACE,
  defaultTeamId: DEFAULT_TEAM_ID,
});

// Resolve the LLM binding for an explicit endpoint id + model pin:
//  - reads /workspace/llm-endpoints/index.json
//  - looks up the endpoint by id
//  - reads the auth token from _keys/<authTokenId>
// Returns { authType, baseUrl, token, defaultModelId } or null if no endpoint
// id was given or the endpoint is missing — in that case the caller falls back
// to the global ANTHROPIC_* env vars from `.env`.
//
// Model resolution order: modelPin (explicit env/agent pin) → endpoint registry
// default → null (lets the Claude CLI pick from .env). The endpoint fallback
// exists so legacy envs that never picked a model still inherit the
// operator-configured default once one is set in the Model Registry.
function resolveLlmBinding(endpointId, modelPin, { context } = {}) {
  if (!endpointId) return null;
  let list;
  try {
    list = JSON.parse(fs.readFileSync(LLM_ENDPOINTS_INDEX, "utf8"));
  } catch {
    return null;
  }
  const ep = Array.isArray(list) ? list.find(e => e.id === endpointId) : null;
  if (!ep) {
    console.error(`[Orchestrator] LLM endpoint '${endpointId}'${context ? ` (${context})` : ""} not found — falling back to .env`);
    return null;
  }
  let token = "";
  if (ep.authTokenId) {
    try {
      token = fs.readFileSync(path.join(LLM_KEYS_DIR, ep.authTokenId), "utf8").trim();
    } catch (err) {
      console.error(`[Orchestrator] Cannot read LLM token for endpoint ${ep.id}: ${err.message}`);
    }
  }
  return {
    endpointId: ep.id,
    name: ep.name || ep.id,
    authType: ep.authType === "oauth-token" ? "oauth-token" : "api-key",
    baseUrl: ep.baseUrl || "",
    token,
    defaultModelId: modelPin || ep.defaultModelId || null,
  };
}

// Resolve the effective LLM binding for an agent: a per-agent provider override
// (`cfg.llmEndpointOverride`) wins over the environment's `llmEndpointId`. The
// model pin still comes from the environment (`env.defaultModelId`); the agent's
// own `modelOverride` is applied later in startAgentProcess.
function resolveLlmBindingForAgent(cfg, env) {
  const endpointId = cfg?.llmEndpointOverride || env?.llmEndpointId || null;
  if (!endpointId) return null;
  const ctx = cfg?.llmEndpointOverride
    ? `agent=${cfg.id} override`
    : `env=${env?.id}`;
  return resolveLlmBinding(endpointId, env?.defaultModelId, { context: ctx });
}

// #1213: resolve the assist-synthesis binding for a team's autonomous synthesis
// (curator auto-promotion, skill distillation). The team agent's optional
// `assistLlmEndpointId` names the provider these session-less calls must bill
// against; it is validated against the team's usable providers (non-oauth) the
// same way `assistSelectableEndpoint` gates the console-side header selection.
// Returns `{ baseUrl, token, model }` when set + usable, else null → the caller
// falls back to the `.env` proxy exactly as before (unset, deleted id, oauth
// seat, foreign team, or unreadable token all fail SOFT with a logged warning).
// The token is read locally from `_keys/` and never leaves this process.
function resolveAssistBindingForTeam(teamId) {
  if (!teamId) return null;
  let cfg = null;
  try { cfg = loadAgentConfig(teamId); } catch { cfg = null; }
  const endpointId = cfg && typeof cfg.assistLlmEndpointId === "string" ? cfg.assistLlmEndpointId.trim() : "";
  if (!endpointId) return null; // unset → .env as today (no warning: the common case)
  // Endpoints are scoped to the human tenant that owns the agents, mirroring
  // spawn-binding + admin-console usableEndpointsForTeam. `parentTeamId` names
  // the Agent Team, not the tenant — resolve the parent's `teamId` instead.
  const tenant = resolveAgentTenant(cfg, (id) => {
    try { return loadAgentConfig(id); } catch { return null; }
  });
  let index = null;
  try { index = JSON.parse(fs.readFileSync(LLM_ENDPOINTS_INDEX, "utf8")); } catch { index = null; }
  const pick = assistBinding.pickAssistEndpoint(index, endpointId, tenant);
  if (!pick.ep) {
    console.warn(`[Orchestrator] assist endpoint '${endpointId}' for team ${teamId} not usable (${pick.reason}) — falling back to .env`);
    return null;
  }
  // Reuse resolveLlmBinding for the impure token read + model default; it never
  // filters, so the usability decision above stays the single gate.
  const bound = resolveLlmBinding(endpointId, null, { context: `assist team=${teamId}` });
  if (!bound || bound.authType === "oauth-token" || !bound.baseUrl || !bound.token) {
    console.warn(`[Orchestrator] assist endpoint '${endpointId}' for team ${teamId} unresolved (base/token/oauth) — falling back to .env`);
    return null;
  }
  const model = bound.defaultModelId
    || process.env.ANTHROPIC_SYNTHESIS_MODEL
    || process.env.ANTHROPIC_DEFAULT_SONNET_MODEL
    || process.env.ANTHROPIC_MODEL;
  if (!model) {
    console.warn(`[Orchestrator] assist endpoint '${endpointId}' for team ${teamId} has no model — falling back to .env`);
    return null;
  }
  return { baseUrl: bound.baseUrl, token: bound.token, model };
}

// #1214: resolve a synthesis binding from an assist selection (endpointId + model)
// that the admin-console already validated against the caller's teams (the
// `X-Assist-Model` header, `resolveAssistTarget`). Only the IDS travel the internal
// HTTP hop — the token is read locally from `_keys/` here and never leaves this
// process. Returns `{ baseUrl, token, model }` when usable, else null → the caller
// falls back to the `.env` proxy (unset selection, deleted id, oauth seat, or an
// unreadable token all fail SOFT). The console already gated team visibility, so
// this only re-checks resolvability, mirroring resolveAssistBindingForTeam's tail.
function resolveAssistBindingFromSelection(endpointId, modelId) {
  if (!endpointId) return null; // no selection forwarded → .env as today
  const bound = resolveLlmBinding(endpointId, modelId || null, { context: "assist domain-bootstrap" });
  if (!bound || bound.authType === "oauth-token" || !bound.baseUrl || !bound.token) return null;
  const model = bound.defaultModelId // resolveLlmBinding returns modelPin (the user's model) || endpoint default
    || process.env.ANTHROPIC_SYNTHESIS_MODEL
    || process.env.ANTHROPIC_DEFAULT_SONNET_MODEL
    || process.env.ANTHROPIC_MODEL;
  if (!model) return null;
  return { baseUrl: bound.baseUrl, token: bound.token, model };
}

const { execFile, execFileSync } = require("child_process");
const execFileP = require("util").promisify(execFile);
// Container-runtime seam: Podman (default) or Kubernetes, per AEE_CONTAINER_RUNTIME.
const { spawnContainer, libpodRequest, removePerAgentVolume, removePerAgentNetwork, reseedPerAgentVolume, perAgentNetworkName, DEFAULT_AGENT_IMAGE } = require("./container-runtime");
// Per-Working-Environment agent toolchain (#1940). The image an agent is
// spawned from is decided HERE — the seam only executes it — because the
// decision needs the agent's environment, which no spawn adapter loads.
const { normalizeRegistry, resolveAgentImage, normalizeRuntime } = require("./toolchain-registry");
// Fast/background split of agent deletion (#1791): graceful-role decision +
// the in-memory "teardown in progress" guard for same-id re-create safety.
const { isGracefulDeleteRole, TeardownRegistry, cascadeChildIds } = require("./agent-delete-plan");
const agentOrphans = require("./agent-orphans");
// One process-wide registry: the delete fast phase arms it, the background
// phase clears it, and every create/clone/import/materialise path consults it
// (alongside loadAgentConfig) so a same-id re-create can't collide with an
// in-flight background teardown whose config.json is already gone (#1525).
const agentTeardownRegistry = new TeardownRegistry();
// Host-folder context mounts (#1283) are a LOCAL/self-hosted-only feature. On
// the podman runtime they are always available; on Kubernetes they are an
// EXPLICIT opt-in (#1319, AEE_K8S_CONTEXT_HOSTPATH=1): the mount renders as a
// hostPath volume, so "host" means the node — right on a single-node kind dev
// cluster, wrong on hosted multi-node GKE, which never sets the flag. The API
// layer mirrors this gate (isLocalContextMountEnv); this is the
// provisioning-side backstop.
const AEE_RUNTIME = String(process.env.AEE_CONTAINER_RUNTIME || "podman").toLowerCase();
const CONTEXT_MOUNT_RUNTIME_OK =
  (AEE_RUNTIME !== "kubernetes" && AEE_RUNTIME !== "k8s") ||
  process.env.AEE_K8S_CONTEXT_HOSTPATH === "1";
const { buildLlmProvenanceEnv } = require("./llm-provenance");
const assistBinding = require("./assist-binding");
const { reconcileSessionAppend } = require("./session-cursor");
const {
  rotationConfig,
  archiveName,
  parseArchiveSeq,
  listArchives,
  planPrune,
} = require("./session-rotation");
const crypto = require("crypto");

function randomHex(bytes) {
  return crypto.randomBytes(bytes).toString("hex");
}
const agentProcesses = new Map(); // id → ChildProcess
// #933: rendezvous for agent-form loop verifiers — a requester loop polls here
// for the verdict the target verifier agent posts back.
const loopVerifyStore = createVerdictStore();

// Subscription-OAuth login flows (`claude setup-token` under a PTY) — driven
// by the Model Providers page in the admin console. See llm-auth-flow.js.
const llmAuthFlows = createLlmAuthFlowManager();

// ============================================================
// Process lifecycle (each agent runs as its own Podman container)
// ============================================================
// Containers start EAGERLY, not on first message: startAgentProcess is invoked
// when an agent is created (createAgent), enabled/activated (enableAgent, claim),
// and for every enabled agent at boot (startAllEnabledAgents). There is no
// spawn-on-first-DM path — the container is up and synced before any message
// arrives, so the first reply is timely. (DM-room readiness is handled on the
// admin-console side, which pre-creates the 1:1 room at create/enable time.)
function startAgentProcess(config) {
  const { id, token, userId, environmentId } = config;
  stopAgentProcess(id); // kill existing if any

  const childEnv = {
    ...process.env,
    AGENT_ID: id,
    // #1547: every plugin CLI facade resolves its own
    // `.agent-studio/plugins/<id>.json` (endpoint + scope token) relative to this,
    // falling back to the home directory. Set on the CONTAINER rather than
    // only inside the entrypoint process so it is also there for anyone who
    // `podman exec`s in to debug — an env the entrypoint mutates is invisible
    // to a fresh exec, which is exactly how a granted CLI came to report
    // itself ungranted.
    AEE_WORKSPACE: `/workspace/agents/${id}`,
    // #1865: spec-kit's bash scripts locate the project by searching upward for
    // a `.specify/` dir; SPECIFY_INIT_DIR pins that to the workspace root (where
    // the plugin seeds the scaffold) so a `/speckit:*` command resolves the
    // project deterministically regardless of which cloned repo the agent has
    // cd'd into. Harmless for agents without spec-kit granted (only spec-kit's
    // own scripts read it).
    SPECIFY_INIT_DIR: `/workspace/agents/${id}`,
    MATRIX_ACCESS_TOKEN: token,
    MATRIX_BOT_USER_ID: userId,
    MATRIX_HOMESERVER: process.env.MATRIX_HOMESERVER,
    ORCHESTRATOR_INTERNAL_URL: process.env.ORCHESTRATOR_INTERNAL_URL || 'http://orchestrator:4002',
    AEE_ORCHESTRATOR_URL: process.env.AEE_ORCHESTRATOR_URL || 'http://orchestrator:4002',
  };
  // The spread above copies THIS container's PATH into the agent container,
  // where it silently overrides the agent image's own PATH — so anything the
  // image puts on PATH (the /opt/aee/plugin-bin entry granted plugin CLIs
  // resolve through, #1547) never takes effect. The orchestrator's PATH has no
  // business travelling; drop it and let the image's own value stand.
  delete childEnv.PATH;

  // Bind the agent's process to the LLM endpoint configured on its working
  // environment. When an environment doesn't reference an endpoint we leave
  // the inherited ANTHROPIC_* values from `.env` in place — that keeps
  // pre-registry environments working.
  const env = environmentId ? loadEnvironment(environmentId) : null;
  const llm = resolveLlmBindingForAgent(config, env);
  if (llm) {
    if (llm.authType === "oauth-token") {
      // Subscription auth (Claude Max / Enterprise seat): the Claude CLI reads
      // CLAUDE_CODE_OAUTH_TOKEN — but only when no API-key credential wins the
      // precedence race. The orchestrator's own environment carries the
      // proxy's ANTHROPIC_* values from `.env` (inherited via process.env
      // above), so strip them explicitly; the token targets the default
      // Anthropic endpoint, never a proxy base URL.
      if (llm.token) childEnv.CLAUDE_CODE_OAUTH_TOKEN = llm.token;
      delete childEnv.ANTHROPIC_BASE_URL;
      delete childEnv.ANTHROPIC_AUTH_TOKEN;
      delete childEnv.ANTHROPIC_API_KEY;
    } else {
      if (llm.baseUrl) childEnv.ANTHROPIC_BASE_URL = llm.baseUrl;
      if (llm.token)   childEnv.ANTHROPIC_AUTH_TOKEN = llm.token;
    }
    if (llm.defaultModelId) childEnv.AGENT_DEFAULT_MODEL = llm.defaultModelId;
    const via = config.llmEndpointOverride ? ' (agent override)' : '';
    console.log(`[Orchestrator] Agent ${id} → LLM endpoint=${llm.endpointId}${via} (${llm.authType}), model=${llm.defaultModelId || '(endpoint default)'}`);
  } else if (config.llmEndpointOverride || env?.llmEndpointId) {
    console.log(`[Orchestrator] Agent ${id} → LLM endpoint binding missing (override=${config.llmEndpointOverride || '-'}, env=${env?.id || '-'}), using .env fallback`);
  }

  // Per-agent override (set via the chat UI) wins over the environment's
  // default model. Fresh-read on each spawn so an admin can edit config.json
  // and restart to apply.
  if (config.modelOverride) childEnv.AGENT_DEFAULT_MODEL = config.modelOverride;

  // Non-secret Model-Provider provenance (#980): the human-readable attributes
  // of how this run is executed (provider name, auth type, sanitized base URL,
  // requested model) so the agent runtime can stamp them onto the immutable
  // `system_init` session-log row. Supersedes the bare AEE_LLM_PROVIDER_ID the
  // usage records still read (buildLlmProvenanceEnv re-sets it when bound). The
  // requested model mirrors the AGENT_DEFAULT_MODEL precedence above
  // (modelOverride wins over the binding default). NEVER carries a token.
  const endpointConfigured = !!(config.llmEndpointOverride || env?.llmEndpointId);
  Object.assign(childEnv, buildLlmProvenanceEnv(llm, config, { endpointConfigured }));

  // If the agent's environment has a GitHub token attached, expose it as
  // GH_TOKEN so the `gh` CLI authenticates without `gh auth login`.
  // (Also exported as GITHUB_TOKEN for git-over-HTTPS pushes.)
  if (env?.githubTokenId) {
    const tokenPath = path.join(GH_TOKENS_DIR, env.githubTokenId);
    try {
      const ghToken = fs.readFileSync(tokenPath, "utf8").trim();
      if (ghToken) {
        childEnv.GH_TOKEN = ghToken;
        childEnv.GITHUB_TOKEN = ghToken;
        console.log(`[Orchestrator] Agent ${id} → GH_TOKEN injected (env=${env.id}, token=${env.githubTokenId})`);
      }
    } catch (err) {
      console.error(`[Orchestrator] Cannot read GitHub token ${env.githubTokenId} for agent ${id}: ${err.message}`);
    }
  }

  // Per-agent SSH identity (see materializeAgentSshKey). Always runs — even for
  // envless agents — because it also strips the orchestrator's inherited
  // GIT_SSH_COMMAND, which would otherwise dangle in every agent.
  materializeAgentSshKey(id, env, childEnv);

  // Shared Agent Learning (Phase 1): expose the team Knowledge Base to the
  // agent runtime + `knowledge` CLI. The autonomy dial is ALWAYS injected
  // explicitly (never left to the runtime default) so an agent whose env can't
  // resolve a KB repo — or that opted to level 0 — sees harvest OFF and never
  // gets nudged to use a KB it doesn't have. Level >= 1 with a resolvable KB
  // repo turns harvesting on and points the CLI at the synced working copy.
  {
    const teamId = agentKnowledgeTeamId(config);
    const kEnv = teamKnowledgeEnv(teamId, env);
    const level = knowledgeAutonomyLevel(kEnv);
    const kbRepoRef = kEnv?.knowledgeStore?.repoRef || null;
    const kbAvailable = level >= 1 && !!kbRepoRef;
    childEnv.KNOWLEDGE_AUTONOMY = String(kbAvailable ? level : 0);
    if (kbAvailable) {
      childEnv.KNOWLEDGE_TEAM_ID = teamId;
      childEnv.KNOWLEDGE_STORE_PATH = kEnv.knowledgeStore.path;
      childEnv.KNOWLEDGE_BRANCH = knowledgeSync.resolveKnowledgeBranch(kEnv);
      childEnv.KNOWLEDGE_DIR = path.join("/workspace/agents", id, "knowledge");
    }
  }

  // Seam #3 fail-closed guard. With per-agent filesystem isolation the
  // container mounts only `agents/<id>` (SubPath) of the pool volume. If the
  // workspace wasn't seeded the SubPath target is missing — refuse to spawn
  // rather than let anything fall back to mounting the whole pool, which would
  // re-expose every agent + the secret stores. Also pre-create the persistent
  // per-agent Claude home SubPath target (`/root/.claude/homes/<id>`), which
  // the orchestrator can write because it mounts claude-home at /root/.claude.
  if (process.env.AEE_WORKSPACE_ISOLATION !== '0') {
    const workdir = path.join('/workspace/agents', id);
    if (!fs.existsSync(workdir)) {
      console.error(
        `[Orchestrator] Refusing to start agent ${id}: workspace ${workdir} ` +
        `not seeded (AEE_WORKSPACE_ISOLATION on)`,
      );
      return;
    }
    try {
      fs.mkdirSync(path.join('/root/.claude/homes', id), { recursive: true });
    } catch (err) {
      console.warn(`[Orchestrator] could not pre-create Claude home for ${id}: ${err.message}`);
    }
  }

  // Host-folder context mount(s) (#1283, multiple folders #1290). Applied on
  // the podman runtime, and on Kubernetes behind the AEE_K8S_CONTEXT_HOSTPATH
  // opt-in (#1319); both runtimes re-validate each path fail-closed at the
  // point of use (buildContextMountSpecs / buildContextHostPathVolumes), so a
  // stale/invalid value produces no mount. Each
  // folder is read-only by default and read-write only when its per-folder
  // opt-in is set (#1289). resolveContextMounts returns [] when there is no
  // mount at all, so the no-mount spawn path is byte-identical to before (AC9).
  const contextMounts = CONTEXT_MOUNT_RUNTIME_OK ? resolveContextMounts(config) : [];

  // Agent toolchain (#1940). The environment may name a toolchain whose image
  // this agent is spawned from; absent, this is the installation-wide default
  // and the spawn is byte-identical to before (AC1). A selection that cannot be
  // honoured (unregistered toolchain, wrong runtime) REFUSES the spawn with a
  // named reason — the same fail-closed stance as the un-seeded-workspace guard
  // above, and for the same reason: booting the agent anyway would produce a
  // container that looks healthy and breaks at the first build command.
  const resolvedImage = resolveImageForAgent(config);
  if (resolvedImage.error) {
    console.error(`[Orchestrator] Refusing to start agent ${id}: ${resolvedImage.message}`);
    return;
  }
  if (resolvedImage.toolchain) {
    console.log(
      `[Orchestrator] Agent ${id} -> toolchain '${resolvedImage.toolchain.toolchainId}' ` +
      `image ${resolvedImage.image}`,
    );
  }

  const child = spawnContainer({
    id,
    env: childEnv,
    contextMounts,
    image: resolvedImage.image,
    toolchain: resolvedImage.toolchain,
  });

  child.stdout.on('data', (d) =>
    d.toString().split('\n').filter(Boolean).forEach(line =>
      console.log(`[Agent:${id}] ${line}`)
    )
  );
  child.stderr.on('data', (d) =>
    d.toString().split('\n').filter(Boolean).forEach(line =>
      console.error(`[Agent:${id}] ${line}`)
    )
  );
  child.on('exit', (code) => {
    console.log(`[Orchestrator] Agent ${id} exited (code ${code})`);
    // Only clear the map entry if it still points at THIS child. A respawn
    // calls stopAgentProcess() (kill + delete) then immediately sets a new
    // child for the same id; the OLD child's exit event can fire after that
    // point (container teardown is async), and would otherwise delete the
    // NEW child's entry — making a genuinely running agent look stopped to
    // every subsequent respawn call (agentProcesses.has(id) → false).
    if (agentProcesses.get(id) === child) {
      agentProcesses.delete(id);
    }
  });

  agentProcesses.set(id, child);
  child.on('spawned', (pid) => {
    console.log(`[Orchestrator] Started container for agent ${id} (id ${pid})`);
  });
}

function stopAgentProcess(id) {
  const proc = agentProcesses.get(id);
  if (!proc) return;
  proc.kill('SIGTERM');
  agentProcesses.delete(id);
  console.log(`[Orchestrator] Stopped process for agent ${id}`);
}

function stopAgentSession(id, sessionId) {
  const proc = agentProcesses.get(id);
  if (!proc) return false;
  // Stop-session is delivered via SIGUSR1; the container's Python listener
  // catches it and terminates the active claude subprocess (the container
  // itself keeps running and stays available for further DMs).
  try {
    proc.kill('SIGUSR1');
    console.log(
      `[Orchestrator] Sent SIGUSR1 stop-session to agent ${id}` +
      (sessionId ? ` (session ${sessionId})` : '')
    );
    return true;
  } catch (err) {
    console.error(`[Orchestrator] stopAgentSession ${id}: ${err.message}`);
    return false;
  }
}

async function evictStaleAgentContainers() {
  if (process.env.EVICT_STALE_AGENTS === '0') return;
  try {
    // Key on the platform's OWN label, not the image ancestor (#1940 AC4).
    // Filtering by `{ ancestor: [AGENT_IMAGE] }` was correct only while every
    // agent ran the one installation-wide image: the moment an agent is spawned
    // from a per-environment toolchain variant, a stale container of that
    // variant is invisible to this sweep and is left running forever. Every
    // agent container carries `aee.agent.id` on both runtimes (spawn-container's
    // AGENT_LABEL_KEY / the pod label in buildPodManifest), so a label-key
    // filter sees them all regardless of image — and also covers the
    // short-lived seed/reseed helpers, whose stale leftovers we equally want
    // gone. The aee.instance check below is UNCHANGED, so the "left N
    // foreign/legacy container(s) untouched" safety is preserved: a sibling
    // stack's agents are still skipped, they are simply now seen first.
    const filters = encodeURIComponent(JSON.stringify({ label: [AGENT_ID_LABEL_KEY] }));
    const list = await libpodRequest('GET', `/containers/json?all=true&filters=${filters}`);
    if (list.status >= 300 || !Array.isArray(list.body)) {
      console.warn(`[Orchestrator] evict: list returned status=${list.status}`);
      return;
    }
    let evicted = 0;
    let skippedForeign = 0;
    for (const c of list.body) {
      const cid = c.Id || c.ID;
      if (!cid) continue;
      // Scope eviction to THIS instance. A container labelled for another
      // compose project belongs to a parallel stack sharing this Podman store —
      // evicting it would kill a sibling instance's agents (exactly the failure
      // this guards against). Legacy containers with no instance label are also
      // left alone so an upgrade boot can't nuke a sibling; operators clear those
      // once during the label rollout.
      const labels = c.Labels || c.labels || {};
      if (labels[INSTANCE_LABEL_KEY] !== INSTANCE_ID) { skippedForeign += 1; continue; }
      const del = await libpodRequest('DELETE', `/containers/${cid}?force=true&v=true`);
      if (del.status < 300) evicted += 1;
      else console.warn(`[Orchestrator] evict: delete ${cid.slice(0, 12)} status=${del.status}`);
    }
    if (evicted > 0 || skippedForeign > 0) {
      console.log(`[Orchestrator] evicted ${evicted} stale agent container(s) for instance '${INSTANCE_ID}'` +
        (skippedForeign > 0 ? ` (left ${skippedForeign} foreign/legacy container(s) untouched)` : ''));
    }
  } catch (err) {
    console.warn(`[Orchestrator] evict skipped: ${err.message}`);
  }
}

async function startAllEnabledAgents() {
  await evictStaleAgentContainers();
  for (const id of listAgentIds()) {
    const config = loadAgentConfig(id);
    if (!config) continue;
    // A config naming a role the platform no longer supports is skipped rather
    // than spawned (#1962, epic AC3). This is also what implements the
    // "still-running mission container" decision: evictStaleAgentContainers()
    // above already force-removed EVERY agent container regardless of role, so
    // not respawning here means a leftover orchestrator / bp-instance container
    // is stopped at upgrade and never comes back — while its configuration is
    // left on disk untouched, per epic decision R2. The note is logged once per
    // config for the whole process lifetime (this loop runs at boot only).
    if (!isSupportedAgentRole(config.role)) {
      const note = unsupportedRoleNote(id, config.role);
      if (note) console.log(note);
      continue;
    }
    // Skip stubs (config without a Matrix user) — enableAgent() materializes
    // those on first activation.
    if (config.enabled !== false && config.token) {
      startAgentProcess(config);
    }
  }
}

// ============================================================
// Agent storage
// ============================================================
function agentDir(id) {
  return path.join(AGENTS_DIR, id);
}

// Control-plane location for an agent's pushed state (#185).
function controlAgentDir(id) {
  return path.join(CONTROL_DIR, id);
}

// Resolve a per-agent state file, preferring the pushed control-plane copy and
// falling back to the agent's own workspace when it hasn't pushed yet (or push
// is disabled). This keeps the read-repoint non-breaking on the shared volume
// and lets it transparently work once agents move to isolated volumes (#185).
function agentStatePath(id, ...segs) {
  const ctrl = path.join(controlAgentDir(id), ...segs);
  if (fs.existsSync(ctrl)) return ctrl;
  return path.join(agentDir(id), ...segs);
}

// Canonical location for control→agent state (triggers.json,
// pending-triggers.json, the session-pointer mirror). With per-agent volume
// isolation the agent's own volume is unreachable from here, so the canonical
// copy lives on the control plane (the agent pulls it). Otherwise it stays on
// the shared pool subpath the agent reads directly. The orchestrator both reads
// and writes through this resolver, so reads always match where it wrote.
function controlOrPoolPath(id, ...segs) {
  return PER_AGENT_VOLUME
    ? path.join(controlAgentDir(id), ...segs)
    : path.join(agentDir(id), ...segs);
}

// Path-segment guard for values that become filesystem paths (agent id, room
// id) in the push endpoints. Rejects separators / traversal / NUL.
function isSafePathSeg(s) {
  return typeof s === 'string' && s.length > 0 && s.length <= 256 &&
    !s.includes('/') && !s.includes('\\') && !s.includes('..') && !s.includes('\0');
}

// Client-safe error text: only ever the `message` property read (a CodeQL
// js/stack-trace-exposure barrier), never a stringification of the exception
// object itself, which is treated as carrying the stack trace.
function errorMessage(err) {
  return (err && err.message) ? String(err.message) : 'error';
}

// Apply the session-log retention policy (#673) to a room's archives in `dir`.
// Best-effort: a stat/unlink failure on one archive never blocks the rest.
function pruneControlSessionArchives(dir, roomId, cfg) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return; }
  const archives = [];
  for (const { name } of listArchives(names, roomId)) {
    let mtimeMs = 0;
    try { mtimeMs = fs.statSync(path.join(dir, name)).mtimeMs; } catch { continue; }
    archives.push({ name, seq: parseArchiveSeq(name, roomId), mtimeMs });
  }
  const doomed = planPrune(archives, {
    maxCount: cfg.maxCount,
    maxAgeMs: cfg.maxAgeDays * 24 * 60 * 60 * 1000,
    now: Date.now(),
  });
  for (const name of doomed) {
    try { fs.rmSync(path.join(dir, name)); } catch { /* best-effort */ }
  }
}

// Legacy role names used to be `expert` / `expert-group` / `expert-instance`.
// The user-facing language is now `agent` / `team` / `team-member` and the
// `parentGroupId` field has been renamed to `parentTeamId`. We keep a
// translation layer here so any config that wasn't rewritten by
// `migrateLegacyAgentConfigs()` still loads with the new shape.
const LEGACY_ROLE_MAP = {
  "expert": "agent",
  "expert-group": "team",
  "expert-instance": "team-member",
};

function normalizeAgentConfig(cfg) {
  if (!cfg) return cfg;
  const out = { ...cfg };
  if (LEGACY_ROLE_MAP[out.role]) out.role = LEGACY_ROLE_MAP[out.role];
  if (out.parentGroupId !== undefined && out.parentTeamId === undefined) {
    out.parentTeamId = out.parentGroupId;
    delete out.parentGroupId;
  }
  return out;
}

function loadAgentConfig(id) {
  const p = path.join(agentDir(id), "config.json");
  if (!fs.existsSync(p)) return null;
  return normalizeAgentConfig(JSON.parse(fs.readFileSync(p, "utf8")));
}

function saveAgentConfig(id, config) {
  const dir = agentDir(id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(config, null, 2));
}

// One-time migration: rewrite any legacy `role` / `parentGroupId` fields on
// disk so the new naming is the single source of truth. Idempotent — safe to
// run on every orchestrator start.
function migrateLegacyAgentConfigs() {
  if (!fs.existsSync(AGENTS_DIR)) return;
  let migrated = 0;
  for (const id of listAgentIds()) {
    const p = path.join(agentDir(id), "config.json");
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(p, "utf8"));
    } catch (err) {
      console.error(`[Orchestrator] migrate: cannot parse ${p}: ${err.message}`);
      continue;
    }
    const before = JSON.stringify(raw);
    const after = normalizeAgentConfig(raw);
    if (JSON.stringify(after) !== before) {
      fs.writeFileSync(p, JSON.stringify(after, null, 2));
      migrated++;
    }
  }
  if (migrated > 0) {
    console.log(`[Orchestrator] Migrated ${migrated} legacy agent config(s) to agent/team/team-member naming`);
  }
}

// One-time migration (team-owned skills): copy each environment's legacy
// `skills[]` grant onto every team / standalone agent config that doesn't
// carry a `skills` field yet. Team-members keep the inherit/override model.
// After this the Working Environment no longer contributes skills — it is a
// pure infrastructure template (docs/knowledge-skill-activation-concept.md).
// Idempotent — an existing `skills` field always wins; safe on every start.
function migrateSkillGrantsToAgents() {
  if (!fs.existsSync(AGENTS_DIR)) return;
  let migrated = 0;
  for (const id of listAgentIds()) {
    const cfg = loadAgentConfig(id);
    if (!cfg) continue;
    // R2 (#1962): a leftover config naming a retired role is not touched — not
    // rewritten and not counted below. This loop has no other role gate, and it
    // runs from main() BEFORE the Orchestrator (and therefore before the
    // startAllEnabledAgents role gate) exists, so it would otherwise be the one
    // path that writes to a config the removal promises to leave alone.
    if (!isSupportedAgentRole(cfg.role)) continue;
    const env = cfg.environmentId ? loadEnvironment(cfg.environmentId) : null;
    const next = migrateSkillGrant(cfg, env);
    if (next) {
      saveAgentConfig(id, next);
      migrated++;
    }
  }
  if (migrated > 0) {
    console.log(`[Orchestrator] Migrated ${migrated} agent config(s) to team-owned skill grants (env.skills → config.skills)`);
  }
}

// One-time migration (#510): rewrite existing agents' CLAUDE.md so the Agent
// Role block references AGENT-PROMPT.md (`@AGENT-PROMPT.md`) instead of inlining
// the prompt text. Older CLAUDE.md files carry a stale inlined copy that never
// got rebuilt when the prompt was edited; converting them to the reference form
// makes future edits take effect on the next session with no rebuild. Idempotent
// — an already-referencing CLAUDE.md is left untouched, and agents without an
// AGENT-PROMPT.md (bare stubs) are skipped.
//
// The rewrite above only touches the pool subpath copy. Under
// AEE_PER_AGENT_VOLUME each agent boots off its OWN dedicated volume, whose
// CLAUDE.md is authoritative and is NOT refreshed by a plain respawn
// (seedPerAgentVolume copies only into an EMPTY /dst, and startAllEnabledAgents
// re-spawns without reseeding). Left alone, a pre-existing agent on a dedicated
// volume would keep serving the OLD inlined CLAUDE.md — so subsequent prompt
// edits (which only reseed AGENT-PROMPT.md) still wouldn't take effect, exactly
// the bug #510 fixes. So after the pool rewrite we mirror CLAUDE.md into each
// migrated agent's dedicated volume (force-copy even into a non-empty volume).
// This runs pre-init(), before agents are spawned, but the volumes persist
// across restarts so a pre-existing agent's volume already exists; a not-yet-
// provisioned agent is a no-op here and gets the migrated pool copy via a fresh
// seed on its next spawn. Best-effort — a mirror failure never aborts boot.
async function migrateAgentClaudeMdToReference() {
  if (!fs.existsSync(AGENTS_DIR)) return;
  const marker = `@${AGENT_PROMPT_FILENAME}`;
  const migratedIds = [];
  for (const id of listAgentIds()) {
    const dir = agentDir(id);
    const promptPath = path.join(dir, AGENT_PROMPT_FILENAME);
    const claudePath = path.join(dir, "CLAUDE.md");
    if (!fs.existsSync(promptPath) || !fs.existsSync(claudePath)) continue;
    let current;
    try { current = fs.readFileSync(claudePath, "utf8"); } catch { continue; }
    if (current.includes(marker)) continue; // already reference form
    const cfg = loadAgentConfig(id);
    if (!cfg) continue;
    let prompt;
    try { prompt = fs.readFileSync(promptPath, "utf8"); } catch { continue; }
    const env = cfg.environmentId ? loadEnvironment(cfg.environmentId) : null;
    const autonomous = agentIsAutonomous(id, cfg.role);
    const rebuilt = buildAgentClaudeMd(prompt, cfg.role, env, cfg.blueprintId || null, {
      autonomous,
      promptRef: AGENT_PROMPT_FILENAME,
    });
    // Guard: only write if the rebuild actually produced the reference form
    // (a missing base template makes buildAgentClaudeMd echo the prompt back).
    if (!rebuilt.includes(marker)) continue;
    try {
      fs.writeFileSync(claudePath, rebuilt);
      migratedIds.push(id);
    } catch (err) {
      console.error(`[Orchestrator] claude-md migrate: cannot write ${claudePath}: ${err.message}`);
    }
  }
  if (migratedIds.length > 0) {
    console.log(`[Orchestrator] Migrated ${migratedIds.length} agent CLAUDE.md file(s) to reference AGENT-PROMPT.md (#510)`);
  }
  // Mirror the migrated CLAUDE.md into per-agent dedicated volumes (AC4). A
  // missing volume is skipped inside reseedPerAgentVolume, so an unprovisioned
  // agent is a harmless no-op here.
  if (PER_AGENT_VOLUME) {
    for (const id of migratedIds) {
      try {
        await reseedPerAgentVolume(id, ['CLAUDE.md']);
      } catch (err) {
        console.warn(`[Orchestrator] claude-md migrate: volume mirror ${id}: ${err.message}`);
      }
    }
  }
}

// ============================================================
// Teams: bootstrap + ownership backfill (#299)
// ============================================================
//
// Every agent construct, Working Environment and credential is owned by exactly
// one Team via a `teamId` field. On startup we guarantee the default team
// exists, optionally seed a System Admin from environment config, and stamp any
// pre-existing resource that predates this model with the default team. The
// pass is idempotent — once stamped, a resource is skipped on subsequent boots.
function bootstrapTeams() {
  teamsStore.ensureDefaultTeam();
  const subject = process.env.BOOTSTRAP_SYSTEM_ADMIN_SUBJECT;
  if (subject) {
    try {
      const admin = teamsStore.ensureSystemAdmin({
        subject,
        email: process.env.BOOTSTRAP_SYSTEM_ADMIN_EMAIL,
        displayName: process.env.BOOTSTRAP_SYSTEM_ADMIN_NAME,
      });
      console.log(`[Orchestrator] Ensured System Admin for subject '${subject}'`);
      // #1457: System Admin is a global flag, not a membership, so the bootstrap
      // admin was left with no *Team* role at all — and the Default Team it
      // owns everything in therefore had no Team Admin. Give it one. The plan is
      // empty once any membership for the pair exists, in any role, so a human
      // who deliberately demoted this admin is not re-promoted on every boot.
      const membership = planBootstrapMembership({
        userId: admin && admin.id,
        memberships: teamsStore.listMemberships({ teamId: DEFAULT_TEAM_ID }),
        teamId: DEFAULT_TEAM_ID,
      });
      if (membership) {
        teamsStore.setMembership(membership);
        console.log(`[Orchestrator] Made System Admin '${subject}' ${membership.role} of the Default Team`);
      }
    } catch (err) {
      console.error(`[Orchestrator] System Admin bootstrap failed: ${err.message}`);
    }
  }
}

// Stamp `teamId: "default"` onto any resource that lacks an owner. Rewrites the
// JSON in place only when it actually changes (so it's cheap on a warm stack).
function backfillResourceOwnership() {
  let stamped = 0;

  // Agents
  if (fs.existsSync(AGENTS_DIR)) {
    const configs = {};
    for (const id of listAgentIds()) {
      const cfg = loadAgentConfig(id);
      if (cfg && cfg.teamId === undefined) {
        cfg.teamId = DEFAULT_TEAM_ID;
        saveAgentConfig(id, cfg);
        stamped++;
      }
      if (cfg) configs[id] = cfg;
    }
    // A team-member's tenant is its parent Agent Team's `teamId` (see
    // agent-tenant.js). Members created before that was enforced can carry a
    // stale stamp; realign them so the on-disk value matches what every scoping
    // decision already resolves. Idempotent — a synced member is skipped.
    for (const { id, from, to } of planTenantBackfill(configs)) {
      const cfg = configs[id];
      cfg.teamId = to;
      saveAgentConfig(id, cfg);
      console.log(`[Orchestrator] Realigned team-member ${id} tenant ${from || "(unset)"} → ${to}`);
      stamped++;
    }
  }

  // Working Environments
  if (fs.existsSync(ENVIRONMENTS_DIR)) {
    for (const name of fs.readdirSync(ENVIRONMENTS_DIR)) {
      const p = path.join(ENVIRONMENTS_DIR, name, "environment.json");
      if (!fs.existsSync(p)) continue;
      try {
        const env = JSON.parse(fs.readFileSync(p, "utf8"));
        if (env.teamId === undefined) {
          env.teamId = DEFAULT_TEAM_ID;
          fs.writeFileSync(p, JSON.stringify(env, null, 2));
          stamped++;
        }
      } catch { /* skip unparsable env */ }
    }
  }

  // Credentials: each index is an array of metadata entries.
  const CREDENTIAL_INDEXES = [
    SSH_KEYS_INDEX,
    path.join(GH_TOKENS_DIR, "index.json"),
    path.join(MCP_CREDENTIALS_KEYS_DIR, "index.json"),
    LLM_ENDPOINTS_INDEX,
  ];
  for (const idx of CREDENTIAL_INDEXES) {
    if (!fs.existsSync(idx)) continue;
    try {
      const list = JSON.parse(fs.readFileSync(idx, "utf8"));
      if (!Array.isArray(list)) continue;
      // planAdoption's `teamId === undefined` predicate is what keeps the
      // personal credential tier (#1567) out: a personal entry carries an
      // explicit `teamId: null` and must NOT be adopted into a team.
      const pending = planAdoption(list.map((record, key) => ({ key, record })));
      if (pending.length > 0) {
        for (const { record } of pending) record.teamId = DEFAULT_TEAM_ID;
        fs.writeFileSync(idx, JSON.stringify(list, null, 2));
        stamped += pending.length;
      }
    } catch { /* skip unparsable index */ }
  }

  // MCP servers (#1457). The scope filter has always read `server.teamId`
  // (api.js `visibleTeam(scope, s.teamId)`) but nothing ever wrote it, so every
  // registered server relied on the `|| 'default'` collapse inside the
  // predicate. Adopt them explicitly, so the Default Team's ownership is a fact
  // on disk rather than a fallback. Writing a `teamId` at *create* time belongs
  // to the ownership phase (#2077/#2083) — this pass only adopts what predates it.
  if (fs.existsSync(MCP_SERVERS_DIR)) {
    for (const name of fs.readdirSync(MCP_SERVERS_DIR)) {
      if (name.startsWith("_")) continue; // credential/key dirs, not servers
      const p = path.join(MCP_SERVERS_DIR, name, "server.json");
      if (!fs.existsSync(p)) continue;
      try {
        const server = JSON.parse(fs.readFileSync(p, "utf8"));
        if (needsAdoption(server)) {
          server.teamId = DEFAULT_TEAM_ID;
          fs.writeFileSync(p, JSON.stringify(server, null, 2));
          stamped++;
        }
      } catch { /* skip unparsable server */ }
    }
  }

  if (stamped > 0) {
    console.log(`[Orchestrator] Backfilled team ownership onto ${stamped} pre-existing resource(s)`);
  }
}

// The D6 ownership migration (#2077, epic #2076; design of record
// `docs/decentralised-access-concept.md` §8). Startup-time, idempotent,
// in-place — the `backfillResourceOwnership` shape above, which §8.3 names as
// the precedent to copy. Two independent passes:
//
//   1. `ownerId` onto every team and standalone agent that lacks one (AC1/AC5),
//      resolved from its access scope's memberships by the D6 rule.
//   2. Every (user ↔ access-scope) membership fanned out to one
//      (user ↔ Agent Team) membership per Agent Team in that scope (AC2/AC3).
//
// Pass 2 is ADDITIVE — the scope memberships stay. P1 is specified as "no
// behaviour change", and enforcement still gates on a resource's `teamId`
// stamp (an access-scope id until P2 re-points it), so removing the scope
// grants here would empty every list for every non-admin. §8.3 states the
// no-lockout property as `⊇` precisely to allow this; the fixture test
// `admin-console/api/ownership-no-lockout.test.js` is the proof.
//
// Idempotent by VALUE, never by a marker: pass 1 skips a config that already
// carries an `ownerId`, pass 2 skips a `(userId, teamId)` pair that already
// exists. A second boot writes nothing and logs nothing (AC6).
//
// Best-effort per item, like its precedent: one unreadable config or a store
// write failure is logged and never aborts boot.
function migrateOwnershipModel() {
  let users = [];
  let memberships = [];
  try {
    users = teamsStore.listUsers();
    memberships = teamsStore.listMemberships();
  } catch (err) {
    console.warn(`[Orchestrator] Ownership migration skipped — user store unreadable: ${err.message}`);
    return;
  }

  const configs = {};
  if (fs.existsSync(AGENTS_DIR)) {
    for (const id of listAgentIds()) {
      try {
        const cfg = loadAgentConfig(id);
        if (cfg) configs[id] = cfg;
      } catch (err) {
        console.warn(`[Orchestrator] Ownership migration: skipping unreadable config ${id}: ${err.message}`);
      }
    }
  }

  // ── Pass 1 — ownerId (AC1/AC5) ──────────────────────────────────────────
  const { stamp, unresolved } = ownershipMigration.planOwnerBackfill({ configs, users, memberships });
  let owned = 0;
  for (const { id, ownerId, ownerSource, scopeId } of stamp) {
    try {
      const cfg = configs[id];
      cfg.ownerId = ownerId;
      cfg.ownerSource = ownerSource;
      saveAgentConfig(id, cfg);
      owned++;
      console.log(`[Orchestrator] Ownership: ${id} (scope ${scopeId}) → owner ${ownerId} (migration placeholder)`);
    } catch (err) {
      console.warn(`[Orchestrator] Ownership migration: could not stamp ${id}: ${err.message}`);
    }
  }
  // D6's rule ends in "else unset", so a scope with no members at all leaves
  // its resources unowned rather than getting a fabricated owner. Report it —
  // an unowned team is correctable (§8.2) but only if someone knows about it.
  for (const { id, scopeId } of unresolved) {
    console.warn(
      `[Orchestrator] Ownership: ${id} has no resolvable owner — access scope '${scopeId}' has no members. `
      + 'Assign an owner from the Access page.',
    );
  }

  // ── Pass 2 — membership fan-out (AC2/AC3) ───────────────────────────────
  let granted = 0;
  const repoint = ownershipMigration.planMembershipRepoint({ configs, memberships });
  if (repoint.length > 0) {
    try {
      granted = teamsStore.appendMemberships(repoint).length;
      for (const m of repoint) {
        console.log(`[Orchestrator] Ownership: membership ${m.userId} → Agent Team ${m.teamId} as ${m.role} (from scope ${m.fromScopeId})`);
      }
    } catch (err) {
      console.warn(`[Orchestrator] Ownership migration: membership fan-out failed: ${err.message}`);
    }
  }

  if (owned > 0 || granted > 0) {
    console.log(`[Orchestrator] Ownership migration: stamped ${owned} owner(s), added ${granted} Agent-Team membership(s)`);
  }
}

// #525: pin the history horizon of pre-existing github-event triggers. The
// #320/#446 fix stamps createdAt/activatedAt on every trigger at create/edit
// time, but a trigger authored before that fix (and never edited since) still
// has neither stamp, so its poller horizon falls back to the triggers.json
// mtime — a volatile value that any unrelated rewrite bumps to "now", silently
// dropping events that arrived just before. Until now the only backfill was
// lazy (on a PUT edit), so a never-edited legacy trigger kept riding the mtime.
// This one-time startup pass closes that gap: for each agent it reads the
// triggers file, captures its CURRENT mtime (a stable value equal to what the
// horizon resolves to right now — so no event backlog is replayed), stamps any
// unstamped github-event trigger with it, and writes back only files that
// actually changed. Idempotent: an already-stamped file is left untouched, so
// this is safe to run on every startup alongside the other migrations.
function backfillTriggerHorizonStamps() {
  const { backfillHorizonStamps } = require("./github-poller");
  let stamped = 0;
  for (const id of listAgentIds()) {
    const p = controlOrPoolPath(id, "triggers.json");
    if (!fs.existsSync(p)) continue;
    let triggers, mtimeIso;
    try {
      triggers = JSON.parse(fs.readFileSync(p, "utf8"));
      mtimeIso = fs.statSync(p).mtime.toISOString();
    } catch (err) {
      console.error(`[Orchestrator] Trigger horizon backfill: skipping ${id}: ${err.message}`);
      continue;
    }
    const { triggers: next, changed } = backfillHorizonStamps(triggers, mtimeIso);
    if (!changed) continue;
    saveTriggers(id, next);
    stamped++;
  }
  if (stamped > 0) {
    console.log(`[Orchestrator] Backfilled history-horizon stamps onto github-event triggers for ${stamped} agent(s)`);
  }
}

// Resolve the owning (human) Team for a newly created resource. An explicit id
// must reference an existing team; absence falls back to the default team.
function resolveOwnerTeamId(teamId) {
  if (teamId === undefined || teamId === null || teamId === '') return DEFAULT_TEAM_ID;
  if (!teamsStore.getTeam(teamId)) {
    throw new Error(`Owning team '${teamId}' not found`);
  }
  return teamId;
}

// Is this agent driven by anything other than interactive DM? Gates the
// injection of the trigger-management docs and the unattended-run framing into
// its CLAUDE.md. Autonomous = a reactive session policy or an already-configured
// trigger. Best-effort: at create-time config.json is written before this is
// read (so sessionPolicy is visible) but triggers.json may not exist yet —
// reactive roles set sessionPolicy=per-invocation, which is the signal we rely
// on there.
//
// `role` is still threaded through to the pure predicate for its signature,
// but no role is inherently autonomous since #1962 removed the two that were
// (`orchestrator`/`bp-instance`).
function agentIsAutonomous(id, role) {
  let sessionPolicy;
  try {
    sessionPolicy = loadAgentConfig(id)?.sessionPolicy;
  } catch { /* no config yet */ }
  let triggers = [];
  try {
    const p = controlOrPoolPath(id, "triggers.json");
    if (fs.existsSync(p)) {
      const arr = JSON.parse(fs.readFileSync(p, "utf8"));
      if (Array.isArray(arr)) triggers = arr;
    }
  } catch { /* unparsable / missing triggers */ }
  // Pure predicate (agent-autonomy.js) so the trigger-write autonomy-flip
  // rebuild (#962) shares one testable definition of "autonomous".
  return isAutonomousState({ role, sessionPolicy, triggers });
}

// Unified-memory / digest gate (Memory/Knowledge unification, Phases 1+2):
// the `@knowledge-digest.md` import AND the unified Memory System section are
// emitted iff the team KB is on (autonomy >= 1) and this agent's checkout was
// actually provisioned. This mirrors _memory_model_unified() in
// agent-image/scripts/agent-entrypoint.py (the runtime resolves the same two
// conditions from KNOWLEDGE_AUTONOMY + the on-disk checkout), so the seeded
// CLAUDE.md, the prompt preview and the runtime hint always agree — including
// when an operator later turns a team's dial back to 0 (checkout still on
// disk, but every surface falls back to the legacy model).
function agentKnowledgeDigestRef(id, env) {
  const teamId = agentKnowledgeTeamId(loadAgentConfig(id) || {});
  return knowledgeAutonomyLevel(teamKnowledgeEnv(teamId, env)) >= 1 &&
    fs.existsSync(path.join(agentDir(id), "knowledge", ".git"))
    ? KNOWLEDGE_DIGEST_FILENAME
    : null;
}

function saveAgentPrompt(id, prompt, role, env, blueprintId = null) {
  const dir = agentDir(id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, AGENT_PROMPT_FILENAME), prompt);
  const autonomous = agentIsAutonomous(id, role);
  // Skills are team-owned (skill-grants.js): resolve the effective grant from
  // the agent's own config (saved before every saveAgentPrompt call in all
  // paths), so no caller can forget to thread it through.
  const cfg = loadAgentConfig(id);
  const skills = effectiveSkills(cfg, loadAgentConfig);
  // #617: enrich the Skills section with each granted skill's SKILL.md
  // description, resolved from the same tier seeding would copy from.
  const skillDescriptions = agentSkillDescriptions(id, agentKnowledgeTeamId(cfg || {}), skills);
  // Seeding runs before every saveAgentPrompt call in all paths, so the
  // on-disk checkout the gate reads is the live truth here.
  const knowledgeDigestRef = agentKnowledgeDigestRef(id, env);
  // #1286: an agent with host-folder mount(s) (#1283, multiple #1290) is told
  // each folder exists. Resolved from the same config the spawn path mounts
  // from, so the prompt can never claim a folder the container doesn't have —
  // each entry carries its in-container target and read/write mode (#1289).
  const contextMounts = resolveContextMounts(cfg || {});
  // #1547: same discipline as skills — resolve the plugin grant from the config
  // here rather than threading it through every caller.
  const plugins = agentPluginDisplays(cfg);
  // #2067: same discipline as skills/plugins/mounts — the agent-scoped
  // repository list is resolved from the config HERE rather than threaded
  // through every caller, so no path can rebuild a prompt that omits (or
  // invents) a repository the workspace actually has.
  const agentRepositories = normalizeAgentRepositories(cfg && cfg.agentRepositories);
  // Reference mode: CLAUDE.md points at AGENT-PROMPT.md instead of inlining it.
  fs.writeFileSync(
    path.join(dir, "CLAUDE.md"),
    buildAgentClaudeMd(prompt, role, env, blueprintId, { autonomous, skills, skillDescriptions, plugins, agentRepositories, promptRef: AGENT_PROMPT_FILENAME, knowledgeDigestRef, contextMounts }),
  );
}

// #962: adding or removing a trigger can flip agentIsAutonomous(), which gates
// the Trigger-management docs + unattended-run framing in the agent's CLAUDE.md.
// Only saveAgentPrompt rebuilds CLAUDE.md and it isn't called on a trigger
// write, so an agent that gained autonomy via the Flow Editor would never see
// the trigger docs (and one that lost it would keep them). Called from the
// trigger PUT chokepoint with the pre-write autonomy state; rebuilds CLAUDE.md
// and mirrors it into an isolated agent's volume — but ONLY when the state
// actually flipped, so a no-op edit (e.g. adding a 2nd trigger) never churns
// (AC4). Reconstructs prompt/env/blueprintId exactly like the skill-sync
// rebuild. Best-effort: a rebuild failure never fails the
// (already-persisted) trigger write.
async function reconcileAgentAutonomyPrompt(id, wasAutonomous) {
  try {
    const cfg = loadAgentConfig(id);
    if (!cfg) return false;
    const nowAutonomous = agentIsAutonomous(id, cfg.role);
    if (!autonomyChanged(wasAutonomous, nowAutonomous)) return false;
    const env = cfg.environmentId ? loadEnvironment(cfg.environmentId) : null;
    const promptPath = path.join(agentDir(id), AGENT_PROMPT_FILENAME);
    const prompt = fs.existsSync(promptPath)
      ? fs.readFileSync(promptPath, "utf8")
      : (cfg.systemPrompt || cfg.systemPromptTemplate || "");
    saveAgentPrompt(id, prompt, cfg.role, env, cfg.blueprintId || null);
    // Mirror the rebuilt CLAUDE.md into a dedicated volume (no-op unless
    // isolated + running). CLAUDE.md is re-read by the CLI on every invocation,
    // so the new prompt takes effect on the agent's next run — no respawn, same
    // as the skill-sync path (AC3).
    await reseedAgent(id, ["CLAUDE.md"]);
    console.log(`[Orchestrator] Rebuilt CLAUDE.md for ${id} (autonomy ${nowAutonomous ? "gained" : "lost"} via trigger change)`);
    return true;
  } catch (err) {
    console.warn(`[Orchestrator] autonomy reconcile ${id}: ${err.message}`);
    return false;
  }
}

// #1286: unconditional CLAUDE.md rebuild for an agent whose config changed in a
// way the prompt is gated on but no prompt write covers — today the read-only
// context mount (setting or clearing it must add/remove the `/context` section).
// Sibling of reconcileAgentAutonomyPrompt, minus the flip check: the caller only
// invokes it when the gating input actually changed. Best-effort — a rebuild
// failure never fails the already-persisted config write.
async function rebuildAgentPrompt(id, reason) {
  try {
    const cfg = loadAgentConfig(id);
    if (!cfg) return false;
    const env = cfg.environmentId ? loadEnvironment(cfg.environmentId) : null;
    const promptPath = path.join(agentDir(id), AGENT_PROMPT_FILENAME);
    const prompt = fs.existsSync(promptPath)
      ? fs.readFileSync(promptPath, "utf8")
      : (cfg.systemPrompt || cfg.systemPromptTemplate || "");
    saveAgentPrompt(id, prompt, cfg.role, env, cfg.blueprintId || null);
    // CLAUDE.md is re-read on every invocation, so this lands on the agent's
    // next run; the mirror keeps an isolated volume in step.
    await reseedAgent(id, ["CLAUDE.md"]);
    console.log(`[Orchestrator] Rebuilt CLAUDE.md for ${id} (${reason || "config change"})`);
    return true;
  } catch (err) {
    console.warn(`[Orchestrator] prompt rebuild ${id}: ${err.message}`);
    return false;
  }
}

// ============================================================
// Environment storage
// ============================================================
function loadEnvironment(envId) {
  if (!envId) return null;
  const p = path.join(ENVIRONMENTS_DIR, envId, "environment.json");
  if (!fs.existsSync(p)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    return normalizeEnvironmentConfig(raw);
  } catch (err) {
    console.error(`[Orchestrator] Cannot parse environment ${envId}: ${err.message}`);
    return null;
  }
}

// ============================================================
// Toolchain registry (#1940)
// ============================================================
// The operator-curated list of agent container images a Working Environment may
// select from. Written ONLY by the admin console's System-Admin-gated routes
// (POST/DELETE /api/toolchains); read here at spawn time — the same
// console-writes / orchestrator-reads split as /workspace/llm-endpoints.
//
// Re-validated on every read rather than trusted (the plugin-registry.js
// discipline): the file is the security boundary that keeps a Team Admin from
// introducing an image reference, so a hand-edited or half-written entry must be
// rejected here too, not just at the route that wrote it.
const TOOLCHAINS_INDEX = "/workspace/toolchains/index.json";

function loadToolchains() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(TOOLCHAINS_INDEX, "utf8"));
  } catch (err) {
    // Absent is the normal state — an installation that registered no toolchain
    // has no file, and every environment then resolves to the default image.
    if (err.code !== "ENOENT") {
      console.warn(`[Orchestrator] toolchain registry unreadable (${err.message}) — treating as empty`);
    }
    return [];
  }
  const { toolchains, errors } = normalizeRegistry(raw);
  for (const e of errors) console.warn(`[Orchestrator] toolchain registry: ${e} — entry skipped`);
  return toolchains;
}

// Resolve the container image for one agent: its Working Environment's
// toolchain, else the installation-wide default. Returns the seam's
// `{ image, toolchain }` pair, or `{ error }` with an operator-readable message
// when the selection cannot be honoured — never a silent fallback (AC7).
function resolveImageForAgent(config) {
  const env = config && config.environmentId ? loadEnvironment(config.environmentId) : null;
  const resolved = resolveAgentImage({
    environmentId: env ? env.id : (config && config.environmentId) || null,
    environmentName: env ? env.name : null,
    toolchainId: env ? env.toolchainId || null : null,
    toolchains: loadToolchains(),
    defaultImage: DEFAULT_AGENT_IMAGE,
    runtime: normalizeRuntime(process.env.AEE_CONTAINER_RUNTIME),
    // Where THIS deployment keeps its toolchain variant images (#1941 AC11).
    // A manifest declares the bare `as-agent-jvm:latest` the build produces;
    // a cluster pulls it from its Artifact Registry under the release's tag.
    // Both halves arrive on the deployment (the same overlay patch that carries
    // AGENT_IMAGE, pinned per release by deploy/k8s/set-images.sh) and are empty
    // on a local Podman stack, where the image IS in the local store under that
    // bare tag. Applied here at spawn time rather than baked into the registry
    // entry at install time, so a release re-pin reaches a toolchain that was
    // registered long before it, with no operator re-install.
    imagePrefix: process.env.AEE_TOOLCHAIN_IMAGE_PREFIX || "",
    imageTag: process.env.AEE_TOOLCHAIN_IMAGE_TAG || "",
  });
  if (resolved.error) return { error: resolved.error, message: resolved.message };
  return {
    image: resolved.image,
    // Non-null only for a toolchain image, so the seam knows whether an
    // image-missing failure is worth the "which environment / which toolchain"
    // sentence — a missing DEFAULT image is a broken installation, not this.
    toolchain: resolved.source === "toolchain"
      ? {
          toolchainId: resolved.toolchainId,
          environmentId: env ? env.id : null,
          environmentName: env ? env.name : null,
        }
      : null,
  };
}

// ============================================================
// Flow-anomaly sweep (#959, concept §4.1/§4.3)
// ============================================================
// Best-effort GitHub + run-state gather feeding the pure detector. All I/O is
// wrapped so a single failed fetch/read degrades to a partial result rather than
// a 500 — this is an observe-only surface, never a gate.

// A minimal GitHub GET returning parsed JSON, mirroring the poller's `_fetchJson`
// but path-based so it honours GITHUB_API_BASE (the E2E fake-github seam, #710).
function _flowGithubGetJson(apiPath, token) {
  const { resolveGithubApiTarget } = require("./github-api-base");
  const api = resolveGithubApiTarget();
  return new Promise((resolve, reject) => {
    const req = api.transport.request(
      {
        hostname: api.hostname,
        port: api.port,
        path: `${api.basePath}${apiPath}`,
        method: "GET",
        headers: {
          "User-Agent": "agent-studio-poller",
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": "2022-11-28",
        },
        timeout: 15_000,
      },
      (resp) => {
        let body = "";
        resp.on("data", (c) => (body += c));
        resp.on("end", () => {
          if (resp.statusCode !== 200) {
            return reject(new Error(`GitHub ${apiPath} → HTTP ${resp.statusCode}`));
          }
          try {
            resolve(JSON.parse(body));
          } catch (err) {
            reject(new Error(`GitHub ${apiPath} → bad JSON: ${err.message}`));
          }
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error(`GitHub ${apiPath} → timeout`)));
    req.end();
  });
}

// #1897 AC8: best-effort resolution of an issue/PR title for a synthetic
// internal-delivery event. The trigger notice shows `[#N](url): <title>` when
// the title is known; internal-transport (flow-emit) and plugin-fast-path
// deliveries synthesize a minimal `{number, html_url}` subject with NO title
// (only poller-delivered PRs are enriched today), so we fetch it here with the
// repo's team token — exactly as the poller does for PRs. Never throws and
// never blocks the hand-off: any missing-token/failure/timeout degrades to a
// null title, and the notice then shows `[#N](url)` with no title (AC5).
async function fetchWorkItemTitle(repoFullName, kind, number) {
  try {
    const tokenId = resolveRepoGithubTokenId(repoFullName);
    if (!tokenId) return null;
    const token = fs.readFileSync(path.join(GH_TOKENS_DIR, tokenId), "utf8").trim();
    const apiPath = kind === "pr"
      ? `/repos/${repoFullName}/pulls/${number}`
      : `/repos/${repoFullName}/issues/${number}`;
    const detail = await _flowGithubGetJson(apiPath, token);
    return detail && typeof detail.title === "string" && detail.title ? detail.title : null;
  } catch (err) {
    console.error(`[Orchestrator] title fetch failed for ${repoFullName}#${number}: ${err.message}`);
    return null;
  }
}

function _flowLiftEmits(cfgEmits, triggers) {
  const base = Array.isArray(cfgEmits) ? cfgEmits.filter((e) => typeof e === "string" && e) : [];
  const lifted = [];
  for (const t of Array.isArray(triggers) ? triggers : []) {
    if (t && Array.isArray(t.emits)) for (const e of t.emits) if (typeof e === "string" && e) lifted.push(e);
  }
  return lifted.length ? [...new Set([...base, ...lifted])] : base;
}

// Gather the team's flow model + a GitHub/run-state snapshot, then classify.
// Returns `{ teamId, generatedAt, thresholds, repos, model, anomalies }`.
async function computeTeamFlowAnomalies(teamId, { now = Date.now() } = {}) {
  const teamCfg = loadAgentConfig(teamId) || {};
  const labels = Array.isArray(teamCfg.labels) ? teamCfg.labels : [];
  const thresholds = flowAnomalySweep.resolveThresholds(teamCfg.anomalyThresholds);

  // 1) Members (+ their triggers) of this team.
  const members = [];
  const envIds = new Set();
  for (const id of listAgentIds()) {
    let cfg = null;
    try {
      cfg = loadAgentConfig(id);
    } catch {
      continue;
    }
    if (!cfg || cfg.role === "team") continue;
    if ((cfg.parentTeamId || null) !== teamId) continue;
    let triggers = [];
    try {
      const raw = JSON.parse(fs.readFileSync(agentStatePath(id, "triggers.json"), "utf8"));
      if (Array.isArray(raw)) triggers = raw;
    } catch {
      /* no triggers yet */
    }
    members.push({
      id,
      displayName: cfg.displayName || id,
      emits: _flowLiftEmits(cfg.emits, triggers),
      github: cfg.github || null,
      // Open-end markers (#1004): a terminal/external outcome makes a silent
      // run legitimate — the detector drops the output-missing expectation.
      outcomes: cfg.outcomes || null,
      triggers,
    });
    if (cfg.environmentId) envIds.add(cfg.environmentId);
  }

  const model = buildFlowModel(members, { labels });

  // Which labels the detector cares about — bound the (expensive) timeline
  // fetches to objects that actually carry one.
  const interesting = new Set([
    ...model.wakeEdges.map((w) => w.label),
    ...model.wakeEdges.map((w) => w.claimLabel),
    ...model.claimEdges.map((c) => c.claimLabel),
    ...model.gateLabels,
  ]);

  // 2) Resolve one token per repo across the team's environments.
  const repoToken = new Map();
  const allowNonGithubHost = String(process.env.AEE_ALLOW_NON_GITHUB_REPO_HOST || "") === "1";
  for (const envId of envIds) {
    const env = loadEnvironment(envId);
    if (!env || !env.githubTokenId) continue;
    let token = null;
    try {
      token = fs.readFileSync(path.join(GH_TOKENS_DIR, env.githubTokenId), "utf8").trim();
    } catch {
      continue;
    }
    if (!token) continue;
    for (const r of Array.isArray(env.repositories) ? env.repositories : []) {
      const full = ghParseRepoFullName(r && r.url, { allowNonGithubHost });
      if (full && !repoToken.has(full)) repoToken.set(full, token);
    }
  }

  // 3) Sweep GitHub for open issues/PRs, enriching interesting objects.
  const objects = [];
  const errors = [];
  for (const [repo, token] of repoToken) {
    const [owner, name] = repo.split("/");
    const seg = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
    let issues = [];
    let openPrs = [];
    try {
      issues = await _flowGithubGetJson(`${seg}/issues?state=open&per_page=100`, token);
    } catch (err) {
      errors.push(`${repo}: ${err.message}`);
      continue;
    }
    try {
      openPrs = await _flowGithubGetJson(`${seg}/pulls?state=open&per_page=100`, token);
    } catch {
      openPrs = [];
    }
    for (const it of Array.isArray(issues) ? issues : []) {
      const names = (Array.isArray(it.labels) ? it.labels : []).map((l) =>
        typeof l === "string" ? l : l && l.name,
      );
      let timeline = null;
      if (names.some((n) => interesting.has(n))) {
        try {
          timeline = await _flowGithubGetJson(`${seg}/issues/${it.number}/timeline`, token);
        } catch {
          timeline = null; // fall back to updated/created time
        }
      }
      const linked =
        flowAnomalySweep.objectKind(it) === "issue"
          ? flowAnomalySweep.prsForIssue(openPrs, it.number)
          : [];
      objects.push(flowAnomalySweep.issueToDetectorObject(it, { timeline, linkedPrNumbers: linked }));
    }
  }

  // 4) Per-consumer run state (running-sessions registry + session logs).
  const sessions = {};
  for (const id of Object.keys(model.consumers)) {
    const active = new Set();
    let running = false;
    try {
      const reg = JSON.parse(fs.readFileSync(agentStatePath(id, "running-sessions.json"), "utf8"));
      if (Array.isArray(reg)) {
        running = reg.length > 0;
        for (const s of reg) if (s && s.correlationId) active.add(s.correlationId);
      }
    } catch {
      /* no active sessions */
    }
    const events = [];
    try {
      const dir = agentStatePath(id, "sessions");
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith(".jsonl")) continue;
        const raw = fs.readFileSync(path.join(dir, f), "utf8");
        for (const line of raw.split("\n")) {
          const t = line.trim();
          if (!t) continue;
          try {
            events.push(JSON.parse(t));
          } catch {
            /* skip malformed line */
          }
        }
      }
    } catch {
      /* no session logs */
    }
    sessions[id] = { running, runs: flowAnomalySweep.runsFromSessionEvents(events, active) };
  }

  const { anomalies } = detectFlowAnomalies({ model, github: { objects }, sessions, thresholds, now });
  return {
    teamId,
    generatedAt: new Date(now).toISOString(),
    thresholds,
    repos: [...repoToken.keys()],
    swept: objects.length,
    errors,
    model,
    anomalies,
  };
}

// ============================================================
// Hill-climbing loop Phase 1 (#1222): per-team run-metrics collector.
// Concept `docs/hill-climbing-agent-concept.md` §3.1/§4/§7. The deterministic
// side lives in the pure `hill-climb-metrics.js` + `hill-climb-sweep.js`
// (golden-fixture tested); this function is the I/O adapter that reads the log
// surfaces off disk and feeds them in. It performs NO GitHub calls — every
// signal is log-driven (session JSONL, usage spool, anomaly-history, the
// event-transparency log, audit / prompt-history) — so a scheduled pass and a
// manual pass produce identical snapshots for identical inputs.
// ============================================================
const HILL_CLIMB_TEAMS_DIR = process.env.HILL_CLIMB_TEAMS_DIR || "/workspace/teams";
// Per-team single-flight lock shared by the scheduled pass and the manual
// endpoint (a manual POST while a pass runs → 409 pass-running).
const _hillClimbInFlight = new Set();

// Read + JSON-parse a JSONL file into an array of rows; [] on any failure.
function _readJsonlRows(file) {
  try {
    const raw = fs.readFileSync(file, "utf8");
    const out = [];
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try { out.push(JSON.parse(t)); } catch { /* skip malformed line */ }
    }
    return out;
  } catch { return []; }
}

// All of one agent's session events across the live file + rotated archives.
function _readAgentSessionEvents(id) {
  const events = [];
  try {
    const dir = agentStatePath(id, "sessions");
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".jsonl")) continue;
      for (const ev of _readJsonlRows(path.join(dir, f))) events.push(ev);
    }
  } catch { /* no session logs */ }
  return events;
}

// Audit entries within the window (config-version boundary fallback when an
// agent has no prompt-history). Newest-only read to bound the scan.
function _readAuditEntriesSince(sinceMs) {
  const dir = process.env.AUDIT_DIR || "/workspace/audit";
  const out = [];
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!/^audit-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)) continue;
      for (const e of _readJsonlRows(path.join(dir, f))) {
        const t = e && e.ts ? Date.parse(e.ts) : NaN;
        if (Number.isFinite(t) && (sinceMs == null || t >= sinceMs)) out.push(e);
      }
    }
  } catch { /* no audit */ }
  return out;
}

async function computeTeamHillClimbMetrics(teamId, { now = Date.now() } = {}) {
  const teamCfg = loadAgentConfig(teamId) || {};
  const hc = teamCfg.hillClimb && typeof teamCfg.hillClimb === "object" ? teamCfg.hillClimb : {};
  const windowDays = Number.isFinite(hc.windowDays) && hc.windowDays > 0 ? hc.windowDays : 7;
  const minRunsPerWindow = Number.isFinite(hc.minRunsPerWindow) && hc.minRunsPerWindow >= 0
    ? hc.minRunsPerWindow : 20;
  const excludeAgents = Array.isArray(hc.excludeAgents)
    ? hc.excludeAgents.filter((s) => typeof s === "string") : [];
  const fromMs = now - windowDays * 24 * 60 * 60 * 1000;

  const auditEntries = _readAuditEntriesSince(fromMs);

  // 1) Members of this team + their triggers/ports (dead-config + rework inputs).
  const members = [];
  for (const id of listAgentIds()) {
    let cfg = null;
    try { cfg = loadAgentConfig(id); } catch { continue; }
    if (!cfg || cfg.role === "team") continue;
    if ((cfg.parentTeamId || null) !== teamId) continue;
    let triggers = [];
    try {
      const raw = JSON.parse(fs.readFileSync(agentStatePath(id, "triggers.json"), "utf8"));
      if (Array.isArray(raw)) triggers = raw;
    } catch { /* no triggers yet */ }
    members.push({ id, emits: cfg.emits, outcomes: cfg.outcomes, triggers });
  }
  const reworkTriggers = hillClimbSweep.reworkTriggerIds(members);

  // 2) Per-member: session runs + token cost + config-version boundaries.
  const runs = [];
  const configBoundaries = {};
  for (const m of members) {
    const events = _readAgentSessionEvents(m.id);
    const usageByCorr = hillClimbSweep.usageByCorrelation(_readJsonlRows(agentStatePath(m.id, "usage-spool.jsonl")));
    const active = new Set();
    try {
      const reg = JSON.parse(fs.readFileSync(agentStatePath(m.id, "running-sessions.json"), "utf8"));
      if (Array.isArray(reg)) for (const s of reg) if (s && s.correlationId) active.add(s.correlationId);
    } catch { /* no active sessions */ }
    for (const r of hillClimbSweep.runsFromSessionEvents(events, {
      agentId: m.id, usageByCorr, reworkTriggerIds: reworkTriggers, activeCorrelationIds: active,
    })) runs.push(r);
    let promptHistory = null;
    try {
      promptHistory = JSON.parse(fs.readFileSync(path.join(agentStateDir(m.id), "prompt-history.json"), "utf8"));
    } catch { /* no prompt-history — audit fallback */ }
    configBoundaries[m.id] = hillClimbSweep.configBoundariesForAgent(promptHistory, auditEntries, m.id);
  }

  // 3) Anomaly recurrence — read #1221's per-team history file by PATH (so this
  //    feature doesn't hard-depend on that module being present); [] if absent.
  let anomalyHistory = [];
  const seg = knowledgeFeed.safeTeamSegment(teamId);
  if (seg) anomalyHistory = _readJsonlRows(path.join(HILL_CLIMB_TEAMS_DIR, seg, "hill-climb", "anomaly-history.jsonl"));

  // 4) Waste signals from the (global) event-transparency log, scoped to team.
  const teamAgentIds = new Set(members.map((m) => m.id));
  const eventLogEntries = [];
  try {
    const dir = githubEventLog.EVENT_LOG_DIR;
    for (const f of fs.readdirSync(dir)) {
      if (!/^github-events-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)) continue;
      for (const e of _readJsonlRows(path.join(dir, f))) eventLogEntries.push(e);
    }
  } catch { /* no event log */ }
  const waste = hillClimbSweep.wasteSignalsFromEventLog(eventLogEntries, fromMs, now, teamAgentIds);

  const snapshot = hillClimbMetrics.computeHillClimbMetrics({
    runs,
    anomalyHistory,
    configBoundaries,
    triggerDefs: hillClimbSweep.triggerDefsFromMembers(members),
    emitLabels: hillClimbSweep.emitLabelsFromMembers(members),
    consumedLabels: hillClimbSweep.consumedLabelsFromMembers(members),
    throttleDrops: waste.throttleDrops,
    digestFolds: waste.digestFolds,
  }, { now, windowDays, minRunsPerWindow, excludeAgents });

  return { teamId, generatedAt: new Date(now).toISOString(), ...snapshot };
}

// Day-keyed snapshot path (same-day re-run overwrites). Traversal-guarded via
// safeTeamSegment — the same guard the KB clone + anomaly-history file use.
function hillClimbSnapshotPath(teamId, dateStr) {
  const seg = knowledgeFeed.safeTeamSegment(teamId);
  if (!seg) return null;
  return path.join(HILL_CLIMB_TEAMS_DIR, seg, "hill-climb", "metrics", `${dateStr}.json`);
}
function persistHillClimbSnapshot(teamId, snapshot, now = Date.now()) {
  const p = hillClimbSnapshotPath(teamId, new Date(now).toISOString().slice(0, 10));
  if (!p) return null;
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(snapshot, null, 2));
    return p;
  } catch { return null; }
}
function readLatestHillClimbSnapshot(teamId) {
  const seg = knowledgeFeed.safeTeamSegment(teamId);
  if (!seg) return null;
  const dir = path.join(HILL_CLIMB_TEAMS_DIR, seg, "hill-climb", "metrics");
  try {
    const files = fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
    if (!files.length) return null;
    return JSON.parse(fs.readFileSync(path.join(dir, files[files.length - 1]), "utf8"));
  } catch { return null; }
}

// ── improvement-card store (hill-climbing loop Phase 2, #1224) ───────────────
//
// Persist the team's improvement cards next to its metrics snapshots at
// /workspace/teams/<teamId>/hill-climb/cards.json. Traversal-guarded via
// safeTeamSegment (same guard as the snapshot/anomaly-history files). The store
// is the single JSON array of cards across their whole lifecycle (open → applied
// → validated/… ); config never travels here (it rides the team-agent bundle).
function hillClimbCardsPath(teamId) {
  const seg = knowledgeFeed.safeTeamSegment(teamId);
  if (!seg) return null;
  return path.join(HILL_CLIMB_TEAMS_DIR, seg, "hill-climb", "cards.json");
}
function readHillClimbCards(teamId) {
  const p = hillClimbCardsPath(teamId);
  if (!p) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    return Array.isArray(raw) ? raw : (Array.isArray(raw.cards) ? raw.cards : []);
  } catch { return []; }
}
function writeHillClimbCards(teamId, cards) {
  const p = hillClimbCardsPath(teamId);
  if (!p) return null;
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(Array.isArray(cards) ? cards : [], null, 2));
    return p;
  } catch { return null; }
}

// The per-team card budget/window config, read off the team agent's hillClimb
// blob (round-tripped like stages/labels). autonomy 0 = collector only (no cards).
function hillClimbCardConfig(teamId) {
  const cfg = loadAgentConfig(teamId) || {};
  const hc = cfg.hillClimb && typeof cfg.hillClimb === "object" ? cfg.hillClimb : {};
  const autonomy = [0, 1, 2, 3].includes(hc.autonomy) ? hc.autonomy : 2;
  const maxCardsPerPass = Number.isFinite(hc.maxCardsPerPass) && hc.maxCardsPerPass >= 0
    ? hc.maxCardsPerPass : hillClimbCards.DEFAULT_MAX_CARDS_PER_PASS;
  const windowDays = Number.isFinite(hc.windowDays) && hc.windowDays > 0 ? hc.windowDays : 7;
  return { autonomy, maxCardsPerPass, windowDays };
}

// Fold this pass's incoming cards (heuristic and/or analyst) into the persisted
// store under the budget/dedup/cooldown rules, re-validating every incoming card
// through the schema (invalid ones are dropped — the store is the authority even
// for analyst output). Persists and returns the merge summary. Never throws.
function mergeAndPersistHillClimbCards(teamId, incoming, { now = Date.now(), source = "heuristic" } = {}) {
  const { maxCardsPerPass, windowDays } = hillClimbCardConfig(teamId);
  const existing = readHillClimbCards(teamId);
  const passId = `pass-${new Date(now).toISOString()}`;
  const valid = [];
  let rejected = 0;
  for (const raw of Array.isArray(incoming) ? incoming : []) {
    // Heuristic cards arrive already-normalized; analyst cards are raw JSON.
    const card = raw && raw.status && raw.id
      ? raw
      : (() => { const n = hillClimbCards.normalizeCard(raw, { teamId, now, source, passId }); return n.ok ? n.card : null; })();
    if (!card) { rejected += 1; continue; }
    if (!hillClimbCards.validateCard(card).ok) { rejected += 1; continue; }
    valid.push(card);
  }
  const merged = hillClimbCards.mergeCards(existing, valid, { maxCardsPerPass, windowDays, now, passId });
  const savedPath = writeHillClimbCards(teamId, merged.cards);
  return { ...merged, rejected, path: savedPath, cards: merged.cards };
}

// Dismiss a card (human action): flip its status to 'dismissed' so it is not
// re-raised. Returns the updated card or null when unknown. Proposals-only —
// dismiss changes card state, never any agent config.
function dismissHillClimbCard(teamId, cardId, { now = Date.now() } = {}) {
  const cards = readHillClimbCards(teamId);
  const card = cards.find((c) => c && c.id === cardId);
  if (!card) return null;
  card.status = "dismissed";
  card.updatedAt = new Date(now).toISOString();
  writeHillClimbCards(teamId, cards);
  return card;
}

// Record an APPLIED card (hill-climbing loop Phase 2b, #1225). The console runs
// the actual mutation through the existing audited choke-point (as the acting
// human); this endpoint only stamps the outcome onto the card so #1226 can
// measure it across the config boundary. Gated: autonomy < 2 refuses (apply is
// a level-2 action even via a direct call), and only an OPEN card can be applied
// (an already-applied/dismissed card is left untouched). The applied patch
// carries the apply timestamp, the config-version reference, the baseline
// metrics snapshot, the undo payload the console gathered before mutating, and a
// one-window cooldown (so a re-detected finding can't bump the applied card and
// contaminate its own measurement). Returns { ok, code?, card? }.
function applyHillClimbCard(teamId, cardId, { now = Date.now(), appliedBy = null, undo = null, configVersionRef = null } = {}) {
  const { autonomy, windowDays } = hillClimbCardConfig(teamId);
  if (!hillClimbApply.canApplyAtAutonomy(autonomy)) {
    return { ok: false, code: "autonomy-locked", autonomy };
  }
  const cards = readHillClimbCards(teamId);
  const card = cards.find((c) => c && c.id === cardId);
  if (!card) return { ok: false, code: "card-not-found" };
  if (card.status !== "open") return { ok: false, code: "card-not-open", status: card.status };
  const snapshot = readLatestHillClimbSnapshot(teamId);
  const patch = hillClimbApply.buildAppliedPatch(card, { now, appliedBy, snapshot, undo, configVersionRef, windowDays });
  Object.assign(card, patch);
  writeHillClimbCards(teamId, cards);
  return { ok: true, card };
}

// The verdict step (hill-climbing loop Phase 3, #1226). For every `applied`
// card whose full measurement window has elapsed AFTER the config boundary it
// created, compare the declared target metric before/after and transition the
// card: improved → validated, regressed → a rollback card, neutral → neutral
// (finalised only after two windows), thin sample → insufficient-data (deferred,
// never guessed). Pure logic in `hill-climb-verdict.js`; this reads/writes the
// store. Runs every pass, independent of autonomy (measurement is honest
// bookkeeping — it never mutates any agent config). Returns the verdict summary.
function runVerdictStep(teamId, snapshot, { now = Date.now() } = {}) {
  const { minRunsPerWindow, windowDays } = (() => {
    const cfg = loadAgentConfig(teamId) || {};
    const hc = cfg.hillClimb && typeof cfg.hillClimb === "object" ? cfg.hillClimb : {};
    return {
      minRunsPerWindow: Number.isFinite(hc.minRunsPerWindow) && hc.minRunsPerWindow >= 0 ? hc.minRunsPerWindow : 20,
      windowDays: Number.isFinite(hc.windowDays) && hc.windowDays > 0 ? hc.windowDays : 7,
    };
  })();
  const cards = readHillClimbCards(teamId);
  if (!cards.some((c) => c && c.status === "applied")) return { transitioned: 0, verdicts: [] };
  const out = hillClimbVerdict.applyVerdicts(cards, snapshot, { now, minRunsPerWindow, windowDays });
  if (out.transitioned > 0) writeHillClimbCards(teamId, out.cards);
  return { transitioned: out.transitioned, verdicts: out.verdicts };
}

// Record a ROLLED-BACK card (hill-climbing loop Phase 3, #1226). The console has
// already executed the card's rollback plan through the same audited choke-point
// as the apply (§3.3) — this only stamps the outcome so the object re-enters
// detection after a fresh window (the cooldown the merge honours). Gated like
// apply: autonomy < 2 refuses, and only a `regressed` card (one carrying a
// rollback offer) can be rolled back. A rollback is always a human click, never
// auto-reverted. Returns { ok, code?, card? }.
function rollbackHillClimbCard(teamId, cardId, { now = Date.now(), rolledBackBy = null, undoResult = null } = {}) {
  const { autonomy, windowDays } = hillClimbCardConfig(teamId);
  if (!hillClimbApply.canApplyAtAutonomy(autonomy)) {
    return { ok: false, code: "autonomy-locked", autonomy };
  }
  const cards = readHillClimbCards(teamId);
  const card = cards.find((c) => c && c.id === cardId);
  if (!card) return { ok: false, code: "card-not-found" };
  if (card.status !== "regressed") return { ok: false, code: "card-not-regressed", status: card.status };
  const nowIso = new Date(now).toISOString();
  const days = Number.isFinite(windowDays) && windowDays > 0 ? windowDays : 7;
  card.status = "rolled-back";
  card.rolledBackAt = nowIso;
  card.rolledBackBy = rolledBackBy ? String(rolledBackBy) : null;
  card.updatedAt = nowIso;
  // A fresh window before the same finding may be raised again (AC: a rolled-back
  // object re-enters detection only after a fresh window).
  card.cooldownUntil = new Date(now + days * 24 * 60 * 60 * 1000).toISOString();
  if (undoResult != null) card.undoResult = undoResult;
  writeHillClimbCards(teamId, cards);
  return { ok: true, card };
}

// Run one hill-climb pass for a team behind the per-team single-flight lock —
// the SAME code path for the scheduled timer and the manual POST endpoint (AC:
// manual and scheduled passes produce identical snapshots for identical inputs).
// A manual run started while a pass is already in flight is refused so the
// endpoint can answer 409 pass-running. Also folds the deterministic heuristic
// findings into the card store (concept §3.2 honest fallback — cards ship on
// every pass, provider or not) and returns the secret-free analyst digest so the
// console can run the LLM analyst step over it (#1224). Cards are proposals only.
// Returns { ok:true, snapshot, path, cards, digest, merge } or { ok:false, reason }.
async function runHillClimbPass(teamId, { now = Date.now() } = {}) {
  if (_hillClimbInFlight.has(teamId)) return { ok: false, reason: "pass-running" };
  _hillClimbInFlight.add(teamId);
  try {
    const snapshot = await computeTeamHillClimbMetrics(teamId, { now });
    const savedPath = persistHillClimbSnapshot(teamId, snapshot, now);
    const { autonomy } = hillClimbCardConfig(teamId);
    // Verdict step (#1226): measure already-applied changes across the config
    // boundary BEFORE folding this pass's new findings, so a regressed card is
    // flipped to a rollback card and its object is not re-raised as a duplicate.
    const verdict = runVerdictStep(teamId, snapshot, { now });
    let merge = null;
    let digest = null;
    if (autonomy >= 1) {
      // Deterministic findings → cards (the honest fallback shipped every pass).
      const anomalyHistory = _readTeamAnomalyHistory(teamId);
      const findings = hillClimbCards.heuristicFindings(snapshot, { now, anomalyHistory });
      merge = mergeAndPersistHillClimbCards(teamId, findings, { now, source: "heuristic" });
      // Secret-free digest for the console's server-side analyst (concept §3.2).
      digest = hillClimbCards.buildAnalystDigest(snapshot, { findings });
    }
    return {
      ok: true,
      snapshot,
      path: savedPath,
      cards: merge ? merge.cards : [],
      merge: merge ? { added: merge.added, bumped: merge.bumped, deferred: merge.deferred, rejected: merge.rejected } : null,
      verdict: { transitioned: verdict.transitioned, verdicts: verdict.verdicts },
      digest,
      autonomy,
    };
  } finally {
    _hillClimbInFlight.delete(teamId);
  }
}

// Read the team's raw #1221 anomaly-history rows (for object-keyed recurrence
// cards). Best-effort; [] when absent. Traversal-guarded like the metrics files.
function _readTeamAnomalyHistory(teamId) {
  const seg = knowledgeFeed.safeTeamSegment(teamId);
  if (!seg) return [];
  return _readJsonlRows(path.join(HILL_CLIMB_TEAMS_DIR, seg, "hill-climb", "anomaly-history.jsonl"));
}

// Enrich a token-usage record (#654) with the authoritative control-plane
// identity the agent can only send best-effort. The agent alone observes the
// turn-wide token counts and stamps them; the orchestrator owns the config,
// so it backfills teamId / roleId / provider when the record left them null.
// agentId is forced to the posting agent (path param) — never trusted from
// the body. Only null/absent fields are filled, so a value the agent already
// resolved correctly is kept.
function enrichUsageRecord(agentId, record) {
  const out = { ...(record && typeof record === "object" ? record : {}) };
  out.agentId = agentId;
  const cfg = loadAgentConfig(agentId) || {};
  const teamId = cfg.parentTeamId || cfg.teamId || null;
  if (out.teamId == null) out.teamId = teamId;
  if (out.roleId == null) {
    // Team members are ided `<teamId>-<roleId>`; strip the team prefix to
    // recover the semantic role. Otherwise fall back to the config role.
    let roleId = cfg.roleId || null;
    if (!roleId && teamId && agentId.startsWith(`${teamId}-`)) {
      roleId = agentId.slice(teamId.length + 1);
    }
    out.roleId = roleId || cfg.role || null;
  }
  if (out.provider == null) {
    const env = cfg.environmentId ? loadEnvironment(cfg.environmentId) : null;
    // A per-agent provider override wins over the environment binding.
    out.provider = cfg.llmEndpointOverride || env?.llmEndpointId || null;
  }
  return out;
}

// Apply every environment normalization in order. Repositories first (the
// knowledgeStore normalization reads the repository list to pick a KB repo).
function normalizeEnvironmentConfig(env) {
  const withRepos = normalizeEnvironmentRepositories(env);
  const { store } = normalizeKnowledgeStore(withRepos);
  return { ...withRepos, knowledgeStore: store };
}

// Migrate legacy `repository` (single) into `repositories: [...]` so the rest
// of the orchestrator can iterate over a uniform list.
function normalizeEnvironmentRepositories(env) {
  if (!env) return env;
  if (Array.isArray(env.repositories)) return env;
  if (env.repository && env.repository.url) {
    return { ...env, repositories: [env.repository] };
  }
  return { ...env, repositories: [] };
}

// ============================================================
// Blueprint storage
// ============================================================
function blueprintDir(id) {
  return path.join(BLUEPRINTS_DIR, id);
}

function loadBlueprint(id) {
  const p = path.join(blueprintDir(id), "blueprint.json");
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

function saveBlueprint(id, data) {
  const dir = blueprintDir(id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "blueprint.json"), JSON.stringify(data, null, 2));
}

function listBlueprintIds() {
  if (!fs.existsSync(BLUEPRINTS_DIR)) return [];
  return fs.readdirSync(BLUEPRINTS_DIR).filter(f =>
    fs.existsSync(path.join(BLUEPRINTS_DIR, f, "blueprint.json"))
  );
}

function listInstanceIds(blueprintId) {
  return listAgentIds().filter(id => {
    const cfg = loadAgentConfig(id);
    return cfg && cfg.blueprintId === blueprintId;
  });
}

// ============================================================
// Blueprint shared memory
// ============================================================
function blueprintMemoryDir(blueprintId) {
  return path.join(BLUEPRINTS_DIR, blueprintId, "memory");
}

function ensureBlueprintMemoryDir(blueprintId) {
  const dir = blueprintMemoryDir(blueprintId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function readBlueprintMemory(blueprintId, filename) {
  const safeFilename = path.basename(filename);
  const p = path.join(blueprintMemoryDir(blueprintId), safeFilename);
  try {
    if (fs.existsSync(p)) return fs.readFileSync(p, "utf8");
  } catch {}
  return "";
}

function writeBlueprintMemory(blueprintId, filename, content) {
  const dir = ensureBlueprintMemoryDir(blueprintId);
  const safeFilename = path.basename(filename);
  const p = path.join(dir, safeFilename);
  const tmp = p + ".tmp";
  fs.writeFileSync(tmp, content, "utf8");
  fs.renameSync(tmp, p);
}

// Seed blueprint memory from template if files don't exist yet
function seedBlueprintMemory(blueprintId) {
  const dir = ensureBlueprintMemoryDir(blueprintId);
  const templateMemory = path.join(TEMPLATE_WORKSPACE, "memory");
  if (!fs.existsSync(templateMemory)) return;
  for (const file of fs.readdirSync(templateMemory)) {
    const dst = path.join(dir, file);
    if (!fs.existsSync(dst)) {
      try {
        let content = fs.readFileSync(path.join(templateMemory, file), "utf8");
        content = content.replace(/\/workspace\//g, "./");
        fs.writeFileSync(dst, content, "utf8");
      } catch {}
    }
  }
}

// Read the one-line `description` for each granted skill from its SKILL.md,
// resolving the source with the SAME agent→team→global order as seeding
// (skill-source.js) so a team-overridden skill shows that copy's description
// (#617). Returns `{ <skillName>: description }`; skills whose dir/SKILL.md/
// description can't be resolved are simply omitted (fail-soft, AC7) — the
// assembler then lists them by name only. The I/O lives here so
// `assembleClaudeMd` stays pure (AC5).
function agentSkillDescriptions(id, teamId, skills) {
  const out = {};
  if (!Array.isArray(skills)) return out;
  for (const name of skills) {
    try {
      const src = resolveSkillSourceDir(name, teamId, { agentId: id });
      if (!src) continue;
      const desc = parseSkillDescription(fs.readFileSync(path.join(src, "SKILL.md"), "utf8"));
      if (desc) out[name] = desc;
    } catch { /* fail-soft: list this skill by name only */ }
  }
  return out;
}

// The display data the gated "Plugin Capabilities" CLAUDE.md block is built
// from (#1547): the agent's RESOLVED plugin grant joined with each plugin's
// installed manifest. Built from the grant, never from the seeded config file's
// contents (§4.7) — and a granted-but-uninstalled plugin contributes nothing,
// so the prompt can't advertise a CLI the workspace doesn't have.
function agentPluginDisplays(cfg) {
  if (!cfg) return [];
  let grant;
  try { grant = effectivePlugins(cfg, loadAgentConfig); } catch { return []; }
  if (!Array.isArray(grant) || grant.length === 0) return [];
  let manifests;
  try { manifests = pluginRegistry.installedManifests(); } catch { return []; }
  return grant
    .map((g) => pluginRegistry.promptDisplayFor(manifests[g.id], g.scopeGranularity))
    .filter(Boolean);
}

// Full plugin reconcile (#1547): sidecars first (so a newly-installed plugin
// has something to attach), then grant-driven network attachment for every
// installed plugin. Used at boot and after an install/uninstall — idempotent,
// so calling it more often than necessary is harmless.
async function reconcilePluginsAndAttachments() {
  const sidecars = await pluginRuntime.reconcilePluginSidecars();
  if (sidecars.supported === false) return { sidecars, networks: [] };
  let networks = [];
  if (orchestratorSingleton) {
    try {
      networks = await orchestratorSingleton._reconcilePluginNetworks(
        Object.keys(pluginRegistry.installedManifests()),
      );
    } catch (err) {
      console.warn(`[Orchestrator] plugin network reconcile failed: ${err.message}`);
    }
  }
  // github-issues (#1633): hand each granted team's env GitHub token + repo list
  // to its broker (best-effort — the token never reaches a browser or an agent).
  try { await pushGithubIssueScopeCredentials(); } catch (err) {
    console.warn(`[Orchestrator] github-issues credential push failed: ${err.message}`);
  }
  return { sidecars, networks };
}

// Resolve, per team the github-issues plugin is granted to, that team's Working-
// Environment GitHub token + repository list, and push the map to the plugin's
// broker (orchestrator/plugin-github-creds.js + plugin-runtime.pushScopeCredentials).
// A no-op when the plugin isn't installed. Best-effort; never throws into a
// reconcile. This is the plugin's live-wiring completion step (the resolver +
// broker map handling are the unit-tested pure cores).
async function pushGithubIssueScopeCredentials() {
  const PLUGIN = "github-issues";
  let entry;
  try { entry = pluginRegistry.readPluginManifest(PLUGIN); } catch { return; }
  if (!entry || !entry.ok || !entry.manifest) return; // not installed / invalid

  // Which team scopes the plugin is granted to (team granularity → scopeId is the
  // team id, matching the broker's viewer/agent scope key).
  const scopeIds = new Set();
  let ids = [];
  try { ids = listAgentIds(); } catch { ids = []; }
  for (const id of ids) {
    const cfg = loadAgentConfig(id);
    if (!cfg || !cfg.token) continue; // a stub has no running surface
    let grant = null;
    try { grant = pluginGrantFor(effectivePlugins(cfg, loadAgentConfig), PLUGIN); } catch { grant = null; }
    if (!grant) continue;
    const scopeId = resolveScopeId(cfg, grant.scopeGranularity);
    if (scopeId) scopeIds.add(scopeId);
  }

  // Even a fully-revoked plugin gets an (empty) push so the broker clears any
  // stale team it still holds.
  const allowNonGithubHost = String(process.env.AEE_ALLOW_NON_GITHUB_REPO_HOST || "") === "1";
  const envForScope = (sid) => {
    const teamCfg = loadAgentConfig(sid);
    return teamCfg && teamCfg.environmentId ? loadEnvironment(teamCfg.environmentId) : null;
  };
  const readToken = (tokenId) => {
    try { return fs.readFileSync(path.join(GH_TOKENS_DIR, tokenId), "utf8"); } catch { return null; }
  };
  const scopes = resolveScopeGithubCredentials([...scopeIds], {
    envForScope,
    readToken,
    parseRepoFullName: (url) => ghParseRepoFullName(url, { allowNonGithubHost }),
  });
  // Enrich each entry with the team's display name (for the UI's team selector)
  // and its FLOW labels + per-repo label→agent trigger preview (#1642, Item 2):
  // the gate/outcome labels the team's flow uses, suggested ahead of the repo's
  // raw label list, each previewing which agent(s) it wakes. Derived here (I/O)
  // and folded by the pure `buildTeamFlowLabels`.
  for (const sid of Object.keys(scopes)) {
    const teamCfg = loadAgentConfig(sid);
    scopes[sid].teamName = (teamCfg && (teamCfg.displayName || teamCfg.name)) || sid;
    const { flowLabels, labelAgents, labelUsage } = buildTeamFlowLabels({
      teamLabels: teamCfg && Array.isArray(teamCfg.labels) ? teamCfg.labels : [],
      members: teamFlowMembers(sid),
    });
    scopes[sid].flowLabels = flowLabels;
    scopes[sid].labelAgents = labelAgents;
    // Per-label usage classification (#1730) so the plugin can colour-code the
    // workflow-trigger buttons (human-set gate vs. agent-emitted label).
    scopes[sid].labelUsage = labelUsage;
  }
  await pluginRuntime.pushScopeCredentials(entry.manifest, scopes);
}

// The enabled members of a team, each shaped `{ displayName, enabled, triggers,
// emits }` for `buildTeamFlowLabels`. Mirrors the member+triggers.json read the
// flow-anomaly sweep does; a team with no members yields []. Best-effort per id.
function teamFlowMembers(teamId) {
  const out = [];
  let ids = [];
  try { ids = listAgentIds(); } catch { ids = []; }
  for (const id of ids) {
    let cfg = null;
    try { cfg = loadAgentConfig(id); } catch { continue; }
    if (!cfg || cfg.role === "team") continue;
    if ((cfg.parentTeamId || null) !== teamId) continue;
    let triggers = [];
    try {
      const raw = JSON.parse(fs.readFileSync(agentStatePath(id, "triggers.json"), "utf8"));
      if (Array.isArray(raw)) triggers = raw;
    } catch { /* no triggers yet */ }
    out.push({
      displayName: cfg.displayName || id,
      enabled: cfg.enabled !== false,
      triggers,
      emits: _flowLiftEmits(cfg.emits, triggers),
    });
  }
  return out;
}

// Compose an agent's CLAUDE.md. The base template is read here (I/O); the
// ordering / conditional-gating / de-duplication rules live in the pure,
// unit-tested `prompt-assembly` module.
function buildAgentClaudeMd(agentPrompt, role, env, blueprintId = null, opts = {}) {
  const candidates = [
    path.join(TEMPLATE_WORKSPACE, "CLAUDE.md"),
    "/defaults/CLAUDE.md",
  ];
  let base = "";
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        base = fs.readFileSync(candidate, "utf8");
        if (base) break;
      }
    } catch (err) {
      console.log(`[Orchestrator] Could not read ${candidate}: ${err.message}`);
    }
  }
  if (!base) return agentPrompt;

  return assembleClaudeMd({
    base,
    agentPrompt,
    role,
    env,
    skills: Array.isArray(opts.skills) ? opts.skills : [],
    skillDescriptions: opts.skillDescriptions && typeof opts.skillDescriptions === "object" ? opts.skillDescriptions : {},
    // Resolved plugin grant → the gated Plugin Capabilities section (#1547).
    // Empty → the section is absent entirely, like Skills.
    plugins: Array.isArray(opts.plugins) ? opts.plugins : [],
    blueprintId,
    autonomous: !!opts.autonomous,
    // Seeding passes promptRef so CLAUDE.md references AGENT-PROMPT.md; a
    // caller may omit it to inline the fully-resolved prompt instead.
    promptRef: opts.promptRef || null,
    // Set only when the agent has a provisioned KB checkout (see
    // saveAgentPrompt) — gates the Team Knowledge digest `@`-import.
    knowledgeDigestRef: opts.knowledgeDigestRef || null,
    // Resolved list of host-folder mounts (#1283 single, #1290 multiple), when
    // the agent has any — gates + populates the Context Folder section (#1286),
    // enumerating each folder with its in-container path and access mode (#1289).
    // Empty → the section is absent (byte-identical to a no-mount agent).
    contextMounts: Array.isArray(opts.contextMounts) ? opts.contextMounts : [],
    // #2067: repositories attached to this ONE agent, outside its Working
    // Environment. Listed alongside the inherited ones and counted by the
    // Git-section gate. Empty → byte-identical to a pre-#2067 agent.
    agentRepositories: normalizeAgentRepositories(opts.agentRepositories),
  });
}

// ── Seeded-skills manifest ──────────────────────────────────────────────────
// Records which skills actually landed in an agent's workspace, with tier and
// timestamp: /workspace/agents/<id>/.agent-studio/seeded-skills.json →
//   { "<skillName>": { "tier": "agent"|"team"|"global", "seededAt": "<ISO>" } }
// This is THE truth for "is this skill active for this member" — the grant
// list alone can't tell whether a running member was seeded before or after a
// name was added (docs/knowledge-skill-activation-concept.md §4.1). Written by
// every seed and by the activation sync; read by the admin console's
// knowledge-graph activation block. `agentStateDir` migrates a legacy `.aee/`
// to `.agent-studio/` on first touch (#1549).
const SEEDED_SKILLS_FILE = "seeded-skills.json";

// The migrating state-dir choke-point (#1549): resolves `.agent-studio/`, moving
// a legacy `.aee/` over exactly once so an upgraded agent keeps all state.
function agentStateDir(id) {
  return resolveAgentStateDir(agentDir(id));
}

function readSeededSkills(id) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(agentStateDir(id), SEEDED_SKILLS_FILE), "utf8"));
    return m && typeof m === "object" ? m : {};
  } catch { return {}; }
}

function writeSeededSkills(id, manifest) {
  const p = path.join(agentStateDir(id), SEEDED_SKILLS_FILE);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(manifest, null, 2));
}

// ── Custom slash-command provisioning (#1796) ──────────────────────────────
// A granted skill may ship a `commands/*.md` subdir; those command files are
// projected into the agent workspace's `.claude/commands/<namespace>/` so Claude
// Code loads them (invoked as `/<namespace>:<name>`). The per-agent manifest
// `seeded-commands.json` (name + description per command) is the truth a
// downstream reader (#1797 autocomplete) consumes and the runtime reads to
// distinguish a known command from an unknown `/token`.
function readSeededCommands(id) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(agentStateDir(id), skillCommands.SEEDED_COMMANDS_FILE), "utf8"));
    return m && typeof m === "object" ? m : {};
  } catch { return {}; }
}

function writeSeededCommands(id, manifest) {
  const p = path.join(agentStateDir(id), skillCommands.SEEDED_COMMANDS_FILE);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(manifest, null, 2));
}

// Project (or, with remove, unproject) one skill's bundled commands into the
// agent workspace, mutating `manifest` in place. Returns the workspace-relative
// `.claude/commands/<namespace>` dir touched (for the reseed mirror), or null
// when the skill ships no commands and none were previously seeded. Best-effort:
// a copy failure is logged and skipped so it never fails the whole skill sync.
function projectSkillCommands(id, skillName, srcDir, manifest, { remove = false, seededAt } = {}) {
  const namespace = skillCommands.commandNamespace(skillName);
  const nsRel = path.join(skillCommands.AGENT_COMMANDS_DIR, namespace);
  const nsAbs = path.join(agentDir(id), nsRel);
  const hadEntries = Object.values(manifest).some((v) => v && v.skill === skillName);

  if (remove) {
    try { fs.rmSync(nsAbs, { recursive: true, force: true }); }
    catch (err) { console.warn(`[Orchestrator] command unproject ${id}/${skillName}: ${err.message}`); }
    for (const k of Object.keys(manifest)) {
      if (manifest[k] && manifest[k].skill === skillName) delete manifest[k];
    }
    return hadEntries ? nsRel : null;
  }

  const records = srcDir ? skillCommands.readSkillCommands(srcDir, skillName) : [];
  // Drop any stale entries for this skill first (a re-sync may have removed a
  // command file from the source), then rewrite its namespace dir from scratch.
  for (const k of Object.keys(manifest)) {
    if (manifest[k] && manifest[k].skill === skillName) delete manifest[k];
  }
  if (records.length === 0) {
    // Skill has no commands now — clear a previously-projected namespace dir.
    if (hadEntries) { try { fs.rmSync(nsAbs, { recursive: true, force: true }); } catch { /* noop */ } }
    return hadEntries ? nsRel : null;
  }
  try {
    fs.rmSync(nsAbs, { recursive: true, force: true }); // replace wholesale (idempotent)
    fs.mkdirSync(nsAbs, { recursive: true });
    for (const r of records) {
      fs.writeFileSync(path.join(agentDir(id), r.targetPath), r.content, "utf8");
    }
    Object.assign(manifest, skillCommands.manifestEntriesFor(records, seededAt || new Date().toISOString()));
  } catch (err) {
    console.warn(`[Orchestrator] command project ${id}/${skillName}: ${err.message}`);
  }
  return nsRel;
}

// The distinct top-level workspace roots a command-only plugin's fetched
// scaffold materialises (e.g. `.specify` for spec-kit, #1865). Derived from the
// manifest's `fetch.scaffold` dest paths so grant removes exactly what grant
// created; empty for a plugin with no scaffold.
function pluginScaffoldRoots(manifest) {
  const scaffold = manifest && manifest.fetch && Array.isArray(manifest.fetch.scaffold)
    ? manifest.fetch.scaffold : [];
  const roots = new Set();
  for (const e of scaffold) {
    if (e && typeof e.dest === "string" && e.dest) roots.add(e.dest.split("/")[0]);
  }
  return [...roots];
}

// Copy a command-only plugin's fetched scaffold (registry `<pDir>/scaffold/`,
// laid out as the workspace-relative `.specify/...` tree by the install-time
// fetch, #1865) into the agent workspace root — or remove it on revoke. Returns
// the top-level roots touched (for the isolated-volume reseed). Additive, no
// respawn; sibling of projectSkillCommands. The scaffold is plugin-owned, so a
// revoke removes the whole root (matching the additive-sync namespace model).
function projectPluginScaffold(id, pDir, manifest, { remove = false } = {}) {
  const roots = pluginScaffoldRoots(manifest);
  if (roots.length === 0) return [];
  const workspaceRoot = agentDir(id);
  if (remove) {
    for (const root of roots) {
      try { fs.rmSync(path.join(workspaceRoot, root), { recursive: true, force: true }); }
      catch (err) { console.warn(`[Orchestrator] scaffold unproject ${id}/${manifest.id}/${root}: ${err.message}`); }
    }
    return roots;
  }
  const scaffoldSrc = path.join(pDir, "scaffold");
  try {
    // fs.cpSync preserves source file modes, so the 0755 the fetch stamped on
    // the `.sh` scripts rides along into the workspace.
    if (fs.existsSync(scaffoldSrc)) fs.cpSync(scaffoldSrc, workspaceRoot, { recursive: true, force: true });
  } catch (err) {
    console.warn(`[Orchestrator] scaffold project ${id}/${manifest.id}: ${err.message}`);
  }
  return roots;
}

// Per-member skill reconcile state (#776 §3): tracks bounded retry attempts plus
// the last error + timestamp for a pending skill the auto-reconcile loop is
// trying to heal. Keyed by skill name. Read by the admin-console graph overlay so
// a stuck member surfaces a Retry + the reason instead of a silent "pending".
const SKILL_RECONCILE_FILE = "skill-reconcile.json";

function readSkillReconcileState(id) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(agentStateDir(id), SKILL_RECONCILE_FILE), "utf8"));
    return m && typeof m === "object" ? m : {};
  } catch { return {}; }
}

function writeSkillReconcileState(id, map) {
  const p = path.join(agentStateDir(id), SKILL_RECONCILE_FILE);
  try {
    const clean = map && typeof map === "object" ? map : {};
    // An empty map means every skill reconciled — drop the file so it leaves no
    // trace (and the overlay never reads a stale error).
    if (Object.keys(clean).length === 0) { try { fs.rmSync(p, { force: true }); } catch { /* noop */ } return; }
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(clean, null, 2));
  } catch { /* best effort */ }
}

// Tier of a resolved skill source dir (skill-source.js resolution order).
function skillTierForSource(src) {
  if (!src) return null;
  if (src.startsWith(TEMPLATE_WORKSPACE)) return "global";
  return src.includes(`${path.sep}teams${path.sep}`) ? "team" : "agent";
}

// Source skill identity for the seeded-skills manifest (#625, AC4): the source
// skill's stamped {version, contentHash} at seed time — the anchor for later
// drift classification (concept §2.4). Falls back to a freshly computed hash
// when the source is not yet stamped. Best-effort; returns {} on any error.
function skillSourceIdentity(srcDir) {
  try {
    const man = skillManifest.readManifest(srcDir);
    let contentHash = man && man.contentHash;
    if (!contentHash) { try { contentHash = skillManifest.hashSkillDir(srcDir); } catch { contentHash = undefined; } }
    const out = {};
    if (contentHash !== undefined) out.contentHash = contentHash;
    if (man && man.version !== undefined) out.sourceVersion = man.version;
    return out;
  } catch { return {}; }
}

function seedAgentWorkspace(id, env, opts = {}) {
  const dest = agentDir(id);
  fs.mkdirSync(dest, { recursive: true });

  if (!fs.existsSync(TEMPLATE_WORKSPACE)) {
    console.log(`[Orchestrator] Template workspace not available — skipping seed for ${id}`);
    return { seeded: false, warnings: ["Template workspace not mounted"] };
  }

  const warnings = [];

  // 1. Always copy baseline directories (.claude settings, memory)
  for (const item of [".claude", "memory"]) {
    const src = path.join(TEMPLATE_WORKSPACE, item);
    const dst = path.join(dest, item);
    if (!fs.existsSync(src)) continue;
    try {
      fs.cpSync(src, dst, { recursive: true });
    } catch (err) {
      warnings.push(`copy ${item}: ${err.message}`);
    }
  }

  // 2. Copy selected skills, resolving each name team-first then global (#306).
  // The GRANT is team-owned (skill-grants.js): callers pass the resolved list
  // via `opts.skills` (team agent's `skills[]`, standalone agent's own list, …);
  // `opts.skillsOverride` (team-member override) wins verbatim, no merge. The
  // environment no longer contributes skills — it is a pure infrastructure
  // template. The owning team's POOL (/workspace/teams/<teamId>/skills) still
  // takes precedence over the global pool (/template-workspace/skills); when a
  // team has no skill of that name this falls back to global, so the
  // global-only behaviour is unchanged.
  const selectedSkills = Array.isArray(opts.skillsOverride)
    ? opts.skillsOverride
    : (Array.isArray(opts.skills) ? opts.skills : []);
  // Materialise the on-disk AGENT skill pool (Phase 4, concept open question #4):
  // the bottom rung of the Agent → Team → Global ladder is now a real, writable
  // tier. The dir exists even with no seeded skills, so an agent can author a
  // private skill and `agent→team` promotion has a source. resolveSkillSourceDir
  // already prefers it (agent-first), and the self-copy is skipped below.
  const skillsDst = path.join(dest, "skills");
  fs.mkdirSync(skillsDst, { recursive: true });
  const seededManifest = {};
  // #1796: accumulate the slash commands each granted skill ships, projected
  // into .claude/commands/<namespace>/ below.
  const commandManifest = {};
  if (selectedSkills.length > 0) {
    // #750: team-tier skills live in the pool keyed by the AGENT team
    // (agentKnowledgeTeamId → parentTeamId, or a team agent's own id) — the SAME
    // key the curator writes them under (_teamSkillDir) and the activation
    // overlay reads. The member's human tenant teamId is NOT that key; keying
    // the seed by it resolved every inherited team skill to
    // /workspace/teams/default/skills, missed, and left members forever
    // `pending` (badge active·0/N). Falls back to opts.teamId for a standalone
    // agent with no squad — identical to the pre-#750 behaviour there.
    const poolTeamId = agentKnowledgeTeamId(loadAgentConfig(id) || { teamId: opts.teamId });
    const seededAt = new Date().toISOString();
    for (const skillName of selectedSkills) {
      // Resolve agent-first (Phase 0): an agent's own skill pool
      // (/workspace/agents/<id>/skills) shadows the team's and the global one.
      const src = resolveSkillSourceDir(skillName, poolTeamId, { agentId: id });
      const dst = path.join(skillsDst, skillName);
      if (!src) {
        warnings.push(`skill not found in pool: ${skillName}`);
        continue;
      }
      // The agent-tier pool IS this destination dir, so an agent-private skill
      // resolves to itself — it is already in place, and cpSync(src === dst)
      // throws. Skip the self-copy (but still record it in the manifest).
      if (path.resolve(src) !== path.resolve(dst)) {
        try {
          fs.cpSync(src, dst, { recursive: true });
        } catch (err) {
          warnings.push(`skill ${skillName}: ${err.message}`);
          continue;
        }
      }
      seededManifest[skillName] = { tier: skillTierForSource(src), seededAt, ...skillSourceIdentity(src) };
      // #1796: project any commands/ this skill ships into .claude/commands/.
      try { projectSkillCommands(id, skillName, src, commandManifest, { seededAt }); }
      catch (err) { warnings.push(`skill ${skillName} commands: ${err.message}`); }
    }
  }
  // Always write the manifest (even empty): its absence means "pre-manifest
  // workspace", its presence is the activation truth for this agent.
  try { writeSeededSkills(id, seededManifest); }
  catch (err) { warnings.push(`seeded-skills manifest: ${err.message}`); }
  // #1796: the slash-command provisioning manifest (name + description per
  // command) — the truth #1797 reads and the runtime uses to recognise a
  // provisioned command. Always written (even empty) for the same reason.
  try { writeSeededCommands(id, commandManifest); }
  catch (err) { warnings.push(`seeded-commands manifest: ${err.message}`); }

  // 3. Patch absolute /workspace/ paths in seeded memory
  patchSeededPaths(dest);

  // 4. Materialize MCP server config into the agent's own .claude/settings.json.
  //    Team-members may override the team-env's MCP list — pass `opts.mcpServersOverride`
  //    (an array of { serverId, credentialId }) to use it instead of `env.mcpServers`.
  //    The override is verbatim, no merge.
  const mcpRefs = Array.isArray(opts.mcpServersOverride)
    ? opts.mcpServersOverride
    : ((env && Array.isArray(env.mcpServers)) ? env.mcpServers : []);
  const mcpSeeded = seedAgentMcpServers(dest, mcpRefs, warnings);

  // 5. Optional git clone(s) — the environment's, then this agent's own
  //    (#2067). Agent-scoped repositories are cloned by EVERY seed, which is
  //    what makes the attachment survive a container respawn and a workspace
  //    re-seed (AC5/D9): reset-to-stub wipes everything but config.json, and
  //    config.json is where the attachment lives, so the next activation
  //    re-clones it rather than leaving the prompt naming a missing directory.
  const clones = [
    ...cloneEnvironmentRepositories(dest, env, warnings),
    ...cloneAgentScopedRepositories(dest, env, (loadAgentConfig(id) || {}).agentRepositories, warnings),
  ];

  // 6. Shared team Knowledge Base working copy (Shared Agent Learning, Phase 1).
  //    Only when the autonomy dial is on (>= 1); best-effort, never fails the seed.
  //    Knowledge config is keyed per team (#570), so overlay the team's overrides
  //    onto the shared env before any knowledge consumer reads it.
  const kbTeamId = agentKnowledgeTeamId(loadAgentConfig(id) || { teamId: opts.teamId });
  const kbEnv = teamKnowledgeEnv(kbTeamId, env);
  if (knowledgeAutonomyLevel(kbEnv) >= 1) {
    provisionKnowledgeCheckout(id, dest, kbEnv, warnings);
    // Initial knowledge digest (Memory/Knowledge unification, Phase 1): the
    // seeded CLAUDE.md `@`-imports knowledge-digest.md whenever a checkout is
    // provisioned, so write the first digest here — the import never dangles.
    // The runtime (pre-invocation) and the post-KB-change fan-out keep it
    // current afterwards.
    if (fs.existsSync(path.join(dest, "knowledge", ".git"))) {
      try {
        writeAgentKnowledgeDigest(id, kbTeamId, path.join(dest, "knowledge", _kbStoreRel(kbEnv)));
      } catch (err) {
        warnings.push(`knowledge digest: ${err.message}`);
      }
      // Unified agents start on the three-file episodic model: the template
      // facts.md/entities.md just copied in step 1 are headings-only
      // boilerplate, which the migration deletes (a workspace with real
      // legacy content gets parsed + archived instead — see Phase 3).
      try {
        migrateAgentMemoryToKb(id, loadAgentConfig(id) || { teamId: opts.teamId }, kbEnv);
      } catch (err) {
        warnings.push(`legacy-memory migration: ${err.message}`);
      }
    }
  }

  const cloneSummary = clones.length > 0 ? `, repos=${clones.map(c => c.repoName).join(",")}` : "";
  const mcpSummary = mcpSeeded.length > 0 ? `, mcp=${mcpSeeded.join(",")}` : "";
  console.log(`[Orchestrator] Seeded workspace for ${id} (env=${env?.id || "none"}, skills=${selectedSkills.length}${mcpSummary}${cloneSummary})`);
  // Warnings (failed clones, missing skills, etc.) used to be silently
  // dropped into the response object — invisible from the logs unless the
  // caller surfaced them. Log them prominently so a clone failure during
  // team-member seeding is immediately visible to the operator.
  for (const w of warnings) {
    console.warn(`[Orchestrator] Seed warning for ${id}: ${w}`);
  }
  return { seeded: true, warnings, clones };
}

// For each {serverId, credentialId} ref attached to the environment (or its
// team-member override), load the server.json template, substitute the
// `${credential}` placeholder with the secret read from the credentials store,
// and write the merged stanza into the agent's own `.claude/settings.json`
// under `mcpServers[<serverId>]`. Per-agent isolation: pool-level MCP config
// is no longer consulted at runtime.
function seedAgentMcpServers(dest, mcpRefs, warnings) {
  const seeded = [];
  if (!Array.isArray(mcpRefs) || mcpRefs.length === 0) return seeded;

  const settingsPath = path.join(dest, ".claude", "settings.json");
  let settings = {};
  try {
    if (fs.existsSync(settingsPath)) {
      settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")) || {};
    }
  } catch (err) {
    warnings.push(`mcp: cannot parse existing .claude/settings.json — overwriting (${err.message})`);
    settings = {};
  }
  if (!settings.mcpServers || typeof settings.mcpServers !== "object") settings.mcpServers = {};

  for (const ref of mcpRefs) {
    const serverId = ref?.serverId;
    const credId = ref?.credentialId || null;
    if (!serverId || !/^[a-z0-9-]+$/.test(serverId)) {
      warnings.push(`mcp: invalid serverId in env ref: ${JSON.stringify(ref)}`);
      continue;
    }
    const serverPath = path.join(MCP_SERVERS_DIR, serverId, "server.json");
    let server;
    try {
      server = JSON.parse(fs.readFileSync(serverPath, "utf8"));
    } catch (err) {
      warnings.push(`mcp: server '${serverId}' not found in registry (${err.message})`);
      continue;
    }

    let secret = "";
    if (credId) {
      if (!/^[a-z0-9-]+$/.test(credId)) {
        warnings.push(`mcp: invalid credentialId for server '${serverId}': ${credId}`);
        continue;
      }
      try {
        secret = fs.readFileSync(path.join(MCP_CREDENTIALS_KEYS_DIR, credId), "utf8").trim();
      } catch (err) {
        warnings.push(`mcp: cannot read credential '${credId}' for server '${serverId}' (${err.message})`);
        continue;
      }
    }

    // Different transports carry the substitution template under different
    // keys: stdio servers get `env` (process environment), http/sse servers
    // get `headers` (HTTP request headers). The substitution mechanics are
    // identical — only the destination key changes.
    const transport = server.transport || "stdio";
    if (!["stdio", "http", "sse"].includes(transport)) {
      warnings.push(`mcp: server '${serverId}' has unsupported transport '${transport}'`);
      continue;
    }
    const tplKey = transport === "stdio" ? "env" : "headers";
    const template = (server[tplKey] && typeof server[tplKey] === "object") ? server[tplKey] : {};

    const resolved = {};
    let placeholderUsed = false;
    for (const [k, v] of Object.entries(template)) {
      if (typeof v !== "string") { resolved[k] = v; continue; }
      if (v.includes("${credential}")) {
        placeholderUsed = true;
        if (!secret) {
          warnings.push(`mcp: server '${serverId}' ${tplKey} key '${k}' uses \${credential} but no credential is bound`);
          // Drop the key rather than leak the literal placeholder into the agent.
          continue;
        }
        resolved[k] = v.split("${credential}").join(secret);
      } else {
        resolved[k] = v;
      }
    }
    if (!placeholderUsed && credId) {
      warnings.push(`mcp: server '${serverId}' has a credential bound but no \${credential} placeholder in ${tplKey} — credential ignored`);
    }

    // Stanza shape per Claude Code's MCP config schema:
    //   stdio   → { command, args, env }                  (no `type` field — stdio is the default)
    //   http    → { type: "http", url, headers }
    //   sse     → { type: "sse",  url, headers }
    let stanza;
    if (transport === "stdio") {
      stanza = {
        command: server.command,
        args: Array.isArray(server.args) ? server.args : [],
        env: resolved,
      };
    } else {
      stanza = {
        type: transport,
        url: server.url,
        headers: resolved,
      };
    }
    settings.mcpServers[serverId] = stanza;
    seeded.push(serverId);
  }

  try {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  } catch (err) {
    warnings.push(`mcp: cannot write .claude/settings.json (${err.message})`);
  }
  return seeded;
}

// Clone every repository attached to an environment. Errors are pushed to the
// shared warnings list so one failed clone never aborts the rest of the seed.
function cloneEnvironmentRepositories(targetDir, env, warnings) {
  const repos = Array.isArray(env?.repositories) ? env.repositories : [];
  const results = [];
  for (const repo of repos) {
    if (!repo?.url) continue;
    try {
      const info = cloneRepository(targetDir, repo, env?.githubTokenId || null, env?.id || null);
      if (info) results.push(info);
    } catch (err) {
      warnings.push(`git clone (${repo.url}): ${err.message}`);
    }
  }
  return results;
}

// Clone the repositories attached to ONE agent (#2067). Same clone code and
// same directory convention as an environment repository — what differs is the
// cache: `envId` is passed as null on purpose, so an agent-scoped repository
// neither reads from nor seeds the per-environment `_repo-cache`. Seeding it
// would let a sibling agent later copy a working tree it was never granted,
// which is precisely what "attaching changes exactly one agent" (AC10) forbids.
function cloneAgentScopedRepositories(targetDir, env, agentRepositories, warnings) {
  const repos = normalizeAgentRepositories(agentRepositories);
  const results = [];
  for (const repo of repos) {
    try {
      const info = cloneRepository(targetDir, repo, env?.githubTokenId || null, null);
      if (info) results.push(info);
    } catch (err) {
      warnings.push(`git clone (${repo.url}): ${err.message}`);
    }
  }
  return results;
}

// Per-env clone cache. The first agent in an env triggers a real `git clone`
// into <envDir>/_repo-cache/<repoName>; subsequent agents in the same env
// `cp -r` from that cache instead of paying the network round-trip again.
// Each agent still ends up with its own independent working copy — the cache
// is only used as the source of the copy, never shared at runtime.
function envRepoCachePath(envId, repoName) {
  if (!envId || !repoName) return null;
  return path.join(ENVIRONMENTS_DIR, envId, "_repo-cache", repoName);
}

function isUsableRepoCache(cacheDir) {
  if (!cacheDir || !fs.existsSync(cacheDir)) return false;
  // Validate the cache holds a complete clone — partial / interrupted clones
  // would silently propagate to every member otherwise.
  try {
    return fs.existsSync(path.join(cacheDir, ".git", "HEAD"));
  } catch {
    return false;
  }
}

// Resolve the git credentials one repository URL needs, and shape them into the
// per-invocation environment git reads them from.
//
// Extracted verbatim out of cloneRepository (#2066) so the in-place ADJUST path
// authenticates through exactly the same resolution — a second copy would be
// the one place where "the clone worked but the fetch did not" could diverge.
// The resolution itself is unchanged: transport is decided by the URL, never by
// which credentials the environment happens to carry.
function repoGitCredentials(repository, envGithubTokenId = null) {
  const { url, sshKeyId } = repository || {};
  // The transport choice is driven by the URL, not by which credentials
  // the env carries. HTTPS URLs need PAT-based Basic auth; SSH URLs need
  // GIT_SSH_COMMAND with the deploy key. The wizard sets BOTH credentials
  // by default (defense-in-depth) and writes the env's `repositories[].url`
  // as HTTPS — so an SSH key being present alongside an HTTPS URL is
  // expected, and we must not let it pre-empt the token path. Pick the
  // right one for the URL and warn loudly when nothing fits.
  const isHttpsGithub = /^https?:\/\/(www\.)?github\.com\//i.test(url);
  const isSshUrl = /^(ssh:\/\/|git@)/.test(url);

  let keyPath = null;
  // Resolve the SSH key only when we actually intend to use it. For HTTPS
  // URLs the key is irrelevant — verifying its existence here would fail
  // the whole clone for envs whose key was rotated/removed long ago even
  // though the HTTPS+token path would have worked fine.
  if (isSshUrl && sshKeyId) {
    keyPath = path.join(SSH_KEYS_DIR, sshKeyId);
    if (!fs.existsSync(keyPath)) {
      throw new Error(`SSH key not found: ${sshKeyId}`);
    }
    try { fs.chmodSync(keyPath, 0o600); } catch { /* best effort */ }
  }

  // For HTTPS GitHub URLs, authenticate via GIT_CONFIG_* env vars so the
  // token never appears in process arguments (/proc/<pid>/cmdline) and never
  // lands in `git remote -v` (no URL rewriting). Only active for this single
  // invocation. The presence of an SSH key does NOT block this path — SSH
  // keys are no help for HTTPS transport.
  let authBasic = null;
  if (isHttpsGithub && envGithubTokenId) {
    const tokenPath = path.join(GH_TOKENS_DIR, envGithubTokenId);
    try {
      const ghToken = fs.readFileSync(tokenPath, "utf8").trim();
      if (ghToken) {
        authBasic = Buffer.from(`x-access-token:${ghToken}`).toString("base64");
      }
    } catch (err) {
      console.warn(`[Orchestrator] Cannot read GitHub token ${envGithubTokenId} for clone: ${err.message}`);
    }
  }
  // Refuse proactively when no auth can possibly work. Without this, git would
  // block on a username prompt (no TTY → fatal: could not read Username) and
  // the failure would surface as a cryptic stderr line.
  if (isHttpsGithub && !authBasic) {
    throw new Error(
      `HTTPS clone of ${url} needs a GitHub PAT, but the env has no usable githubTokenId ` +
      `(SSH keys do not authenticate HTTPS transports). Either add a PAT to the env or ` +
      `change the repository URL to its SSH form.`
    );
  }

  const env = { ...process.env };
  if (keyPath) {
    env.GIT_SSH_COMMAND = `ssh -i ${keyPath} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o IdentitiesOnly=yes`;
  }
  if (authBasic) {
    env.GIT_CONFIG_COUNT = "1";
    env.GIT_CONFIG_KEY_0 = "http.https://github.com/.extraheader";
    env.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${authBasic}`;
  }
  return env;
}

function cloneRepository(targetDir, repository, envGithubTokenId = null, envId = null) {
  const { url, branch } = repository;
  if (!url) return null;

  const repoName = (url.split("/").pop() || "repo").replace(/\.git$/, "");
  const repoDir = path.join(targetDir, repoName);

  if (fs.existsSync(repoDir)) {
    console.log(`[Orchestrator] Repo dir already exists: ${repoDir} — skipping clone`);
    return { repoName, skipped: true };
  }

  // Cache fast-path: if a sibling agent in this env already cloned the repo
  // we can copy that working tree instead of running `git clone` again.
  const cacheDir = envRepoCachePath(envId, repoName);
  if (isUsableRepoCache(cacheDir)) {
    try {
      fs.cpSync(cacheDir, repoDir, { recursive: true });
      console.log(`[Orchestrator] Copied ${repoName} from env cache → ${repoDir}`);
      return { repoName, skipped: false, fromCache: true };
    } catch (err) {
      // Fall through to a fresh clone if the copy fails — the cache may be
      // corrupted or hit a permission edge case. Don't let the optimisation
      // fail seeding outright.
      console.warn(`[Orchestrator] Cache copy for ${repoName} failed (${err.message}); falling back to git clone`);
    }
  }

  // Credentials are resolved HERE, after the two early returns above, so a
  // clone that is not going to run never fails on a credential it would not
  // have used. The HTTPS-without-a-PAT refusal keeps its original position for
  // the same reason: it must fire for a clone that is about to happen.
  const env = repoGitCredentials(repository, envGithubTokenId);

  const args = ["clone"];
  if (branch) args.push("--branch", branch);
  args.push("--", url, repoName);

  try {
    execFileSync("git", args, {
      cwd: targetDir,
      env,
      stdio: "pipe",
      timeout: 120_000,
    });
    console.log(`[Orchestrator] Cloned ${url} → ${repoDir}`);
  } catch (err) {
    const stderr = (err.stderr || "").toString();
    const msg = stderr.substring(0, 400) || err.message;
    throw new Error(`git clone failed: ${msg}`);
  }

  // Seed the env-level cache so the next member in the same env can skip
  // the network round-trip. Failure here is non-fatal: subsequent members
  // simply re-clone instead of copying.
  if (cacheDir) {
    try {
      fs.mkdirSync(path.dirname(cacheDir), { recursive: true });
      if (!fs.existsSync(cacheDir)) {
        fs.cpSync(repoDir, cacheDir, { recursive: true });
      }
    } catch (err) {
      console.warn(`[Orchestrator] Cache seed for ${repoName} failed (${err.message}) — siblings will re-clone`);
    }
  }

  return { repoName, skipped: false, fromCache: false };
}

// Every git checkout directly under an agent's workspace, by directory name.
// Used to report clones that are no longer declared as RETAINED (#2066) — they
// are never deleted, so saying so is the only thing left to do about them.
function listWorkspaceClones(workspace) {
  try {
    return fs.readdirSync(workspace, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .filter((e) => fs.existsSync(path.join(workspace, e.name, ".git")))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

// The MINIMAL probe repoDivergence() needs: per declared repository, does a
// clone exist, which branch is checked out, and where does 'origin' point.
//
// Deliberately not inspectAgentRepoStatuses — that runs ~7 git commands per
// repository (log, status --porcelain, rev-list against the upstream) because
// it answers "is this safe to hand over". The out-of-date indicator asks a much
// smaller question and is rendered for every agent of every environment, so it
// gets two git commands per repository and no network access at all. The shape
// it returns is a strict subset of the full status record, so the same pure
// repoDivergence() reads either one.
function inspectAgentRepoDivergence(agentId, env) {
  const repos = Array.isArray(env?.repositories) ? env.repositories : [];
  const workspace = agentDir(agentId);
  const out = [];

  for (const repo of repos) {
    if (!repo?.url) continue;
    const name = (repo.url.split("/").pop() || "repo").replace(/\.git$/, "");
    const repoPath = path.join(workspace, name);
    const record = { name, url: repo.url, exists: false, branchActual: null, remoteUrl: null };
    if (!fs.existsSync(path.join(repoPath, ".git"))) {
      out.push(record);
      continue;
    }
    record.exists = true;
    const run = (args) => execFileSync("git", args, {
      cwd: repoPath,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    }).toString().trim();
    try { record.branchActual = run(["rev-parse", "--abbrev-ref", "HEAD"]) || null; } catch { /* leave null */ }
    try { record.remoteUrl = run(["remote", "get-url", "origin"]) || null; } catch { /* no origin */ }
    out.push(record);
  }
  return out;
}

// Bring ONE existing clone into line with its declared entry (#2066 D1).
//
// Only ever reached for a clone cloneAdjustSafety() has cleared as clean and
// fully pushed, and every operation below is chosen so that even then it cannot
// discard work: `remote set-url` touches no file, `fetch` only adds objects, and
// the branch move is `checkout` + `merge --ff-only` — a local branch that has
// diverged makes the merge REFUSE, which surfaces as a per-repository failure.
// There is deliberately no stash, no reset, no `checkout -f` and no clean.
function adjustRepoClone(workspace, repository, status, plan, envGithubTokenId = null) {
  const repoDir = path.join(workspace, status.name);
  const env = repoGitCredentials(repository, envGithubTokenId);
  const applied = [];

  const run = (args, timeout = 120_000) => {
    try {
      return execFileSync("git", args, {
        cwd: repoDir,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        timeout,
      }).toString();
    } catch (err) {
      const detail = (err.stderr || err.stdout || "").toString().trim() || err.message || "";
      throw new Error(`git ${args[0]} failed: ${detail.slice(0, 300)}`);
    }
  };

  // Repoint 'origin' FIRST, so the fetch below already speaks to the new
  // address and the branch step resolves against it.
  if (plan.setUrl) {
    run(["remote", "set-url", "origin", plan.setUrl]);
    applied.push(`remote → ${plan.setUrl}`);
  }

  // Always fetch. This is also the point at which an edited SSH key or PAT is
  // actually exercised, so a credential change is proven rather than assumed.
  run(["fetch", "--prune", "origin"]);
  applied.push("fetched");

  if (plan.checkoutBranch) {
    const branch = plan.checkoutBranch;
    run(["checkout", branch]);
    run(["merge", "--ff-only", `origin/${branch}`]);
    applied.push(`branch → ${branch}`);
  }

  console.log(`[Orchestrator] Adjusted ${status.name} in ${workspace}: ${applied.join("; ")}`);
  return { applied };
}

function patchSeededPaths(dir) {
  const memoryDir = path.join(dir, "memory");
  if (!fs.existsSync(memoryDir)) return;
  for (const file of fs.readdirSync(memoryDir)) {
    if (!file.endsWith(".md")) continue;
    const filePath = path.join(memoryDir, file);
    try {
      let content = fs.readFileSync(filePath, "utf8");
      const patched = content.replace(/\/workspace\//g, "./");
      if (patched !== content) {
        fs.writeFileSync(filePath, patched);
        console.log(`[Orchestrator] Patched paths in memory/${file}`);
      }
    } catch (err) {
      console.log(`[Orchestrator] Patch warning (${file}): ${err.message}`);
    }
  }
}

// Workspace seeding for blueprint instances: no memory copy (shared via API).
// `skills` is the instance's grant (team-owned skills): the blueprint paths
// have no operator UI, so callers copy the env's legacy skill list once at
// instance creation as the initial grant and record it on the config.
function seedAgentWorkspaceForInstance(id, env, blueprintId, skills = []) {
  const dest = agentDir(id);
  fs.mkdirSync(dest, { recursive: true });

  if (!fs.existsSync(TEMPLATE_WORKSPACE)) {
    console.log(`[Orchestrator] Template workspace not available — skipping seed for instance ${id}`);
    return { seeded: false, warnings: ["Template workspace not mounted"] };
  }

  const warnings = [];

  // Copy .claude settings (not memory — shared via blueprint)
  const src = path.join(TEMPLATE_WORKSPACE, ".claude");
  const dst = path.join(dest, ".claude");
  if (fs.existsSync(src)) {
    try { fs.cpSync(src, dst, { recursive: true }); }
    catch (err) { warnings.push(`copy .claude: ${err.message}`); }
  }

  // Copy selected skills
  const selectedSkills = Array.isArray(skills) ? skills : [];
  const seededManifest = {};
  const commandManifest = {}; // #1796: slash commands the granted skills ship
  if (selectedSkills.length > 0) {
    const skillsSrc = path.join(TEMPLATE_WORKSPACE, "skills");
    const skillsDst = path.join(dest, "skills");
    fs.mkdirSync(skillsDst, { recursive: true });
    const seededAt = new Date().toISOString();
    for (const skillName of selectedSkills) {
      const skillSrc = path.join(skillsSrc, skillName);
      const skillDst = path.join(skillsDst, skillName);
      if (!fs.existsSync(skillSrc)) { warnings.push(`skill not found: ${skillName}`); continue; }
      try { fs.cpSync(skillSrc, skillDst, { recursive: true }); }
      catch (err) { warnings.push(`skill ${skillName}: ${err.message}`); continue; }
      seededManifest[skillName] = { tier: "global", seededAt, ...skillSourceIdentity(skillSrc) };
      try { projectSkillCommands(id, skillName, skillSrc, commandManifest, { seededAt }); }
      catch (err) { warnings.push(`skill ${skillName} commands: ${err.message}`); }
    }
  }
  try { writeSeededSkills(id, seededManifest); }
  catch (err) { warnings.push(`seeded-skills manifest: ${err.message}`); }
  try { writeSeededCommands(id, commandManifest); }
  catch (err) { warnings.push(`seeded-commands manifest: ${err.message}`); }

  // Create local memory dir (used as staging area; content synced from blueprint API at session start)
  fs.mkdirSync(path.join(dest, "memory"), { recursive: true });

  // Ensure blueprint memory dir exists and seed from template if first instance
  seedBlueprintMemory(blueprintId);

  // Git clone(s)
  const clones = cloneEnvironmentRepositories(dest, env, warnings);

  const cloneSummary = clones.length > 0 ? `, repos=${clones.map(c => c.repoName).join(",")}` : "";
  console.log(`[Orchestrator] Seeded instance workspace for ${id} (blueprint=${blueprintId}, skills=${selectedSkills.length}${cloneSummary})`);
  return { seeded: true, warnings, clones };
}

// ============================================================
// Trigger storage (per-agent triggers.json)
// ============================================================
// Triggers are control→agent state: the orchestrator owns the canonical copy
// (on /control when the agent's volume is isolated, on the pool subpath
// otherwise — see controlOrPoolPath) and the agent pulls it over HTTP. Admin
// CRUD routes its writes through us (PUT /internal/agents/:id/triggers) so this
// stays the single writer.
function loadTriggers(id) {
  const p = controlOrPoolPath(id, "triggers.json");
  try {
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (err) {
    console.error(`[Triggers] Error loading triggers for ${id}: ${err.message}`);
  }
  return [];
}

function saveTriggers(id, triggers) {
  const p = controlOrPoolPath(id, "triggers.json");
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(triggers, null, 2));
}

function deleteAgentFiles(id) {
  const dir = agentDir(id);
  // `force: true` matches the sibling cleanups below: without it, an
  // rmSync that fails mid-walk (e.g. an NFS/Filestore `.nfsXXXX` silly-rename
  // left by a live pod → ENOTEMPTY) throws AFTER unlinking config.json,
  // leaving exactly the invisible config-less residue that dead-locked
  // same-id team retries (#1525 B2).
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  // Control-plane state pushed by the agent (#185): /control/agents/<id>/
  // status.json + sessions/<roomId>.jsonl + the session-pointer mirror. This
  // is UNCONDITIONAL — push (AEE_PUSH_STATE) defaults ON, so the control dir
  // exists for every agent even on the shared volume, not just under the
  // per-agent-volume flag. Leaving it behind leaks state and, because
  // agentStatePath/controlOrAgentPath prefer the /control copy when present,
  // makes a reused agent id read stale status.json until its first push.
  try { fs.rmSync(controlAgentDir(id), { recursive: true, force: true }); }
  catch { /* best effort */ }
  // Per-agent Claude home (SubPath homes/<id> of the shared claude-home volume,
  // mounted at /root/.claude on the orchestrator). Can't be torn down via libpod
  // (it's a subpath, not a dedicated volume), but the orchestrator can rm the
  // subdir directly. Gated on PER_AGENT_VOLUME to keep the default shared-volume
  // path byte-for-byte (its pre-existing homes/<id> leak is out of scope). The
  // dedicated DATA volume is removed separately by removePerAgentVolume at the
  // async call sites (#185 item 6).
  if (PER_AGENT_VOLUME) {
    try { fs.rmSync(path.join('/root/.claude/homes', id), { recursive: true, force: true }); }
    catch { /* best effort */ }
  }
}

// Tear down a deleted squad's team-scoped knowledge (#532). Called when a
// `role: "team"` agent is deleted: without this a later same-name team — whose
// id is the same deterministic slug, hence the same KB scope — silently
// re-adopts the dead team's knowledge (a data-isolation leak).
//
// Shared-infra safety: the scope is keyed by `agentKnowledgeTeamId`, so we skip
// the purge entirely if ANY surviving agent still resolves to the same scope
// (e.g. a standalone agent that set `parentTeamId` to it) — deletion never
// removes knowledge another live agent still shares.
//
// Best-effort: a per-target failure logs and continues; it must never break the
// delete. The git-side canonical KB (the `agent-knowledge` branch in the team's
// repo) is deliberately NOT purged here — repo-shared knowledge is the wanted
// sharing channel, so team deletion never modifies or pushes it (#532 AC6). A
// same-id team bound to the same repo re-cloning it is intended, not a leak.
function purgeTeamKnowledge(teamId) {
  const plan = knowledgeCleanup.planTeamKnowledgePurge(teamId, {
    cloneRoot: KNOWLEDGE_CLONE_ROOT,
    teamsDir: path.join(WORKSPACE, "teams"),
    suggestionsDir: KNOWLEDGE_SUGGESTIONS_DIR,
    archivedDir: KNOWLEDGE_ARCHIVED_DIR,
    reviewDir: KNOWLEDGE_REVIEW_DIR,
    retrievalDir: KNOWLEDGE_RETRIEVAL_DIR,
    vectorsDir: KNOWLEDGE_VECTORS_DIR,
    eventsFile: KNOWLEDGE_EVENTS_FILE,
  });
  if (!plan) return; // unsafe id → remove nothing

  const stillInUse = listAgentIds().some((otherId) => {
    const cfg = loadAgentConfig(otherId);
    return cfg && agentKnowledgeTeamId(cfg) === plan.teamId;
  });
  if (stillInUse) {
    console.log(`[Orchestrator] Skipping knowledge purge for team '${plan.teamId}': still in use by a surviving agent`);
    return;
  }

  for (const dir of plan.dirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); }
    catch (err) { console.warn(`[Orchestrator] knowledge purge (${dir}): ${err.message}`); }
  }
  for (const file of plan.files) {
    try { fs.rmSync(file, { force: true }); }
    catch (err) { console.warn(`[Orchestrator] knowledge purge (${file}): ${err.message}`); }
  }
  if (plan.eventsFile) {
    try {
      if (fs.existsSync(plan.eventsFile)) {
        const { kept, removed } = knowledgeCleanup.filterEventsForTeam(
          fs.readFileSync(plan.eventsFile, "utf8"), plan.teamId);
        if (removed > 0) {
          fs.writeFileSync(plan.eventsFile, kept.length ? kept.join("\n") + "\n" : "");
        }
      }
    } catch (err) {
      console.warn(`[Orchestrator] knowledge purge (feed rewrite): ${err.message}`);
    }
  }
  _kbRefreshThrottles.delete(plan.teamId);
  console.log(`[Orchestrator] Purged team-scoped knowledge for deleted team '${plan.teamId}'`);
}

// Mirror named control-plane files (CLAUDE.md, AGENT-PROMPT.md, skills/<name>,
// ...) from the pool subpath into an isolated agent's dedicated volume after an
// edit (#185 item 5). No-op unless the per-agent-volume flag is on AND the agent
// is currently running — a stopped/never-spawned agent re-seeds fresh on its
// next spawn, and a missing volume is skipped inside reseedPerAgentVolume.
// Best-effort: a re-seed failure must never break the edit that triggered it.
async function reseedAgent(id, paths) {
  if (!PER_AGENT_VOLUME) return { skipped: 'flag-off' };
  if (!agentProcesses.has(id)) return { skipped: 'not-running' };
  try {
    return await reseedPerAgentVolume(id, paths);
  } catch (err) {
    console.warn(`[Orchestrator] reseed ${id} (${(paths || []).join(',')}): ${err.message}`);
    return { error: err.message };
  }
}

function listAgentIds() {
  if (!fs.existsSync(AGENTS_DIR)) return [];
  return fs.readdirSync(AGENTS_DIR).filter((f) =>
    fs.existsSync(path.join(AGENTS_DIR, f, "config.json"))
  );
}

// Every agent dir with its config, in the `{ id, cfg }` shape the pure
// cascade/orphan planners take (#1960). A dir whose config.json is present but
// unparseable yields `cfg: null` rather than being dropped — the planners treat
// it as an id that is occupied but is not a resolvable parent, which is the
// honest reading. (A dir with no config.json at all is already excluded by
// listAgentIds(); a member naming one therefore reads as `parent-missing`.)
//
// Deliberately reads the same dirs as listAgentIds() so the delete route and
// the orphan scan can never disagree about what is on disk.
function listAgentConfigs() {
  return listAgentIds().map((id) => ({ id, cfg: loadAgentConfig(id) }));
}

// All team-member configs belonging to teamId — shared by
// listTeamMembersWithState/disableTeam/enableTeam so the membership
// filter (role + parentTeamId) lives in exactly one place.
function teamMemberConfigs(teamId) {
  return listAgentIds()
    .map((id) => loadAgentConfig(id))
    .filter((c) => c && c.role === "team-member" && c.parentTeamId === teamId);
}

// Busy/active-trigger snapshot for an agent — shared by disableAgent's own
// busy-warning path and the team-members preview listing, so both report
// identical state for the same agent.
function agentBusyState(id) {
  let statusJson = null;
  try {
    statusJson = JSON.parse(
      fs.readFileSync(agentStatePath(id, 'status.json'), 'utf8'), // control-plane copy preferred (#185)
    );
  } catch { /* no status file = idle */ }

  let triggers = null;
  try {
    triggers = loadTriggers(id); // canonical copy (#185 Phase 2)
  } catch { /* no triggers file */ }

  return deriveBusyState(statusJson, triggers);
}

// ============================================================
// Matrix helpers (admin operations only — no routing identity)
// ============================================================

// Total time budget for the login retry that absorbs the cold-stack
// provisioning race (issue #719). Overridable via env for slow CI stacks; a
// non-positive/NaN value falls back to the module default.
const MATRIX_LOGIN_RETRY_CEILING_MS = (() => {
  const raw = Number(process.env.AEE_MATRIX_LOGIN_RETRY_CEILING_MS);
  return Number.isFinite(raw) && raw > 0
    ? raw
    : matrixLoginRetry.DEFAULT_CEILING_MS;
})();

async function ensureMatrixUser(adminClient, username, password, { allowHumanLocalpart = false } = {}) {
  // Human-localpart reservation (#1458). This function is the ONE choke point
  // through which every Matrix account in the stack is created — the seven
  // agent/team/member call sites below and the human-provisioning path — so it
  // is the only place the reservation has to be enforced to be complete.
  //
  // Agent ids are free-form slugs (AGENT_ID_RE allows `[A-Za-z0-9_-]`), so
  // without this an operator could create an agent literally named
  // `u-0123456789abcdef` and take over a human's Matrix account, and with it
  // that human's rooms. The predicate is exactly as narrow as the minted human
  // shape, so ordinary ids like `u-payments` remain legal.
  if (!allowHumanLocalpart && humanMatrixIdentity.isReservedHumanLocalpart(username)) {
    throw new Error(
      `Matrix localpart '${username}' is reserved for per-human identities (#1458)`,
    );
  }
  // Ordered create → reset-password → enable-login. Plain reset-password both
  // sets the password and reactivates a previously deactivated account on the
  // Continuwuity build we run (issue #715) — see matrix-admin-commands.js.
  for (const { body, delayMs } of buildEnsureUserCommands(username, password)) {
    await adminClient.sendMessage(CONDUWUIT_ADMIN_ROOM, { msgtype: "m.text", body });
    await new Promise((r) => setTimeout(r, delayMs));
  }
}

// Re-issue only the account-reactivation commands (no create-user) for an
// existing local account. Called from the login-retry recovery path when a
// login still returns M_USER_DEACTIVATED after `ensureMatrixUser` (issue #1386):
// on a delete→immediate-recreate race the admin bot can process the deletion's
// `deactivate` *after* the ensure sequence's `reset-password`, so re-sending the
// reactivation once the late deactivate has landed clears the flag.
async function reissueMatrixReactivation(adminClient, username, password) {
  for (const { body, delayMs } of buildReactivateCommands(username, password)) {
    await adminClient.sendMessage(CONDUWUIT_ADMIN_ROOM, { msgtype: "m.text", body });
    await new Promise((r) => setTimeout(r, delayMs));
  }
}

// A single login attempt: one /login round-trip, throwing on any non-success
// response (the error body — including an `M_FORBIDDEN` errcode — is preserved
// in the message so the retry classifier can read it).
async function attemptLoginMatrixUser(username, password) {
  const res = await fetch(`${HOMESERVER}/_matrix/client/v3/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "m.login.password",
      identifier: { type: "m.id.user", user: username },
      password,
    }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error(`Login failed: ${JSON.stringify(data)}`);
  return data.access_token;
}

// Log in, tolerating the cold-stack provisioning race (issue #719). On a fast
// system the first attempt succeeds and returns immediately; on a slow one the
// admin bot may not have finished create-user/enable-login by the time we try,
// yielding a transient M_FORBIDDEN — we retry the login with bounded backoff up
// to MATRIX_LOGIN_RETRY_CEILING_MS. Non-retryable errors propagate at once.
//
// When `adminClient` is supplied, a lingering M_USER_DEACTIVATED between retries
// re-issues the account-reactivation admin command (issue #1386): the delete→
// immediate-recreate race can leave the account deactivated at first login
// because the deletion's `deactivate` was processed *after* the ensure
// sequence's reactivating `reset-password`. Re-sending the reactivation, then
// waiting out the backoff, lets the next login succeed once the late deactivate
// has landed. Without an adminClient the loop behaves exactly as before (login
// retries only) — every existing call site keeps its prior semantics.
async function loginMatrixUser(username, password, adminClient = null) {
  return matrixLoginRetry.retryWhile(
    () => attemptLoginMatrixUser(username, password),
    {
      ceilingMs: MATRIX_LOGIN_RETRY_CEILING_MS,
      onBeforeRetry: adminClient
        ? async (err) => {
            if (!matrixLoginRetry.isDeactivatedError(err)) return;
            // Best-effort — a failed re-issue must not abort the retry loop;
            // the next login attempt is the real gate.
            await reissueMatrixReactivation(adminClient, username, password).catch((e) =>
              console.warn(`[Orchestrator] reactivation re-issue for ${username} failed: ${e.message}`)
            );
          }
        : null,
    }
  );
}

async function setDisplayName(token, userId, displayName) {
  await fetch(
    `${HOMESERVER}/_matrix/client/v3/profile/${encodeURIComponent(userId)}/displayname`,
    {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ displayname: displayName }),
    }
  );
}

// ============================================================
// Per-human Matrix identity (#1458, epic #2076 P1)
// ============================================================
//
// docs/multi-user-concept.md §4: every human gets their OWN Matrix account
// instead of sharing the one admin identity whose token lives in
// MATRIX_ACCESS_TOKEN. This is the identity half of that change — the room
// model (one DM room per (human, agent), one shared room per team agent) is
// the second half and lands separately; it needs these accounts to exist
// before it can invite anyone into anything.
//
// ── The provisioning mechanism, and why it is this one ─────────────────────
// Continuwuity exposes NO Synapse `/_synapse/admin/` REST API (see
// matrix-admin-commands.js), and the stack runs with
// CONTINUWUITY_ALLOW_REGISTRATION="false", so the client registration endpoint
// is closed too. The only live mechanism is the admin-ROOM command sequence
// that `ensureMatrixUser` already fires for every agent. Humans therefore
// reuse it verbatim — including its two hard-won properties:
//   * the ordered create → reset-password → enable-login sequence, which also
//     recovers a previously deactivated account (issue #715), so a re-onboarded
//     human gets their old rooms back rather than a dead account; and
//   * `loginMatrixUser`'s bounded retry, which absorbs the cold-stack race
//     where the admin bot has not processed the commands yet (issues #719/#1386).
// The admin-room commands are fire-and-forget — their replies are never parsed
// — so the LOGIN is the only real success signal, exactly as for agents.
//
// ── When this runs ─────────────────────────────────────────────────────────
// At user-record creation, not at first login. There is no just-in-time user
// provisioning today (admin-console/api/auth.js fails an unregistered identity
// closed, #1415), so a user record is always created deliberately, and doing
// the work there keeps the ~5s of admin-bot settle delays off the login path.
// When SSO JIT provisioning does arrive it will create a user record and pick
// this up for free.

// Deactivate a Matrix account by its full user id. The class method
// `deactivateMatrixUser` covers agents (which are addressed by agent id);
// humans are addressed by their derived `@u-<hash>:local`, so the id-taking
// form lives here. Best-effort and fire-and-forget, like every admin-room op.
async function deactivateMatrixUserId(adminClient, matrixUserId) {
  if (!adminClient || !matrixUserId) return;
  try {
    await adminClient.sendMessage(CONDUWUIT_ADMIN_ROOM, {
      msgtype: "m.text",
      body: `!admin users deactivate ${matrixUserId}`,
    });
    console.log(`[Orchestrator] Matrix user ${matrixUserId} deactivated`);
  } catch (err) {
    console.error(`[Orchestrator] Deactivate warning for ${matrixUserId}: ${err.message}`);
  }
}

// Idempotent: make sure `user` has a Matrix account and a stored access token.
// Returns the credential record, or null when it could not be provisioned.
//
// Idempotency matters because the callers are best-effort: a create that failed
// (admin bot down, homeserver restarting) must be repairable by simply calling
// this again, and a call for an already-provisioned user must be a cheap no-op
// rather than a second round of admin-room traffic.
async function ensureHumanMatrixIdentity(adminClient, user) {
  if (!user || !user.id || !user.subject) return null;

  const existing = humanMatrixStore.readIdentity(user.id);
  if (existing && existing.accessToken) return existing;

  const localpart = humanMatrixIdentity.humanMatrixLocalpart(user.subject);
  const matrixUserId = humanMatrixIdentity.humanMatrixUserId(user.subject);

  // A human's Matrix password is never typed by anyone — the access token from
  // the login below is what we keep — so it is a full-entropy random value
  // rather than the derivable `agent-<id>-<ts>` pattern the agent path uses.
  const password = randomHex(24);

  if (adminClient) {
    await ensureMatrixUser(adminClient, localpart, password, { allowHumanLocalpart: true });
  }
  const accessToken = await loginMatrixUser(localpart, password, adminClient);

  // Display name = the corporate display name (concept §4 step 2). This is the
  // only human-readable thing room members see, since the localpart is a hash.
  await setDisplayName(accessToken, matrixUserId, user.displayName || user.subject);

  const record = humanMatrixStore.writeIdentity(user.id, { matrixUserId, accessToken });
  // The pointer — not the token — goes on the user record so other components
  // can resolve "which Matrix account is this human?" without touching the
  // credential store.
  try {
    teamsStore.setUserMatrixIdentity(user.id, matrixUserId);
  } catch (err) {
    console.warn(`[Orchestrator] could not stamp matrixUserId on user ${user.id}: ${err.message}`);
  }
  console.log(`[Orchestrator] Provisioned Matrix identity ${matrixUserId} for user ${user.id}`);
  return record;
}

// Fire-and-forget wrapper for the create path: provisioning costs several
// seconds of admin-bot settle delays, and a homeserver hiccup must not fail the
// user creation the caller actually asked for. A user left without an identity
// is repaired by the next `ensureHumanMatrixIdentity` call.
function provisionHumanMatrixIdentityInBackground(adminClient, user) {
  ensureHumanMatrixIdentity(adminClient, user).catch((err) => {
    console.warn(
      `[Orchestrator] Matrix identity provisioning deferred for user ${user && user.id}: ${err.message}`,
    );
  });
}

// Off-boarding counterpart: deactivate the account and drop the stored token so
// the credential does not outlive the user record. Best-effort in both halves —
// the user removal is what the caller contracted for.
async function deprovisionHumanMatrixIdentity(adminClient, userId) {
  const identity = humanMatrixStore.readIdentity(userId);
  if (identity && identity.matrixUserId) {
    await deactivateMatrixUserId(adminClient, identity.matrixUserId);
  }
  humanMatrixStore.deleteIdentity(userId);
}

// ============================================================
// Git helpers (pull + commit + push from the orchestrator workspace)
// ============================================================

// Where the agent's persistent Claude home is mounted *inside the orchestrator*
// (the whole claude-home volume) vs. *inside the agent* (only its homes/<id>
// SubPath). Files the orchestrator writes under <ORCH>/homes/<id>/X surface to
// the agent at <AGENT>/X — the bridge we use to hand a per-env SSH key to an
// agent container that does not mount the _keys store.
const CLAUDE_HOME_ORCH_DIR = "/root/.claude";
const CLAUDE_HOME_AGENT_DIR = "/root/.claude";

// Install the environment's SSH deploy key into a running agent.
//
// The agent container mounts neither the _keys store nor the host deploy key,
// yet startAgentProcess copies the orchestrator's whole process.env into the
// agent — including the GIT_SSH_COMMAND that docker-compose sets for the
// orchestrator itself (pointing at /root/.ssh/id_orchestrator, an optional
// baseline key that only exists in the orchestrator). Inherited blindly, that var made every
// agent's `git push` reference a key it does not have ("SSH key missing").
//
// So we ALWAYS strip the inherited value first, then — only when the env has an
// SSH key — copy that key into the agent's claude-home SubPath (orchestrator
// path <ORCH>/homes/<id>/.ssh, agent path <AGENT>/.ssh) and write a self-
// contained ssh config beside it. GIT_SSH_COMMAND is set to `ssh -F <config>`
// so it applies regardless of the agent's HOME (agent git runs with
// HOME=/workspace/agents/<id>, so the image-baked /root/.ssh/config is never
// read). The config carries the github.com -> ssh.github.com:443 routing that
// corporate networks blocking outbound TCP 22 require.
function materializeAgentSshKey(id, env, childEnv) {
  delete childEnv.GIT_SSH_COMMAND;

  const orchSshDir = path.join(CLAUDE_HOME_ORCH_DIR, "homes", id, ".ssh");
  const orchKeyPath = path.join(orchSshDir, "id_env");
  const orchCfgPath = path.join(orchSshDir, "config");
  const agentSshDir = path.join(CLAUDE_HOME_AGENT_DIR, ".ssh");
  const agentKeyPath = path.join(agentSshDir, "id_env");
  const agentCfgPath = path.join(agentSshDir, "config");
  const agentKnownHosts = path.join(agentSshDir, "known_hosts");

  const repos = Array.isArray(env?.repositories) ? env.repositories : [];
  const sshKeyId = repos.find((r) => r && r.sshKeyId)?.sshKeyId;
  if (!sshKeyId) {
    // No key for this env — make sure no stale identity lingers from a prior
    // spawn under a different (key-bearing) environment.
    try { fs.rmSync(orchKeyPath, { force: true }); } catch { /* best effort */ }
    try { fs.rmSync(orchCfgPath, { force: true }); } catch { /* best effort */ }
    return;
  }

  const srcKeyPath = path.join(SSH_KEYS_DIR, sshKeyId);
  if (!fs.existsSync(srcKeyPath)) {
    console.error(`[Orchestrator] Agent ${id} → SSH key ${sshKeyId} not found at ${srcKeyPath}; SSH git ops will fail`);
    return;
  }

  try {
    fs.mkdirSync(orchSshDir, { recursive: true });
    fs.writeFileSync(orchKeyPath, fs.readFileSync(srcKeyPath), { mode: 0o600 });
    fs.chmodSync(orchKeyPath, 0o600);
    const sshConfig = [
      "Host github.com",
      "  HostName ssh.github.com",
      "  Port 443",
      "  User git",
      `  IdentityFile ${agentKeyPath}`,
      "  IdentitiesOnly yes",
      `  UserKnownHostsFile ${agentKnownHosts}`,
      "  StrictHostKeyChecking accept-new",
      "  BatchMode yes",
      "",
    ].join("\n");
    fs.writeFileSync(orchCfgPath, sshConfig, { mode: 0o600 });
    childEnv.GIT_SSH_COMMAND = `ssh -F ${agentCfgPath}`;
    console.log(`[Orchestrator] Agent ${id} → SSH identity installed (env=${env.id}, key=${sshKeyId})`);
  } catch (err) {
    console.error(`[Orchestrator] Agent ${id} → failed to install SSH key ${sshKeyId}: ${err.message}`);
  }
}

// Build the GIT_SSH_COMMAND value for an env with an attached SSH key. Falls
// back to null so the caller can leave process.env's default in place — the
// optional baseline identity from docker-compose (ORCHESTRATOR_SSH_KEY), which
// is a dud /dev/null key unless the operator configured one.
function buildGitSshCommand(env) {
  const repos = Array.isArray(env?.repositories) ? env.repositories : [];
  const sshKeyId = repos.find((r) => r && r.sshKeyId)?.sshKeyId;
  if (!sshKeyId) return null;
  const keyPath = path.join(SSH_KEYS_DIR, sshKeyId);
  if (!fs.existsSync(keyPath)) return null;
  try { fs.chmodSync(keyPath, 0o600); } catch { /* best effort */ }
  return `ssh -i ${keyPath} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=8`;
}

// ── Orchestrator-side git push / PR on behalf of an agent ────────────────────
//
// Under enterprise-subscription OAuth (authType "oauth-token") the agent's
// Claude CLI enforces the org's server-managed settings, which can force
// interactive approval for `git push` / `gh pr create` — impossible in an
// unattended run. The agent therefore commits locally (not blocked) and asks
// the orchestrator, via the `gh-as-agent push` / `pr` CLI, to perform the network-facing step.
// The orchestrator shares the workspace volume, so it sees the agent's commits
// and pushes them with the environment's own credentials. See agent-git-ops.js.

function _buildAgentGitEnv(id, repo, env, overrides = {}) {
  return agentGitOps.buildRepoGitEnv({
    env,
    repoUrl: repo.url,
    // Personal-credential resolution (#1569) may override the env's shared
    // ssh key / PAT with the owner's personal one for an attributed write.
    // Absent overrides ⇒ byte-identical to the pre-#1569 env-only behaviour.
    sshKeyId: overrides.sshKeyId || repo.sshKeyId,
    githubTokenId: overrides.githubTokenId || env?.githubTokenId,
    baseEnv: process.env,
    sshKeysDir: SSH_KEYS_DIR,
    ghTokensDir: GH_TOKENS_DIR,
  });
}

// Read the GitHub-token credential index (metadata only — scope/userId, never
// the secret). Used to resolve an owner's personal PAT for an attributed write
// (#1569). Best-effort: an unreadable/absent index yields [] so resolution
// falls through to the shared credential exactly as today.
function loadGithubTokenIndex() {
  try {
    const raw = fs.readFileSync(path.join(GH_TOKENS_DIR, "index.json"), "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// Read the SSH-key credential index (metadata only — scope/userId/fingerprint,
// never the private key). Sibling of `loadGithubTokenIndex`; used by offboarding
// (#1571) to find a departing human's personal SSH keys. Best-effort: an
// unreadable/absent index yields [].
function loadSshKeyIndex() {
  try {
    const raw = fs.readFileSync(SSH_KEYS_INDEX, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// Resolve the GitHub-token id an attributed write (PR/HTTPS push) should run
// under, applying the personal → team → system order with refuse-on-missing
// (#1569, concept §5/§6). Returns `{ githubTokenId }` (the id to inject; the
// env's shared id when the personal tier does not apply) or throws a
// `personalCredentialRequired`-tagged Error the caller surfaces as a distinct,
// actionable failure.
//
// Since #2077 populates `ownerId` on every team and standalone agent, owner
// PRESENCE is no longer the switch — participation in the personal tier is. The
// `present` half of `findPersonalCredentialState` is what carries that
// distinction: an owner with no personal token takes the shared id unchanged and
// never refuses (which is every agent today), while an owner whose personal
// token is present-but-unusable still refuses. See the header comment in
// `credential-resolution.js` for why the switch had to move.
function resolveAttributedGithubToken(id, env, operation) {
  const cfg = loadAgentConfig(id) || {};
  const ownerId = credentialResolution.resolveAgentOwnerId(cfg, loadAgentConfig);
  const personal = credentialResolution.findPersonalCredentialState(loadGithubTokenIndex(), ownerId);
  const decision = credentialResolution.resolveCredential({
    operation,
    ownerId,
    personalCredential: personal.entry,
    personalCredentialPresent: personal.present,
    sharedCredentialId: env?.githubTokenId || null,
    kind: "GitHub token",
  });
  if (decision.refuse) {
    const e = new Error(decision.refuse.message);
    e.personalCredentialRequired = true;
    e.refusalCode = decision.refuse.code;
    throw e;
  }
  return { githubTokenId: decision.credentialId };
}

// ── Shared team Knowledge Base (Shared Agent Learning, Phase 1) ──────────────
// KB working copy = a dedicated checkout of the KB repo on the non-protected
// `agent-knowledge` branch, at <agent>/knowledge. Separate from the agent's
// feature-branch repo clone. See docs/knowledge-cli.md §3.

function _buildKbGitEnv(repoRef, env) {
  return agentGitOps.buildRepoGitEnv({
    env,
    repoUrl: repoRef.url,
    sshKeyId: repoRef.sshKeyId || null,
    githubTokenId: repoRef.githubTokenId || env?.githubTokenId || null,
    baseEnv: process.env,
    sshKeysDir: SSH_KEYS_DIR,
    ghTokensDir: GH_TOKENS_DIR,
  });
}

// Provision the KB working copy into an agent's workspace at seed time. Gated by
// the caller on autonomy >= 1. Best-effort: never throws — a failure just leaves
// the agent without a KB (it degrades to level-0 behaviour) and is surfaced as a
// warning. First agent on a team bootstraps the branch from the shipped template.
function provisionKnowledgeCheckout(id, dest, env, warnings) {
  // #570: knowledge config is per team — overlay the agent's team overrides
  // (idempotent even when a caller already overlaid the same env).
  env = teamKnowledgeEnv(agentKnowledgeTeamId(loadAgentConfig(id) || {}), env);
  const repoRef = env?.knowledgeStore?.repoRef || null;
  if (!repoRef || !repoRef.url) {
    warnings.push("knowledge: no KB repo could be resolved from the environment — skipping KB provisioning");
    return;
  }
  const kbDir = path.join(dest, "knowledge");
  if (fs.existsSync(path.join(kbDir, ".git"))) return; // already provisioned

  const branch = knowledgeSync.resolveKnowledgeBranch(env);
  const gitEnv = _buildKbGitEnv(repoRef, env);
  const runIn = (cwd, args, timeout = 120_000) =>
    execFileSync("git", args, { cwd, env: gitEnv, stdio: "pipe", timeout }).toString();

  try {
    fs.mkdirSync(dest, { recursive: true });
    execFileSync("git", ["clone", "--", repoRef.url, "knowledge"], {
      cwd: dest, env: gitEnv, stdio: "pipe", timeout: 120_000,
    });

    let hasBranch = false;
    try {
      hasBranch = runIn(kbDir, ["ls-remote", "--heads", "origin", branch], 30_000).trim() !== "";
    } catch { /* treat as absent */ }

    if (hasBranch) {
      runIn(kbDir, ["checkout", branch]);
    } else {
      // Bootstrap: a dedicated branch carrying the KB template at the store path.
      runIn(kbDir, ["checkout", "-b", branch]);
      bootstrapKbTemplate(kbDir, env.knowledgeStore.path);
      runIn(kbDir, ["add", "-A"]);
      runIn(kbDir, [
        "-c", "user.name=Agent Studio", "-c", "user.email=knowledge@agents.local",
        "commit", "-m", "chore(knowledge): initialize team knowledge base",
      ]);
      runIn(kbDir, ["push", "--set-upstream", "origin", branch], 60_000);
    }
    console.log(`[Orchestrator] Provisioned KB working copy for ${id} on branch ${branch}`);
  } catch (err) {
    const detail = agentGitOps
      .sanitizeGitOutput((err.stderr || err.message || "").toString())
      .slice(0, 200);
    warnings.push(`knowledge: KB provisioning failed: ${detail}`);
  }
}

// Lay the shipped default KB template (facts/entities/conventions + manifest +
// README) into <kbDir>/<storePath> without clobbering anything already there.
function bootstrapKbTemplate(kbDir, storePath) {
  const templateDir = path.join(__dirname, "knowledge-template");
  if (!fs.existsSync(templateDir)) return;
  const rel = String(storePath || "docs/agent-knowledge/").replace(/^\/+|\/+$/g, "");
  const storeFull = path.join(kbDir, rel);
  fs.mkdirSync(storeFull, { recursive: true });
  fs.cpSync(templateDir, storeFull, { recursive: true, force: false, errorOnExist: false });
}

// Read every raw KB entry from a store root (shards before canonical per kind,
// so the digest fold's last-writer tie-break keeps the curated canonical copy).
// Mirrors _read_kb_entries() in agent-image/scripts/agent-entrypoint.py.
function readKbStoreEntries(storeRoot) {
  const manifest = _loadCloneManifest(storeRoot);
  const out = [];
  for (const kind of KNOWLEDGE_KINDS) {
    let rel;
    try { rel = kindFilePath(manifest, kind); } catch { continue; }
    const dir = path.dirname(rel);
    const shardsDir = path.join(storeRoot, dir, "shards");
    let names = [];
    try { names = fs.readdirSync(shardsDir).filter((n) => n.endsWith(".jsonl")).sort(); } catch { /* none */ }
    const files = names.map((n) => path.join(shardsDir, n));
    const canonical = path.join(storeRoot, rel);
    if (fs.existsSync(canonical)) files.push(canonical);
    for (const f of files) {
      let raw;
      try { raw = fs.readFileSync(f, "utf8"); } catch { continue; }
      for (const line of raw.split("\n")) {
        const e = parseKnowledgeEntry(line);
        if (e) out.push(e);
      }
    }
  }
  return out;
}

// Render + atomically write an agent's knowledge-digest.md (workspace root)
// from the given KB store root — the orchestrator half of the digest writer
// contract (the runtime's pre-invocation rebuild is the other; both go through
// the same pure builder, so they can't disagree). Best-effort: throws never
// leave a torn file (tmp+rename); callers catch.
function writeAgentKnowledgeDigest(id, teamId, storeRoot) {
  const { markdown } = buildKnowledgeDigest({
    teamId,
    generatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    entries: readKbStoreEntries(storeRoot),
  });
  const target = path.join(agentDir(id), KNOWLEDGE_DIGEST_FILENAME);
  const tmp = target + ".tmp";
  fs.writeFileSync(tmp, markdown);
  fs.renameSync(tmp, target);
  // #917: guarantee the scoped-knowledge stub exists so the CLAUDE.md
  // `@`-import never dangles. STUB ONLY — the orchestrator never has the
  // invocation prompt; the Python runtime is the single real writer and
  // overwrites this before every run. Never overwrite an existing file (it may
  // hold the last invocation's real matches, which the operator can browse).
  const scoped = path.join(agentDir(id), SCOPED_KNOWLEDGE_FILENAME);
  if (!fs.existsSync(scoped)) {
    fs.writeFileSync(
      scoped,
      "# Task-Scoped Knowledge\n\n" +
      "> GENERATED — do not edit. Auto-built before every run from team knowledge\n" +
      "> whose auto-load triggers match the current task.\n\n" +
      "No task-scoped knowledge for this session.\n",
    );
  }
}

// ── Legacy-memory migration (Memory/Knowledge unification, Phase 3) ─────────
// One-shot per agent, at the flip to the unified model (concept §6): parse
// legacy memory/facts.md + entities.md into KB entries (provenance
// migration:<agentId>), push them to the shared agent-knowledge branch via the
// team's canonical clone, archive the files to memory/_archive/ (visible, not
// deleted). Template boilerplate (headings only) is deleted instead — a fresh
// unified agent simply starts on the three-file episodic model. users.md is
// NEVER touched (personal data, locked decision). Best-effort: a failed push
// leaves the files in place, so the next startup pass retries.

// Append the migrated entries to a dedicated per-agent shard
// (<kind>/shards/<agentId>.migrated.jsonl — both the CLI and the collector
// glob shards/*.jsonl, so it is picked up everywhere) in the canonical clone,
// then commit + push. A separate file, NOT the agent's own shard: the agent
// appends to its shard concurrently from its container, and two writers on
// one append-only file would race at rebase time. Throws on failure.
function pushMigrationEntries(id, teamId, env, entries) {
  env = teamKnowledgeEnv(teamId, env); // #570: per-team knowledge config
  const repoRef = env?.knowledgeStore?.repoRef || null;
  if (!repoRef || !repoRef.url) throw new Error("no KB repo resolvable from the environment");
  const refresh = refreshKnowledgeClone(teamId, { force: true, repoRef, env });
  const clonePath = knowledgeFeed.canonicalClonePath(KNOWLEDGE_CLONE_ROOT, teamId);
  if (!clonePath || !fs.existsSync(path.join(clonePath, ".git"))) {
    throw new Error(`canonical clone unavailable: ${refresh.warnings.join("; ") || "clone failed"}`);
  }
  const storeRoot = path.join(clonePath, _kbStoreRel(env));
  const manifest = _loadCloneManifest(storeRoot);

  const byKind = new Map();
  for (const e of entries) {
    if (!byKind.has(e.kind)) byKind.set(e.kind, []);
    byKind.get(e.kind).push(e);
  }
  for (const [kind, list] of byKind) {
    let rel;
    try { rel = kindFilePath(manifest, kind); } catch { continue; }
    const shard = path.join(storeRoot, path.dirname(rel), "shards", `${id}.migrated.jsonl`);
    fs.mkdirSync(path.dirname(shard), { recursive: true });
    const have = new Set();
    if (fs.existsSync(shard)) {
      for (const line of fs.readFileSync(shard, "utf8").split("\n")) {
        const e = parseKnowledgeEntry(line);
        if (e && e.id) have.add(e.id);
      }
    }
    const add = list.filter((e) => !have.has(e.id));
    if (add.length > 0) {
      fs.appendFileSync(shard, add.map(serializeKnowledgeEntry).join("\n") + "\n");
    }
  }

  const gitEnv = _buildKbGitEnv(repoRef, env);
  const runIn = (args, timeout = 60_000) =>
    execFileSync("git", args, { cwd: clonePath, env: gitEnv, stdio: "pipe", timeout }).toString();
  runIn(["add", "-A"]);
  if (runIn(["status", "--porcelain"]).trim() === "") return; // idempotent re-run
  runIn([
    "-c", "user.name=Agent Studio", "-c", `user.email=${id}@agents.local`,
    "commit", "-m", `chore(knowledge): migrate legacy memory of ${id} (unification phase 3)`,
  ]);
  const branch = knowledgeSync.resolveKnowledgeBranch(env);
  try {
    runIn(["push", "origin", branch]);
  } catch (err) {
    // Lost the fast-forward race against a concurrent agent push — rebase our
    // (own-file-only) commit on top and push once more.
    if (!knowledgeSync.isRetryablePushError((err.stderr || err.message || "").toString())) throw err;
    runIn(["fetch", "origin", branch], 30_000);
    runIn(["rebase", `origin/${branch}`], 30_000);
    runIn(["push", "origin", branch]);
  }
}

function migrateAgentMemoryToKb(id, cfg, env) {
  if (!agentKnowledgeDigestRef(id, env)) return { migrated: 0, skipped: "not-unified" };
  const memDir = path.join(agentDir(id), "memory");
  const files = [
    { name: "facts.md", parse: memoryMigration.parseLegacyFacts, key: "facts" },
    { name: "entities.md", parse: memoryMigration.parseLegacyEntities, key: "entities" },
  ];
  const toArchive = [];
  const parsed = { facts: [], entities: [] };
  let present = 0;
  for (const f of files) {
    const p = path.join(memDir, f.name);
    if (!fs.existsSync(p)) continue;
    present += 1;
    const text = fs.readFileSync(p, "utf8");
    if (!memoryMigration.hasLegacyContent(text)) {
      // Template boilerplate (`# Facts` / `# Entities`) — delete, no archive noise.
      fs.rmSync(p, { force: true });
      continue;
    }
    parsed[f.key] = f.parse(text);
    toArchive.push(p);
  }
  if (toArchive.length === 0) {
    return { migrated: 0, skipped: present === 0 ? "already-migrated" : "boilerplate-only" };
  }

  const teamId = agentKnowledgeTeamId(cfg);
  env = teamKnowledgeEnv(teamId, env); // #570: per-team knowledge config
  const entries = memoryMigration.buildMigrationEntries({
    agentId: id, teamId, facts: parsed.facts, entities: parsed.entities,
  });
  if (entries.length > 0) pushMigrationEntries(id, teamId, env, entries); // throws → files stay, retried next pass

  // Archive only after the entries are durably in the KB.
  const archiveDir = path.join(memDir, "_archive");
  fs.mkdirSync(archiveDir, { recursive: true });
  for (const p of toArchive) fs.renameSync(p, path.join(archiveDir, path.basename(p)));

  if (entries.length > 0) {
    const ts = new Date().toISOString();
    appendKnowledgeEvents(entries.map((entry) => knowledgeFeed.buildHarvestEvent({ teamId, agentId: id, entry, ts })));
    // #855: runConvergenceCollector is async (its curator LLM synthesis no longer
    // blocks the event loop) — fire-and-forget with a .catch so the (already
    // best-effort) pass never surfaces an unhandled rejection.
    runConvergenceCollector(teamId, env)
      .catch((err) => console.warn(`[Orchestrator] convergence after migration of ${id}: ${err.message}`));
    try { fanOutKnowledgeDigests(teamId, env); }
    catch (err) { console.warn(`[Orchestrator] digest fan-out after migration of ${id}: ${err.message}`); }
  }
  return { migrated: entries.length, archived: toArchive.map((p) => path.basename(p)) };
}

// Startup pass: migrate every unified agent that still carries legacy files.
// Idempotent — migrated agents return `already-migrated` on every later boot.
function migrateUnifiedAgentsMemory() {
  for (const id of listAgentIds()) {
    try {
      const cfg = loadAgentConfig(id);
      if (!cfg) continue;
      const env = cfg.environmentId ? loadEnvironment(cfg.environmentId) : null;
      const r = migrateAgentMemoryToKb(id, cfg, env);
      if (r.migrated > 0) {
        console.log(`[Orchestrator] Migrated ${r.migrated} legacy memory entries of ${id} to the team KB (archived: ${r.archived.join(", ")})`);
      }
    } catch (err) {
      console.warn(`[Orchestrator] legacy-memory migration for ${id} failed (will retry next start): ${err.message}`);
    }
  }
}

// Self-heal a knowledge working copy that has shard content but no git checkout.
// This is the state of every agent seeded BEFORE the knowledge feature (or whose
// seed-time clone failed): the `knowledge` CLI kept appending shard lines locally
// while every push 400'd with "not provisioned" — so the lessons never reached
// the team. On the next push we move the un-synced tree aside, provision a fresh
// checkout, merge the local shard lines back in (append-only, dedup by entry id),
// and commit — after which the caller's normal rebase+push flow takes over.
function healKnowledgeCheckout(id, kbDir, env, warnings) {
  env = teamKnowledgeEnv(agentKnowledgeTeamId(loadAgentConfig(id) || {}), env); // #570: per-team knowledge config
  const dest = agentDir(id);
  const sources = [];
  // A previous heal that died between rename and merge leaves *.unsynced-* dirs.
  try {
    for (const name of fs.readdirSync(dest)) {
      if (name.startsWith("knowledge.unsynced-")) sources.push(path.join(dest, name));
    }
  } catch { /* no agent dir → provisioning will fail loudly below */ }
  if (fs.existsSync(kbDir)) {
    const aside = path.join(dest, `knowledge.unsynced-${Date.now()}`);
    fs.renameSync(kbDir, aside);
    sources.push(aside);
  }

  provisionKnowledgeCheckout(id, dest, env, warnings);
  if (!fs.existsSync(path.join(kbDir, ".git"))) {
    throw new Error(
      `knowledge working copy could not be provisioned: ${warnings.join("; ") || "git clone failed"}`,
    );
  }

  // Merge every un-synced shard file back in: append lines whose entry id (or,
  // for an unparseable line, the raw line itself) is not already present.
  let mergedLines = 0;
  for (const src of sources) {
    for (const shard of _walkShardFiles(src)) {
      const rel = path.relative(src, shard);
      const target = path.join(kbDir, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const have = new Set();
      const haveRaw = new Set();
      if (fs.existsSync(target)) {
        for (const line of fs.readFileSync(target, "utf8").split("\n")) {
          if (!line.trim()) continue;
          haveRaw.add(line);
          const e = parseKnowledgeEntry(line);
          if (e && e.id) have.add(e.id);
        }
      }
      const add = [];
      for (const line of fs.readFileSync(shard, "utf8").split("\n")) {
        if (!line.trim() || haveRaw.has(line)) continue;
        const e = parseKnowledgeEntry(line);
        if (e && e.id && have.has(e.id)) continue;
        add.push(line);
      }
      if (add.length > 0) {
        fs.appendFileSync(target, add.join("\n") + "\n");
        mergedLines += add.length;
      }
    }
  }
  if (mergedLines > 0) {
    const gitEnv = _buildKbGitEnv(env?.knowledgeStore?.repoRef || {}, env);
    const runIn = (args, timeout = 30_000) =>
      execFileSync("git", args, { cwd: kbDir, env: gitEnv, stdio: "pipe", timeout }).toString();
    runIn(["add", "-A"]);
    runIn([
      "-c", `user.name=${id}`, "-c", `user.email=${id}@agents.local`,
      "commit", "-m", "chore(knowledge): recover locally-recorded entries into the synced checkout",
    ]);
  }
  for (const src of sources) {
    try { fs.rmSync(src, { recursive: true, force: true }); } catch { /* leftover is re-merged next heal */ }
  }
  console.log(`[Orchestrator] healed knowledge checkout for ${id} (${mergedLines} recovered line(s))`);
}

// All shard JSONL files under a knowledge tree (any store path / manifest).
function _walkShardFiles(root) {
  const out = [];
  const walk = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const d of entries) {
      const p = path.join(dir, d.name);
      if (d.isDirectory()) {
        if (d.name === ".git") continue;
        walk(p);
      } else if (d.isFile() && d.name.endsWith(".jsonl") && path.basename(dir) === "shards") {
        out.push(p);
      }
    }
  };
  walk(root);
  return out;
}

// Serialize the KB push per team. Concurrent agents on one team otherwise all
// fetch/rebase/push the shared branch at once, lose the fast-forward race
// (non-fast-forward reject → retry storm) and stack up git subprocesses. One
// push at a time per team keeps them conflict-free and the git work bounded.
const _kbPushMutex = createKeyedMutex();

// Push the agent's local KB commits to the shared branch. Fetch-rebase-retry so
// a concurrent agent's push can't make us lose our (own-shard-only) append.
// ASYNC: the git steps run through execFileP so the orchestrator event loop
// keeps serving HTTP / the poller while git talks to the remote — a synchronous
// execFileSync here previously froze the whole control plane for the multi-
// second SSH round-trips (worst under the very concurrency this now serializes).
// Throws caller-facing Errors (safe to return over the internal API).
async function agentKnowledgePush(id) {
  const cfg = loadAgentConfig(id);
  const teamId = agentKnowledgeTeamId(cfg || {});
  const env = teamKnowledgeEnv(teamId, cfg && cfg.environmentId ? loadEnvironment(cfg.environmentId) : null); // #570: per-team knowledge config
  const repoRef = env?.knowledgeStore?.repoRef || null;
  if (!repoRef || !repoRef.url) throw new Error("no knowledge repo is configured for this agent");

  const kbDir = path.join(agentDir(id), "knowledge");
  if (!fs.existsSync(path.join(kbDir, ".git"))) {
    healKnowledgeCheckout(id, kbDir, env, []);
  }

  const branch = knowledgeSync.resolveKnowledgeBranch(env);
  const gitEnv = _buildKbGitEnv(repoRef, env);
  const run = async (args, timeout = 30_000) =>
    String((await execFileP("git", args, { cwd: kbDir, env: gitEnv, timeout })).stdout);

  // Local read (no network) — cheap, no need to hold the per-team lock for it.
  const current = (await run(["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  if (!knowledgeSync.knowledgeBranchAllowed(current, branch)) {
    throw new Error(`knowledge push refused: checkout is on '${current}', not ${branch}`);
  }

  return _kbPushMutex(teamId, async () => {
    let lastErr = "";
    for (let attempt = 1; attempt <= knowledgeSync.MAX_PUSH_RETRIES; attempt++) {
      // Rebase our local commits onto the latest shared tip (clean: each agent
      // only ever touches its own shard file). Both steps tolerate a not-yet-
      // existing remote branch (first push on the team).
      try {
        await run(["fetch", "origin", branch]);
        await run(["rebase", `origin/${branch}`]);
      } catch {
        try { await run(["rebase", "--abort"]); } catch { /* nothing to abort */ }
      }
      try {
        const out = await run(["push", "--set-upstream", "origin", branch]);
        return { ok: true, branch, output: agentGitOps.sanitizeGitOutput(out).trim() };
      } catch (err) {
        lastErr = agentGitOps.sanitizeGitOutput((err.stderr || err.stdout || err.message || "").toString());
        if (!knowledgeSync.isRetryablePushError(lastErr)) break;
      }
    }
    const e = new Error(`knowledge push failed: ${String(lastErr).trim().slice(0, 400)}`);
    e.gitFailed = true;
    throw e;
  });
}

// ── Canonical KB clone + live feed (Shared Agent Learning, Phase 2) ──────────
// The orchestrator keeps ONE authoritative clone per team at
// /workspace/knowledge/<teamId>/ on the agent-knowledge branch. The
// admin-console reads its
// JSONL shards off the shared volume — no git in the admin-console. It also
// appends a lean event per harvest to a feed file the admin-console tails.

const _kbRefreshThrottles = new Map(); // teamId -> last refresh ms

// The team an agent shares KNOWLEDGE with. This is the AGENT team — the squad
// materialised by the Team-Setup wizard (`parentTeamId` on a member, a `team`
// agent's own id) — NOT the human tenant Team (`teamId`, #299): knowledge is
// pooled per working squad, and that is also the team id operators see in the
// Knowledge Flow UI. A standalone agent without a squad falls back to its human
// team so it still gets a KB scope. (Before this helper the knowledge paths used
// `cfg.teamId || cfg.parentTeamId`, which — since #302 backfills teamId onto
// every agent — always resolved to the human team and broke team-scoped reads
// and env writes for squads.)
function agentKnowledgeTeamId(cfg) {
  if (!cfg) return DEFAULT_TEAM_ID;
  if (typeof cfg.parentTeamId === "string" && cfg.parentTeamId.trim()) return cfg.parentTeamId;
  if (cfg.role === "team" && typeof cfg.id === "string" && cfg.id.trim()) return cfg.id;
  return cfg.teamId || DEFAULT_TEAM_ID;
}

// The squad members whose harvested knowledge belongs to `teamId` — every agent
// whose agentKnowledgeTeamId resolves to this team (a member via parentTeamId, or
// the team agent itself). Used to team-scope the shared-branch clustering input
// (#603): teams working the same repo share one `agent-knowledge` branch, so a
// team's canonical clone contains co-tenant teams' shards. The team id is always
// in the set (a `team` agent's own id === teamId), so members whose shards carry
// originAgent = their id are matched via their parentTeamId resolving here.
function teamSquadMemberIds(teamId) {
  const ids = new Set();
  if (typeof teamId === "string" && teamId.trim()) ids.add(teamId.trim());
  for (const otherId of listAgentIds()) {
    const cfg = loadAgentConfig(otherId);
    if (cfg && agentKnowledgeTeamId(cfg) === teamId) ids.add(otherId);
  }
  return ids;
}

// Per-team knowledge-config overrides (#570). The four knowledge-config groups
// (autonomy / review / promotion gates / storage) are keyed PER TEAM here, not on
// the shared environment record, so two teams reusing one environment hold
// independent settings. Stored at /workspace/teams/<teamId>/knowledge-config.json
// (traversal-guarded via knowledge-feed's safeTeamSegment, the same guard the KB
// clone + team-skill dirs use). A team with no file (or an unset key) falls back
// to the environment's value via mergeTeamKnowledgeConfig — so a read immediately
// after the upgrade is byte-identical to before (migration, AC-2); a write records
// only that team's own key, from then on resolved independently (AC-1/AC-4).
function _teamKnowledgeConfigPath(teamId) {
  const seg = knowledgeFeed.safeTeamSegment(teamId);
  if (!seg) return null;
  return path.join(WORKSPACE, "teams", seg, "knowledge-config.json");
}

function loadTeamKnowledgeOverrides(teamId) {
  const p = _teamKnowledgeConfigPath(teamId);
  if (!p || !fs.existsSync(p)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

// Merge a patch into the team's overrides file and persist it. Only the four
// TEAM_KNOWLEDGE_KEYS are meaningful; the patch keys are written verbatim.
// Returns the full overrides object after the write.
function writeTeamKnowledgeOverrides(teamId, patch) {
  const p = _teamKnowledgeConfigPath(teamId);
  if (!p) throw new Error(`knowledge: refusing unsafe team id '${teamId}'`);
  const next = { ...loadTeamKnowledgeOverrides(teamId), ...patch };
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(next, null, 2));
  return next;
}

// ── Persistent skill domains (#780, skill-aggregation Phase 2) ──────────────────
// A team's domain taxonomy — the routing targets + name sources for its skills —
// persisted at /workspace/teams/<teamId>/knowledge-domains.json (same traversal-
// guarded, team-keyed shared-volume pattern as knowledge-config.json). Pure logic
// lives in knowledge-domains.js; this is the IO. A team with no file carries an
// empty (unconfirmed) doc, so domain routing is a no-op until it is seeded.
function _domainsPath(teamId) {
  const seg = knowledgeFeed.safeTeamSegment(teamId);
  if (!seg) return null;
  return path.join(WORKSPACE, "teams", seg, "knowledge-domains.json");
}

function readTeamDomainsDoc(teamId) {
  const p = _domainsPath(teamId);
  if (!p || !fs.existsSync(p)) return knowledgeDomains.emptyDomainDoc();
  try {
    return knowledgeDomains.normalizeDomainDoc(JSON.parse(fs.readFileSync(p, "utf8")));
  } catch {
    return knowledgeDomains.emptyDomainDoc();
  }
}

function writeTeamDomainsDoc(teamId, doc) {
  const p = _domainsPath(teamId);
  if (!p) throw new Error(`knowledge: refusing unsafe team id '${teamId}'`);
  const normalized = knowledgeDomains.normalizeDomainDoc(doc);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(normalized, null, 2));
  return normalized;
}

// #781 consolidation-migration progress doc (§4). Per-team, resumable — an
// interrupted migration re-enters at the first still-pending domain. Sibling of the
// domains doc; traversal-guarded the same way.
function _consolidationPath(teamId) {
  const seg = knowledgeFeed.safeTeamSegment(teamId);
  if (!seg) return null;
  return path.join(WORKSPACE, "teams", seg, "consolidation-migration.json");
}

function readConsolidationState(teamId) {
  const p = _consolidationPath(teamId);
  if (!p || !fs.existsSync(p)) return null;
  try {
    return knowledgeConsolidation.normalizeMigrationState(JSON.parse(fs.readFileSync(p, "utf8")), {});
  } catch {
    return null;
  }
}

function writeConsolidationState(teamId, state) {
  const p = _consolidationPath(teamId);
  if (!p) throw new Error(`consolidation: refusing unsafe team id '${teamId}'`);
  const normalized = knowledgeConsolidation.normalizeMigrationState(state, {});
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(normalized, null, 2));
  return normalized;
}

// Role tokens for a team's squad, used to seed the default domain list. Derives a
// role from each member config's `role`/`roleId`/id-suffix — best-effort, tolerant.
function teamSquadRoleTokens(teamId) {
  const tokens = new Set();
  for (const id of teamSquadMemberIds(teamId)) {
    if (id === teamId) continue;
    const cfg = loadAgentConfig(id);
    const role = (cfg && (cfg.roleId || cfg.role)) || "";
    if (typeof role === "string" && role && role !== "team-member") tokens.add(role);
    // member ids are conventionally `<teamId>-<roleId>`
    if (typeof id === "string" && id.startsWith(`${teamId}-`)) tokens.add(id.slice(teamId.length + 1));
  }
  return [...tokens];
}

// Lazily seed a team's domain taxonomy from its role templates the first time the
// collector runs for it (§3.1). Deterministic defaults are safe, so a seeded list
// is confirmed by construction; a bootstrap (LLM) list is confirmed by the operator
// via the API. Best-effort: a write failure logs and leaves the team domain-less
// (routing stays a no-op). Returns the domain array in effect.
function ensureTeamDomains(teamId, now) {
  const doc = readTeamDomainsDoc(teamId);
  if (doc.domains.length > 0) return doc.domains;
  const seeded = knowledgeDomains.seedDomainsFromRoles(teamSquadRoleTokens(teamId), { now });
  if (seeded.length === 0) return [];
  try {
    writeTeamDomainsDoc(teamId, { confirmed: true, domains: seeded, updatedAt: now });
    appendKnowledgeEvents([knowledgeDomains.domainEvent("seeded", { teamId, now })]);
  } catch (err) {
    console.warn(`[Orchestrator] domain seed for '${teamId}' failed: ${err.message}`);
  }
  return seeded;
}

// Overlay a team's persisted knowledge-config overrides onto a base environment,
// producing the env-shaped object the pure knowledge readers consume. Applied
// defensively at every knowledge consumer keyed by the teamId it already knows,
// so no single missed call site can leak an env-keyed value.
function teamKnowledgeEnv(teamId, baseEnv) {
  return mergeTeamKnowledgeConfig(baseEnv, loadTeamKnowledgeOverrides(teamId));
}

// Resolve the KB repo for a team from any of its agents' environments (a team
// shares one env → one KB repo), overlaid with the team's per-team knowledge
// config (#570) so the repoRef + branch reflect the TEAM's storage, not the
// environment's. Returns { repoRef, env } (env already overlaid) or null.
function resolveTeamKbRepo(teamId) {
  for (const id of listAgentIds()) {
    const cfg = loadAgentConfig(id);
    if (!cfg) continue;
    if (agentKnowledgeTeamId(cfg) !== teamId) continue;
    if (!cfg.environmentId) continue;
    const env = teamKnowledgeEnv(teamId, loadEnvironment(cfg.environmentId));
    const repoRef = env?.knowledgeStore?.repoRef || null;
    if (repoRef && repoRef.url) return { repoRef, env };
  }
  return null;
}

// The environment id a team shares (from any of its agents' configs). A team is
// materialised with one shared env, so the first match wins. Returns null when no
// agent of the team carries an environmentId.
function resolveTeamEnvId(teamId) {
  for (const id of listAgentIds()) {
    const cfg = loadAgentConfig(id);
    if (!cfg) continue;
    if (agentKnowledgeTeamId(cfg) === teamId && cfg.environmentId) return cfg.environmentId;
  }
  return null;
}

// Persist one per-transition promotion gate PER TEAM (#570). The gates map is
// seeded from the team's current effective gates (per-team override overlaid on
// the env, plus defaults + the forced team>global review) so setting one
// transition never silently resets the others; only that team's own file is
// touched, leaving sibling teams on the shared env untouched (AC-1/AC-4).
function writeTeamPromotionGate(teamId, transition, mode) {
  const effEnv = teamKnowledgeEnv(teamId, loadEnvironment(resolveTeamEnvId(teamId)));
  const gates = { ...resolvePromotionGates(effEnv) };
  gates[transition] = mode;
  writeTeamKnowledgeOverrides(teamId, { knowledgePromotionGates: gates });
  return { gates: resolvePromotionGates({ knowledgePromotionGates: gates }) };
}

// Persist the 0..3 autonomy dial PER TEAM (#570). Takes effect immediately for the
// orchestrator-side convergence/suggestion/curation steps (they overlay the team's
// config fresh each pass); the agent-side harvest hint + KB provisioning are read
// at spawn/seed, so a running agent picks a level change up on its next rebuild.
function writeTeamAutonomy(teamId, level) {
  writeTeamKnowledgeOverrides(teamId, { knowledgeAutonomy: level });
  return { autonomy: knowledgeAutonomyLevel({ knowledgeAutonomy: level }) };
}

// Persist the supervised-review toggle PER TEAM (#570).
function writeTeamReview(teamId, enabled) {
  writeTeamKnowledgeOverrides(teamId, { knowledgeReview: !!enabled });
  return { review: knowledgeReviewEnabled({ knowledgeReview: !!enabled }) };
}

// Persist the wizard's knowledge-*learning* config in ONE write at team-creation
// time (#567). Accepts a patch already reduced to the differing keys by the
// admin-console's normalizeWizardKnowledgeConfig; here we sanitize each key
// defensively (values from an HTTP body are never trusted) before merging it onto
// the team's own knowledge-config.json. STORAGE is deliberately out of scope — a
// `knowledgeStore` key in the patch is ignored, so the wizard can never repoint a
// team's KB repo. Returns the sanitized patch that was written.
function writeTeamKnowledgeConfig(teamId, patch) {
  const src = patch && typeof patch === 'object' ? patch : {};
  const clean = {};

  if ('knowledgeAutonomy' in src) {
    const level = Number(src.knowledgeAutonomy);
    if (!Number.isInteger(level) || level < 0 || level > 3) throw new Error('knowledgeAutonomy must be an integer 0..3');
    clean.knowledgeAutonomy = level;
  }
  if ('knowledgeReview' in src) {
    clean.knowledgeReview = src.knowledgeReview === true || src.knowledgeReview === 'true';
  }
  if ('knowledgePromotionGates' in src) {
    const raw = src.knowledgePromotionGates;
    if (!raw || typeof raw !== 'object') throw new Error('knowledgePromotionGates must be an object');
    const gates = {};
    for (const t of PROMOTION_TRANSITIONS) {
      if (!(t in raw)) continue;
      if (!GATE_MODES.includes(raw[t])) throw new Error(`invalid gate mode for '${t}'`);
      gates[t] = raw[t];
    }
    gates['team>global'] = 'review'; // always reviewed — can't be automated
    clean.knowledgePromotionGates = gates;
  }

  if ('decayHorizonDays' in src) {
    const days = Number(src.decayHorizonDays);
    if (!Number.isInteger(days) || days < 0 || days > 3650) throw new Error('decayHorizonDays must be an integer 0..3650 (0 = off)');
    clean.decayHorizonDays = days;
  }

  if (!Object.keys(clean).length) throw new Error('no valid knowledge-config keys in patch');
  writeTeamKnowledgeOverrides(teamId, clean);
  return clean;
}

// Persist the knowledge storage location — repo, branch, path (#558) — PER TEAM
// (#570), on the team's own knowledge-config file, not the shared environment.
// The env is still consulted (read-only) for the code-repository list, so an
// in-repo store can pin to / inherit the SSH key of a real repo. Reachability of
// the repo/branch + write access is validated by the admin-console layer (it owns
// the ls-remote probe) BEFORE this writer is called, so here we normalize +
// persist, then force-refresh the canonical clone at the NEW location so the
// digest and every downstream read/write follow the change immediately (AC-4).
// Knowledge already stored at the OLD location is deliberately left untouched.
function writeTeamKnowledgeStore(teamId, input) {
  const inMode = input && input.mode === "own-repo" ? "own-repo" : "in-repo";
  const inPath = input && typeof input.path === "string" ? input.path.trim() : "";
  const inBranch = input && typeof input.branch === "string" ? input.branch.trim() : "";
  const inRef = input && input.repoRef && typeof input.repoRef === "object" ? input.repoRef : {};
  let url = typeof inRef.url === "string" ? inRef.url.trim() : "";

  // A team may have no dedicated environment (standalone / envless); the store is
  // still keyed per team, so a missing env is not fatal — we just have no code
  // repositories to pin an in-repo store to.
  const envId = resolveTeamEnvId(teamId);
  const currentEnv = envId ? loadEnvironment(envId) : null;
  const repositories = currentEnv && Array.isArray(currentEnv.repositories) ? currentEnv.repositories : [];
  // The team's current effective store (per-team override overlaid on the env),
  // so MCP knowledge sources round-trip from wherever they currently live.
  const currentStore = teamKnowledgeEnv(teamId, currentEnv)?.knowledgeStore || null;

  if (inMode === "own-repo" && !url) {
    throw new Error("a separate knowledge repository requires a repo URL");
  }
  // in-repo: the UI omits the url when the team has a single repo, so pin it to
  // that repo here. Without a real url, normalizeRepoRef drops the whole repoRef
  // (empty-url → null) and the configured branch/path would be silently lost —
  // the in-repo fallback would re-resolve repoRef from repositories[0] with the
  // repo's DEFAULT branch, not the operator's choice (AC-4).
  if (inMode === "in-repo" && !url && repositories.length) {
    const first = repositories[0];
    if (first && typeof first.url === "string" && first.url.trim()) url = first.url.trim();
  }

  // Build the raw repoRef we will persist (branch rides on it, per the schema).
  let repoRef = null;
  if (url || inBranch || inRef.sshKeyId || inRef.githubTokenId) {
    repoRef = { url };
    if (inBranch) repoRef.branch = inBranch;
    if (typeof inRef.sshKeyId === "string" && inRef.sshKeyId.trim()) repoRef.sshKeyId = inRef.sshKeyId.trim();
    if (typeof inRef.githubTokenId === "string" && inRef.githubTokenId.trim()) repoRef.githubTokenId = inRef.githubTokenId.trim();
  }
  // in-repo: inherit the matching env repository's SSH key when the operator
  // didn't pick one, so KB git ops authenticate exactly like the repo clone
  // (the GitHub token already falls back to env.githubTokenId in _buildKbGitEnv).
  if (inMode === "in-repo" && repoRef && repoRef.url && !repoRef.sshKeyId) {
    const match = repositories.find((r) => r && r.url === repoRef.url);
    if (match && match.sshKeyId) repoRef.sshKeyId = match.sshKeyId;
  }

  const rawStore = { mode: inMode };
  if (inPath) rawStore.path = inPath;
  if (repoRef) rawStore.repoRef = repoRef;
  // MCP knowledge sources are a separate track (#464) — preserve them verbatim.
  const existingSources = currentStore && Array.isArray(currentStore.sources) ? currentStore.sources : [];
  if (existingSources.length) rawStore.sources = existingSources;

  // Normalize + surface any hard error (e.g. own-repo without a resolvable repo)
  // before persisting so an invalid config is rejected, never saved (AC-2).
  const { store, warnings } = normalizeKnowledgeStore({ ...(currentEnv || {}), knowledgeStore: rawStore, repositories });
  const hardError = warnings.find((w) => w.includes("requires a repoRef"));
  if (hardError) throw new Error(hardError);

  writeTeamKnowledgeOverrides(teamId, { knowledgeStore: store });

  const refreshEnv = { ...(currentEnv || {}), knowledgeStore: store, repositories };
  const refRepo = store.repoRef && store.repoRef.url ? store.repoRef : null;
  try {
    refreshKnowledgeClone(teamId, { force: true, repoRef: refRepo, env: refreshEnv });
  } catch (err) {
    console.warn(`[Orchestrator] KB store refresh for '${teamId}' failed: ${err.message}`);
  }
  return { store, warnings: warnings.filter((w) => w !== hardError) };
}

// Ensure/refresh the canonical clone for a team. Best-effort, throttled per team
// (force bypasses the throttle). Never throws — a missing/failing clone just
// means the admin-console reads whatever is on disk (agent-checkout fallback).
// Returns { refreshedAt, warnings }.
function refreshKnowledgeClone(teamId, { force = false, repoRef = null, env = null } = {}) {
  const warnings = [];
  const clonePath = knowledgeFeed.canonicalClonePath(KNOWLEDGE_CLONE_ROOT, teamId);
  if (!clonePath) {
    warnings.push(`knowledge: refusing unsafe team id '${teamId}'`);
    return { refreshedAt: null, warnings };
  }

  const last = _kbRefreshThrottles.get(teamId) || 0;
  if (!force && !knowledgeFeed.shouldRefresh(last, Date.now(), KNOWLEDGE_REFRESH_MIN_MS)) {
    return { refreshedAt: last, warnings };
  }

  let ref = repoRef;
  let kbEnv = env;
  if (!ref) {
    const resolved = resolveTeamKbRepo(teamId);
    if (!resolved) {
      warnings.push(`knowledge: no KB repo resolvable for team '${teamId}'`);
      return { refreshedAt: null, warnings };
    }
    ref = resolved.repoRef;
    kbEnv = resolved.env;
  }
  // #570: knowledge config is keyed per team — overlay the team's overrides onto
  // whatever env we ended up with (idempotent when already overlaid). This is the
  // central hub for the KB branch + digest fan-out, so a per-team KB branch/store
  // resolves correctly here regardless of which caller supplied the env.
  kbEnv = teamKnowledgeEnv(teamId, kbEnv);

  const branch = knowledgeSync.resolveKnowledgeBranch(kbEnv);
  const gitEnv = _buildKbGitEnv(ref, kbEnv);
  const runIn = (cwd, args, timeout = 60_000) =>
    execFileSync("git", args, { cwd, env: gitEnv, stdio: "pipe", timeout }).toString();
  try {
    if (!fs.existsSync(path.join(clonePath, ".git"))) {
      fs.mkdirSync(KNOWLEDGE_CLONE_ROOT, { recursive: true });
      execFileSync("git", ["clone", "--branch", branch, "--", ref.url, clonePath], {
        env: gitEnv, stdio: "pipe", timeout: 120_000,
      });
    } else {
      runIn(clonePath, ["fetch", "origin", branch], 30_000);
      runIn(clonePath, ["reset", "--hard", `origin/${branch}`], 30_000);
    }
    const now = Date.now();
    _kbRefreshThrottles.set(teamId, now);
    // Post-KB-change digest fan-out (Memory/Knowledge unification, Phase 1):
    // every KB change funnels through this refresh, so regenerating here keeps
    // knowledge-digest.md current in every materialized agent workspace — the
    // transparency guarantee for a human browsing between invocations. Cheap +
    // content-diffed, so read-triggered refreshes cost nothing.
    try { fanOutKnowledgeDigests(teamId, kbEnv); }
    catch (err) { warnings.push(`knowledge: digest fan-out failed: ${err.message}`); }
    return { refreshedAt: now, warnings };
  } catch (err) {
    const detail = agentGitOps
      .sanitizeGitOutput((err.stderr || err.stdout || err.message || "").toString())
      .slice(0, 200);
    warnings.push(`knowledge: canonical clone refresh failed for '${teamId}': ${detail}`);
    return { refreshedAt: null, warnings };
  }
}

// Regenerate knowledge-digest.md for every materialized agent of a team from
// the freshly-refreshed canonical clone. The banner timestamp changes on every
// build, so the comparison strips the `> Generated:` line — only a real content
// change rewrites the file (and mirrors it into an isolated agent's volume).
// Best-effort per agent: one broken workspace never blocks the rest.
function _digestComparable(md) {
  return String(md).split("\n").filter((l) => !l.startsWith("> Generated:")).join("\n");
}

function fanOutKnowledgeDigests(teamId, env) {
  env = teamKnowledgeEnv(teamId, env); // #570: per-team knowledge config
  const clonePath = knowledgeFeed.canonicalClonePath(KNOWLEDGE_CLONE_ROOT, teamId);
  if (!clonePath || !fs.existsSync(path.join(clonePath, ".git"))) return;
  const storeRoot = path.join(clonePath, _kbStoreRel(env));
  const { markdown } = buildKnowledgeDigest({
    teamId,
    generatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    entries: readKbStoreEntries(storeRoot),
  });
  for (const id of listAgentIds()) {
    try {
      const cfg = loadAgentConfig(id);
      if (!cfg || agentKnowledgeTeamId(cfg) !== teamId) continue;
      // Materialized, KB-provisioned agents only — a stub has no workspace,
      // and an agent without a checkout has no digest import in its CLAUDE.md.
      if (!fs.existsSync(path.join(agentDir(id), "knowledge", ".git"))) continue;
      const target = path.join(agentDir(id), KNOWLEDGE_DIGEST_FILENAME);
      let prev = null;
      try { prev = fs.readFileSync(target, "utf8"); } catch { /* first write */ }
      if (prev !== null && _digestComparable(prev) === _digestComparable(markdown)) continue;
      const tmp = target + ".tmp";
      fs.writeFileSync(tmp, markdown);
      fs.renameSync(tmp, target);
      // Mirror into a per-agent dedicated volume (no-op unless isolated + running).
      reseedAgent(id, [KNOWLEDGE_DIGEST_FILENAME]).catch(() => { /* best effort */ });
    } catch (err) {
      console.warn(`[Orchestrator] knowledge digest fan-out for ${id}: ${err.message}`);
    }
  }
}

// Append lean harvest/promotion events to the live-feed file the admin-console
// tails. Best-effort — a failure never breaks a push.
function appendKnowledgeEvents(events) {
  if (!Array.isArray(events) || events.length === 0) return;
  try {
    fs.mkdirSync(KNOWLEDGE_EVENTS_DIR, { recursive: true });
    const lines = events.map((e) => knowledgeFeed.serializeEvent(e)).join("\n") + "\n";
    fs.appendFileSync(KNOWLEDGE_EVENTS_FILE, lines);
  } catch (err) {
    console.warn(`[Orchestrator] knowledge feed append failed: ${err.message}`);
  }
}

// After a successful KB push: (a) refresh the team's canonical clone so the
// operator view is fresh, and (b) append one harvest event per pushed entry
// (count-only if the CLI sent no summary). Resolves teamId from the agent config.
function emitKnowledgeHarvest(id, cfg, env, rawBody) {
  const teamId = agentKnowledgeTeamId(cfg);
  env = teamKnowledgeEnv(teamId, env); // #570: per-team knowledge config
  const repoRef = env?.knowledgeStore?.repoRef || null;
  try {
    refreshKnowledgeClone(teamId, { force: true, repoRef, env });
  } catch (err) {
    console.warn(`[Orchestrator] knowledge clone refresh (post-push) failed: ${err.message}`);
  }
  const ts = new Date().toISOString();
  const entries = knowledgeFeed.parsePushEntries(rawBody);
  const events = entries.length > 0
    ? entries.map((entry) => knowledgeFeed.buildHarvestEvent({ teamId, agentId: id, entry, ts }))
    : [knowledgeFeed.buildHarvestEvent({ teamId, agentId: id, ts })];
  appendKnowledgeEvents(events);

  // Phase 3: grow convergence[] across agents + raise promotion suggestions.
  // #855: async fire-and-forget — the pass is best-effort and no longer blocks.
  runConvergenceCollector(teamId, env)
    .catch((err) => console.warn(`[Orchestrator] convergence collector for '${teamId}' failed: ${err.message}`));
}

// ── Convergence collector (Shared Agent Learning, Phase 3) ───────────────────
// Runs after every KB push, on the freshly-refreshed canonical clone (the only
// cross-agent read). It (1) projects all per-agent shards into the single-writer
// canonical <kind>.jsonl — growing convergence[] and writing status:"merged"
// tombstones, never touching a shard — and (2) at autonomy >= 2 raises batched
// promotion suggestions for clusters that cross the convergence threshold. All
// git ops are synchronous (execFileSync), so overlapping pushes serialize on the
// event loop — no explicit mutex needed. Best-effort throughout: a failure never
// breaks the push. See docs/knowledge-convergence.md §2.

function _kbStoreRel(env) {
  const p = env?.knowledgeStore?.path;
  return (typeof p === "string" && p.trim() ? p : "docs/agent-knowledge/").replace(/^\/+|\/+$/g, "");
}

function _loadCloneManifest(storeRoot) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(storeRoot, "knowledge.manifest.json"), "utf8"));
    if (m && typeof m === "object" && m.kinds && typeof m.kinds === "object") return m;
  } catch { /* fall through to default */ }
  return buildDefaultManifest();
}

// Read every agent shard from the canonical clone (tolerant-parsed).
function _readCloneShards(storeRoot, manifest) {
  const out = [];
  for (const kind of KNOWLEDGE_KINDS) {
    let dir;
    try { dir = path.dirname(kindFilePath(manifest, kind)); } catch { continue; }
    const shardsDir = path.join(storeRoot, dir, "shards");
    let names = [];
    try { names = fs.readdirSync(shardsDir).filter((n) => n.endsWith(".jsonl")); } catch { continue; }
    for (const name of names) {
      let raw;
      try { raw = fs.readFileSync(path.join(shardsDir, name), "utf8"); } catch { continue; }
      for (const line of raw.split("\n")) {
        const e = parseKnowledgeEntry(line);
        if (e) out.push(e);
      }
    }
  }
  return out;
}

function _candidatesPath(teamId) {
  const seg = knowledgeFeed.safeTeamSegment(teamId);
  if (!seg) return null;
  return path.join(KNOWLEDGE_SUGGESTIONS_DIR, `${seg}.json`);
}

function readKnowledgeCandidates(teamId) {
  const p = _candidatesPath(teamId);
  if (!p) return [];
  try {
    const arr = JSON.parse(fs.readFileSync(p, "utf8"));
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

function writeKnowledgeCandidates(teamId, list) {
  const p = _candidatesPath(teamId);
  if (!p) return;
  fs.mkdirSync(KNOWLEDGE_SUGGESTIONS_DIR, { recursive: true });
  fs.writeFileSync(p, JSON.stringify(Array.isArray(list) ? list : [], null, 2));
}

function _archivedPath(teamId) {
  const seg = knowledgeFeed.safeTeamSegment(teamId);
  if (!seg) return null;
  return path.join(KNOWLEDGE_ARCHIVED_DIR, `${seg}.json`);
}

function readArchivedIds(teamId) {
  const p = _archivedPath(teamId);
  if (!p) return [];
  try {
    const arr = JSON.parse(fs.readFileSync(p, "utf8"));
    return Array.isArray(arr) ? arr.filter((x) => typeof x === "string") : [];
  } catch { return []; }
}

function writeArchivedIds(teamId, list) {
  const p = _archivedPath(teamId);
  if (!p) return;
  fs.mkdirSync(KNOWLEDGE_ARCHIVED_DIR, { recursive: true });
  fs.writeFileSync(p, JSON.stringify([...new Set(Array.isArray(list) ? list : [])], null, 2));
}

// Per-team operator validity windows (#916): a map { <canonicalId>: { validTo?,
// supersededBy? } }. Same shared-volume JSON-per-team pattern as the archived-id
// set; overlaid as fields (never a status) at each canonical re-projection.
function _validityPath(teamId) {
  const seg = knowledgeFeed.safeTeamSegment(teamId);
  if (!seg) return null;
  return path.join(KNOWLEDGE_VALIDITY_DIR, `${seg}.json`);
}

function readKnowledgeValidity(teamId) {
  const p = _validityPath(teamId);
  if (!p) return {};
  try {
    const obj = JSON.parse(fs.readFileSync(p, "utf8"));
    return obj && typeof obj === "object" && !Array.isArray(obj) ? obj : {};
  } catch { return {}; }
}

function writeKnowledgeValidity(teamId, map) {
  const p = _validityPath(teamId);
  if (!p) return;
  fs.mkdirSync(KNOWLEDGE_VALIDITY_DIR, { recursive: true });
  fs.writeFileSync(p, JSON.stringify(map && typeof map === "object" ? map : {}, null, 2));
}

// Per-team curation-health record (#919) — sibling file of the candidate store
// (<team>.health.json). Written by the nightly decay/health pass; served
// read-only to the admin console's health strip.
function _curationHealthPath(teamId) {
  const seg = knowledgeFeed.safeTeamSegment(teamId);
  if (!seg) return null;
  return path.join(KNOWLEDGE_SUGGESTIONS_DIR, `${seg}.health.json`);
}

function readCurationHealth(teamId) {
  const p = _curationHealthPath(teamId);
  if (!p) return null;
  try {
    const obj = JSON.parse(fs.readFileSync(p, "utf8"));
    return obj && typeof obj === "object" && !Array.isArray(obj) ? obj : null;
  } catch { return null; }
}

function writeCurationHealth(teamId, health) {
  const p = _curationHealthPath(teamId);
  if (!p) return;
  fs.mkdirSync(KNOWLEDGE_SUGGESTIONS_DIR, { recursive: true });
  fs.writeFileSync(p, JSON.stringify(health, null, 2));
}

// Tolerant read of the whole live feed (the health counter needs the harvest
// history; the file is bounded in practice and this runs once per backstop).
function _readFeedEvents() {
  let raw;
  try { raw = fs.readFileSync(KNOWLEDGE_EVENTS_FILE, "utf8"); } catch { return []; }
  const out = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const obj = JSON.parse(t);
      if (obj && typeof obj === "object") out.push(obj);
    } catch { /* keep going — one bad line never hides the history */ }
  }
  return out;
}

// #919 nightly decay sweep + curation-health refresh for one team. Runs inside
// the curator backstop AFTER the collector pass (so the canonical clone and
// candidate store are fresh). PROPOSES only: stale entries become
// `source:"decay"` cards in the existing suggestion store; confirming a card in
// the UI runs the exact same archive path as the manual Retire button. Best-
// effort — any failure is logged, never thrown into the backstop loop.
function runTeamDecaySweep(teamId) {
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const resolved = resolveTeamKbRepo(teamId);
  const rawEnv = resolved ? resolved.env : null;
  const env = teamKnowledgeEnv(teamId, rawEnv); // #570: per-team knowledge config
  const horizonDays = resolveDecayHorizonDays(env);

  let raised = 0;
  const clonePath = knowledgeFeed.canonicalClonePath(KNOWLEDGE_CLONE_ROOT, teamId);
  if (clonePath && fs.existsSync(path.join(clonePath, ".git"))) {
    const storeRoot = path.join(clonePath, _kbStoreRel(env));
    const rawEntries = readKbStoreEntries(storeRoot);
    const candidates = readKnowledgeCandidates(teamId);
    const plan = knowledgeDecay.planDecaySuggestions({
      // post-fold: merged/archived/pending/rejected/expired (#916) already gone
      entries: foldVisibleEntries(rawEntries, now),
      retrieval: readRetrievalStats(teamId),
      includedIds: buildKnowledgeDigest({ teamId, generatedAt: now, entries: rawEntries }).includedIds,
      candidates,
      horizonDays,
      now,
    });
    if (plan.raise.length) {
      writeKnowledgeCandidates(teamId, [...candidates, ...plan.raise]);
      if (plan.batch) appendKnowledgeEvents([plan.batch]);
      raised = plan.raise.length;
    }
  }

  // Curation health (the Gap-3 silent-convergence monitor) — computed even when
  // no clone exists yet; one `curation-health` feed event per state TRANSITION.
  const health = knowledgeDecay.computeCurationHealth({
    candidates: readKnowledgeCandidates(teamId),
    events: _readFeedEvents(),
    teamId,
    now,
  });
  const transition = knowledgeDecay.planHealthTransition(readCurationHealth(teamId), health, { teamId, now });
  writeCurationHealth(teamId, health);
  if (transition) appendKnowledgeEvents([transition]);
  return { raised, health: health.status };
}

// ── #918 embedding backend + per-team vector cache ──────────────────────────
// The backend is a lazy singleton (model loads on first embed, only in the
// backstop). A load failure (library/model absent) downgrades to unavailable
// once, logged once — never an error loop, never on the push path.
let _embeddingBackend = null;
let _embeddingWarned = false;
function getEmbeddingBackend() {
  if (_embeddingBackend === null) {
    _embeddingBackend = knowledgeEmbeddings.createEmbeddingBackend({});
  }
  return _embeddingBackend;
}

function _vectorsPath(teamId) {
  const seg = knowledgeFeed.safeTeamSegment(teamId);
  if (!seg) return null;
  return path.join(KNOWLEDGE_VECTORS_DIR, `${seg}.jsonl`);
}

function readVectorCache(teamId) {
  const p = _vectorsPath(teamId);
  if (!p) return [];
  try { return knowledgeEmbeddings.parseVectorCache(fs.readFileSync(p, "utf8")); } catch { return []; }
}

function writeVectorCache(teamId, rows) {
  const p = _vectorsPath(teamId);
  if (!p) return;
  fs.mkdirSync(KNOWLEDGE_VECTORS_DIR, { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, knowledgeEmbeddings.serializeVectorCache(rows));
  fs.renameSync(tmp, p);
}

// The `semantic` clustering context (#918) for one projection run: vectors from
// the team's cache whose contentHash still matches the entry's current text,
// plus the per-team cosine threshold. Null when the cache holds nothing usable
// — the seam then runs bit-for-bit lexical-only, zero overhead.
function teamSemanticCtx(teamId, entries, env) {
  try {
    const vectors = knowledgeEmbeddings.buildVectorLookup(readVectorCache(teamId), entries);
    if (!vectors) return null;
    const { cosineThreshold } = knowledgeConvergenceConfig(env);
    return { vectors, cosineThreshold };
  } catch { return null; }
}

// Nightly backstop embedding pass (#918): (re-)embed entries whose contentHash
// is missing/stale, prune vectors of vanished ids. NEVER on the push path — a
// freshly pushed entry matches lexically immediately and semantically after
// this pass (the backstop re-runs the collector right after, idempotent via
// stableSuggestionId). Best-effort throughout.
async function runTeamEmbeddingPass(teamId) {
  const backend = getEmbeddingBackend();
  if (!backend.available) return { embedded: 0, skipped: backend.reason };
  const clonePath = knowledgeFeed.canonicalClonePath(KNOWLEDGE_CLONE_ROOT, teamId);
  if (!clonePath || !fs.existsSync(path.join(clonePath, ".git"))) return { embedded: 0, skipped: "no-clone" };
  const resolved = resolveTeamKbRepo(teamId);
  const env = teamKnowledgeEnv(teamId, resolved ? resolved.env : null);
  const storeRoot = path.join(clonePath, _kbStoreRel(env));
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const entries = foldVisibleEntries(readKbStoreEntries(storeRoot), now);
  const cache = readVectorCache(teamId);
  const plan = knowledgeEmbeddings.planEmbeddingPass({ entries, cache });
  if (plan.toEmbed.length === 0 && plan.pruned === 0) return { embedded: 0, skipped: null };
  let fresh = [];
  if (plan.toEmbed.length > 0) {
    try {
      const vectors = await backend.embed(plan.toEmbed.map((e) => e.text));
      fresh = plan.toEmbed
        .map((e, i) => ({ id: e.id, contentHash: e.contentHash, vector: vectors[i] }))
        .filter((r) => Array.isArray(r.vector) && r.vector.length > 0);
    } catch (err) {
      if (!_embeddingWarned) {
        _embeddingWarned = true;
        console.warn(`[Orchestrator] embedding backend failed (semantic convergence stays off): ${err.message}`);
      }
      return { embedded: 0, skipped: "backend-error" };
    }
  }
  writeVectorCache(teamId, [...plan.keep, ...fresh]);
  return { embedded: fresh.length, pruned: plan.pruned, skipped: null };
}

// Per-team read-side retrieval aggregate (#915) — same shared-volume JSON-per-
// team pattern. Written atomically (tmp+rename): the emitters are fire-and-
// forget, so a torn read must never be possible.
function _retrievalPath(teamId) {
  const seg = knowledgeFeed.safeTeamSegment(teamId);
  if (!seg) return null;
  return path.join(KNOWLEDGE_RETRIEVAL_DIR, `${seg}.json`);
}

function readRetrievalStats(teamId) {
  const p = _retrievalPath(teamId);
  if (!p) return { since: null, entries: {} };
  try {
    const obj = JSON.parse(fs.readFileSync(p, "utf8"));
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      return { since: typeof obj.since === "string" ? obj.since : null, entries: obj.entries && typeof obj.entries === "object" ? obj.entries : {} };
    }
  } catch { /* fresh */ }
  return { since: null, entries: {} };
}

function recordKnowledgeRetrieval(teamId, report) {
  const p = _retrievalPath(teamId);
  if (!p) throw new Error("invalid teamId");
  const next = knowledgeRetrieval.applyRetrieval(readRetrievalStats(teamId), report);
  fs.mkdirSync(KNOWLEDGE_RETRIEVAL_DIR, { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next));
  fs.renameSync(tmp, p);
  return { entries: report.entryIds.length, source: report.source };
}

// Per-team operator auto-load triggers (#917): { <canonicalId>: loadTriggers[] }.
// Same shared-volume JSON-per-team pattern as the validity sidecar; applied as
// a field at each canonical re-projection so the agent-side scoped resolver
// reads them straight off the canonical clone.
function _triggersPath(teamId) {
  const seg = knowledgeFeed.safeTeamSegment(teamId);
  if (!seg) return null;
  return path.join(KNOWLEDGE_TRIGGERS_DIR, `${seg}.json`);
}

function readKnowledgeTriggers(teamId) {
  const p = _triggersPath(teamId);
  if (!p) return {};
  try {
    const obj = JSON.parse(fs.readFileSync(p, "utf8"));
    return obj && typeof obj === "object" && !Array.isArray(obj) ? obj : {};
  } catch { return {}; }
}

function writeKnowledgeTriggers(teamId, map) {
  const p = _triggersPath(teamId);
  if (!p) return;
  fs.mkdirSync(KNOWLEDGE_TRIGGERS_DIR, { recursive: true });
  fs.writeFileSync(p, JSON.stringify(map && typeof map === "object" ? map : {}, null, 2));
}

// Set / clear a canonical KB entry's auto-load triggers (#917, operator-
// initiated via the item card). Empty/invalid list clears. Re-projects like the
// validity setter so the canonical clone — the file the Python resolver reads —
// carries the field immediately. Best-effort on the git side.
function setKnowledgeTriggers(teamId, id, loadTriggers) {
  if (!/^[0-9a-f]{12}$/.test(id)) throw new Error("invalid id");
  const clean = normalizeLoadTriggers(loadTriggers);
  const map = readKnowledgeTriggers(teamId);
  if (clean) map[id] = clean; else delete map[id];
  writeKnowledgeTriggers(teamId, map);
  let env = null;
  const resolved = resolveTeamKbRepo(teamId);
  if (resolved) env = resolved.env;
  try {
    refreshKnowledgeClone(teamId, { force: true, env });
    runConvergenceCollector(teamId, env) // #855: async, non-blocking
      .catch((err) => console.warn(`[Orchestrator] triggers re-projection for '${teamId}' failed: ${err.message}`));
  } catch (err) {
    console.warn(`[Orchestrator] triggers re-projection for '${teamId}' failed: ${err.message}`);
  }
  return { id, loadTriggers: clean || [] };
}

// Per-team operator review decisions for supervised-review mode: a map
// { <canonicalId>: "approved" | "rejected" }. Same shared-volume JSON-per-team
// pattern as the archived-id set. An id absent from the map is "pending" while
// the team runs in review mode (knowledgeReview). Overlaid onto the canonical
// <kind>.jsonl each collector pass (§ runConvergenceCollector), so a decision is
// durable across re-projections and shards (the source of truth) stay untouched.
function _reviewPath(teamId) {
  const seg = knowledgeFeed.safeTeamSegment(teamId);
  if (!seg) return null;
  return path.join(KNOWLEDGE_REVIEW_DIR, `${seg}.json`);
}

function readReviewDecisions(teamId) {
  const p = _reviewPath(teamId);
  if (!p) return {};
  try {
    const obj = JSON.parse(fs.readFileSync(p, "utf8"));
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {};
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (/^[0-9a-f]{12}$/.test(k) && (v === "approved" || v === "rejected")) out[k] = v;
    }
    return out;
  } catch { return {}; }
}

function writeReviewDecisions(teamId, decisions) {
  const p = _reviewPath(teamId);
  if (!p) return;
  fs.mkdirSync(KNOWLEDGE_REVIEW_DIR, { recursive: true });
  fs.writeFileSync(p, JSON.stringify(decisions && typeof decisions === "object" ? decisions : {}, null, 2));
}

// Grandfather the knowledge a team already shares when review mode is switched
// ON: mark every existing canonical id "approved" (unless already decided) so
// turning review on holds only NEW learnings, never retroactively yanks facts the
// team already relies on out of the KB. Mirrors the github-poller's "first poll
// re-baselines, no flood" discipline. Best-effort — a failure just means the next
// collector pass treats existing entries as pending (safe, if noisier).
function baselineReviewApprovals(teamId, env) {
  env = teamKnowledgeEnv(teamId, env); // #570: per-team knowledge config
  try {
    refreshKnowledgeClone(teamId, { force: true, env });
    const clonePath = knowledgeFeed.canonicalClonePath(KNOWLEDGE_CLONE_ROOT, teamId);
    let shardEntries = [];
    if (clonePath && fs.existsSync(path.join(clonePath, ".git"))) {
      const storeRel = _kbStoreRel(env);
      const storeRoot = storeRel ? path.join(clonePath, storeRel) : clonePath;
      const manifest = _loadCloneManifest(storeRoot);
      // #603: scope to this team's squad — the shared KB branch can hold co-tenant
      // teams' shards, and grandfathering must approve only this team's own ids.
      shardEntries = knowledgeConvergence.filterEntriesToTeam(
        _readCloneShards(storeRoot, manifest),
        teamSquadMemberIds(teamId),
      );
    }
    // No canonical clone (yet): baseline from the team agents' local checkouts
    // instead, so flipping review on still grandfathers everything already
    // learned — an un-synced KB must not flood the queue with old facts.
    if (shardEntries.length === 0) {
      for (const id of listAgentIds()) {
        const cfg = loadAgentConfig(id);
        if (!cfg || agentKnowledgeTeamId(cfg) !== teamId) continue;
        const agentEnv = cfg.environmentId ? loadEnvironment(cfg.environmentId) : env;
        const storeRoot = path.join(agentDir(id), "knowledge", _kbStoreRel(agentEnv));
        if (!fs.existsSync(storeRoot)) continue;
        shardEntries.push(..._readCloneShards(storeRoot, _loadCloneManifest(storeRoot)));
      }
    }
    if (shardEntries.length === 0) return;
    const { simThreshold } = knowledgeConvergenceConfig(env);
    const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    const proj = knowledgeConvergence.buildCanonicalProjection(shardEntries, {
      simThreshold, semantic: teamSemanticCtx(teamId, shardEntries, env), now,
    });
    const decisions = readReviewDecisions(teamId);
    for (const kind of KNOWLEDGE_KINDS) {
      const bucket = proj.byKind[kind];
      if (!bucket) continue;
      for (const e of bucket.canonical) {
        if (!decisions[e.id]) decisions[e.id] = "approved";
      }
    }
    // Belt-and-braces: approve the raw entry ids too — when the canonical
    // projection later merges differently, an already-learned entry still never
    // lands in the review queue.
    for (const e of shardEntries) {
      if (e && e.id && !decisions[e.id]) decisions[e.id] = "approved";
    }
    writeReviewDecisions(teamId, decisions);
  } catch (err) {
    console.warn(`[Orchestrator] review baseline for '${teamId}' failed: ${err.message}`);
  }
}

// Record an operator's approve/reject on one canonical KB entry (supervised
// review), then re-project + commit so the overlay is reflected + git-audited.
// decision ∈ "approved" | "rejected" | "reset" (reset drops the decision, back to
// pending). Best-effort on the git side, mirroring archiveKnowledgeEntry.
function reviewKnowledgeEntry(teamId, id, decision) {
  if (!/^[0-9a-f]{12}$/.test(id)) throw new Error("invalid id");
  if (!["approved", "rejected", "reset"].includes(decision)) throw new Error("invalid decision");
  let env = null;
  const resolved = resolveTeamKbRepo(teamId);
  if (resolved) env = resolved.env;
  const decisions = readReviewDecisions(teamId);
  if (decision === "reset") delete decisions[id];
  else decisions[id] = decision;
  writeReviewDecisions(teamId, decisions);
  try {
    refreshKnowledgeClone(teamId, { force: true, env });
    // #855: async, non-blocking — the response (below) no longer waits on the
    // curator LLM synthesis; the re-projection commits in the background.
    runConvergenceCollector(teamId, env)
      .catch((err) => console.warn(`[Orchestrator] review re-projection for '${teamId}' failed: ${err.message}`));
  } catch (err) {
    console.warn(`[Orchestrator] review re-projection for '${teamId}' failed: ${err.message}`);
  }
  return { id, decision };
}

// Push the canonical-file commit to the team's KB branch, fetch-rebase-retry
// (clean — the orchestrator only ever writes canonical files, never a shard).
function _pushKnowledgeClone(clonePath, gitEnv, branch = knowledgeSync.KNOWLEDGE_BRANCH) {
  const run = (args, timeout = 30_000) =>
    execFileSync("git", args, { cwd: clonePath, env: gitEnv, stdio: "pipe", timeout }).toString();
  let lastErr = "";
  for (let attempt = 1; attempt <= knowledgeSync.MAX_PUSH_RETRIES; attempt++) {
    try {
      run(["fetch", "origin", branch]);
      run(["rebase", `origin/${branch}`]);
    } catch {
      try { run(["rebase", "--abort"]); } catch { /* nothing to abort */ }
    }
    try {
      run(["push", "origin", branch]);
      return;
    } catch (err) {
      lastErr = agentGitOps.sanitizeGitOutput((err.stderr || err.stdout || err.message || "").toString());
      if (!knowledgeSync.isRetryablePushError(lastErr)) break;
    }
  }
  throw new Error(`knowledge canonical push failed: ${String(lastErr).trim().slice(0, 200)}`);
}

async function runConvergenceCollector(teamId, envArg, opts = {}) {
  // #570: overlay the team's per-team knowledge config BEFORE reading repoRef, so
  // the repoRef used to build the push credentials and the branch resolved below
  // both come from the team's store — never a mix of the env's repoRef and the
  // team's branch when a team points its storage at its own repo.
  let env = teamKnowledgeEnv(teamId, envArg || null);
  let repoRef = env?.knowledgeStore?.repoRef || null;
  if (!repoRef) {
    const resolved = resolveTeamKbRepo(teamId);
    if (!resolved) return; // no KB repo → nothing to collect
    repoRef = resolved.repoRef;
    env = resolved.env; // resolveTeamKbRepo already overlaid the team's config
  }
  // Level 0 has no KB at all; convergence-grow is a level >= 1 behaviour.
  if (knowledgeAutonomyLevel(env) < 1) return;

  const clonePath = knowledgeFeed.canonicalClonePath(KNOWLEDGE_CLONE_ROOT, teamId);
  if (!clonePath || !fs.existsSync(path.join(clonePath, ".git"))) return; // refresh makes it; nothing yet

  const storeRel = _kbStoreRel(env);
  const storeRoot = storeRel ? path.join(clonePath, storeRel) : clonePath;
  const manifest = _loadCloneManifest(storeRoot);
  // #603: a shared `agent-knowledge` branch means this clone can hold co-tenant
  // teams' shards — scope the clustering input to this team's squad before
  // projecting, so the canonical merge, candidate store, suggestions and
  // auto-promotion all operate on team-owned knowledge only.
  const shardEntries = knowledgeConvergence.filterEntriesToTeam(
    _readCloneShards(storeRoot, manifest),
    teamSquadMemberIds(teamId),
  );
  if (shardEntries.length === 0) return;

  const { simThreshold, convergenceThreshold, relatedThreshold } = knowledgeConvergenceConfig(env);
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  // #918: the semantic clustering context — backstop-computed vectors, or null
  // (bit-for-bit lexical) when no cache exists. Never blocks the push path.
  const proj = knowledgeConvergence.buildCanonicalProjection(shardEntries, {
    simThreshold, semantic: teamSemanticCtx(teamId, shardEntries, env), now,
  });

  // Read the candidate store once — it drives both the promoted-status overlay on
  // the canonical files (Phase 4 git audit) and the suggestion / auto-promotion
  // steps below.
  const candidates = readKnowledgeCandidates(teamId);
  // Canonical ids a promotion (operator level-2 OR curator level-3, from THIS or a
  // prior pass) marked promoted. Overlaid onto the freshly-projected canonical
  // entries so status:"promoted" is durable in git across re-projections
  // (buildCanonicalProjection reads shards, which always carry status "active").
  // A multi-lesson (related-theme / manual-combine) candidate spans SEVERAL
  // canonical entries — its entryIds, not just the lead canonicalId — so the
  // overlay unions both. Extra member ids that only exist as tombstones are
  // harmless: the overlay below matches canonical entries by id.
  const promotedCanonicalIds = new Set(
    candidates
      .filter((c) => c && c.status === "promoted")
      .flatMap((c) => [c.canonicalId, ...(Array.isArray(c.entryIds) ? c.entryIds : [])])
      .filter(Boolean),
  );
  // Canonical ids the operator archived (Phase 4 non-destructive curation) — the
  // same durable-overlay pattern as promoted, so an archive survives re-projection.
  const archivedCanonicalIds = new Set(readArchivedIds(teamId));
  // Operator-set validity windows (#916) — same durable-sidecar pattern, applied
  // as fields (not a status) in _serializeCanonicalKind.
  const validityOverlay = readKnowledgeValidity(teamId);
  // Operator-set auto-load triggers (#917) — same pattern.
  const triggersOverlay = readKnowledgeTriggers(teamId);

  // Supervised-review overlay: when review mode is on, a canonical entry the
  // operator has not yet approved is stamped status:"pending" (held out of the
  // curated KB) and a rejected one status:"rejected". Empty when review is off ⇒
  // no overlay ⇒ byte-identical projection (idempotent, no git churn). The held
  // set also gates the downstream suggestion/promotion steps below, so un-reviewed
  // knowledge can never become a skill.
  const reviewOn = knowledgeReviewEnabled(env);
  const reviewDecisions = reviewOn ? readReviewDecisions(teamId) : {};
  const pendingCanonicalIds = new Set();
  const rejectedCanonicalIds = new Set();
  if (reviewOn) {
    for (const kind of KNOWLEDGE_KINDS) {
      const bucket = proj.byKind[kind];
      if (!bucket) continue;
      for (const e of bucket.canonical) {
        const d = reviewDecisions[e.id];
        if (d === "rejected") rejectedCanonicalIds.add(e.id);
        else if (d !== "approved") pendingCanonicalIds.add(e.id);
      }
    }
  }
  const heldCanonicalIds = new Set([...pendingCanonicalIds, ...rejectedCanonicalIds]);

  // Human-readable summaries (#635) are a real field on the canonical entry, git-
  // persisted — NOT a sidecar. buildCanonicalProjection reads shards (which never
  // carry a summary), so a summary must be CARRIED FORWARD across re-projection:
  // read the prior canonical files (still on disk from the last push / the refresh
  // reset) and re-apply each entry's summary — but ONLY when the freshly-projected
  // text is unchanged, so an entry whose text changed drops its stale summary and
  // gets regenerated on the next backfill (AC5). `extraSummaries` (backfill's
  // freshly-generated map) wins and is trusted for the CURRENT text. Empty extra +
  // no prior summaries ⇒ no summary field emitted ⇒ byte-identical projection.
  const priorSummaries = _readCanonicalSummaries(storeRoot, manifest);
  const extraSummaries = _normalizeSummaryMap(opts && opts.extraSummaries);
  const resolvedSummaries = new Map();
  for (const kind of KNOWLEDGE_KINDS) {
    const bucket = proj.byKind[kind];
    if (!bucket) continue;
    for (const e of bucket.canonical) {
      if (extraSummaries.has(e.id)) {
        resolvedSummaries.set(e.id, extraSummaries.get(e.id));
      } else {
        const prev = priorSummaries.get(e.id);
        if (prev && prev.summary && prev.text === e.text) resolvedSummaries.set(e.id, prev.summary);
      }
    }
  }

  // Write the canonical <kind>.jsonl files (single-writer merged view), applying
  // the promoted/archived/review-status overlay. Byte-identical to proj.lines when
  // all overlays are empty, so idempotency (no spurious git churn) is preserved.
  for (const kind of KNOWLEDGE_KINDS) {
    const bucket = proj.byKind[kind];
    if (!bucket) continue;
    let rel;
    try { rel = kindFilePath(manifest, kind); } catch { continue; }
    const file = path.join(storeRoot, rel);
    const lines = _serializeCanonicalKind(bucket, promotedCanonicalIds, archivedCanonicalIds, {
      pendingIds: pendingCanonicalIds, rejectedIds: rejectedCanonicalIds, summaries: resolvedSummaries,
      validity: validityOverlay, triggers: triggersOverlay,
    });
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, lines.length ? lines.join("\n") + "\n" : "");
    } catch (err) {
      console.warn(`[Orchestrator] convergence: writing ${rel} failed: ${err.message}`);
    }
  }

  // Commit + push only when the canonical projection actually changed (idempotent
  // → no spurious churn on a re-run over unchanged shards).
  const gitEnv = _buildKbGitEnv(repoRef, env);
  const runIn = (args, timeout = 30_000) =>
    execFileSync("git", args, { cwd: clonePath, env: gitEnv, stdio: "pipe", timeout }).toString();
  try {
    const relPath = storeRel || ".";
    const status = runIn(["status", "--porcelain", "--", relPath]).trim();
    if (status) {
      runIn(["add", "--", relPath]);
      runIn([
        "-c", "user.name=Agent Studio", "-c", "user.email=knowledge@agents.local",
        "commit", "-m", `chore(knowledge): converge canonical facts for ${teamId}`,
      ]);
      _pushKnowledgeClone(clonePath, gitEnv, knowledgeSync.resolveKnowledgeBranch(env));
    }
  } catch (err) {
    console.warn(`[Orchestrator] convergence commit/push for '${teamId}' failed: ${err.message}`);
  }

  // Level 3 ("Auto-curate"): the curator auto-promotes converged clusters within
  // the gate policy and defers the rest to review cards. Level 2 ("Suggest"):
  // raise convergence cards only. Level 1: nothing more (merge already done).
  //
  // Supervised-review gate: a held (pending/rejected) cluster is NOT eligible for
  // a suggestion or an auto-promotion — un-reviewed knowledge must never become a
  // skill. Filtering the clusters here (rather than deep in the pure planners)
  // keeps review a single, understandable choke-point.
  const eligibleClusters = heldCanonicalIds.size === 0
    ? proj.clusters
    : proj.clusters.filter((c) => c && !heldCanonicalIds.has(c.canonicalId));
  const level = knowledgeAutonomyLevel(env);

  // #779 digest-only routing: at the candidate-raising levels (>= 2), a single
  // converged convention/fact the knowledge digest already delivers raises NO skill
  // candidate/card until it graduates (>= graduateAtAgents distinct agents). The
  // decision is persisted (status:"digest-only" — never an open card) and surfaced
  // as a low-key `digest-routing` feed event, so it is auditable rather than silent.
  // Digest-only clusters are pulled ONLY from the single-cluster candidate/auto-
  // promotion path (candidateClusters); they stay in the THEME path (eligibleClusters)
  // so a growing set can still surface as a theme. The escape hatches (agent
  // `knowledge promote`, manual combine) run on other code paths, never here.
  let candidateClusters = eligibleClusters;
  let curCandidates = candidates;
  // #780: canonicalIds routed to a domain (amendment) or parked unrouted this pass —
  // excluded from the single-lesson candidate path so they don't also raise a card.
  let domainRoutedCanonicalIds = new Set();
  if (level >= 2) {
    const { digestRouting, graduateAtAgents } = knowledgeCurationConfig(env);
    if (digestRouting) {
      try {
        const routed = knowledgeConvergence.planDigestRouting(eligibleClusters, curCandidates, {
          threshold: convergenceThreshold, graduateAtAgents, teamId, now,
        });
        candidateClusters = routed.candidateClusters;
        if (routed.rows.length > 0) {
          writeKnowledgeCandidates(teamId, [...curCandidates, ...routed.rows]);
          curCandidates = readKnowledgeCandidates(teamId);
          if (routed.batch) appendKnowledgeEvents([routed.batch]);
        }
      } catch (err) {
        console.warn(`[Orchestrator] digest routing for '${teamId}' failed: ${err.message}`);
        candidateClusters = eligibleClusters;
      }
    }

    // #780 domain routing (skill-aggregation Phase 2): classify each remaining
    // candidate cluster against the team's persistent domains. A cluster that fits
    // a domain becomes an AMENDMENT review card ("Add to <skill>") instead of a new
    // micro-skill; a cluster that fits no domain is parked in the UNROUTED pool and
    // never spawns its own skill — only accumulated mass raises a new-domain
    // proposal (always a review card, budget-aware). Both classes are excluded from
    // the single-lesson candidate + create-new auto-promotion paths below, so the
    // inbox shows a few decidable amendments rather than dozens of new-skill cards.
    // No-op for a team with no confirmed domains (routing bias only kicks in once a
    // taxonomy exists) — existing teams are unaffected until they seed/bootstrap.
    const { domainRouting, skillBudget } = knowledgeCurationConfig(env);
    if (domainRouting) {
      try {
        const domains = ensureTeamDomains(teamId, now);
        if (domains.length > 0 && candidateClusters.length > 0) {
          // entry tags[] (read by nothing before #780) feed the routing heuristic.
          const tagsByEntryId = {};
          for (const e of shardEntries) {
            if (e && e.id && Array.isArray(e.tags) && e.tags.length) tagsByEntryId[e.id] = e.tags;
          }
          domainRoutedCanonicalIds = _routeDomains(teamId, env, domains, candidateClusters, {
            skillBudget, now, tagsByEntryId,
          });
          if (domainRoutedCanonicalIds.size > 0) {
            candidateClusters = candidateClusters.filter(
              (c) => c && !domainRoutedCanonicalIds.has(c.canonicalId),
            );
            curCandidates = readKnowledgeCandidates(teamId);
          }
        }
      } catch (err) {
        console.warn(`[Orchestrator] domain routing for '${teamId}' failed: ${err.message}`);
      }
    }
  }

  // FIX-D step 1: the theme (related-aggregation) path historically ran over the
  // UNFILTERED eligibleClusters, so a cluster already claimed by domain routing
  // re-entered as a brand-new lesson-slug theme micro-skill — the main reason the team
  // accumulated dozens of skills over its ~12 budget. Exclude domain-routed clusters
  // from the theme inputs so that knowledge stays owned by its domain amendment card.
  const themeClusters = domainRoutedCanonicalIds.size > 0
    ? eligibleClusters.filter((c) => c && !domainRoutedCanonicalIds.has(c.canonicalId))
    : eligibleClusters;

  if (level >= 3) {
    // #779: the per-pass cap is shared across auto-extend + convergence promotions +
    // theme promotions. Auto-extend runs FIRST and claims its matched clusters so
    // they don't also spawn a brand-new skill; then create-new promotion on the
    // remaining clusters; then themes. The remaining budget shrinks at each step.
    const { maxAutoPromotionsPerPass, autoExtend } = knowledgeCurationConfig(env);
    let capUsed = 0;
    let consumed = new Set();
    // Auto-extend follows the autonomy dial (level >= 3, so on here) unless the team
    // explicitly toggled it off (autoExtend === false).
    if (autoExtend !== false) {
      try {
        const existingSkills = readTeamSkillsForMatch(teamId);
        const ext = await autoExtendStep(teamId, env, candidateClusters, curCandidates, existingSkills, {
          convergenceThreshold, now, capRemaining: maxAutoPromotionsPerPass - capUsed,
        });
        capUsed += ext.extendedCount;
        consumed = ext.consumedCanonicalIds;
        curCandidates = readKnowledgeCandidates(teamId);
      } catch (err) {
        console.warn(`[Orchestrator] auto-extend for '${teamId}' failed: ${err.message}`);
      }
    }
    try {
      const n = await autoPromoteStep(teamId, env, candidateClusters, curCandidates, {
        convergenceThreshold, now, capRemaining: maxAutoPromotionsPerPass - capUsed, excludeCanonicalIds: consumed,
      });
      capUsed += (n || 0);
    } catch (err) {
      console.warn(`[Orchestrator] auto-promotion for '${teamId}' failed: ${err.message}`);
    }
    // #604: strong single-role accumulation themes are also auto-promoted (and
    // auto-activated) at level 3. Re-read the store: the steps above just rewrote it.
    // #780 AC4: resolve each theme's best-matching domain so it is named after the
    // domain (not a lesson-slug). Read-only — never seeds domains here; when the
    // team has no taxonomy the resolver is null and naming stays lesson-slug (the
    // backward-compatible no-op). Reuses the same heuristic classifier as _routeDomains.
    let resolveThemeDomain = null;
    try {
      const themeDomains = readTeamDomainsDoc(teamId).domains;
      if (themeDomains.length > 0) {
        const existingSkills = readTeamSkillsForMatch(teamId);
        const skillEntryIdsByDomain = {};
        for (const d of themeDomains) {
          const sk = existingSkills.find((s) => s.name === knowledgeDomains.domainSkillName(d));
          if (sk) skillEntryIdsByDomain[d.id] = sk.entryIds;
        }
        const tagsByEntryId = {};
        for (const e of shardEntries) {
          if (e && e.id && Array.isArray(e.tags) && e.tags.length) tagsByEntryId[e.id] = e.tags;
        }
        resolveThemeDomain = (cand) => {
          const m = knowledgeRouting.classifyCandidateToDomain(cand, themeDomains, { skillEntryIdsByDomain, tagsByEntryId });
          return m ? (themeDomains.find((d) => d.id === m.domainId) || null) : null;
        };
      }
    } catch (err) {
      console.warn(`[Orchestrator] theme domain resolver for '${teamId}' failed: ${err.message}`);
    }
    try {
      const n = autoPromoteThemesStep(teamId, env, themeClusters, readKnowledgeCandidates(teamId), {
        relatedThreshold, now, capRemaining: maxAutoPromotionsPerPass - capUsed, resolveDomain: resolveThemeDomain,
      });
      capUsed += (n || 0);
    } catch (err) {
      console.warn(`[Orchestrator] theme auto-promotion for '${teamId}' failed: ${err.message}`);
    }
    // Weaker themes (strongLessons <= lessonCount < autoThemeMinLessons), gated or
    // over-cap themes stay review cards — synthesising a borderline theme into a
    // skill needs judgment. raiseRelatedSuggestions raises only the remainder
    // (planRelatedSuggestions excludes the clusters just auto-promoted above).
    try {
      raiseRelatedSuggestions(teamId, themeClusters, readKnowledgeCandidates(teamId), { relatedThreshold, now });
    } catch (err) {
      console.warn(`[Orchestrator] related-theme suggestions for '${teamId}' failed: ${err.message}`);
    }
    // #781: distil any grown skill that is due (auto path only — review-mode skills
    // wait for an operator Distill action). Runs LAST so it sees this pass's extends.
    try {
      await autoDistillStep(teamId, env, { now });
    } catch (err) {
      console.warn(`[Orchestrator] auto-distill for '${teamId}' failed: ${err.message}`);
    }
  } else if (level >= 2) {
    try {
      // Themes first: a lesson bundled into a raised theme card must not also
      // raise its own single-lesson convergence card (one decision, not two).
      const afterThemes = raiseRelatedSuggestions(teamId, themeClusters, curCandidates, { relatedThreshold, now });
      const covered = knowledgeConvergence.clustersCoveredByThemes(themeClusters, afterThemes);
      // #779: single-cluster candidates are raised only for digest-routed
      // candidateClusters (digest-only clusters excluded), minus theme-covered ones.
      const singles = covered.size === 0
        ? candidateClusters
        : candidateClusters.filter((c) => c && !covered.has(c.canonicalId));
      const { raise, batch } = knowledgeConvergence.planNewSuggestions(singles, afterThemes, {
        threshold: convergenceThreshold,
        teamId,
        now,
      });
      if (raise.length > 0) {
        writeKnowledgeCandidates(teamId, [...afterThemes, ...raise]);
        if (batch) appendKnowledgeEvents([batch]);
      }
    } catch (err) {
      console.warn(`[Orchestrator] convergence suggestions for '${teamId}' failed: ${err.message}`);
    }
  }

  // Suggestion auto-hygiene (#776 §4): move open cards that have gathered no new
  // evidence for N weeks (default 4, configurable) into a `stale` state so they
  // drop out of the default inbox, and revive a stale card whose underlying
  // cluster reappeared this run. Feed-logged for transparency. Idempotent — a run
  // with nothing to move rewrites nothing. Runs at every autonomy level so an
  // existing backlog keeps healing even after the dial is lowered.
  try {
    const staleWeeks = Math.max(1, Number(process.env.KNOWLEDGE_SUGGESTION_STALE_WEEKS) || 4);
    const maxOpen = Math.max(1, Number(process.env.KNOWLEDGE_MAX_OPEN_SUGGESTIONS) || knowledgeHygiene.DEFAULT_MAX_OPEN_SUGGESTIONS);
    const observedIds = new Set(
      (Array.isArray(proj.clusters) ? proj.clusters : []).map((c) => knowledgeConvergence.stableSuggestionId(c)),
    );
    let store = readKnowledgeCandidates(teamId);
    const evts = [];
    let changed = false;

    // 1) quiet-decay open→stale (+ stale→open revive on fresh evidence).
    const stalePlan = knowledgeHygiene.planStaleTransitions(store, { now, maxWeeks: staleWeeks, observedIds });
    if (stalePlan.changed) {
      store = stalePlan.next;
      changed = true;
      evts.push(...stalePlan.stale.map((c) => knowledgeFeed.buildStaleEvent({ teamId, suggestionId: c.id, text: c.text, revived: false })));
      evts.push(...stalePlan.revive.map((c) => knowledgeFeed.buildStaleEvent({ teamId, suggestionId: c.id, text: c.text, revived: true })));
    }

    // 2) FIX-B: retire grown-cluster duplicates immediately (a card whose lesson set is
    // a strict subset of a larger open card of the same kind+source → `superseded`),
    // instead of waiting out the multi-week stale window.
    const supPlan = knowledgeHygiene.planSupersessions(store, { now });
    if (supPlan.changed) {
      store = supPlan.next;
      changed = true;
      evts.push(...supPlan.superseded.map((c) => knowledgeFeed.buildStaleEvent({ teamId, suggestionId: c.id, text: c.text, revived: false })));
    }

    // 3) FIX-C: hard backstop — if still over the open-card cap, evict the
    // lowest-evidence cards to `stale` (never the domain-proposal singleton/amendments).
    const capPlan = knowledgeHygiene.planOpenCap(store, { now, maxOpen });
    if (capPlan.changed) {
      store = capPlan.next;
      changed = true;
      evts.push(...capPlan.evicted.map((c) => knowledgeFeed.buildStaleEvent({ teamId, suggestionId: c.id, text: c.text, revived: false })));
    }

    if (changed) {
      writeKnowledgeCandidates(teamId, store);
      if (evts.length) appendKnowledgeEvents(evts);
    }
  } catch (err) {
    console.warn(`[Orchestrator] suggestion hygiene for '${teamId}' failed: ${err.message}`);
  }
}

// Raise related-theme (thematic aggregation) suggestion cards for a team and
// return the up-to-date candidate list (written when anything new was raised).
function raiseRelatedSuggestions(teamId, clusters, candidates, { relatedThreshold, now }) {
  const { raise, batch } = knowledgeConvergence.planRelatedSuggestions(clusters, candidates, {
    relatedThreshold,
    teamId,
    now,
  });
  if (raise.length === 0) return candidates;
  const next = [...candidates, ...raise];
  writeKnowledgeCandidates(teamId, next);
  if (batch) appendKnowledgeEvents([batch]);
  return next;
}

// Serialize one kind's canonical bucket (canonical entries first, then merge
// tombstones) in the SAME deterministic order buildCanonicalProjection uses, with
// a status overlay: a canonical entry whose id was archived is written
// status:"archived"; else one marked promoted is written status:"promoted"
// (archived wins). Empty overlays ⇒ byte-identical to proj.lines[kind].
function _serializeCanonicalKind(bucket, promotedIds, archivedIds, review = {}) {
  const { pendingIds, rejectedIds, summaries, validity, triggers } = review;
  const canon = bucket.canonical.slice().sort(
    (a, b) => (a.createdAt || "").localeCompare(b.createdAt || "") || String(a.id).localeCompare(String(b.id)),
  );
  const tombs = bucket.tombstones.slice().sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const out = [];
  for (const e of canon) {
    let entry = e;
    // Review overlay wins over promoted/archived (a held entry isn't in the KB at
    // all yet). Status-only overlay (no synthetic updatedAt) exactly like the
    // archived overlay: the admin-console reads the canonical file AFTER the shard
    // copies, so foldReview's last-writer-wins tie-break already prefers the held
    // canonical copy — and the projection stays a pure function of shards+decisions,
    // so idempotent re-runs produce byte-identical files (no spurious git churn).
    if (rejectedIds && rejectedIds.has(e.id)) {
      if (e.status !== "rejected") entry = { ...e, status: "rejected" };
    } else if (pendingIds && pendingIds.has(e.id)) {
      if (e.status !== "pending") entry = { ...e, status: "pending" };
    } else if (archivedIds && archivedIds.has(e.id)) {
      if (e.status !== "archived") entry = { ...e, status: "archived" };
    } else if (promotedIds && promotedIds.has(e.id) && e.status !== "promoted") {
      entry = { ...e, status: "promoted" };
    }
    // Human-readable summary overlay (#635): a real field on the canonical entry,
    // resolved (carried-forward or freshly backfilled) by the caller. Only applied
    // to canonical entries, never tombstones. No summary ⇒ field omitted ⇒ line
    // byte-identical to the pre-#635 projection.
    if (summaries && summaries.has(e.id)) {
      entry = { ...entry, summary: summaries.get(e.id) };
    }
    // Bitemporal-validity overlay (#916): FIELDS on the canonical entry, never a
    // status — the line keeps status:"active" and readers derive "expired" from
    // validTo. Sidecar-sourced (shards never carry these), so clearing = the id
    // leaving the sidecar ⇒ the fields simply aren't re-applied. Empty sidecar ⇒
    // byte-identical projection.
    if (validity) {
      const vv = validity[e.id];
      if (vv && typeof vv === "object") {
        const patch = {};
        if (typeof vv.validTo === "string" && vv.validTo.trim() !== "") patch.validTo = vv.validTo.trim();
        if (typeof vv.supersededBy === "string" && /^[0-9a-f]{12}$/.test(vv.supersededBy)) patch.supersededBy = vv.supersededBy;
        if (Object.keys(patch).length > 0) entry = { ...entry, ...patch };
      }
    }
    // Auto-load trigger overlay (#917): same sidecar-sourced field posture as
    // validity — the canonical line carries the operator-authored triggers so
    // the agent-side scoped resolver reads them off its checkout.
    if (triggers) {
      const tt = normalizeLoadTriggers(triggers[e.id]);
      if (tt) entry = { ...entry, loadTriggers: tt };
    }
    out.push(serializeKnowledgeEntry(entry));
  }
  for (const e of tombs) out.push(serializeKnowledgeEntry(e));
  return out;
}

// Read the prior canonical <kind>.jsonl files and collect each entry's persisted
// human-readable summary (#635) keyed by id → {text, summary}. Used to carry a
// summary forward across a re-projection (which rebuilds canonical from shards
// that never carry one), and to drop it when the entry's text has changed (AC5).
// Best-effort + tolerant: a missing file or a mangled line is skipped, never throws.
function _readCanonicalSummaries(storeRoot, manifest) {
  const byId = new Map();
  for (const kind of KNOWLEDGE_KINDS) {
    let rel;
    try { rel = kindFilePath(manifest, kind); } catch { continue; }
    let raw;
    try { raw = fs.readFileSync(path.join(storeRoot, rel), "utf8"); } catch { continue; }
    for (const line of raw.split("\n")) {
      const e = parseKnowledgeEntry(line);
      if (!e || typeof e.id !== "string") continue;
      if (typeof e.summary === "string" && e.summary.trim() !== "") {
        byId.set(e.id, { text: e.text, summary: e.summary });
      }
    }
  }
  return byId;
}

// Normalize a caller-supplied summary map (id → summary text) into a validated
// Map, keeping only 12-hex ids with a non-empty string summary.
function _normalizeSummaryMap(input) {
  const out = new Map();
  if (!input) return out;
  const entries = input instanceof Map ? [...input.entries()] : Object.entries(input);
  for (const [id, text] of entries) {
    if (typeof id === "string" && /^[0-9a-f]{12}$/.test(id) && typeof text === "string" && text.trim() !== "") {
      out.set(id, text.trim());
    }
  }
  return out;
}

// Persist human-readable summaries (#635) for a team's canonical KB entries. The
// summary is a real, git-persisted field on the entry (never a sidecar): this
// refreshes the canonical clone then re-projects with the supplied summaries
// carried into the write, committing + pushing the change. Mirrors
// archiveKnowledgeEntry's re-projection posture. Best-effort on the git side.
function persistKnowledgeSummaries(teamId, summaries) {
  const clean = _normalizeSummaryMap(summaries);
  if (clean.size === 0) return { persisted: 0, ids: [] };
  let env = null;
  const resolved = resolveTeamKbRepo(teamId);
  if (resolved) env = resolved.env;
  const extra = {};
  for (const [id, text] of clean.entries()) extra[id] = text;
  try {
    refreshKnowledgeClone(teamId, { force: true, env });
    runConvergenceCollector(teamId, env, { extraSummaries: extra }) // #855: async, non-blocking
      .catch((err) => console.warn(`[Orchestrator] summary persist re-projection for '${teamId}' failed: ${err.message}`));
  } catch (err) {
    console.warn(`[Orchestrator] summary persist re-projection for '${teamId}' failed: ${err.message}`);
  }
  return { persisted: clean.size, ids: [...clean.keys()] };
}

// Archive / unarchive a canonical KB entry (Phase 4 manual curation, operator-
// initiated). Non-destructive: updates the per-team archived-id set, then re-runs
// the collector so the canonical file is re-projected with the overlay + committed
// (git audit). Refuses to archive a promoted entry — it backs a skill, and hiding
// it would erase the T1→T2 promoted edge. Best-effort on the git side.
function archiveKnowledgeEntry(teamId, id, archived) {
  if (!/^[0-9a-f]{12}$/.test(id)) throw new Error("invalid id");
  let env = null;
  const resolved = resolveTeamKbRepo(teamId);
  if (resolved) env = resolved.env;
  if (archived) {
    // Every entry a promoted candidate bundles backs the skill — not just the
    // lead canonicalId (multi-lesson related/manual candidates span several).
    const promoted = readKnowledgeCandidates(teamId).some(
      (c) => c && c.status === "promoted"
        && (c.canonicalId === id || (Array.isArray(c.entryIds) && c.entryIds.includes(id))),
    );
    if (promoted) throw new Error("cannot archive a promoted entry (it backs a skill) — remove the skill first");
  }
  const ids = new Set(readArchivedIds(teamId));
  if (archived) ids.add(id); else ids.delete(id);
  writeArchivedIds(teamId, [...ids]);
  // Re-project + commit so the change is reflected + git-audited. Best-effort.
  try {
    refreshKnowledgeClone(teamId, { force: true, env });
    runConvergenceCollector(teamId, env) // #855: async, non-blocking
      .catch((err) => console.warn(`[Orchestrator] archive re-projection for '${teamId}' failed: ${err.message}`));
  } catch (err) {
    console.warn(`[Orchestrator] archive re-projection for '${teamId}' failed: ${err.message}`);
  }
  return { id, archived: !!archived };
}

// Set / clear a canonical KB entry's validity window (#916, operator-initiated).
// Non-destructive field overlay: updates the per-team validity sidecar, then
// re-runs the collector so the canonical file is re-projected with the fields +
// committed (git audit). Unlike archive there is NO promoted-entry guard —
// expiring a promoted entry is allowed (AC5): the skill stays, the source entry
// expires. `validTo` accepts a date (YYYY-MM-DD, normalized to the END of that
// day so "valid until X" includes X) or a full ISO timestamp; null/'' clears.
// `supersededBy` records semantic replacement (fact B replaces outdated fact A)
// and NEVER by itself hides the old entry (AC4) — deliberately distinct from the
// convergence merge's `mergedInto`. Best-effort on the git side.
function setKnowledgeValidity(teamId, id, { validTo = null, supersededBy = null } = {}) {
  if (!/^[0-9a-f]{12}$/.test(id)) throw new Error("invalid id");
  let normalizedTo = null;
  if (typeof validTo === "string" && validTo.trim() !== "") {
    const raw = validTo.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) normalizedTo = `${raw}T23:59:59Z`;
    else if (!Number.isNaN(Date.parse(raw))) normalizedTo = raw;
    else throw new Error("validTo must be an ISO date or timestamp");
  }
  let normalizedBy = null;
  if (typeof supersededBy === "string" && supersededBy.trim() !== "") {
    if (!/^[0-9a-f]{12}$/.test(supersededBy.trim())) throw new Error("supersededBy must be a 12-char hex entry id");
    normalizedBy = supersededBy.trim();
  }
  const map = readKnowledgeValidity(teamId);
  if (!normalizedTo && !normalizedBy) {
    delete map[id];
  } else {
    map[id] = {
      ...(normalizedTo ? { validTo: normalizedTo } : {}),
      ...(normalizedBy ? { supersededBy: normalizedBy } : {}),
    };
  }
  writeKnowledgeValidity(teamId, map);
  let env = null;
  const resolved = resolveTeamKbRepo(teamId);
  if (resolved) env = resolved.env;
  // Re-project + commit so the change is reflected + git-audited (and the digest
  // fan-out picks it up immediately). Best-effort, mirrors archiveKnowledgeEntry.
  try {
    refreshKnowledgeClone(teamId, { force: true, env });
    runConvergenceCollector(teamId, env) // #855: async, non-blocking
      .catch((err) => console.warn(`[Orchestrator] validity re-projection for '${teamId}' failed: ${err.message}`));
  } catch (err) {
    console.warn(`[Orchestrator] validity re-projection for '${teamId}' failed: ${err.message}`);
  }
  return { id, validTo: normalizedTo, supersededBy: normalizedBy };
}

// Explicit, operator-initiated removal of the source KB entries a freshly-written
// skill now supersedes (#559). Unlike archiveKnowledgeEntry this DELIBERATELY
// bypasses the "cannot archive a promoted entry" guard (#553 AC7) — the promotion
// itself is the authorisation, so this is an intentional override of that silent-
// archive protection, not a silent archive (E7). Removal = archive (reversible,
// non-destructive, AC1/Q1): the entry leaves the active KB / digest / search /
// graph (archived wins over promoted in the collector overlay) but stays
// recoverable, and each skill's provenance keeps its own entryIds so the
// skill→knowledge link never dangles (AC8, E2). Best-effort and idempotent:
// re-removing an already-archived entry is a no-op (E1). Emits ONE distinguishable
// cleanup feed event (AC9). Re-projects so the removal is reflected everywhere on
// the next read (AC3, E5).
function removePromotedSourceEntries(teamId, entryIds, { skill = null, auto = false, env = null } = {}) {
  const ids = (Array.isArray(entryIds) ? entryIds : [])
    .filter((x) => typeof x === "string" && /^[0-9a-f]{12}$/.test(x));
  if (ids.length === 0) return { removed: 0, ids: [] };
  let resolvedEnv = env;
  if (!resolvedEnv) {
    const r = resolveTeamKbRepo(teamId);
    if (r) resolvedEnv = r.env;
  }
  const set = new Set(readArchivedIds(teamId));
  for (const id of ids) set.add(id); // E1: already-archived is a no-op
  writeArchivedIds(teamId, [...set]);
  // Re-project + commit so the removal drops out of the KB / digest / search /
  // graph, exactly like archiveKnowledgeEntry. Best-effort — a re-projection
  // failure never rolls the promotion back (AC7): the ids are already archived.
  try {
    refreshKnowledgeClone(teamId, { force: true, env: resolvedEnv });
    // #855: async, non-blocking. This runs from a curator pass (_finalizePromotedSkills)
    // as well as the operator handler; fire-and-forget keeps the (best-effort,
    // idempotent, git-audited) re-projection off the caller's critical path.
    runConvergenceCollector(teamId, resolvedEnv)
      .catch((err) => console.warn(`[Orchestrator] promote-cleanup re-projection for '${teamId}' failed: ${err.message}`));
  } catch (err) {
    console.warn(`[Orchestrator] promote-cleanup re-projection for '${teamId}' failed: ${err.message}`);
  }
  appendKnowledgeEvents([knowledgeFeed.buildPromotionCleanupEvent({ teamId, skill, entryIds: ids, auto })]);
  return { removed: ids.length, ids };
}

// Guarded destination dir for a curator-written TEAM skill:
// /workspace/teams/<teamId>/skills/<name>. Returns null on an unsafe id/name.
// The orchestrator can write here (/workspace is RW); it can NEVER write the
// global pool (/template-workspace is mounted read-only), which is exactly why
// team→global is never auto-promoted (see docs/knowledge-curation.md decision c).
function _teamSkillDir(teamId, name) {
  const seg = knowledgeFeed.safeTeamSegment(teamId);
  if (!seg) return null;
  if (typeof name !== "string" || !knowledgeCurator.SKILL_NAME_RE.test(name)) return null;
  const base = path.resolve(WORKSPACE, "teams", seg, "skills");
  const dir = path.resolve(base, name);
  const rel = path.relative(base, dir);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return dir;
}

// Level-3 auto-promotion (Shared Agent Learning, Phase 4). Plans with the pure
// curator core, writes each auto-promoted cluster as a TEAM skill (SKILL.md +
// mandatory provenance.json, promotedBy:"curator"), flips its candidate to
// promoted, and raises review cards for deferred (gated / over-cap) clusters.
// Best-effort: a per-skill failure logs and continues. The promoted-status git
// stamp lands on the NEXT collector pass via the candidate-store overlay above
// (or within a day via the backstop), so this step performs no git op itself.
// Set in main(); lets free functions (this one) reach instance methods.
let orchestratorSingleton = null;

async function autoPromoteStep(teamId, env, clusters, candidates, { convergenceThreshold, now, capRemaining, excludeCanonicalIds } = {}) {
  env = teamKnowledgeEnv(teamId, env); // #570: per-team knowledge config
  const assistSynthBinding = resolveAssistBindingForTeam(teamId); // #1213: team-billed synthesis provider
  const gates = resolvePromotionGates(env);
  const { maxAutoPromotionsPerPass, synthesizeSkills } = knowledgeCurationConfig(env);
  // #779: the per-pass cap is shared across auto-extend + convergence promotions +
  // theme promotions. When the caller has already spent part of it, it passes the
  // remaining budget; absent ⇒ the whole cap (legacy behaviour).
  const cap = Number.isInteger(capRemaining) ? Math.max(0, capRemaining) : maxAutoPromotionsPerPass;
  // #779: clusters already claimed by the auto-extend path must not also spawn a
  // brand-new skill here.
  const exclude = excludeCanonicalIds instanceof Set ? excludeCanonicalIds : null;
  const inClusters = exclude && exclude.size > 0
    ? (Array.isArray(clusters) ? clusters : []).filter((c) => c && !exclude.has(c.canonicalId))
    : clusters;
  const plan = knowledgeCurator.planAutoPromotions(inClusters, candidates, gates, {
    threshold: convergenceThreshold,
    cap,
    teamId,
    now,
  });
  if (plan.promote.length === 0 && plan.defer.length === 0) return 0;

  const byId = new Map((candidates || []).filter((c) => c && c.id).map((c) => [c.id, c]));
  const promotedSkills = [];
  for (const item of plan.promote) {
    const dir = _teamSkillDir(teamId, item.name);
    if (!dir) {
      console.warn(`[Orchestrator] auto-promote: unsafe skill dir for '${item.name}'`);
      continue;
    }
    const promotedCand = { ...item.candidate, status: "promoted", resolvedAt: now, promotedBy: "curator" };
    // Idempotent: never clobber an existing skill — just settle the candidate so
    // it is not retried every pass.
    if (fs.existsSync(path.join(dir, "SKILL.md"))) {
      byId.set(item.candidate.id, promotedCand);
      continue;
    }
    const prov = knowledgeCurator.curatorSkillProvenance({
      teamId, cluster: item.cluster, entryIds: item.candidate.entryIds, now,
    });
    // #780 §3.3: default LLM synthesis on the create path (opt-in per team) — the
    // heuristic draft is the marked fallback when synthesis is off or the call fails.
    const synth = await _resolveSkillMd(env, {
      heuristicMd: item.draft.skillMd,
      request: knowledgeCurator.buildSkillSynthesisRequest(item.candidate),
      synthesize: synthesizeSkills,
      frontmatter: { name: item.draft.name, description: item.draft.description },
      binding: assistSynthBinding, // #1213: team-billed provider (null → .env)
    });
    try {
      fs.mkdirSync(dir, { recursive: true });
      const md = synth.skillMd.endsWith("\n") ? synth.skillMd : synth.skillMd + "\n";
      fs.writeFileSync(path.join(dir, "SKILL.md"), md);
      fs.writeFileSync(path.join(dir, "provenance.json"), JSON.stringify(prov, null, 2));
    } catch (err) {
      console.warn(`[Orchestrator] auto-promote: writing skill '${item.name}' failed: ${err.message}`);
      continue;
    }
    // #625: stamp the curator-authored team skill (fresh chain, no origin — its
    // knowledge lineage lives in provenance.json). Best-effort: never rolls back.
    try { skillManifest.stampSkillDir(dir, { name: item.name, by: "curator", action: "promoted", now, note: synth.note || undefined }); }
    catch (err) { console.warn(`[Orchestrator] auto-promote: stamp '${item.name}' failed: ${err.message}`); }
    byId.set(item.candidate.id, promotedCand);
    promotedSkills.push({ name: item.name, entryIds: item.candidate.entryIds });
  }

  // Deferred clusters (review-gated / over the per-pass cap) become open cards.
  const raisedCards = [];
  for (const item of plan.defer) {
    if (byId.has(item.candidate.id)) continue; // already tracked (open/promoted/dismissed)
    const card = { ...item.candidate, autoDrafted: true, gateReason: item.reason };
    byId.set(card.id, card);
    raisedCards.push(card);
  }

  writeKnowledgeCandidates(teamId, [...byId.values()]);

  _finalizePromotedSkills(teamId, env, promotedSkills, now);
  if (raisedCards.length > 0) {
    appendKnowledgeEvents([{
      type: "suggestion", ts: now, teamId, count: raisedCards.length,
      samples: raisedCards.slice(0, 5).map((c) => ({
        id: c.id, canonicalId: c.canonicalId, text: c.text, convergenceCount: c.convergenceCount,
      })),
    }]);
  }
  return promotedSkills.length;
}

// Shared finalize for a batch of curator auto-promotions (convergence clusters or
// themes): emit the `promotion` feed event (auto:true), archive the source KB
// entries so the promoted knowledge drops out of the KB/digest/graph, and
// auto-activate each new team skill (auto:true) — closing learn→bundle→promote→
// activate without a human (docs/knowledge-curation.md §4). Each side is
// best-effort: a per-skill failure logs and never rolls the promotion back (AC7).
function _finalizePromotedSkills(teamId, env, promotedSkills, now) {
  if (!promotedSkills || promotedSkills.length === 0) return;
  appendKnowledgeEvents(promotedSkills.map((s) => ({
    type: "promotion", ts: now, teamId, skill: { name: s.name, tier: "team" }, entryIds: s.entryIds, auto: true,
  })));
  for (const s of promotedSkills) {
    try {
      removePromotedSourceEntries(teamId, s.entryIds, { skill: { name: s.name, tier: "team" }, auto: true, env });
    } catch (err) {
      console.warn(`[Orchestrator] auto promote-cleanup for '${s.name}' (team ${teamId}) failed: ${err.message}`);
    }
  }
  if (orchestratorSingleton) {
    (async () => {
      for (const s of promotedSkills) {
        try {
          const res = await orchestratorSingleton.setTeamSkillActive(teamId, s.name, { active: true, auto: true });
          // #750 AC7: verify the auto-activation actually reached members. A pass
          // that synced nobody (e.g. the pool-keyspace bug, or a genuinely absent
          // source) must be surfaced as a failure in the live feed, not left as a
          // silent `active · 0/N`.
          const verdict = skillDelivery.deliveryVerdict(res && res.members);
          if (!verdict.delivered) {
            appendKnowledgeEvents([skillDelivery.buildDeliveryFailureEvent({
              teamId, skillName: s.name, verdict, auto: true,
            })]);
            console.warn(
              `[Orchestrator] auto-activate '${s.name}' for team ${teamId} delivered to 0/${verdict.syncable} member(s) ` +
              `(${verdict.allSourceMissing ? "source missing from pool" : "sync failed"})`
            );
          }
        } catch (err) {
          console.warn(`[Orchestrator] auto-activate '${s.name}' for team ${teamId} failed: ${err.message}`);
        }
      }
    })();
  }
}

// Level-3 theme auto-promotion (#604). Sibling of autoPromoteStep for single-role
// accumulation THEMES: plans with the pure curator core (planAutoPromoteThemes),
// writes each strong theme (lessonCount >= autoThemeMinLessons) as ONE team skill
// bundling its members across clusters/kinds (SKILL.md + provenance.json,
// promotedBy:"curator"), flips its candidate to promoted, and finalizes (promotion
// event + source archival + auto-activation). Weaker/gated/over-cap themes are NOT
// raised here — the caller's raiseRelatedSuggestions raises the remainder as cards
// (planRelatedSuggestions naturally excludes the clusters this step just promoted).
function autoPromoteThemesStep(teamId, env, clusters, candidates, { relatedThreshold, now, capRemaining, resolveDomain } = {}) {
  env = teamKnowledgeEnv(teamId, env); // #570: per-team knowledge config
  const gates = resolvePromotionGates(env);
  const { maxAutoPromotionsPerPass, autoThemeMinLessons } = knowledgeCurationConfig(env);
  // #779: share the per-pass cap with auto-extend + convergence promotions.
  const cap = Number.isInteger(capRemaining) ? Math.max(0, capRemaining) : maxAutoPromotionsPerPass;
  const plan = knowledgeCurator.planAutoPromoteThemes(clusters, candidates, gates, {
    autoThemeMinLessons,
    cap,
    relatedThreshold,
    teamId,
    now,
    resolveDomain, // #780 AC4: domain-based naming for auto-promoted themes
  });
  if (plan.promote.length === 0) return 0;

  const byId = new Map((candidates || []).filter((c) => c && c.id).map((c) => [c.id, c]));
  const promotedSkills = [];
  for (const item of plan.promote) {
    const dir = _teamSkillDir(teamId, item.name);
    if (!dir) {
      console.warn(`[Orchestrator] auto-promote theme: unsafe skill dir for '${item.name}'`);
      continue;
    }
    const promotedCand = { ...item.candidate, status: "promoted", resolvedAt: now, promotedBy: "curator" };
    // Idempotent: never clobber an existing skill — just settle the candidate.
    if (fs.existsSync(path.join(dir, "SKILL.md"))) {
      byId.set(item.candidate.id, promotedCand);
      continue;
    }
    const prov = knowledgeCurator.curatorThemeSkillProvenance({
      teamId, candidate: item.candidate, entryIds: item.candidate.entryIds, now,
    });
    try {
      fs.mkdirSync(dir, { recursive: true });
      const md = item.draft.skillMd.endsWith("\n") ? item.draft.skillMd : item.draft.skillMd + "\n";
      fs.writeFileSync(path.join(dir, "SKILL.md"), md);
      fs.writeFileSync(path.join(dir, "provenance.json"), JSON.stringify(prov, null, 2));
    } catch (err) {
      console.warn(`[Orchestrator] auto-promote theme: writing skill '${item.name}' failed: ${err.message}`);
      continue;
    }
    // #625: stamp the curator-authored theme skill (fresh chain, no origin).
    try { skillManifest.stampSkillDir(dir, { name: item.name, by: "curator", action: "promoted", now }); }
    catch (err) { console.warn(`[Orchestrator] auto-promote theme: stamp '${item.name}' failed: ${err.message}`); }
    byId.set(item.candidate.id, promotedCand);
    promotedSkills.push({ name: item.name, entryIds: item.candidate.entryIds });
  }

  writeKnowledgeCandidates(teamId, [...byId.values()]);
  _finalizePromotedSkills(teamId, env, promotedSkills, now);
  return promotedSkills.length;
}

// ── Curator auto-extend (#779, skill-aggregation Phase 1) ───────────────────────
// Read the team's existing team-tier skills as match targets for the auto-extend
// planner: [{ name, tier:"team", entryIds }] where entryIds come from each skill's
// provenance.json (the same lineage signal admin-console eligibleExtendSkills uses).
// Best-effort + tolerant: an unreadable dir/provenance yields an empty entryIds set,
// never throws. Returns [] when the team has no skill pool yet.
// #780: route this pass's candidate clusters against the team's domains. Persists
// amendment review cards ("Add to <skill>"), unrouted-pool rows, and a new-domain
// proposal card (budget-aware); emits the `domain-routing` feed event. Returns the
// set of canonicalIds it claimed (amendments + unrouted) so the caller excludes
// them from the single-lesson candidate + create-new auto-promotion paths — the
// core flood-reduction move. Best-effort: any failure leaves the pass untouched.
function _routeDomains(teamId, env, domains, candidateClusters, { skillBudget, now, tagsByEntryId } = {}) {
  const claimed = new Set();
  const cands = (Array.isArray(candidateClusters) ? candidateClusters : [])
    .map((c) => knowledgeConvergence.toCandidate(c, { teamId, now }));
  if (cands.length === 0) return claimed;

  const existingSkills = readTeamSkillsForMatch(teamId);
  const skillEntryIdsByDomain = {};
  for (const d of domains) {
    const sn = knowledgeDomains.domainSkillName(d);
    const sk = existingSkills.find((s) => s.name === sn);
    if (sk) skillEntryIdsByDomain[d.id] = sk.entryIds;
  }
  const budget = knowledgeDomains.skillBudgetState(existingSkills.map((s) => s.name), { cap: skillBudget });

  const plan = knowledgeRouting.planDomainRouting(cands, domains, {
    skillEntryIdsByDomain,
    tagsByEntryId: tagsByEntryId || {},
    budgetOver: budget.over,
    teamId,
    now,
  });

  const rows = readKnowledgeCandidates(teamId);
  const byId = new Map(rows.filter((r) => r && r.id).map((r) => [r.id, r]));
  const tracked = (id) => {
    const r = byId.get(id);
    return r && ['open', 'promoted', 'dismissed'].includes(r.status);
  };

  for (const a of plan.amendments) {
    if (a.candidate && a.candidate.canonicalId) claimed.add(a.candidate.canonicalId);
    if (tracked(a.candidate.id)) continue;
    byId.set(a.candidate.id, {
      ...a.candidate,
      status: 'open',
      source: 'convergence',
      autoDrafted: true,
      extendMode: true,
      domainId: a.domainId,
      routedVia: a.via,
      matchedSkill: { name: a.skill, tier: 'team' },
    });
  }
  for (const c of plan.unrouted) {
    if (c && c.canonicalId) claimed.add(c.canonicalId);
    if (tracked(c.id)) continue;
    // Parked pool row (never rendered as an open card) — accumulates toward a
    // new-domain proposal; keyed by the same stable id so a grown set re-evaluates.
    byId.set(c.id, { ...c, status: 'unrouted', routedAt: now });
  }
  // FIX-A: keep at most ONE open new-domain proposal card (a singleton per team,
  // upserted; operator dismissal respected; legacy dp-<hash> pile collapsed). The
  // decision is a pure, unit-tested helper in knowledge-routing.
  const reconciledRows = knowledgeRouting.reconcileDomainProposal([...byId.values()], {
    proposal: plan.newDomainProposal,
    teamId,
    teamSegment: knowledgeFeed.safeTeamSegment(teamId),
    now,
  });

  writeKnowledgeCandidates(teamId, reconciledRows);
  if (plan.batch) appendKnowledgeEvents([plan.batch]);
  return claimed;
}

// #780 §3.3: best-effort LLM synthesis transport for a SKILL.md write. Uses the
// orchestrator's own Anthropic-compatible endpoint (ANTHROPIC_BASE_URL +
// ANTHROPIC_AUTH_TOKEN, the same proxy every agent talks to) with a short timeout.
// Returns the synthesised Markdown, or null on any failure / missing config — the
// caller (synthesisFallback) then keeps the heuristic draft VISIBLY MARKED
// un-synthesised and re-queued. Deliberately fail-soft: synthesis quality never
// blocks a promotion, and a slow/absent endpoint just yields the marked fallback.
//
// #855: this MUST be non-blocking. It was previously a synchronous
// `execFileSync('curl', …)`, which parks the orchestrator's single-threaded Node
// event loop for the whole LLM round-trip (up to the 25 s timeout) — freezing every
// other concurrent request (the 'orchestrator unreachable: fetch failed' bug). It is
// now an async `fetch` with an `AbortSignal` timeout, so the loop stays free while
// the LLM is in flight and only THIS logical operation waits. Every caller awaits it.
// An optional `binding` {baseUrl, token, model} overrides the `.env` proxy so
// synthesis bills against the chosen provider — a team's `assistLlmEndpointId`
// (#1213, resolveAssistBindingForTeam) for curator auto-promotion/distillation,
// or a user's console selection (#1214, resolveAssistBindingFromSelection) for
// domain bootstrap. Absent (or with any field missing) → the `.env` fallback,
// byte-identical to before. The token stays in-process; only these three values
// ever reach fetch.
async function _synthesizeSkillMd(env, request, binding) {
  const base = (binding && binding.baseUrl) || process.env.ANTHROPIC_BASE_URL;
  const token = (binding && binding.token) || process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY;
  const model = (binding && binding.model)
    || process.env.ANTHROPIC_SYNTHESIS_MODEL
    || process.env.ANTHROPIC_DEFAULT_SONNET_MODEL
    || process.env.ANTHROPIC_MODEL;
  if (!base || !token || !model || !request || !Array.isArray(request.messages)) return null;
  try {
    const url = `${String(base).replace(/\/+$/, '')}/v1/messages`;
    const body = JSON.stringify({ model, max_tokens: request.max_tokens || 2048, messages: request.messages });
    // Same 25 s budget as the former curl `--max-time`, enforced by an abort signal
    // rather than a blocking process timeout so the event loop is never parked.
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key': token,
        authorization: `Bearer ${token}`,
      },
      body,
      signal: AbortSignal.timeout(25_000),
    });
    if (!res.ok) return null;
    const parsed = await res.json();
    const text = Array.isArray(parsed.content)
      ? parsed.content.filter((b) => b && b.type === 'text').map((b) => b.text).join('').trim()
      : '';
    return text || null;
  } catch {
    return null;
  }
}

// Resolve the SKILL.md text to write for a create/extend, applying default
// synthesis (§3.3) when the team opted in. OFF (default) ⇒ the Phase-1 heuristic
// draft verbatim (backward-compatible). ON ⇒ attempt LLM synthesis, else the
// marked-un-synthesised fallback. Returns { skillMd, synthesised, note }.
async function _resolveSkillMd(env, { heuristicMd, request, synthesize, frontmatter, binding }) {
  // #805: the heuristic draft already carries frontmatter, so OFF is safe verbatim.
  // ON: hand the deterministic { name, description } to synthesisFallback so the LLM
  // output is guaranteed a valid frontmatter block (its own if present, else this).
  if (!synthesize) return { skillMd: heuristicMd, synthesised: null, note: null };
  const out = knowledgeCurator.synthesisFallback({
    heuristic: { name: null, skillMd: heuristicMd },
    llmText: await _synthesizeSkillMd(env, request, binding), // #855: async; #1213: team-billed binding
    frontmatter,
  });
  return {
    skillMd: out.skillMd,
    synthesised: out.synthesised,
    note: out.synthesised ? 'LLM-synthesised playbook' : 'heuristic fallback (un-synthesised, queued for re-synthesis)',
  };
}

function readTeamSkillsForMatch(teamId) {
  const seg = knowledgeFeed.safeTeamSegment(teamId);
  if (!seg) return [];
  const base = path.resolve(WORKSPACE, "teams", seg, "skills");
  let names;
  try { names = fs.readdirSync(base, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const d of names) {
    if (!d.isDirectory()) continue;
    const name = d.name;
    if (!knowledgeCurator.SKILL_NAME_RE.test(name)) continue;
    const dir = path.join(base, name);
    if (!fs.existsSync(path.join(dir, "SKILL.md"))) continue;
    let entryIds = [];
    try {
      const prov = JSON.parse(fs.readFileSync(path.join(dir, "provenance.json"), "utf8"));
      if (prov && Array.isArray(prov.entryIds)) {
        entryIds = prov.entryIds.filter((x) => typeof x === "string" && /^[0-9a-f]{12}$/.test(x));
      }
    } catch { /* no/garbled provenance ⇒ name-only match still possible */ }
    out.push({ name, tier: "team", entryIds });
  }
  return out;
}

// Read one existing team skill's SKILL.md + provenance.json for an in-place
// extension. Returns { dir, skillMd, provenance } or null when the skill/dir is
// missing or unsafe.
function _readTeamSkillDoc(teamId, name) {
  const dir = _teamSkillDir(teamId, name);
  if (!dir) return null;
  let skillMd;
  try { skillMd = fs.readFileSync(path.join(dir, "SKILL.md"), "utf8"); } catch { return null; }
  let provenance = {};
  try { provenance = JSON.parse(fs.readFileSync(path.join(dir, "provenance.json"), "utf8")) || {}; }
  catch { provenance = {}; }
  return { dir, skillMd, provenance };
}

// Level-3 curator auto-extend. Plans with the pure curator core
// (planAutoExtensions), folds each auto-extendable cluster into its matched team
// skill in place (re-synthesised SKILL.md via the heuristic extension draft +
// unioned provenance + a version-bumping "extended" stamp), flips the candidate to
// promoted, and raises review cards (extend mode preselected) for below-confidence /
// gated / over-cap matches. Shares the per-pass cap via `capRemaining`. Best-effort:
// a per-skill failure logs and continues. Returns
// { extendedCount, consumedCanonicalIds } so the caller excludes claimed clusters
// from the create-new auto-promotion path and debits the shared cap.
async function autoExtendStep(teamId, env, clusters, candidates, existingSkills, { convergenceThreshold, now, capRemaining } = {}) {
  env = teamKnowledgeEnv(teamId, env); // #570: per-team knowledge config
  const assistSynthBinding = resolveAssistBindingForTeam(teamId); // #1213: team-billed synthesis provider
  const gates = resolvePromotionGates(env);
  const { maxAutoPromotionsPerPass, extendConfidenceFloor, synthesizeSkills } = knowledgeCurationConfig(env);
  const cap = Number.isInteger(capRemaining) ? Math.max(0, capRemaining) : maxAutoPromotionsPerPass;
  const plan = knowledgeCurator.planAutoExtensions(clusters, candidates, existingSkills, gates, {
    threshold: convergenceThreshold,
    cap,
    confidenceFloor: extendConfidenceFloor,
    teamId,
    now,
  });
  if (plan.extend.length === 0 && plan.reviewExtend.length === 0) {
    return { extendedCount: 0, consumedCanonicalIds: new Set() };
  }

  const byId = new Map((candidates || []).filter((c) => c && c.id).map((c) => [c.id, c]));
  const extendedSkills = [];
  for (const item of plan.extend) {
    const doc = _readTeamSkillDoc(teamId, item.target.name);
    if (!doc) {
      // The match target vanished between the read and now — leave the cluster for
      // the create-new path on the next pass (don't claim it as extended).
      item.cluster && item.cluster.canonicalId && plan.consumedCanonicalIds.delete(item.cluster.canonicalId);
      console.warn(`[Orchestrator] auto-extend: target skill '${item.target.name}' not readable for team ${teamId}`);
      continue;
    }
    // #805: pass the target skill name so a legacy (pre-#805) skill gains valid
    // frontmatter on extension; an existing description is preserved (E5).
    const ext = knowledgeCurator.curatorSkillExtension(doc.skillMd, item.candidate, { name: item.target.name });
    if (!ext.added) {
      // No genuinely new content (all lessons already present) — settle the
      // candidate as promoted so it isn't retried, but write nothing.
      byId.set(item.candidate.id, { ...item.candidate, status: "promoted", resolvedAt: now, promotedBy: "curator", extendedInto: item.target.name });
      continue;
    }
    const prov = knowledgeCurator.curatorExtendProvenance({
      existingProv: doc.provenance, from: "team", to: "team", teamId,
      entryIds: item.candidate.entryIds, candidate: item.candidate, now,
    });
    // #780 §3.3: default LLM synthesis on the extend path (opt-in per team) —
    // re-synthesise the whole playbook with the new lessons folded in, else keep the
    // heuristic append VISIBLY MARKED un-synthesised (curatorSkillExtension already
    // returns synthesised:false, so the append is the marked fallback either way).
    const synth = synthesizeSkills
      ? await _resolveSkillMd(env, {
        heuristicMd: ext.skillMd,
        request: knowledgeCurator.buildSkillExtensionSynthesisRequest(doc.skillMd, item.candidate),
        synthesize: true,
        frontmatter: { name: item.target.name, description: ext.description },
        binding: assistSynthBinding, // #1213: team-billed provider (null → .env)
      })
      : { skillMd: ext.skillMd, synthesised: false, note: null };
    const synthesised = synth.synthesised === true;
    try {
      const md = synth.skillMd.endsWith("\n") ? synth.skillMd : synth.skillMd + "\n";
      fs.writeFileSync(path.join(doc.dir, "SKILL.md"), md);
      fs.writeFileSync(path.join(doc.dir, "provenance.json"), JSON.stringify(prov, null, 2));
    } catch (err) {
      console.warn(`[Orchestrator] auto-extend: writing skill '${item.target.name}' failed: ${err.message}`);
      continue;
    }
    // Version bump + history (#779 AC3): the content changed, so stampSkillDir
    // increments the version and records an "extended" entry. #780: the note records
    // whether the fold was LLM-synthesised or the un-synthesised heuristic fallback.
    const nLessons = item.candidate.entryIds.length;
    try {
      skillManifest.stampSkillDir(doc.dir, {
        name: item.target.name, by: "curator", action: "extended", now,
        note: `folded ${nLessons} converged ${nLessons === 1 ? "lesson" : "lessons"} (${synthesised ? "LLM-synthesised" : "heuristic, un-synthesised"})`,
      });
    } catch (err) { console.warn(`[Orchestrator] auto-extend: stamp '${item.target.name}' failed: ${err.message}`); }
    byId.set(item.candidate.id, { ...item.candidate, status: "promoted", resolvedAt: now, promotedBy: "curator", extendedInto: item.target.name });
    extendedSkills.push({ name: item.target.name, entryIds: item.candidate.entryIds });
  }

  // Below-confidence / gated / over-cap matches become review cards that
  // pre-select extend mode with the matched target (the dialog's mode:'extend').
  const raisedCards = [];
  for (const item of plan.reviewExtend) {
    if (byId.has(item.candidate.id)) continue; // already tracked
    const card = {
      ...item.candidate,
      autoDrafted: true,
      extendMode: true,
      matchedSkill: { name: item.target.name, tier: item.target.tier || "team", score: item.target.score },
      gateReason: item.reason,
    };
    byId.set(card.id, card);
    raisedCards.push(card);
  }

  writeKnowledgeCandidates(teamId, [...byId.values()]);
  _finalizeExtendedSkills(teamId, env, extendedSkills, now);
  if (raisedCards.length > 0) {
    appendKnowledgeEvents([{
      type: "suggestion", ts: now, teamId, count: raisedCards.length,
      samples: raisedCards.slice(0, 5).map((c) => ({
        id: c.id, canonicalId: c.canonicalId, text: c.text, convergenceCount: c.convergenceCount,
        extendMode: true, matchedSkill: c.matchedSkill ? c.matchedSkill.name : null,
      })),
    }]);
  }
  return { extendedCount: extendedSkills.length, consumedCanonicalIds: plan.consumedCanonicalIds };
}

// Shared finalize for a batch of curator auto-EXTENSIONS: emit the distinguishable
// `extension` feed event (auto:true), archive the source KB entries folded in, and
// re-sync the refreshed skill content to every member that already has it active
// (the skill already exists, so — unlike a fresh promotion — this re-syncs rather
// than activates). Each side is best-effort and never rolls the write back.
function _finalizeExtendedSkills(teamId, env, extendedSkills, now) {
  if (!extendedSkills || extendedSkills.length === 0) return;
  appendKnowledgeEvents(extendedSkills.map((s) => ({
    type: "extension", ts: now, teamId, skill: { name: s.name, tier: "team" }, entryIds: s.entryIds, auto: true,
  })));
  for (const s of extendedSkills) {
    try {
      removePromotedSourceEntries(teamId, s.entryIds, { skill: { name: s.name, tier: "team" }, auto: true, env });
    } catch (err) {
      console.warn(`[Orchestrator] auto extend-cleanup for '${s.name}' (team ${teamId}) failed: ${err.message}`);
    }
  }
  if (orchestratorSingleton) {
    (async () => {
      for (const s of extendedSkills) {
        try { await orchestratorSingleton.resyncTeamSkill(teamId, s.name); }
        catch (err) { console.warn(`[Orchestrator] auto-extend resync '${s.name}' for team ${teamId} failed: ${err.message}`); }
      }
    })();
  }
}

// #781 distillation pass (§3.4): re-synthesise a whole team skill from its current
// SKILL.md + provenance. NO heuristic fallback — on LLM failure the skill is left
// BYTE-IDENTICAL (AC2). On a usable synthesis the SKILL.md is rewritten, the
// provenance entryIds are PRESERVED VERBATIM (AC1), the manifest version bumps
// (content changed), the amendment counter resets, and a `distillation` feed event is
// appended. `apply:false` (preview) NEVER writes — it returns the proposed new doc so
// the caller can render an old-vs-new diff.
//
// Returns { changed, reason, skill, old, new, entryCount, mode }.
async function _distillTeamSkill(teamId, envArg, name, { apply = true, now, auto = false } = {}) {
  const env = teamKnowledgeEnv(teamId, envArg);
  const doc = _readTeamSkillDoc(teamId, name);
  if (!doc) return { changed: false, reason: "not-found", skill: name };
  const ts = now || new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  // Resolve the skill's domain for the prompt title/audience (best-effort).
  let domain = null;
  try {
    domain = readTeamDomainsDoc(teamId).domains.find((d) => knowledgeDomains.domainSkillName(d) === name) || null;
  } catch { domain = null; }
  const request = knowledgeDistillation.buildDistillationRequest(doc.skillMd, doc.provenance, { domain });
  const assistSynthBinding = resolveAssistBindingForTeam(teamId); // #1213: team-billed synthesis provider (null → .env)
  const llmText = await _synthesizeSkillMd(env, request, assistSynthBinding); // #855: async, non-blocking
  const result = knowledgeDistillation.applyDistillation({
    skillMd: doc.skillMd, provenance: doc.provenance, llmText, by: auto ? "curator" : "operator", now: ts,
  });
  const entryCount = Array.isArray(doc.provenance.entryIds) ? doc.provenance.entryIds.length : 0;
  const base = {
    changed: result.changed, reason: result.reason, skill: name,
    old: doc.skillMd, new: result.skillMd, entryCount, mode: apply ? "applied" : "review",
  };
  if (!apply) return base;
  if (result.reason === "identical") {
    // The LLM returned the same doc: reset the counter so a manual distill doesn't
    // immediately re-fire, but don't rewrite/bump/emit.
    try { fs.writeFileSync(path.join(doc.dir, "provenance.json"), JSON.stringify(result.provenance, null, 2)); }
    catch (err) { console.warn(`[Orchestrator] distill counter-reset for '${name}' failed: ${err.message}`); }
    return base;
  }
  if (!result.changed) return base; // llm-failed → byte-identical, nothing written (AC2)
  try {
    const md = result.skillMd.endsWith("\n") ? result.skillMd : result.skillMd + "\n";
    fs.writeFileSync(path.join(doc.dir, "SKILL.md"), md);
    fs.writeFileSync(path.join(doc.dir, "provenance.json"), JSON.stringify(result.provenance, null, 2));
  } catch (err) {
    console.warn(`[Orchestrator] distill write for '${name}' (team ${teamId}) failed: ${err.message}`);
    return { ...base, changed: false, reason: "write-failed" };
  }
  try {
    skillManifest.stampSkillDir(doc.dir, {
      name, by: auto ? "curator" : "operator", action: "resynced", now: ts,
      note: `distilled ${entryCount} ${entryCount === 1 ? "lesson" : "lessons"}`,
    });
  } catch (err) { console.warn(`[Orchestrator] distill stamp for '${name}' failed: ${err.message}`); }
  appendKnowledgeEvents([knowledgeDistillation.buildDistillationEvent({
    teamId, skill: { name, tier: "team" }, mode: "applied", auto, entryCount, reason: "distilled", ts,
  })]);
  if (orchestratorSingleton) {
    orchestratorSingleton.resyncTeamSkill(teamId, name).catch((err) =>
      console.warn(`[Orchestrator] distill resync '${name}' for team ${teamId} failed: ${err.message}`));
  }
  return base;
}

// #781: after the auto-extend/promote steps, distil any team skill that accrued
// enough amendments AND whose gate/autonomy allow a direct apply (§3.4). A skill whose
// mode is 'review' waits for an operator Distill action (no auto-apply). Best-effort;
// returns the count distilled.
async function autoDistillStep(teamId, envArg, { now } = {}) {
  const env = teamKnowledgeEnv(teamId, envArg);
  const gates = resolvePromotionGates(env);
  const level = knowledgeAutonomyLevel(env);
  if (knowledgeDistillation.distillationMode(gates, { autonomyLevel: level }) !== "auto") return 0;
  const { distillAfterAmendments } = knowledgeCurationConfig(env);
  let distilled = 0;
  for (const s of readTeamSkillsForMatch(teamId)) {
    try {
      const doc = _readTeamSkillDoc(teamId, s.name);
      if (!doc) continue;
      if (!knowledgeDistillation.shouldDistill(doc.provenance, { threshold: distillAfterAmendments })) continue;
      const r = await _distillTeamSkill(teamId, env, s.name, { apply: true, now, auto: true });
      if (r && r.changed) distilled += 1;
    } catch (err) {
      console.warn(`[Orchestrator] auto-distill '${s.name}' for team ${teamId} failed: ${err.message}`);
    }
  }
  return distilled;
}

// Record an agent nomination (the `knowledge promote <id>` CLI verb). Builds a
// candidate from the entry's convergence cluster (works below threshold too),
// dedup-stable so a re-nomination never duplicates. Returns the candidate.
function nominateKnowledgeEntry(agentId, entryId, note) {
  const cfg = loadAgentConfig(agentId);
  if (!cfg) throw new Error(`Agent '${agentId}' not found`);
  const teamId = agentKnowledgeTeamId(cfg);
  const env = teamKnowledgeEnv(teamId, cfg.environmentId ? loadEnvironment(cfg.environmentId) : null); // #570: per-team knowledge config
  if (knowledgeAutonomyLevel(env) < 1) throw new Error("knowledge sharing is off for this team");

  // Refresh so the nomination sees the freshest shards, then cluster.
  try { refreshKnowledgeClone(teamId, { force: true, env }); } catch { /* best-effort */ }
  const clonePath = knowledgeFeed.canonicalClonePath(KNOWLEDGE_CLONE_ROOT, teamId);
  if (!clonePath || !fs.existsSync(path.join(clonePath, ".git"))) throw new Error("no team knowledge base yet");
  const storeRel = _kbStoreRel(env);
  const storeRoot = storeRel ? path.join(clonePath, storeRel) : clonePath;
  const manifest = _loadCloneManifest(storeRoot);
  // #603: scope to this team's squad so a nomination can never pull a co-tenant
  // team's entry (sharing the KB branch) into the resolved cluster / candidate.
  const shardEntries = knowledgeConvergence.filterEntriesToTeam(
    _readCloneShards(storeRoot, manifest),
    teamSquadMemberIds(teamId),
  );
  const { simThreshold } = knowledgeConvergenceConfig(env);
  const clusters = knowledgeConvergence.buildCanonicalProjection(shardEntries, {
    simThreshold, semantic: teamSemanticCtx(teamId, shardEntries, env),
  }).clusters;
  const cluster = clusters.find((c) => c.memberIds.includes(entryId));
  if (!cluster) throw new Error(`entry '${entryId}' not found in the team knowledge base`);

  const cand = knowledgeConvergence.toCandidate(cluster, { teamId, source: "agent-nominated", note });
  const existing = readKnowledgeCandidates(teamId);
  const idx = existing.findIndex((c) => c.id === cand.id);
  if (idx >= 0 && (existing[idx].status === "open" || existing[idx].status === "promoted")) {
    return existing[idx]; // already raised — idempotent
  }
  const next = idx >= 0 ? existing.map((c, i) => (i === idx ? cand : c)) : [...existing, cand];
  writeKnowledgeCandidates(teamId, next);
  appendKnowledgeEvents([{
    type: "suggestion", ts: cand.raisedAt, teamId, count: 1,
    samples: [{ id: cand.id, canonicalId: cand.canonicalId, text: cand.text, convergenceCount: cand.convergenceCount }],
  }]);
  return cand;
}

// #855-class fix: `git push` / `gh pr create` are network round-trips (SSH to
// GitHub, HTTPS API) that routinely take many seconds — run synchronously they
// park the single-threaded event loop and freeze every other request (admin
// API, session-log pushes, poller). Async execFile keeps the loop free; the
// per-checkout queue preserves the serialization the blocking calls provided
// implicitly, so overlapping pushes to one repo clone still never interleave.
const _repoGitQueue = agentGitOps.makeKeyedQueue();

async function _execRepo(cmd, args, { cwd, env, timeout = 30_000 }) {
  const { stdout } = await execFileP(cmd, args, { cwd, env, timeout });
  return stdout.toString();
}

// Push the agent's committed work. `body` = { repo?, branch?, remote?,
// setUpstream? }. Throws caller-facing Errors (safe to return over the API).
async function agentGitPush(id, env, body = {}) {
  const repo = agentGitOps.resolveAgentRepo({
    repositories: env?.repositories,
    requestedRepo: body.repo,
    agentWorkspace: agentDir(id),
  });
  const req = agentGitOps.normalizePushRequest(body);
  const gitEnv = _buildAgentGitEnv(id, repo, env);
  return _repoGitQueue(repo.repoPath, () => _agentGitPushLocked(id, repo, req, gitEnv, body));
}

async function _agentGitPushLocked(id, repo, req, gitEnv, body) {
  const run = (args, timeout = 30_000) =>
    _execRepo("git", args, { cwd: repo.repoPath, env: gitEnv, timeout });

  let branch = req.branch;
  if (!branch) {
    branch = (await run(["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    if (branch === "HEAD") {
      throw new Error("workspace is in detached HEAD — check out a branch before pushing");
    }
    if (agentGitOps.PROTECTED_BRANCHES.has(branch)) {
      throw new Error(`refusing to push protected branch '${branch}' — open a PR from a feature branch`);
    }
  }

  const pushArgs = ["push"];
  if (req.setUpstream) pushArgs.push("--set-upstream");
  pushArgs.push(req.remote, branch);

  try {
    const stdout = await run(pushArgs);
    // PR-link record (#655 §4.2): a bare branch push carries no PR number, but
    // the correlationId↔branch binding corroborates the branch-tier (C) join if a
    // PR is later opened on this head another way. Best-effort, never blocks.
    const cfg = loadAgentConfig(id) || {};
    prEventsLog.record({
      ts: new Date().toISOString(),
      kind: "branch-pushed",
      agentId: id,
      teamId: cfg.parentTeamId || cfg.teamId || null,
      // Normalize to owner/name so artifact keys match the poller's github.repo
      // (tier B) — the git remote URL carries the owner; repo.name is the short
      // clone-dir name only.
      repo: prEventsLog.repoFullName(repo.url) || repo.name,
      branch,
      correlationId: body.correlationId != null ? String(body.correlationId) : null,
    });
    return {
      ok: true,
      repo: repo.name,
      branch,
      remote: req.remote,
      output: agentGitOps.sanitizeGitOutput(stdout).trim(),
    };
  } catch (err) {
    const detail = agentGitOps
      .sanitizeGitOutput((err.stderr || err.stdout || err.message || "").toString())
      .trim()
      .slice(0, 500);
    const e = new Error(`git push failed: ${detail}`);
    e.gitFailed = true;
    throw e;
  }
}

// Push the current branch, then open a PR via `gh`. `body` = { repo?, title,
// body?, base?, head?, draft? }. Stamps the agent marker into the PR body so the
// GitHub poller can attribute the resulting events (loop protection).
async function agentCreatePr(id, env, body = {}) {
  const repo = agentGitOps.resolveAgentRepo({
    repositories: env?.repositories,
    requestedRepo: body.repo,
    agentWorkspace: agentDir(id),
  });
  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!title) throw new Error("pr title is required");

  const base = body.base != null ? String(body.base) : null;
  if (base !== null && !agentGitOps.isValidBranchName(base)) {
    throw new Error(`invalid base branch: ${base}`);
  }

  // #1569: opening a PR is an attributed write — resolve the owner's personal
  // PAT (personal → team → system), refusing rather than acting under a shared
  // identity when an owner is set but has no usable personal token. No owner
  // (AC8) ⇒ the env's shared token, unchanged.
  const { githubTokenId } = resolveAttributedGithubToken(id, env, "pr");
  const gitEnv = _buildAgentGitEnv(id, repo, env, { githubTokenId });
  return _repoGitQueue(repo.repoPath, () =>
    _agentCreatePrLocked(id, env, repo, title, base, gitEnv, body, githubTokenId));
}

async function _agentCreatePrLocked(id, env, repo, title, base, gitEnv, body, githubTokenId = null) {
  const run = (args, timeout = 30_000) =>
    _execRepo("git", args, { cwd: repo.repoPath, env: gitEnv, timeout });

  let head = body.head != null ? String(body.head) : (await run(["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  if (head === "HEAD") {
    throw new Error("workspace is in detached HEAD — check out a branch before opening a PR");
  }
  if (!agentGitOps.isValidBranchName(head)) throw new Error(`invalid head branch: ${head}`);
  if (agentGitOps.PROTECTED_BRANCHES.has(head)) {
    throw new Error(`refusing to open a PR from protected branch '${head}'`);
  }

  // Ensure the branch exists on the remote before gh reads it.
  try {
    await run(["push", "--set-upstream", "origin", head]);
  } catch (err) {
    const detail = agentGitOps
      .sanitizeGitOutput((err.stderr || err.stdout || err.message || "").toString())
      .trim()
      .slice(0, 500);
    const e = new Error(`git push failed (needed before PR): ${detail}`);
    e.gitFailed = true;
    throw e;
  }

  // The branch is now on the remote (SSH or PAT — whichever the env carries).
  // `gh pr create` additionally needs a GitHub PAT. Pre-check it here so a
  // missing/unresolvable token surfaces as a distinct, actionable error rather
  // than an opaque `gh` auth failure indistinguishable from a real git reject.
  // Note this gate is only on the PR step — SSH `push` never reaches here.
  // Validate the token that will ACTUALLY be used — the personal one when
  // #1569 resolution overrode the env's shared id — not merely env.githubTokenId.
  const tokenStatus = agentGitOps.githubTokenStatus({
    env,
    githubTokenId: githubTokenId || undefined,
    ghTokensDir: GH_TOKENS_DIR,
  });
  if (!tokenStatus.resolvable) {
    const e = new Error(
      `no GitHub token available to open a PR for agent '${id}' ` +
      `(environment '${env?.id || "none"}', reason: ${tokenStatus.reason}). ` +
      `The branch '${head}' was pushed successfully — attach a GitHub PAT to the ` +
      `environment, or open the PR manually with 'gh pr create --head ${head}'.`,
    );
    e.noGithubToken = true;
    e.branchPushed = head;
    throw e;
  }

  const marker = `<!-- agent: ${id} -->`;
  let prBody = typeof body.body === "string" ? body.body : "";
  if (!prBody.includes(marker)) prBody = `${prBody.trimEnd()}\n\n${marker}\n`;
  const tmp = path.join(repo.repoPath, `.agent-studio-pr-body-${Date.now()}.md`);
  fs.writeFileSync(tmp, prBody);

  try {
    const ghArgs = ["pr", "create", "--title", title, "--body-file", tmp, "--head", head];
    if (base) ghArgs.push("--base", base);
    if (body.draft) ghArgs.push("--draft");
    const out = await _execRepo("gh", ghArgs, { cwd: repo.repoPath, env: gitEnv });
    const url = (out.match(/https?:\/\/\S+/) || [])[0] || null;
    // PR-link record (#655 §4.2, tier A): the exact "which run created this PR"
    // fact. prNumber from the URL just parsed; closes[] for the artifact graph
    // (§3.1) from the PR body (which we stamped above) + the head branch name;
    // correlationId via the AEE_CORRELATION_ID passthrough (null when absent, then
    // tier C covers attribution). Best-effort — a log hiccup must not fail the PR.
    const cfg = loadAgentConfig(id) || {};
    prEventsLog.record({
      ts: new Date().toISOString(),
      kind: "pr-created",
      agentId: id,
      teamId: cfg.parentTeamId || cfg.teamId || null,
      // owner/name (tier B artifact-key parity) — prefer the created PR URL, which
      // always carries the owner, then the git remote URL, then the short name.
      repo: prEventsLog.repoFullName(url) || prEventsLog.repoFullName(repo.url) || repo.name,
      prNumber: prEventsLog.parsePrNumber(url),
      url,
      branch: head,
      base: base || null,
      closes: prEventsLog.parseCloses(prBody, head),
      correlationId: body.correlationId != null ? String(body.correlationId) : null,
    });
    return { ok: true, repo: repo.name, branch: head, base: base || null, url };
  } catch (err) {
    const detail = agentGitOps
      .sanitizeGitOutput((err.stderr || err.stdout || err.message || "").toString())
      .trim()
      .slice(0, 500);
    const e = new Error(`gh pr create failed: ${detail}`);
    e.gitFailed = true;
    throw e;
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* best effort */ }
  }
}

// ── PR-merge token comment (#678, Phase 3 item 2) ───────────────────────────
//
// Wired as the poller's `onMergedPr` callback: fired once per merged PR. Thin
// shell (AC8) over the tested pure modules — resolve the repo's team + token,
// gate on the per-team opt-in (OFF by default, AC4), reuse the Phase-2 work-item
// aggregation to compute the summary (reuse, do not re-implement), then post a
// single identity-stamped, idempotent comment (AC1–3, 5–7). Fully best-effort:
// any failure logs and returns — a merge event must never be disrupted by this.

// Resolve the environment (hence GitHub token + owning team) for a polled repo,
// mirroring the poller's own "first environment referencing the repo wins" rule.
// Returns { token, teamId, envId } or null when unresolvable.
function _resolveRepoCommentContext(repoFullName) {
  let envIds;
  try {
    envIds = fs.readdirSync(ENVIRONMENTS_DIR).filter((n) => !n.startsWith("_"));
  } catch {
    return null;
  }
  for (const envId of envIds) {
    const env = loadEnvironment(envId);
    if (!env || !env.githubTokenId) continue;
    const repos = Array.isArray(env.repositories) ? env.repositories : [];
    const match = repos.some((r) => ghParseRepoFullName(r && r.url) === repoFullName);
    if (!match) continue;
    let token;
    try {
      token = fs.readFileSync(path.join(GH_TOKENS_DIR, env.githubTokenId), "utf8").trim();
    } catch {
      continue;
    }
    if (!token) continue;
    // Owning team: the first agent bound to this env (a team shares one env).
    let teamId = null;
    for (const id of listAgentIds()) {
      const cfg = loadAgentConfig(id);
      if (cfg && cfg.environmentId === envId) { teamId = agentKnowledgeTeamId(cfg); break; }
    }
    return { token, teamId, envId };
  }
  return null;
}

// ── Parent-ticket binding (#1383) ──────────────────────────────────────────
// A ticket binds an agent chat room to a parent GitHub issue. The authoritative
// room-scoped binding + the session-log event live in admin-console (api.js);
// here we own the GitHub round-trip and the workspace-root `ticket.json` (AC8)
// that a running agent reads on its next invocation. Pure parsing/shapes are in
// `ticket-store.js` (unit-tested); these are the thin fs/network adapters.

// Contained path to an agent's workspace-root ticket.json. `id` is already
// isSafePathSeg-validated by every caller; the path.relative return-value check
// is the CodeQL-legible containment barrier (mirrors api.js safeSessionPath).
function agentTicketPath(id) {
  const base = path.resolve(AGENTS_DIR);
  const full = path.resolve(base, id, "ticket.json");
  const rel = path.relative(base, full);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return full;
}

function readAgentTicket(id) {
  const fp = agentTicketPath(id);
  if (!fp || !fs.existsSync(fp)) return null;
  try {
    const t = JSON.parse(fs.readFileSync(fp, "utf8"));
    return ticketStore.isValidTicket(t) ? t : null;
  } catch {
    return null;
  }
}

function writeAgentTicket(id, ticket) {
  const fp = agentTicketPath(id);
  if (!fp) throw new Error("bad agent id");
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  const tmp = fp + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(ticket, null, 2));
  fs.renameSync(tmp, fp);
}

function deleteAgentTicket(id) {
  const fp = agentTicketPath(id);
  if (!fp) return;
  try {
    fs.unlinkSync(fp);
  } catch {
    /* already gone */
  }
}

// Resolve the GitHub token + declared repo full-names for an agent's env.
// Returns null when the agent has no GitHub-enabled environment.
function resolveAgentGithub(id) {
  const cfg = loadAgentConfig(id);
  const env = cfg && cfg.environmentId ? loadEnvironment(cfg.environmentId) : null;
  if (!env || !env.githubTokenId) return null;
  let token;
  try {
    token = fs.readFileSync(path.join(GH_TOKENS_DIR, env.githubTokenId), "utf8").trim();
  } catch {
    return null;
  }
  if (!token) return null;
  const repos = Array.isArray(env.repositories)
    ? env.repositories
    : env.repository
      ? [env.repository]
      : [];
  const envRepoFullNames = repos.map((r) => ghParseRepoFullName(r && r.url)).filter(Boolean);
  return { token, envRepoFullNames };
}

function _ticketErr(message, statusCode) {
  const e = new Error(message);
  e.statusCode = statusCode;
  return e;
}

// Bind a parent ticket to an agent (create a new issue or attach an existing
// one), then materialise ticket.json at the workspace root. Returns the stored
// ticket; throws a `statusCode`-tagged Error on a client/GitHub failure.
async function bindAgentTicket(id, body) {
  const gh = resolveAgentGithub(id);
  if (!gh) throw _ticketErr("agent has no GitHub-enabled environment", 400);
  const explicitRepo = body && typeof body.repo === "string" ? body.repo : null;
  const mode = body && body.mode === "create" ? "create" : "attach";
  let ticket;

  if (mode === "create") {
    const title = body && typeof body.title === "string" ? body.title.trim() : "";
    if (!title) throw _ticketErr("title is required", 400);
    const repoFullName = ticketStore.resolveRepoFullName(null, {
      explicitRepo,
      envRepoFullNames: gh.envRepoFullNames,
    });
    if (!repoFullName) throw _ticketErr("no target repository for this environment", 400);
    const args = [`repos/${repoFullName}/issues`, "--method", "POST", "-f", `title=${title}`];
    if (body && typeof body.issueBody === "string" && body.issueBody) {
      args.push("-f", `body=${body.issueBody}`);
    }
    let issue;
    try {
      issue = JSON.parse(await _ghApi(gh.token, args));
    } catch (err) {
      throw _ticketErr(`GitHub issue create failed: ${err.message}`, 502);
    }
    ticket = ticketStore.ticketFromIssue(issue, repoFullName);
  } else {
    const parsed = ticketStore.parseIssueRef(body && body.ref);
    if (!parsed) throw _ticketErr("ref must be an issue number or a GitHub issue URL", 400);
    const repoFullName = ticketStore.resolveRepoFullName(parsed, {
      explicitRepo,
      envRepoFullNames: gh.envRepoFullNames,
    });
    if (!repoFullName) throw _ticketErr("no target repository for this environment", 400);
    let issue;
    try {
      issue = await _flowGithubGetJson(`/repos/${repoFullName}/issues/${parsed.number}`, gh.token);
    } catch (err) {
      throw _ticketErr(`issue not found or not accessible: ${err.message}`, 404);
    }
    ticket = ticketStore.ticketFromIssue(issue, repoFullName);
  }

  if (!ticket) throw _ticketErr("could not resolve the issue", 502);
  writeAgentTicket(id, ticket);
  return ticket;
}

// gh api helper bound to a token — no repo checkout needed (`gh api` works from
// anywhere). Returns stdout string; throws on non-zero exit. Async for the same
// reason as _execRepo above: a gh network round-trip must not park the loop.
async function _ghApi(token, args, input) {
  const env = { ...process.env, GH_TOKEN: token, GITHUB_TOKEN: token };
  const pending = execFileP("gh", ["api", ...args], {
    env,
    timeout: 30_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  if (input !== undefined) pending.child.stdin.end(input);
  const { stdout } = await pending;
  return stdout.toString();
}

async function postPrTokenComment(repoFullName, prNumber, _ghEvent) {
  try {
    const ctx = _resolveRepoCommentContext(repoFullName);
    if (!ctx) return; // no token/env for this repo — can't post, nothing to do

    // AC4 — opt-in, OFF by default. Skip silently unless the owning team enabled it.
    if (!ctx.teamId || !prCommentConfig.isPrMergeCommentEnabled(WORKSPACE, ctx.teamId)) return;

    // Reuse the Phase-2 aggregation (§3) to resolve the work item + its summary.
    const usage = usageRecordsReader.readUsageRecords();
    const prEvents = usageRecordsReader.readPrEvents();
    const detail = workItemDetail(usage, prEvents, repoFullName, prNumber, {});

    // AC6 — a PR mapping to no work item yields the labelled "unattributed" note,
    // never a wrong/empty total. The formatter decides which body to render.
    const { body: summaryBody } = prTokenComment.formatPrTokenComment({ repo: repoFullName, prNumber, detail });

    // AC5 — identity-stamp like gh-as-agent does (invisible HTML comment). The
    // poster is the team agent; loop-protection is frequency-only, and posting a
    // comment does not re-fire the merge callback, so no self-trigger.
    const idMarker = `<!-- agent: ${ctx.teamId} -->`;
    const body = summaryBody.includes(idMarker) ? summaryBody : `${summaryBody}\n${idMarker}\n`;

    // AC7 — idempotent update-or-skip. List existing PR comments and look for our
    // stable marker; PATCH if the content changed, skip if identical, else create.
    let existing = null;
    try {
      const raw = await _ghApi(ctx.token, [`repos/${repoFullName}/issues/${prNumber}/comments`, "--paginate"]);
      existing = prTokenComment.findExistingComment(JSON.parse(raw));
    } catch (err) {
      console.error(`[PR-token-comment] ${repoFullName}#${prNumber}: could not list comments: ${err.message}`);
      // If we can't confirm absence, do NOT create — risking a duplicate is worse
      // than skipping (AC7). Bail out.
      return;
    }

    if (existing) {
      if (typeof existing.body === "string" && existing.body.trim() === body.trim()) return; // no change
      await _ghApi(ctx.token, [`repos/${repoFullName}/issues/comments/${existing.id}`, "--method", "PATCH", "-f", `body=${body}`]);
      console.log(`[PR-token-comment] ${repoFullName}#${prNumber}: updated existing comment ${existing.id}`);
    } else {
      await _ghApi(ctx.token, [`repos/${repoFullName}/issues/${prNumber}/comments`, "--method", "POST", "-f", `body=${body}`]);
      console.log(`[PR-token-comment] ${repoFullName}#${prNumber}: posted token-usage comment`);
    }
  } catch (err) {
    console.error(`[PR-token-comment] ${repoFullName}#${prNumber}: ${err.message}`);
  }
}

// ── Deterministic Workspace Git panel action (issue #648) ──────────────────
//
// Operator-triggered, no LLM: switch the local branch, fast-forward-update the
// current branch, or discard local changes for one repo in the agent's
// workspace. Called by the admin-console proxy after it re-checks that the
// agent has no running session (AC7). Hard guardrails:
//   - switch / update refuse while the working tree is dirty (AC4/AC5)
//   - discard is the only path that destroys uncommitted work (AC6)
//   - update only ever fast-forwards; a diverged branch is refused, never
//     merged or rebased (AC3 + edge cases)
//   - only the selected repo is touched (AC8)
//
// Throws caller-facing Errors; `err.gitFailed = true` marks the ones the API
// should surface as a 409 (dirty / diverged / git failure) rather than a 400
// (bad request / config).
function performGitPanelAction(id, env, body = {}) {
  const { action, repoPath, branch } = gitPanelOps.normalizeGitAction(body);
  const repoDir = gitPanelOps.resolveWorkspaceRepoDir({
    agentWorkspace: agentDir(id),
    repoPath,
  });

  const baseGitEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
    GIT_OPTIONAL_LOCKS: "0",
  };
  const runRaw = (args, { env: e = baseGitEnv, timeout = 15_000 } = {}) =>
    execFileSync("git", args, { cwd: repoDir, env: e, stdio: "pipe", timeout }).toString();
  const tryRun = (args, opts) => {
    try {
      return { ok: true, out: runRaw(args, opts) };
    } catch (err) {
      const detail = agentGitOps
        .sanitizeGitOutput((err.stderr || err.stdout || err.message || "").toString())
        .trim()
        .slice(0, 500);
      return { ok: false, detail };
    }
  };
  const fail = (msg) => {
    const e = new Error(msg);
    e.gitFailed = true;
    return e;
  };

  // Current state — branch, detached-HEAD, dirty.
  const curBranchRes = tryRun(["rev-parse", "--abbrev-ref", "HEAD"]);
  const currentBranch = curBranchRes.ok ? curBranchRes.out.trim() : null;
  const detached = currentBranch === "HEAD" || currentBranch === null;
  const dirtyRes = tryRun(["status", "--porcelain"]);
  const dirty = dirtyRes.ok ? dirtyRes.out.trim().length > 0 : false;

  if (action === "discard") {
    // The only action that removes uncommitted work: reset tracked changes to
    // HEAD, then remove untracked files + directories.
    const r1 = tryRun(["reset", "--hard", "HEAD"]);
    if (!r1.ok) throw fail(`discard failed: ${r1.detail}`);
    const r2 = tryRun(["clean", "-fd"]);
    if (!r2.ok) throw fail(`discard failed: ${r2.detail}`);
    return {
      ok: true,
      action,
      repoPath,
      branch: currentBranch,
      message: "Discarded all uncommitted changes.",
    };
  }

  if (action === "switch") {
    if (dirty) {
      throw fail(
        "repository has uncommitted changes — discard them or ask the agent to commit before switching branches",
      );
    }
    if (branch === currentBranch) {
      return {
        ok: true,
        action,
        repoPath,
        branch,
        noop: true,
        message: `Already on '${branch}'.`,
      };
    }
    // Local branch must already exist (refs/heads). We never create a branch
    // or check out a remote-tracking ref here.
    const verify = tryRun(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
    if (!verify.ok || !verify.out.trim()) {
      throw fail(`no local branch named '${branch}'`);
    }
    const co = tryRun(["checkout", branch]);
    if (!co.ok) throw fail(`branch switch failed: ${co.detail}`);
    return { ok: true, action, repoPath, branch, message: `Switched to '${branch}'.` };
  }

  // action === "update" → fetch + fast-forward pull of the current branch.
  if (dirty) {
    throw fail("repository has uncommitted changes — resolve them before updating");
  }
  if (detached) {
    throw fail("workspace is in detached HEAD — check out a branch before updating");
  }

  const remoteRes = tryRun(["remote", "get-url", "origin"]);
  if (!remoteRes.ok) {
    return {
      ok: true,
      action,
      repoPath,
      branch: currentBranch,
      message: "No remote configured — nothing to update.",
    };
  }
  const remoteUrl = remoteRes.out.trim();
  // #2067 AC18: the Git panel's update acts on whatever `.git` it finds in the
  // workspace, which now includes agent-scoped repositories. Their SSH key is
  // recorded on the AGENT, not the environment, so both lists have to be
  // offered here or an agent-scoped SSH repo would fail to fetch with no key.
  const matched = gitPanelOps.matchEnvRepoByRemote(remoteUrl, [
    ...(Array.isArray(env?.repositories) ? env.repositories : []),
    ...normalizeAgentRepositories((loadAgentConfig(id) || {}).agentRepositories),
  ]);
  const gitEnv = agentGitOps.buildRepoGitEnv({
    env,
    repoUrl: remoteUrl,
    sshKeyId: matched?.sshKeyId || null,
    githubTokenId: env?.githubTokenId,
    baseEnv: baseGitEnv,
    sshKeysDir: SSH_KEYS_DIR,
    ghTokensDir: GH_TOKENS_DIR,
  });

  const upstreamRes = tryRun(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  if (!upstreamRes.ok) {
    return {
      ok: true,
      action,
      repoPath,
      branch: currentBranch,
      message: "Branch has no upstream — nothing to update.",
    };
  }
  const upstream = upstreamRes.out.trim();

  const fetchRes = tryRun(["fetch", "origin"], { env: gitEnv, timeout: 60_000 });
  if (!fetchRes.ok) throw fail(`git fetch failed: ${fetchRes.detail}`);

  let ahead = 0;
  let behind = 0;
  const countRes = tryRun(["rev-list", "--left-right", "--count", "HEAD...@{u}"]);
  if (countRes.ok) {
    const parts = countRes.out.trim().split(/\s+/);
    ahead = Number(parts[0]) || 0;
    behind = Number(parts[1]) || 0;
  }
  const cls = gitPanelOps.classifyFastForward({ ahead, behind });
  if (cls.kind === "up-to-date") {
    return {
      ok: true,
      action,
      repoPath,
      branch: currentBranch,
      message: "Already up to date.",
    };
  }
  if (cls.kind === "diverged") {
    throw fail(
      `branch has diverged from ${upstream} (${ahead} local, ${behind} remote commit${behind === 1 ? "" : "s"}) — ` +
        "a fast-forward is not possible. Resolve it via the agent; merge/rebase are out of scope here.",
    );
  }

  const pullRes = tryRun(["pull", "--ff-only"], { env: gitEnv, timeout: 60_000 });
  if (!pullRes.ok) throw fail(`git pull --ff-only failed: ${pullRes.detail}`);
  return {
    ok: true,
    action,
    repoPath,
    branch: currentBranch,
    message: `Fast-forwarded ${behind} commit${behind === 1 ? "" : "s"} from ${upstream}.`,
  };
}

// Inspect every repo of an agent's environment in its workspace and report
// commit/push state. Used by the hand-off pre-flight: an agent must not push
// uncommitted work onto downstream agents that only see the repo via git.
//
// For each repo entry in `env.repositories` we resolve the workspace clone,
// run a small set of plumbing commands, and return a record with:
//
//   {
//     name, url, branch, sshKeyId,
//     path,                              // absolute path inside the orchestrator container
//     exists,                            // false → never cloned, all other fields are null
//     branchActual, head, headShort,
//     headSubject, headAuthor, headDate, // last commit metadata
//     remoteUrl,                         // `git remote get-url origin`
//     upstream,                          // tracking branch (e.g. origin/feature/x) or null
//     ahead, behind,                     // commits vs. upstream; null if no upstream
//     dirty: { staged, unstaged, untracked, files: [{path, status}] },
//     pushed,                            // true ↔ ahead === 0 && upstream !== null
//     clean,                             // true ↔ no dirty changes anywhere
//     ready,                             // clean && pushed — green light for hand-off
//     warnings: [...],                   // non-fatal notes (e.g. detached HEAD, missing upstream)
//     error,                             // present if git plumbing failed for this repo
//   }
//
// Per-repo failures are caught and surfaced via the `error` field — one bad
// repo never aborts the rest of the report.
// `extraRepos` (#2067) lets a caller add the agent's OWN attached repositories
// to the report. They are on disk exactly like an environment one, so the
// hand-off readiness gate and the removal confirmation both need their real
// dirty/unpushed state rather than a guess.
function inspectAgentRepoStatuses(agentId, env, extraRepos = []) {
  const repos = [
    ...(Array.isArray(env?.repositories) ? env.repositories : []),
    ...(Array.isArray(extraRepos) ? extraRepos : []),
  ];
  const workspace = agentDir(agentId);
  const results = [];

  for (const repo of repos) {
    if (!repo?.url) continue;
    const name = (repo.url.split("/").pop() || "repo").replace(/\.git$/, "");
    const repoPath = path.join(workspace, name);
    const base = {
      name,
      url: repo.url,
      branch: repo.branch || null,
      sshKeyId: repo.sshKeyId || null,
      path: repoPath,
      exists: false,
      branchActual: null,
      head: null,
      headShort: null,
      headSubject: null,
      headAuthor: null,
      headDate: null,
      remoteUrl: null,
      upstream: null,
      ahead: null,
      behind: null,
      dirty: { staged: 0, unstaged: 0, untracked: 0, files: [] },
      pushed: false,
      clean: false,
      ready: false,
      warnings: [],
      error: null,
    };

    if (!fs.existsSync(path.join(repoPath, ".git"))) {
      results.push(base);
      continue;
    }
    base.exists = true;

    const run = (args, opts = {}) => {
      try {
        return execFileSync("git", args, {
          cwd: repoPath,
          stdio: ["ignore", "pipe", "pipe"],
          timeout: opts.timeout || 5_000,
          env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        }).toString();
      } catch (err) {
        const detail = (err.stderr || err.stdout || err.message || "").toString().trim();
        const e = new Error(detail.slice(0, 300) || `git ${args[0]} failed`);
        e.code = err.status || 1;
        throw e;
      }
    };

    try {
      base.branchActual = run(["rev-parse", "--abbrev-ref", "HEAD"]).trim();
      if (base.branchActual === "HEAD") {
        base.warnings.push("detached HEAD — no branch checked out");
      }
      base.head = run(["rev-parse", "HEAD"]).trim();
      base.headShort = base.head.slice(0, 8);

      // %x1f = unit separator, safe across commit subjects.
      const fmt = run(["log", "-1", "--pretty=format:%s%x1f%an%x1f%aI"]).split("\x1f");
      base.headSubject = (fmt[0] || "").trim() || null;
      base.headAuthor  = (fmt[1] || "").trim() || null;
      base.headDate    = (fmt[2] || "").trim() || null;

      try { base.remoteUrl = run(["remote", "get-url", "origin"]).trim() || null; } catch { /* no origin */ }

      try {
        base.upstream = run(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]).trim();
      } catch {
        base.upstream = null;
        base.warnings.push("no upstream tracking branch");
      }

      if (base.upstream) {
        try {
          const counts = run(["rev-list", "--left-right", "--count", `${base.upstream}...HEAD`]).trim().split(/\s+/);
          base.behind = Number(counts[0] || 0);
          base.ahead  = Number(counts[1] || 0);
        } catch {
          base.warnings.push("could not compare against upstream — fetch may be needed");
        }
      }

      const porcelain = run(["status", "--porcelain=v1", "--untracked-files=all"]);
      const lines = porcelain.split("\n").filter((l) => l.length > 0);
      const files = [];
      for (const line of lines) {
        // Format: XY <path>  (X = staged, Y = unstaged; "??" = untracked)
        const code = line.slice(0, 2);
        const file = line.slice(3);
        let status;
        if (code === "??") {
          base.dirty.untracked++;
          status = "untracked";
        } else {
          if (code[0] && code[0] !== " ") base.dirty.staged++;
          if (code[1] && code[1] !== " ") base.dirty.unstaged++;
          status = code.trim();
        }
        if (files.length < 25) files.push({ path: file, status });
      }
      base.dirty.files = files;

      base.clean  = base.dirty.staged === 0 && base.dirty.unstaged === 0 && base.dirty.untracked === 0;
      base.pushed = base.upstream !== null && base.ahead === 0;
      base.ready  = base.clean && base.pushed;
    } catch (err) {
      base.error = errorMessage(err);
    }

    results.push(base);
  }

  return results;
}

// Pending-triggers queue (#185 Phase 2). The orchestrator owns this queue: all
// writers (hook server, github-poller, admin handover) funnel
// through enqueuePending, and the agent drains it (locally when on the shared
// volume; over HTTP via /pending-drain when isolated). Because every writer and
// the drain run in this single Node event loop, the read-modify-write needs no
// lock. controlOrPoolPath puts the file on /control when isolated, on the pool
// subpath otherwise (the agent's own drain location) — so it's non-breaking.
function pendingPath(id) {
  return controlOrPoolPath(id, "pending-triggers.json");
}

function enqueuePending(agentId, entry) {
  const p = pendingPath(agentId);
  let pending = [];
  try {
    if (fs.existsSync(p)) pending = JSON.parse(fs.readFileSync(p, "utf8"));
    if (!Array.isArray(pending)) pending = [];
  } catch { /* corrupt file — start over */ }
  // Stamp a stable, unique per-entry id (#724 D1) so an operator can cancel one
  // entry unambiguously. Additive: a caller that already set `id` keeps it, and
  // every other consumer (the agent's drain) simply ignores the extra field.
  pending.push({ receivedAt: new Date().toISOString(), id: crypto.randomUUID(), ...entry });
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(pending, null, 2));
  } catch (err) {
    console.error(`[Orchestrator] Cannot enqueue pending for ${agentId}: ${err.message}`);
    // Additive (#2030): report the failure so a caller that has no other trace
    // to fall back on can refuse rather than confirm. Every pre-existing caller
    // ignores the return value and is unaffected — a label emit still has its
    // mirrored GitHub label as evidence, but a direct hand-off leaves nothing
    // anywhere, so "enqueued" must not be reported for a write that failed.
    return false;
  }
  return true;
}

// #1173: pick the GitHub token an internal-channel emit uses to mirror its
// label — the first environment whose repositories contain the repo, the same
// first-env-wins rule the poller's plan applies. null when no env covers it.
function resolveRepoGithubTokenId(repoFullName) {
  const { parseRepoFullName } = require("./github-poller");
  const { githubApiBase, DEFAULT_GITHUB_API_BASE } = require("./github-api-base");
  const allowNonGithubHost = githubApiBase() !== DEFAULT_GITHUB_API_BASE;
  let envIds = [];
  try {
    envIds = fs.readdirSync(ENVIRONMENTS_DIR).filter((n) => !n.startsWith("_"));
  } catch { return null; }
  for (const envId of envIds) {
    const env = loadEnvironment(envId);
    if (!env?.githubTokenId || !/^[A-Za-z0-9._-]+$/.test(env.githubTokenId)) continue;
    const repos = Array.isArray(env.repositories)
      ? env.repositories
      : (env.repository ? [env.repository] : []);
    for (const r of repos) {
      if (parseRepoFullName(r?.url, { allowNonGithubHost }) === repoFullName) {
        return env.githubTokenId;
      }
    }
  }
  return null;
}

// #1173: mirror a label onto an issue/PR after an internal-channel delivery.
// Decoration only — the wake already went through the queue, so every failure
// here becomes a returned warning, never a delivery failure (concept §4.2
// step 3: enqueue first, stamp second). The add endpoint doesn't reliably
// auto-create labels, so on a failed add the label is created (422 = already
// exists, e.g. a lost race — fine) and the add retried once, mirroring the
// runner's claim-swap behavior.
async function stampMirrorLabel(repoFullName, number, label, warnings) {
  const tokenId = resolveRepoGithubTokenId(repoFullName);
  if (!tokenId) {
    warnings.push(`no environment with a GitHub token covers ${repoFullName} — label not stamped`);
    return false;
  }
  let token;
  try {
    token = fs.readFileSync(path.join(GH_TOKENS_DIR, tokenId), "utf8").trim();
  } catch (err) {
    warnings.push(`cannot read GitHub token '${tokenId}': ${err.message} — label not stamped`);
    return false;
  }
  const { githubApiBase } = require("./github-api-base");
  const base = githubApiBase();
  const headers = {
    "Authorization": `Bearer ${token}`,
    "Accept": "application/vnd.github+json",
    "Content-Type": "application/json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const addLabel = () => fetch(`${base}/repos/${repoFullName}/issues/${number}/labels`, {
    method: "POST", headers, body: JSON.stringify({ labels: [label] }),
  });
  try {
    let resp = await addLabel();
    if (!resp.ok) {
      await fetch(`${base}/repos/${repoFullName}/labels`, {
        method: "POST", headers,
        body: JSON.stringify({ name: label, color: "ededed", description: "internal-channel mirror label" }),
      }).catch(() => {});
      resp = await addLabel();
    }
    if (resp.ok) return true;
    warnings.push(`label stamp failed: GitHub returned ${resp.status}`);
    return false;
  } catch (err) {
    warnings.push(`label stamp failed: ${err.message}`);
    return false;
  }
}

// Read one agent's pending queue as a raw array WITHOUT draining it (#724 AC1).
// Corrupt / missing / non-array → [] (mirrors enqueue/drain; AC10). Every entry
// is returned with a guaranteed `id` (legacy entries get a deterministic one)
// but the file itself is left untouched — the view must never mutate it.
function readPendingEntries(agentId) {
  const p = pendingPath(agentId);
  let raw = [];
  try {
    if (fs.existsSync(p)) raw = JSON.parse(fs.readFileSync(p, "utf8"));
    if (!Array.isArray(raw)) raw = [];
  } catch { raw = []; }
  return pendingQueue.withIds(raw);
}

// Aggregate every agent's pending queue into one operator view (#724 AC3):
// per-agent groups with a count and summarised entries (no webhook payloads —
// AC "large payloads"). An agent with no/empty/corrupt queue contributes an
// empty group is skipped (AC10 — it's simply not a backlog). Ordered by agent
// id for a stable render.
function aggregatePendingQueue() {
  const groups = [];
  let total = 0;
  for (const agentId of listAgentIds().sort()) {
    const entries = readPendingEntries(agentId);
    if (!entries.length) continue;
    const cfg = loadAgentConfig(agentId);
    groups.push({
      agentId,
      agentName: (cfg && cfg.name) || agentId,
      count: entries.length,
      entries: entries.map((e) => pendingQueue.summarizeEntry(e)),
    });
    total += entries.length;
  }
  return { agents: groups, total };
}

// The full (un-summarised) entry for on-demand detail — includes the GitHub
// webhook payload the list view omits. Returns null when the id isn't present.
function readPendingEntry(agentId, entryId) {
  return readPendingEntries(agentId).find((e) => e.id === entryId) || null;
}

// Cancel exactly one entry by id, preserving the rest (#724 AC5). Race-free:
// the read-modify-write runs in this single event loop alongside enqueue/drain,
// so no file lock is needed (AC6). No-op (writes nothing) when the id is gone —
// e.g. the agent drained the file between view and cancel (AC7). Clearing the
// last entry leaves a valid `[]` (AC8), identical to the post-drain state.
function cancelPendingEntry(agentId, entryId) {
  const p = pendingPath(agentId);
  let raw = [];
  try {
    if (fs.existsSync(p)) raw = JSON.parse(fs.readFileSync(p, "utf8"));
    if (!Array.isArray(raw)) raw = [];
  } catch { raw = []; }
  const { entries, removed, changed } = pendingQueue.removeEntryById(raw, entryId);
  if (!changed) return { removed: false };
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(entries, null, 2));
  } catch (err) {
    console.error(`[Orchestrator] Cannot cancel pending entry for ${agentId}: ${err.message}`);
    throw err;
  }
  return { removed: true, entry: pendingQueue.summarizeEntry(removed) };
}

// Atomic read-and-clear for the agent's HTTP drain. Single-event-loop atomic.
function drainPending(agentId) {
  const p = pendingPath(agentId);
  let entries = [];
  try {
    if (fs.existsSync(p)) entries = JSON.parse(fs.readFileSync(p, "utf8"));
    if (!Array.isArray(entries)) entries = [];
  } catch { entries = []; }
  if (entries.length) {
    try { fs.writeFileSync(p, "[]"); }
    catch (err) { console.error(`[Orchestrator] drainPending clear ${agentId}: ${err.message}`); }
  }
  return entries;
}

// Pop and return ONLY the head of the pending queue, persisting the remaining
// tail (#1195 follow-up). The agent drains one entry per round-trip, executes
// it (a triggered run can take many minutes), then asks for the next — so
// entries 2..N stay durably queued until their turn instead of living in the
// agent's volatile in-memory list for the whole first run. A container
// restart mid-run then loses at most the single in-flight entry (its #506
// marker flags it on next startup), never the still-queued tail. Returns null
// when the queue is empty. FIFO, matching the agent-side drain order.
function drainPendingOne(agentId) {
  const p = pendingPath(agentId);
  let entries = [];
  try {
    if (fs.existsSync(p)) entries = JSON.parse(fs.readFileSync(p, "utf8"));
    if (!Array.isArray(entries)) entries = [];
  } catch { entries = []; }
  if (!entries.length) return null;
  const head = entries.shift();
  try { fs.writeFileSync(p, JSON.stringify(entries, null, 2)); }
  catch (err) { console.error(`[Orchestrator] drainPendingOne clear ${agentId}: ${err.message}`); }
  return head;
}

// ============================================================
// Orchestrator (backend service — no Matrix routing identity)
//
// The orchestrator runs as a pure backend service: it manages the per-agent
// containers (agent-image's Python entrypoint) and exposes an internal HTTP
// API for the admin console. It holds an admin Matrix client to create/deactivate
// user accounts via the Conduwuit admin room, but does not have a chat presence.
// All human↔agent communication happens via direct messages to each agent.
// ============================================================
class Orchestrator {
  constructor() {
    this.adminClient = null;
    // Map of agentId → { config } (no per-agent Matrix clients — they run in containers)
    this.agentConfigs = new Map();
  }

  async init() {
    if (CONDUWUIT_ADMIN_TOKEN && CONDUWUIT_ADMIN_ROOM) {
      this.adminClient = new MatrixClient(
        HOMESERVER,
        CONDUWUIT_ADMIN_TOKEN,
        new SimpleFsStorageProvider(path.join(WORKSPACE, ".admin-state.json"))
      );
    } else {
      // A silent null here disables Matrix user provisioning entirely
      // (ensureMatrixUser is skipped at every call site), so members never get
      // a Matrix user and the first member login fails with M_FORBIDDEN. Log it
      // loudly — an unconfigured admin client cost a full diagnostic round trip
      // on the cold-stack e2e race (#719).
      console.warn(
        "[Orchestrator] WARNING: CONDUWUIT_ADMIN_TOKEN/ROOM missing — Matrix user provisioning disabled"
      );
    }

    fs.mkdirSync(AGENTS_DIR, { recursive: true });

    // Load all agent configs into memory
    for (const id of listAgentIds()) {
      const config = loadAgentConfig(id);
      if (config) this.agentConfigs.set(id, { config });
    }

    // Start all enabled agent containers
    await startAllEnabledAgents();

    console.log(`[Orchestrator] Backend service ready`);
    console.log(`[Orchestrator] Agents loaded: ${this.agentConfigs.size}`);
    for (const [id, { config }] of this.agentConfigs) {
      const schedInfo = config.schedule ? ` [${config.schedule}]` : "";
      // A config naming a retired/unknown role is still listed (it exists on
      // disk and the operator should see it) but marked, so the boot summary
      // doesn't read as if it were running. startAllEnabledAgents() already
      // logged the one explanatory line; this is a one-word tag, not a repeat.
      const roleInfo = isSupportedAgentRole(config.role)
        ? `(${config.role})`
        : `(${config.role} — unsupported, skipped)`;
      console.log(`  ${id}: ${config.displayName} ${roleInfo}${schedInfo}`);
    }
  }

  async deactivateMatrixUser(id) {
    if (!this.adminClient) return;
    try {
      await this.adminClient.sendMessage(CONDUWUIT_ADMIN_ROOM, {
        msgtype: "m.text",
        body: `!admin users deactivate @${id}:local`,
      });
      console.log(`[Orchestrator] Matrix user @${id}:local deactivated`);
    } catch (err) {
      console.error(`[Orchestrator] Deactivate warning for @${id}:local: ${err.message}`);
    }
  }

  // ===========================================================
  // Agent creation
  // ===========================================================
  async createAgent(id, displayName, role, systemPrompt, environmentId, extra = {}) {
    const env = loadEnvironment(environmentId);
    if (!env) {
      throw new Error(`Working Environment not found: ${environmentId}`);
    }

    // team: save a template config (no Matrix user, no process) and
    // immediately materialize the first member — unless `extra.skipFirstMember`
    // is set (used by the Team-Setup wizard, which then adds members itself
    // with role-specific overrides).
    // Owning (human) Team — the tenant this construct belongs to (#299).
    // Defaults to the default team; an explicit `extra.teamId` must reference
    // an existing team.
    const ownerTeamId = resolveOwnerTeamId(extra.teamId);

    // Human OWNER — the creating person (#2077, concept D8/§3.4/§3.5). Written
    // for `role: 'team'` and standalone `role: 'agent'` only; a `team-member`
    // deliberately gets none and resolves its owner from the parent team
    // (`resolveAgentOwnerId`). `ownerSource` records HOW the owner was decided,
    // so a real creator stays distinguishable from a D6 migration placeholder
    // (§8.2 — the migrated owner "may be wrong and must be correctable").
    const ownerFields = ownershipMigration.ownableRole(role) && extra.ownerId
      ? {
        ownerId: String(extra.ownerId),
        ownerSource: ownershipMigration.OWNER_SOURCES.includes(extra.ownerSource)
          ? extra.ownerSource
          : ownershipMigration.OWNER_SOURCE_CREATOR,
      }
      : {};

    // Skill grant is team-owned (skill-grants.js): the caller passes the
    // initial `skills` list explicitly; the environment no longer contributes.
    const grantedSkills = Array.isArray(extra.skills)
      ? extra.skills.filter((s) => typeof s === "string" && s.trim()).map((s) => s.trim())
      : [];

    if (role === "team") {
      const teamConfig = {
        id,
        displayName,
        role: "team",
        environmentId: env.id,
        teamId: ownerTeamId,
        ...ownerFields,
        systemPromptTemplate: systemPrompt || "",
        // The team's ACTIVE skill set — inherited by every member without a
        // `skillsOverride`; the lever the Knowledge activation flow writes.
        skills: grantedSkills,
        // Ordered stage names for the process graph's layered layout (#stage-order).
        // Members carry their own `stage`; the team holds the column *order* so the
        // live graph reproduces a materialised draft's stage layout.
        ...(Array.isArray(extra.stages) && extra.stages.length
          ? { stages: extra.stages.filter(s => typeof s === 'string') } : {}),
        // Authoritative gate/brake label registry (#928). Gate-ness is
        // configuration, not a naming convention, and the LIVE graph has no
        // bundle to read `labels[]` from — so the team agent holds the registry
        // (same reasoning as `stages` above) and the graph builders read the
        // `humanGate`/`brake` flags off it.
        ...(Array.isArray(extra.labels) && extra.labels.length
          ? {
            labels: extra.labels
              .filter(l => l && typeof l.name === 'string' && l.name.trim())
              .map(l => ({ name: l.name.trim(), humanGate: !!l.humanGate, brake: !!l.brake })),
          } : {}),
        // Named human roles (#987) — first-class human flow nodes, held on the
        // team agent like `stages`/`labels` (the live graph has no bundle to read
        // them from). Passed through pre-normalized by the admin console; kept as
        // objects with a string id.
        ...(Array.isArray(extra.humans) && extra.humans.length
          ? { humans: extra.humans.filter(h => h && typeof h === 'object' && typeof h.id === 'string' && h.id.trim()) }
          : {}),
        // Hill-climb collector config (#1222) — held on the team agent like
        // `stages`/`labels`; carried through materialise so an exported+re-imported
        // team keeps its collector config. Only the config keys travel (the admin
        // console normalizes via normalizeHillClimb); snapshot/applied-card state
        // is per-instance run history and never rides the bundle.
        ...(extra.hillClimb && typeof extra.hillClimb === "object" && !Array.isArray(extra.hillClimb)
          ? { hillClimb: extra.hillClimb } : {}),
        // Label suffix (#902): stored for extend-mode consistency checks and
        // Flow-Editor dialog pre-fill. Not used at runtime — labels are already
        // stamped in the member configs.
        ...(typeof extra.labelSuffix === 'string' && extra.labelSuffix ? { labelSuffix: extra.labelSuffix } : {}),
        enabled: true,
      };
      saveAgentConfig(id, teamConfig);
      this.agentConfigs.set(id, { config: teamConfig });
      console.log(`[Orchestrator] Created team ${id}`);

      if (extra.skipFirstMember) {
        return { id, team: true, firstMember: null };
      }
      const member = await this.addTeamMember(id);
      return { id, team: true, firstMember: member.id };
    }

    const password = `agent-${id}-${Date.now()}`;
    const userId = `@${id}:local`;

    if (this.adminClient) await ensureMatrixUser(this.adminClient, id, password);

    const token = await loginMatrixUser(id, password, this.adminClient);
    await setDisplayName(token, userId, displayName);

    // Seed agent workspace using the chosen environment (infrastructure) and
    // the explicitly granted skills (team-owned grant).
    const seedResult = seedAgentWorkspace(id, env, { teamId: ownerTeamId, skills: grantedSkills });

    const effectivePrompt = systemPrompt && systemPrompt.trim() ? systemPrompt : "";

    const config = {
      id,
      displayName,
      userId,
      token,
      role,
      environmentId: env.id,
      teamId: ownerTeamId,
      ...ownerFields,
      // The agent's own skill grant (team-owned skills; standalone agents
      // carry their list directly).
      skills: grantedSkills,
      // Optional fields written by the Team-Setup wizard. `team` ties the
      // agent to its sibling team-mates (used by the Layer-2 `from: team`
      // filter and by the Admin Console's team grouping). `sessionPolicy:
      // per-invocation` makes triggered runs ephemeral — see the agent-runner
      // for the runtime behavior.
      ...(extra.team ? { team: String(extra.team) } : {}),
      ...(extra.sessionPolicy === 'per-invocation' ? { sessionPolicy: 'per-invocation' } : {}),
      enabled: true,
    };
    saveAgentConfig(id, config);
    saveAgentPrompt(id, effectivePrompt, role, env);

    // Two ways to provide an initial trigger set, mutually exclusive:
    // - extra.triggers — full array, written verbatim. Used by the Team-Setup
    //   wizard which renders templates into multiple triggers per agent.
    // - extra.schedule + extra.taskPrompt — legacy single-cron path used by
    //   ad-hoc agent creation flows. Kept for backward compatibility.
    if (Array.isArray(extra.triggers) && extra.triggers.length > 0) {
      saveTriggers(id, extra.triggers);
    } else if (extra.schedule && extra.taskPrompt) {
      saveTriggers(id, [{
        id: "initial",
        type: "cron",
        enabled: true,
        cron: extra.schedule,
        description: displayName,
        prompt: extra.taskPrompt,
      }]);
    }

    this.agentConfigs.set(id, { config });
    startAgentProcess(config);

    return {
      id,
      userId,
      seeded: seedResult.seeded,
      warnings: seedResult.warnings || [],
      clones: seedResult.clones || [],
    };
  }

  // Add a new team-member to an existing team. The member is immediately
  // materialized (Matrix user + workspace + agent process).
  //
  // Without opts: member id auto-numbered (`{teamId}-1`, `{teamId}-2`, …),
  // prompt + skills inherited from the team (skills are team-owned:
  // `teamCfg.skills`, not the env — skill-grants.js).
  //
  // With opts (used by the Team-Setup wizard):
  //   - id                  — pin the member id (`<teamId>-developer`, etc.)
  //   - displayName         — override the auto-generated `Team #n`
  //   - systemPromptOverride — role-specific prompt; member config records
  //                            it in `systemPrompt`. Absent = inherit team's
  //                            `systemPromptTemplate`.
  //   - skillsOverride      — replace the team's `skills[]` for this member's
  //                            workspace. Absent = inherit `teamCfg.skills`.
  //   - mcpServersOverride  — replace env.mcpServers for this member. Same
  //                            shape as env.mcpServers ([{serverId, credentialId}]).
  //                            Absent = inherit env.mcpServers.
  //   - sessionPolicy       — `per-invocation` | `persistent` (default).
  //                            Persisted on the member config.
  //   - triggers            — full triggers.json array, written verbatim.
  async addTeamMember(teamId, opts = {}) {
    const teamCfg = loadAgentConfig(teamId);
    if (!teamCfg) throw new Error(`Team '${teamId}' not found`);
    if (teamCfg.role !== "team") {
      throw new Error(`Agent '${teamId}' is not a team (role=${teamCfg.role})`);
    }

    const env = loadEnvironment(teamCfg.environmentId);
    if (!env) throw new Error(`Working Environment '${teamCfg.environmentId}' not found`);

    let memberId, memberDisplayName;
    if (opts.id) {
      // Reject a collision with a live config OR an id whose background teardown
      // is still in flight — its config.json is already gone but its network/
      // volume/Matrix reaping may still be racing a same-id re-create (#1525/#1791).
      if (loadAgentConfig(opts.id) || agentTeardownRegistry.has(opts.id)) {
        throw new Error(`Agent '${opts.id}' already exists`);
      }
      memberId = opts.id;
      memberDisplayName = opts.displayName || opts.id;
    } else {
      // Determine next available member number and immediately reserve the
      // slot by writing a placeholder config. This prevents a TOCTOU race where
      // two concurrent POST /members requests both compute the same n before
      // either saveAgentConfig call runs.
      let n = 1;
      while (loadAgentConfig(`${teamId}-${n}`)) n++;
      memberId = `${teamId}-${n}`;
      // Auto-numbered fallback name. The parent team name is intentionally NOT
      // prepended — UIs group members under their team already, so a team
      // prefix would only duplicate the team name and bloat every label.
      memberDisplayName = opts.displayName || `Member #${n}`;
    }

    // A team-member inherits its parent team agent's owning (human) Team.
    const ownerTeamId = teamCfg.teamId || DEFAULT_TEAM_ID;

    // Deferred materialization: create the member as a STUB — config + triggers
    // only, no Matrix user, no workspace seed/clone, no process. enableAgent()
    // does the full provisioning (Matrix + clone + spawn) on first
    // activation. Lets a large
    // process (dozens of members) be laid out without dozens of clones up front.
    if (opts.materialize === false) {
      const stubConfig = {
        id: memberId,
        displayName: memberDisplayName,
        role: "team-member",
        parentTeamId: teamId,
        environmentId: teamCfg.environmentId,
        teamId: ownerTeamId,
        ...(typeof opts.systemPromptOverride === 'string' && opts.systemPromptOverride.length > 0
          ? { systemPrompt: opts.systemPromptOverride } : {}),
        ...(Array.isArray(opts.skillsOverride) ? { skillsOverride: opts.skillsOverride } : {}),
        ...(Array.isArray(opts.mcpServersOverride) ? { mcpServersOverride: opts.mcpServersOverride } : {}),
        ...(opts.sessionPolicy === 'per-invocation' ? { sessionPolicy: 'per-invocation' } : {}),
        ...(opts.dataFlow && typeof opts.dataFlow === 'object' ? { dataFlow: opts.dataFlow } : {}),
        ...(typeof opts.parentMemberId === 'string' && opts.parentMemberId ? { parentMemberId: opts.parentMemberId } : {}),
        ...(Array.isArray(opts.emits) && opts.emits.length ? { emits: opts.emits } : {}),
        // Structured OUTCOMES port (#827) — the successor to `emits`, recorded
        // verbatim for the process graph. Declarative only (no runtime effect).
        ...(opts.outcomes && typeof opts.outcomes === 'object' ? { outcomes: opts.outcomes } : {}),
        ...(opts.github && typeof opts.github === 'object' ? { github: opts.github } : {}),
        ...(Array.isArray(opts.channels) && opts.channels.length ? { channels: opts.channels } : {}),
        // Process stage band (#362 E) — so the live graph reproduces the draft's
        // stage layout after materialisation.
        ...(typeof opts.stage === 'string' && opts.stage.trim() ? { stage: opts.stage.trim() } : {}),
        enabled: false, // no token → isStub; UI shows it, enableAgent materializes it
        // A member created while its team is disabled is tagged so
        // enableTeam brings it back automatically later — see
        // docs/superpowers/specs/2026-07-31-team-wide-disable-design.md.
        ...(isTeamDisabled(teamCfg) ? { disabledByTeam: true } : {}),
      };
      saveAgentConfig(memberId, stubConfig);
      // Pre-write triggers so the materialized agent has them immediately;
      // seedAgentWorkspace never touches triggers.json, so they survive.
      if (Array.isArray(opts.triggers) && opts.triggers.length > 0) {
        saveTriggers(memberId, opts.triggers);
      }
      this.agentConfigs.set(memberId, { config: stubConfig });
      console.log(`[Orchestrator] Created team-member STUB ${memberId} (team=${teamId}, deferred — not materialized)`);
      return { id: memberId, userId: null, stub: true, materialized: false, seeded: false, warnings: [] };
    }

    saveAgentConfig(memberId, {
      id: memberId,
      displayName: memberDisplayName,
      role: "team-member",
      parentTeamId: teamId,
      environmentId: teamCfg.environmentId,
      teamId: ownerTeamId,
      enabled: false,
      _provisioning: true,
    });

    const password = `agent-${memberId}-${Date.now()}`;
    const userId = `@${memberId}:local`;

    if (this.adminClient) await ensureMatrixUser(this.adminClient, memberId, password);
    const token = await loginMatrixUser(memberId, password, this.adminClient);
    await setDisplayName(token, userId, memberDisplayName);

    const seedResult = seedAgentWorkspace(memberId, env, {
      teamId: ownerTeamId,
      // Inherit the parent team's active skill set unless the member overrides.
      skills: Array.isArray(teamCfg.skills) ? teamCfg.skills : [],
      skillsOverride: Array.isArray(opts.skillsOverride) ? opts.skillsOverride : undefined,
      mcpServersOverride: Array.isArray(opts.mcpServersOverride) ? opts.mcpServersOverride : undefined,
    });

    // Resolve effective values once, here. The member's config records ONLY
    // the override fields (when present); absence is the inherit signal that
    // team-edit propagation reads later.
    const effectivePrompt = (typeof opts.systemPromptOverride === 'string' && opts.systemPromptOverride.length > 0)
      ? opts.systemPromptOverride
      : (teamCfg.systemPromptTemplate || "");

    const memberConfig = {
      id: memberId,
      displayName: memberDisplayName,
      userId,
      token,
      role: "team-member",
      parentTeamId: teamId,
      environmentId: teamCfg.environmentId,
      teamId: ownerTeamId,
      ...(typeof opts.systemPromptOverride === 'string' && opts.systemPromptOverride.length > 0
        ? { systemPrompt: opts.systemPromptOverride } : {}),
      ...(Array.isArray(opts.skillsOverride) ? { skillsOverride: opts.skillsOverride } : {}),
      ...(Array.isArray(opts.mcpServersOverride) ? { mcpServersOverride: opts.mcpServersOverride } : {}),
      ...(opts.sessionPolicy === 'per-invocation' ? { sessionPolicy: 'per-invocation' } : {}),
      // BP data-flow ports (#379) — recorded verbatim so the live process graph
      // renders this member's dependency/artifact edges. Runtime hand-offs are
      // driven by the push triggers, not this block.
      ...(opts.dataFlow && typeof opts.dataFlow === 'object' ? { dataFlow: opts.dataFlow } : {}),
      // Parent member id for the agent-overview / live-graph hierarchy.
      ...(typeof opts.parentMemberId === 'string' && opts.parentMemberId ? { parentMemberId: opts.parentMemberId } : {}),
      // Agent-level emitted labels (label hand-offs) for the process graph.
      ...(Array.isArray(opts.emits) && opts.emits.length ? { emits: opts.emits } : {}),
      // Structured OUTCOMES port (#827) — the successor to `emits`, recorded
      // verbatim for the process graph. Declarative only (no runtime effect).
      ...(opts.outcomes && typeof opts.outcomes === 'object' ? { outcomes: opts.outcomes } : {}),
      // GitHub artifact ports (#380) — produce flags + consumed channels, recorded
      // for the process graph. Runtime consumer hand-offs are driven by the derived
      // github-event triggers, not this block.
      ...(opts.github && typeof opts.github === 'object' ? { github: opts.github } : {}),
      ...(Array.isArray(opts.channels) && opts.channels.length ? { channels: opts.channels } : {}),
      // Process stage band (#362 E) — recorded so the live graph reproduces the
      // draft's stage layout after materialisation.
      ...(typeof opts.stage === 'string' && opts.stage.trim() ? { stage: opts.stage.trim() } : {}),
      // A member created while its team is disabled comes up disabled too,
      // tagged so enableTeam brings it back automatically — see
      // docs/superpowers/specs/2026-07-31-team-wide-disable-design.md.
      ...newMemberFieldsForTeam(teamCfg),
    };
    saveAgentConfig(memberId, memberConfig);
    saveAgentPrompt(memberId, effectivePrompt, "team-member", env);

    if (Array.isArray(opts.triggers) && opts.triggers.length > 0) {
      saveTriggers(memberId, opts.triggers);
    }

    this.agentConfigs.set(memberId, { config: memberConfig });
    if (memberConfig.enabled !== false) startAgentProcess(memberConfig);

    console.log(
      `[Orchestrator] Created team-member ${memberId} (team=${teamId}` +
      `${memberConfig.systemPrompt ? ', prompt=override' : ', prompt=inherit'}` +
      `${memberConfig.skillsOverride ? ', skills=override' : ', skills=inherit'}` +
      `${memberConfig.sessionPolicy ? `, session=${memberConfig.sessionPolicy}` : ''})`
    );
    return {
      id: memberId,
      userId,
      seeded: seedResult.seeded,
      warnings: seedResult.warnings || [],
      clones: seedResult.clones || [],
    };
  }

  // Update a team's `systemPromptTemplate` and eagerly push the new value
  // to all members that inherit it (i.e. don't carry their own
  // `systemPrompt` override). Skill changes on the team's env are NOT
  // pushed — those wait for the next member rebuild (sync-on-restart).
  async updateTeamPrompt(teamId, newTemplate) {
    const teamCfg = loadAgentConfig(teamId);
    if (!teamCfg) throw new Error(`Team '${teamId}' not found`);
    if (teamCfg.role !== "team") {
      throw new Error(`Agent '${teamId}' is not a team (role=${teamCfg.role})`);
    }
    const env = loadEnvironment(teamCfg.environmentId);
    if (!env) throw new Error(`Working Environment '${teamCfg.environmentId}' not found`);

    teamCfg.systemPromptTemplate = typeof newTemplate === 'string' ? newTemplate : '';
    saveAgentConfig(teamId, teamCfg);
    this.agentConfigs.set(teamId, { config: teamCfg });

    let propagated = 0;
    const reseeded = [];
    for (const id of listAgentIds()) {
      const cfg = loadAgentConfig(id);
      if (!cfg || cfg.role !== "team-member" || cfg.parentTeamId !== teamId) continue;
      // #1511 (AC5): re-compose inheriting AND additional members; an EXCLUSIVE
      // member (its own full override) is never re-composed. An additional member
      // stores ONLY its addition in cfg.systemPrompt — composeMemberPrompt re-applies
      // the team template on top at read time here, so its stored config is untouched
      // (saveAgentPrompt writes only AGENT-PROMPT.md/CLAUDE.md, never config.systemPrompt),
      // and a later re-compose can't double the team text.
      const mode = resolvePromptMode(cfg);
      if (mode === PROMPT_MODES.EXCLUSIVE) continue;
      const ownText = typeof cfg.systemPrompt === 'string' ? cfg.systemPrompt : '';
      const composed = composeMemberPrompt(mode, teamCfg.systemPromptTemplate, ownText);
      saveAgentPrompt(id, composed, "team-member", env);
      reseeded.push(id);
      propagated++;
    }
    // Under volume isolation each member reads CLAUDE.md / AGENT-PROMPT.md from
    // its own dedicated volume, not the pool subpath just rewritten above —
    // mirror both files into each running member's volume (#185 item 5). This
    // is the one orchestrator writer that edits ALREADY-RUNNING agents without a
    // respawn; every other saveAgentPrompt is followed by startAgentProcess, so
    // the one-time seed covers it. One helper per member (distinct volumes), run
    // concurrently to bound latency on large teams. No-op when the flag is off.
    if (PER_AGENT_VOLUME && reseeded.length > 0) {
      await Promise.all(reseeded.map(id =>
        reseedAgent(id, ['AGENT-PROMPT.md', 'CLAUDE.md'])));
    }
    console.log(
      `[Orchestrator] Team ${teamId} prompt updated; pushed to ${propagated} inheriting/additional member(s)`
    );
    return { teamId, propagated };
  }

  // ── Skill activation (team-owned skills, phase 2) ─────────────────────────
  // Additive file sync, NOT a respawn: skills are static files the Claude CLI
  // reads per invocation, so copying into the live workspace is enough — no
  // container restart, no session loss (docs/knowledge-skill-activation-concept.md §4).
  // Copy the resolved skill into one agent's workspace, update its manifest,
  // rebuild its CLAUDE.md (the Skills gate may have flipped), and mirror the
  // touched files into an isolated agent's dedicated volume.
  async _syncSkillIntoWorkspace(id, cfg, skillName, { remove = false } = {}) {
    const env = cfg.environmentId ? loadEnvironment(cfg.environmentId) : null;
    const dst = path.join(agentDir(id), "skills", skillName);
    const manifest = readSeededSkills(id);
    let commandSrc = null; // resolved skill source dir, for command projection (#1796)
    if (remove) {
      // Never remove an agent-authored (agent-tier) skill: the workspace dir
      // IS the agent pool — deactivation only withdraws the grant.
      if ((manifest[skillName] || {}).tier !== "agent") {
        try { fs.rmSync(dst, { recursive: true, force: true }); }
        catch (err) { return { agentId: id, status: "error", error: err.message }; }
      }
      delete manifest[skillName];
    } else {
      // #750: resolve the team pool by the AGENT team (parentTeamId), the key
      // the curator/overlay/seed all use — NOT the member's human tenant teamId,
      // which pointed at /workspace/teams/default and made every sync miss.
      const src = resolveSkillSourceDir(skillName, agentKnowledgeTeamId(cfg), { agentId: id });
      // Machine-readable `reason` so the UI can distinguish the "pool file gone"
      // condition (recoverable via restore/re-promote, not a retry) from a
      // generic copy failure (#739 AC4).
      if (!src) return { agentId: id, status: "error", error: `skill not found in pool: ${skillName}`, reason: "source-missing" };
      commandSrc = src;
      if (path.resolve(src) !== path.resolve(dst)) {
        try { fs.cpSync(src, dst, { recursive: true, force: true }); }
        catch (err) { return { agentId: id, status: "error", error: err.message, reason: "copy-failed" }; }
      }
      manifest[skillName] = { tier: skillTierForSource(src), seededAt: new Date().toISOString(), ...skillSourceIdentity(src) };
    }
    try { writeSeededSkills(id, manifest); } catch { /* best effort */ }
    // #1796: project (or remove) this skill's bundled slash commands into
    // .claude/commands/ as an additive file sync — no respawn, exactly like the
    // skill files themselves. The namespace dir is mirrored into an isolated
    // volume alongside CLAUDE.md below.
    let commandNsRel = null;
    try {
      const commandManifest = readSeededCommands(id);
      commandNsRel = projectSkillCommands(id, skillName, commandSrc, commandManifest, { remove });
      writeSeededCommands(id, commandManifest);
    } catch (err) {
      console.warn(`[Orchestrator] command sync ${id}/${skillName}: ${err.message}`);
    }
    // Rebuild CLAUDE.md from the (already saved) config so the Skills section
    // gate + list reflect the new grant. AGENT-PROMPT.md is left untouched.
    try {
      const promptPath = path.join(agentDir(id), AGENT_PROMPT_FILENAME);
      const prompt = fs.existsSync(promptPath)
        ? fs.readFileSync(promptPath, "utf8")
        : (cfg.systemPrompt || cfg.systemPromptTemplate || "");
      saveAgentPrompt(id, prompt, cfg.role, env, cfg.blueprintId || null);
    } catch (err) {
      console.warn(`[Orchestrator] skill sync ${id}: CLAUDE.md rebuild failed: ${err.message}`);
    }
    // Mirror into the dedicated volume (no-op unless isolated + running).
    // Removal can't be mirrored file-wise — the stale copy disappears at the
    // next respawn; the rebuilt CLAUDE.md (which no longer lists the skill) IS
    // mirrored, so the agent stops being told about it immediately.
    // Mirror the skill files (add only), the rebuilt CLAUDE.md, the projected
    // command namespace dir and the commands manifest into the isolated volume.
    // On removal the stale skill/command dirs can't be file-mirrored away, but
    // the rebuilt CLAUDE.md + manifest are, and they disappear at next respawn.
    const reseedPaths = remove ? ["CLAUDE.md"] : ["skills/" + skillName, "CLAUDE.md"];
    if (commandNsRel && !remove) reseedPaths.push(commandNsRel);
    reseedPaths.push(path.join(".agent-studio", skillCommands.SEEDED_COMMANDS_FILE));
    await reseedAgent(id, reseedPaths);
    return { agentId: id, status: remove ? "removed" : "seeded" };
  }

  // (De)activate a skill for a whole team: idempotent set-insert/-remove on the
  // team agent's `skills[]`, then fan the file sync out to every materialized
  // member per planSkillSync (override members are skipped unless explicitly
  // opted in via includeMembers — opting in also records the name on their
  // skillsOverride so the grant survives the next full re-seed).
  // `onlyMembers` (#739) scopes the file sync to a subset of member ids — the
  // member-aware "Sync now" retry. It never changes the team's active list edit
  // (that stays idempotent) and never suppresses the override opt-in semantics of
  // `includeMembers`; it only narrows which members are actually (re-)synced so
  // the caller can report that member's concrete outcome.
  async setTeamSkillActive(teamId, skillName, { active = true, includeMembers = [], onlyMembers = [], auto = false } = {}) {
    const teamCfg = loadAgentConfig(teamId);
    if (!teamCfg) throw new Error(`Team '${teamId}' not found`);
    if (teamCfg.role !== "team") throw new Error(`Agent '${teamId}' is not a team (role=${teamCfg.role})`);
    if (typeof skillName !== "string" || !skillName.trim()) throw new Error("skillName required");
    const name = skillName.trim();

    const list = Array.isArray(teamCfg.skills) ? teamCfg.skills : [];
    teamCfg.skills = active
      ? (list.includes(name) ? list : [...list, name])
      : list.filter((s) => s !== name);
    saveAgentConfig(teamId, teamCfg);
    this.agentConfigs.set(teamId, { config: teamCfg });

    const members = listAgentIds()
      .map((id) => loadAgentConfig(id))
      .filter((c) => c && c.role === "team-member" && c.parentTeamId === teamId);
    const plan = planSkillSync({ members, skillName: name, includeMembers: active ? includeMembers : [] });
    const scope = Array.isArray(onlyMembers) && onlyMembers.length ? new Set(onlyMembers) : null;
    const effectivePlan = scope ? plan.filter((s) => scope.has(s.agentId)) : plan;

    const results = [];
    for (const step of effectivePlan) {
      const cfg = members.find((m) => m.id === step.agentId);
      if (step.action === "stub") {
        // Consistent by construction: the team list already carries (or no
        // longer carries) the name; the normal seed path applies it at enable.
        results.push({ agentId: step.agentId, status: "stub" });
        continue;
      }
      if (step.action === "skip-override") {
        // On deactivation an override member that carries the name keeps it —
        // its own list is its grant; on activation it is surfaced for opt-in.
        results.push({ agentId: step.agentId, status: "skipped-override" });
        continue;
      }
      if (step.action === "sync-override") {
        // Explicit opt-in: persist the name on the member's own list so the
        // grant survives the next full re-seed, then sync like an inheritor.
        if (!cfg.skillsOverride.includes(name)) {
          cfg.skillsOverride = [...cfg.skillsOverride, name];
          saveAgentConfig(step.agentId, cfg);
          this.agentConfigs.set(step.agentId, { config: cfg });
        }
      }
      results.push(await this._syncSkillIntoWorkspace(step.agentId, cfg, name, { remove: !active }));
    }
    // Cascade deactivation (skill-deletion #627): stripping the team grant leaves
    // an OVERRIDE member's own `skillsOverride` grant in place — a delete guard
    // would still see it and the skill would strand once the pool dir is gone.
    // When the caller opts a member in via includeMembers on a DEACTIVATE, remove
    // the name from that member's own list too, so the grant is fully retired.
    if (!active && includeMembers.length) {
      const optIn = new Set(includeMembers);
      for (const m of members) {
        if (!optIn.has(m.id) || !Array.isArray(m.skillsOverride) || !m.skillsOverride.includes(name)) continue;
        m.skillsOverride = m.skillsOverride.filter((s) => s !== name);
        saveAgentConfig(m.id, m);
        this.agentConfigs.set(m.id, { config: m });
        if (m.token && !results.some((r) => r.agentId === m.id && (r.status === "seeded" || r.status === "removed"))) {
          results.push(await this._syncSkillIntoWorkspace(m.id, m, name, { remove: true }));
        }
      }
    }
    console.log(
      `[Orchestrator] Team ${teamId}: skill '${name}' ${active ? "activated" : "deactivated"} — ` +
      results.map((r) => `${r.agentId}:${r.status}`).join(", ") || "no members"
    );
    // Live-feed transparency (phase 3): one lean event per (de)activation so
    // the Knowledge page's feed shows the loop closing. Best-effort. A
    // member-scoped "Sync now" retry (#739) is not a team-level toggle, so it
    // does not emit an activation event (keeps the feed a record of real
    // activate/deactivate actions, not per-member retries).
    if (!scope) appendKnowledgeEvents([{
      type: "activation",
      ts: new Date().toISOString(),
      teamId,
      skillName: name,
      active,
      auto: !!auto,
      synced: results.filter((r) => r.status === "seeded" || r.status === "removed").length,
      skipped: results.filter((r) => r.status === "skipped-override").length,
      total: results.length,
    }]);
    return { teamId, skillName: name, active, members: results };
  }

  // Refresh an ALREADY-ACTIVE team skill's files on every member that currently
  // carries it (#553, AC10/E1): re-copy the (re-synthesised) SKILL.md into each
  // seeded member's workspace and rebuild its CLAUDE.md, WITHOUT touching the
  // grant or emitting an activation event. No-op when the skill is not in the
  // team's active list, or for members that never had it seeded (a content
  // refresh must not newly seed a member). Reuses the additive activation sync.
  async resyncTeamSkill(teamId, skillName) {
    const teamCfg = loadAgentConfig(teamId);
    if (!teamCfg || teamCfg.role !== "team") return { teamId, skillName, resynced: false, members: [] };
    const name = typeof skillName === "string" ? skillName.trim() : "";
    if (!name) return { teamId, skillName, resynced: false, members: [] };
    const list = Array.isArray(teamCfg.skills) ? teamCfg.skills : [];
    if (!list.includes(name)) return { teamId, skillName: name, resynced: false, members: [] };

    const members = listAgentIds()
      .map((id) => loadAgentConfig(id))
      .filter((c) => c && c.role === "team-member" && c.parentTeamId === teamId);
    const plan = planSkillSync({ members, skillName: name, includeMembers: [] });

    const results = [];
    for (const step of plan) {
      if (step.action !== "sync" && step.action !== "sync-override") continue;
      if (!readSeededSkills(step.agentId)[name]) continue; // only members that already have it
      const cfg = members.find((m) => m.id === step.agentId);
      results.push(await this._syncSkillIntoWorkspace(step.agentId, cfg, name, { remove: false }));
    }
    console.log(`[Orchestrator] Team ${teamId}: skill '${name}' content re-synced to ${results.length} member(s)`);
    return { teamId, skillName: name, resynced: true, members: results };
  }

  // Auto-reconcile pending skill members (#776 §3). Periodic + best-effort: for
  // every team with active skills, sync any member that is GRANTED a skill but
  // missing it from its seed manifest (the `pending` state) — the distribution
  // that used to wait for a human "Sync now". Bounded by skill-reconcile's
  // attempt cap + exponential backoff, so a persistent failure (e.g. a deleted
  // source file) records its error and stops rather than looping hot. Idempotent:
  // a fully-synced team does zero work and writes nothing. The per-target outcome
  // is folded into each member's `.agent-studio/skill-reconcile.json` so the Rollout tab
  // can turn a stuck member's action into a Retry with the last error + time.
  async reconcilePendingSkills({ now = new Date().toISOString() } = {}) {
    const teamIds = listAgentIds()
      .map((id) => loadAgentConfig(id))
      .filter((c) => c && c.role === "team" && Array.isArray(c.skills) && c.skills.length)
      .map((c) => c.id);
    const summary = { synced: [], failed: [], exhausted: [] };
    for (const teamId of teamIds) {
      const teamCfg = loadAgentConfig(teamId);
      const activeSkills = Array.isArray(teamCfg.skills) ? teamCfg.skills : [];
      const members = listAgentIds()
        .map((id) => loadAgentConfig(id))
        .filter((c) => c && c.role === "team-member" && c.parentTeamId === teamId);
      const plan = skillReconcile.planTeamReconcile(
        { members, activeSkills, seededOf: readSeededSkills, stateOf: readSkillReconcileState },
        { now },
      );
      summary.exhausted.push(...plan.exhausted);
      for (const target of plan.due) {
        const cfg = members.find((m) => m.id === target.agentId);
        if (!cfg) continue;
        let ok = false; let error = null;
        try {
          // Reuse the idempotent activation sync scoped to this one member — it
          // never re-emits an activation feed event (scope set) and the team list
          // insert is a no-op (the skill is already active).
          const res = await this.setTeamSkillActive(teamId, target.skillName, { active: true, onlyMembers: [target.agentId] });
          const mine = (res.members || []).find((r) => r.agentId === target.agentId);
          ok = !!mine && mine.status === "seeded";
          if (!ok) error = (mine && (mine.error || mine.status)) || "not synced";
        } catch (err) { error = err.message; }
        const state = readSkillReconcileState(target.agentId);
        const nextEntry = skillReconcile.recordAttempt(state[target.skillName], { ok, error, now });
        if (nextEntry === null) delete state[target.skillName]; else state[target.skillName] = nextEntry;
        writeSkillReconcileState(target.agentId, state);
        (ok ? summary.synced : summary.failed).push(target);
      }
    }
    const touched = summary.synced.length + summary.failed.length;
    if (touched) {
      console.log(`[Orchestrator] skill reconcile: ${summary.synced.length} synced, ${summary.failed.length} failed, ${summary.exhausted.length} exhausted`);
    }
    return summary;
  }

  // Drift state of ONE seeded copy against the source it descends from (#629,
  // concept §2.4). Mirrors admin-console/api/skill-drift.copyDriftState on the
  // orchestrator side: hash the copy dir + the CURRENT source dir on disk and
  // compare against the anchor hash the copy recorded at seed time (the seeded
  // manifest's contentHash). A deleted source is detected by the absent SKILL.md
  // (NOT a hash of an empty dir, which would look in-sync). Returns
  // { state, sourceVersion } — `state` is one of skillManifest.DRIFT_STATES.
  _copyDriftState(id, cfg, skillName, seeded) {
    const copyDir = path.join(agentDir(id), "skills", skillName);
    // #750: same agent-team keyspace as seed/sync so a seeded team skill's drift
    // is compared against the source it was actually copied from.
    const srcDir = resolveSkillSourceDir(skillName, agentKnowledgeTeamId(cfg), { agentId: id });
    const anchor = seeded && seeded.contentHash ? seeded.contentHash : null;
    let copyHash = null;
    try { if (fs.existsSync(path.join(copyDir, "SKILL.md"))) copyHash = skillManifest.hashSkillDir(copyDir); } catch { copyHash = null; }
    let sourceCurrentHash = null;
    try { if (srcDir && fs.existsSync(path.join(srcDir, "SKILL.md"))) sourceCurrentHash = skillManifest.hashSkillDir(srcDir); } catch { sourceCurrentHash = null; }
    const state = skillManifest.classifyCopyDrift({ copyHash, sourceHash: anchor, sourceCurrentHash });
    let sourceVersion;
    try { const m = srcDir ? skillManifest.readManifest(srcDir) : null; if (m && Number.isInteger(m.version)) sourceVersion = m.version; } catch { /* unstamped */ }
    return { state, sourceVersion };
  }

  // Drift-gated resync (#629 AC3/AC4): deliver the CURRENT source content to
  // every seeded copy in scope through the SAME additive sync as activation
  // (_syncSkillIntoWorkspace: re-copy + re-stamp the seeded manifest anchor +
  // rebuild CLAUDE.md + mirror the isolated volume — no respawn). Per-copy the
  // drift is classified first: only an `outdated` copy (isResyncable) is
  // overwritten; `in-sync` is a no-op (so the whole op is idempotent — a second
  // call touches nothing); `diverged`/`conflict`/`orphaned`/`unknown` are
  // REFUSED and surfaced with a manual-path hint, never auto-overwritten (AC4).
  //
  // Scope: { name, teamId } fans out to every materialized member of the team
  // that carries the skill seeded; { name, agentId } targets one copy. Emits one
  // `skill-resynced` feed event with the member fan-out results.
  async resyncSkill({ name, teamId = null, agentId = null } = {}) {
    const skillName = typeof name === "string" ? name.trim() : "";
    if (!skillName) throw new Error("skillName required");
    if (!teamId && !agentId) throw new Error("scope required: teamId or agentId");

    // Resolve the target agent ids from the scope.
    let targetIds;
    if (agentId) {
      targetIds = [agentId];
    } else {
      targetIds = listAgentIds()
        .map((id) => loadAgentConfig(id))
        .filter((c) => c && c.role === "team-member" && c.parentTeamId === teamId)
        .map((c) => c.id);
    }

    const REFUSAL_HINT = {
      diverged: "copy edited locally — resolve manually (re-import or discard the local edit)",
      conflict: "copy and source both changed — resolve manually (re-import or discard the local edit)",
      orphaned: "source skill was deleted — restore it from the archive or detach the copy",
      unknown: "pre-manifest copy with no recorded origin — re-import to establish an anchor",
    };

    const members = [];
    for (const id of targetIds) {
      const cfg = loadAgentConfig(id);
      if (!cfg) { members.push({ agentId: id, state: "unknown", action: "refused", reason: "agent not found" }); continue; }
      const seeded = readSeededSkills(id)[skillName];
      if (!seeded) {
        // Not seeded on this copy — nothing to resync. For an explicit single
        // agent scope surface it; for a team fan-out skip silently (never had it).
        if (agentId) members.push({ agentId: id, state: "unknown", action: "refused", reason: "skill not seeded on this agent" });
        continue;
      }
      const { state, sourceVersion } = this._copyDriftState(id, cfg, skillName, seeded);
      if (skillManifest.isResyncable(state)) {
        const r = await this._syncSkillIntoWorkspace(id, cfg, skillName, { remove: false });
        members.push({ agentId: id, state, action: "resynced", status: r.status, sourceVersion });
      } else if (state === "in-sync") {
        members.push({ agentId: id, state, action: "skipped" });
      } else {
        members.push({ agentId: id, state, action: "refused", reason: REFUSAL_HINT[state] || "cannot resync automatically" });
      }
    }

    const resynced = members.filter((m) => m.action === "resynced").length;
    const skipped = members.filter((m) => m.action === "skipped").length;
    const refused = members.filter((m) => m.action === "refused").length;
    console.log(
      `[Orchestrator] resync skill '${skillName}' (${agentId ? `agent ${agentId}` : `team ${teamId}`}): ` +
      `${resynced} resynced, ${skipped} in-sync, ${refused} refused`
    );
    appendKnowledgeEvents([{
      type: "skill-resynced",
      ts: new Date().toISOString(),
      teamId: teamId || (targetIds.length ? agentKnowledgeTeamId(loadAgentConfig(targetIds[0])) : null),
      ...(agentId ? { agentId } : {}),
      skillName,
      resynced,
      skipped,
      refused,
      total: members.length,
    }]);
    return { skillName, teamId, agentId, resynced, skipped, refused, total: members.length, members };
  }

  // (De)activate a skill on a single agent (standalone / team-member):
  // idempotent grant edit + file sync, one
  // workspace. A team-member writes its own `skillsOverride` (a per-member
  // grant) rather than the team set, so the install reaches only that member.
  async setAgentSkillActive(id, skillName, { active = true } = {}) {
    const cfg = loadAgentConfig(id);
    if (!cfg) throw new Error(`Agent '${id}' not found`);
    if (cfg.role === "team") throw new Error(`Agent '${id}' is a team — use the team route`);
    if (typeof skillName !== "string" || !skillName.trim()) throw new Error("skillName required");
    const name = skillName.trim();

    // A team-member writes its own `skillsOverride` (a per-member grant), any
    // other construct writes its own `skills[]` — see planAgentGrantEdit. The
    // grant edit is what makes install/activate survive a full re-seed (AC1).
    const { field, list } = planAgentGrantEdit(cfg, name, active, loadAgentConfig);
    cfg[field] = list;
    saveAgentConfig(id, cfg);
    this.agentConfigs.set(id, { config: cfg });

    // A stub (no token) has no workspace to sync — the list edit is enough.
    const result = cfg.token
      ? await this._syncSkillIntoWorkspace(id, cfg, name, { remove: !active })
      : { agentId: id, status: "stub" };
    console.log(`[Orchestrator] Agent ${id}: skill '${name}' ${active ? "activated" : "deactivated"} (${result.status})`);
    appendKnowledgeEvents([{
      type: "activation",
      ts: new Date().toISOString(),
      teamId: agentKnowledgeTeamId(cfg),
      agentId: id,
      skillName: name,
      active,
      synced: result.status === "seeded" || result.status === "removed" ? 1 : 0,
      skipped: 0,
      total: 1,
    }]);
    return { agentId: id, skillName: name, active, result };
  }

  // ── Plugin activation (#1547) ─────────────────────────────────────────────
  // The plugin sibling of the skill activation above, and deliberately the same
  // shape: an idempotent grant edit on the agent construct, then an ADDITIVE
  // FILE SYNC into the live workspace — no respawn. A plugin CLI is a static
  // file read per invocation, exactly like a skill, and `.agent-studio/bin` is on the
  // agent's PATH from container start, so a grant becomes usable immediately
  // (docs/plugin-system-concept.md §4.5).
  //
  // What a plugin adds over a skill is the NETWORK and the TOKEN: the sidecar
  // must be reachable from this agent's per-agent network, and the workspace
  // gets a 0600 config carrying a scope token minted for the grant's
  // granularity. Both are handled by planWorkspaceSync + the runtime adapter.

  // Apply one agent's move from prevGrant to nextGrant.
  async _syncPluginIntoWorkspace(id, cfg, prevGrant, nextGrant) {
    const manifests = pluginRegistry.installedManifests();
    const plan = planWorkspaceSync({
      agentCfg: cfg,
      prevGrant,
      nextGrant,
      manifests,
      resolveScopeId,
      mintToken: (pluginId, scopeId) => pluginRuntime.mintScopeToken(pluginId, scopeId),
      networkNameFor: perAgentNetworkName,
    });

    const dir = agentDir(id);
    // Migrate a legacy `.aee/` to `.agent-studio/` before the plan's relative
    // paths (`.agent-studio/bin`, `.agent-studio/plugins`) are written, so an
    // upgraded agent's plugin CLIs/grants move with the rename instead of
    // splitting across two dirs (#1549).
    resolveAgentStateDir(dir);
    const written = [];
    const removed = [];
    const errors = [];

    for (const item of plan.write) {
      const dest = path.join(dir, item.path);
      try {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        if (item.copyFrom) {
          // `copyFrom` is the manifest's registry-relative cli.entrypoint.
          // Match on entrypoint AND cli name so two plugins shipping the same
          // relative path can't be confused for one another, and resolve the
          // absolute source through the registry so the containment check
          // happens in exactly one place.
          const cliName = path.basename(item.path);
          const manifest = Object.values(manifests).find(
            (m) => m.cli && m.cli.entrypoint === item.copyFrom && m.cli.name === cliName,
          );
          const src = manifest ? pluginRegistry.cliEntrypointPath(manifest) : null;
          if (!src) { errors.push({ path: item.path, error: 'CLI entrypoint not resolvable' }); continue; }
          fs.copyFileSync(src, dest);
        } else {
          fs.writeFileSync(dest, `${JSON.stringify(item.content, null, 2)}\n`);
        }
        // chmod AFTER write: writeFileSync's mode option is masked by umask,
        // and the token config must be 0600 exactly.
        fs.chmodSync(dest, item.mode);
        written.push(item.path);
      } catch (err) {
        errors.push({ path: item.path, error: err.message });
      }
    }

    for (const rel of plan.remove) {
      try {
        fs.rmSync(path.join(dir, rel), { force: true });
        removed.push(rel);
      } catch (err) {
        errors.push({ path: rel, error: err.message });
      }
    }

    // ── Command-only plugin provisioning (#1798) ──────────────────────────
    // Plugins with `commands` field ship .claude/commands/* files (same
    // additive-sync seam as skill commands, #1796). planWorkspaceSync skips
    // them (no bin/config), so we project/unproject them here.
    const commandReseedPaths = [];
    try {
      const seededCmds = readSeededCommands(id);
      const prevPluginIds = new Set((prevGrant || []).map((g) => g.id));
      const nextPluginIds = new Set((nextGrant || []).map((g) => g.id));

      for (const [pluginId] of Object.entries(manifests)) {
        const pm = manifests[pluginId];
        if (!pm || !pm.commands) continue;
        const namespace = pm.commands.namespace || pluginId;
        const inNext = nextPluginIds.has(pluginId);
        const inPrev = prevPluginIds.has(pluginId);
        if (inNext && !inPrev) {
          // Fresh grant: project this plugin's commands + any fetched scaffold
          // (the runnable `.specify/` project layout, #1865) into the workspace.
          const { dir: pDir } = pluginRegistry.readPluginManifest(pluginId);
          const nsRel = projectSkillCommands(id, namespace, pDir, seededCmds, {
            seededAt: new Date().toISOString(),
          });
          if (nsRel) commandReseedPaths.push(nsRel);
          commandReseedPaths.push(...projectPluginScaffold(id, pDir, pm, { remove: false }));
        } else if (!inNext && inPrev) {
          // Revocation: remove the plugin's projected commands + scaffold.
          const { dir: pDir } = pluginRegistry.readPluginManifest(pluginId);
          const nsRel = projectSkillCommands(id, namespace, null, seededCmds, { remove: true });
          if (nsRel) commandReseedPaths.push(nsRel);
          commandReseedPaths.push(...projectPluginScaffold(id, pDir, pm, { remove: true }));
        }
      }
      writeSeededCommands(id, seededCmds);
    } catch (err) {
      console.warn(`[Orchestrator] plugin command sync ${id}: ${err.message}`);
    }

    // Rebuild CLAUDE.md so the Plugin Capabilities gate + lines match the new
    // grant (the config is already saved by the caller, as for skills).
    try {
      const env = cfg.environmentId ? loadEnvironment(cfg.environmentId) : null;
      const promptPath = path.join(dir, AGENT_PROMPT_FILENAME);
      const prompt = fs.existsSync(promptPath)
        ? fs.readFileSync(promptPath, "utf8")
        : (cfg.systemPrompt || cfg.systemPromptTemplate || "");
      saveAgentPrompt(id, prompt, cfg.role, env, cfg.blueprintId || null);
    } catch (err) {
      console.warn(`[Orchestrator] plugin sync ${id}: CLAUDE.md rebuild failed: ${err.message}`);
    }

    await reseedAgent(id, ["CLAUDE.md", ".agent-studio", ...commandReseedPaths]);
    return { agentId: id, status: errors.length ? "error" : "synced", written, removed, errors };
  }

  // Reconnect every touched plugin's sidecar to exactly the per-agent networks
  // its current grant implies. Reconciled from truth rather than applied as a
  // delta, so a missed event or a manual disconnect self-heals on the next
  // grant edit.
  async _reconcilePluginNetworks(pluginIds) {
    const results = [];
    const configs = listAgentIds().map((id) => loadAgentConfig(id)).filter(Boolean);
    for (const pluginId of new Set(pluginIds)) {
      const granted = configs
        .filter((c) => c.token) // a stub has no container, so no network
        .filter((c) => {
          try { return !!pluginGrantFor(effectivePlugins(c, loadAgentConfig), pluginId); }
          catch { return false; }
        })
        .map((c) => c.id);
      results.push({ pluginId, ...(await pluginRuntime.reconcilePluginAttachments(pluginId, granted)) });
    }
    // A github-issues grant/revoke changes which teams the broker must hold a
    // token for — re-push its per-scope credential map (best-effort, #1633).
    if (new Set(pluginIds).has("github-issues")) {
      try { await pushGithubIssueScopeCredentials(); } catch (err) {
        console.warn(`[Orchestrator] github-issues credential push failed: ${err.message}`);
      }
    }
    return results;
  }

  // Validate that a plugin may be granted at the requested granularity. The UI
  // bounds the choice too, but the server is the authority (§4.4).
  _resolvePluginGrant(pluginId, scopeGranularity) {
    const id = typeof pluginId === "string" ? pluginId.trim() : "";
    if (!id) throw new Error("pluginId required");
    const entry = pluginRegistry.readPluginManifest(id);
    if (!entry.ok) throw new Error(`Plugin '${id}' is not installed or its manifest is invalid`);
    const granularity = scopeGranularity || defaultGranularity(entry.manifest);
    const problem = assertGranularityGrantable(entry.manifest, granularity);
    if (problem) throw new Error(problem);
    return { manifest: entry.manifest, granularity };
  }

  // (De)activate a plugin for a whole team: the grant edit lands on the team
  // agent, the file sync fans out to every materialized member — the same
  // override semantics as skills (a member with its own pluginsOverride is
  // skipped unless explicitly opted in).
  async setTeamPluginActive(teamId, pluginId, { active = true, includeMembers = [], scopeGranularity = null } = {}) {
    const teamCfg = loadAgentConfig(teamId);
    if (!teamCfg) throw new Error(`Team '${teamId}' not found`);
    if (teamCfg.role !== "team") throw new Error(`Agent '${teamId}' is not a team (role=${teamCfg.role})`);
    const { granularity } = this._resolvePluginGrant(pluginId, scopeGranularity);
    const id = pluginId.trim();

    const before = Array.isArray(teamCfg.plugins) ? teamCfg.plugins.slice() : [];
    const { field, list } = planAgentPluginGrantEdit(teamCfg, { id, scopeGranularity: granularity }, active, loadAgentConfig);
    teamCfg[field] = list;
    saveAgentConfig(teamId, teamCfg);
    this.agentConfigs.set(teamId, { config: teamCfg });

    const members = listAgentIds()
      .map((mid) => loadAgentConfig(mid))
      .filter((c) => c && c.role === "team-member" && c.parentTeamId === teamId);
    const plan = planPluginSync({ members, grant: { id, scopeGranularity: granularity }, includeMembers });

    const results = [];
    for (const step of plan) {
      if (step.action === "stub") {
        // Consistent by construction: the team list already carries (or no
        // longer carries) the grant; the normal seed path applies it at enable.
        results.push({ agentId: step.agentId, status: "stub" });
        continue;
      }
      if (step.action === "skip-override") {
        results.push({ agentId: step.agentId, status: "skipped-override" });
        continue;
      }
      const cfg = members.find((m) => m.id === step.agentId);
      if (!cfg) continue;
      // The member's grant BEFORE this edit — resolved against the team's
      // pre-edit list, so a member that inherits sees the real transition.
      const prev = effectivePlugins(cfg, (wanted) => (wanted === teamId ? { ...teamCfg, plugins: before } : loadAgentConfig(wanted)));

      if (step.action === "sync-override") {
        // Explicit opt-in: persist the grant on the member's OWN list, exactly
        // as the skill path does. Without this the sync would seed files the
        // next full re-seed silently drops, because an override member's own
        // list — not the team's — is its grant.
        const edit = planAgentPluginGrantEdit(cfg, { id, scopeGranularity: granularity }, active, loadAgentConfig);
        cfg[edit.field] = edit.list;
        saveAgentConfig(step.agentId, cfg);
        this.agentConfigs.set(step.agentId, { config: cfg });
      }

      const next = effectivePlugins(cfg, loadAgentConfig);
      results.push(await this._syncPluginIntoWorkspace(step.agentId, cfg, prev, next));
    }

    const networks = await this._reconcilePluginNetworks([id]);
    console.log(`[Orchestrator] Team ${teamId}: plugin '${id}' ${active ? "activated" : "deactivated"} (${granularity}) on ${results.length} member(s)`);
    return { teamId, pluginId: id, scopeGranularity: granularity, active, members: results, networks };
  }

  // Same for a single non-member agent (standalone / orchestrator) or for one
  // team-member overriding its team's grant.
  async setAgentPluginActive(id, pluginId, { active = true, scopeGranularity = null } = {}) {
    const cfg = loadAgentConfig(id);
    if (!cfg) throw new Error(`Agent '${id}' not found`);
    if (cfg.role === "team") throw new Error(`Agent '${id}' is a team — use the team route`);
    const { granularity } = this._resolvePluginGrant(pluginId, scopeGranularity);
    const pid = pluginId.trim();

    const prev = effectivePlugins(cfg, loadAgentConfig);
    const { field, list } = planAgentPluginGrantEdit(cfg, { id: pid, scopeGranularity: granularity }, active, loadAgentConfig);
    cfg[field] = list;
    saveAgentConfig(id, cfg);
    this.agentConfigs.set(id, { config: cfg });
    const next = effectivePlugins(cfg, loadAgentConfig);

    const result = cfg.token
      ? await this._syncPluginIntoWorkspace(id, cfg, prev, next)
      : { agentId: id, status: "stub" };
    const networks = await this._reconcilePluginNetworks([pid]);
    console.log(`[Orchestrator] Agent ${id}: plugin '${pid}' ${active ? "activated" : "deactivated"} (${granularity}) — ${result.status}`);
    return { agentId: id, pluginId: pid, scopeGranularity: granularity, active, result, networks };
  }

  // Reap a deleting agent's plugin-owned resources BEFORE its token stops being
  // honoured (§4.9). At `team` granularity the scopeId is shared, so a member's
  // deletion must NOT tear down the squad's pool — only the last holder does.
  // Best-effort throughout: an unreachable broker never blocks a deletion.
  async teardownAgentPluginScopes(id, cfg) {
    if (!cfg || !cfg.token) return [];
    let grant;
    try { grant = effectivePlugins(cfg, loadAgentConfig); } catch { return []; }
    if (!Array.isArray(grant) || grant.length === 0) return [];
    const manifests = pluginRegistry.installedManifests();

    const siblings = listAgentIds()
      .filter((other) => other !== id)
      .map((other) => loadAgentConfig(other))
      .filter(Boolean);

    const out = [];
    for (const g of grant) {
      const manifest = manifests[g.id];
      if (!manifest) continue;
      const scopeId = resolveScopeId(cfg, g.scopeGranularity);
      if (!scopeId) continue;
      const stillHeld = siblings.some((s) => {
        try {
          const sg = pluginGrantFor(effectivePlugins(s, loadAgentConfig), g.id);
          return sg && resolveScopeId(s, sg.scopeGranularity) === scopeId;
        } catch { return false; }
      });
      if (stillHeld) {
        out.push({ pluginId: g.id, scopeId, skipped: "scope-still-held" });
        continue;
      }
      try { out.push(await pluginRuntime.teardownScope(manifest, scopeId)); }
      catch (err) { out.push({ pluginId: g.id, scopeId, ok: false, error: err.message }); }
    }
    return out;
  }

  // ─── STILLED: BP-instance hand-off — decision pending in #1968 ─────────────
  //
  // Retained deliberately by epic #1961 decision R4 and phase #1962: the
  // hand-off mechanism (this candidate resolution plus the `handoverToTargets`
  // fan-out below) stays in the tree so it can be revived, but it is now
  // UNREACHABLE — it requires `role === "bp-instance"`, and #1962 removed both
  // BriefingPack roles, so no config the platform can create ever satisfies the
  // gate below. #1968 decides its future (revive against the Flow/Team model,
  // or delete); #1528 is where the idea lives on conceptually.
  //
  // One thing DID change rather than being frozen: `suggested` used to be
  // derived from the briefings dependency graph (bp-explorer's parsed brief.md
  // frontmatter → `briefings-graph.js` → `bp-event-router.findAffectedBps`),
  // and all three of those went with #1962. That enrichment is gone; the
  // shape is unchanged and `suggested` is now always empty, which is exactly
  // the behaviour the old code already degraded to whenever bp-explorer was
  // unreachable. `siblings` (which needs no graph) is untouched.
  //
  // Compute hand-off candidates for a bp-instance source agent.
  // Returns:
  //   {
  //     source: { agentId, bpId, displayName, parentOrchestratorId, briefingsPath },
  //     suggested: [],                                                   // always empty since #1962 — see above
  //     siblings:  [{ agentId, displayName, role, materialized }, ...]   // all bp-instance siblings under the same parent orchestrator (excluding source)
  //   }
  async handoverCandidates(id) {
    const cfg = loadAgentConfig(id);
    if (!cfg) throw new Error(`Agent '${id}' not found`);
    if (cfg.role !== "bp-instance") {
      throw new Error(`Agent '${id}' is not a bp-instance (role=${cfg.role})`);
    }
    const parentId = cfg.parentOrchestratorId;
    if (!parentId) throw new Error(`bp-instance '${id}' has no parentOrchestratorId`);
    const orchCfg = loadAgentConfig(parentId);
    if (!orchCfg) throw new Error(`Parent orchestrator '${parentId}' not found`);

    const source = {
      agentId: id,
      bpId: cfg.bpId || null,
      displayName: cfg.displayName || id,
      parentOrchestratorId: parentId,
      briefingsPath: orchCfg.briefingsPath || null,
    };

    // Siblings: every bp-instance stub sharing this source's parent.
    const siblings = [];
    for (const otherId of listAgentIds()) {
      if (otherId === id) continue;
      const otherCfg = loadAgentConfig(otherId);
      if (!otherCfg) continue;
      if (otherCfg.role !== "bp-instance") continue;
      if (otherCfg.parentOrchestratorId !== parentId) continue;
      siblings.push({
        agentId: otherId,
        displayName: otherCfg.displayName || otherId,
        role: "bp-instance",
        materialized: Boolean(otherCfg.token),
        bpId: otherCfg.bpId || null,
      });
    }

    // `suggested` was the briefings-graph enrichment (depends-on /
    // input-artifact edges). Its whole supply chain — bp-explorer, the
    // briefings graph and the BP event router — went with #1962, so the list is
    // now always empty. Kept in the response shape because it is what the
    // stilled UI reads, and because "siblings only" was already the documented
    // degradation whenever bp-explorer was unreachable.
    const suggested = [];

    return { source, suggested, siblings };
  }

  // Throws a team-disabled error if cfg is a team-member whose parent team
  // is currently disabled — the lockout for the team-wide disable feature
  // (docs/superpowers/specs/2026-07-31-team-wide-disable-design.md). A
  // member's own enable/disable toggle must not do anything while its team
  // is off; this guard makes that true no matter which route calls in
  // (PUT /api/agents/:id, the internal /enable|/disable routes, or any
  // future caller).
  //
  // `bypass` is for disableTeam's OWN internal per-member disableAgent()
  // calls only — never set by any external route. Without it, retrying
  // disableTeam after a partial failure (team already flipped to disabled,
  // one member still enabled because its disableAgent() call failed for an
  // unrelated reason) would deadlock: this guard would now block that same
  // member's disableAgent() forever, and it's never disabledByTeam-tagged
  // (its disable never succeeded), so enableTeam can't reach it either.
  _assertNotLockedByTeam(cfg, bypass = false) {
    if (bypass) return;
    const teamCfg = cfg.parentTeamId ? loadAgentConfig(cfg.parentTeamId) : null;
    if (isMemberLockedByTeam(cfg, teamCfg)) {
      const err = new Error(`Team '${cfg.parentTeamId}' is disabled — enable the team first`);
      err.code = 'team-disabled';
      err.teamId = cfg.parentTeamId;
      throw err;
    }
  }

  // Materialize a stub team-member agent (or re-enable a previously-active
  // one). Idempotent: a stub gets full provisioning on the first call;
  // subsequent calls just (re)spawn the agent-runner process.
  //
  // This is the deferred-team-materialization path (#1955/#1957/#1958): a
  // member created with `materialize: false` is config + triggers.json only,
  // and this method does the Matrix user, the workspace seed, the clone and
  // the container on first activation. It used to serve `bp-instance` stubs
  // too; #1962 removed that arm with the rest of the BriefingPack model and
  // deliberately left the `team-member` arm untouched.
  async enableAgent(id) {
    const cfg = loadAgentConfig(id);
    if (!cfg) throw new Error(`Agent '${id}' not found`);
    this._assertNotLockedByTeam(cfg);

    // Already-materialized agents: just flip enabled and respawn.
    if (cfg.token) {
      const updated = { ...cfg, enabled: true };
      saveAgentConfig(id, updated);
      this.agentConfigs.set(id, { config: updated });
      // Under volume isolation a previously-disabled agent keeps its dedicated
      // volume, and seedPerAgentVolume only copies into an EMPTY /dst — so a
      // prompt/skill edit made WHILE the agent was disabled (which reseedAgent
      // skipped as 'not-running') would otherwise be lost on this fast-path
      // respawn. Mirror the control-plane file set from the pool subpath now,
      // before the container starts; copying only these named paths preserves
      // agent-written memory/, .claude/projects, the git tree, and sessions/.
      // No-op when the dedicated volume is absent (#185 item 5).
      if (PER_AGENT_VOLUME) {
        await reseedPerAgentVolume(
          id, ['CLAUDE.md', 'AGENT-PROMPT.md', '.claude/settings.json', 'skills'],
        ).catch(err => console.warn(`[Orchestrator] re-enable reseed ${id}: ${err.message}`));
      }
      startAgentProcess(updated);
      return { id, materialized: false, enabled: true };
    }

    // Stub: full materialization. `team-member` is the only stub-bearing role
    // (#1962 removed the `bp-instance` arm — a leftover BP stub on an upgraded
    // stack now lands in this throw, which is the intended hard cut).
    if (cfg.role !== "team-member") {
      throw new Error(`Agent '${id}' is a stub but has unexpected role '${cfg.role}'`);
    }
    const env = loadEnvironment(cfg.environmentId);
    if (!env) throw new Error(`Working Environment '${cfg.environmentId}' not found`);

    const password = `agent-${id}-${Date.now()}`;
    const userId = `@${id}:local`;

    if (this.adminClient) await ensureMatrixUser(this.adminClient, id, password);
    const token = await loginMatrixUser(id, password, this.adminClient);
    await setDisplayName(token, userId, cfg.displayName);

    const seedResult = seedAgentWorkspace(id, env, {
      teamId: cfg.teamId || DEFAULT_TEAM_ID,
      // Resolved team-owned grant: member override wins, else the parent
      // team's skills[], else the stub's own list.
      skills: effectiveSkills(cfg, loadAgentConfig),
      mcpServersOverride: Array.isArray(cfg.mcpServersOverride) ? cfg.mcpServersOverride : undefined,
    });

    const updated = {
      ...cfg,
      userId,
      token,
      enabled: true,
    };
    saveAgentConfig(id, updated);

    // team-member: prefer the member's own systemPrompt override (recorded on
    // a deferred-materialization stub, or any inherit/override member). Only
    // fall back to the parent team template when the member has no override —
    // this is the inherit signal.
    let prompt = (typeof cfg.systemPrompt === 'string' && cfg.systemPrompt.length > 0) ? cfg.systemPrompt : '';
    if (!prompt) {
      const teamCfg = cfg.parentTeamId ? loadAgentConfig(cfg.parentTeamId) : null;
      if (!teamCfg) {
        console.warn(`[Orchestrator] team-member ${id}: parent team '${cfg.parentTeamId}' not found — reactivating with empty system prompt`);
      }
      prompt = teamCfg?.systemPromptTemplate || "";
    }
    saveAgentPrompt(id, prompt, "team-member", env);
    console.log(`[Orchestrator] Materialized team-member ${id} (team=${cfg.parentTeamId}, prompt=${cfg.systemPrompt ? 'override' : 'inherit'})`);

    this.agentConfigs.set(id, { config: updated });
    startAgentProcess(updated);
    return {
      id,
      materialized: true,
      enabled: true,
      seeded: seedResult.seeded,
      warnings: seedResult.warnings || [],
      clones: seedResult.clones || [],
    };
  }

  // Disable an agent: mark enabled=false and (depending on mode) stop its
  // process. Keeps token and workspace intact so it can be re-enabled.
  //
  // mode === undefined → if the agent is running and has active triggers or a
  //   busy session, return a warning object instead of disabling. The caller
  //   (admin-console UI) must re-call with an explicit mode.
  // mode === 'drain'  → write enabled=false immediately so no new trigger
  //   executions start, but leave the process running to let the current
  //   invocation finish naturally.
  // mode === 'abort'  → write enabled=false and kill the process right away.
  async disableAgent(id, { mode, bypassTeamLock = false } = {}) {
    const cfg = loadAgentConfig(id);
    if (!cfg) throw new Error(`Agent '${id}' not found`);
    this._assertNotLockedByTeam(cfg, bypassTeamLock);

    const isRunning = agentProcesses.has(id);

    if (!mode && isRunning) {
      const { busy: isBusy, activeTriggers } = agentBusyState(id);
      if (isBusy || activeTriggers.length > 0) {
        return {
          id,
          warning: true,
          busy: isBusy,
          activeTriggers,
        };
      }
    }

    // Write enabled=false first so drain mode takes effect immediately:
    // TriggerScheduler.execute() re-reads config.json on every trigger tick
    // and will skip new executions as soon as this write lands.
    const updated = { ...cfg, enabled: false };
    saveAgentConfig(id, updated);
    this.agentConfigs.set(id, { config: updated });

    if (mode !== 'drain') {
      // abort mode (or no active state needing drain) — kill process now.
      stopAgentProcess(id);
    }

    return { id, enabled: false };
  }

  // Members + running/busy/trigger state for the team-wide disable/enable
  // preview dialog. Read-only — makes no config changes.
  listTeamMembersWithState(teamId) {
    const teamCfg = loadAgentConfig(teamId);
    if (!teamCfg) throw new Error(`Team '${teamId}' not found`);

    const members = teamMemberConfigs(teamId)
      .map((c) => {
        const { busy, activeTriggers } = agentBusyState(c.id);
        return {
          id: c.id,
          displayName: c.displayName || c.id,
          enabled: c.enabled !== false,
          disabledByTeam: c.disabledByTeam === true,
          running: agentProcesses.has(c.id),
          busy,
          activeTriggers,
        };
      });

    return { teamId, teamEnabled: !isTeamDisabled(teamCfg), members };
  }

  // Disable every currently-enabled member of teamId in one bulk action,
  // tagging each one disabledByTeam so enableTeam later knows to bring back
  // only these — members already enabled===false are left completely
  // untouched (see docs/superpowers/specs/2026-07-31-team-wide-disable-design.md).
  // Idempotent/retry-safe: the team config is flipped to disabled=false
  // unconditionally at the end EVEN IF some members failed, so a retry after
  // a partial failure must still be able to disable the members that are
  // still enabled — bypassTeamLock:true on the per-member disableAgent()
  // call below is what makes that retry actually work (see
  // _assertNotLockedByTeam's comment for why a retry would otherwise
  // deadlock on any member left enabled by the first attempt).
  async disableTeam(teamId, { mode } = {}) {
    if (mode !== 'drain' && mode !== 'abort') {
      throw new Error("mode must be 'drain' or 'abort'");
    }
    const teamCfg = loadAgentConfig(teamId);
    if (!teamCfg) throw new Error(`Team '${teamId}' not found`);
    if (teamCfg.role !== "team") throw new Error(`Agent '${teamId}' is not a team (role=${teamCfg.role})`);

    const memberConfigs = teamMemberConfigs(teamId);
    const { toDisable, skip } = planTeamDisable(memberConfigs);

    const disabled = [];
    const failed = [];
    for (const id of toDisable) {
      try {
        await this.disableAgent(id, { mode, bypassTeamLock: true });
      } catch (err) {
        // disableAgent never touched disk (it threw before/at its own save,
        // e.g. the lockout guard or "not found") — nothing to reconcile.
        failed.push({ id, error: err.message });
        continue;
      }
      // disableAgent's own work (warning-check/mode/stop-process) is now
      // confirmed done: enabled=false is already on disk. Tag
      // disabledByTeam in one more save so enableTeam later knows to bring
      // this member back. If that save throws, the member is left
      // disabled-but-untagged and enableTeam would never find it again — so
      // best-effort roll it back to enabled here, keeping the on-disk state
      // consistent with reporting it under `failed` (never disabled).
      try {
        const cfg = loadAgentConfig(id);
        const updated = { ...cfg, disabledByTeam: true };
        saveAgentConfig(id, updated);
        this.agentConfigs.set(id, { config: updated });
        disabled.push(id);
      } catch (err) {
        try {
          const cfg = loadAgentConfig(id);
          const reverted = { ...cfg, enabled: true };
          saveAgentConfig(id, reverted);
          this.agentConfigs.set(id, { config: reverted });
        } catch (rollbackErr) {
          console.error(`[Orchestrator] team ${teamId}: member ${id} was disabled but could not be tagged disabledByTeam, AND the rollback to enabled also failed — it is now disabled without disabledByTeam tracking and needs manual re-enable: ${rollbackErr.message}`);
        }
        failed.push({ id, error: err.message });
      }
    }

    const teamUpdated = { ...teamCfg, enabled: false };
    saveAgentConfig(teamId, teamUpdated);
    this.agentConfigs.set(teamId, { config: teamUpdated });

    console.log(`[Orchestrator] team ${teamId} disabled → ${disabled.length} member(s) disabled, ${skip.length} already off, ${failed.length} failed`);
    return { teamId, disabled, skipped: skip, failed };
  }

  // Re-enable every member disableTeam previously tagged disabledByTeam.
  // Members disabled independently before the team went down, or never
  // activated, are left exactly as they are (see the design spec). The
  // team's own config flips to enabled FIRST, so the per-member
  // enableAgent() calls below don't trip their own lockout guard.
  async enableTeam(teamId) {
    const teamCfg = loadAgentConfig(teamId);
    if (!teamCfg) throw new Error(`Team '${teamId}' not found`);
    if (teamCfg.role !== "team") throw new Error(`Agent '${teamId}' is not a team (role=${teamCfg.role})`);

    const teamUpdated = { ...teamCfg, enabled: true };
    saveAgentConfig(teamId, teamUpdated);
    this.agentConfigs.set(teamId, { config: teamUpdated });

    const memberConfigs = teamMemberConfigs(teamId);
    const { toEnable, skip } = planTeamEnable(memberConfigs);

    const enabled = [];
    const failed = [];
    for (const id of toEnable) {
      try {
        await this.enableAgent(id);
        // Deliberate asymmetry vs. disableTeam's rollback: if this tag-clear
        // write fails after enableAgent() already succeeded, the member is
        // left enabled but still tagged disabledByTeam. That's harmless — the
        // member is already up and working, and the stale tag self-heals on
        // the next disable/enable cycle. disableTeam rolls back instead
        // because leaving a member disabled-and-untagged there would make it
        // invisible to future enableTeam calls, which matters more.
        const cfg = loadAgentConfig(id);
        const { disabledByTeam, ...rest } = cfg;
        saveAgentConfig(id, rest);
        this.agentConfigs.set(id, { config: rest });
        enabled.push(id);
      } catch (err) {
        failed.push({ id, error: err.message });
      }
    }

    console.log(`[Orchestrator] team ${teamId} enabled → ${enabled.length} member(s) re-enabled, ${skip.length} left as-is, ${failed.length} failed`);
    return { teamId, enabled, skipped: skip, failed };
  }

  // Re-inject an environment's credentials into every running agent bound to it.
  //
  // Credentials (GH_TOKEN/GITHUB_TOKEN from env.githubTokenId, the per-agent SSH
  // identity) are read from disk and baked into the container's environment at
  // spawn time by startAgentProcess — they are immutable for the container's
  // lifetime. So when an operator rotates the GitHub PAT (or repoints the env at
  // a different token), already-running containers keep the stale value until
  // they are recreated. This respawns each currently-running, materialized agent
  // on the env (startAgentProcess stops the old container and creates a new one
  // with a freshly-read childEnv), so the new credential takes effect without a
  // manual disable/enable. Best-effort and idempotent; disabled/stopped agents
  // are left alone (they pick up the fresh credential on their next enable).
  async respawnAgentsForEnvironment(envId, { reason } = {}) {
    if (!envId) return { envId, respawned: [], skipped: [] };
    const respawned = [];
    const skipped = [];
    for (const [id] of this.agentConfigs) {
      const cfg = loadAgentConfig(id); // fresh read — canonical on-disk config
      if (!cfg || cfg.environmentId !== envId) continue;
      if (cfg.enabled === false || !cfg.token) { skipped.push(id); continue; }
      if (!agentProcesses.has(id)) { skipped.push(id); continue; }
      try {
        this.agentConfigs.set(id, { config: cfg });
        startAgentProcess(cfg); // stops old container, recreates with fresh env
        respawned.push(id);
      } catch (err) {
        console.error(`[Orchestrator] respawn for env ${envId} failed for ${id}: ${err.message}`);
        skipped.push(id);
      }
    }
    if (respawned.length) {
      console.log(`[Orchestrator] env ${envId} credential change (${reason || 'update'}) → respawned ${respawned.length} agent(s): ${respawned.join(', ')}`);
    }
    return { envId, respawned, skipped };
  }

  // Re-inject a rotated/newly-set PERSONAL credential into its owner's running
  // agents (#1570, epic #1558 Phase 4). Fired by the admin-console after a human
  // sets or rotates their personal SSH key or GitHub token. Owner-scoped sibling
  // of respawnAgentsForEnvironment: instead of matching an environment id, it
  // matches each agent's RESOLVED human owner (credential-resolution's
  // resolveAgentOwnerId — the exact Phase-3 rule, so a team-member is respawned
  // via its parent team's owner). Personal credentials are unique per (owner,
  // kind), so every one of that human's running agents is exactly the set whose
  // resolved credential is the one that changed — including an agent that only
  // uses it for attributed writes (edge case). Same skip rules as the env path:
  // disabled / not-running / tokenless agents are left for their next enable.
  // Other humans' agents and unrelated environments are never touched (AC1/AC2/
  // AC6). Best-effort and idempotent.
  async respawnAgentsForOwner(ownerId, { reason } = {}) {
    const target = ownerId != null && String(ownerId) !== '' ? String(ownerId) : null;
    if (!target) return { ownerId: null, respawned: [], skipped: [] };
    const agents = Array.from(this.agentConfigs.keys()).map(id => ({ id, cfg: loadAgentConfig(id) }));
    const owned = credentialResolution.selectAgentIdsForOwner(agents, target, loadAgentConfig);
    const respawned = [];
    const skipped = [];
    for (const id of owned) {
      const cfg = loadAgentConfig(id); // fresh read — canonical on-disk config
      if (!cfg || cfg.enabled === false || !cfg.token) { skipped.push(id); continue; }
      if (!agentProcesses.has(id)) { skipped.push(id); continue; }
      try {
        this.agentConfigs.set(id, { config: cfg });
        startAgentProcess(cfg); // stops old container, recreates with fresh env
        respawned.push(id);
      } catch (err) {
        console.error(`[Orchestrator] respawn for owner ${target} failed for ${id}: ${err.message}`);
        skipped.push(id);
      }
    }
    if (respawned.length) {
      console.log(`[Orchestrator] owner ${target} personal-credential change (${reason || 'update'}) → respawned ${respawned.length} agent(s): ${respawned.join(', ')}`);
    }
    return { ownerId: target, respawned, skipped };
  }

  // Offboarding (#1571, epic #1558 Phase 5; concept §8, decision D6). When a
  // human is deactivated/removed we (1) PAUSE the agents that were acting under
  // that person's personal identity, then (2) auto-DELETE that person's personal
  // credentials — both the index entries and the 0600 secret files.
  //
  // Order matters for AC5 (atomic-enough): agents are paused FIRST, so no run is
  // started under the identity after this point; any in-flight attributed write
  // that outlives the pause refuses (Phase 3 refuse-on-missing) rather than act
  // under a now-deleted credential — it never silently drops to a shared one. A
  // paused agent is DRAINED (disabled in place), never wiped (AC2), and does not
  // auto-resume: re-enabling it is an explicit human decision, and with the
  // personal credential gone it refuses until a present human re-owns it.
  //
  // Only PERSONAL credentials owned by this `userId` are deleted; the person's
  // team/system credentials are shared infrastructure and are left untouched
  // (AC3). There is deliberately no break-glass read/transfer before deletion —
  // the secret is simply removed (AC4/D2). Best-effort per item so one failure
  // does not abort the rest; a summary is returned for the caller to log.
  async offboardOwner(ownerId) {
    const target = ownerId != null && String(ownerId) !== '' ? String(ownerId) : null;
    if (!target) return { ownerId: null, paused: [], skipped: [], deletedCredentials: [] };

    // (1) Pause the departing human's agents (disable in place, no wipe).
    const agents = Array.from(this.agentConfigs.keys()).map(id => ({ id, cfg: loadAgentConfig(id) }));
    const owned = credentialResolution.selectAgentIdsForOwner(agents, target, loadAgentConfig);
    const paused = [];
    const skipped = [];
    for (const id of owned) {
      try {
        // bypassTeamLock: offboarding is a system action — a team-locked member
        // owned by the departing human must still be pausable.
        await this.disableAgent(id, { mode: 'drain', bypassTeamLock: true });
        paused.push(id);
      } catch (err) {
        console.error(`[Orchestrator] offboarding: could not pause ${id} for owner ${target}: ${err.message}`);
        skipped.push(id);
      }
    }

    // (2) Delete the departing human's PERSONAL SSH keys and GitHub tokens.
    const deletedCredentials = [
      ...this._deletePersonalCredentials(loadSshKeyIndex(), SSH_KEYS_INDEX, SSH_KEYS_DIR, target, 'ssh-key'),
      ...this._deletePersonalCredentials(loadGithubTokenIndex(), path.join(GH_TOKENS_DIR, 'index.json'), GH_TOKENS_DIR, target, 'github-token'),
    ];

    if (paused.length || deletedCredentials.length) {
      console.log(`[Orchestrator] offboarded owner ${target}: paused ${paused.length} agent(s), deleted ${deletedCredentials.length} personal credential(s)`);
    }
    return { ownerId: target, paused, skipped, deletedCredentials };
  }

  // Delete every PERSONAL credential owned by `ownerId` from one credential
  // store: unlink the 0600 secret file (named by id) and rewrite the metadata
  // index without those entries. Pure selection is delegated to
  // `credential-resolution.selectPersonalCredentialIds` so a team/system entry
  // is never matched even if its `userId` coincides (AC3). Returns the ids
  // removed (each tagged with `kind`). Best-effort — a missing file is fine
  // (the point is that no residual copy remains, AC1/AC4).
  _deletePersonalCredentials(index, indexPath, secretDir, ownerId, kind) {
    const ids = credentialResolution.selectPersonalCredentialIds(index, ownerId);
    if (!ids.length) return [];
    const doomed = new Set(ids);
    for (const id of ids) {
      try {
        fs.unlinkSync(path.join(secretDir, path.basename(id)));
      } catch (err) {
        if (err && err.code !== 'ENOENT') {
          console.error(`[Orchestrator] offboarding: could not unlink ${kind} '${id}': ${err.message}`);
        }
      }
    }
    try {
      const remaining = index.filter(e => !(e && e.id && doomed.has(String(e.id))));
      fs.writeFileSync(indexPath, JSON.stringify(remaining, null, 2));
    } catch (err) {
      console.error(`[Orchestrator] offboarding: could not rewrite ${kind} index: ${err.message}`);
    }
    return ids.map(id => ({ id, kind }));
  }

  // Recreate a single running agent's container so a spawn-time change (e.g. a
  // per-agent Model-Provider override) is re-injected. A disabled/stub agent is
  // left untouched — it picks up the new binding on its next enable. Fresh-reads
  // the on-disk config so a just-written override is honoured.
  respawnAgent(id, { reason } = {}) {
    const cfg = loadAgentConfig(id);
    if (!cfg) throw new Error(`Agent '${id}' not found`);
    if (cfg.enabled === false || !cfg.token || !agentProcesses.has(id)) {
      return { id, respawned: false };
    }
    this.agentConfigs.set(id, { config: cfg });
    startAgentProcess(cfg); // stops old container, recreates with fresh env
    console.log(`[Orchestrator] agent ${id} respawned (${reason || 'update'})`);
    return { id, respawned: true };
  }

  // Sync an environment's declared repositories into an already-created agent's
  // workspace (issue #1342). Repos are otherwise only cloned when the agent is
  // first seeded, so a repo added to the environment after the fact never
  // reaches existing agents. This clones only the repos that are MISSING from
  // the workspace — already-cloned repos are left untouched (no fetch, no
  // branch switch, no re-clone). Reuses the same clone helper (and therefore
  // the env's SSH-key / GitHub-token resolution and per-env clone cache) as
  // creation-time seeding. The workspace volume is shared with the running
  // container, so cloned files appear inside the agent without a respawn.
  syncAgentRepositories(agentId) {
    const cfg = loadAgentConfig(agentId);
    if (!cfg) {
      const e = new Error(`Agent '${agentId}' not found`);
      e.code = "not-found";
      throw e;
    }
    const environmentId = cfg.environmentId || null;
    const env = environmentId ? loadEnvironment(environmentId) : null;
    const envRepos = Array.isArray(env?.repositories) ? env.repositories : [];
    // #2067 AC11: this agent's OWN attachments are healed by the same pass, so
    // a sync never leaves an attached repository missing — and because the list
    // is read from THIS agent's config, the environment fan-out (Sync all
    // agents) can neither propagate it to a sibling nor drop it here.
    const ownRepos = normalizeAgentRepositories(cfg.agentRepositories);
    const repositories = [...envRepos, ...ownRepos];
    const workspace = agentDir(agentId);

    // A stub / never-materialized agent has no workspace on disk — there is
    // nothing to clone into (git would fail on a missing cwd). Report honestly.
    if (repositories.length && !fs.existsSync(workspace)) {
      return { agentId, environmentId, repos: [], noWorkspace: true, summary: summarizeRepoResults([]) };
    }

    const ownUrls = new Set(ownRepos.map((r) => r.url));
    // The plan is derived from the DECLARED list against the ACTUAL clones
    // (#2066), which is why the status probe runs first: it is what lets one
    // core serve the save-time offer, the out-of-date catch-up and this
    // per-agent panel without them being able to disagree (AC21). The declared
    // list here is env + this agent's own attachments (#2067 AC11), and the
    // probe is handed those attachments too so an agent-scoped clone is
    // reconciled rather than read as no-longer-declared.
    const repos = syncAgentRepoPlan(repositories, {
      statuses: inspectAgentRepoStatuses(agentId, env, ownRepos),
      // An agent-scoped repo deliberately bypasses the per-env clone cache (see
      // cloneAgentScopedRepositories) — one agent's private repository must
      // never become a sibling's copy source.
      clone: (repo) => cloneRepository(
        workspace,
        repo,
        env?.githubTokenId || null,
        ownUrls.has(String(repo.url || "").trim()) ? null : (env?.id || null),
      ),
      adjust: (repo, status, plan) => adjustRepoClone(workspace, repo, status, plan, env?.githubTokenId || null),
      listClones: () => listWorkspaceClones(workspace),
    });
    return { agentId, environmentId, repos, summary: summarizeRepoResults(repos) };
  }

  // ── Agent-scoped repositories (#2067) ──────────────────────────────────
  // Attach / detach a repository to ONE agent, outside its Working
  // Environment. Every rule lives in the pure agent-repositories module; the
  // three methods below are its fs half: read the config, plan, clone or
  // delete, persist, rebuild the prompt.
  //
  // Deliberately NOT a respawn (unlike the context-mount path, whose mount
  // only exists at container-create time): the workspace volume is shared with
  // the running container, so a clone appears inside the agent immediately —
  // the same additive, no-respawn mechanism as #1342's Sync repositories. The
  // prompt is rebuilt so the NEXT run names the repository (AC6).

  // The merged environment+agent view every surface reads, plus the git state
  // of each working copy so a removal confirmation can name what would be lost
  // (AC9) without a second round-trip.
  agentRepositoriesView(agentId, { withStatus = true } = {}) {
    const cfg = loadAgentConfig(agentId);
    if (!cfg) {
      const e = new Error(`Agent '${agentId}' not found`);
      e.code = "not-found";
      throw e;
    }
    const env = cfg.environmentId ? loadEnvironment(cfg.environmentId) : null;
    const own = normalizeAgentRepositories(cfg.agentRepositories);
    const resolved = resolveAgentRepositories(env, own);
    let statuses = [];
    if (withStatus && fs.existsSync(agentDir(agentId))) {
      try {
        statuses = inspectAgentRepoStatuses(agentId, env, own);
      } catch (err) {
        console.warn(`[Orchestrator] repo status for ${agentId}: ${err.message}`);
      }
    }
    const byUrl = new Map(statuses.map((s) => [s.url, s]));
    return {
      agentId,
      environmentId: cfg.environmentId || null,
      role: cfg.role || "agent",
      // A team record has no workspace and a stub has none yet — the surfaces
      // disable the action with a stated reason rather than hiding it (AC16).
      materialized: Boolean(cfg.token),
      busy: agentBusyState(agentId).busy === true,
      hasGithubToken: Boolean(env && env.githubTokenId),
      repositories: resolved.map((r) => ({
        ...r,
        facts: r.scope === "agent" ? removalFacts(byUrl.get(r.url) || null) : null,
      })),
    };
  }

  attachAgentRepository(agentId, repo) {
    const cfg = loadAgentConfig(agentId);
    if (!cfg) {
      const e = new Error(`Agent '${agentId}' not found`);
      e.code = "not-found";
      throw e;
    }
    if (cfg.role === "team") {
      const e = new Error(
        "A team record has no container and no workspace of its own — attach the repository to one of its members instead.",
      );
      e.code = "no-workspace";
      throw e;
    }
    const workspace = agentDir(agentId);
    if (!cfg.token || !fs.existsSync(workspace)) {
      const e = new Error(
        "This agent has not been materialized yet, so it has no workspace to clone into. Materialize it first.",
      );
      e.code = "no-workspace";
      throw e;
    }

    const env = cfg.environmentId ? loadEnvironment(cfg.environmentId) : null;
    // Directory names already taken in the workspace root — a sibling clone or
    // an ordinary folder the agent created. Read here so the pure planner can
    // refuse a collision BEFORE anything is written (AC13).
    let occupiedNames = [];
    try {
      occupiedNames = fs.readdirSync(workspace, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch { /* unreadable workspace → the clone itself will fail honestly */ }

    const plan = planAgentRepoAttach({
      env,
      agentRepositories: cfg.agentRepositories,
      repo,
      occupiedNames,
      credentials: {
        // Both conditions cloneRepository will actually apply: the id is in
        // the registry AND the key file it would read still exists.
        sshKeyIds: loadSshKeyIndex()
          .map((k) => k && k.id)
          .filter((keyId) => keyId && fs.existsSync(path.join(SSH_KEYS_DIR, keyId))),
        hasGithubToken: Boolean(env && env.githubTokenId),
      },
    });
    if (!plan.ok) {
      const e = new Error(plan.message);
      e.code = plan.code;
      throw e;
    }

    // Clone FIRST, persist second: a failed clone must leave neither a config
    // entry naming a repository that is not there nor a half-cloned directory
    // (AC13). cloneRepository throws on failure and never leaves the target
    // dir behind on the error path, so a throw here writes nothing at all.
    const warnings = [];
    const clones = cloneAgentScopedRepositories(workspace, env, [plan.repo], warnings);
    if (warnings.length) {
      // Best-effort cleanup of anything a partial clone left behind, then
      // surface the real git error rather than a generic failure.
      const target = path.join(workspace, plan.dirName);
      try {
        if (fs.existsSync(target) && !fs.existsSync(path.join(target, ".git"))) {
          fs.rmSync(target, { recursive: true, force: true });
        }
      } catch { /* best effort */ }
      const e = new Error(warnings[0]);
      e.code = "clone-failed";
      throw e;
    }
    // cloneRepository REPORTS rather than throws when the target directory
    // already exists — it does not overwrite. The planner refuses that case
    // from the directory listing it read a moment earlier, so reaching here
    // means the directory appeared in between (a concurrent attach, or the
    // agent itself creating a folder mid-run). Persisting now would bind the
    // entry to a directory this clone did not produce, so refuse instead and
    // leave the newcomer's directory untouched.
    if (clones.some((c) => c && c.skipped)) {
      const e = new Error(
        `\`./${plan.dirName}/\` appeared in the workspace while the clone was starting, so ` +
        `nothing was cloned and nothing was attached. Check what is at that path and try again.`,
      );
      e.code = "dir-name-occupied";
      throw e;
    }

    cfg.agentRepositories = plan.agentRepositories;
    saveAgentConfig(agentId, cfg);
    this.agentConfigs.set(agentId, { config: cfg });

    // Rebuild + reseed CLAUDE.md so the next run names the repository (AC6),
    // including the git / gh-as-agent block a repo-less environment used to
    // suppress (AC14). The shared rebuild helper is best-effort by contract:
    // the repository is already on disk, so a prompt-rebuild failure must not
    // undo a good clone. Deliberately no respawn — the workspace volume is
    // shared with the running container and CLAUDE.md is re-read per
    // invocation, so this is the #1342 additive path, not the context-mount one.
    rebuildAgentPrompt(agentId, "agent-repository-attached").catch(() => {});

    return {
      agentId,
      repo: plan.repo,
      dirName: plan.dirName,
      clones,
      ...this.agentRepositoriesView(agentId),
    };
  }

  detachAgentRepository(agentId, url) {
    const cfg = loadAgentConfig(agentId);
    if (!cfg) {
      const e = new Error(`Agent '${agentId}' not found`);
      e.code = "not-found";
      throw e;
    }
    const env = cfg.environmentId ? loadEnvironment(cfg.environmentId) : null;
    const plan = planAgentRepoDetach({ env, agentRepositories: cfg.agentRepositories, url });
    if (!plan.ok) {
      const e = new Error(plan.message);
      e.code = plan.code;
      throw e;
    }
    // AC17: a removal deletes files under the agent's own working directory,
    // so it is refused while a run is in flight rather than corrupting that
    // run's view of the workspace. (Attaching is additive and needs no gate.)
    const { busy, activeTriggers } = agentBusyState(agentId);
    if (busy) {
      const e = new Error(
        "This agent is running a session. Removing a repository deletes files it may be using — wait until the run ends.",
      );
      e.code = "busy";
      e.activeTriggers = activeTriggers;
      throw e;
    }

    // Config first here, working copy second — the inverse of attach, for the
    // same reason: if the delete fails the entry is already gone, so a retry
    // sees `not-attached` rather than re-deleting; a leftover directory is
    // visible in the tree and removable by hand, whereas an entry pointing at
    // deleted files would keep the prompt naming a missing repository.
    cfg.agentRepositories = plan.agentRepositories;
    saveAgentConfig(agentId, cfg);
    this.agentConfigs.set(agentId, { config: cfg });
    rebuildAgentPrompt(agentId, "agent-repository-detached").catch(() => {});

    let deleted = false;
    if (plan.deleteWorkingCopy) {
      const target = path.join(agentDir(agentId), plan.dirName);
      try {
        if (fs.existsSync(target)) {
          fs.rmSync(target, { recursive: true, force: true });
          deleted = true;
        }
      } catch (err) {
        console.error(`[Orchestrator] repo detach ${agentId}/${plan.dirName}: ${err.message}`);
        const e = new Error(`The attachment was removed, but the working copy could not be deleted: ${err.message}`);
        e.code = "delete-failed";
        throw e;
      }
    }

    return {
      agentId,
      repo: plan.repo,
      dirName: plan.dirName,
      deleted,
      keptReason: plan.keptReason,
      ...this.agentRepositoriesView(agentId),
    };
  }

  // Read-only sibling of syncAgentRepositories: which declared repositories
  // are out of date in this agent's workspace, and why (#2066 D4). Drives the
  // environment's persistent "N agents not up to date" indicator, so it must
  // never mutate anything and must never report a clone that is merely no
  // longer declared — nothing is ever pruned, so that can never be fixed.
  agentRepoDivergence(agentId) {
    const cfg = loadAgentConfig(agentId);
    if (!cfg) {
      const e = new Error(`Agent '${agentId}' not found`);
      e.code = "not-found";
      throw e;
    }
    const environmentId = cfg.environmentId || null;
    const env = environmentId ? loadEnvironment(environmentId) : null;
    const repositories = Array.isArray(env?.repositories) ? env.repositories : [];
    const workspace = agentDir(agentId);

    // A stub has no workspace, so it is not "out of date" — it has nothing to
    // be out of date with. Reporting it would light the indicator for a state
    // only materialization can clear.
    if (!fs.existsSync(workspace)) {
      return { agentId, environmentId, diverged: [], noWorkspace: true };
    }
    const diverged = repoDivergence(repositories, inspectAgentRepoDivergence(agentId, env));
    return { agentId, environmentId, diverged };
  }

  // Aggregate the above across the agents of one environment, for the
  // environment's persistent "N agents not up to date" indicator (#2066 AC19).
  //
  // The agent set is supplied by the caller rather than discovered here,
  // because deciding WHICH agents a caller may see is the console's scoping
  // job — the orchestrator has no notion of the requesting human.
  environmentRepoDivergence(envId, agentIds) {
    const env = loadEnvironment(envId);
    const agents = [];
    for (const agentId of Array.isArray(agentIds) ? agentIds : []) {
      try {
        const cfg = loadAgentConfig(agentId);
        if (!cfg || cfg.environmentId !== envId) continue;
        const workspace = agentDir(agentId);
        if (!fs.existsSync(workspace)) {
          agents.push({ agentId, diverged: [], noWorkspace: true });
          continue;
        }
        const repositories = Array.isArray(env?.repositories) ? env.repositories : [];
        agents.push({
          agentId,
          diverged: repoDivergence(repositories, inspectAgentRepoDivergence(agentId, env)),
        });
      } catch (err) {
        // One unreadable agent must not blank the whole indicator — report it
        // rather than counting it as up to date.
        agents.push({ agentId, diverged: [], error: errorMessage(err) });
      }
    }
    return {
      envId,
      agents,
      outOfDate: agents.filter((a) => a.diverged.length > 0).length,
    };
  }

  // Reset an agent back to its stub state: stop the process, deactivate the
  // Matrix user (best-effort), wipe the workspace, and strip the config of
  // any runtime identity (token, userId). The stub config keeps just the
  // metadata needed to re-activate later.
  //
  // Destructive — caller is expected to have confirmed with the user.
  //
  // mode === undefined → if the agent is running and has active triggers or a
  //   busy session, return a warning object (HTTP 409) so the caller can ask
  //   the user to choose drain or abort before proceeding.
  // mode === 'drain' → disable triggers and set enabled=false immediately
  //   (no new executions start), but leave the process running and defer the
  //   workspace wipe. The agent appears as "disabled" until the operator
  //   deactivates again once idle.
  // mode === 'hard-stop' → stop the process right away and wipe (original
  //   behaviour).
  async deactivateAgent(id, { mode } = {}) {
    const cfg = loadAgentConfig(id);
    if (!cfg) throw new Error(`Agent '${id}' not found`);

    const isRunning = agentProcesses.has(id);

    // Pre-flight: when no mode is given and the process is running, check for
    // active state and surface it as a warning so the UI can ask the user.
    if (!mode && isRunning) {
      let isBusy = false;
      try {
        const status = JSON.parse(
          fs.readFileSync(agentStatePath(id, 'status.json'), 'utf8'), // control-plane copy preferred (#185)
        );
        isBusy = status?.state === 'busy';
      } catch { /* no status file = idle */ }

      let activeTriggers = [];
      try {
        const triggers = loadTriggers(id); // canonical copy (#185 Phase 2)
        if (Array.isArray(triggers)) {
          activeTriggers = triggers
            .filter(t => t.enabled !== false && t.id)
            .map(t => ({ id: t.id, type: t.type, description: t.description || null }));
        }
      } catch { /* no triggers file */ }

      if (isBusy || activeTriggers.length > 0) {
        return { id, warning: true, busy: isBusy, activeTriggers };
      }
    }

    // Drain mode: disable the agent in place (no wipe). The caller should
    // re-invoke with hard-stop once the agent goes idle.
    if (mode === 'drain') {
      return this.disableAgent(id, { mode: 'drain' });
    }

    stopAgentProcess(id);

    if (cfg.userId || cfg.token) {
      // Best-effort — we don't want to fail the reset if the admin client
      // or Conduwuit is unavailable; the local config wipe is what matters.
      await this.deactivateMatrixUser(id);
    }

    // Wipe the workspace except for config.json so the next activation seeds
    // a fresh repo + skills + memory copy.
    const dir = agentDir(id);
    if (fs.existsSync(dir)) {
      for (const entry of fs.readdirSync(dir)) {
        if (entry === "config.json") continue;
        try {
          fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
        } catch (err) {
          console.error(`[Orchestrator] Could not remove ${entry} from ${id}: ${err.message}`);
        }
      }
    }

    // Remove the dedicated volume too (#185 item 6). Required, not just tidy:
    // seedPerAgentVolume only copies into an EMPTY /dst, so leaving the volume
    // in place would make a later reactivation run against stale state instead
    // of re-seeding the freshly-wiped pool subpath above.
    if (PER_AGENT_VOLUME) {
      await removePerAgentVolume(id).catch(err =>
        console.warn(`[Orchestrator] volume teardown ${id}: ${err.message}`));
    }

    // Strip runtime identity. Keep id, displayName, role, environmentId, and
    // role-specific metadata (parentTeamId / blueprintId). Drop token, userId.
    // Mark disabled. The BriefingPack keys this list used to preserve
    // (briefingsPath / parentOrchestratorId / bpId / bpSlug / bpRelPath) went
    // with #1962 — nothing writes them any more.
    const stripped = {
      id: cfg.id,
      displayName: cfg.displayName,
      role: cfg.role,
      environmentId: cfg.environmentId,
      ...(cfg.parentTeamId && { parentTeamId: cfg.parentTeamId }),
      ...(cfg.blueprintId && { blueprintId: cfg.blueprintId }),
      // #2067 D9/AC5: the attachment must survive a workspace re-seed. This
      // wipe keeps config.json alone, so config.json is the only place the
      // list can survive — dropping it here would leave the next activation
      // re-cloning the environment's repositories and silently losing the
      // agent-scoped one, while the rebuilt prompt no longer names it either.
      ...(normalizeAgentRepositories(cfg.agentRepositories).length
        ? { agentRepositories: normalizeAgentRepositories(cfg.agentRepositories) }
        : {}),
      enabled: false,
    };
    saveAgentConfig(id, stripped);
    this.agentConfigs.set(id, { config: stripped });

    console.log(`[Orchestrator] Reset ${id} to stub state`);
    return { id, reset: true };
  }

  // ===========================================================
  // Blueprint instance creation
  // ===========================================================
  async createInstance(blueprintId, instanceId, instanceDisplayName) {
    const blueprint = loadBlueprint(blueprintId);
    if (!blueprint) throw new Error(`Blueprint '${blueprintId}' not found`);
    if (loadAgentConfig(instanceId) || agentTeardownRegistry.has(instanceId)) throw new Error(`Agent '${instanceId}' already exists`);

    const env = loadEnvironment(blueprint.environmentId);
    if (!env) throw new Error(`Working Environment '${blueprint.environmentId}' not found`);

    const password = `agent-${instanceId}-${Date.now()}`;
    const userId = `@${instanceId}:local`;

    if (this.adminClient) await ensureMatrixUser(this.adminClient, instanceId, password);
    const token = await loginMatrixUser(instanceId, password, this.adminClient);
    await setDisplayName(token, userId, instanceDisplayName);

    // Initial grant for a blueprint instance: one-time copy of the env's
    // legacy skill list (no operator UI on this path), recorded on the config —
    // team-owned skills from then on.
    const instanceSkills = Array.isArray(env.skills) ? [...env.skills] : [];
    const seedResult = seedAgentWorkspaceForInstance(instanceId, env, blueprintId, instanceSkills);

    const config = {
      id: instanceId,
      displayName: instanceDisplayName,
      userId,
      token,
      role: blueprint.role,
      environmentId: env.id,
      skills: instanceSkills,
      blueprintId,
      // Preserve the owning Team of the stub being activated (#299); fall back
      // to the default team for a fresh instance.
      teamId: (loadAgentConfig(instanceId)?.teamId) || DEFAULT_TEAM_ID,
      enabled: true,
    };
    saveAgentConfig(instanceId, config);
    saveAgentPrompt(instanceId, blueprint.systemPrompt, blueprint.role, env, blueprintId);

    this.agentConfigs.set(instanceId, { config });
    startAgentProcess(config);

    console.log(`[Orchestrator] Created instance ${instanceId} from blueprint ${blueprintId}`);
    return {
      id: instanceId,
      userId,
      blueprintId,
      seeded: seedResult.seeded,
      warnings: seedResult.warnings || [],
      clones: seedResult.clones || [],
    };
  }

  // ===========================================================
  // Convert a standalone agent into a team of one, in place (#2052)
  // ===========================================================
  // The product has told the user since #1667 that "a single agent is simply a
  // team of one". This is the step that makes it true: a `role: 'team'` metadata
  // record is created beside the agent and the agent becomes its only member —
  // keeping its id, its Matrix user, its DM room, its chat history, its triggers
  // and its Working Environment. Nothing is copied and nothing is re-minted.
  //
  // The decisions (eligibility, the derived id, what each config field becomes,
  // which skills need copying, which plugin scopes flip) all live in the pure
  // `team-conversion.js`; this method is the fs/broker/respawn half.
  //
  // opts:
  //   - force — proceed even though the agent is mid-run. Without it a busy
  //             agent is reported back (the `disableAgent` two-phase shape) so
  //             the console can ask rather than cut a turn off mid-sentence.
  async convertAgentToTeam(id, { force = false } = {}) {
    const cfg = loadAgentConfig(id);
    if (!cfg) throw new Error(`Agent '${id}' not found`);

    // Re-checked here and not only in the console: this is the last gate before
    // anything is written, and the API's copy of the check can be stale.
    const verdict = assessConversionEligibility(cfg);
    if (!verdict.eligible) {
      const err = new Error(`Agent '${id}' cannot be converted into a team: ${verdict.reason}`);
      err.code = verdict.code;
      throw err;
    }

    // The prompt file is rewritten and the container is recreated, so a
    // conversion that lands mid-turn truncates the run. Refuse and say so
    // rather than deciding for the user.
    if (!force) {
      const { busy, activeTriggers } = agentBusyState(id);
      if (busy || activeTriggers.length > 0) {
        return { id, warning: true, busy, activeTriggers };
      }
    }

    const skills = effectiveSkills(cfg, loadAgentConfig);
    const plugins = effectivePlugins(cfg, loadAgentConfig);
    const fromPoolTeamId = agentKnowledgeTeamId(cfg);

    // AC5 — which granted skills are served by the TENANT pool right now. A
    // global-pool skill resolves identically after the conversion; a tenant-tier
    // one would not, so the plan asks for those to be copied into the squad
    // pool. Resolved here (fs), decided in the plan (pure).
    const tenantSkills = skills.filter((name) => {
      const src = resolveSkillSourceDir(name, fromPoolTeamId, { agentId: id });
      return !!src && src === path.join(teamSkillsDir(fromPoolTeamId), name);
    });

    let promptFallback = "";
    try {
      promptFallback = fs.readFileSync(path.join(agentDir(id), AGENT_PROMPT_FILENAME), "utf8");
    } catch { /* no prompt file — the config's own prompt (or none) is the truth */ }

    const plan = planTeamConversion(cfg, {
      teamIdTaken: (tid) => !!loadAgentConfig(tid) || agentTeardownRegistry.has(tid) || fs.existsSync(agentDir(tid)),
      skills,
      plugins,
      tenantSkills,
      promptFallback,
      defaultTeamId: DEFAULT_TEAM_ID,
    });

    // ── 1. Additive, pre-flip work ────────────────────────────────────────────
    // Everything here is safe to leave behind if a later step fails: it only
    // populates the new squad's pools, which nothing else reads yet.
    const warnings = [];

    // AC5 — copy the tenant-tier skill content into the squad pool so every
    // grant still resolves to the same bytes.
    for (const name of plan.skillPoolCopies) {
      const src = path.join(teamSkillsDir(fromPoolTeamId), name);
      const dst = path.join(teamSkillsDir(plan.teamId), name);
      try {
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.cpSync(src, dst, { recursive: true, force: false, errorOnExist: false });
      } catch (err) {
        warnings.push(`skill '${name}' could not be copied into the new team's pool: ${err.message}`);
      }
    }

    // AC6 — the agent's knowledge scope re-keys from the tenant to the squad.
    // Carrying the tenant's per-team knowledge config (#570) across is what
    // keeps the KB repo ref and branch identical, so the agent's existing
    // `knowledge/` checkout stays the right one and its entries stay readable.
    // A tenant with no overrides has nothing to carry — both sides then fall
    // through to the environment's own `knowledgeStore`.
    const knowledgeOverrides = loadTeamKnowledgeOverrides(fromPoolTeamId);
    if (Object.keys(knowledgeOverrides).length > 0) {
      try {
        writeTeamKnowledgeOverrides(plan.teamId, knowledgeOverrides);
      } catch (err) {
        warnings.push(`knowledge configuration could not be carried over: ${err.message}`);
      }
    }

    // AC7 — a `team`-granularity plugin scope id is the agent's own id while it
    // is standalone and the team's id afterwards. Reap the old scope BEFORE the
    // flip, while its token is still mintable: a broker asked to clean up after
    // invalidation can no longer authenticate the request.
    let pluginTeardown = [];
    if (plan.pluginScopeChanges.length > 0) {
      pluginTeardown = await this.teardownAgentPluginScopes(id, cfg).catch((err) => {
        warnings.push(`plugin scope teardown: ${err.message}`);
        return [];
      });
    }

    // ── 2. The flip ───────────────────────────────────────────────────────────
    // Two config writes that must both land. If the second fails, the first is
    // undone and the agent is left exactly as it was (AC9).
    const memberConfig = { ...cfg, ...plan.memberPatch };
    for (const key of plan.memberUnset) delete memberConfig[key];

    saveAgentConfig(plan.teamId, plan.teamConfig);
    this.agentConfigs.set(plan.teamId, { config: plan.teamConfig });
    try {
      saveAgentConfig(id, memberConfig);
      this.agentConfigs.set(id, { config: memberConfig });
    } catch (err) {
      this.agentConfigs.delete(plan.teamId);
      try { fs.rmSync(agentDir(plan.teamId), { recursive: true, force: true }); }
      catch { /* the team record is metadata only — a leftover dir is inert */ }
      throw err;
    }

    // ── 3. Re-derive everything that keys on the new scope ────────────────────
    // saveAgentPrompt re-reads the config, so it must run after the write: it
    // rewrites AGENT-PROMPT.md from the resolved prompt and rebuilds CLAUDE.md
    // with the member's skill descriptions and the squad's knowledge digest ref.
    const env = loadEnvironment(cfg.environmentId) || {};
    try {
      saveAgentPrompt(id, plan.effectivePrompt, "team-member", env);
    } catch (err) {
      warnings.push(`prompt/CLAUDE.md rebuild: ${err.message}`);
    }
    await reseedAgent(id, [AGENT_PROMPT_FILENAME, "CLAUDE.md"]);

    // The agent must come back on its own — a converted agent left stopped is a
    // failed conversion. respawnAgent is a no-op for a disabled or never-spawned
    // agent, which is the right answer there too.
    let respawned = false;
    try {
      respawned = !!this.respawnAgent(id, { reason: "converted-to-team" }).respawned;
    } catch (err) {
      warnings.push(`respawn: ${err.message}`);
    }

    console.log(`[Orchestrator] Converted standalone agent ${id} into team ${plan.teamId} (team of one)`);
    return {
      id,
      teamId: plan.teamId,
      teamName: plan.teamConfig.displayName,
      role: "team-member",
      skillsCopied: plan.skillPoolCopies,
      knowledgeScope: plan.knowledgeScope,
      pluginScopeChanges: plan.pluginScopeChanges,
      pluginTeardown,
      respawned,
      ...(warnings.length ? { warnings } : {}),
    };
  }

  // ===========================================================
  // Agent cloning
  // ===========================================================
  // opts:
  //   - parentTeamId — when set, the clone is grafted into an existing team as
  //                    a `team-member` and inherits the team's environment
  //                    (same resolution importAgent() uses). Absent → cloned
  //                    as a standalone `agent`, even if the source itself was
  //                    a team-member of some other team.
  async cloneAgent(sourceId, newId, newDisplayName, opts = {}) {
    const sourceCfg = loadAgentConfig(sourceId);
    if (!sourceCfg) throw new Error(`Source agent '${sourceId}' not found`);
    if (!["agent", "team-member"].includes(sourceCfg.role)) {
      throw new Error(`Agent '${sourceId}' has role '${sourceCfg.role}' and cannot be cloned`);
    }
    if (loadAgentConfig(newId) || agentTeardownRegistry.has(newId)) throw new Error(`Agent '${newId}' already exists`);

    const teamCfg = opts.parentTeamId ? loadAgentConfig(opts.parentTeamId) : null;
    const { role, parentTeamId, environmentId } = resolveCloneTarget(sourceCfg, opts, teamCfg);

    const password = `agent-${newId}-${Date.now()}`;
    const userId = `@${newId}:local`;

    if (this.adminClient) await ensureMatrixUser(this.adminClient, newId, password);
    const token = await loginMatrixUser(newId, password, this.adminClient);
    await setDisplayName(token, userId, newDisplayName);

    // Copy workspace — skip runtime-only files
    const srcDir = agentDir(sourceId);
    const dstDir = agentDir(newId);
    fs.mkdirSync(dstDir, { recursive: true });
    const SKIP = new Set(['config.json', 'status.json', 'dm-room.json', 'sessions']);
    for (const entry of fs.readdirSync(srcDir)) {
      if (SKIP.has(entry)) continue;
      fs.cpSync(path.join(srcDir, entry), path.join(dstDir, entry), { recursive: true });
    }

    const newConfig = {
      ...sourceCfg,
      id: newId,
      displayName: newDisplayName,
      userId,
      token,
      enabled: true,
      role,
      environmentId,
    };
    if (parentTeamId) {
      newConfig.parentTeamId = parentTeamId;
    } else {
      delete newConfig.parentTeamId;
    }
    saveAgentConfig(newId, newConfig);

    this.agentConfigs.set(newId, { config: newConfig });
    startAgentProcess(newConfig);

    console.log(`[Orchestrator] Cloned agent ${sourceId} → ${newId}${parentTeamId ? ` (team=${parentTeamId})` : ''}`);
    return { id: newId, userId, clonedFrom: sourceId, role, parentTeamId };
  }

  // ===========================================================
  // Agent import
  // ===========================================================
  // Materialize an agent from an extracted export workspace staged on the
  // shared volume (written by the admin-console import endpoint). Mirrors
  // cloneAgent: a FRESH Matrix identity is provisioned for `agentId` — the
  // export's old `userId`/`token` are dropped, because they belong to the
  // source homeserver/user and are invalid here (the source user may even
  // have been deactivated on delete). The imported workspace (memory/,
  // skills/, repo clone, prompt files) is preserved 1:1; we never re-seed,
  // so nothing the agent learned is lost.
  //
  // opts:
  //   - displayName   — override; defaults to the imported config's name.
  //   - parentTeamId  — when set, the agent is grafted into an existing team
  //                     as a `team-member`. Its imported system prompt is kept
  //                     as a per-member override (so a later team-prompt edit
  //                     won't wipe it), and it inherits the team's environment.
  //                     Absent → imported as a standalone `agent`.
  async importAgent(stagingDir, agentId, opts = {}) {
    if (!agentId || !AGENT_ID_RE.test(agentId)) throw new Error(`Invalid agent id '${agentId}'`);
    if (loadAgentConfig(agentId) || agentTeardownRegistry.has(agentId)) throw new Error(`Agent '${agentId}' already exists`);

    // Containment: staging dirs live under WORKSPACE/.import-staging only.
    const stagingRoot = path.resolve(path.join(WORKSPACE, ".import-staging"));
    const resolvedStaging = path.resolve(stagingDir);
    if (resolvedStaging !== stagingRoot &&
        !resolvedStaging.startsWith(stagingRoot + path.sep)) {
      throw new Error("Invalid staging path");
    }
    const stagedConfigPath = path.join(resolvedStaging, "config.json");
    if (!fs.existsSync(stagedConfigPath)) {
      throw new Error("Staged workspace is missing config.json — not a valid agent export");
    }
    let sourceCfg;
    try {
      sourceCfg = JSON.parse(fs.readFileSync(stagedConfigPath, "utf8"));
    } catch (err) {
      throw new Error(`Corrupt config.json in export: ${err.message}`);
    }

    // Resolve role + environment binding.
    let role, parentTeamId = null, environmentId;
    if (opts.parentTeamId) {
      const teamCfg = loadAgentConfig(opts.parentTeamId);
      if (!teamCfg) throw new Error(`Team '${opts.parentTeamId}' not found`);
      if (teamCfg.role !== "team") {
        throw new Error(`Agent '${opts.parentTeamId}' is not a team (role=${teamCfg.role})`);
      }
      role = "team-member";
      parentTeamId = opts.parentTeamId;
      environmentId = teamCfg.environmentId;
    } else {
      // Standalone import — never resurrect a dangling team-member shape (it
      // would render as an orphan with a missing parent). This forced role is
      // also why the BriefingPack linkage fields no longer need stripping
      // (#1962): an imported pre-BP-removal archive can still carry
      // parentOrchestratorId / bpId / bpSlug / briefingsPath, but nothing in
      // the platform reads them any more and the role they belonged to cannot
      // be assigned here.
      role = "agent";
      environmentId = sourceCfg.environmentId;
    }

    const displayName = opts.displayName || sourceCfg.displayName || agentId;
    const password = `agent-${agentId}-${Date.now()}`;
    const userId = `@${agentId}:local`;

    if (this.adminClient) await ensureMatrixUser(this.adminClient, agentId, password);
    const token = await loginMatrixUser(agentId, password, this.adminClient);
    await setDisplayName(token, userId, displayName);

    // Copy the staged workspace into place, skipping runtime-only files we
    // regenerate (config rewritten below; session/DM/status are host-specific).
    const dstDir = agentDir(agentId);
    fs.mkdirSync(dstDir, { recursive: true });
    const SKIP = new Set(["config.json", "status.json", "dm-room.json", "sessions"]);
    for (const entry of fs.readdirSync(resolvedStaging)) {
      if (SKIP.has(entry)) continue;
      fs.cpSync(path.join(resolvedStaging, entry), path.join(dstDir, entry), { recursive: true });
    }

    // Rebuild the config: keep imported fields, swap in fresh identity + role.
    const newConfig = {
      ...sourceCfg,
      id: agentId,
      displayName,
      userId,
      token,
      role,
      enabled: true,
    };
    delete newConfig._provisioning;

    if (role === "team-member") {
      newConfig.parentTeamId = parentTeamId;
      newConfig.environmentId = environmentId;
      // Keep the imported prompt as a member override so team-prompt
      // propagation (updateTeamPrompt) won't overwrite it. Fall back to the
      // exported AGENT-PROMPT.md when the config carried no explicit prompt.
      if (typeof sourceCfg.systemPrompt === "string" && sourceCfg.systemPrompt.length > 0) {
        newConfig.systemPrompt = sourceCfg.systemPrompt;
      } else {
        const promptPath = path.join(dstDir, "AGENT-PROMPT.md");
        try {
          const p = fs.existsSync(promptPath) ? fs.readFileSync(promptPath, "utf8").trim() : "";
          if (p) newConfig.systemPrompt = p;
        } catch { /* leave prompt unset → inherits team template */ }
      }
    } else {
      delete newConfig.parentTeamId;
      delete newConfig.systemPromptTemplate;
    }

    saveAgentConfig(agentId, newConfig);
    this.agentConfigs.set(agentId, { config: newConfig });
    startAgentProcess(newConfig);

    try { fs.rmSync(resolvedStaging, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }

    console.log(
      `[Orchestrator] Imported agent → ${agentId} (role=${role}` +
      `${parentTeamId ? `, team=${parentTeamId}` : ""})`
    );
    return { id: agentId, userId, role, parentTeamId };
  }
}

// ============================================================
// Teams admin API (#299) — CRUD for the human Team data model.
// ============================================================
//
// Mounted under /internal/admin/{teams,users,memberships}. Deliberately
// separate from the /internal/teams/* routes, which operate on the *Agent
// Team* construct (members, prompt template). Auth lives in a later issue; this
// is the data-model surface the admin console proxies to.
function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      if (!body) return resolve({});
      try { resolve(JSON.parse(body)); }
      catch { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

// Does any agent / environment / credential still name this team as its owner?
// Used to refuse deletion of a non-empty team so resources aren't orphaned.
function teamHasOwnedResources(teamId) {
  if (fs.existsSync(AGENTS_DIR)) {
    for (const id of listAgentIds()) {
      const cfg = loadAgentConfig(id);
      if (cfg && cfg.teamId === teamId) return true;
    }
  }
  if (fs.existsSync(ENVIRONMENTS_DIR)) {
    for (const name of fs.readdirSync(ENVIRONMENTS_DIR)) {
      const p = path.join(ENVIRONMENTS_DIR, name, 'environment.json');
      if (!fs.existsSync(p)) continue;
      try {
        if (JSON.parse(fs.readFileSync(p, 'utf8')).teamId === teamId) return true;
      } catch { /* ignore */ }
    }
  }
  const indexes = [
    SSH_KEYS_INDEX,
    path.join(GH_TOKENS_DIR, 'index.json'),
    path.join(MCP_CREDENTIALS_KEYS_DIR, 'index.json'),
    LLM_ENDPOINTS_INDEX,
  ];
  for (const idx of indexes) {
    if (!fs.existsSync(idx)) continue;
    try {
      const list = JSON.parse(fs.readFileSync(idx, 'utf8'));
      if (Array.isArray(list) && list.some(e => e && e.teamId === teamId)) return true;
    } catch { /* ignore */ }
  }
  return false;
}

// Returns true if the request was a /internal/admin/* route (handled here),
// false otherwise so the caller can fall through to other routes.
async function handleTeamsAdminApi(req, res) {
  const parsed = new URL(req.url, 'http://internal');
  const segs = parsed.pathname.split('/').filter(Boolean); // ['internal','admin',...]
  if (segs[0] !== 'internal' || segs[1] !== 'admin') return false;

  const collection = segs[2];
  const resourceId = segs[3] ? decodeURIComponent(segs[3]) : null;

  try {
    if (collection === 'teams') {
      if (req.method === 'GET' && !resourceId) return sendJson(res, 200, teamsStore.listTeams()), true;
      if (req.method === 'POST' && !resourceId) {
        const body = await readBody(req);
        return sendJson(res, 201, teamsStore.createTeam(body)), true;
      }
      if (req.method === 'GET' && resourceId) {
        const team = teamsStore.getTeam(resourceId);
        if (!team) return sendJson(res, 404, { error: `Team '${resourceId}' not found` }), true;
        return sendJson(res, 200, team), true;
      }
      if (req.method === 'PUT' && resourceId) {
        const body = await readBody(req);
        return sendJson(res, 200, teamsStore.updateTeam(resourceId, body)), true;
      }
      if (req.method === 'DELETE' && resourceId) {
        if (teamHasOwnedResources(resourceId)) {
          return sendJson(res, 409, {
            error: `Team '${resourceId}' still owns agents, environments or credentials — reassign them first`,
          }), true;
        }
        return sendJson(res, 200, teamsStore.deleteTeam(resourceId)), true;
      }
    }

    if (collection === 'users') {
      const subAction = segs[4] || null; // e.g. /internal/admin/users/<id>/password
      const clean = teamsStore.sanitizeUser; // strip passwordHash from every response

      // Verify a login (#374). Internal-only; called by the admin-console's
      // public login route. Returns the sanitized user on success, else 401.
      if (req.method === 'POST' && resourceId === 'verify' && !subAction) {
        const body = await readBody(req);
        const user = teamsStore.verifyUserCredentials(body.username, body.password);
        if (!user) return sendJson(res, 401, { error: 'invalid credentials' }), true;
        return sendJson(res, 200, user), true;
      }

      // Set / clear a user's local password (System-Admin action).
      if (resourceId && subAction === 'password') {
        if (req.method === 'POST') {
          const body = await readBody(req);
          return sendJson(res, 200, teamsStore.setUserPassword(resourceId, body.password)), true;
        }
        if (req.method === 'DELETE') {
          return sendJson(res, 200, teamsStore.clearUserPassword(resourceId)), true;
        }
      }

      if (req.method === 'GET' && !resourceId) {
        const subject = parsed.searchParams.get('subject');
        if (subject) {
          const u = teamsStore.getUserBySubject(subject);
          return sendJson(res, 200, u ? [clean(u)] : []), true;
        }
        return sendJson(res, 200, teamsStore.listUsers().map(clean)), true;
      }
      if (req.method === 'POST' && !resourceId) {
        const body = await readBody(req);
        const created = teamsStore.createUser(body);
        // Give the new human their own Matrix account (#1458). Deliberately
        // wired HERE and not inside teamsStore.createUser: the startup
        // `ensureSystemAdmin` bootstrap also goes through createUser, and the
        // bootstrap admin must ADOPT the existing shared-admin identity
        // (`@admin:local`) and its rooms rather than be handed a fresh empty
        // account — that adoption is the migration slice's job.
        //
        // A single-operator stack creates no user records at all (the env
        // admin of #276 has none), so nothing here fires and its behaviour is
        // unchanged end to end.
        provisionHumanMatrixIdentityInBackground(orchestrator.adminClient, created);
        return sendJson(res, 201, clean(created)), true;
      }
      if (req.method === 'GET' && resourceId) {
        const u = teamsStore.getUser(resourceId);
        if (!u) return sendJson(res, 404, { error: `User '${resourceId}' not found` }), true;
        return sendJson(res, 200, clean(u)), true;
      }
      if (req.method === 'PUT' && resourceId) {
        const body = await readBody(req);
        return sendJson(res, 200, clean(teamsStore.updateUser(resourceId, body))), true;
      }
      if (req.method === 'DELETE' && resourceId) {
        // Offboarding (#1571, Phase 5): pause the departing human's agents and
        // auto-delete their personal credentials BEFORE removing the user
        // record, so a partial failure leaves the user recoverable rather than
        // a deleted user with lingering personal secrets (AC5). Best-effort —
        // the user removal is what the caller contracted for and still proceeds.
        let offboarding = null;
        try {
          offboarding = await orchestrator.offboardOwner(resourceId);
        } catch (err) {
          console.error(`[Orchestrator] offboarding failed for user ${resourceId}: ${err.message}`);
        }
        // Retire the departing human's Matrix account and delete their stored
        // access token (#1458), for the same reason personal credentials are
        // removed above: a live token must not outlive the user record. Runs
        // BEFORE deleteUser so a failure here leaves the user recoverable.
        try {
          await deprovisionHumanMatrixIdentity(orchestrator.adminClient, resourceId);
        } catch (err) {
          console.error(`[Orchestrator] Matrix de-provisioning failed for user ${resourceId}: ${err.message}`);
        }
        const deleted = teamsStore.deleteUser(resourceId);
        return sendJson(res, 200, { ...deleted, offboarding }), true;
      }
    }

    if (collection === 'memberships' && !resourceId) {
      if (req.method === 'GET') {
        return sendJson(res, 200, teamsStore.listMemberships({
          userId: parsed.searchParams.get('userId') || undefined,
          teamId: parsed.searchParams.get('teamId') || undefined,
        })), true;
      }
      if (req.method === 'POST') {
        const body = await readBody(req);
        return sendJson(res, 200, teamsStore.setMembership(body)), true;
      }
      if (req.method === 'DELETE') {
        return sendJson(res, 200, teamsStore.removeMembership({
          userId: parsed.searchParams.get('userId'),
          teamId: parsed.searchParams.get('teamId'),
        })), true;
      }
    }

    sendJson(res, 404, { error: 'unknown admin route' });
    return true;
  } catch (err) {
    sendJson(res, err.statusHint || 500, { error: err.message });
    return true;
  }
}

// ============================================================
// Main
// ============================================================
async function main() {
  if (!HOMESERVER) {
    console.error("MATRIX_HOMESERVER required");
    process.exit(1);
  }
  migrateLegacyAgentConfigs();
  migrateSkillGrantsToAgents();
  await migrateAgentClaudeMdToReference();
  bootstrapTeams();
  backfillResourceOwnership();
  // After backfillResourceOwnership, which is what guarantees every config
  // carries the `teamId` the D6 owner resolution keys on (#2077).
  migrateOwnershipModel();
  backfillTriggerHorizonStamps();

  const orchestrator = new Orchestrator();
  // Module-level handle for free-function callers that need instance methods
  // (today: the level-3 curator's auto-activation in autoPromoteStep).
  orchestratorSingleton = orchestrator;
  await orchestrator.init();

  // Legacy-memory migration (unification Phase 3) — one-shot per unified
  // agent, retried on every start until it succeeds. Needs git/network, so it
  // runs after init and must never block or break the boot.
  try { migrateUnifiedAgentsMemory(); }
  catch (err) { console.warn(`[Orchestrator] legacy-memory migration pass failed: ${err.message}`); }

  // Plugin broker sidecars (#1547): bring the live set in line with the
  // installed registry — start what is installed, stop orphans of anything
  // uninstalled while we were down. Best-effort and non-blocking: a broken
  // plugin image must never stop the stack from booting. Inert on the
  // kubernetes runtime (see spawn-kubernetes-pod.js Deliberate differences).
  reconcilePluginsAndAttachments()
    .catch((err) => console.warn(`[Orchestrator] plugin reconcile at boot failed: ${err.message}`));

  // Internal API — used by admin-console to manage agents
  const internalApi = http.createServer((req, res) => {
    // Teams data model (#299) — CRUD for the human Team / users / memberships.
    if (req.url.startsWith('/internal/admin/')) {
      handleTeamsAdminApi(req, res).catch(err => {
        console.error(`[Orchestrator] admin API error: ${err.message}`);
        if (!res.headersSent) sendJson(res, 500, { error: err.message });
      });
      return;
    }

    // Subscription-OAuth login flows for Model Providers. Proxied by the
    // admin console as /api/llm-auth/flows/*. The raw token is obtainable
    // only via the one-shot POST …/claim, which the admin console calls
    // server-side while persisting the endpoint — status responses never
    // carry it.
    if (req.method === 'POST' && req.url === '/internal/llm-auth/flows') {
      llmAuthFlows.start()
        .then(view => sendJson(res, 201, view))
        .catch(err => sendJson(res, 500, { error: err.message }));
      return;
    }
    const llmAuthFlowMatch = req.url.match(/^\/internal\/llm-auth\/flows\/([a-f0-9]+)(?:\/(code|claim))?$/);
    if (llmAuthFlowMatch) {
      const [, flowId, action] = llmAuthFlowMatch;
      if (!action && req.method === 'GET') {
        const view = llmAuthFlows.get(flowId);
        if (!view) return sendJson(res, 404, { error: 'flow not found' });
        return sendJson(res, 200, view);
      }
      if (!action && req.method === 'DELETE') {
        const r = llmAuthFlows.cancel(flowId);
        if (r.error) return sendJson(res, r.status || 400, { error: r.error });
        return sendJson(res, 200, { ok: true });
      }
      if (action === 'code' && req.method === 'POST') {
        readBody(req).then(body => {
          const r = llmAuthFlows.submitCode(flowId, body.code);
          if (r.error) return sendJson(res, r.status || 400, { error: r.error });
          sendJson(res, 200, r.view);
        }).catch(err => sendJson(res, 400, { error: err.message }));
        return;
      }
      if (action === 'claim' && req.method === 'POST') {
        const r = llmAuthFlows.claimToken(flowId);
        if (r.error) return sendJson(res, r.status || 400, { error: r.error });
        return sendJson(res, 200, { token: r.token });
      }
      return sendJson(res, 405, { error: 'method not allowed' });
    }

    // Read-only access to baked-in helper scripts referenced by agent
    // templates' preCheckScript. The allowlist is the only way to obtain a
    // path — no user-supplied path ever reaches the filesystem.
    const SCRIPT_ALLOWLIST = {
      'multi-agent-bid': '/usr/local/bin/multi-agent-bid',
    };
    const scriptMatch = req.method === 'GET' && req.url.match(/^\/internal\/scripts\/([^/?]+)$/);
    if (scriptMatch) {
      const name = scriptMatch[1];
      const filePath = SCRIPT_ALLOWLIST[name];
      if (!filePath) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'script not in allowlist' }));
        return;
      }
      fs.readFile(filePath, 'utf8', (err, content) => {
        if (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `read failed: ${err.code || err.message}` }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ name, path: filePath, content }));
      });
      return;
    }

    if (req.method === 'GET' && req.url === '/internal/agents/processes') {
      // Source of truth = Podman. The in-memory map is the fast path and the
      // authority for pid + this-process ownership, but it drifts (e.g. an
      // orchestrator restart race, or a container that died without the exit
      // handler firing). Merge the labelled live containers so the UI reflects
      // real container state instead of a stale map.
      (async () => {
        const byId = new Map();
        for (const [id, proc] of agentProcesses) {
          byId.set(id, { id, pid: proc.pid, running: !proc.exitCode && !proc.killed });
        }
        try {
          const filters = encodeURIComponent(JSON.stringify({ label: ['aee.agent.id'] }));
          const list = await libpodRequest('GET', `/containers/json?filters=${filters}`);
          if (list.status < 300 && Array.isArray(list.body)) {
            for (const c of list.body) {
              const labels = c.Labels || c.labels || {};
              const aid = labels['aee.agent.id'];
              if (!aid) continue;
              // Only surface THIS instance's containers — a parallel stack
              // sharing the Podman store also carries aee.agent.id labels, and
              // merging its agents would show phantom processes in this UI.
              if (labels[INSTANCE_LABEL_KEY] !== INSTANCE_ID) continue;
              const running = String(c.State || c.state || '').toLowerCase() === 'running';
              const cid = String(c.Id || c.ID || '').slice(0, 12) || null;
              const existing = byId.get(aid);
              if (existing) {
                existing.running = existing.running || running;
                if (!existing.pid && cid) existing.pid = cid;
              } else {
                byId.set(aid, { id: aid, pid: cid, running });
              }
            }
          }
        } catch (err) {
          console.warn(`[Orchestrator] /processes podman reconcile skipped: ${err.message}`);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([...byId.values()]));
      })();
      return;
    }

    // Quick "does this repo URL work with this SSH key" probe used by the
    // admin console to validate a Working Environment repo entry before save.
    if (req.method === 'POST' && req.url === '/internal/repository-check') {
      let body = '';
      req.on('data', d => body += d);
      req.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(body || '{}'); }
        catch { parsed = {}; }
        const url = typeof parsed.url === 'string' ? parsed.url.trim() : '';
        const sshKeyId = parsed.sshKeyId || null;
        const githubTokenId = parsed.githubTokenId || null;
        if (!url || url.startsWith('-')) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'url is required' }));
          return;
        }
        const isHttpsGithub = /^https?:\/\/(www\.)?github\.com\//i.test(url);
        const cmdEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
        if (sshKeyId) {
          const keyPath = path.join(SSH_KEYS_DIR, sshKeyId);
          const resolvedKey = path.resolve(keyPath);
          if (!resolvedKey.startsWith(path.resolve(SSH_KEYS_DIR) + path.sep)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'Invalid SSH key id' }));
            return;
          }
          if (!fs.existsSync(keyPath)) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: `SSH key not found: ${sshKeyId}` }));
            return;
          }
          try { fs.chmodSync(keyPath, 0o600); } catch { /* best effort */ }
          cmdEnv.GIT_SSH_COMMAND =
            `ssh -i ${keyPath} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null` +
            ` -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=8`;
        }
        // For HTTPS GitHub URLs inject PAT auth via GIT_CONFIG_* env vars so
        // the token never appears in process arguments (/proc/<pid>/cmdline).
        if (isHttpsGithub && githubTokenId) {
          const tokenPath = path.join(GH_TOKENS_DIR, githubTokenId);
          const resolvedToken = path.resolve(tokenPath);
          if (resolvedToken.startsWith(path.resolve(GH_TOKENS_DIR) + path.sep)) {
            try {
              const ghToken = fs.readFileSync(tokenPath, 'utf8').trim();
              if (ghToken) {
                const basic = Buffer.from(`x-access-token:${ghToken}`).toString('base64');
                cmdEnv.GIT_CONFIG_COUNT = '1';
                cmdEnv.GIT_CONFIG_KEY_0 = 'http.https://github.com/.extraheader';
                cmdEnv.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${basic}`;
              }
            } catch (err) {
              console.warn(`[Orchestrator] repository-check: cannot read GitHub token ${githubTokenId}: ${err.message}`);
            }
          }
        }
        const gitArgs = ['ls-remote', '--exit-code', '--symref', '--', url, 'HEAD'];
        execFile(
          'git',
          gitArgs,
          { env: cmdEnv, timeout: 12_000, maxBuffer: 1024 * 1024 },
          (err, stdout, stderr) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            if (!err) {
              // First line is the symref pointing HEAD at the default branch:
              //   "ref: refs/heads/<branch>\tHEAD". Resolve so the caller can
              //   record the actual default rather than guessing "main".
              const firstLine = (stdout || '').toString().split('\n')[0] || '';
              const m = firstLine.match(/^ref:\s+refs\/heads\/([^\s]+)\s+HEAD/);
              const branch = m ? m[1] : null;
              res.end(JSON.stringify({ ok: true, branch }));
              return;
            }
            // `git ls-remote --exit-code` returns 2 when the connection
            // succeeded but no refs matched — i.e. an empty repository (no
            // commits/branches/HEAD yet). That is reachable-and-authorized, not
            // a failure, so report it as OK-but-empty rather than surfacing the
            // benign SSH known-hosts warning as an error (fatal errors use 128).
            if (err.code === 2) {
              res.end(JSON.stringify({ ok: true, branch: null, empty: true }));
              return;
            }
            const detail = (stderr || err.message || '').toString().trim();
            // Strip any Authorization header line that may have leaked into the
            // error output before returning it to the caller. Match to end-of-line
            // so the full "Basic <base64>" value is covered, not just the first word.
            const sanitized = detail.replace(/Authorization:[^\r\n]*/gi, 'Authorization: [redacted]');
            // Skip benign SSH notices (first-connection known-hosts warnings)
            // so the real failure — "Permission denied", "Repository not found",
            // a timeout — surfaces instead of being masked by the warning line.
            const isNoise = (l) =>
              /^Warning:\s/i.test(l) || /Permanently added/i.test(l);
            const lines = sanitized.split('\n').map(l => l.trim()).filter(Boolean);
            const firstLine =
              lines.find(l => !isNoise(l)) || lines[0] || 'git ls-remote failed';
            res.end(JSON.stringify({ ok: false, error: firstLine.slice(0, 300) }));
          },
        );
      });
      return;
    }

    // ── Blueprint routes ───────────────────────────────────────────────────
    if (req.method === 'GET' && req.url === '/internal/blueprints') {
      const blueprints = listBlueprintIds().map(id => {
        const bp = loadBlueprint(id);
        const instances = listInstanceIds(id).map(iid => {
          const cfg = loadAgentConfig(iid);
          return { id: iid, displayName: cfg?.displayName || iid, enabled: cfg?.enabled !== false };
        });
        return { ...bp, instances };
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(blueprints));
      return;
    }

    const blueprintInstanceMatch = req.method === 'POST' && req.url.match(/^\/internal\/blueprints\/([^/]+)\/instances$/);
    if (blueprintInstanceMatch) {
      const blueprintId = decodeURIComponent(blueprintInstanceMatch[1]);
      let body = '';
      req.on('data', d => body += d);
      req.on('end', async () => {
        try {
          const { instanceId, displayName } = JSON.parse(body);
          if (!instanceId || !displayName) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'instanceId and displayName required' }));
            return;
          }
          const result = await orchestrator.createInstance(blueprintId, instanceId, displayName);
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (err) {
          console.error(`[Orchestrator] createInstance error: ${err.message}`);
          const status = /not found/i.test(err.message) ? 404 : /already exists/i.test(err.message) ? 409 : 500;
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    const blueprintMemoryGetMatch = req.method === 'GET' && req.url.match(/^\/internal\/blueprints\/([^/]+)\/memory\/([^/]+)$/);
    if (blueprintMemoryGetMatch) {
      const blueprintId = decodeURIComponent(blueprintMemoryGetMatch[1]);
      const filename = decodeURIComponent(blueprintMemoryGetMatch[2]);
      if (!loadBlueprint(blueprintId)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Blueprint not found' }));
        return;
      }
      const content = readBlueprintMemory(blueprintId, filename);
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(content);
      return;
    }

    const blueprintMemoryPutMatch = req.method === 'PUT' && req.url.match(/^\/internal\/blueprints\/([^/]+)\/memory\/([^/]+)$/);
    if (blueprintMemoryPutMatch) {
      const blueprintId = decodeURIComponent(blueprintMemoryPutMatch[1]);
      const filename = decodeURIComponent(blueprintMemoryPutMatch[2]);
      if (!loadBlueprint(blueprintId)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Blueprint not found' }));
        return;
      }
      let body = '';
      req.on('data', d => body += d);
      req.on('end', () => {
        try {
          writeBlueprintMemory(blueprintId, filename, body);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    const blueprintDeleteMatch = req.method === 'DELETE' && req.url.match(/^\/internal\/blueprints\/([^/]+)$/);
    if (blueprintDeleteMatch) {
      const blueprintId = decodeURIComponent(blueprintDeleteMatch[1]);
      if (!loadBlueprint(blueprintId)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Blueprint not found' }));
        return;
      }
      const instances = listInstanceIds(blueprintId);
      if (instances.length > 0) {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Blueprint has ${instances.length} instance(s). Delete them first.` }));
        return;
      }
      try {
        fs.rmSync(blueprintDir(blueprintId), { recursive: true });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    const blueprintUpdateMatch = req.method === 'PUT' && req.url.match(/^\/internal\/blueprints\/([^/]+)$/);
    if (blueprintUpdateMatch) {
      const blueprintId = decodeURIComponent(blueprintUpdateMatch[1]);
      let body = '';
      req.on('data', d => body += d);
      req.on('end', () => {
        try {
          const existing = loadBlueprint(blueprintId);
          if (!existing) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Blueprint not found' }));
            return;
          }
          const { displayName, role, systemPrompt } = JSON.parse(body || '{}');
          const updated = {
            ...existing,
            ...(displayName !== undefined && { displayName }),
            ...(role !== undefined && { role }),
            ...(systemPrompt !== undefined && { systemPrompt }),
          };
          saveBlueprint(blueprintId, updated);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(updated));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    const blueprintCreateMatch = req.method === 'POST' && req.url === '/internal/blueprints';
    if (blueprintCreateMatch) {
      let body = '';
      req.on('data', d => body += d);
      req.on('end', () => {
        try {
          const { id, displayName, role, systemPrompt, environmentId } = JSON.parse(body);
          if (!id || !displayName || !role || !environmentId) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'id, displayName, role, environmentId required' }));
            return;
          }
          // Teams may be created without a default prompt — members can carry
          // their own per-role prompts, and the team stores an empty template.
          if (!systemPrompt && role !== 'team') {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'systemPrompt is required for every role except team' }));
            return;
          }
          if (loadBlueprint(id)) {
            res.writeHead(409, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `Blueprint '${id}' already exists` }));
            return;
          }
          if (!loadEnvironment(environmentId)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `Working Environment '${environmentId}' not found` }));
            return;
          }
          const blueprint = { id, displayName, role, systemPrompt, environmentId, createdAt: new Date().toISOString() };
          saveBlueprint(id, blueprint);
          seedBlueprintMemory(id);
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(blueprint));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // ── End blueprint routes ───────────────────────────────────────────────

    // Rebuild an agent's CLAUDE.md after a config change the prompt is gated on
    // (#1286: setting/clearing the context mount). Idempotent and best-effort —
    // it always answers 200 with what happened.
    const promptRebuildMatch = req.method === 'POST' &&
      req.url.match(/^\/internal\/agents\/([^/]+)\/prompt-rebuild$/);
    if (promptRebuildMatch) {
      const id = decodeURIComponent(promptRebuildMatch[1]);
      let body = '';
      req.on('data', d => { body += d; });
      req.on('end', async () => {
        let reason = 'config change';
        try { reason = (JSON.parse(body || '{}').reason) || reason; } catch { /* keep default */ }
        const rebuilt = await rebuildAgentPrompt(id, reason);
        sendJson(res, 200, { rebuilt });
      });
      return;
    }

    // ── Read-only context-folder browsing (#1286) ─────────────────────────
    // The host folder mounted by #1283 exists ONLY inside the agent's own
    // container — the console reads the pool volume from its own container and
    // has no view of it. So the listing/read runs where the folder actually is:
    // a one-shot, read-only exec in that container. Guards, in order:
    //   • the agent must actually carry a `contextMount` (else 404 — an agent
    //     without one has no context surface at all);
    //   • the requested path is normalised here (no traversal, no absolute
    //     path) and re-checked inside the container by realpath containment,
    //     which is what stops a symlink from reaching the rest of the host;
    //   • only `list` and a capped `read` exist — there is no write mode.
    const contextBrowseMatch = req.method === 'GET' &&
      req.url.match(/^\/internal\/agents\/([^/]+)\/context\/(tree|file|download)(\?.*)?$/);
    if (contextBrowseMatch) {
      const id = decodeURIComponent(contextBrowseMatch[1]);
      const kind = contextBrowseMatch[2];
      (async () => {
        const cfg = loadAgentConfig(id);
        if (!cfg) return sendJson(res, 404, { error: 'agent not found' });
        // #1290: an agent has a context surface iff it has at least one folder
        // (multi-folder field or the legacy single-folder field). The browse
        // program lists under /context, and each folder's target (`/context` or
        // `/context/<slug>`) is a real path there, so a `<slug>/…` rel resolves
        // with no per-folder branch here.
        if (resolveContextMounts(cfg).length === 0) {
          return sendJson(res, 404, { error: 'agent has no context folder', code: 'no-context-mount' });
        }
        const rel = normalizeContextRel(new URL(req.url, 'http://localhost').searchParams.get('path') || '');
        if (!rel.ok) return sendJson(res, 400, { error: rel.error, code: 'invalid-path' });

        const cap = kind === 'download' ? CONTEXT_DOWNLOAD_MAX_BYTES : CONTEXT_FILE_MAX_BYTES;
        const argv = kind === 'tree' ? buildListArgv(rel.rel) : buildReadArgv(rel.rel, cap);
        // Output budget: base64 inflates by 4/3, plus the JSON envelope.
        const maxBytes = kind === 'tree' ? 16 * 1024 * 1024 : Math.ceil(cap * 1.4) + 64 * 1024;

        let out;
        try {
          out = await execInAgentContainer(id, argv, { timeoutMs: BROWSE_TIMEOUT_MS, maxBytes });
        } catch (err) {
          const code = err && err.code ? err.code : 'exec-failed';
          const status = code === 'no-container' ? 409
                       : code === 'timeout' ? 504
                       : code === 'too-large' ? 413
                       : 502;
          const message = code === 'no-container'
            ? 'The agent is not running, so its context folder cannot be read'
            : `Reading the context folder failed (${code})`;
          console.warn(`[Orchestrator] context browse ${kind} for ${id}: ${err.message}`);
          return sendJson(res, status, { error: message, code });
        }

        const parsed = parseBrowseOutput(out.stdout);
        if (!parsed.ok) {
          if (parsed.code === 'exec-failed') {
            console.warn(`[Orchestrator] context browse ${kind} for ${id}: ${parsed.error} (exit ${out.exitCode}, stderr ${String(out.stderr).slice(0, 200)})`);
          }
          return sendJson(res, statusForBrowseCode(parsed.code), { error: parsed.error, code: parsed.code });
        }
        if (kind === 'tree') {
          return sendJson(res, 200, {
            path: parsed.result.path || '',
            items: sortContextItems(parsed.result.items),
            truncated: !!parsed.result.truncated,
          });
        }
        return sendJson(res, 200, parsed.result);
      })().catch((err) => {
        console.error(`[Orchestrator] context browse error for ${id}: ${err.message}`);
        sendJson(res, 500, { error: 'context browse failed' });
      });
      return;
    }

    // ── Read-write context mount: DELETE a file/dir inside a mounted folder ──
    // The mount lives only in the agent's container, so the mutation runs there.
    // Guarded twice like browsing (request-side path normalise + in-container
    // realpath containment), plus a per-mount readWrite gate here and the kernel
    // EROFS backstop on a read-only bind mount.
    const contextDeleteMatch = req.method === 'DELETE' &&
      req.url.match(/^\/internal\/agents\/([^/]+)\/context\/file(\?.*)?$/);
    if (contextDeleteMatch) {
      const id = decodeURIComponent(contextDeleteMatch[1]);
      (async () => {
        const cfg = loadAgentConfig(id);
        if (!cfg) return sendJson(res, 404, { error: 'agent not found' });
        const mounts = resolveContextMounts(cfg);
        if (mounts.length === 0) return sendJson(res, 404, { error: 'agent has no context folder', code: 'no-context-mount' });
        const rel = normalizeContextRel(new URL(req.url, 'http://localhost').searchParams.get('path') || '');
        if (!rel.ok) return sendJson(res, 400, { error: rel.error, code: 'invalid-path' });
        if (!rel.rel) return sendJson(res, 400, { error: 'refusing to delete the mount root', code: 'invalid-path' });
        const mount = resolveContextMountForRel(mounts, rel.rel);
        if (!mount) return sendJson(res, 404, { error: 'not found', code: 'not-found' });
        if (!mount.readWrite) return sendJson(res, 403, { error: 'this context folder is mounted read-only', code: 'read-only' });
        const r = await runContextWriteExec(id, buildDeleteArgv(rel.rel));
        if (!r.ok) return sendJson(res, r.status, { error: r.error, code: r.code });
        return sendJson(res, 200, r.result);
      })().catch((err) => {
        console.error(`[Orchestrator] context delete error for ${id}: ${err.message}`);
        sendJson(res, 500, { error: 'context delete failed' });
      });
      return;
    }

    // ── Read-write context mount: MOVE (rename/relocate) within ONE folder ──
    // Source and destination directory must belong to the SAME read-write mount;
    // a cross-folder or workspace↔context move is not a rename (different
    // filesystems) and is refused here (and never offered by the UI).
    const contextMoveMatch = req.method === 'POST' &&
      req.url.match(/^\/internal\/agents\/([^/]+)\/context\/move$/);
    if (contextMoveMatch) {
      const id = decodeURIComponent(contextMoveMatch[1]);
      let body = '';
      req.on('data', d => { body += d; });
      req.on('end', () => {
        (async () => {
          const cfg = loadAgentConfig(id);
          if (!cfg) return sendJson(res, 404, { error: 'agent not found' });
          const mounts = resolveContextMounts(cfg);
          if (mounts.length === 0) return sendJson(res, 404, { error: 'agent has no context folder', code: 'no-context-mount' });
          let parsed;
          try { parsed = JSON.parse(body || '{}'); } catch { return sendJson(res, 400, { error: 'invalid JSON body', code: 'bad-body' }); }
          const from = normalizeContextRel(parsed.from || '');
          const toDir = normalizeContextRel(parsed.toDir || '');
          if (!from.ok) return sendJson(res, 400, { error: from.error, code: 'invalid-path' });
          if (!toDir.ok) return sendJson(res, 400, { error: toDir.error, code: 'invalid-path' });
          if (!from.rel) return sendJson(res, 400, { error: 'refusing to move the mount root', code: 'invalid-path' });
          const srcMount = resolveContextMountForRel(mounts, from.rel);
          const dstMount = resolveContextMountForRel(mounts, toDir.rel);
          if (!srcMount || !dstMount) return sendJson(res, 404, { error: 'not found', code: 'not-found' });
          if (srcMount.target !== dstMount.target) {
            return sendJson(res, 400, { error: 'cannot move between different context folders', code: 'cross-folder' });
          }
          if (!srcMount.readWrite) return sendJson(res, 403, { error: 'this context folder is mounted read-only', code: 'read-only' });
          const r = await runContextWriteExec(id, buildMoveArgv(from.rel, toDir.rel));
          if (!r.ok) return sendJson(res, r.status, { error: r.error, code: r.code });
          return sendJson(res, 200, r.result);
        })().catch((err) => {
          console.error(`[Orchestrator] context move error for ${id}: ${err.message}`);
          sendJson(res, 500, { error: 'context move failed' });
        });
      });
      return;
    }

    // ── Read-write context mount: UPLOAD one file into a mounted folder ──
    // Body is the raw file bytes (octet-stream); `path` is the target directory
    // and `name` the (possibly folder-upload) relative file path. `prepare-upload`
    // validates + de-duplicates the name in-container, then the bytes go in via
    // the libpod archive endpoint (the only ARG_MAX/stdin-free write channel).
    const contextUploadMatch = req.method === 'POST' &&
      req.url.match(/^\/internal\/agents\/([^/]+)\/context\/upload(\?.*)?$/);
    if (contextUploadMatch) {
      const id = decodeURIComponent(contextUploadMatch[1]);
      const params = new URL(req.url, 'http://localhost').searchParams;
      const chunks = [];
      let total = 0;
      let tooBig = false;
      req.on('data', (c) => {
        if (tooBig) return;
        total += c.length;
        if (total > CONTEXT_UPLOAD_MAX_BYTES) { tooBig = true; chunks.length = 0; return; }
        chunks.push(c);
      });
      req.on('end', () => {
        (async () => {
          if (tooBig) return sendJson(res, 413, { error: 'file too large', code: 'too-large' });
          const cfg = loadAgentConfig(id);
          if (!cfg) return sendJson(res, 404, { error: 'agent not found' });
          const mounts = resolveContextMounts(cfg);
          if (mounts.length === 0) return sendJson(res, 404, { error: 'agent has no context folder', code: 'no-context-mount' });
          const dir = normalizeContextRel(params.get('path') || '');
          if (!dir.ok) return sendJson(res, 400, { error: dir.error, code: 'invalid-path' });
          const mount = resolveContextMountForRel(mounts, dir.rel);
          if (!mount) return sendJson(res, 404, { error: 'target directory not found', code: 'not-found' });
          if (!mount.readWrite) return sendJson(res, 403, { error: 'this context folder is mounted read-only', code: 'read-only' });
          const name = sanitizeUploadName(params.get('name') || '');
          if (!name) return sendJson(res, 400, { error: 'invalid filename', code: 'invalid-path' });
          // Validate the target dir + resolve a collision-free entry name.
          const prep = await runContextWriteExec(id, buildPrepareUploadArgv(dir.rel, name));
          if (!prep.ok) return sendJson(res, prep.status, { error: prep.error, code: prep.code });
          const buf = Buffer.concat(chunks);
          let tar;
          try {
            tar = buildTar([{ name: prep.result.entry, body: buf }]);
          } catch (err) {
            return sendJson(res, 400, { error: `could not package the upload (${err.message})`, code: 'bad-entry' });
          }
          try {
            await putArchiveToAgentContainer(id, prep.result.base, tar, { timeoutMs: WRITE_TIMEOUT_MS });
          } catch (err) {
            const code = err && err.code ? err.code : 'exec-failed';
            const status = code === 'no-container' ? 409 : code === 'read-only' ? 403 : code === 'denied' ? 403 : code === 'timeout' ? 504 : 502;
            return sendJson(res, status, { error: `upload failed (${code})`, code });
          }
          return sendJson(res, 200, { uploaded: [{ name: prep.result.entry, size: buf.length }] });
        })().catch((err) => {
          console.error(`[Orchestrator] context upload error for ${id}: ${err.message}`);
          sendJson(res, 500, { error: 'context upload failed' });
        });
      });
      return;
    }

    // Convert one standalone agent into a team of one, in place (#2052).
    const convertMatch = req.method === 'POST'
      && req.url.match(/^\/internal\/agents\/([^/]+)\/convert-to-team$/);
    if (convertMatch) {
      const agentId = decodeURIComponent(convertMatch[1]);
      let body = '';
      req.on('data', d => body += d);
      req.on('end', async () => {
        try {
          const parsed = body ? JSON.parse(body) : {};
          const result = await orchestrator.convertAgentToTeam(agentId, { force: parsed.force === true });
          // A busy agent is a refusal the caller can retry with `force`, not an
          // error — the same 409-with-a-warning contract disable/enable uses.
          sendJson(res, result && result.warning ? 409 : 200, result);
        } catch (err) {
          console.error(`[Orchestrator] Convert-to-team error for ${agentId}: ${err.message}`);
          const status = /not found/i.test(err.message) ? 404
                       : /already taken/i.test(err.message) ? 409
                       : /cannot be converted|Cannot derive/i.test(err.message) ? 400
                       : 500;
          sendJson(res, status, { error: err.message, ...(err.code ? { code: err.code } : {}) });
        }
      });
      return;
    }

    const cloneMatch = req.method === 'POST' && req.url.match(/^\/internal\/agents\/([^/]+)\/clone$/);
    if (cloneMatch) {
      const sourceId = decodeURIComponent(cloneMatch[1]);
      let body = '';
      req.on('data', d => body += d);
      req.on('end', async () => {
        try {
          const { newId, newDisplayName, parentTeamId } = JSON.parse(body);
          if (!newId || !newDisplayName) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'newId and newDisplayName required' }));
            return;
          }
          const result = await orchestrator.cloneAgent(sourceId, newId, newDisplayName, {
            parentTeamId: parentTeamId || undefined,
          });
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (err) {
          console.error(`[Orchestrator] Clone error: ${err.message}`);
          const status = /not found/i.test(err.message) ? 404
                       : /already exists/i.test(err.message) ? 409
                       : /is not a team|cannot be cloned/i.test(err.message) ? 400
                       : 500;
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    if (req.method === 'POST' && req.url === '/internal/agents/import') {
      let body = '';
      req.on('data', d => body += d);
      req.on('end', async () => {
        try {
          const { stagingDir, agentId, displayName, parentTeamId } = JSON.parse(body || '{}');
          if (!stagingDir || !agentId) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'stagingDir and agentId required' }));
            return;
          }
          const result = await orchestrator.importAgent(stagingDir, agentId, {
            displayName: displayName || undefined,
            parentTeamId: parentTeamId || undefined,
          });
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (err) {
          console.error(`[Orchestrator] Import error: ${err.message}`);
          const status = /already exists/i.test(err.message) ? 409
                       : /not found/i.test(err.message) ? 404
                       : /invalid|missing|corrupt|not a valid/i.test(err.message) ? 400
                       : 500;
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // ── Orphan scan + one-off cleanup (#1960) ─────────────────────────────
    //
    // The cascade above is what stops NEW orphans being created; these two
    // routes are the one-off for an installation that already has some (from
    // before the cascade covered every case, from a hand-edited config, or from
    // a deletion that was interrupted after the team's own dir was gone — the
    // one state the DELETE route can no longer reach, because it 404s on a
    // parent that is not there).
    //
    // GET is the **dry run**: it lists exactly what a cleanup would act on and
    // changes nothing. It is also what makes the POST safe to describe — the
    // POST re-plans, logs the identical listing, and only then acts, so
    // "lists before acting" holds even for a caller that skipped the GET.
    //
    // Operator-invoked, never automatic on startup: deleting agents is a
    // destructive action and this codebase does not take those without an
    // explicit human decision.
    if (req.method === 'GET' && req.url.split('?')[0] === '/internal/agents/orphans') {
      const plan = agentOrphans.planOrphanCleanup(listAgentConfigs());
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(plan));
      return;
    }

    if (req.method === 'POST' && req.url.split('?')[0] === '/internal/agents/orphans/cleanup') {
      (async () => {
        const plan = agentOrphans.planOrphanCleanup(listAgentConfigs());
        // AC3 "lists what it would act on before acting" — the listing is
        // written to the log BEFORE the first deletion, so an operator watching
        // `podman logs -f orchestrator` sees the plan even if the run dies
        // halfway. It is also returned as `planned` so the caller has it.
        if (plan.orphans.length === 0) {
          console.log('[Orchestrator] Orphan cleanup: no orphaned agents found');
        } else {
          console.log(
            `[Orchestrator] Orphan cleanup: ${plan.orphans.length} orphaned agent(s) found, ` +
            `${plan.removable.length} to remove:\n` +
            plan.orphans.map(o => `  - ${agentOrphans.formatOrphanLine(o)}`).join('\n')
          );
        }

        const deleted = [];
        const warnings = [];
        const bgTargets = [];
        // Only the removable ones — a member whose named parent still exists as
        // a live non-team agent is reported and left alone, because correcting
        // the id is a human call and deleting it would be over-reach.
        for (const orphan of plan.removable) {
          const cfg = loadAgentConfig(orphan.id);
          if (!cfg) continue; // removed by someone else between plan and act
          agentTeardownRegistry.begin(orphan.id);
          try {
            // Same fast phase as the DELETE route, and in the same order: stop
            // → reap plugin scopes while the config is still on disk (§4.9) →
            // delete the files → drop the in-memory config.
            stopAgentProcess(orphan.id);
            await orchestrator.teardownAgentPluginScopes(orphan.id, cfg).catch(e =>
              console.warn(`[Orchestrator] plugin teardown ${orphan.id}: ${e.message}`));
            deleteAgentFiles(orphan.id);
            orchestrator.agentConfigs.delete(orphan.id);
            bgTargets.push({ id: orphan.id, deactivateMatrix: !!cfg.token });
            deleted.push(orphan.id);
          } catch (err) {
            // Never abort the sweep on one failure — the point of the routine is
            // that the NEXT run picks up whatever this one could not finish.
            agentTeardownRegistry.finish(orphan.id);
            console.error(`[Orchestrator] Orphan cleanup: '${orphan.id}' failed: ${err.message}`);
            warnings.push({ id: orphan.id, kind: 'orphan', error: err.message });
          }
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          scanned: plan.scanned,
          // The whole finding, then the subset the sweep acted on — so a caller
          // that only reads `planned` is never surprised by a shorter `deleted`.
          planned: plan.orphans,
          removable: plan.removable.map(o => o.id),
          reportOnly: plan.reportOnly,
          deleted,
          ...(warnings.length ? { warnings } : {}),
        }));

        // Slow reaping off the request path, exactly like the DELETE route —
        // a large sweep must not time out the caller. No team-knowledge purge
        // here: an orphan is never a `team` agent, so its KB scope belongs to
        // the parent that is already gone.
        (async () => {
          for (const t of bgTargets) {
            try {
              if (PER_AGENT_VOLUME) await removePerAgentVolume(t.id).catch(e =>
                console.warn(`[Orchestrator] volume teardown ${t.id}: ${e.message}`));
              await removePerAgentNetwork(t.id, { graceful: false }).catch(e =>
                console.warn(`[Orchestrator] network teardown ${t.id}: ${e.message}`));
              if (t.deactivateMatrix) await orchestrator.deactivateMatrixUser(t.id).catch(e =>
                console.warn(`[Orchestrator] matrix deactivate ${t.id}: ${e.message}`));
            } catch (err) {
              console.error(`[Orchestrator] Orphan cleanup background teardown for '${t.id}' failed: ${err.message}`);
            } finally {
              agentTeardownRegistry.finish(t.id);
            }
          }
          if (deleted.length > 0) {
            console.log(`[Orchestrator] Orphan cleanup: removed ${deleted.length} orphaned agent(s): ${deleted.join(', ')}`);
          }
        })().catch(err =>
          console.error(`[Orchestrator] Orphan cleanup background sweep crashed: ${err.message}`));
      })().catch(err => {
        console.error(`[Orchestrator] Orphan cleanup failed: ${err.message}`);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    const deleteMatch = req.method === 'DELETE' && req.url.match(/^\/internal\/agents\/([^/]+)$/);
    if (deleteMatch) {
      const id = decodeURIComponent(deleteMatch[1]);
      (async () => {
        // Ids we armed in the teardown registry — cleared on a fast-phase error
        // (so a retry isn't blocked) and, on success, one at a time as each
        // agent's background reaping finishes.
        const armed = [];
        // Agents whose slow reaping the background phase must finish, captured
        // in the fast phase while their configs were still readable.
        const bgTargets = [];
        let parentCfg = null;
        try {
          if (!fs.existsSync(agentDir(id))) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Agent not found' }));
            return;
          }

          // Cascade to children before deleting the parent. Without this,
          // deleting a team leaves its team-member stubs orphaned: they keep
          // the now-dangling parentTeamId, the UI can't render them under any
          // parent, and a re-created team can't reuse the deterministic member
          // ids because the orphans still occupy them. (#1962 removed the
          // orchestrator → bp-instance arm of this cascade with the rest of the
          // BriefingPack model; `team` is the only parent construct left.)
          //
          // Which children (#1960) is the pure, unit-tested `cascadeChildIds`:
          // materialized members and stubs alike, and — new here — the same set
          // when the parent's own config is unreadable, so an interrupted
          // deletion finishes the job on the retry instead of stranding the
          // members it never reached.
          parentCfg = loadAgentConfig(id);
          const cascaded = [];
          // A child that fails its fast steps used to be logged and dropped from
          // the response, so the caller was told all was well while a
          // half-deleted agent stayed on disk (#1960 AC2). Report it in the
          // `{ id, kind, error }` shape the team fan-out's `rollbackWarnings`
          // already uses, so a partial failure reads the same either way.
          const cascadeWarnings = [];

          // ── FAST PHASE (#1791) ────────────────────────────────────────────
          // Do only the cheap steps that make the agent *logically gone* — stop
          // the process, reap plugin scopes (while configs are still on disk so
          // §4.9 ordering + the sibling-still-held check both hold), delete
          // config.json (the agent leaves listAgentIds()/the UI), drop the
          // in-memory config. The slow, dominant work (per-agent network grace
          // poll + retries, volume, Matrix deactivation) is deferred to the
          // background phase after the response. Plugin teardown is kept here on
          // purpose: it is cheap ("only with plugins") and running it before
          // config.json is gone is the unambiguous way to satisfy the §4.9
          // "reap before the scope token/config is invalidated" contract.

          // deleteAgentFiles removes config.json, so listAgentIds() can no
          // longer guard a same-id re-create against this in-flight teardown —
          // arm the registry first so the create paths reject the id until the
          // background reaping below finishes (#1525).
          agentTeardownRegistry.begin(id);
          armed.push(id);

          // Fast-phase teardown for one agent: stop → plugin reap → delete
          // config → drop in-memory config. Records the agent for background
          // reaping. `graceful` (isGracefulDeleteRole, #1791 Change 2) keeps the
          // SIGTERM→commit→autoremove window only for a role that flushes work
          // on shutdown — since #1962 that is no role, so every agent is
          // force-removed. The flag stays as the seam for the next one.
          //
          // NOTE for #1962 reviewers: this is deliberately still routed through
          // isGracefulDeleteRole rather than hard-coded false, so "which roles
          // flush on shutdown" keeps its one named, unit-tested home.
          const fastTeardown = async (targetId, cfg, deactivateMatrix) => {
            stopAgentProcess(targetId);
            if (cfg) {
              // Reap plugin-owned resources BEFORE the config (and with it the
              // grant this scope is derived from) is deleted — §4.9 requires the
              // reap to precede token invalidation. At `team` granularity the
              // sibling-still-held check means only the last member torn down
              // actually reaps, so this must run while siblings are on disk.
              await orchestrator.teardownAgentPluginScopes(targetId, cfg).catch(e =>
                console.warn(`[Orchestrator] plugin teardown ${targetId}: ${e.message}`));
            }
            deleteAgentFiles(targetId);
            orchestrator.agentConfigs.delete(targetId);
            bgTargets.push({
              id: targetId,
              graceful: isGracefulDeleteRole(cfg ? cfg.role : null),
              deactivateMatrix,
            });
          };

          // Sequential on purpose: at `team` plugin-scope granularity only the
          // last member torn down actually reaps, so the children must be
          // processed one at a time with their siblings still on disk (§4.9).
          const childIds = cascadeChildIds(id, parentCfg, listAgentConfigs());
          for (const childId of childIds) {
            const childCfg = loadAgentConfig(childId);
            if (!childCfg) continue; // vanished between the scan and here
            agentTeardownRegistry.begin(childId);
            armed.push(childId);
            try {
              // Materialized child (has a token) → best-effort Matrix
              // cleanup in the background phase; a stub has no Matrix user.
              await fastTeardown(childId, childCfg, !!childCfg.token);
              cascaded.push(childId);
            } catch (err) {
              // One child failing its fast steps doesn't abort the rest (or the
              // parent) — but it is now reported, not just logged. It wasn't
              // recorded for background reaping, so release its guard.
              agentTeardownRegistry.finish(childId);
              console.error(`[Orchestrator] cascade-delete child '${childId}' failed: ${err.message}`);
              cascadeWarnings.push({ id: childId, kind: 'member', error: err.message });
            }
          }
          if (cascaded.length > 0) {
            console.log(
              `[Orchestrator] Cascade-deleted ${cascaded.length} team-member children of '${id}': ${cascaded.join(', ')}`
            );
          }
          if (cascadeWarnings.length > 0) {
            console.error(
              `[Orchestrator] Cascade-delete of '${id}' left ${cascadeWarnings.length} member(s) behind: ` +
              cascadeWarnings.map(w => `${w.id} (${w.error})`).join('; ') +
              ` — run the orphan cleanup (GET/POST /internal/agents/orphans) to finish them off`
            );
          }

          // Parent last. A parent fast-phase failure IS surfaced (below) — the
          // agent the caller asked to delete could not be removed.
          await fastTeardown(id, parentCfg, true);

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            ok: true,
            cascaded,
            // Omitted when clean, so a healthy delete's body is unchanged.
            ...(cascadeWarnings.length ? { cascadeWarnings } : {}),
          }));
        } catch (err) {
          // Fast-phase failure — surface a hard error to the console (AC8: a
          // fast-phase failure still returns an error to the caller). We do NOT
          // return: any agent already fast-torn-down (its config.json gone) is
          // recorded in bgTargets and must still be reaped below, or it would
          // leak its network/volume/Matrix user.
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
          }
          console.error(`[Orchestrator] agent delete fast phase for '${id}' failed: ${err.message}`);
        }

        // ── BACKGROUND PHASE (#1791) ──────────────────────────────────────────
        // Off the request path now that the response is sent. Best-effort and
        // fully idempotent; a failure here is logged (AC8) — it can no longer be
        // returned to the caller. Runs after either a 200 or a partial-failure
        // 500. Each id's guard is released only after its reaping finishes, so a
        // same-id re-create waits out the whole teardown.
        (async () => {
          for (const t of bgTargets) {
            try {
              if (PER_AGENT_VOLUME) await removePerAgentVolume(t.id).catch(e =>
                console.warn(`[Orchestrator] volume teardown ${t.id}: ${e.message}`));
              await removePerAgentNetwork(t.id, { graceful: t.graceful }).catch(e =>
                console.warn(`[Orchestrator] network teardown ${t.id}: ${e.message}`));
              if (t.deactivateMatrix) await orchestrator.deactivateMatrixUser(t.id).catch(e =>
                console.warn(`[Orchestrator] matrix deactivate ${t.id}: ${e.message}`));
              // Tear down the squad's team-scoped knowledge so a later same-name
              // (same-id) team can't silently re-adopt it (#532). Only for the
              // parent `team` entry — its own id is the KB scope; standalone/
              // member deletes leave the shared team KB intact. The parent is
              // reaped LAST (pushed after its members), so by here every member
              // is gone and the in-use guard sees the true survivor set. Runs
              // BEFORE the parent's guard is released in `finally`, so a same-id
              // team re-create can't slip between the release and the purge and
              // either read stale KB or have its freshly-seeded KB purged (AC7).
              if (t.id === id && parentCfg && parentCfg.role === 'team') {
                try { purgeTeamKnowledge(agentKnowledgeTeamId(parentCfg)); }
                catch (err) { console.warn(`[Orchestrator] knowledge purge for '${id}': ${err.message}`); }
              }
            } catch (err) {
              console.error(`[Orchestrator] background teardown for '${t.id}' failed: ${err.message}`);
            } finally {
              agentTeardownRegistry.finish(t.id);
            }
          }

          // Release the guard for any id armed but never recorded for reaping
          // (a child whose fast steps threw, or the parent on a fast-phase
          // failure) — there is nothing to reap, so it must not block a retry.
          const reaped = new Set(bgTargets.map(t => t.id));
          for (const aid of armed) {
            if (!reaped.has(aid)) agentTeardownRegistry.finish(aid);
          }
        })().catch(err =>
          console.error(`[Orchestrator] background teardown crashed for '${id}': ${err.message}`));
      })();
      return;
    }

    // ── Ephemeral agent ───────────────────────────────────────────────────
    if (req.method === 'POST' && req.url === '/internal/agents/ephemeral') {
      let body = '';
      req.on('data', d => body += d);
      req.on('end', async () => {
        try {
          const { blueprintId, displayName, missionPrompt, environmentId, timeoutSeconds } = JSON.parse(body);
          if (!displayName || !missionPrompt || !environmentId) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'displayName, missionPrompt, environmentId required' }));
            return;
          }

          const agentId = 'bp-' + randomHex(4);
          const env = loadEnvironment(environmentId);
          if (!env) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `Working Environment not found: ${environmentId}` }));
            return;
          }

          const password = `agent-${agentId}-${Date.now()}`;
          const userId = `@${agentId}:local`;

          if (orchestrator.adminClient) await ensureMatrixUser(orchestrator.adminClient, agentId, password);
          const token = await loginMatrixUser(agentId, password, orchestrator.adminClient);
          await setDisplayName(token, userId, displayName);

          // Initial grant for an ephemeral agent: one-time copy of the env's
          // legacy skill list (no operator UI on this path).
          const ephemeralSkills = Array.isArray(env.skills) ? [...env.skills] : [];
          const seedResult = blueprintId
            ? seedAgentWorkspaceForInstance(agentId, env, blueprintId, ephemeralSkills)
            : seedAgentWorkspace(agentId, env, { skills: ephemeralSkills });

          const systemPrompt = blueprintId
            ? (loadBlueprint(blueprintId)?.systemPrompt || displayName)
            : displayName;

          const config = {
            id: agentId,
            displayName,
            userId,
            token,
            role: 'agent',
            environmentId: env.id,
            teamId: DEFAULT_TEAM_ID,
            skills: ephemeralSkills,
            ephemeral: true,
            enabled: true,
            ...(blueprintId && { blueprintId }),
          };
          saveAgentConfig(agentId, config);
          saveAgentPrompt(agentId, systemPrompt, 'agent', env, blueprintId || null);

          const triggerId = 'trigger-' + randomHex(4);
          const fireAt = new Date(Date.now() + 5000).toISOString();
          saveTriggers(agentId, [{
            id: triggerId,
            type: 'once',
            enabled: true,
            at: fireAt,
            prompt: missionPrompt,
            ...(timeoutSeconds && { timeoutSeconds }),
          }]);

          orchestrator.agentConfigs.set(agentId, { config });
          startAgentProcess(config);

          const workspacePath = agentDir(agentId);
          console.log(`[Orchestrator] Created ephemeral agent ${agentId} (displayName=${displayName})`);
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ agentId, workspacePath }));
        } catch (err) {
          console.error(`[Orchestrator] Ephemeral agent create error: ${err.message}`);
          const statusCode = /not found/i.test(err.message) ? 400 : 500;
          res.writeHead(statusCode, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // ── Push: agent status (#185) ─────────────────────────────────────────
    // Agents POST their {state, updatedAt, lastResponseAt} here; we persist it
    // on the control-plane volume so status reads no longer touch the agent's
    // workspace. Last-writer-wins — no ordering contract.
    const pushStatusMatch = req.method === 'POST' && req.url.match(/^\/internal\/agents\/([^/]+)\/status$/);
    if (pushStatusMatch) {
      const id = decodeURIComponent(pushStatusMatch[1]);
      let body = '';
      req.on('data', (d) => { body += d; if (body.length > 1_000_000) req.destroy(); });
      req.on('end', () => {
        if (!isSafePathSeg(id)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'bad agent id' }));
          return;
        }
        try {
          const data = JSON.parse(body || '{}');
          const dir = controlAgentDir(id);
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify(data));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
      });
      return;
    }

    // ── Push: agent running-sessions registry (#185) ──────────────────────
    // Agents POST their running-sessions array; we persist it to the control
    // plane so the admin's "Sessions" tab works under per-agent volume
    // isolation (where the agent's own running-sessions.json is unreachable).
    const pushRunningMatch = req.method === 'POST' && req.url.match(/^\/internal\/agents\/([^/]+)\/running-sessions$/);
    if (pushRunningMatch) {
      const id = decodeURIComponent(pushRunningMatch[1]);
      let body = '';
      req.on('data', (d) => { body += d; if (body.length > 1_000_000) req.destroy(); });
      req.on('end', () => {
        if (!isSafePathSeg(id)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'bad agent id' }));
          return;
        }
        try {
          const data = JSON.parse(body || '[]');
          const dir = controlAgentDir(id);
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(path.join(dir, 'running-sessions.json'),
            JSON.stringify(Array.isArray(data) ? data : []));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
      });
      return;
    }

    // ── Push: agent session-log lines (#185) ──────────────────────────────
    // Agents POST { roomId, baseOffset, dataB64 } where dataB64 is the raw
    // bytes appended to their local sessions/<roomId>.jsonl since baseOffset.
    // We append byte-for-byte to the control-plane copy so the admin SSE
    // viewer's byte-cursor contract (?since=<byte>) stays valid. Reconciled on
    // baseOffset so a lost-ACK retry can't duplicate and a gap is self-healed:
    //   base == cur          → append all
    //   base <  cur (retry)  → append only the part beyond cur
    //   base >  cur (gap)    → reply {expected: cur}; the agent rewinds + resends
    const sessionEventsMatch = req.method === 'POST' && req.url.match(/^\/internal\/agents\/([^/]+)\/session-events$/);
    if (sessionEventsMatch) {
      const id = decodeURIComponent(sessionEventsMatch[1]);
      let body = '';
      req.on('data', (d) => { body += d; if (body.length > 16_000_000) req.destroy(); });
      req.on('end', () => {
        try {
          const { roomId, baseOffset, dataB64, rotate, seq } = JSON.parse(body || '{}');
          if (!isSafePathSeg(id) || !isSafePathSeg(roomId)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'bad id/roomId' }));
            return;
          }
          const dir = path.join(controlAgentDir(id), 'sessions');
          fs.mkdirSync(dir, { recursive: true });
          const fp = path.join(dir, `${roomId}.jsonl`);

          // ── Rotation command (#673) ──────────────────────────────────────
          // The agent has fully synced this room's live copy up to `baseOffset`
          // and now rotates it. We archive OUR live copy to <roomId>.<seq>.jsonl
          // at the same boundary — so the two archives are byte-identical — then
          // prune, and let the next append recreate the live file. The admin SSE
          // tail sees the live file shrink and emits `_truncated` (UI re-backfills).
          if (rotate === true) {
            const seqN = Number(seq);
            if (!Number.isInteger(seqN) || seqN < 1) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: 'bad seq' }));
              return;
            }
            const cfg = rotationConfig(process.env);
            const archiveFp = path.join(dir, archiveName(roomId, seqN));
            // Idempotent: a lost-ACK retry finds the archive already written and
            // the live file already recreated — do NOT clobber it with new data.
            if (fs.existsSync(archiveFp)) {
              pruneControlSessionArchives(dir, roomId, cfg);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true, rotated: true, seq: seqN }));
              return;
            }
            let cur = 0;
            try { cur = fs.statSync(fp).size; } catch { cur = 0; }
            // Guard: only rotate once we hold every byte the agent archived, so
            // the control archive can't lose the un-synced tail. If we're behind,
            // tell the agent to resend from `cur` first (it drains, then retries).
            const base = Number.isFinite(Number(baseOffset)) ? Number(baseOffset) : 0;
            if (base > cur) {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, expected: cur }));
              return;
            }
            if (fs.existsSync(fp)) fs.renameSync(fp, archiveFp);
            pruneControlSessionArchives(dir, roomId, cfg);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, rotated: true, seq: seqN }));
            return;
          }

          const buf = Buffer.from(dataB64 || '', 'base64');
          let cur = 0;
          try { cur = fs.statSync(fp).size; } catch { cur = 0; }
          // Reconcile against baseOffset (pure helper, unit-tested in
          // session-cursor.test.js — the byte-cursor "sharp edge").
          const recon = reconcileSessionAppend(baseOffset, cur, buf.length);
          if (recon.gap) {
            // Gap: control file is behind the agent — ask it to resend from cur.
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, expected: recon.expected }));
            return;
          }
          if (recon.appendLen > 0) {
            fs.appendFileSync(fp, buf.subarray(recon.sliceFrom));
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, offset: recon.offset }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
      });
      return;
    }

    // ── Ingest: agent token-usage records (#654) ─────────────────────────
    // Agents POST one usage record per invocation (build_usage_record in
    // agent-image/scripts/agent-entrypoint.py), delivered via their durable
    // spool + retry push client. We enrich it with the authoritative
    // control-plane identity (teamId/roleId/provider the agent can only
    // guess) and append it to the day-bucketed usage log. The append is
    // best-effort; a transient failure is covered by the agent's spool retry.
    const usageIngestMatch = req.method === 'POST' && req.url.match(/^\/internal\/agents\/([^/]+)\/usage$/);
    if (usageIngestMatch) {
      const id = decodeURIComponent(usageIngestMatch[1]);
      let body = '';
      req.on('data', (d) => { body += d; if (body.length > 1_000_000) req.destroy(); });
      req.on('end', () => {
        if (!isSafePathSeg(id)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'bad agent id' }));
          return;
        }
        try {
          const rec = JSON.parse(body || '{}');
          if (!rec || typeof rec !== 'object' || Array.isArray(rec)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'record must be an object' }));
            return;
          }
          usageLog.record(enrichUsageRecord(id, rec));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
      });
      return;
    }

    // ── Read: agent-facing read-only usage summary (#679) ─────────────────
    // An agent container is volume-isolated from /workspace/usage/, so it
    // cannot read the store directly; the on-agent `usage` CLI queries here.
    // The orchestrator (the store owner) reads the records and hands them to
    // the pure scoping + aggregation core (usage-query.js). Fail-closed team
    // resolution: an UNKNOWN agent (no config) resolves to teamId=null, so a
    // team-scoped query returns an empty set — never another team's usage.
    // Tokens only; no dollar figures ever ride along.
    const usageSummaryMatch = req.method === 'GET' && req.url.split('?')[0].match(/^\/internal\/agents\/([^/]+)\/usage\/summary$/);
    if (usageSummaryMatch) {
      const id = decodeURIComponent(usageSummaryMatch[1]);
      if (!isSafePathSeg(id)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'bad agent id' }));
        return;
      }
      try {
        const u = new URL(req.url, 'http://localhost');
        const scope = u.searchParams.get('scope') || 'self';
        const since = u.searchParams.get('since') || undefined;
        const until = u.searchParams.get('until') || undefined;
        const groupBy = u.searchParams.get('groupBy') || undefined;
        // Fail-closed: only a resolvable config yields a team id. An unknown
        // agent → null → team scope can match nothing.
        const cfg = loadAgentConfig(id);
        const teamId = cfg ? agentKnowledgeTeamId(cfg) : null;
        const records = usageLog.readRecords({ since });
        const result = usageQuery.buildUsageQuery(records, { scope, agentId: id, teamId, since, until, groupBy });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    // ── Push: per-room session pointer mirror (#185 Phase 2) ──────────────
    // Agents POST { roomId, sessionId, updatedAt }. The pointer (<roomId>.
    // current.json) is agent-authored (it drives --resume) but admin-read (the
    // "Session aktiv" badge / session-reset). With per-agent volumes the admin
    // can't read the agent's copy, so the agent mirrors it here. Whole-file,
    // last-writer-wins like status.json. An empty/absent sessionId clears it
    // (used by the session-reset path so the badge drops).
    const sessionPointerMatch = req.method === 'POST' && req.url.match(/^\/internal\/agents\/([^/]+)\/session-pointer$/);
    if (sessionPointerMatch) {
      const id = decodeURIComponent(sessionPointerMatch[1]);
      let body = '';
      req.on('data', (d) => { body += d; if (body.length > 1_000_000) req.destroy(); });
      req.on('end', () => {
        try {
          const { roomId, sessionId, updatedAt } = JSON.parse(body || '{}');
          if (!isSafePathSeg(id) || !isSafePathSeg(roomId)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'bad id/roomId' }));
            return;
          }
          const dir = path.join(controlAgentDir(id), 'sessions');
          fs.mkdirSync(dir, { recursive: true });
          const fp = path.join(dir, `${roomId}.current.json`);
          if (typeof sessionId === 'string' && sessionId) {
            fs.writeFileSync(fp, JSON.stringify({ sessionId, updatedAt: updatedAt || new Date().toISOString() }));
          } else {
            try { fs.unlinkSync(fp); } catch { /* already gone */ }
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
      });
      return;
    }

    // ── Pending-triggers drain (#185 Phase 2) ────────────────────────────
    // The isolated agent pulls its queue here every ~5s; read-and-clear is
    // atomic in this single event loop, so no entry is lost between the read
    // and the clear even with concurrent enqueues.
    const pendingDrainMatch = req.method === 'GET' && req.url.match(/^\/internal\/agents\/([^/]+)\/pending-drain$/);
    if (pendingDrainMatch) {
      const id = decodeURIComponent(pendingDrainMatch[1]);
      if (!isSafePathSeg(id)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'bad agent id' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, entries: drainPending(id) }));
      return;
    }

    // Drain ONE entry (#1195 follow-up): pop the head, keep the tail durably
    // queued. The agent loops this per entry so a long first run can't leave
    // the rest stranded in a volatile in-memory list.
    const pendingDrainOneMatch = req.method === 'GET' && req.url.match(/^\/internal\/agents\/([^/]+)\/pending-drain-one$/);
    if (pendingDrainOneMatch) {
      const id = decodeURIComponent(pendingDrainOneMatch[1]);
      if (!isSafePathSeg(id)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'bad agent id' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, entry: drainPendingOne(id) }));
      return;
    }

    // ── Enqueue a pending entry (#185 Phase 2) ────────────────────────────
    // The admin-console is a separate process, so to keep this queue
    // single-writer (and the drain race-free) it hands entries in through us
    // rather than writing the file itself.
    const enqueuePendingMatch = req.method === 'POST' && req.url.match(/^\/internal\/agents\/([^/]+)\/enqueue-pending$/);
    if (enqueuePendingMatch) {
      const id = decodeURIComponent(enqueuePendingMatch[1]);
      let body = '';
      req.on('data', (d) => { body += d; if (body.length > 4_000_000) req.destroy(); });
      req.on('end', () => {
        if (!isSafePathSeg(id)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'bad agent id' }));
          return;
        }
        try {
          const entry = JSON.parse(body || '{}');
          if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'entry must be an object' }));
            return;
          }
          enqueuePending(id, entry);
          res.writeHead(202, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
      });
      return;
    }

    // ── Internal-channel emit (#1173, epic #1172) ─────────────────────────
    // A producer agent announces "label L set on issue/PR #n of repo R"
    // (via the `aee-emit` CLI) and the wake is delivered directly to every
    // `transport: 'internal'` listener — enqueue FIRST, then mirror the label
    // onto GitHub as decoration (best-effort). Internal-transport triggers
    // are excluded from the poller plan (`pollerSubscribes`), so the mirror
    // stamp can never double-deliver. docs/internal-channels-concept.md §4.2.
    if (req.method === 'POST' && req.url === '/internal/flow-emit') {
      let body = '';
      req.on('data', (d) => { body += d; if (body.length > 1_000_000) req.destroy(); });
      req.on('end', async () => {
        let parsed;
        try {
          parsed = flowEmit.validateEmitRequest(JSON.parse(body || '{}'));
        } catch (err) {
          parsed = { ok: false, error: err.message };
        }
        if (!parsed.ok) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: parsed.error }));
          return;
        }
        try {
          const { agentId, repo, label, target } = parsed.value;
          const key = flowEmit.eventKeyForKind(target.kind);
          const agents = listAgentIds().map((aid) => ({
            agentId: aid,
            enabled: loadAgentConfig(aid)?.enabled !== false,
            triggers: loadTriggers(aid),
          }));
          const listeners = flowEmit.matchInternalListeners(
            { repo, label, kind: target.kind }, agents);
          // #1897 AC8: resolve the title best-effort so the notice isn't blank.
          const title = await fetchWorkItemTitle(repo, target.kind, target.number);
          const ghEvent = flowEmit.buildSyntheticEvent({
            repo, label, kind: target.kind, number: target.number, title,
            producerId: agentId,
            eventId: `int:${crypto.randomBytes(6).toString('hex')}`,
            now: new Date().toISOString(),
          });
          for (const l of listeners) {
            enqueuePending(l.agentId, flowEmit.buildPendingEntry(l.triggerId, key, ghEvent));
            console.log(
              `[Orchestrator] flow-emit: ${repo}#${target.number} +${label} ` +
              `by ${agentId} → agent=${l.agentId} trigger=${l.triggerId}`);
          }
          const warnings = [];
          const labelStamped = await stampMirrorLabel(repo, target.number, label, warnings);
          // Same transparency log the poller writes, tagged with the delivery
          // path — internal and polled events share one operator timeline.
          githubEventLog.record({
            ...githubEventLog.buildEventEntry({
              ghEvent, repoFullName: repo, key,
              outcomes: listeners.map((l) => ({
                agentId: l.agentId, triggerId: l.triggerId,
                status: 'delivered', reason: null, digest: false,
              })),
            }),
            source: 'internal',
            emittedBy: agentId,
          });
          if (listeners.length === 0) {
            console.log(
              `[Orchestrator] flow-emit: ${repo}#${target.number} +${label} ` +
              `by ${agentId} matched no internal listener (label ${labelStamped ? 'stamped' : 'NOT stamped'})`);
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            ok: true,
            matched: listeners.length,
            listeners,
            labelStamped,
            warnings,
          }));
        } catch (err) {
          console.error(`[Orchestrator] flow-emit error: ${err.message}`);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
      });
      return;
    }

    // ── Direct agent-to-agent hand-off (#2030) ────────────────────────────
    // A producer agent says "dear agent, take this over" (via the `aee-wake`
    // CLI) and the wake is delivered straight into the target's durable queue
    // as a `kind: 'wake-agent'` entry. TARGET-LESS: no label, no issue/PR, no
    // poller subscription is involved at any step — which is the point, and
    // also why the event-log row below is not optional.
    // docs/direct-agent-handoff-concept.md §5/§5.2.
    if (req.method === 'POST' && req.url === '/internal/wake-agent') {
      let body = '';
      req.on('data', (d) => { body += d; if (body.length > 1_000_000) req.destroy(); });
      req.on('end', () => {
        let parsed;
        try {
          parsed = wakeAgent.validateWakeRequest(JSON.parse(body || '{}'));
        } catch (err) {
          parsed = { ok: false, error: err.message };
        }
        if (!parsed.ok) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: parsed.error }));
          return;
        }
        try {
          const { fromAgentId, toAgentId, note } = parsed.value;
          const agents = listAgentIds().map((aid) => ({
            agentId: aid,
            config: loadAgentConfig(aid),
          }));
          const resolved = wakeAgent.resolveWakeTarget(
            { fromAgentId, toRoleId: toAgentId }, agents);
          if (!resolved.ok) {
            const status = wakeAgent.WAKE_REFUSALS[resolved.reason] || 400;
            console.log(
              `[Orchestrator] wake-agent: ${fromAgentId} → ${toAgentId} refused `
              + `(${resolved.reason})`);
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, reason: resolved.reason }));
            return;
          }
          // Enqueue first, log second — the same ordering flow-emit uses: the
          // hand-off is what must not be lost, and the log is best-effort.
          const enqueued = enqueuePending(resolved.agentId, wakeAgent.buildWakeEntry({
            from: fromAgentId, note, teamId: resolved.teamId,
          }));
          if (enqueued === false) {
            // Unlike a label emit, nothing else records that this happened —
            // no label, no issue/PR, no GitHub trace. Confirming a hand-off
            // whose queue write failed would lose it silently, which is the one
            // outcome this feature exists to prevent. 500, so `aee-wake` exits
            // non-zero and the producer surfaces it.
            console.error(
              `[Orchestrator] wake-agent: ${fromAgentId} → ${resolved.agentId} `
              + `NOT delivered (queue write failed)`);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'could not write the target\'s pending queue — the hand-off was NOT delivered' }));
            return;
          }
          console.log(
            `[Orchestrator] wake-agent: ${fromAgentId} → agent=${resolved.agentId} `
            + `team=${resolved.teamId}${note ? ` note=${note.length}ch` : ''}`);
          // A label-free hand-off leaves NO trace on GitHub, so the platform's
          // own log is how #1172's workspace-transparency principle is honoured
          // here — not optional, and one row per hand-off.
          const eventId = `wake:${crypto.randomBytes(6).toString('hex')}`;
          const ghEvent = wakeAgent.buildWakeLogEvent({
            producerId: fromAgentId, targetId: resolved.agentId, note,
            eventId, now: new Date().toISOString(),
          });
          githubEventLog.record({
            ...githubEventLog.buildEventEntry({
              ghEvent, repoFullName: null, key: wakeAgent.WAKE_EVENT_KEY,
              outcomes: [{
                agentId: resolved.agentId, triggerId: null,
                status: 'delivered', reason: null, digest: false,
              }],
            }),
            source: 'internal',
            emittedBy: fromAgentId,
            // The producer→target pair and the note, in fields that mean that
            // (#2032) — `buildEventEntry` only extracts GitHub's own
            // vocabulary, so without this the note would never reach the log.
            ...wakeAgent.buildWakeLogFields({
              producerId: fromAgentId, targetId: resolved.agentId, note,
            }),
          });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, target: resolved.agentId }));
        } catch (err) {
          console.error(`[Orchestrator] wake-agent error: ${err.message}`);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
      });
      return;
    }

    // ── Internal label fast-path (#1858) ──────────────────────────────────
    // POST /internal/github-label-applied { repo, number, kind, label, actor }.
    // The Admin Console calls this right after a human-applied label write
    // succeeds through the GitHub Issues plugin (writeLabel(...,'add')). The
    // GitHub Events API drops/coalesces label events under churn, so instead of
    // waiting for the poller to (maybe) see the `*.labeled` event, we wake the
    // POLLER-SUBSCRIBED listener directly and leave a dedup marker so the
    // poller drops the later duplicate. The label itself is unchanged on GitHub
    // (the human already applied it) — this path does NOT stamp any label. The
    // target trigger stays transport:'github' (no config change).
    if (req.method === 'POST' && req.url === '/internal/github-label-applied') {
      let body = '';
      req.on('data', (d) => { body += d; if (body.length > 1_000_000) req.destroy(); });
      req.on('end', async () => {
        let parsed;
        try {
          parsed = labelFastPath.validateLabelAppliedRequest(JSON.parse(body || '{}'));
        } catch (err) {
          parsed = { ok: false, error: err.message };
        }
        if (!parsed.ok) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: parsed.error }));
          return;
        }
        try {
          const { repo, number, kind, label, actor } = parsed.value;
          const key = labelFastPath.eventKeyForKind(kind);
          const agents = listAgentIds().map((aid) => ({
            agentId: aid,
            enabled: loadAgentConfig(aid)?.enabled !== false,
            triggers: loadTriggers(aid),
          }));
          const listeners = labelFastPath.matchPollerListeners({ repo, label, kind }, agents);
          const now = new Date().toISOString();
          // #1897 AC8: resolve the title best-effort so the notice isn't blank.
          const title = await fetchWorkItemTitle(repo, kind, number);
          const ghEvent = labelFastPath.buildSyntheticEvent({
            repo, label, kind, number, title, actor,
            eventId: `intlbl:${crypto.randomBytes(6).toString('hex')}`,
            now,
          });
          for (const l of listeners) {
            // Enqueue first (immediate wake), then arm the dedup marker so the
            // poller's later delivery of the same label is dropped.
            enqueuePending(l.agentId, {
              ...flowEmit.buildPendingEntry(l.triggerId, key, ghEvent),
              source: 'internal-plugin',
            });
            labelDedupMarkers.add({
              agentId: l.agentId, triggerId: l.triggerId,
              repo, kind, number, label, appliedAt: now,
            });
            console.log(
              `[Orchestrator] label-fastpath: ${repo}#${number} +${label} ` +
              `by ${actor || 'console'} → agent=${l.agentId} trigger=${l.triggerId}`);
          }
          // Same transparency log the poller writes, tagged with the delivery
          // path so operators see an honest "delivered internally" line.
          githubEventLog.record({
            ...githubEventLog.buildEventEntry({
              ghEvent, repoFullName: repo, key,
              outcomes: listeners.map((l) => ({
                agentId: l.agentId, triggerId: l.triggerId,
                status: 'delivered', reason: null, digest: false, wakeLabel: label,
              })),
            }),
            source: 'internal-plugin',
          });
          if (listeners.length === 0) {
            console.log(
              `[Orchestrator] label-fastpath: ${repo}#${number} +${label} matched no poller listener`);
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, matched: listeners.length, listeners }));
        } catch (err) {
          console.error(`[Orchestrator] label-fastpath error: ${err.message}`);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
      });
      return;
    }

    // ── Team roster for the loop verifier (#933) ──────────────────────────
    // A team loop agent with an empty `verify` reads its sibling roster to
    // enforce a *different* verifier (concept §4.6 decision 1). Read-only.
    const teamRosterMatch = req.method === 'GET' && req.url.match(/^\/internal\/agents\/([^/]+)\/team-roster$/);
    if (teamRosterMatch) {
      const id = decodeURIComponent(teamRosterMatch[1]);
      if (!isSafePathSeg(id)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'bad agent id' }));
        return;
      }
      try {
        const configs = listAgentIds().map((aid) => {
          const c = loadAgentConfig(aid);
          return c ? { ...c, id: aid } : null;
        });
        const roster = computeTeamRoster(id, configs);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, ...roster }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    // ── Provisioned slash commands (#1796, foundation for #1797) ──────────
    // The list of custom slash commands currently provisioned into an agent's
    // workspace (name + optional description per command). The **workspace is the
    // source of truth** (#1797): we enumerate the actual `.claude/commands/` tree
    // so a command dropped in by hand — never recorded in seeded-commands.json —
    // surfaces too. The manifest is read only to attribute each seeded command to
    // its originating skill. #1797's composer autocomplete consumes this via the
    // console proxy.
    const commandsListMatch = req.method === 'GET' && req.url.match(/^\/internal\/agents\/([^/]+)\/commands$/);
    if (commandsListMatch) {
      const id = decodeURIComponent(commandsListMatch[1]);
      if (!isSafePathSeg(id)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'bad agent id' }));
        return;
      }
      try {
        const commandsRoot = path.join(agentDir(id), skillCommands.AGENT_COMMANDS_DIR);
        const commands = skillCommands.scanProvisionedCommands(commandsRoot, { manifest: readSeededCommands(id) });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, agentId: id, commands }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    // ── Loop verifier verdict rendezvous (#933, AC2) ──────────────────────
    // POST: the target verifier agent posts its pass/fail verdict for a token.
    // GET:  the requesting loop polls for that verdict.
    if (req.method === 'POST' && req.url.split('?')[0] === '/internal/loop-verify/verdict') {
      let body = '';
      req.on('data', (d) => { body += d; if (body.length > 4_000_000) req.destroy(); });
      req.on('end', () => {
        try {
          const payload = JSON.parse(body || '{}');
          const token = payload && payload.token;
          if (typeof token !== 'string' || !token) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'token required' }));
            return;
          }
          loopVerifyStore.set(token, payload.passed, payload.output);
          res.writeHead(202, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
      });
      return;
    }
    if (req.method === 'GET' && req.url.split('?')[0] === '/internal/loop-verify/verdict') {
      const token = new URL(req.url, 'http://localhost').searchParams.get('token') || '';
      if (!token) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'token required' }));
        return;
      }
      const verdict = loopVerifyStore.get(token);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ...verdict }));
      return;
    }

    // ── Pending-queue operator view (#724) ────────────────────────────────
    // Read-only, aggregated across every agent — does NOT drain (AC1). Used by
    // the admin console's GitHub Event Log "pending queue" section.
    if (req.method === 'GET' && req.url.split('?')[0] === '/internal/pending-queue') {
      try {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, ...aggregatePendingQueue() }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    // ── Pending-queue single-entry detail + cancel (#724) ─────────────────
    // GET returns the full entry (incl. the GitHub payload the list omits);
    // DELETE cancels exactly one entry by id, race-free in this event loop and
    // a graceful no-op when the entry is already gone (AC5/AC6/AC7).
    const pendingEntryMatch = req.url.split('?')[0].match(/^\/internal\/agents\/([^/]+)\/pending\/([^/]+)$/);
    if (pendingEntryMatch && (req.method === 'GET' || req.method === 'DELETE')) {
      const id = decodeURIComponent(pendingEntryMatch[1]);
      const entryId = decodeURIComponent(pendingEntryMatch[2]);
      if (!isSafePathSeg(id)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'bad agent id' }));
        return;
      }
      try {
        if (req.method === 'GET') {
          const entry = readPendingEntry(id, entryId);
          if (!entry) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'entry not found' }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, entry }));
          return;
        }
        const result = cancelPendingEntry(id, entryId);
        // Not-found is a clear no-op, not an error (AC7): report removed:false
        // with a 200 so the UI can refresh and show the entry already gone.
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, ...result }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    // ── Targeted re-seed of an isolated agent's dedicated volume (#185 item 5) ─
    // After the admin (or orchestrator) rewrites a running agent's control-plane
    // files on the pool subpath, it asks us to mirror the named paths into the
    // agent's dedicated volume — the orchestrator is the only writer that can
    // reach it. No-op with the flag off or when the agent isn't running (see
    // reseedAgent); reseedPerAgentVolume re-validates each path (allowlist).
    const reseedMatch = req.method === 'POST' && req.url.match(/^\/internal\/agents\/([^/]+)\/reseed$/);
    if (reseedMatch) {
      const id = decodeURIComponent(reseedMatch[1]);
      let body = '';
      req.on('data', (d) => { body += d; if (body.length > 1_000_000) req.destroy(); });
      req.on('end', async () => {
        if (!isSafePathSeg(id)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'bad agent id' }));
          return;
        }
        try {
          const { paths } = JSON.parse(body || '{}');
          if (!Array.isArray(paths)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'paths must be an array' }));
            return;
          }
          const result = await reseedAgent(id, paths);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, ...result }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
      });
      return;
    }

    // ── Session reset (#185 Phase 2) ──────────────────────────────────────
    // The admin can't delete an isolated agent's session pointer, so it asks
    // us. We drop the pushed mirror (badge clears now) and, when isolated,
    // enqueue a command so the agent drops its own --resume pointer. With the
    // flag off the admin still deletes the pool pointer directly, so we skip
    // the command to keep that path unchanged.
    const sessionResetMatch = req.method === 'POST' && req.url.match(/^\/internal\/agents\/([^/]+)\/session-reset$/);
    if (sessionResetMatch) {
      const id = decodeURIComponent(sessionResetMatch[1]);
      let body = '';
      req.on('data', (d) => { body += d; if (body.length > 1_000_000) req.destroy(); });
      req.on('end', () => {
        try {
          const { roomId } = JSON.parse(body || '{}');
          if (!isSafePathSeg(id) || !isSafePathSeg(roomId)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'bad id/roomId' }));
            return;
          }
          try { fs.unlinkSync(path.join(controlAgentDir(id), 'sessions', `${roomId}.current.json`)); } catch { /* already gone */ }
          if (PER_AGENT_VOLUME) enqueuePending(id, { kind: 'session-reset', roomId });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
      });
      return;
    }

    // ── Session set / resume (#574) ───────────────────────────────────────
    // The admin re-points the room at a finished session (Sessions-tab resume).
    // We write the pushed pointer mirror (badge shows active now) and, when
    // isolated, enqueue a command so the agent writes its own --resume pointer
    // plus a resume-intent marker (so a failed --resume surfaces as an error
    // rather than silently starting fresh — AC6). With the flag off the admin
    // already wrote the pool pointer + marker directly, so we only mirror.
    const sessionSetMatch = req.method === 'POST' && req.url.match(/^\/internal\/agents\/([^/]+)\/session-set$/);
    if (sessionSetMatch) {
      const id = decodeURIComponent(sessionSetMatch[1]);
      let body = '';
      req.on('data', (d) => { body += d; if (body.length > 1_000_000) req.destroy(); });
      req.on('end', () => {
        try {
          const { roomId, sessionId, resumeRequested } = JSON.parse(body || '{}');
          if (!isSafePathSeg(id) || !isSafePathSeg(roomId) || typeof sessionId !== 'string' || !sessionId) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'bad id/roomId/sessionId' }));
            return;
          }
          const dir = path.join(controlAgentDir(id), 'sessions');
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(
            path.join(dir, `${roomId}.current.json`),
            JSON.stringify({ sessionId, updatedAt: new Date().toISOString(), resumeRequested: !!resumeRequested }),
          );
          if (PER_AGENT_VOLUME) enqueuePending(id, { kind: 'session-set', roomId, sessionId, resumeRequested: !!resumeRequested });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
      });
      return;
    }

    // ── Parent-ticket binding (#1383) ─────────────────────────────────────
    // Agents register a child issue on the bound parent ticket (AC6). Checked
    // before the bare /ticket route (anchored regexes make them disjoint, but
    // order keeps intent clear).
    const ticketChildrenMatch = req.method === 'POST' && req.url.match(/^\/internal\/agents\/([^/]+)\/ticket\/children$/);
    if (ticketChildrenMatch) {
      const id = decodeURIComponent(ticketChildrenMatch[1]);
      let body = '';
      req.on('data', (d) => { body += d; if (body.length > 1_000_000) req.destroy(); });
      req.on('end', () => {
        try {
          if (!isSafePathSeg(id)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'bad agent id' }));
            return;
          }
          const { number } = JSON.parse(body || '{}');
          const parent = readAgentTicket(id);
          if (!parent) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'no parent ticket bound' }));
            return;
          }
          const next = ticketStore.addChild(parent, number);
          if (!next) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'child must be a positive issue number' }));
            return;
          }
          writeAgentTicket(id, next);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, children: next.children }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
      });
      return;
    }

    // GET reads the materialised ticket.json; POST binds (create/attach, calls
    // GitHub with the env PAT + writes ticket.json — AC2/AC3/AC8); DELETE unbinds.
    const ticketMatch = req.url.match(/^\/internal\/agents\/([^/]+)\/ticket$/);
    if (ticketMatch && (req.method === 'GET' || req.method === 'POST' || req.method === 'DELETE')) {
      const id = decodeURIComponent(ticketMatch[1]);
      if (!isSafePathSeg(id)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'bad agent id' }));
        return;
      }
      if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, ticket: readAgentTicket(id) }));
        return;
      }
      if (req.method === 'DELETE') {
        deleteAgentTicket(id);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      // POST — bind (async GitHub round-trip).
      let body = '';
      req.on('data', (d) => { body += d; if (body.length > 1_000_000) req.destroy(); });
      req.on('end', async () => {
        try {
          const ticket = await bindAgentTicket(id, JSON.parse(body || '{}'));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, ticket }));
        } catch (err) {
          const code = err.statusCode || 500;
          res.writeHead(code, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
      });
      return;
    }

    // ── Triggers: agent pull (#185 Phase 2) ───────────────────────────────
    // The isolated agent fetches its canonical triggers on each sync tick and
    // whenever SIGUSR2 wakes it. Read-only.
    const getTriggersMatch = req.method === 'GET' && req.url.match(/^\/internal\/agents\/([^/]+)\/triggers$/);
    if (getTriggersMatch) {
      const id = decodeURIComponent(getTriggersMatch[1]);
      if (!isSafePathSeg(id)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'bad agent id' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, triggers: loadTriggers(id) }));
      return;
    }

    // ── Triggers: one-shot consumed (#185 Phase 2) ────────────────────────
    // After firing a `once` trigger the agent reports it consumed so we drop it
    // from the canonical copy and it won't re-fire on the next pull/restart.
    const consumeTriggerMatch = req.method === 'POST' && req.url.match(/^\/internal\/agents\/([^/]+)\/triggers\/([^/]+)\/consumed$/);
    if (consumeTriggerMatch) {
      const id = decodeURIComponent(consumeTriggerMatch[1]);
      const tid = decodeURIComponent(consumeTriggerMatch[2]);
      if (!isSafePathSeg(id) || !isSafePathSeg(tid)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'bad id/triggerId' }));
        return;
      }
      const before = loadTriggers(id);
      const after = Array.isArray(before) ? before.filter(t => t && t.id !== tid) : [];
      const removed = after.length !== (Array.isArray(before) ? before.length : 0);
      if (removed) {
        try {
          saveTriggers(id, after);
        } catch (err) {
          // Don't claim success — the canonical copy still has the trigger, so
          // the agent should know its consume report didn't persist.
          console.error(`[Triggers] consume ${id}/${tid}: ${err.message}`);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
          return;
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, removed }));
      return;
    }

    // ── Triggers: admin write-through (#185 Phase 2) ──────────────────────
    // Admin CRUD computes the new full array and PUTs it here, so the
    // orchestrator stays the single writer of the canonical copy. We persist
    // and signal SIGUSR2 so the agent re-pulls immediately.
    const putTriggersMatch = req.method === 'PUT' && req.url.match(/^\/internal\/agents\/([^/]+)\/triggers$/);
    if (putTriggersMatch) {
      const id = decodeURIComponent(putTriggersMatch[1]);
      let body = '';
      req.on('data', (d) => { body += d; if (body.length > 4_000_000) req.destroy(); });
      req.on('end', async () => {
        if (!isSafePathSeg(id)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'bad agent id' }));
          return;
        }
        try {
          const { triggers } = JSON.parse(body || '{}');
          if (!Array.isArray(triggers)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'triggers must be an array' }));
            return;
          }
          // #962: capture the autonomy state BEFORE the write; if this add/
          // remove flips it, the agent's CLAUDE.md must be rebuilt (the
          // Trigger-management docs are gated on autonomy). The role comes from
          // config; agentIsAutonomous falls back safely if it's missing.
          const wasAutonomous = agentIsAutonomous(id, loadAgentConfig(id)?.role);
          saveTriggers(id, triggers);
          const proc = agentProcesses.get(id);
          if (proc) proc.kill('SIGUSR2');
          // Rebuild + reseed CLAUDE.md only when autonomy actually flipped
          // (no-op otherwise). Best-effort — never fails the trigger write.
          await reconcileAgentAutonomyPrompt(id, wasAutonomous);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
      });
      return;
    }

    // ── Maintenance mode: agent pull (#504) ───────────────────────────────
    // The state file lives outside any agent's own workspace subtree, which
    // the default SubPath / per-agent-volume isolation doesn't mount — every
    // agent (isolated or not) asks us instead of reading it directly.
    if (req.method === 'GET' && req.url === '/internal/maintenance-mode') {
      const state = readMaintenanceState();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, active: !!state.active }));
      return;
    }

    // ── Config + dm-room: agent pull (#185 Phase 2 item 3) ────────────────
    // config.json / dm-room.json are control-plane authored and stay canonical
    // on the pool subpath (orchestrator + admin own them there). An isolated
    // agent can't read the pool subpath, so it pulls them from us into its
    // local cache (refreshed each sync tick / on SIGUSR2). Read-only.
    const getConfigMatch = req.method === 'GET' && req.url.match(/^\/internal\/agents\/([^/]+)\/config$/);
    if (getConfigMatch) {
      const id = decodeURIComponent(getConfigMatch[1]);
      if (!isSafePathSeg(id)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'bad agent id' }));
        return;
      }
      const cfg = loadAgentConfig(id);
      if (!cfg) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Agent not found' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, config: cfg }));
      return;
    }

    const getDmRoomMatch = req.method === 'GET' && req.url.match(/^\/internal\/agents\/([^/]+)\/dm-room$/);
    if (getDmRoomMatch) {
      const id = decodeURIComponent(getDmRoomMatch[1]);
      if (!isSafePathSeg(id)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'bad agent id' }));
        return;
      }
      let dmRoom = null;
      try {
        const p = path.join(agentDir(id), 'dm-room.json');
        if (fs.existsSync(p)) dmRoom = JSON.parse(fs.readFileSync(p, 'utf8'));
      } catch { /* missing/corrupt → null (chat not opened yet) */ }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, dmRoom }));
      return;
    }

    // ── Poll agent status ─────────────────────────────────────────────────
    const pollMatch = req.method === 'GET' && req.url.match(/^\/internal\/agents\/([^/]+)\/poll$/);
    if (pollMatch) {
      const id = decodeURIComponent(pollMatch[1]);
      if (!fs.existsSync(agentDir(id))) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Agent not found' }));
        return;
      }
      const statusPath = agentStatePath(id, 'status.json'); // control-plane copy preferred (#185)
      let status = {};
      try {
        if (fs.existsSync(statusPath)) {
          status = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
        }
      } catch (err) {
        console.error(`[Orchestrator] Poll read error for ${id}: ${err.message}`);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        agentId: id,
        busy: status.busy ?? null,
        triggerFired: status.triggerFired ?? null,
        lastActivity: status.lastActivity ?? null,
        exitedAt: status.exitedAt ?? null,
      }));
      return;
    }

    // ── Session tail ──────────────────────────────────────────────────────
    const sessionTailMatch = req.method === 'GET' && req.url.match(/^\/internal\/agents\/([^/]+)\/session-tail(\?.*)?$/);
    if (sessionTailMatch) {
      const id = decodeURIComponent(sessionTailMatch[1]);
      const urlObj = new URL(req.url, 'http://localhost');
      const lines = parseInt(urlObj.searchParams.get('lines') || '100', 10);
      const since = parseInt(urlObj.searchParams.get('since') || '0', 10);

      if (!fs.existsSync(agentDir(id))) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Agent not found' }));
        return;
      }

      try {
        const sessionsDir = agentStatePath(id, 'sessions'); // control-plane copy preferred (#185)
        let newestFile = null;
        let newestMtime = 0;
        if (fs.existsSync(sessionsDir)) {
          for (const f of fs.readdirSync(sessionsDir)) {
            if (!f.endsWith('.jsonl')) continue;
            const fp = path.join(sessionsDir, f);
            const st = fs.statSync(fp);
            if (st.mtimeMs > newestMtime) {
              newestMtime = st.mtimeMs;
              newestFile = fp;
            }
          }
        }

        if (!newestFile) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ lines: [], nextOffset: 0 }));
          return;
        }

        const fileSize = fs.statSync(newestFile).size;
        const startOffset = Math.min(since, fileSize);
        const toRead = fileSize - startOffset;
        let chunk = '';
        if (toRead > 0) {
          const buf = Buffer.alloc(toRead);
          const fd = fs.openSync(newestFile, 'r');
          fs.readSync(fd, buf, 0, toRead, startOffset);
          fs.closeSync(fd);
          chunk = buf.toString('utf8');
        }

        const allLines = chunk.split('\n').filter(l => l.trim());
        const tail = allLines.slice(-lines);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ lines: tail, nextOffset: fileSize }));
      } catch (err) {
        console.error(`[Orchestrator] session-tail error for ${id}: ${err.message}`);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // ── Enable / Disable an agent (with stub materialization) ────────────
    const enableMatch = req.method === 'POST' && req.url.match(/^\/internal\/agents\/([^/]+)\/enable$/);
    if (enableMatch) {
      const id = decodeURIComponent(enableMatch[1]);
      (async () => {
        try {
          const result = await orchestrator.enableAgent(id);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (err) {
          console.error(`[Orchestrator] enableAgent error for ${id}: ${err.message}`);
          const status = httpStatusForAgentActionError(err);
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message, ...(err.code ? { code: err.code, teamId: err.teamId } : {}) }));
        }
      })();
      return;
    }

    // ── Re-inject an env's credentials into its running agents ──────────
    // Fired by the admin-console after an environment's GitHub token (or other
    // spawn-time credential) changes, so already-running containers pick up the
    // new value by being recreated. Best-effort on the caller's side.
    const respawnEnvMatch = req.method === 'POST' && req.url.match(/^\/internal\/environments\/([^/]+)\/respawn-agents$/);
    if (respawnEnvMatch) {
      const envId = decodeURIComponent(respawnEnvMatch[1]);
      let body = '';
      req.on('data', d => body += d);
      req.on('end', () => {
        let parsed = {};
        try { parsed = JSON.parse(body || '{}'); } catch { /* ignore */ }
        (async () => {
          try {
            const result = await orchestrator.respawnAgentsForEnvironment(envId, { reason: parsed.reason });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
          } catch (err) {
            console.error(`[Orchestrator] respawnAgentsForEnvironment error for ${envId}: ${err.message}`);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
          }
        })();
      });
      return;
    }

    // ── Re-inject a human's personal credential into their running agents ──
    // Fired by the admin-console after a person SETS or ROTATES their personal
    // SSH key / GitHub token (#1570), so already-running containers pick up the
    // new secret by being recreated. Owner-scoped (only that human's agents).
    // Best-effort on the caller's side.
    const respawnOwnerMatch = req.method === 'POST' && req.url.match(/^\/internal\/owners\/([^/]+)\/respawn-agents$/);
    if (respawnOwnerMatch) {
      const ownerId = decodeURIComponent(respawnOwnerMatch[1]);
      let body = '';
      req.on('data', d => body += d);
      req.on('end', () => {
        let parsed = {};
        try { parsed = JSON.parse(body || '{}'); } catch { /* ignore */ }
        (async () => {
          try {
            const result = await orchestrator.respawnAgentsForOwner(ownerId, { reason: parsed.reason });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
          } catch (err) {
            console.error(`[Orchestrator] respawnAgentsForOwner error for ${ownerId}: ${err.message}`);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
          }
        })();
      });
      return;
    }

    // ── Create GitHub labels for a team (label-suffix provisioning, #902) ─────
    // Called best-effort after materialisation: creates any missing labels in the
    // target repo via the env's PAT. 422 (already-exists) is silently ignored.
    // Failures are warnings, never errors — the team is already created.
    const githubLabelsMatch = req.method === 'POST' && req.url.match(/^\/internal\/environments\/([^/]+)\/github-labels$/);
    if (githubLabelsMatch) {
      const envId = decodeURIComponent(githubLabelsMatch[1]);
      let body = '';
      req.on('data', d => body += d);
      req.on('end', async () => {
        let parsed = {};
        try { parsed = JSON.parse(body || '{}'); } catch { /* ignore */ }
        const labels = Array.isArray(parsed.labels) ? parsed.labels.filter(s => typeof s === 'string') : [];
        const color = typeof parsed.color === 'string' && /^[0-9a-fA-F]{6}$/.test(parsed.color)
          ? parsed.color : null;
        if (!labels.length || !color) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'labels (string[]) and color (6-hex) required' }));
          return;
        }
        try {
          const env = loadEnvironment(envId);
          if (!env) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `Environment '${envId}' not found` }));
            return;
          }
          if (!env.githubTokenId) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, created: [], skipped: labels, warnings: ['No GitHub token on environment — skipping label provisioning'] }));
            return;
          }
          let ghToken;
          try {
            ghToken = fs.readFileSync(path.join(GH_TOKENS_DIR, env.githubTokenId), 'utf8').trim();
          } catch (err) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, created: [], skipped: labels, warnings: [`Cannot read GitHub token: ${err.message}`] }));
            return;
          }
          // Derive owner/repo from the environment's primary repo URL.
          const repos = Array.isArray(env.repositories) ? env.repositories : (env.repository ? [env.repository] : []);
          const primaryUrl = repos[0]?.url || '';
          const repoMatch = primaryUrl.match(/github\.com[/:]([^/]+)\/([^/ .]+?)(?:\.git)?\s*$/);
          if (!repoMatch) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, created: [], skipped: labels, warnings: ['Cannot parse GitHub owner/repo from environment URL — skipping label provisioning'] }));
            return;
          }
          const [, owner, repo] = repoMatch;
          const created = [];
          const skipped = [];
          const warnings = [];
          for (const labelName of labels) {
            try {
              const resp = await fetch(`https://api.github.com/repos/${owner}/${repo}/labels`, {
                method: 'POST',
                headers: {
                  'Authorization': `Bearer ${ghToken}`,
                  'Accept': 'application/vnd.github+json',
                  'Content-Type': 'application/json',
                  'X-GitHub-Api-Version': '2022-11-28',
                },
                body: JSON.stringify({ name: labelName, color }),
              });
              if (resp.status === 201) {
                created.push(labelName);
              } else if (resp.status === 422) {
                skipped.push(labelName);
              } else {
                const errBody = await resp.text().catch(() => '');
                warnings.push(`Label '${labelName}': GitHub returned ${resp.status} — ${errBody.slice(0, 200)}`);
                skipped.push(labelName);
              }
            } catch (err) {
              warnings.push(`Label '${labelName}': ${err.message}`);
              skipped.push(labelName);
            }
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, created, skipped, warnings }));
        } catch (err) {
          console.error(`[Orchestrator] github-labels error for env ${envId}: ${err.message}`);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // ── Respawn a single running agent ──────────────────────────────────
    // Fired by the admin-console after a per-agent spawn-time change (e.g. the
    // Model-Provider override) so the running container is recreated with the
    // fresh binding. No-op for disabled/stub agents. Best-effort on the caller.
    const respawnAgentMatch = req.method === 'POST' && req.url.match(/^\/internal\/agents\/([^/]+)\/respawn$/);
    if (respawnAgentMatch) {
      const id = decodeURIComponent(respawnAgentMatch[1]);
      let body = '';
      req.on('data', d => body += d);
      req.on('end', () => {
        let parsed = {};
        try { parsed = JSON.parse(body || '{}'); } catch { /* ignore */ }
        try {
          const result = orchestrator.respawnAgent(id, { reason: parsed.reason });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (err) {
          console.error(`[Orchestrator] respawnAgent error for ${id}: ${err.message}`);
          const status = /not found/i.test(err.message) ? 404 : 500;
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // ── Sync an environment's repos into an existing agent's workspace ──────
    // Fired by the admin-console "Sync repositories" action (#1342). Clones any
    // repos the environment declares that are missing from this agent's
    // workspace; idempotent (already-cloned repos are left untouched). Returns
    // a per-repo result the console streams to the operator.
    const syncReposMatch = req.method === 'POST' && req.url.match(/^\/internal\/agents\/([^/]+)\/sync-repositories$/);
    if (syncReposMatch) {
      const id = decodeURIComponent(syncReposMatch[1]);
      try {
        const result = orchestrator.syncAgentRepositories(id);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        console.error(`[Orchestrator] syncAgentRepositories error for ${id}: ${err.message}`);
        const status = err.code === 'not-found' || /not found/i.test(err.message) ? 404 : 500;
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // ── Agent-scoped repositories (#2067) ───────────────────────────────────
    // GET    → the merged environment+agent list, each agent entry carrying the
    //          git facts a removal confirmation needs (AC7/AC9).
    // POST   → attach one repository to THIS agent and clone it (AC4/AC5).
    // DELETE → detach it and delete the working copy (AC9).
    //
    // Authorization lives in the console (the only side that knows the caller):
    // `canManageAgent`, the PATCH /api/agents/:id/context-mount precedent.
    // Every refusal maps a code from the pure planner onto an HTTP status so
    // the console can relay the message verbatim instead of re-wording it.
    const agentReposMatch = req.url.match(/^\/internal\/agents\/([^/?]+)\/repositories(?:\?.*)?$/);
    if (agentReposMatch && ['GET', 'POST', 'DELETE'].includes(req.method)) {
      const id = decodeURIComponent(agentReposMatch[1]);
      // Refusal code → HTTP status. A collision / credential / busy refusal is
      // a 409 (the request is well-formed, the state says no); a malformed body
      // is a 400; an unknown agent or url is a 404.
      const statusFor = (code) => {
        if (code === 'not-found' || code === 'not-attached') return 404;
        if (code === 'url-required') return 400;
        if (code === 'no-workspace' || code === 'environment-repository') return 409;
        return 409;
      };
      const respond = (status, payload) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      const run = (fn) => {
        try {
          respond(200, fn());
        } catch (err) {
          const code = err.code || 'error';
          if (code === 'error') console.error(`[Orchestrator] agent-repositories ${id}: ${err.message}`);
          respond(
            code === 'error' ? 500 : statusFor(code),
            { error: err.message, code, ...(err.activeTriggers ? { activeTriggers: err.activeTriggers } : {}) },
          );
        }
      };
      if (req.method === 'GET') {
        run(() => orchestrator.agentRepositoriesView(id));
        return;
      }
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        let parsed = {};
        try { parsed = JSON.parse(body || '{}'); } catch { /* treated as empty → url-required */ }
        if (req.method === 'POST') run(() => orchestrator.attachAgentRepository(id, parsed));
        else run(() => orchestrator.detachAgentRepository(id, parsed.url));
      });
      return;
    }

    // Read-only divergence probe for one environment's agents (#2066 D4). POST
    // because the caller supplies the agent set it is allowed to see — scoping
    // is the console's job, not the orchestrator's.
    const repoDivergenceMatch = req.method === 'POST'
      && req.url.match(/^\/internal\/environments\/([^/]+)\/repo-divergence$/);
    if (repoDivergenceMatch) {
      const envId = decodeURIComponent(repoDivergenceMatch[1]);
      let body = '';
      req.on('data', d => body += d);
      req.on('end', () => {
        let parsed = {};
        try { parsed = JSON.parse(body || '{}'); } catch { /* ignore */ }
        const agentIds = Array.isArray(parsed.agentIds)
          ? parsed.agentIds.filter(s => typeof s === 'string')
          : [];
        try {
          const result = orchestrator.environmentRepoDivergence(envId, agentIds);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (err) {
          console.error(`[Orchestrator] environmentRepoDivergence error for ${envId}: ${err.message}`);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    const disableMatch = req.method === 'POST' && req.url.match(/^\/internal\/agents\/([^/]+)\/disable$/);
    if (disableMatch) {
      const id = decodeURIComponent(disableMatch[1]);
      let body = '';
      req.on('data', d => body += d);
      req.on('end', () => {
        let parsed = {};
        try { parsed = JSON.parse(body || '{}'); } catch { /* ignore */ }
        const mode = parsed.mode || undefined;
        (async () => {
          try {
            const result = await orchestrator.disableAgent(id, { mode });
            // warning=true means the agent is busy/has active triggers and the
            // caller must choose drain or abort before we proceed.
            const httpStatus = result.warning ? 409 : 200;
            res.writeHead(httpStatus, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
          } catch (err) {
            console.error(`[Orchestrator] disableAgent error for ${id}: ${err.message}`);
            const status = httpStatusForAgentActionError(err);
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message, ...(err.code ? { code: err.code, teamId: err.teamId } : {}) }));
          }
        })();
      });
      return;
    }

    // ── STILLED: hand-off candidates for a bp-instance — see #1968 ───────
    // Retained by epic #1961 decision R4 / phase #1962, and now UNREACHABLE:
    // it requires `role === "bp-instance"`, a role the platform can no longer
    // create, so every call answers 409. Returns the sibling bp-instance stubs
    // under the same parent orchestrator; `suggested` (the bp-explorer
    // briefings-graph enrichment) is always empty since #1962 removed that
    // supply chain — see orchestrator.handoverCandidates.
    const handoverCandMatch = req.method === 'GET' && req.url.match(/^\/internal\/agents\/([^/?]+)\/handover-candidates(?:\?.*)?$/);
    if (handoverCandMatch) {
      const id = decodeURIComponent(handoverCandMatch[1]);
      (async () => {
        try {
          const result = await orchestrator.handoverCandidates(id);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (err) {
          console.error(`[Orchestrator] handoverCandidates error for ${id}: ${err.message}`);
          const status = /not found/i.test(err.message) ? 404 :
                         /not a bp-instance/i.test(err.message) ? 409 : 500;
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      })();
      return;
    }

    // ── Workspace git status (hand-off pre-flight) ───────────────────────
    // Reports per-repo commit/push state for an agent's workspace so the
    // hand-off dialog can block on uncommitted or unpushed work. Read-only,
    // no remote calls — relies on whatever the workspace has fetched. The
    // `summary.ready` flag is the convenience shortcut the UI uses to decide
    // whether to enable the submit button.
    const gitStatusMatch = req.method === 'GET' && req.url.match(/^\/internal\/agents\/([^/?]+)\/workspace\/git-status(?:\?.*)?$/);
    if (gitStatusMatch) {
      const id = decodeURIComponent(gitStatusMatch[1]);
      try {
        const cfg = loadAgentConfig(id);
        if (!cfg) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `Agent '${id}' not found` }));
          return;
        }
        const env = cfg.environmentId ? loadEnvironment(cfg.environmentId) : null;
        // #2067: an agent-scoped repository is a working copy like any other,
        // so the hand-off pre-flight must see its uncommitted / unpushed work
        // too — otherwise a hand-off reads "ready" over losable changes.
        const repos = inspectAgentRepoStatuses(id, env, normalizeAgentRepositories(cfg.agentRepositories));
        const summary = {
          totalRepos: repos.length,
          missing: repos.filter((r) => !r.exists).length,
          dirty: repos.filter((r) => r.exists && !r.clean).length,
          ahead: repos.filter((r) => r.exists && r.upstream && (r.ahead || 0) > 0).length,
          ready: repos.length > 0 && repos.every((r) => r.exists && r.ready),
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ agentId: id, environmentId: cfg.environmentId || null, repos, summary }));
      } catch (err) {
        console.error(`[Orchestrator] git-status error for ${id}: ${err.message}`);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // ── Push / open-PR on behalf of an agent (gh-as-agent push/pr) ──────────────────
    // Moves the managed-policy-gated `git push` / `gh pr create` out of the
    // agent's Claude CLI into the orchestrator (see agentGitPush / agentCreatePr
    // above). Internal-only, unauthenticated like the rest of :4002.
    const gitPushMatch = req.method === 'POST' && req.url.match(/^\/internal\/agents\/([^/]+)\/git\/push$/);
    const gitPrMatch = req.method === 'POST' && req.url.match(/^\/internal\/agents\/([^/]+)\/git\/pr$/);
    if (gitPushMatch || gitPrMatch) {
      const id = decodeURIComponent((gitPushMatch || gitPrMatch)[1]);
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', async () => {
        let parsed = {};
        try { parsed = JSON.parse(body || '{}'); } catch { /* {} */ }
        try {
          const cfg = loadAgentConfig(id);
          if (!cfg) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: `Agent '${id}' not found` }));
            return;
          }
          const env = cfg.environmentId ? loadEnvironment(cfg.environmentId) : null;
          const result = gitPushMatch ? await agentGitPush(id, env, parsed) : await agentCreatePr(id, env, parsed);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (err) {
          const msg = errorMessage(err);
          // 424 (Failed Dependency) + stable code for a missing GitHub token —
          // distinct from a real git failure so the agent can tell "no PAT in
          // this environment" apart from a non-fast-forward reject;
          // 409 for git/gh failures the agent can act on (non-fast-forward,
          // auth, etc.); 400 for request/config problems.
          const payload = { ok: false, error: msg };
          let status = 400;
          if (err && err.personalCredentialRequired) {
            // #1569 refuse-on-missing: the agent's owner has no usable personal
            // credential for this attributed write, and there is deliberately no
            // team/system fallback. 424 (Failed Dependency) + stable code so the
            // agent surfaces the actionable message rather than retrying a shared
            // push. Nothing was pushed/opened.
            status = 424;
            payload.code = err.refusalCode || 'personal-credential-required';
          } else if (err && err.noGithubToken) {
            status = 424;
            payload.code = 'no-github-token';
            if (err.branchPushed) payload.branchPushed = err.branchPushed;
          } else if (err && err.gitFailed) {
            status = 409;
          }
          console.warn(`[Orchestrator] git ${gitPushMatch ? 'push' : 'pr'} for ${id}: ${msg}`);
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(payload));
        }
      });
      return;
    }

    // ── Deterministic Workspace Git panel action (issue #648) ────────────────
    // switch / update / discard for one repo in an agent's workspace, executed
    // server-side (no LLM). The admin-console proxy re-checks running state
    // before calling this (AC7). See performGitPanelAction above for the
    // guardrails.
    const gitActionMatch = req.method === 'POST' && req.url.match(/^\/internal\/agents\/([^/]+)\/workspace\/git-action$/);
    if (gitActionMatch) {
      const id = decodeURIComponent(gitActionMatch[1]);
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        let parsed = {};
        try { parsed = JSON.parse(body || '{}'); } catch { /* {} */ }
        try {
          const cfg = loadAgentConfig(id);
          if (!cfg) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: `Agent '${id}' not found` }));
            return;
          }
          const env = cfg.environmentId ? loadEnvironment(cfg.environmentId) : null;
          const result = performGitPanelAction(id, env, parsed);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (err) {
          const msg = errorMessage(err);
          // 409 for a git-level refusal the operator can act on (dirty tree,
          // diverged branch, checkout/pull failure); 400 for bad requests.
          const status = err && err.gitFailed ? 409 : 400;
          console.warn(`[Orchestrator] git-action for ${id}: ${msg}`);
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: msg }));
        }
      });
      return;
    }

    // ── Push the agent's KB shard to the shared agent-knowledge branch ──────────
    // Shared Agent Learning (Phase 1): the `knowledge` CLI commits the entry to
    // its own shard locally, then calls this to push it — the credentialed
    // network step (mirrors gh-as-agent push), on the one dedicated non-protected
    // branch, with fetch-rebase-retry so concurrent agents can't lose an append.
    const knPushMatch = req.method === 'POST' && req.url.match(/^\/internal\/agents\/([^/]+)\/knowledge\/push$/);
    if (knPushMatch) {
      const id = decodeURIComponent(knPushMatch[1]);
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', async () => {
        try {
          const cfg = loadAgentConfig(id);
          if (!cfg) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: `Agent '${id}' not found` }));
            return;
          }
          const result = await agentKnowledgePush(id);
          // Phase 2: echo the pushed entry summary into the live feed + refresh
          // the team's canonical clone. Best-effort — never fails the push.
          try {
            const env = cfg.environmentId ? loadEnvironment(cfg.environmentId) : null;
            emitKnowledgeHarvest(id, cfg, env, body);
          } catch (feedErr) {
            console.warn(`[Orchestrator] knowledge feed/refresh for ${id}: ${feedErr.message}`);
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (err) {
          const msg = errorMessage(err);
          const status = err && err.gitFailed ? 409 : 400;
          console.warn(`[Orchestrator] knowledge push for ${id}: ${msg}`);
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: msg }));
        }
      });
      return;
    }

    // ── Read-side retrieval telemetry (#915) — the READ choke-point ─────────────
    // `knowledge search` is fully local in the agent container (a checkout scan;
    // it never touches us) and the container cannot write the shared volume, so
    // the read signal arrives over this endpoint — the same agent→orchestrator
    // pattern as the knowledge push. Updates the compact per-team aggregate
    // ONLY; never events.jsonl, never the SSE feed.
    const knRetrievalMatch = req.method === 'POST' && req.url.match(/^\/internal\/agents\/([^/]+)\/knowledge\/retrieval$/);
    if (knRetrievalMatch) {
      const id = decodeURIComponent(knRetrievalMatch[1]);
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        try {
          const cfg = loadAgentConfig(id);
          if (!cfg) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: `Agent '${id}' not found` }));
            return;
          }
          let payload = {};
          try { payload = JSON.parse(body || '{}'); } catch { payload = {}; }
          const v = knowledgeRetrieval.validateRetrieval(payload, {
            now: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
          });
          if (!v.ok) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: v.error }));
            return;
          }
          const teamId = agentKnowledgeTeamId(cfg); // server-side, same as push
          const result = recordKnowledgeRetrieval(teamId, v);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, teamId, ...result }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: errorMessage(err) }));
        }
      });
      return;
    }

    // ── Ensure/refresh a team's canonical KB clone (Phase 2) ────────────────────
    // The admin-console calls this opportunistically (fire-and-forget) before it
    // reads the KB shards, so the on-disk copy is current. Best-effort, throttled
    // per team, never throws to the caller.
    if (req.method === 'POST' && req.url === '/internal/knowledge/refresh') {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        let teamId = DEFAULT_TEAM_ID;
        try { teamId = (JSON.parse(body || '{}').teamId) || DEFAULT_TEAM_ID; } catch { /* default */ }
        let result;
        try {
          result = refreshKnowledgeClone(String(teamId), { force: false });
        } catch (err) {
          result = { refreshedAt: null, warnings: [errorMessage(err)] };
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, ...result }));
      });
      return;
    }

    // ── Agent nomination — the `knowledge promote <id>` CLI verb (Phase 3) ──────
    // Raises a promotion suggestion for the entry's convergence cluster (works
    // below the threshold too). NEVER promotes — the operator confirms in the UI.
    const knNominateMatch = req.method === 'POST' && req.url.match(/^\/internal\/agents\/([^/]+)\/knowledge\/nominate$/);
    if (knNominateMatch) {
      const id = decodeURIComponent(knNominateMatch[1]);
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body || '{}');
          const entryId = String(parsed.entryId || '');
          if (!/^[0-9a-f]{12}$/.test(entryId)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'invalid entryId' }));
            return;
          }
          const candidate = nominateKnowledgeEntry(id, entryId, parsed.note);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, candidate }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: errorMessage(err) }));
        }
      });
      return;
    }

    // ── Post-promotion side effects (Phase 3) ───────────────────────────────────
    // Called by the admin-console after it writes a promoted skill: flip the
    // candidate lifecycle to `promoted` and echo a `promotion` event into the
    // live feed so the Knowledge Flow view draws the T1→T2 edge.
    if (req.method === 'POST' && (req.url === '/internal/knowledge/promoted' || req.url === '/internal/knowledge/dismiss' || req.url === '/internal/knowledge/undismiss')) {
      const dismiss = req.url.endsWith('/dismiss');
      const undismiss = req.url.endsWith('/undismiss');
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', async () => {
        try {
          const p = JSON.parse(body || '{}');
          const teamId = String(p.teamId || DEFAULT_TEAM_ID);
          const isExtend = !dismiss && !undismiss && !!p.extend;
          const entryIds = Array.isArray(p.entryIds)
            ? p.entryIds.filter((x) => typeof x === 'string' && /^[0-9a-f]{12}$/.test(x))
            : [];
          // #775: dismiss carries an optional structured reason; un-dismiss
          // restores a previously-dismissed suggestion to `open`. Both emit a
          // feed event (below) so the live feed records the decision.
          const dismissReason = dismiss ? knowledgeFeed.normalizeDismissReason(p.reason) : null;
          let touched = null; // the candidate we flipped, for the feed event text
          // #776 §2: a merge-basket promotion flips SEVERAL candidates to
          // `promoted` in one call (`suggestionIds`), so all merged cards leave
          // the inbox. dismiss/undismiss stay single-card (`suggestionId`).
          const idList = (!dismiss && !undismiss && Array.isArray(p.suggestionIds) && p.suggestionIds.length)
            ? [...new Set([...p.suggestionIds, ...(p.suggestionId ? [p.suggestionId] : [])]
                .filter((x) => typeof x === 'string' && x))]
            : (typeof p.suggestionId === 'string' && p.suggestionId ? [p.suggestionId] : []);
          if (idList.length) {
            const list = readKnowledgeCandidates(teamId);
            let wrote = false;
            for (const sid of idList) {
              const i = list.findIndex((c) => c && c.id === sid);
              if (i < 0) continue;
              if (undismiss) {
                // Restore a dismissed OR a stale (#776 §4) candidate to the open
                // inbox — strip every resolved-state marker so it reads as fresh.
                const { dismissReason: _dr, dismissedAt: _da, resolvedAt: _ra, staleAt: _sa, ...rest } = list[i];
                list[i] = { ...rest, status: 'open', lastEvidenceAt: new Date().toISOString() };
              } else {
                list[i] = {
                  ...list[i],
                  status: dismiss ? 'dismissed' : 'promoted',
                  resolvedAt: new Date().toISOString(),
                  ...(dismiss ? { dismissedAt: new Date().toISOString(), dismissReason } : {}),
                };
              }
              touched = list[i];
              wrote = true;
            }
            if (wrote) writeKnowledgeCandidates(teamId, list);
          } else if (!dismiss && !undismiss && entryIds.length > 0) {
            // Promotion without a stored suggestion (manual combine, agent→team
            // lift): record a synthetic promoted row so the collector's promoted
            // overlay, the archive guard, and the planners' promoted-entry
            // filters all see these entries as skill-backing.
            const list = readKnowledgeCandidates(teamId);
            const already = list.some((c) => c && c.status === 'promoted'
              && Array.isArray(c.entryIds) && entryIds.every((id) => c.entryIds.includes(id)));
            if (!already) {
              list.push({
                id: crypto.randomBytes(6).toString('hex'),
                teamId,
                source: 'manual',
                status: 'promoted',
                canonicalId: entryIds[0],
                entryIds,
                skill: p.skill && typeof p.skill === 'object' ? { name: p.skill.name, tier: p.skill.tier } : null,
                resolvedAt: new Date().toISOString(),
              });
              writeKnowledgeCandidates(teamId, list);
            }
          }
          if (dismiss || undismiss) {
            // #775 §4: record the dismiss / un-dismiss decision in the live feed
            // so it is transparent that a suggestion was turned down or restored.
            appendKnowledgeEvents([knowledgeFeed.buildDismissalEvent({
              teamId,
              suggestionId: typeof p.suggestionId === 'string' ? p.suggestionId : null,
              reason: dismissReason,
              text: touched && typeof touched.text === 'string' ? touched.text : null,
              undo: undismiss,
            })]);
          } else {
            const skill = p.skill && typeof p.skill === 'object'
              ? { name: p.skill.name, tier: p.skill.tier } : null;
            // Distinguishable feed event (#553, AC9): "extension" (skill X gained
            // N entries) vs the "promotion" of a brand-new skill.
            appendKnowledgeEvents([{
              type: isExtend ? 'extension' : 'promotion',
              ts: new Date().toISOString(),
              teamId,
              skill,
              entryIds: Array.isArray(p.entryIds) ? p.entryIds : [],
            }]);
            // Auto-sync the refreshed content to every agent that already has this
            // team skill active (#553, AC10). Best-effort — never fails the write.
            if (isExtend && skill && skill.tier === 'team' && skill.name) {
              try { await orchestrator.resyncTeamSkill(teamId, skill.name); }
              catch (err) { console.warn(`[Orchestrator] resyncTeamSkill(${teamId}, ${skill.name}) failed: ${err.message}`); }
            }
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: errorMessage(err) }));
        }
      });
      return;
    }

    // ── Set a team's promotion gate policy (Phase 4) ────────────────────────────
    // The admin-console PUT /api/knowledge/gates proxies here. Writes one
    // per-transition mode onto the team's own knowledge-config.json (#570), not
    // the shared environment. team>global is never persisted as auto
    // (resolvePromotionGates forces it to review anyway).
    if (req.method === 'POST' && req.url === '/internal/knowledge/gates') {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        try {
          const p = JSON.parse(body || '{}');
          const teamId = String(p.teamId || '');
          const transition = String(p.transition || '');
          const mode = String(p.mode || '');
          if (!AGENT_ID_RE.test(teamId)) throw new Error('invalid teamId');
          if (!PROMOTION_TRANSITIONS.includes(transition)) throw new Error('invalid transition');
          if (!GATE_MODES.includes(mode)) throw new Error('invalid mode');
          const result = writeTeamPromotionGate(teamId, transition, mode);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, ...result }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: errorMessage(err) }));
        }
      });
      return;
    }

    // ── Skill domains CRUD (#780, skill-aggregation Phase 2) ────────────────────
    // The admin-console /api/knowledge/domains routes proxy here. One dispatch
    // endpoint over the pure knowledge-domains ops (read/add/rename/merge/split/
    // remove/confirm/seed/bootstrap). Domain changes are ALWAYS a human decision, so
    // every mutating op emits a `domain` feed event. Read returns the doc + the soft
    // skill-budget state so the UI can surface it (AC5).
    if (req.method === 'POST' && req.url === '/internal/knowledge/domains') {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', async () => { // #855: async so the bootstrap LLM call is awaited non-blockingly
        try {
          const p = JSON.parse(body || '{}');
          const teamId = String(p.teamId || '');
          const op = String(p.op || 'read');
          if (!AGENT_ID_RE.test(teamId)) throw new Error('invalid teamId');
          const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
          const budgetOf = () => {
            const { skillBudget } = knowledgeCurationConfig(teamKnowledgeEnv(teamId, null));
            return knowledgeDomains.skillBudgetState(readTeamSkillsForMatch(teamId).map((s) => s.name), { cap: skillBudget });
          };
          const respond = (doc, extra = {}) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, doc, budget: budgetOf(), ...extra }));
          };
          const doc = readTeamDomainsDoc(teamId);
          let r;
          switch (op) {
            case 'read':
              return respond(doc);
            case 'seed': {
              const seeded = knowledgeDomains.seedDomainsFromRoles(teamSquadRoleTokens(teamId), { now });
              r = knowledgeDomains.confirmDomains(doc, { domains: seeded, teamId, now });
              break;
            }
            case 'bootstrap': {
              // Propose domains via the LLM over the team's lessons; NOT persisted —
              // returned for operator confirmation. Heuristic (role-seed) fallback.
              const req2 = knowledgeDomains.buildBootstrapRequest(
                Array.isArray(p.lessons) ? p.lessons : [], { roles: teamSquadRoleTokens(teamId) },
              );
              // #1214: bill against the user's header-selected provider (ids forwarded
              // by the console proxy; token resolved locally). Unusable/absent → .env.
              const binding = resolveAssistBindingFromSelection(String(p.assistEndpointId || ''), String(p.model || ''));
              const text = await _synthesizeSkillMd(teamKnowledgeEnv(teamId, null), req2, binding); // #855: async, non-blocking
              const llmProposed = knowledgeDomains.parseBootstrapResponse(text, { now });
              // `fallback` tells the UI the LLM target was unavailable/unusable and the
              // proposal is the deterministic role-seed instead (AC1 — visible fallback).
              const fallback = llmProposed.length === 0;
              const proposed = fallback
                ? knowledgeDomains.seedDomainsFromRoles(teamSquadRoleTokens(teamId), { now })
                : llmProposed;
              return respond(doc, { proposed, fallback });
            }
            case 'add': r = knowledgeDomains.addDomain(doc, p.domain || {}, { teamId, now }); break;
            case 'rename': r = knowledgeDomains.renameDomain(doc, String(p.id || ''), String(p.name || ''), { teamId, now }); break;
            case 'merge': r = knowledgeDomains.mergeDomains(doc, p.ids || [], { name: p.name, scope: p.scope, teamId, now }); break;
            case 'split': r = knowledgeDomains.splitDomain(doc, String(p.id || ''), p.parts || [], { teamId, now }); break;
            case 'remove': r = knowledgeDomains.removeDomain(doc, String(p.id || ''), { teamId, now }); break;
            case 'confirm': r = knowledgeDomains.confirmDomains(doc, { domains: p.domains, teamId, now }); break;
            default: throw new Error(`unknown op '${op}'`);
          }
          if (!r || r.ok !== true) { const e = new Error((r && r.error) || 'op failed'); e.status = 400; throw e; }
          writeTeamDomainsDoc(teamId, r.doc);
          if (r.event) appendKnowledgeEvents([r.event]);
          return respond(r.doc);
        } catch (err) {
          res.writeHead(err && err.status === 400 ? 400 : 500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: errorMessage(err) }));
        }
      });
      return;
    }

    // ── Distil a whole team skill (#781 §3.4) ───────────────────────────────────
    // The admin-console POST /api/knowledge/distill proxies here. `apply:false` is a
    // preview that returns old/new for a diff; `apply:true` writes (version bump +
    // feed event) only when the LLM produced a usable re-synthesis — LLM failure
    // leaves the skill byte-identical (AC2).
    if (req.method === 'POST' && req.url === '/internal/knowledge/distill') {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', async () => { // #855: async so the distill LLM synthesis is awaited non-blockingly
        try {
          const p = JSON.parse(body || '{}');
          const teamId = String(p.teamId || '');
          const skill = String(p.skill || '');
          const apply = p.apply !== false;
          if (!AGENT_ID_RE.test(teamId)) throw new Error('invalid teamId');
          if (!knowledgeCurator.SKILL_NAME_RE.test(skill)) throw new Error('invalid skill name');
          const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
          const result = await _distillTeamSkill(teamId, null, skill, { apply, now, auto: false }); // #855: async, non-blocking
          const status = result.reason === 'not-found' ? 404 : 200;
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: result.reason !== 'not-found', ...result }));
        } catch (err) {
          res.writeHead(err && err.status === 400 ? 400 : 500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: errorMessage(err) }));
        }
      });
      return;
    }

    // ── Consolidation migration (#781 §4) ───────────────────────────────────────
    // Operator-driven, one-time-per-team, resumable. Ops: read | plan | start |
    // advance | route-remaining. The actual per-domain synthesis + archive + atomic
    // grant swap is performed by the existing POST /api/skills/merge (fed the
    // buildConsolidationMerge input); this endpoint owns the resumable progress doc
    // and the corpus plan. The admin-console POST /api/knowledge/consolidation proxies here.
    if (req.method === 'POST' && req.url === '/internal/knowledge/consolidation') {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        try {
          const p = JSON.parse(body || '{}');
          const teamId = String(p.teamId || '');
          const op = String(p.op || 'read');
          if (!AGENT_ID_RE.test(teamId)) throw new Error('invalid teamId');
          const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
          const ok = (extra = {}) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, ...extra }));
          };
          // Build the per-domain member/candidate assignment plan from the confirmed
          // domains + the current corpus (existing team skills + open candidates).
          const buildPlan = () => {
            const domains = readTeamDomainsDoc(teamId).domains;
            const skills = readTeamSkillsForMatch(teamId);
            const openCands = (readKnowledgeCandidates(teamId) || []).filter((c) => c && c.status === 'open');
            const skillEntryIdsByDomain = {};
            for (const d of domains) {
              const sk = skills.find((s) => s.name === knowledgeDomains.domainSkillName(d));
              if (sk) skillEntryIdsByDomain[d.id] = sk.entryIds;
            }
            return knowledgeConsolidation.planConsolidation(domains, skills, openCands, { skillEntryIdsByDomain });
          };
          if (op === 'read') return ok({ state: readConsolidationState(teamId) });
          if (op === 'plan') {
            const plan = buildPlan();
            // The merge input each ≥2-member domain will feed to POST /api/skills/merge.
            const merges = plan.domains
              .map((d) => ({ domainId: d.domainId, skill: d.skill, merge: knowledgeConsolidation.buildConsolidationMerge(d, { teamId }) }))
              .filter((m) => m.merge);
            return ok({ plan, merges });
          }
          if (op === 'start') {
            const plan = buildPlan();
            const state = writeConsolidationState(teamId, knowledgeConsolidation.makeMigrationState(plan, { teamId, now }));
            appendKnowledgeEvents([knowledgeConsolidation.consolidationEvent('started', {
              teamId, count: state.domains.length, summary: knowledgeConsolidation.migrationSummary(state), now,
            })]);
            return ok({ state });
          }
          if (op === 'advance') {
            const prev = readConsolidationState(teamId);
            if (!prev) { const e = new Error('no migration in progress'); e.status = 400; throw e; }
            const domainId = String(p.domainId || '');
            const stepStatus = p.status === 'skipped' ? 'skipped' : 'accepted';
            const next = knowledgeConsolidation.advanceMigration(prev, { domainId, status: stepStatus, now });
            const state = writeConsolidationState(teamId, next);
            const dom = state.domains.find((d) => d.domainId === domainId) || null;
            appendKnowledgeEvents([knowledgeConsolidation.consolidationEvent(stepStatus, {
              teamId, domain: dom ? { id: dom.domainId, name: dom.name } : null, skill: dom ? dom.skill : null, now,
            })]);
            return ok({ state });
          }
          if (op === 'route-remaining') {
            const prev = readConsolidationState(teamId);
            if (!prev) { const e = new Error('no migration in progress'); e.status = 400; throw e; }
            // Actually route the leftover candidates by re-running the collector pass
            // (best-effort — it re-projects + routes per §3.2). Then mark the step done.
            runConvergenceCollector(teamId, null, { force: true }) // #855: async, non-blocking
              .catch((err) => console.warn(`[Orchestrator] consolidation route-remaining collector for '${teamId}' failed: ${err.message}`));
            const state = writeConsolidationState(teamId, knowledgeConsolidation.markRoutedRemaining(prev, { now }));
            appendKnowledgeEvents([knowledgeConsolidation.consolidationEvent(
              state.status === 'complete' ? 'completed' : 'routed',
              { teamId, summary: knowledgeConsolidation.migrationSummary(state), now },
            )]);
            return ok({ state });
          }
          const e = new Error(`unknown op '${op}'`); e.status = 400; throw e;
        } catch (err) {
          res.writeHead(err && err.status === 400 ? 400 : 500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: errorMessage(err) }));
        }
      });
      return;
    }

    // ── Set the 0..3 autonomy dial for a team (human-in-control) ────────────────
    // The admin-console PUT /api/knowledge/autonomy proxies here.
    if (req.method === 'POST' && req.url === '/internal/knowledge/autonomy') {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        try {
          const p = JSON.parse(body || '{}');
          const teamId = String(p.teamId || '');
          const level = Number(p.level);
          if (!AGENT_ID_RE.test(teamId)) throw new Error('invalid teamId');
          if (!Number.isInteger(level) || level < 0 || level > 3) throw new Error('level must be an integer 0..3');
          const result = writeTeamAutonomy(teamId, level);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, ...result }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: errorMessage(err) }));
        }
      });
      return;
    }

    // ── Persist the wizard's initial knowledge-learning config in one write (#567) ─
    // The admin-console POST /api/teams(/stream) proxies here right after the team +
    // members are materialised, with a patch already reduced to non-default keys.
    // Only ever called for a non-default config, so a defaulted wizard writes no
    // override file at all (AC-4). Storage is out of scope and ignored by the writer.
    if (req.method === 'POST' && req.url === '/internal/knowledge/config') {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        try {
          const p = JSON.parse(body || '{}');
          const teamId = String(p.teamId || '');
          if (!AGENT_ID_RE.test(teamId)) throw new Error('invalid teamId');
          const result = writeTeamKnowledgeConfig(teamId, p.config || {});
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, config: result }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: errorMessage(err) }));
        }
      });
      return;
    }

    // ── Set the per-team knowledge storage location (repo/branch/path) (#558) ────
    // The admin-console PUT /api/knowledge/store proxies here after it has
    // validated + probed the target (reachability + write access). This handler
    // normalizes, persists onto the team's own knowledge-config.json (#570), and
    // refreshes the clone.
    if (req.method === 'POST' && req.url === '/internal/knowledge/store') {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        try {
          const p = JSON.parse(body || '{}');
          const teamId = String(p.teamId || '');
          if (!AGENT_ID_RE.test(teamId)) throw new Error('invalid teamId');
          const result = writeTeamKnowledgeStore(teamId, p.store || {});
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, ...result }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: errorMessage(err) }));
        }
      });
      return;
    }

    // ── Toggle supervised-review mode for a team ────────────────────────────────
    if (req.method === 'POST' && req.url === '/internal/knowledge/review-mode') {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        try {
          const p = JSON.parse(body || '{}');
          const teamId = String(p.teamId || '');
          if (!AGENT_ID_RE.test(teamId)) throw new Error('invalid teamId');
          const enabled = p.enabled === true || p.enabled === 'true';
          const resolved = resolveTeamKbRepo(teamId);
          const env = resolved ? resolved.env : null;
          // Grandfather existing KB before flipping on, so review holds only NEW facts.
          if (enabled) baselineReviewApprovals(teamId, env);
          const result = writeTeamReview(teamId, enabled);
          // Re-project immediately so the canonical overlay matches the new mode
          // (turning review OFF must release held entries now, not at the next
          // daily backstop; turning ON stamps pending on anything not baselined).
          try {
            refreshKnowledgeClone(teamId, { force: true, env });
            runConvergenceCollector(teamId, env) // #855: async, non-blocking
              .catch((err) => console.warn(`[Orchestrator] review-mode re-projection for '${teamId}' failed: ${err.message}`));
          } catch (err) {
            console.warn(`[Orchestrator] review-mode re-projection for '${teamId}' failed: ${err.message}`);
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, ...result }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: errorMessage(err) }));
        }
      });
      return;
    }

    // ── Approve / reject a held KB entry (supervised review) ─────────────────────
    if (req.method === 'POST' && req.url === '/internal/knowledge/review') {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        try {
          const p = JSON.parse(body || '{}');
          const teamId = String(p.teamId || '');
          const id = String(p.id || '');
          const decision = String(p.decision || '');
          if (!AGENT_ID_RE.test(teamId)) throw new Error('invalid teamId');
          const result = reviewKnowledgeEntry(teamId, id, decision);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, ...result }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: errorMessage(err) }));
        }
      });
      return;
    }

    // ── Archive / unarchive a canonical KB entry (Phase 4) ──────────────────────
    if (req.method === 'POST' && req.url === '/internal/knowledge/archive') {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        try {
          const p = JSON.parse(body || '{}');
          const teamId = String(p.teamId || '');
          const id = String(p.id || '');
          if (!AGENT_ID_RE.test(teamId)) throw new Error('invalid teamId');
          const result = archiveKnowledgeEntry(teamId, id, p.archived !== false);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, ...result }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: errorMessage(err) }));
        }
      });
      return;
    }

    // ── Set / clear a KB entry's validity window (#916 bitemporal validity) ─────
    if (req.method === 'POST' && req.url === '/internal/knowledge/validity') {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        try {
          const p = JSON.parse(body || '{}');
          const teamId = String(p.teamId || '');
          const id = String(p.id || '');
          if (!AGENT_ID_RE.test(teamId)) throw new Error('invalid teamId');
          const result = setKnowledgeValidity(teamId, id, { validTo: p.validTo ?? null, supersededBy: p.supersededBy ?? null });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, ...result }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: errorMessage(err) }));
        }
      });
      return;
    }

    // ── Set / clear a KB entry's auto-load triggers (#917 scoped knowledge) ─────
    if (req.method === 'POST' && req.url === '/internal/knowledge/triggers') {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        try {
          const p = JSON.parse(body || '{}');
          const teamId = String(p.teamId || '');
          const id = String(p.id || '');
          if (!AGENT_ID_RE.test(teamId)) throw new Error('invalid teamId');
          const result = setKnowledgeTriggers(teamId, id, p.loadTriggers);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, ...result }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: errorMessage(err) }));
        }
      });
      return;
    }

    // ── Persist human-readable summaries for canonical KB entries (#635) ────────
    if (req.method === 'POST' && req.url === '/internal/knowledge/summaries') {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        try {
          const p = JSON.parse(body || '{}');
          const teamId = String(p.teamId || '');
          if (!AGENT_ID_RE.test(teamId)) throw new Error('invalid teamId');
          const result = persistKnowledgeSummaries(teamId, p.summaries || {});
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, ...result }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: errorMessage(err) }));
        }
      });
      return;
    }

    // ── Remove the source knowledge a just-promoted skill supersedes (#559) ──────
    // The admin-console's promote endpoint calls this AFTER a successful skill
    // write when the operator left the (pre-ticked) "remove source knowledge" box
    // checked. Archival, reversible, bypasses the promoted-entry archive guard.
    if (req.method === 'POST' && req.url === '/internal/knowledge/promote-cleanup') {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        try {
          const p = JSON.parse(body || '{}');
          const teamId = String(p.teamId || '');
          if (!AGENT_ID_RE.test(teamId)) throw new Error('invalid teamId');
          const skill = p.skill && typeof p.skill === 'object'
            ? { name: p.skill.name, tier: p.skill.tier } : null;
          const result = removePromotedSourceEntries(teamId, p.entryIds, { skill, auto: false });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, ...result }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: errorMessage(err) }));
        }
      });
      return;
    }

    const deactivateMatch = req.method === 'POST' && req.url.match(/^\/internal\/agents\/([^/]+)\/deactivate$/);
    if (deactivateMatch) {
      const id = decodeURIComponent(deactivateMatch[1]);
      let body = '';
      req.on('data', d => body += d);
      req.on('end', () => {
        let parsed = {};
        try { parsed = JSON.parse(body || '{}'); } catch { /* ignore */ }
        const mode = parsed.mode || undefined;
        (async () => {
          try {
            const result = await orchestrator.deactivateAgent(id, { mode });
            const httpStatus = result.warning ? 409 : 200;
            res.writeHead(httpStatus, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
          } catch (err) {
            console.error(`[Orchestrator] deactivateAgent error for ${id}: ${err.message}`);
            const status = /not found/i.test(err.message) ? 404 : 500;
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
          }
        })();
      });
      return;
    }

    const stopSessionMatch = req.method === 'POST' && req.url.match(/^\/internal\/agents\/([^/]+)\/stop-session$/);
    if (stopSessionMatch) {
      const id = decodeURIComponent(stopSessionMatch[1]);
      const ok = stopAgentSession(id);
      res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(ok ? { ok: true } : { error: 'Agent not running' }));
      return;
    }

    const stopOneSessionMatch = req.method === 'POST' && req.url.match(/^\/internal\/agents\/([^/]+)\/sessions\/([^/]+)\/stop$/);
    if (stopOneSessionMatch) {
      const id = decodeURIComponent(stopOneSessionMatch[1]);
      const sessionId = decodeURIComponent(stopOneSessionMatch[2]);
      const ok = stopAgentSession(id, sessionId);
      res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(ok ? { ok: true } : { error: 'Agent not running' }));
      return;
    }

    const reloadTriggersMatch = req.method === 'POST' && req.url.match(/^\/internal\/agents\/([^/]+)\/reload-triggers$/);
    if (reloadTriggersMatch) {
      const id = decodeURIComponent(reloadTriggersMatch[1]);
      const proc = agentProcesses.get(id);
      if (proc) {
        proc.kill('SIGUSR2');
        console.log(`[Orchestrator] Sent SIGUSR2 (reload-triggers) to agent ${id}`);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    const resetReposMatch = req.method === 'POST' && req.url.match(/^\/internal\/agents\/([^/]+)\/reset-repos$/);
    if (resetReposMatch) {
      const agentId = decodeURIComponent(resetReposMatch[1]);
      // Git here is network-bound (fetch, up to a 30s timeout per repo) and the
      // orchestrator runs on a single event loop the admin console proxies
      // through — a synchronous fetch froze every in-flight console request for
      // its whole duration (#1683). Run the whole reset asynchronously so the
      // loop stays responsive while a slow fetch is in flight.
      (async () => {
        const cfg = loadAgentConfig(agentId);
        if (!cfg) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Agent not found' }));
          return;
        }
        const env = cfg.environmentId ? loadEnvironment(cfg.environmentId) : null;
        const repos = Array.isArray(env?.repositories) ? env.repositories : [];
        const workspace = agentDir(agentId);
        const results = [];
        for (const repo of repos) {
          if (!repo?.url) continue;
          const repoName = (repo.url.split('/').pop() || 'repo').replace(/\.git$/, '');
          const repoPath = path.join(workspace, repoName);
          let branch = repo.branch || null;
          if (!fs.existsSync(path.join(repoPath, '.git'))) {
            results.push({ repo: repoName, skipped: 'not-a-git-repo' });
            continue;
          }
          const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
          if (repo.sshKeyId) {
            const keyPath = path.join(SSH_KEYS_DIR, repo.sshKeyId);
            if (fs.existsSync(keyPath)) {
              try { fs.chmodSync(keyPath, 0o600); } catch { /* best effort */ }
              gitEnv.GIT_SSH_COMMAND =
                `ssh -i ${keyPath} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null` +
                ` -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=8`;
            }
          }
          try {
            await execFileP('git', ['fetch', 'origin'], { cwd: repoPath, env: gitEnv, timeout: 30_000 });
            if (!branch) {
              // No branch configured — resolve the remote's HEAD so we don't
              // assume 'main'. Falls back to the locally checked-out branch if
              // the remote HEAD ref isn't available (e.g. older git servers).
              try {
                await execFileP('git', ['remote', 'set-head', 'origin', '--auto'], { cwd: repoPath, env: gitEnv, timeout: 10_000 });
                branch = (await execFileP('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { cwd: repoPath, env: gitEnv, timeout: 5_000 }))
                  .stdout.toString().trim().replace(/^origin\//, '');
              } catch {
                branch = (await execFileP('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoPath, env: gitEnv, timeout: 5_000 })).stdout.toString().trim();
              }
            }
            await execFileP('git', ['checkout', branch], { cwd: repoPath, env: gitEnv, timeout: 10_000 });
            await execFileP('git', ['reset', '--hard', `origin/${branch}`], { cwd: repoPath, env: gitEnv, timeout: 10_000 });
            results.push({ repo: repoName, branch, reset: true });
          } catch (err) {
            const detail = (err.stderr || err.stdout || err.message || '').toString().trim().slice(0, 200);
            console.warn(`[Orchestrator] reset-repos ${agentId}/${repoName}: ${detail}`);
            results.push({ repo: repoName, branch, failed: true, detail });
          }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, results }));
      })().catch((err) => {
        console.warn(`[Orchestrator] reset-repos ${agentId}: ${err.message}`);
        try {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'reset-repos-failed' }));
        } catch { /* response already started */ }
      });
      return;
    }

    // ── List a team's members with running/busy/trigger state ────────────
    // Feeds the team-wide disable/enable preview dialog in the admin console.
    const teamMembersMatch = req.method === 'GET' && req.url.match(/^\/internal\/teams\/([^/]+)\/members$/);
    if (teamMembersMatch) {
      const teamId = decodeURIComponent(teamMembersMatch[1]);
      try {
        const result = orchestrator.listTeamMembersWithState(teamId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        const status = httpStatusForTeamActionError(err);
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // ── Disable an entire team's members in one bulk action ───────────────
    // Body: { mode: 'drain' | 'abort' } — required, applied uniformly to
    // every currently-enabled member (the preview dialog already showed the
    // operator which members are busy before they picked one mode).
    const teamDisableMatch = req.method === 'POST' && req.url.match(/^\/internal\/teams\/([^/]+)\/disable$/);
    if (teamDisableMatch) {
      const teamId = decodeURIComponent(teamDisableMatch[1]);
      let body = '';
      req.on('data', d => body += d);
      req.on('end', () => {
        let parsed = {};
        try { parsed = JSON.parse(body || '{}'); } catch { /* ignore */ }
        (async () => {
          try {
            const result = await orchestrator.disableTeam(teamId, { mode: parsed.mode });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
          } catch (err) {
            console.error(`[Orchestrator] disableTeam error for ${teamId}: ${err.message}`);
            const status = httpStatusForTeamActionError(err, { hasMode: true });
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
          }
        })();
      });
      return;
    }

    // ── Re-enable an entire team's cascade-disabled members ───────────────
    const teamEnableMatch = req.method === 'POST' && req.url.match(/^\/internal\/teams\/([^/]+)\/enable$/);
    if (teamEnableMatch) {
      const teamId = decodeURIComponent(teamEnableMatch[1]);
      (async () => {
        try {
          const result = await orchestrator.enableTeam(teamId);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (err) {
          console.error(`[Orchestrator] enableTeam error for ${teamId}: ${err.message}`);
          const status = httpStatusForTeamActionError(err);
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      })();
      return;
    }

    // POST /internal/teams/:teamId/members — add member to team
    // Body (all optional): { id, displayName, systemPromptOverride,
    //   skillsOverride, sessionPolicy, triggers }
    const addMemberMatch = req.method === 'POST' && req.url.match(/^\/internal\/teams\/([^/]+)\/members$/);
    if (addMemberMatch) {
      const teamId = decodeURIComponent(addMemberMatch[1]);
      let body = '';
      req.on('data', d => body += d);
      req.on('end', async () => {
        let opts = {};
        if (body) {
          try { opts = JSON.parse(body) || {}; }
          catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `Invalid JSON body: ${err.message}` }));
            return;
          }
        }
        try {
          const result = await orchestrator.addTeamMember(teamId, opts);
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (err) {
          console.error(`[Orchestrator] addTeamMember error for ${teamId}: ${err.message}`);
          const status = /not found/i.test(err.message) ? 404
            : /not a team/i.test(err.message) ? 400
            : /already exists/i.test(err.message) ? 409
            : 500;
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // GET /internal/teams/:teamId/knowledge/digest-status — which KB entries
    // are currently inside the team's digest budget (unification Phase 3).
    // Computed live from the canonical clone with the same pure builder that
    // writes knowledge-digest.md, so the "in digest" indicator in the admin
    // console can never disagree with the file the agents actually import.
    const digestStatusMatch = req.method === 'GET' &&
      req.url.match(/^\/internal\/teams\/([^/]+)\/knowledge\/digest-status$/);
    if (digestStatusMatch) {
      const teamId = decodeURIComponent(digestStatusMatch[1]);
      try {
        const clonePath = knowledgeFeed.canonicalClonePath(KNOWLEDGE_CLONE_ROOT, teamId);
        if (!clonePath || !fs.existsSync(path.join(clonePath, '.git'))) {
          return sendJson(res, 404, { error: 'no canonical KB clone for this team' });
        }
        const resolved = resolveTeamKbRepo(teamId);
        const storeRoot = path.join(clonePath, _kbStoreRel(resolved?.env || null));
        const digest = buildKnowledgeDigest({
          teamId,
          generatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
          entries: readKbStoreEntries(storeRoot),
        });
        return sendJson(res, 200, {
          teamId,
          includedIds: digest.includedIds,
          includedCount: digest.includedCount,
          totalCount: digest.totalCount,
          omittedCount: digest.omittedCount,
          tokensUsed: digest.tokensUsed,
        });
      } catch (err) {
        console.error(`[Orchestrator] digest-status error for ${teamId}: ${err.message}`);
        return sendJson(res, 500, { error: err.message });
      }
    }

    // GET /internal/teams/:teamId/knowledge/curation-health — the #919 health
    // record the nightly pass persists. `status: "unknown"` until the first
    // pass has run (never a 404 — "no record yet" is a valid answer).
    const curationHealthMatch = req.method === 'GET' &&
      req.url.match(/^\/internal\/teams\/([^/]+)\/knowledge\/curation-health$/);
    if (curationHealthMatch) {
      const teamId = decodeURIComponent(curationHealthMatch[1]);
      try {
        const health = readCurationHealth(teamId);
        return sendJson(res, 200, { teamId, ...(health || { status: 'unknown' }) });
      } catch (err) {
        return sendJson(res, 500, { error: err.message });
      }
    }

    // GET /internal/teams/:teamId/knowledge/retrieval-stats — the read-side
    // aggregate (#915): per-entry last-used truth + the `since` baseline the
    // Gap-5 decay sweep needs. Empty aggregate (no telemetry yet) is a valid
    // 200, never a 404 — "no data" is itself the cold-start signal.
    const retrievalStatsMatch = req.method === 'GET' &&
      req.url.match(/^\/internal\/teams\/([^/]+)\/knowledge\/retrieval-stats$/);
    if (retrievalStatsMatch) {
      const teamId = decodeURIComponent(retrievalStatsMatch[1]);
      try {
        return sendJson(res, 200, { teamId, ...readRetrievalStats(teamId) });
      } catch (err) {
        return sendJson(res, 500, { error: err.message });
      }
    }

    // GET /internal/teams/:teamId/flow-anomalies — observe-only stall detection
    // (#959, concept §4.1/§4.3). Derives the team's expected label state machine
    // from member ports, sweeps GitHub + run state with the poller's PAT, and
    // returns the classified anomaly list. Skipped during maintenance mode (the
    // sweep is a poll, and repairs — a later phase — must not fire in the window).
    const flowAnomaliesMatch = req.method === 'GET' &&
      req.url.match(/^\/internal\/teams\/([^/]+)\/flow-anomalies(?:\?.*)?$/);
    if (flowAnomaliesMatch) {
      const teamId = decodeURIComponent(flowAnomaliesMatch[1]);
      (async () => {
        try {
          const cfg = loadAgentConfig(teamId);
          if (!cfg || cfg.role !== 'team') {
            return sendJson(res, 404, { error: 'agent team not found' });
          }
          const maint = readMaintenanceState();
          if (maint && maint.active) {
            return sendJson(res, 200, {
              teamId, maintenance: true, anomalies: [], generatedAt: new Date().toISOString(),
            });
          }
          const result = await computeTeamFlowAnomalies(teamId);
          return sendJson(res, 200, { maintenance: false, ...result });
        } catch (err) {
          console.error(`[Orchestrator] flow-anomalies error for ${teamId}: ${err.message}`);
          return sendJson(res, 500, { error: err.message });
        }
      })();
      return;
    }

    // GET /internal/teams/:teamId/hill-climb/metrics — the latest persisted
    // metrics snapshot (hill-climbing loop Phase 1, #1222). Read-only; returns
    // the most recent day-keyed snapshot or { snapshot: null } if the team has
    // never had a pass. Never re-computes (that is the POST .../run path).
    const hillClimbGetMatch = req.method === 'GET' &&
      req.url.match(/^\/internal\/teams\/([^/]+)\/hill-climb\/metrics(?:\?.*)?$/);
    if (hillClimbGetMatch) {
      const teamId = decodeURIComponent(hillClimbGetMatch[1]);
      try {
        const cfg = loadAgentConfig(teamId);
        if (!cfg || cfg.role !== 'team') {
          return sendJson(res, 404, { error: 'agent team not found' });
        }
        const snapshot = readLatestHillClimbSnapshot(teamId);
        return sendJson(res, 200, { teamId, snapshot: snapshot || null });
      } catch (err) {
        console.error(`[Orchestrator] hill-climb metrics error for ${teamId}: ${err.message}`);
        return sendJson(res, 500, { error: err.message });
      }
    }

    // POST /internal/teams/:teamId/hill-climb/run — manual metrics pass (#1222).
    // Same code path as the scheduled daily timer, behind the per-team
    // single-flight lock: a manual run while a pass is already in flight is
    // rejected 409 pass-running. Skipped during maintenance mode (same gate as
    // the anomaly-history sweep). Overwrites the same-day snapshot.
    const hillClimbRunMatch = req.method === 'POST' &&
      req.url.match(/^\/internal\/teams\/([^/]+)\/hill-climb\/run$/);
    if (hillClimbRunMatch) {
      const teamId = decodeURIComponent(hillClimbRunMatch[1]);
      (async () => {
        try {
          const cfg = loadAgentConfig(teamId);
          if (!cfg || cfg.role !== 'team') {
            return sendJson(res, 404, { error: 'agent team not found' });
          }
          const maint = readMaintenanceState();
          if (maint && maint.active) {
            return sendJson(res, 200, { teamId, maintenance: true, snapshot: null });
          }
          const out = await runHillClimbPass(teamId);
          if (!out.ok) {
            return sendJson(res, 409, { error: out.reason });
          }
          // The run also folded the deterministic heuristic cards into the store
          // (#1224) and returns the secret-free analyst `digest`; the console
          // runs the LLM analyst over it and POSTs any cards back to
          // .../hill-climb/cards/merge. Cards are proposals only.
          return sendJson(res, 200, {
            teamId, maintenance: false, snapshot: out.snapshot,
            cards: out.cards, merge: out.merge, digest: out.digest, autonomy: out.autonomy,
          });
        } catch (err) {
          console.error(`[Orchestrator] hill-climb run error for ${teamId}: ${err.message}`);
          return sendJson(res, 500, { error: err.message });
        }
      })();
      return;
    }

    // GET /internal/teams/:teamId/hill-climb/cards — the persisted improvement
    // cards (#1224). Read-only; returns the full card list across their whole
    // lifecycle so the Improvements panel can render open cards + the closed
    // ledger. Never re-computes.
    const hillClimbCardsMatch = req.method === 'GET' &&
      req.url.match(/^\/internal\/teams\/([^/]+)\/hill-climb\/cards(?:\?.*)?$/);
    if (hillClimbCardsMatch) {
      const teamId = decodeURIComponent(hillClimbCardsMatch[1]);
      try {
        const cfg = loadAgentConfig(teamId);
        if (!cfg || cfg.role !== 'team') return sendJson(res, 404, { error: 'agent team not found' });
        // `autonomy` rides along so the console can gate the Apply action (#1225)
        // before it runs any mutation, without a second round-trip.
        const { autonomy } = hillClimbCardConfig(teamId);
        return sendJson(res, 200, { teamId, autonomy, cards: readHillClimbCards(teamId) });
      } catch (err) {
        console.error(`[Orchestrator] hill-climb cards error for ${teamId}: ${err.message}`);
        return sendJson(res, 500, { error: err.message });
      }
    }

    // POST /internal/teams/:teamId/hill-climb/cards/merge — hand-back path for
    // the console's server-side analyst (#1224). Body: { cards: [...] } (raw
    // analyst JSON). Every card is re-validated through the schema here (the
    // store is the authority — the analyst is untrusted) and merged under the
    // budget/dedup/cooldown rules. Proposals only; nothing mutates agent config.
    const hillClimbMergeMatch = req.method === 'POST' &&
      req.url.match(/^\/internal\/teams\/([^/]+)\/hill-climb\/cards\/merge$/);
    if (hillClimbMergeMatch) {
      const teamId = decodeURIComponent(hillClimbMergeMatch[1]);
      (async () => {
        try {
          const cfg = loadAgentConfig(teamId);
          if (!cfg || cfg.role !== 'team') return sendJson(res, 404, { error: 'agent team not found' });
          const { autonomy } = hillClimbCardConfig(teamId);
          if (autonomy < 1) return sendJson(res, 200, { teamId, autonomy, merge: null, cards: readHillClimbCards(teamId) });
          const body = JSON.parse((await readBody(req)) || '{}');
          const incoming = Array.isArray(body.cards) ? body.cards : [];
          const merge = mergeAndPersistHillClimbCards(teamId, incoming, { source: 'analyst' });
          return sendJson(res, 200, {
            teamId,
            merge: { added: merge.added, bumped: merge.bumped, deferred: merge.deferred, rejected: merge.rejected },
            cards: merge.cards,
          });
        } catch (err) {
          console.error(`[Orchestrator] hill-climb cards merge error for ${teamId}: ${err.message}`);
          return sendJson(res, 500, { error: err.message });
        }
      })();
      return;
    }

    // POST /internal/teams/:teamId/hill-climb/cards/:cardId/dismiss — flip a card
    // to 'dismissed' so it is not re-raised (#1224). Human action; card-state
    // only, never touches agent config.
    const hillClimbDismissMatch = req.method === 'POST' &&
      req.url.match(/^\/internal\/teams\/([^/]+)\/hill-climb\/cards\/([^/]+)\/dismiss$/);
    if (hillClimbDismissMatch) {
      const teamId = decodeURIComponent(hillClimbDismissMatch[1]);
      const cardId = decodeURIComponent(hillClimbDismissMatch[2]);
      try {
        const cfg = loadAgentConfig(teamId);
        if (!cfg || cfg.role !== 'team') return sendJson(res, 404, { error: 'agent team not found' });
        const card = dismissHillClimbCard(teamId, cardId);
        if (!card) return sendJson(res, 404, { error: 'card not found' });
        return sendJson(res, 200, { teamId, card });
      } catch (err) {
        console.error(`[Orchestrator] hill-climb card dismiss error for ${teamId}: ${err.message}`);
        return sendJson(res, 500, { error: err.message });
      }
    }

    // POST /internal/teams/:teamId/hill-climb/cards/:cardId/apply — record an
    // APPLIED card (hill-climbing loop Phase 2b, #1225). The console has already
    // run the card's declared apply path through the existing audited choke-point
    // (as the acting human); this only stamps the outcome onto the card so #1226
    // can measure it. Autonomy < 2 refuses (apply is a level-2 action even via a
    // direct call), and only an open card can be applied. Body: { appliedBy?,
    // undo?, configVersionRef? } gathered console-side before the mutation.
    const hillClimbApplyMatch = req.method === 'POST' &&
      req.url.match(/^\/internal\/teams\/([^/]+)\/hill-climb\/cards\/([^/]+)\/apply$/);
    if (hillClimbApplyMatch) {
      const teamId = decodeURIComponent(hillClimbApplyMatch[1]);
      const cardId = decodeURIComponent(hillClimbApplyMatch[2]);
      (async () => {
        try {
          const cfg = loadAgentConfig(teamId);
          if (!cfg || cfg.role !== 'team') return sendJson(res, 404, { error: 'agent team not found' });
          const body = JSON.parse((await readBody(req)) || '{}');
          const result = applyHillClimbCard(teamId, cardId, {
            appliedBy: body.appliedBy || null,
            undo: body.undo || null,
            configVersionRef: body.configVersionRef || null,
          });
          if (!result.ok) {
            const status = result.code === 'card-not-found' ? 404
              : result.code === 'autonomy-locked' ? 403
              : 409;
            return sendJson(res, status, { error: result.code, autonomy: result.autonomy, status: result.status });
          }
          return sendJson(res, 200, { teamId, card: result.card });
        } catch (err) {
          console.error(`[Orchestrator] hill-climb card apply error for ${teamId}: ${err.message}`);
          return sendJson(res, 500, { error: err.message });
        }
      })();
      return;
    }

    // POST /internal/teams/:teamId/hill-climb/cards/:cardId/rollback — record a
    // ROLLED-BACK card (hill-climbing loop Phase 3, #1226). The console has
    // already executed the card's rollback plan through the existing audited
    // choke-point (as the acting human); this only stamps the outcome + a fresh
    // cooldown so the object re-enters detection after a full window. Autonomy
    // < 2 refuses, and only a `regressed` card (one that carries a rollback
    // offer) can be rolled back. Body: { rolledBackBy?, undoResult? }.
    const hillClimbRollbackMatch = req.method === 'POST' &&
      req.url.match(/^\/internal\/teams\/([^/]+)\/hill-climb\/cards\/([^/]+)\/rollback$/);
    if (hillClimbRollbackMatch) {
      const teamId = decodeURIComponent(hillClimbRollbackMatch[1]);
      const cardId = decodeURIComponent(hillClimbRollbackMatch[2]);
      (async () => {
        try {
          const cfg = loadAgentConfig(teamId);
          if (!cfg || cfg.role !== 'team') return sendJson(res, 404, { error: 'agent team not found' });
          const body = JSON.parse((await readBody(req)) || '{}');
          const result = rollbackHillClimbCard(teamId, cardId, {
            rolledBackBy: body.rolledBackBy || null,
            undoResult: body.undoResult || null,
          });
          if (!result.ok) {
            const status = result.code === 'card-not-found' ? 404
              : result.code === 'autonomy-locked' ? 403
              : 409;
            return sendJson(res, status, { error: result.code, autonomy: result.autonomy, status: result.status });
          }
          return sendJson(res, 200, { teamId, card: result.card });
        } catch (err) {
          console.error(`[Orchestrator] hill-climb card rollback error for ${teamId}: ${err.message}`);
          return sendJson(res, 500, { error: err.message });
        }
      })();
      return;
    }

    // POST /internal/teams/:teamId/skills/{activate,deactivate} — team-owned
    // skill (de)activation (phase 2): idempotent list edit on the team agent's
    // skills[] + additive file sync into every materialized member workspace.
    // Body: { skillName, includeMembers?, onlyMembers? } (includeMembers:
    // override members to opt in explicitly; onlyMembers: scope the file sync to
    // a subset — the member-aware "Sync now" retry, #739).
    const teamSkillMatch = req.method === 'POST' &&
      req.url.match(/^\/internal\/teams\/([^/]+)\/skills\/(activate|deactivate)$/);
    if (teamSkillMatch) {
      const teamId = decodeURIComponent(teamSkillMatch[1]);
      const active = teamSkillMatch[2] === 'activate';
      let body = '';
      req.on('data', d => body += d);
      req.on('end', async () => {
        let payload;
        try { payload = JSON.parse(body || '{}'); }
        catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `Invalid JSON body: ${err.message}` }));
          return;
        }
        try {
          const result = await orchestrator.setTeamSkillActive(teamId, payload?.skillName, {
            active,
            includeMembers: Array.isArray(payload?.includeMembers) ? payload.includeMembers : [],
            onlyMembers: Array.isArray(payload?.onlyMembers) ? payload.onlyMembers : [],
          });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (err) {
          console.error(`[Orchestrator] setTeamSkillActive error for ${teamId}: ${err.message}`);
          const status = /not found/i.test(err.message) ? 404
            : /not a team|required/i.test(err.message) ? 400
            : 500;
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // POST /internal/agents/:id/skills/{activate,deactivate} — same for a
    // single non-member agent (standalone / orchestrator).
    const agentSkillMatch = req.method === 'POST' &&
      req.url.match(/^\/internal\/agents\/([^/]+)\/skills\/(activate|deactivate)$/);
    if (agentSkillMatch) {
      const agentId = decodeURIComponent(agentSkillMatch[1]);
      const active = agentSkillMatch[2] === 'activate';
      let body = '';
      req.on('data', d => body += d);
      req.on('end', async () => {
        let payload;
        try { payload = JSON.parse(body || '{}'); }
        catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `Invalid JSON body: ${err.message}` }));
          return;
        }
        try {
          const result = await orchestrator.setAgentSkillActive(agentId, payload?.skillName, { active });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (err) {
          console.error(`[Orchestrator] setAgentSkillActive error for ${agentId}: ${err.message}`);
          const status = /not found/i.test(err.message) ? 404
            : /team-member|is a team|required/i.test(err.message) ? 400
            : 500;
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // ── Plugin grant + registry routes (#1547) ────────────────────────────
    // Deliberately mirroring the skill routes above: the plugin grant is their
    // sibling and (de)activation is the same additive live sync, no respawn.

    // POST /internal/plugins/reconcile — start sidecars for installed plugins,
    // stop orphans of uninstalled ones. Called by the console after an
    // install/uninstall and once at orchestrator startup. Idempotent.
    if (req.method === 'POST' && req.url === '/internal/plugins/reconcile') {
      (async () => {
        try {
          const result = await reconcilePluginsAndAttachments();
          return sendJson(res, 200, result);
        } catch (err) {
          console.error(`[Orchestrator] plugin reconcile error: ${err.message}`);
          return sendJson(res, 500, { error: err.message });
        }
      })();
      return;
    }

    // GET /internal/plugins — the installed registry as the orchestrator sees
    // it, including which sidecars are actually running. The console has its
    // own view of the registry directory; this one answers "what is LIVE".
    if (req.method === 'GET' && req.url === '/internal/plugins') {
      (async () => {
        try {
          const entries = pluginRegistry.listPlugins();
          let live = [];
          try { live = await pluginRuntime.listLiveSidecars(); } catch { /* runtime down: report none */ }
          const running = new Set(live.map((c) => (c.Labels || {})['aee.plugin.id']).filter(Boolean));
          return sendJson(res, 200, {
            plugins: entries.map((e) => ({
              id: e.id,
              ok: e.ok,
              errors: e.errors,
              manifest: e.manifest,
              sidecarRunning: running.has(e.id),
            })),
          });
        } catch (err) {
          return sendJson(res, 500, { error: err.message });
        }
      })();
      return;
    }

    // GET /internal/plugins/:id/ui-endpoint — the sidecar's base URL for the
    // console's §4.8 UI proxy. The orchestrator owns sidecar truth because it
    // starts them; on Kubernetes the address is a Service name rather than a
    // container name, so a lookup is the only form that survives that phase, and
    // the admin-console image (which copies only api/*.js) never learns the
    // naming rule. 404 when the plugin is not installed / its manifest is
    // invalid; `running` tells the caller whether a broker is actually up.
    const uiEndpointMatch = req.method === 'GET' &&
      req.url.split('?')[0].match(/^\/internal\/plugins\/([^/]+)\/ui-endpoint$/);
    if (uiEndpointMatch) {
      (async () => {
        try {
          const pluginId = decodeURIComponent(uiEndpointMatch[1]);
          const entry = pluginRegistry.readPluginManifest(pluginId);
          if (!entry.ok || !entry.manifest) {
            return sendJson(res, 404, { error: `Plugin '${pluginId}' is not installed or its manifest is invalid` });
          }
          let running = false;
          try {
            const live = await pluginRuntime.listLiveSidecars();
            running = new Set(live.map((c) => (c.Labels || {})['aee.plugin.id']).filter(Boolean)).has(pluginId);
          } catch { /* runtime down: report not running */ }
          return sendJson(res, 200, {
            pluginId,
            endpoint: pluginRuntime.brokerBaseUrl(entry.manifest),
            hasUi: !!(entry.manifest.ui && Array.isArray(entry.manifest.ui.routes)),
            running,
          });
        } catch (err) {
          return sendJson(res, 500, { error: err.message });
        }
      })();
      return;
    }

    // GET /internal/plugins/:id/granted-agents — the resolved grant enumeration
    // the console feeds to plugin-ui-proxy.deriveScopeList: every materialised
    // agent whose effective grant includes this plugin, shaped
    // { agentId, parentTeamId?, scopeGranularity }, plus a display-name
    // directory. Discovery is not a new read privilege — the list is derived
    // ONLY from grants that already exist.
    const grantedAgentsMatch = req.method === 'GET' &&
      req.url.split('?')[0].match(/^\/internal\/plugins\/([^/]+)\/granted-agents$/);
    if (grantedAgentsMatch) {
      (async () => {
        try {
          const pluginId = decodeURIComponent(grantedAgentsMatch[1]);
          const entry = pluginRegistry.readPluginManifest(pluginId);
          if (!entry.ok || !entry.manifest) {
            return sendJson(res, 404, { error: `Plugin '${pluginId}' is not installed or its manifest is invalid` });
          }
          const configs = listAgentIds().map((id) => loadAgentConfig(id)).filter(Boolean);
          const teams = {};
          const agents = {};
          for (const c of configs) {
            const name = c.displayName || c.name || c.id;
            agents[c.id] = name;
            if (c.role === 'team') teams[c.id] = name;
          }
          const grantedAgents = [];
          for (const c of configs) {
            if (!c.token) continue; // a stub has no running surface
            let grant = null;
            try { grant = pluginGrantFor(effectivePlugins(c, loadAgentConfig), pluginId); }
            catch { grant = null; }
            if (!grant) continue;
            grantedAgents.push({
              agentId: c.id,
              parentTeamId: c.parentTeamId || null,
              teamId: c.role === 'team' ? c.id : (c.parentTeamId || null),
              scopeGranularity: grant.scopeGranularity === 'agent' ? 'agent' : 'team',
              agentName: agents[c.id],
              teamName: teams[c.parentTeamId] || (c.role === 'team' ? teams[c.id] : undefined),
            });
          }
          return sendJson(res, 200, { pluginId, grantedAgents, directory: { teams, agents } });
        } catch (err) {
          return sendJson(res, 500, { error: err.message });
        }
      })();
      return;
    }

    // POST /internal/teams/:teamId/plugins/{activate,deactivate}
    // Body: { pluginId, scopeGranularity?, includeMembers? }
    const teamPluginMatch = req.method === 'POST' &&
      req.url.match(/^\/internal\/teams\/([^/]+)\/plugins\/(activate|deactivate)$/);
    if (teamPluginMatch) {
      const teamId = decodeURIComponent(teamPluginMatch[1]);
      const active = teamPluginMatch[2] === 'activate';
      let body = '';
      req.on('data', d => body += d);
      req.on('end', async () => {
        let payload;
        try { payload = JSON.parse(body || '{}'); }
        catch (err) { return sendJson(res, 400, { error: `Invalid JSON body: ${err.message}` }); }
        try {
          const result = await orchestrator.setTeamPluginActive(teamId, payload?.pluginId, {
            active,
            scopeGranularity: payload?.scopeGranularity || null,
            includeMembers: Array.isArray(payload?.includeMembers) ? payload.includeMembers : [],
          });
          return sendJson(res, 200, result);
        } catch (err) {
          console.error(`[Orchestrator] setTeamPluginActive error for ${teamId}: ${err.message}`);
          const status = /not found/i.test(err.message) ? 404
            : /not a team|required|not installed|does not honour|unknown scope/i.test(err.message) ? 400
            : 500;
          return sendJson(res, status, { error: err.message });
        }
      });
      return;
    }

    // POST /internal/agents/:id/plugins/{activate,deactivate}
    // Body: { pluginId, scopeGranularity? }
    const agentPluginMatch = req.method === 'POST' &&
      req.url.match(/^\/internal\/agents\/([^/]+)\/plugins\/(activate|deactivate)$/);
    if (agentPluginMatch) {
      const agentId = decodeURIComponent(agentPluginMatch[1]);
      const active = agentPluginMatch[2] === 'activate';
      let body = '';
      req.on('data', d => body += d);
      req.on('end', async () => {
        let payload;
        try { payload = JSON.parse(body || '{}'); }
        catch (err) { return sendJson(res, 400, { error: `Invalid JSON body: ${err.message}` }); }
        try {
          const result = await orchestrator.setAgentPluginActive(agentId, payload?.pluginId, {
            active,
            scopeGranularity: payload?.scopeGranularity || null,
          });
          return sendJson(res, 200, result);
        } catch (err) {
          console.error(`[Orchestrator] setAgentPluginActive error for ${agentId}: ${err.message}`);
          const status = /not found/i.test(err.message) ? 404
            : /is a team|required|not installed|does not honour|unknown scope/i.test(err.message) ? 400
            : 500;
          return sendJson(res, status, { error: err.message });
        }
      });
      return;
    }

    // POST /internal/skills/resync — drift-gated resync (#629 AC3/AC4). Body:
    // { skillName, teamId?, agentId? }. Delivers the current source content to
    // every seeded copy in scope through the additive sync, refusing
    // diverged/conflict/orphaned/unknown copies (never auto-overwritten).
    const skillResyncMatch = req.method === 'POST' && req.url === '/internal/skills/resync';
    if (skillResyncMatch) {
      let body = '';
      req.on('data', d => body += d);
      req.on('end', async () => {
        let payload;
        try { payload = JSON.parse(body || '{}'); }
        catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `Invalid JSON body: ${err.message}` }));
          return;
        }
        try {
          const result = await orchestrator.resyncSkill({
            name: payload?.skillName,
            teamId: typeof payload?.teamId === 'string' ? payload.teamId : null,
            agentId: typeof payload?.agentId === 'string' ? payload.agentId : null,
          });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (err) {
          console.error(`[Orchestrator] resyncSkill error: ${err.message}`);
          const status = /required/i.test(err.message) ? 400 : 500;
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // GET|POST /internal/teams/:teamId/token-telemetry — read / toggle the
    // per-team opt-in for the PR-merge token comment (#678, AC4 — OFF by default).
    // The only switch for a feature that ships dark; no admin-console proxy/UI yet
    // (out of scope for #678). GET returns { enabled }; POST { enabled: bool } sets it.
    const tokenTelemetryMatch = req.url.match(/^\/internal\/teams\/([^/]+)\/token-telemetry$/);
    if (tokenTelemetryMatch && (req.method === 'GET' || req.method === 'POST')) {
      const teamId = decodeURIComponent(tokenTelemetryMatch[1]);
      if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ enabled: prCommentConfig.isPrMergeCommentEnabled(WORKSPACE, teamId) }));
        return;
      }
      let body = '';
      req.on('data', d => body += d);
      req.on('end', () => {
        let payload;
        try { payload = JSON.parse(body || '{}'); }
        catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `Invalid JSON body: ${err.message}` }));
          return;
        }
        if (typeof payload?.enabled !== 'boolean') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'enabled (boolean) required' }));
          return;
        }
        try {
          prCommentConfig.setPrMergeCommentEnabled(WORKSPACE, teamId, payload.enabled);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ enabled: payload.enabled }));
        } catch (err) {
          const status = /unsafe team id/i.test(err.message) ? 400 : 500;
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // POST /internal/teams/:teamId/prompt — update team's systemPromptTemplate
    // and push it to all inheriting members.
    const teamPromptMatch = req.method === 'POST' && req.url.match(/^\/internal\/teams\/([^/]+)\/prompt$/);
    if (teamPromptMatch) {
      const teamId = decodeURIComponent(teamPromptMatch[1]);
      let body = '';
      req.on('data', d => body += d);
      req.on('end', async () => {
        let payload;
        try { payload = JSON.parse(body || '{}'); }
        catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `Invalid JSON body: ${err.message}` }));
          return;
        }
        if (typeof payload?.systemPromptTemplate !== 'string') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'systemPromptTemplate (string) required' }));
          return;
        }
        try {
          const result = await orchestrator.updateTeamPrompt(teamId, payload.systemPromptTemplate);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (err) {
          console.error(`[Orchestrator] updateTeamPrompt error for ${teamId}: ${err.message}`);
          const status = /not found/i.test(err.message) ? 404
            : /not a team/i.test(err.message) ? 400
            : 500;
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    if (req.method !== 'POST' || req.url !== '/internal/agents') {
      res.writeHead(404); res.end(); return;
    }
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        const {
          id, displayName, role, systemPrompt, environmentId,
          schedule, taskPrompt,
          // Team-Setup wizard fields (all optional, additive):
          team, sessionPolicy, triggers,
          // Owning (human) Team — the tenant this construct belongs to (#299).
          teamId,
          // Human OWNER (#2077, D8): the user-record id of the creating human,
          // resolved by the console from the authenticated session — never
          // self-asserted by an agent, since this API is unauthenticated.
          // Honoured for `role: 'team'` and `role: 'agent'` only.
          ownerId, ownerSource,
          // For role: 'team' — suppress the auto-numbered first member
          // (the wizard adds members itself with role overrides instead).
          skipFirstMember,
          // For role: 'team' — ordered stage names for the process graph layout.
          stages,
          // For role: 'team' — the gate/brake label registry (#928): the
          // authoritative source for which labels are human approval gates
          // (`humanGate`) and which pause the loop (`brake`).
          labels,
          // For role: 'team' — named human roles (#987): first-class human flow
          // nodes the process graph binds the #981 touchpoints to. Declarative
          // only; never materialised into an agent.
          humans,
          // Initial skill grant (team-owned skills, skill-grants.js): the
          // team's active set / the standalone agent's own list. The
          // environment no longer contributes skills.
          skills,
          // For role: 'team' — label suffix (#902): stored for extend-mode
          // consistency and Flow-Editor dialog pre-fill.
          labelSuffix,
          // For role: 'team' — hill-climb collector config (#1222): the run-metrics
          // window/floor/cron/excludeAgents, round-tripped with the bundle.
          hillClimb,
        } = JSON.parse(body);
        if (!id || !displayName || !role || !environmentId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'id, displayName, role, environmentId required' }));
          return;
        }
        // `orchestrator` was removed from this whitelist by #1962 — it is the
        // authoritative gate (the console API validates only presence), so
        // dropping it here is what makes the role uncreatable platform-wide.
        if (!['agent', 'team'].includes(role)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `Invalid role: ${role}. Must be one of: agent, team` }));
          return;
        }
        // Teams may be created without a default prompt — members can carry
        // their own per-role prompts, and the team stores an empty template.
        if (role !== 'team' && !systemPrompt) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'systemPrompt required for role: agent' }));
          return;
        }
        if (loadAgentConfig(id) || agentTeardownRegistry.has(id)) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `Agent '${id}' already exists` }));
          return;
        }

        const extra = { schedule, taskPrompt };
        // Wizard-side extras layered on top of the legacy fields.
        if (team) extra.team = team;
        if (sessionPolicy) extra.sessionPolicy = sessionPolicy;
        if (Array.isArray(triggers)) extra.triggers = triggers;
        if (skipFirstMember) extra.skipFirstMember = true;
        if (teamId) extra.teamId = teamId;
        if (typeof ownerId === 'string' && ownerId.trim()) extra.ownerId = ownerId.trim();
        if (typeof ownerSource === 'string' && ownerSource.trim()) extra.ownerSource = ownerSource.trim();
        if (Array.isArray(stages)) extra.stages = stages;
        if (Array.isArray(labels)) extra.labels = labels;
        if (Array.isArray(humans)) extra.humans = humans;
        if (Array.isArray(skills)) extra.skills = skills;
        if (typeof labelSuffix === 'string' && labelSuffix) extra.labelSuffix = labelSuffix;
        if (hillClimb && typeof hillClimb === 'object' && !Array.isArray(hillClimb)) extra.hillClimb = hillClimb;
        const result = await orchestrator.createAgent(id, displayName, role, systemPrompt, environmentId, extra);
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        console.error(`[Orchestrator] Internal API create error: ${err.message}`);
        // A login that stays M_USER_DEACTIVATED after the reactivation-retry loop
        // (issue #1386) means the just-deleted account was still deactivated —
        // e.g. re-creating the same id faster than the homeserver settled, or a
        // build where reset-password can't clear the flag. Surface the actionable
        // message + a stable code instead of a raw `Login failed: {...}` stack
        // (409 = retryable conflict, not a bad request or a server fault).
        if (matrixLoginRetry.isDeactivatedError(err)) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: matrixLoginRetry.DEACTIVATED_USER_MESSAGE,
            code: 'matrix_user_deactivated',
          }));
          return;
        }
        // 400 for caller-fixable misconfigurations (missing env / token, clone
        // rejected by the remote) so the UI surfaces them as a validation
        // error rather than a generic 500 server error.
        const isUserError = /not found/i.test(err.message) || /clone failed/i.test(err.message);
        const statusCode = isUserError ? 400 : 500;
        res.writeHead(statusCode, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
  });
  internalApi.listen(4002, '0.0.0.0', () =>
    console.log('[Orchestrator] Internal API listening on :4002')
  );

  // ============================================================
  // Webhook server — receives HTTP triggers from external systems
  // (GitHub, CI, etc.) and enqueues them for the target agent.
  //
  // POST /hooks/:agentId/:hookId
  //   → looks up a trigger with type="http" and matching id in
  //     /workspace/agents/:agentId/triggers.json
  //   → validates X-Hook-Secret against the trigger's `secret` field
  //   → appends to /workspace/agents/:agentId/pending-triggers.json
  //   → agent-runner picks it up within seconds and fires the prompt
  //
  // Each HTTP trigger MUST carry its own `secret` (auto-generated when
  // created via the Admin Console). Triggers without a secret are
  // rejected with 401, since an external endpoint without auth is a
  // footgun even on a private network.
  // ============================================================
  const HOOK_PORT = parseInt(process.env.HOOK_PORT || '4003', 10);

  function constantTimeEqual(a, b) {
    try {
      const ba = Buffer.from(a);
      const bb = Buffer.from(b);
      if (ba.length !== bb.length) return false;
      return crypto.timingSafeEqual(ba, bb);
    } catch {
      return false;
    }
  }

  const hookServer = http.createServer((req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }

    const match = req.url.match(/^\/hooks\/([^/]+)\/([^/]+)$/);
    if (!match) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found — expected /hooks/:agentId/:hookId' }));
      return;
    }

    const agentId = match[1];
    const hookId  = match[2];
    const agentDir = path.join(AGENTS_DIR, agentId);

    if (!fs.existsSync(agentDir)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Agent '${agentId}' not found` }));
      return;
    }

    // Reject webhooks for disabled agents — the agent process is stopped and
    // no new executions should start. Callers can retry after re-enabling.
    try {
      const agentCfg = JSON.parse(fs.readFileSync(path.join(agentDir, 'config.json'), 'utf8'));
      if (agentCfg?.enabled === false) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Agent '${agentId}' is disabled` }));
        return;
      }
    } catch { /* no config.json → new agent, allow through */ }

    const triggers = loadTriggers(agentId); // canonical copy (#185 Phase 2)

    const trigger = Array.isArray(triggers)
      ? triggers.find(t => t.id === hookId && t.type === 'http' && t.enabled !== false)
      : null;
    if (!trigger) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `HTTP trigger '${hookId}' not found for agent '${agentId}'` }));
      return;
    }

    // Per-trigger secret check — every HTTP trigger must carry its own
    // secret. Triggers without one are misconfigured and rejected.
    if (!trigger.secret) {
      console.log(`[HookServer] Rejected '${hookId}' for '${agentId}': trigger has no secret configured`);
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Trigger has no secret configured' }));
      return;
    }
    const provided = req.headers['x-hook-secret'] || '';
    if (!constantTimeEqual(provided, trigger.secret)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    enqueuePending(agentId, { triggerId: hookId });

    console.log(`[HookServer] Queued trigger '${hookId}' for agent '${agentId}'`);
    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ queued: true, triggerId: hookId, agentId }));
  });

  hookServer.listen(HOOK_PORT, '0.0.0.0', () =>
    console.log(`[Orchestrator] Hook server listening on :${HOOK_PORT}`)
  );

  // ============================================================
  // GitHub event poller — translates GitHub Events API activity into
  // pending-triggers entries for agents that subscribed via a
  // type=github-event trigger. See orchestrator/github-poller.js.
  // ============================================================
  const { GitHubPoller } = require('./github-poller');
  const ghPoller = new GitHubPoller({
    loadEnvironment,
    listEnvironmentIds: () => {
      try {
        return fs.readdirSync(ENVIRONMENTS_DIR).filter(n => !n.startsWith('_'));
      } catch {
        return [];
      }
    },
    enqueuePending, // #185 Phase 2: orchestrator owns the queue (control plane when isolated)
    triggersPath: (agentId) => controlOrPoolPath(agentId, 'triggers.json'),
    onMergedPr: postPrTokenComment, // #678 Phase 3 item 2: PR-merge token comment
    labelMarkers: labelDedupMarkers, // #1858 internal fast-path dedup (shared with the label-applied endpoint)
  });
  ghPoller.start();

  // ============================================================
  // Knowledge curator backstop (Shared Agent Learning, Phase 4).
  // The convergence collector runs event-driven on every KB push; this timer is
  // the concept's "cron only as a backstop, never the primary driver" — a ≤ daily
  // sweep that force-refreshes + re-runs the collector for every knowledge-enabled
  // team, so an autonomy-dial change (e.g. flipped to level 3 after facts already
  // converged) or a push whose collector failed still converges/promotes within a
  // day. Idempotent: a team with nothing new produces no commit and no promotion.
  // ============================================================
  const CURATOR_INTERVAL_MS = Math.max(
    60_000,
    Number(process.env.KNOWLEDGE_CURATOR_INTERVAL_MS) || 24 * 60 * 60 * 1000,
  );
  const runCuratorBackstop = () => {
    let teamIds;
    try {
      teamIds = [...new Set(
        listAgentIds()
          .map((id) => { const c = loadAgentConfig(id); return c && agentKnowledgeTeamId(c); })
          .filter((t) => typeof t === "string" && t),
      )];
    } catch (err) {
      console.warn(`[Orchestrator] curator backstop: team enumeration failed: ${err.message}`);
      return;
    }
    for (const teamId of teamIds) {
      try {
        refreshKnowledgeClone(teamId, { force: true });
        // #918: embed missing/stale vectors BEFORE the collector, so this very
        // pass can already link semantically; then the collector (#855 async),
        // then #919's decay/health sweep. Each step best-effort, chained.
        runTeamEmbeddingPass(teamId)
          .catch((err) => console.warn(`[Orchestrator] embedding pass for '${teamId}' failed: ${err.message}`))
          .then(() => runConvergenceCollector(teamId))
          .then(() => runTeamDecaySweep(teamId))
          .catch((err) => console.warn(`[Orchestrator] curator backstop for '${teamId}' failed: ${err.message}`));
      } catch (err) {
        console.warn(`[Orchestrator] curator backstop for '${teamId}' failed: ${err.message}`);
      }
    }
  };
  const curatorTimer = setInterval(runCuratorBackstop, CURATOR_INTERVAL_MS);
  if (typeof curatorTimer.unref === "function") curatorTimer.unref();

  // ============================================================
  // Skill auto-reconcile loop (skill-UX Phase 3, #776 §3).
  // Heals `pending` skill members — a member granted a skill but missing it from
  // its seed manifest gets the idempotent workspace sync re-run for it, so
  // distribution is system work, not a human "Sync now". Bounded retry/backoff
  // lives in the pure planner; this timer just drives it with an overlap guard.
  // ============================================================
  const RECONCILE_INTERVAL_MS = Math.max(
    30_000,
    Number(process.env.SKILL_RECONCILE_INTERVAL_MS) || 5 * 60 * 1000,
  );
  let reconcileBusy = false;
  const runSkillReconcile = async () => {
    if (reconcileBusy) return; // overlap guard — a slow pass must not stack
    reconcileBusy = true;
    try { await orchestrator.reconcilePendingSkills(); }
    catch (err) { console.warn(`[Orchestrator] skill reconcile pass failed: ${err.message}`); }
    finally { reconcileBusy = false; }
  };
  const reconcileTimer = setInterval(runSkillReconcile, RECONCILE_INTERVAL_MS);
  if (typeof reconcileTimer.unref === "function") reconcileTimer.unref();

  // ============================================================
  // Hill-climbing loop Phase 1 (#1221): scheduled flow-anomaly-sweep persistence.
  // The live GET .../flow-anomalies endpoint computes and discards; recurrence
  // detection (the hill-climber) and the flow-reconciliation Phase-4 responder's
  // "third sighting" ladder both need history. An hourly timer (poller cadence
  // class) re-runs the same sweep per Agent Team and appends one JSONL line to
  // /workspace/teams/<teamId>/hill-climb/anomaly-history.jsonl, then prunes lines
  // past the retention window (default 90 days). Skipped during maintenance mode
  // (same gate as the endpoint — the sweep is a poll). Best-effort: a failed sweep
  // records an errors-only line and never throws out of the timer; a team with no
  // repos/tokens produces no file and no errors.
  // ============================================================
  const anomalyHistory = require("./anomaly-history");
  const HILL_CLIMB_ANOMALY_INTERVAL_MS = Math.max(
    60_000,
    Number(process.env.HILL_CLIMB_ANOMALY_INTERVAL_MS) || 60 * 60 * 1000,
  );
  let anomalyHistoryBusy = false;
  const runAnomalyHistorySweep = async () => {
    if (anomalyHistoryBusy) return; // overlap guard — a slow sweep must not stack
    anomalyHistoryBusy = true;
    try {
      const maint = readMaintenanceState();
      if (maint && maint.active) return; // maintenance suppresses scheduled sweeps
      let teamIds;
      try {
        teamIds = listAgentIds().filter((id) => {
          try { const c = loadAgentConfig(id); return c && c.role === "team"; }
          catch { return false; }
        });
      } catch (err) {
        console.warn(`[Orchestrator] anomaly-history: team enumeration failed: ${err.message}`);
        return;
      }
      for (const teamId of teamIds) {
        let result = null;
        try {
          result = await computeTeamFlowAnomalies(teamId);
        } catch (err) {
          // A sweep that threw outright still records an errors-only line so the
          // gap is visible in history — never let it escape the timer.
          anomalyHistory.record(teamId, anomalyHistory.buildHistoryEntry({ errors: [err.message] }));
          anomalyHistory.pruneOldEntries(teamId);
          continue;
        }
        // A team with no repos/tokens resolved produces no file and no errors.
        if ((result.repos || []).length === 0 && (result.errors || []).length === 0) continue;
        anomalyHistory.record(teamId, anomalyHistory.buildHistoryEntry(result));
        anomalyHistory.pruneOldEntries(teamId);
      }
    } catch (err) {
      console.warn(`[Orchestrator] anomaly-history sweep failed: ${err.message}`);
    } finally {
      anomalyHistoryBusy = false;
    }
  };
  const anomalyHistoryTimer = setInterval(runAnomalyHistorySweep, HILL_CLIMB_ANOMALY_INTERVAL_MS);
  if (typeof anomalyHistoryTimer.unref === "function") anomalyHistoryTimer.unref();

  // ============================================================
  // Hill-climbing loop Phase 1 (#1222): daily per-team metrics collector.
  // Folds the team's log surfaces (session JSONL, usage spool, #1221's
  // anomaly-history, the event-transparency log, audit / prompt-history) into the
  // §4 run-metric catalog and persists one day-keyed snapshot per Agent Team at
  // /workspace/teams/<teamId>/hill-climb/metrics/<date>.json (same-day re-run
  // overwrites). Daily cadence (staggered like the curation crons), skipped during
  // maintenance mode. Shares the per-team single-flight lock with the manual
  // POST .../hill-climb/run endpoint (runHillClimbPass), so a scheduled and a
  // manual pass never overlap and produce identical snapshots for identical
  // inputs. Best-effort: a per-team failure is logged and never escapes the timer.
  // ============================================================
  const HILL_CLIMB_METRICS_INTERVAL_MS = Math.max(
    60_000,
    Number(process.env.HILL_CLIMB_METRICS_INTERVAL_MS) || 24 * 60 * 60 * 1000,
  );
  let hillClimbMetricsBusy = false;
  const runHillClimbMetricsSweep = async () => {
    if (hillClimbMetricsBusy) return; // overlap guard — a slow pass must not stack
    hillClimbMetricsBusy = true;
    try {
      const maint = readMaintenanceState();
      if (maint && maint.active) return; // maintenance suppresses scheduled passes
      let teamIds;
      try {
        teamIds = listAgentIds().filter((id) => {
          try { const c = loadAgentConfig(id); return c && c.role === "team"; }
          catch { return false; }
        });
      } catch (err) {
        console.warn(`[Orchestrator] hill-climb metrics: team enumeration failed: ${err.message}`);
        return;
      }
      for (const teamId of teamIds) {
        try {
          await runHillClimbPass(teamId);
        } catch (err) {
          // Best-effort per team: a failed collection must not stop the others.
          console.warn(`[Orchestrator] hill-climb metrics pass failed for ${teamId}: ${err.message}`);
        }
      }
    } catch (err) {
      console.warn(`[Orchestrator] hill-climb metrics sweep failed: ${err.message}`);
    } finally {
      hillClimbMetricsBusy = false;
    }
  };
  const hillClimbMetricsTimer = setInterval(runHillClimbMetricsSweep, HILL_CLIMB_METRICS_INTERVAL_MS);
  if (typeof hillClimbMetricsTimer.unref === "function") hillClimbMetricsTimer.unref();
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
