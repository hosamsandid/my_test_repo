'use strict';

const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { runArchiveTool, streamArchiveTool, describeArchiveFailure } = require('./archive');
const matrix = require('./matrix');
const auth = require('./auth');
const audit = require('./audit');
const internalAuthClient = require('./internal-auth-client');
const githubEventLog = require('./github-event-log');
const clientErrorLog = require('./client-error-log');
const usageLog = require('./usage-log');
const { summarize } = require('./usage-summary');
const prEventsLog = require('./pr-events-log');
const { buildWorkItems, workItemDetail } = require('./work-items');
const usageExport = require('./usage-export');
const maintenanceMode = require('./maintenance-mode');
const { detectRasterImageType, imageContentType } = require('./image-type');
const { discoverBoundAgents, hiddenBlastRadius, projectRespawnOutcome, respawnWithConcurrency } = require('./respawn-agents');
const { githubApiBase } = require('./github-api-base');
const { createTtlCache } = require('./ttl-cache');
const { computeScope, visibleTeam, visibleAgent, canManageTeam, canManageAgent,
        visibleEnvironment, canManageEnvironment, canCreateEnvironment, canRetierEnvironment,
        visibleUser, describeAuthz,
        normalizeCredential, visibleCredential, canManageCredential, canCreateCredential,
        canReassignCredential, credentialVisibleToTeam, canViewUsageStatistics,
        resolveAgentTenant } = require('./scope');
const { resolveAgentTeam } = require('./agent-team');
const { createAgentManageGate } = require('./team-member-boundary');
// Layered resource ownership (#2083, P5) — the shared tier shape for
// environments and MCP servers. Byte-mirrored in orchestrator/resource-tier.js.
const { tierOwnershipFields, isRetier } = require('./resource-tier');
// Global model providers (#2136): the System-Admin-only publish gate + the
// provider-specific reachability predicate. `isGlobalProvider` is composed with
// the generic scope.js predicates ONLY at the model-provider call sites (see
// `providerVisible` / `providerUsableByTeam` below), never inside scope.js —
// those predicates also gate SSH keys and GitHub tokens (finding 2).
const { resolveGlobalFlag, isGlobalProvider } = require('./llm-endpoint-global');
// Global working environments + MCP servers (#2158): the same System-Admin-only
// publish gate shape, applied to a second resource family. `isGlobalEnvironment`
// is composed with `visibleEnvironment` ONLY at the environment/MCP-server call
// sites below — never inside scope.js or resource-tier.js (AC4), for the same
// reason `isGlobalProvider` stays out of the generic credential predicates.
const { resolveGlobalFlag: resolveEnvGlobalFlag, isGlobalEnvironment } = require('./global-resource');
const { resolveAuthEnabled, authModeLogLine, singleUserElevationWarning } = require('./auth-mode');
const { createWorkPlaneGates, WORK_PLANE_AGENT_PREFIXES,
        WORK_PLANE_ROOM_PREFIX } = require('./work-plane-access');
const { buildAssistModelOptions } = require('./assist-model-options');
const llmHealth = require('./llm-health');
const { normalizeDiscoveredModels } = require('./model-discovery');
const { CHAT_AUTHOR_FIELD, chatAuthorStamp } = require('./chat-author');
// Per-human Matrix identity (#1458, epic #2076 P1). Byte-mirrored in
// orchestrator/human-matrix-store.js — the console reads the same
// /workspace/users/matrix/<userId>.json store the orchestrator provisions,
// so a human's own token can be used on the send path (#2173) without a
// second internal-API hop.
const { createHumanMatrixStore } = require('./human-matrix-store');
const { parseAssistSelection, resolveAssistSelection } = require('./assist-target');
const { buildSessionHistory, findResumableSession } = require('./session-history');
const { buildProcessGraph } = require('./process-graph');
const {
  validateHostMountPath,
  CONTEXT_MOUNT_TARGET,
  MAX_CONTEXT_MOUNTS,
  normalizeContextMountsInput,
  resolveContextMounts,
} = require('./context-mount');
const { buildKnowledgeGraph, summarizeKnowledge, parseScope, selectReviewQueue, overlayStatuses, overlayValidity, overlayLoadTriggers } = require('./knowledge-graph');
const knowledgeSuggestions = require('./knowledge-suggestions');
const knowledgeLinks = require('./knowledge-links');
const { buildProcessTemplate, validateProcessTemplate, templateToCustomRoles, buildMemberFromTemplate, liftTriggerEmits, expandGithubChannels, expandDataFlowSteps, normalizeLegacyReview, isChannelTrigger, expandWakeHandoffs, isWakeHandoffTrigger, stampDerivedActivation, emptyDraftBundle, deriveUniqueDraftId, applyDerivedPromptBlocks, normalizeHumans, pruneOrphanHumanConsumes, normalizeHillClimb, normalizeWipLimit, rawTriggerError, launchedLoopConflict, outcomesWiringContext } = require('./process-template');
const { injectDerivedTriggerRepo } = require('./derived-trigger-repo');
// Process-draft access model (#2068) — one predicate for every draft route.
const draftAccess = require('./draft-access');
// Team-member system-prompt modes (#1511): inherit / additional / exclusive.
const { PROMPT_MODES, resolvePromptMode, composeMemberPrompt } = require('./prompt-modes');
const { listProcessTemplates, loadProcessTemplate } = require('./process-template-registry');
const { parseGitHubUrl, deriveRepoIdentity } = require('./repo-identity');
const { normalizeTemplatePorts } = require('./catalog-ports');
const agentTemplateStore = require('./agent-templates-store');
const extractTemplate = require('./extract-template');
const { runCopilot, isCopilotAborted, classifyTurnFailure, sanitizeCopilotHistory, readFormatDoc, readPromptAddendum, measureCopilotSystemPrompt, SYSTEM_PROMPT_CHAR_LIMIT } = require('./flow-copilot');
const { httpPostStreamText } = require('./anthropic-transport');
const createHelperChatHandler = require('./helper-chat/handler');
const { heuristicPortSuggestion, buildPortSuggestionRequest, parsePortSuggestion } = require('./port-suggestion');
const { buildHillClimbAnalystRequest, parseHillClimbCards } = require('./hill-climb-analyst');
const hillClimbApplyGuard = require('./hill-climb-apply-guard');
const { heuristicOutcomeSuggestion, buildOutcomeSuggestionRequest, parseOutcomeSuggestion, wakePeerList } = require('./outcome-suggestion');
const { buildUnifiedGraph, briefingsToUnified, processTemplateToUnified, unifiedToProcessTemplate } = require('./unified-graph');
const { readBriefingPacks, BriefingsError } = require('./briefings-fs');
const { validateOutcomes, normalizeOutcomes, isAuthoredOutcomes } = require('./outcomes');
const { membersOfTeam } = require('./agent-team-cascade');
const skillManifest = require('./skill-manifest');
const promptHistory = require('./prompt-history');
const { resolveAgentStateDir } = require('./agent-state-dir');
const skillDrift = require('./skill-drift');
const skillLineage = require('./skill-lineage');
const skillTransfer = require('./skill-transfer');
const skillDeletion = require('./skill-deletion');
const skillMerge = require('./skill-merge');
const skillImport = require('./skill-import');
const skillGrantValidate = require('./skill-grant-validate');
const { buildSetupStatus } = require('./setup-status');
const { orderedArchiveNames, baseRoomOfSessionFile } = require('./session-archives');
const { createTranscribeRoute } = require('./transcribe.js');
const { validateSuffix, suggestSuffix: generateSuffix, applyLabelSuffix } = require('./label-suffix');
const { classifyMemberResidue, decideTeamCreate } = require('./team-residue');
const { reposFromEnv, repoVars } = require('./team-repo-resolve');
const { planCreatorMembership, creatorEnvironmentOwnership } = require('./creator-membership');
const { buildAgentStatus, statusCacheFresh } = require('./agent-statuses');
const { admitsToChatList } = require('./matrix-agent-list');
const { parseMemberMaterialize } = require('./member-materialize');
const { quickstartLlmSystemPrompt, validateQuickstartLlmInput, llmEnvId, llmAgentId } = require('./quickstart-llm');
const { validatePluginManifest } = require('./plugin-manifest');
// Agent toolchain registry (#1940) — the pure validator/resolver, byte-identical
// to orchestrator/toolchain-registry.js. The console owns the WRITE side (a
// System Admin registering an image reference); the orchestrator reads the same
// file at spawn time.
const {
  validateToolchain,
  validateToolchainManifest,
  toolchainFromManifest,
  resolveToolchainImage,
  normalizeRegistry: normalizeToolchainRegistry,
  normalizeRuntime: normalizeToolchainRuntime,
  DEFAULT_AGENT_IMAGE: BUILTIN_AGENT_IMAGE,
} = require('./toolchain-registry');
const { resolveSpecKitCommand, hasUnresolvedPlaceholders } = require('./speckit-content');
const { deriveScopeList, enforceUiRoute, signViewerHeaders } = require('./plugin-ui-proxy');
const { uiSubPath, visibleScopes, isGloballyVisibleUi, effectiveViewerRole } = require('./plugin-ui-viewer');

const WORKSPACE = '/workspace';
const POOL_DIR = '/pool';
const AGENT_TEMPLATES_DIR = path.join(POOL_DIR, 'agent-templates');
// User store for UI-managed role templates (#587). Lives on the durable
// workspace volume (NOT the pool that `make seed-templates` wipes), so UI
// edits/creates survive a re-seed. Shadows the seeded defaults: user wins.
const USER_AGENT_TEMPLATES_DIR = path.join(WORKSPACE, 'agent-templates');
const AGENTS_DIR = path.join(WORKSPACE, 'agents');
// The per-human Matrix credential store (#1458), same root the orchestrator
// provisions into — see the require above for why the console reads it
// directly rather than proxying through :4002.
const humanMatrixStore = createHumanMatrixStore({ root: WORKSPACE });
// Control-plane volume (#185): agents push status + session-log to the
// orchestrator, which persists them here. Mounted read-write by both services.
const CONTROL_DIR = '/control/agents';
// Resolve a per-agent state file, preferring the pushed control-plane copy and
// falling back to the agent's own workspace when it hasn't pushed yet (or push
// is off). Keeps the read-repoint non-breaking on the shared volume and lets it
// transparently survive per-agent volume isolation.
function controlOrAgentPath(...segs) {
  const ctrl = path.join(CONTROL_DIR, ...segs);
  if (fs.existsSync(ctrl)) return ctrl;
  return path.join(AGENTS_DIR, ...segs);
}

// Per-archive parsed-events cache (#1684). Session-log archives are immutable
// once rotated, so their parsed rows never change — a file's (size, mtime) is a
// safe signature. Caching them means GET .../sessions/history re-reads and
// re-parses only the growing live file on each poll, not the whole archive set,
// so response time stays flat as rotated history accumulates. Bounded LRU.
const SESSION_ARCHIVE_CACHE_MAX = 512;
const _sessionArchiveCache = new Map(); // `path:size:mtimeMs` -> events[]

function _cachedArchiveEvents(fullPath, parse) {
  let st;
  try { st = fs.statSync(fullPath); } catch { return null; }
  const key = `${fullPath}:${st.size}:${st.mtimeMs}`;
  const hit = _sessionArchiveCache.get(key);
  if (hit) {
    // Refresh LRU recency.
    _sessionArchiveCache.delete(key);
    _sessionArchiveCache.set(key, hit);
    return hit;
  }
  let raw;
  try { raw = fs.readFileSync(fullPath, 'utf8'); } catch { return null; }
  const events = [];
  for (const line of raw.split('\n')) {
    if (line.trim()) events.push(parse(line));
  }
  if (_sessionArchiveCache.size >= SESSION_ARCHIVE_CACHE_MAX) {
    const oldest = _sessionArchiveCache.keys().next().value;
    _sessionArchiveCache.delete(oldest);
  }
  _sessionArchiveCache.set(key, events);
  return events;
}

// Rotated session-log archives of `roomId` (#673), oldest→newest, parsed to
// events via `parse`. Archives are immutable and read WHOLESALE, so a finished
// session's rows survive rotation. The live file is NOT included — callers
// concatenate it after these. Best-effort: an unreadable archive is skipped.
// Parsed archives are memoized (see _cachedArchiveEvents) so repeated reads
// don't re-parse the whole history (#1684).
function readSessionArchiveEvents(agentId, roomId, parse) {
  const dir = controlOrAgentPath(agentId, 'sessions');
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const name of orderedArchiveNames(names, roomId)) {
    const events = _cachedArchiveEvents(path.join(dir, name), parse);
    if (events) out.push(...events);
  }
  return out;
}
const ENVIRONMENTS_DIR = path.join(WORKSPACE, 'environments');
const SSH_KEYS_DIR = path.join(ENVIRONMENTS_DIR, '_keys');
const SSH_KEYS_INDEX = path.join(SSH_KEYS_DIR, 'index.json');
const GH_TOKENS_DIR = path.join(ENVIRONMENTS_DIR, '_tokens');
const GH_TOKENS_INDEX = path.join(GH_TOKENS_DIR, 'index.json');
const LLM_ENDPOINTS_DIR = path.join(WORKSPACE, 'llm-endpoints');
const LLM_ENDPOINTS_INDEX = path.join(LLM_ENDPOINTS_DIR, 'index.json');
const LLM_KEYS_DIR = path.join(LLM_ENDPOINTS_DIR, '_keys');
// Model Provider health status (#1843) — persisted SEPARATELY from index.json so
// the background poller's frequent rewrites never race the CRUD read-modify-write
// of the endpoint list. Keyed by endpoint id → health record (see llm-health.js).
const LLM_HEALTH_INDEX = path.join(LLM_ENDPOINTS_DIR, 'health.json');
const MCP_SERVERS_DIR = path.join(WORKSPACE, 'mcp-servers');
const MCP_CREDENTIALS_DIR = path.join(WORKSPACE, 'mcp-credentials');
const MCP_CREDENTIALS_KEYS_DIR = path.join(MCP_CREDENTIALS_DIR, '_keys');
const MCP_CREDENTIALS_INDEX = path.join(MCP_CREDENTIALS_KEYS_DIR, 'index.json');
// Teams data model (#299): resources are owned by exactly one human Team.
const TEAMS_INDEX = path.join(WORKSPACE, 'teams', 'index.json');
const USERS_INDEX = path.join(WORKSPACE, 'users', 'index.json');
const MEMBERSHIPS_INDEX = path.join(WORKSPACE, 'memberships', 'index.json');
const DEFAULT_TEAM_ID = 'default';
// The env single-admin login (#276); its session subject is this value and it
// is treated as the operator (full visibility) by the scope filter (#302).
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
// Single-user ⇄ multi-user mode (#1457). Off by default: an existing stack that
// upgrades keeps today's behaviour (every principal is the implicit System
// Admin) until an operator activates multi-user mode explicitly. See auth-mode.js.
const AUTH_ENABLED = resolveAuthEnabled(process.env);
const STATIC_DIR = path.join(__dirname, '..', 'dist');
const PODMAN_SOCK = process.env.PODMAN_SOCK_PATH || '/var/run/podman.sock';

fs.mkdirSync(ENVIRONMENTS_DIR, { recursive: true });
fs.mkdirSync(SSH_KEYS_DIR, { recursive: true });
fs.mkdirSync(GH_TOKENS_DIR, { recursive: true });
fs.mkdirSync(LLM_ENDPOINTS_DIR, { recursive: true });
fs.mkdirSync(LLM_KEYS_DIR, { recursive: true });
fs.mkdirSync(MCP_SERVERS_DIR, { recursive: true });
fs.mkdirSync(MCP_CREDENTIALS_KEYS_DIR, { recursive: true });

// Control-plane credential for :4002 (#1456, GOV-PLATFORM-2). Installed BEFORE
// the app is built — and therefore before any route handler, any background
// poller and `auth.js`'s pre-session `POST /internal/admin/users/verify` — can
// make its first orchestrator call. There are 126 raw fetch call sites reaching
// :4002 from this process; wrapping the global is what makes "every one of them
// carries the token" a property rather than a review claim. Scoped to the
// orchestrator's own origin + `/internal/` (see internal-auth-client.js), so the
// GitHub / Matrix / LLM calls this same process makes never see it. Inert with
// no INTERNAL_API_TOKEN configured.
{
  const r = internalAuthClient.installInternalAuthFetch();
  console.log(`[API] internal-auth control-plane token: ${r.installed
    ? `installed for ${r.origin}` : `not installed (${r.reason})`}`);
}

const app = express();
// Trust one hop (the GKE/IAP load balancer) so express-rate-limit can read
// the real client IP from X-Forwarded-For without throwing a ValidationError.
app.set('trust proxy', 1);
app.use(cors());
// Document-bundle endpoints (process drafts, the unified flow graph, imported
// BriefingPack flows) carry the full brief.md / prompt bodies inline, which
// easily exceeds body-parser's 100kb default. Raise the limit so importing /
// rendering / saving a multi-BP flow doesn't 413 (#377). Behind the auth gate.
app.use(express.json({ limit: '10mb' }));
app.use(express.static(STATIC_DIR));

// Allowlist for ids that turn into filesystem path segments. The dotted-
// segment pattern explicitly rejects "..", leading/trailing dots and
// consecutive dots — without this the previous /^[\w.-]+$/ regex would
// have accepted ".." and allowed traversal one level up out of AGENTS_DIR.
// Inline `AGENT_ID_RE.test(x)` checks at the start of every route reading
// an agent id from req.params/req.body/req.query are recognised by CodeQL
// as a path-injection sanitizer (js/path-injection); helper-indirected
// checks are not, which is why the regex is applied inline.
const AGENT_ID_RE = /^[a-zA-Z0-9_-]+(\.[a-zA-Z0-9_-]+)*$/;
const SSH_KEY_ID_RE = /^[a-z0-9-]+$/;
const GH_TOKEN_ID_RE = /^[a-z0-9-]+$/;
const SKILL_NAME_RE = /^[a-zA-Z0-9_-]+([.:][a-zA-Z0-9_-]+)*$/;
// Blueprint id / memory-file path params (proxied into the orchestrator URL).
// Allowlist guards (no separators, no '..') sanitize the values for the URL path.
const BP_PARAM_RE = /^[a-zA-Z0-9_-]+$/;
const BP_FILE_RE = /^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/;

// Rate limiter for the coordinator-workflow endpoints — uses express-rate-limit
// rather than a hand-rolled bucket so that CodeQL's js/missing-rate-limiting
// query recognises it (the query only flags routes without a known middleware).
const coordinatorWorkflowLimiter = rateLimit({
  windowMs: 60_000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests' },
});
const handoverLimiter = rateLimit({
  windowMs: 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests' },
});

// Per-route limiter explicitly attached to mutating/heavy routes so CodeQL's
// js/missing-rate-limiting query recognises them. Generous max because this
// is an internal single-user admin console — the UI legitimately bursts
// dozens of requests during page navigations and polls several endpoints on
// 5s intervals.
const apiLimiter = rateLimit({
  windowMs: 60_000,
  max: 2000,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests' },
});

// Tighter limit for routes that spawn processes, run git clone, or write
// large files. Still generous enough not to interfere with normal UI use.
const heavyLimiter = rateLimit({
  windowMs: 60_000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests' },
});

// Global limiter — a SEPARATE rateLimit instance from apiLimiter so the two
// don't share a counter. (Using the same instance both globally and
// per-route would double-increment every request and halve the effective
// limit.) Catches GET routes that don't carry an explicit limiter.
const globalApiLimiter = rateLimit({
  windowMs: 60_000,
  max: 3000,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests' },
});

app.use('/api/', globalApiLimiter);

// SPA fallback limiter — a SEPARATE instance again (the catch-all serves the
// static index.html from disk, so CodeQL's js/missing-rate-limiting flags its
// file-system access unless a limiter is attached; the global limiter above is
// mounted only on /api/ and never sees these routes). Very generous: this is
// the shell every browser navigation lands on for a single-user admin console.
const spaLimiter = rateLimit({
  windowMs: 60_000,
  max: 3000,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests' },
});

// Audit trail (#305). Mounted before the auth wiring so it observes every
// mutating /api request — including denied/unauthenticated ones — and reads the
// acting human from req.user lazily at response-finish time. Best-effort: it can
// never block or break a request (see audit.js).
app.use('/api', audit.auditMutations);

// Authentication (#276). Mounted after the global limiter (so the gate itself
// is rate-limited) and before every protected route definition below. Public
// auth endpoints are registered first; the gate then requires a valid session
// cookie for all other /api/* routes. Static assets + the SPA fallback stay
// open so the console can load and render its login screen.
// Inject the authorization descriptor resolver (#584) so the session/login
// responses carry the caller's admin indicator + per-team roles for the
// frontend, reusing the same users/memberships indexes as getScope. The same
// resolver gates IAP auto-login (#1415): only a registered user-store subject
// gets a silent session; readJsonFile degrading to [] on an unreadable users
// index means unknown → login form (fail-closed).
//
// `usersSeeded` backs the public readiness probe (#2059 AC3): the first-boot
// seed writes the users index before the orchestrator serves anything, so this
// file having at least one record is what "ready to be signed in to" means.
auth.registerAuthRoutes(app, {
  describeAuthz: (subject) => describeAuthz({
    username: subject,
    users: readJsonFile(USERS_INDEX, []),
    memberships: readJsonFile(MEMBERSHIPS_INDEX, []),
    authEnabled: AUTH_ENABLED,
  }),
  usersSeeded: () => readJsonFile(USERS_INDEX, []).length > 0,
});
app.use('/api', auth.gate);

// Work-plane tenant isolation (#1459 §2 — GOV-ACCESS-3 / GOV-PLATFORM-4).
//
// One gate in front of the entire `:agentId` family (workspace browser, git
// actions, session log, context folders, chat upload) and the Matrix chat
// rooms, which until now authorized nothing beyond the id's shape — the widest
// live cross-tenant hole (docs/governance-concept.md:196-201).
//
// Mounted HERE, immediately after the authentication gate and ~1 400 lines
// before the first route it protects, deliberately: express walks its stack in
// registration order, so a gate registered up front cannot be bypassed by a
// route that is added later, in the wrong place, or by someone who does not
// know the gate exists. The rules and the mount list live in
// work-plane-access.js; `work-plane-access.test.js` re-derives the list from
// this file's own route table and fails if a `:agentId` route escapes it.
//
// The lookups are injected rather than imported so the middleware is reachable
// from a real-HTTP test (api.js boots two listeners on require, #651).
const workPlaneGates = createWorkPlaneGates({
  getScope,
  visibleAgent,
  isValidAgentId: (id) => AGENT_ID_RE.test(id),
  // `safeAgentPath` returns null for a missing agent directory or config, so an
  // unresolvable agent arrives at the predicate as `null` and is refused — the
  // same 404 as "no such agent", never a guessed `default` tenant.
  loadAgentMeta: (id) => {
    const cfgPath = safeAgentPath(id, 'config.json');
    const cfg = cfgPath ? readJsonFile(cfgPath, null) : null;
    return cfg ? agentMetaForScope(cfg) : null;
  },
  loadRoomAgentMeta: (roomId) => {
    const owner = findAgentByDmRoom(roomId);
    return owner && owner.cfg ? agentMetaForScope(owner.cfg) : null;
  },
});
for (const prefix of WORK_PLANE_AGENT_PREFIXES) app.use(prefix, workPlaneGates.agentGate);
app.use(WORK_PLANE_ROOM_PREFIX, workPlaneGates.roomGate);

// Helper Chat guided-tour manifest (#1737, Phase 2.2). Serves the pre-built
// tour manifest (generated + vendored by #1736) behind the global /api gate
// above. The loader degrades to an empty { chapters: [] } when the generated
// file is not present, so this endpoint never fails the API to boot on a
// checkout where #1736 has not merged yet. Memoized once real chapters load.
const { readTourManifest: _readTourManifest } = require('./helper-chat/tour-manifest-loader');
let _tourManifestCache = null;
app.get('/api/helper/tour-manifest', (req, res) => {
  if (!_tourManifestCache) {
    const m = _readTourManifest();
    // Only cache once the real (non-empty) manifest is present, so the endpoint
    // self-heals if the generated file appears after startup.
    if (Array.isArray(m.chapters) && m.chapters.length > 0) _tourManifestCache = m;
    return res.json(m);
  }
  res.json(_tourManifestCache);
});

// ─── Context-help topics (#1872, spec docs/context-help-system-concept.md §3) ──
// GET /api/helper/page-help returns the whole curated topic set once (a few KB;
// the client resolves the current route → topic locally so face-switching is
// instant/offline). The SAME help-topics/ files ground the chat corpus above, so
// there is no vendoring/parity drift. Behind the global /api auth gate like every
// other /api route. Topics are small + static; load once and memoize.
const _helpRegistryModule = require('./helper-chat/help-registry');
let _pageHelpCache = null;
app.get('/api/helper/page-help', (req, res) => {
  if (!_pageHelpCache) {
    const topics = _helpRegistryModule.loadTopics();
    _pageHelpCache = { topics, overviewId: _helpRegistryModule.OVERVIEW_ID };
  }
  res.json(_pageHelpCache);
});

// Speech-to-text transcription: proxies audio to the STT service and returns { text }.
const _transcribeUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
app.post('/api/transcribe', _transcribeUpload.single('audio_file'), createTranscribeRoute());

// Helper Chat tour screenshots (#1736, Phase 2.1). The tour manifest
// (admin-console/api/helper-chat/tour-manifest.json) references screenshots by
// relative path ("team-setup/create-launcher.png"); the PNGs are captured by a
// green journey run and served here as static files. express.static normalizes
// and rejects "../" traversal internally, so the user-controlled URL sub-path
// cannot escape the artifacts root. Behind the global /api limiter + auth gate.
//
// The PNGs are committed under api/helper-chat/tour-screenshots/ (alongside the
// generated tour-manifest.json) precisely so they travel with the image: the
// Dockerfile's `COPY api/helper-chat ./api/helper-chat` bakes them in, so the
// route works in every deploy target (local compose + GKE) with no volume or
// env wiring. They are refreshed from a green journey run by the scheduled
// tour-screenshots workflow (.github/workflows/tour-screenshots.yml), which
// copies e2e/artifacts/ into this directory and commits the diff.
// TOUR_ARTIFACTS_DIR still overrides the source (e.g. a bind-mount pointing at a
// fresh local `e2e/artifacts/` while iterating on captures).
const TOUR_ARTIFACTS_DIR = process.env.TOUR_ARTIFACTS_DIR
  || path.resolve(__dirname, 'helper-chat', 'tour-screenshots');
app.use('/api/helper/tour-screenshot', express.static(TOUR_ARTIFACTS_DIR));

// Read recent audit entries (newest first). Protected by the gate above.
app.get('/api/audit', (req, res) => {
  res.json(audit.recentEntries(Number(req.query.limit) || 200));
});

// Read GitHub poller event-transparency entries (#469): every fresh event the
// poller saw, whether delivered, dropped (with reason), digested, or matching
// no subscriber at all. Protected by the gate above.
app.get('/api/github-events', (req, res) => {
  const entries = githubEventLog.queryEntries({
    since: req.query.since,
    until: req.query.until,
    limit: Number(req.query.limit) || undefined,
  });
  const nameCache = new Map();
  const agentName = (agentId) => {
    if (!nameCache.has(agentId)) {
      const cfg = readJsonFile(path.join(AGENTS_DIR, agentId, 'config.json'), null);
      nameCache.set(agentId, cfg?.name || agentId);
    }
    return nameCache.get(agentId);
  };
  res.json(entries.map((e) => ({
    ...e,
    outcomes: (e.outcomes || []).map((o) => ({ ...o, agentName: agentName(o.agentId) })),
  })));
});

// Pending-triggers dispatch queue — operator visibility & control (#724).
// Distinct from /api/github-events above (that is the history of already-
// PROCESSED events); this surfaces the UPSTREAM live queue of entries enqueued
// but not yet drained by the agent. All three are thin proxies to the
// orchestrator, which owns the per-agent pending-triggers.json files and runs
// the read/cancel in its single event loop (race-free, no file lock). Gated by
// the auth gate mounted above, consistent with the other agent-internal
// endpoints (AC11).
//
//  - GET  /api/pending-queue                    → aggregated, read-only view (AC1/AC3)
//  - GET  /api/agents/:id/pending/:entryId       → full entry incl. payload (detail on demand)
//  - DELETE /api/agents/:id/pending/:entryId     → cancel one entry (AC5/AC7)
const PENDING_ENTRY_ID_RE = /^[a-zA-Z0-9_-]+$/;

app.get('/api/pending-queue', async (req, res) => {
  const orchestratorUrl = process.env.ORCHESTRATOR_URL || 'http://orchestrator:4002';
  try {
    const r = await fetch(`${orchestratorUrl}/internal/pending-queue`);
    const body = await r.json().catch(() => ({ ok: false, error: 'invalid orchestrator response' }));
    return res.status(r.status).json(body);
  } catch (err) {
    return res.status(502).json({ ok: false, error: `orchestrator unreachable: ${err.message}` });
  }
});

app.get('/api/agents/:id/pending/:entryId', async (req, res) => {
  const { id, entryId } = req.params;
  if (!AGENT_ID_RE.test(id) || !PENDING_ENTRY_ID_RE.test(entryId)) {
    return res.status(400).json({ ok: false, error: 'Invalid agent id or entry id' });
  }
  const orchestratorUrl = process.env.ORCHESTRATOR_URL || 'http://orchestrator:4002';
  try {
    const r = await fetch(`${orchestratorUrl}/internal/agents/${encodeURIComponent(id)}/pending/${encodeURIComponent(entryId)}`);
    const body = await r.json().catch(() => ({ ok: false, error: 'invalid orchestrator response' }));
    return res.status(r.status).json(body);
  } catch (err) {
    return res.status(502).json({ ok: false, error: `orchestrator unreachable: ${err.message}` });
  }
});

app.delete('/api/agents/:id/pending/:entryId', async (req, res) => {
  const { id, entryId } = req.params;
  if (!AGENT_ID_RE.test(id) || !PENDING_ENTRY_ID_RE.test(entryId)) {
    return res.status(400).json({ ok: false, error: 'Invalid agent id or entry id' });
  }
  const orchestratorUrl = process.env.ORCHESTRATOR_URL || 'http://orchestrator:4002';
  try {
    const r = await fetch(`${orchestratorUrl}/internal/agents/${encodeURIComponent(id)}/pending/${encodeURIComponent(entryId)}`, { method: 'DELETE' });
    const body = await r.json().catch(() => ({ ok: false, error: 'invalid orchestrator response' }));
    return res.status(r.status).json(body);
  } catch (err) {
    return res.status(502).json({ ok: false, error: `orchestrator unreachable: ${err.message}` });
  }
});

// ── Pending-queue reassignment (#2102) ─────────────────────────────────────
//
// Hand a waiting entry to a different agent instead of only cancelling it.
//
//  - GET  /api/agents/:id/pending/:entryId/reassign-targets → eligible targets
//  - POST /api/agents/:id/pending/:entryId/reassign          → move it
//
// UNLIKE the three read/cancel routes above, these are AUTHORIZED. A
// reassignment injects work into another agent's queue — operator-initiated
// trigger firing at a distance — and #2041 §7/D9 already decided that manually
// firing a trigger is Team-Admin-only, on the reasoning that an autonomous run
// is not attributable to a person the way a chat message is. So the capability
// does not ship ungated, even though its read/cancel neighbours currently are.
//
// The gate runs on BOTH agents (AC5): managing the source is the right to take
// the entry away, managing the target is the right to make it run something.
// Holding one is not holding the other.
//
// The pre-existing absence of authorization on `GET /api/pending-queue` and the
// cancel route is real and out of scope here — it belongs to the #2041 P2
// enforcement sweep, which owns the ungated-route inventory. FLAGGED FOR THE P2
// OWNER: any signed-in user can currently read every agent's queue and cancel
// any entry in it.
function resolveManageableAgentDir(req, res, id) {
  if (!AGENT_ID_RE.test(id)) {
    res.status(400).json({ ok: false, error: 'Invalid agent id' });
    return null;
  }
  const agentsBaseDir = path.resolve(AGENTS_DIR);
  const agentDir = path.resolve(agentsBaseDir, id);
  const rel = path.relative(agentsBaseDir, agentDir);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    res.status(400).json({ ok: false, error: 'Invalid agent id' });
    return null;
  }
  if (!fs.existsSync(agentDir)) {
    res.status(404).json({ ok: false, error: 'Agent not found' });
    return null;
  }
  if (denyUnlessCanManageAgent(req, res, agentDir)) return null;
  return agentDir;
}

app.get('/api/agents/:id/pending/:entryId/reassign-targets', async (req, res) => {
  const { id, entryId } = req.params;
  if (!PENDING_ENTRY_ID_RE.test(entryId)) {
    return res.status(400).json({ ok: false, error: 'Invalid entry id' });
  }
  // Listing the agents that could take this entry is already a step toward
  // firing one, so it carries the source-side gate too.
  if (!resolveManageableAgentDir(req, res, id)) return;
  const orchestratorUrl = process.env.ORCHESTRATOR_URL || 'http://orchestrator:4002';
  try {
    const r = await fetch(`${orchestratorUrl}/internal/agents/${encodeURIComponent(id)}/pending/${encodeURIComponent(entryId)}/reassign-targets`);
    const body = await r.json().catch(() => ({ ok: false, error: 'invalid orchestrator response' }));
    // A target the caller may not manage must not be offered, or the picker
    // would list an option the POST below refuses (AC5).
    if (body && Array.isArray(body.targets)) {
      const scope = getScope(req);
      body.targets = body.targets.filter((t) => canManageAgent(
        scope, agentMetaForScope(readJsonFile(path.join(AGENTS_DIR, t.agentId, 'config.json'), null) || {})));
    }
    return res.status(r.status).json(body);
  } catch (err) {
    return res.status(502).json({ ok: false, error: `orchestrator unreachable: ${err.message}` });
  }
});

app.post('/api/agents/:id/pending/:entryId/reassign', async (req, res) => {
  const { id, entryId } = req.params;
  const targetAgentId = req.body && req.body.targetAgentId;
  if (!PENDING_ENTRY_ID_RE.test(entryId)) {
    return res.status(400).json({ ok: false, error: 'Invalid entry id' });
  }
  if (typeof targetAgentId !== 'string' || !AGENT_ID_RE.test(targetAgentId)) {
    return res.status(400).json({ ok: false, error: 'Invalid target agent id' });
  }
  if (!resolveManageableAgentDir(req, res, id)) return;
  if (!resolveManageableAgentDir(req, res, targetAgentId)) return;
  const orchestratorUrl = process.env.ORCHESTRATOR_URL || 'http://orchestrator:4002';
  try {
    const r = await fetch(`${orchestratorUrl}/internal/agents/${encodeURIComponent(id)}/pending/${encodeURIComponent(entryId)}/reassign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // The acting human is stamped SERVER-SIDE from the session — a body-supplied
      // actor would be self-asserted, and this value ends up in the audit trail.
      body: JSON.stringify({ targetAgentId, byUserId: (req.user && (req.user.sub || req.user.id)) || null }),
    });
    const body = await r.json().catch(() => ({ ok: false, error: 'invalid orchestrator response' }));
    return res.status(r.status).json(body);
  } catch (err) {
    return res.status(502).json({ ok: false, error: `orchestrator unreachable: ${err.message}` });
  }
});

// Token-usage statistics (#654, §5 view 1 of docs/cost-per-pr-concept.md).
// Reads the day-bucketed usage records the orchestrator ingested and runs the
// pure aggregator. Tokens only — dollar figures are never surfaced (AC4).
//
// System-Admin-only for now (#801): every usage endpoint rejects a non-System-
// Admin caller with 403 via requireUsageAdmin — this is the real security
// boundary; the SPA route/nav gate is UX only. The System Admin narrows to a
// single team with `?team=<id>`. Protected by the auth gate above.

// The optional `?team=<id>` narrowing (#801 AC4). A blank/absent param means
// "all teams" (the full, unfiltered picture).
function usageTeamParam(req) {
  return typeof req.query.team === 'string' && req.query.team ? req.query.team : null;
}

// Narrow usage records by the caller's scope (defensive — a System Admin is
// `scope.all`, so this is a no-op for them) and the optional team filter (#801).
// Under "all teams" (no `team`) a System Admin sees every record, including
// legacy records with no `teamId`; under a specific team filter a record only
// matches when its `teamId` equals that team, so team-less legacy records are
// (correctly) excluded from a single-team view — they belong to no team.
function narrowUsageRecords(records, scope, team) {
  if (scope.all && !team) return records;
  return records.filter((r) => {
    const t = r && r.teamId;
    if (!scope.all && !visibleTeam(scope, t)) return false;
    if (team && t !== team) return false;
    return true;
  });
}

// Gate: usage statistics are System-Admin-only (#801). Returns the caller's
// scope when allowed, else sends 403 and returns null (caller must bail out).
function requireUsageAdmin(req, res) {
  const scope = getScope(req);
  if (!canViewUsageStatistics(scope)) {
    res.status(403).json({ error: 'System-Admin access required', code: 'forbidden' });
    return null;
  }
  return scope;
}

app.get('/api/usage/summary', (req, res) => {
  const scope = requireUsageAdmin(req, res);
  if (!scope) return;
  const { since, until } = req.query;
  const groupBy = req.query.groupBy;
  let records = usageLog.readRecords({ since });
  records = narrowUsageRecords(records, scope, usageTeamParam(req));
  res.json(summarize(records, { since, until, groupBy }));
});

// Flat export of the statistics view (#656 phase 3): one row per invocation ×
// model, CSV or JSON, so FinOps / the customer can apply their own contract
// prices downstream. Read-side add-on over the same scoped records — tokens
// only, four classes as separate columns. `format` = csv (default) | json.
function sendExport(req, res, kind, records, prEvents) {
  const { since, until } = req.query;
  const format = req.query.format === 'json' ? 'json' : 'csv';
  const out = usageExport.serialize(kind, format, { records, prEvents, since: since || null, until: until || null });
  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', out.contentType);
  res.setHeader('Content-Disposition', `attachment; filename="token-usage-${kind}-${stamp}.${out.ext}"`);
  res.send(out.body);
}

app.get('/api/usage/summary/export', (req, res) => {
  const scope = requireUsageAdmin(req, res);
  if (!scope) return;
  let records = usageLog.readRecords({ since: req.query.since });
  records = narrowUsageRecords(records, scope, usageTeamParam(req));
  sendExport(req, res, 'summary', records, null);
});

// Work-item attribution (#655, §5 view 2 of docs/cost-per-pr-concept.md).
// Groups token usage by the issue↔PR chain a run belongs to (a connected
// component of the artifact graph), reporting per-role cost and the always-visible
// unattributed remainder. Tokens only. Team-scoped like the summary above: usage
// records outside the caller's memberships (or the optional `team` narrowing) are
// dropped BEFORE attribution, so a work item with no in-scope runs never surfaces.
// pr-link records are read unfiltered — they only supply the graph edges; output
// is gated on in-scope runs > 0, so no cross-team artifact leaks.
function scopedUsageRecords(req, scope) {
  const { since } = req.query;
  const records = usageLog.readRecords({ since });
  return narrowUsageRecords(records, scope, usageTeamParam(req));
}

app.get('/api/usage/work-items', (req, res) => {
  const scope = requireUsageAdmin(req, res);
  if (!scope) return;
  const { since, until } = req.query;
  const records = scopedUsageRecords(req, scope);
  const prEvents = prEventsLog.readRecords();
  res.json(buildWorkItems(records, prEvents, { since, until }));
});

// Flat export of the work-item view (#656 phase 3): one row per work-item ×
// model plus the always-visible unattributed remainder row; each row carries
// the attribution-tier context so downstream numbers stay honest. Team-scoped
// exactly like the list route. `format` = csv (default) | json.
app.get('/api/usage/work-items/export', (req, res) => {
  const scope = requireUsageAdmin(req, res);
  if (!scope) return;
  const records = scopedUsageRecords(req, scope);
  const prEvents = prEventsLog.readRecords();
  sendExport(req, res, 'work-items', records, prEvents);
});

// Drill-down addressed by ANY artifact in the chain. `repo` is owner/name, so it
// arrives as two path segments reassembled here.
app.get('/api/usage/work-items/:owner/:repo/:number', (req, res) => {
  const scope = requireUsageAdmin(req, res);
  if (!scope) return;
  const { since, until } = req.query;
  const repo = `${req.params.owner}/${req.params.repo}`;
  const number = Number(req.params.number);
  if (!Number.isInteger(number) || number <= 0) {
    return res.status(400).json({ error: 'invalid artifact number' });
  }
  const records = scopedUsageRecords(req, scope);
  const prEvents = prEventsLog.readRecords();
  const detail = workItemDetail(records, prEvents, repo, number, { since, until });
  if (!detail) return res.status(404).json({ error: 'work item not found' });
  res.json(detail);
});

const MCP_SERVER_ID_RE = /^[a-z0-9-]+$/;
const MCP_CREDENTIAL_ID_RE = /^[a-z0-9-]+$/;

/* ─── Helpers ───────────────────────────────────────────────────────── */

// writeJsonAtomic and readJsonFile only ever receive paths under WORKSPACE
// (or POOL_DIR / CONTROL_DIR for skill/control files). Callers should have
// already validated their user-supplied id segments via AGENT_ID_RE etc., so
// the containment below only fires on a programming bug — it is defense in
// depth. Both funnel the sink-bound path through containPathUnderRoot(), whose
// path.relative(root, resolved) + reject-'..'/absolute check is the canonical
// CodeQL js/path-injection barrier on the RETURNED value (the same idiom as
// safeAgentPath / safeGlobalSkillDir). Multiple roots compose with `||`, so the
// value the fs sink consumes always flowed through a single-root barrier.
// NOTE: an inline nested per-root disjunction that guards `resolved` but then
// feeds the pre-guard `resolved` straight to the sink is NOT CodeQL-legible
// (the barrier must gate the exact value the sink consumes) — routing through
// this helper's return value is what clears the alerts.

// Return `resolved` unchanged if it is contained under `root`, else null. The
// path.relative + reject-'..'/absolute guard on the returned value is the
// CodeQL-recognised path-injection barrier; callers OR several roots together.
function containPathUnderRoot(resolved, root) {
  const base = path.resolve(root);
  const rel = path.relative(base, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return resolved;
}

function writeJsonAtomic(filePath, data) {
  if (typeof filePath !== 'string') {
    throw new Error('writeJsonAtomic: refusing non-string path');
  }
  const resolved = path.resolve(filePath);
  const safe = containPathUnderRoot(resolved, WORKSPACE)
    || containPathUnderRoot(resolved, POOL_DIR);
  if (safe === null) {
    throw new Error(`writeJsonAtomic: refusing path outside allowed roots: ${filePath}`);
  }
  const tmp = safe + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, safe);
}

function podmanRequest(method, urlPath) {
  return new Promise((resolve, reject) => {
    const opts = { socketPath: PODMAN_SOCK, path: `/v4.0.0/libpod${urlPath}`, method };
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function readJsonFile(filePath, fallback = null) {
  if (typeof filePath !== 'string') return fallback;
  // Confine reads under an allowed root before the value reaches readFileSync.
  // Same containPathUnderRoot() return-value barrier as writeJsonAtomic; reads
  // in this stack are always built from trusted constants joined with id
  // segments the route handlers validate — this is defense in depth.
  const resolved = path.resolve(filePath);
  const safe = containPathUnderRoot(resolved, WORKSPACE)
    || containPathUnderRoot(resolved, POOL_DIR)
    || containPathUnderRoot(resolved, CONTROL_DIR);
  if (safe === null) return fallback;
  try {
    return JSON.parse(fs.readFileSync(safe, 'utf8'));
  } catch {
    return fallback;
  }
}

// Resolve the owning (human) Team for a newly created resource (#299). An
// explicit id must reference an existing team; absence falls back to the
// default team. Throws a 400-tagged error for an unknown team.
function resolveOwnerTeamId(teamId) {
  if (!teamId) return DEFAULT_TEAM_ID;
  const teams = readJsonFile(TEAMS_INDEX, []);
  if (!Array.isArray(teams) || !teams.some(t => t.id === teamId)) {
    const err = new Error(`Owning team '${teamId}' not found`);
    err.status = 400;
    throw err;
  }
  return teamId;
}

// Resolve the requested ownership of a credential from a create/reassign body
// (#798). A `system` scope carries an `assignedTeamIds` set (0..n existing
// teams); any other value is a `team` scope owned by exactly one team. Throws a
// 400-tagged error for an unknown team. Returns the canonical persisted shape.
//
// Personal tier (#1567/epic #1558): a `personal` credential is owned by exactly
// one human. The owner is ALWAYS the authenticated caller (`actingUserId`) — a
// body that omits it is filled in, a body that names a DIFFERENT owner is
// rejected 403 (an agent/human may never register a credential under a foreign
// identity, edge case + AC2). The owner is validated against a known user record.
function resolveCredentialOwnership(body, actingUserId) {
  const b = body || {};
  if (b.scope === 'personal') {
    if (!actingUserId) {
      const err = new Error('A personal credential requires an authenticated user'); err.status = 403; throw err;
    }
    if (b.userId != null && String(b.userId) !== String(actingUserId)) {
      const err = new Error('A personal credential can only be owned by yourself'); err.status = 403; throw err;
    }
    const users = readJsonFile(USERS_INDEX, []);
    if (!Array.isArray(users) || !users.some(u => u.id === actingUserId)) {
      const err = new Error(`Owner '${actingUserId}' is not a known user`); err.status = 400; throw err;
    }
    return { scope: 'personal', userId: String(actingUserId), teamId: null, assignedTeamIds: [] };
  }
  const reqScope = b.scope === 'system' ? 'system' : 'team';
  if (reqScope === 'system') {
    const raw = Array.isArray(b.assignedTeamIds) ? b.assignedTeamIds : [];
    const ids = [...new Set(raw.map(String))];
    if (ids.length) {
      const teams = readJsonFile(TEAMS_INDEX, []);
      for (const id of ids) {
        if (!Array.isArray(teams) || !teams.some(t => t.id === id)) {
          const err = new Error(`Assigned team '${id}' not found`);
          err.status = 400;
          throw err;
        }
      }
    }
    return { scope: 'system', teamId: null, assignedTeamIds: ids };
  }
  const teamId = resolveOwnerTeamId(b.teamId);
  return { scope: 'team', teamId, assignedTeamIds: [] };
}

// Resolve the requested ownership of a TIERED CONFIGURATION resource — a
// working environment or an MCP server (#2083, epic #2076 P5).
//
// Deliberately a thin named wrapper over `resolveCredentialOwnership` rather
// than a second validator: the tier shape is shared (resource-tier.js), so the
// question "does this team exist, and are these assignments real" must have one
// answer. What the wrapper adds is the ONE difference, and it is a refusal.
//
// THE PERSONAL TIER IS NOT OFFERED HERE, and this is a deliberate deviation from
// issue #2083's AC1 ("a working environment can be created as shared/system,
// team, or personal"). The design of record's own tier table (§5.1) asks only
// for the shared tier for environments and MCP servers, and its before/after
// example (§5.2) shows only `team` and `system` — AC1's third value is the one
// clause of the ticket that contradicts §5.1, and the code says why §5.1 is
// right: the personal tier's defining property is that it has NO `scope.all`
// bypass (#1567 D2), because a personal SECRET must be private even from the
// operator. An environment is not a secret, it is infrastructure that agents
// run on — a personal one would be an environment a System Admin can neither
// read, repair nor delete, which also makes the "Used by <env>" refusal on a
// credential delete unresolvable by anyone. The predicates in scope.js still
// handle the personal tier (so the shape stays uniform, a hand-edited record
// fails closed to its owner, and a later ticket that wants personal
// environments only has to open this door), but nothing can create one.
function resolveTieredOwnership(body) {
  const b = body || {};
  if (b.scope === 'personal') {
    const err = new Error('A working environment or MCP server cannot be personal — use the team or shared tier');
    err.status = 400;
    throw err;
  }
  // No `actingUserId`: without it `resolveCredentialOwnership` refuses a
  // personal request anyway, so the explicit 400 above is the message and this
  // is the backstop.
  return resolveCredentialOwnership(b);
}

// Apply a rename/reassign patch to a credential entry (#798), enforcing the
// role model. The caller has already been checked with `canManageCredential`.
// Returns the updated entry, or null after sending the appropriate error
// response (403 for a reassignment by a non-System-Admin, 400 for an unknown
// team, 409 when the move would orphan a referencing environment).
function applyCredentialPatch({ res, cred, scope, body, inUse, label }) {
  const b = body || {};
  const cur = normalizeCredential(cred);
  const reassigning = ('scope' in b) || ('teamId' in b) || ('assignedTeamIds' in b);

  // Personal-tier ownership is immutable (#1567 edge case / AC6): a personal
  // credential cannot be reassigned into a team/system tier (and vice versa) —
  // that would move a private secret out of one human's sole control. Renaming a
  // personal credential is still allowed (`name`-only patch → not `reassigning`);
  // to change ownership, create a new credential instead.
  if (reassigning && (cur.scope === 'personal' || b.scope === 'personal')) {
    res.status(400).json({
      error: `A personal ${label} cannot be reassigned to or from a team/system tier; create a new credential instead.`,
      code: 'personal-reassign-unsupported',
    });
    return null;
  }

  let next = { scope: cur.scope, teamId: cur.teamId, assignedTeamIds: cur.assignedTeamIds };
  if (reassigning) {
    if (!canReassignCredential(scope)) {
      res.status(403).json({ error: `forbidden: only a System Admin may reassign a ${label}`, code: 'forbidden' });
      return null;
    }
    try {
      next = resolveCredentialOwnership({
        scope: 'scope' in b ? b.scope : cur.scope,
        teamId: b.teamId,
        assignedTeamIds: b.assignedTeamIds,
      });
    } catch (err) {
      res.status(err.status || 400).json({ error: err.message });
      return null;
    }
    // Do not silently orphan an environment that still references this credential.
    if (inUse) {
      const env = loadEnvironment(inUse);
      const envTeam = (env && env.teamId) || 'default';
      const candidate = { ...cred, scope: next.scope, teamId: next.teamId, assignedTeamIds: next.assignedTeamIds };
      if (!credentialVisibleToTeam(candidate, envTeam)) {
        res.status(409).json({
          error: `${label} is used by environment '${inUse}' (team '${envTeam}'); reassignment would orphan it. Detach it first.`,
        });
        return null;
      }
    }
  }

  const name = (typeof b.name === 'string' && b.name.trim()) ? b.name.trim() : cred.name;
  return {
    ...cred,
    name,
    scope: next.scope,
    teamId: next.teamId,
    assignedTeamIds: next.assignedTeamIds,
  };
}

// Resolve what the logged-in caller may see (#302). Reads the users/memberships
// indexes fresh each call (cheap; small JSON). A System Admin gets
// `all: true` — so a single-administrator stack is entirely unaffected.
function getScope(req) {
  const username = req && req.user && req.user.username;
  return computeScope({
    username,
    users: readJsonFile(USERS_INDEX, []),
    memberships: readJsonFile(MEMBERSHIPS_INDEX, []),
    authEnabled: AUTH_ENABLED,
  });
}

// The author stamp for a chat message posted by this request (#2065). Both
// halves come from the authenticated session — the user-store record id and the
// login subject — never from the request body.
function chatAuthorFor(req) {
  return chatAuthorStamp({
    userId: getScope(req).userId,
    username: req && req.user && req.user.username,
  });
}

// The acting human's own Matrix credential for this request (#2173), or
// `null` when there is none to send as — no user record behind the session
// (the env single-admin), or a record whose Matrix identity has not finished
// provisioning yet (#1458 provisioning is best-effort/backgrounded). Either
// way the caller falls back to the shared admin token rather than failing
// the send.
function humanMatrixIdentityFor(req) {
  const userId = getScope(req).userId;
  if (!userId) return null;
  const identity = humanMatrixStore.readIdentity(userId);
  return identity && identity.accessToken && identity.matrixUserId ? identity : null;
}

// Make sure the acting human is actually a member of the room before they
// send as themselves — the DM room is created with the shared admin invited
// (see ensureAgentDmRoom), not with any individual human's account, so a
// human sending here for the first time has to be invited and joined. Both
// steps are best-effort and idempotent (an already-invited/joined account
// just gets a non-2xx we ignore); a genuine failure to join surfaces at the
// send call itself rather than here.
async function ensureHumanJoinedToRoom(identity, roomId) {
  try {
    await matrix.matrixFetch(matrix.ADMIN_TOKEN,
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/invite`,
      { method: 'POST', body: { user_id: identity.matrixUserId } });
  } catch { /* already invited/joined, or admin token unavailable — join below still tries */ }
  try {
    await matrix.matrixFetch(identity.accessToken,
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/join`,
      { method: 'POST', body: {} });
  } catch { /* already joined */ }
}

// The `{ ownerId, ownerSource }` stamp a create request carries to the
// orchestrator (#2077, concept D8/§3.4/§3.5). The owner is the authenticated
// caller's user-record id, resolved HERE from the session — `POST
// /internal/agents` is unauthenticated, so an owner accepted from a request
// body would be self-asserted and worthless.
//
// Returns an EMPTY object when there is no user record to point at, which is
// the env single-admin case (`computeScope` gives it `userId: null`). Spreading
// `{}` leaves the key absent rather than writing `ownerId: null`, so an agent
// created by the operator is indistinguishable from a pre-#2077 one and takes
// the same shared-credential path — an explicit null would be a third state
// nothing reads.
function ownerFor(req) {
  const userId = getScope(req).userId;
  return userId ? { ownerId: String(userId), ownerSource: 'creator' } : {};
}

function listAgentDirs() {
  try {
    return fs.readdirSync(AGENTS_DIR).filter(name => {
      const p = path.join(AGENTS_DIR, name);
      return fs.statSync(p).isDirectory() && fs.existsSync(path.join(p, 'config.json'));
    });
  } catch {
    return [];
  }
}

function listEnvironmentIds() {
  try {
    return fs.readdirSync(ENVIRONMENTS_DIR).filter(name => {
      if (name.startsWith('_')) return false;
      const p = path.join(ENVIRONMENTS_DIR, name);
      return fs.statSync(p).isDirectory() && fs.existsSync(path.join(p, 'environment.json'));
    });
  } catch {
    return [];
  }
}

function loadEnvironment(envId) {
  const p = path.join(ENVIRONMENTS_DIR, envId, 'environment.json');
  const raw = readJsonFile(p, null);
  return normalizeEnvironmentRepositories(raw);
}

// Migrate legacy single-repo `repository` into `repositories: [...]` on read so
// every consumer can rely on the array shape. The legacy field is kept on the
// returned object only if it's still present on disk; saves drop it.
function normalizeEnvironmentRepositories(env) {
  if (!env) return env;
  if (Array.isArray(env.repositories)) return env;
  if (env.repository && env.repository.url) {
    return { ...env, repositories: [env.repository] };
  }
  return { ...env, repositories: [] };
}

function saveEnvironment(envId, data) {
  // path.basename strips any separator — the explicit call is what CodeQL
  // recognises as a path-injection sanitizer for the env-id path segment.
  const dir = path.join(ENVIRONMENTS_DIR, path.basename(String(envId)));
  fs.mkdirSync(dir, { recursive: true });
  writeJsonAtomic(path.join(dir, 'environment.json'), data);
}

function listSshKeys() {
  return readJsonFile(SSH_KEYS_INDEX, []);
}

function saveSshKeysIndex(keys) {
  writeJsonAtomic(SSH_KEYS_INDEX, keys);
}

// Extract the SSH "public key blob" (length-prefixed wire form) from an
// OpenSSH-format private-key PEM. Returns null for any other PEM format
// (PKCS1, PKCS8, ...). Algorithm-agnostic: the caller doesn't need to know
// whether the key is ed25519, rsa, ecdsa — the blob is the first key entry.
function extractOpensshPubBlob(pem) {
  // Linear indexOf/slice instead of a regex: a lazy `[\s\S]*?` between two
  // literals backtracks polynomially when the END marker is absent
  // (CodeQL js/polynomial-redos). indexOf scanning is O(n) and avoids it.
  const s = String(pem || '');
  const BEGIN = '-----BEGIN OPENSSH PRIVATE KEY-----';
  const END = '-----END OPENSSH PRIVATE KEY-----';
  const start = s.indexOf(BEGIN);
  if (start === -1) return null;
  const bodyStart = start + BEGIN.length;
  const end = s.indexOf(END, bodyStart);
  if (end === -1) return null;
  let buf;
  try { buf = Buffer.from(s.slice(bodyStart, end).replace(/\s+/g, ''), 'base64'); } catch { return null; }
  const magic = Buffer.from('openssh-key-v1\0', 'utf8');
  if (buf.length < magic.length || !buf.subarray(0, magic.length).equals(magic)) return null;
  let off = magic.length;
  const readSshString = () => {
    if (off + 4 > buf.length) throw new Error('truncated');
    const len = buf.readUInt32BE(off); off += 4;
    if (off + len > buf.length) throw new Error('truncated');
    const out = buf.subarray(off, off + len);
    off += len;
    return out;
  };
  try {
    readSshString(); readSshString(); readSshString();   // ciphername, kdfname, kdfoptions
    if (off + 4 > buf.length) return null;
    const numKeys = buf.readUInt32BE(off); off += 4;
    if (numKeys < 1) return null;
    return readSshString();   // first public key blob
  } catch { return null; }
}

function sshFingerprintFromPubBlob(pubBlob) {
  return 'SHA256:' + crypto.createHash('sha256').update(pubBlob).digest('base64').replace(/=+$/, '');
}

// Standard SSH fingerprint = SHA256 of the public-key wire blob, displayed
// in base64 without padding. Matches what `ssh-keygen -lf` and GitHub show.
// For non-OpenSSH PEMs (rare for SSH today) we fall back to a hash over the
// raw PEM so the listing still has a stable identifier.
function sshKeyFingerprint(privateKey) {
  const blob = extractOpensshPubBlob(privateKey);
  if (blob) return sshFingerprintFromPubBlob(blob);
  return 'SHA256:' + crypto.createHash('sha256').update(privateKey).digest('base64').replace(/=+$/, '');
}

// Generate an unencrypted ed25519 keypair in OpenSSH wire format. Returns
// the PEM-armored OPENSSH PRIVATE KEY together with the matching public key
// in `authorized_keys` form (`ssh-ed25519 <base64> <comment>`). No external
// `ssh-keygen` binary is required — Node's crypto produces the raw 32-byte
// seed/pubkey via PKCS8/SPKI DER, and we frame them per OpenSSH's PROTOCOL.key.
function generateOpensshEd25519Keypair(comment) {
  const c = String(comment || '').replace(/[\r\n]/g, ' ').trim() || 'aee-deploy-key';
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  // Last 32 bytes of the SPKI DER encoding are the raw ed25519 public key.
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  const pub = spki.subarray(spki.length - 32);
  // Last 32 bytes of the PKCS8 DER encoding are the raw ed25519 seed.
  const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' });
  const seed = pkcs8.subarray(pkcs8.length - 32);
  // OpenSSH stores the ed25519 secret as seed||publicKey (64 bytes total).
  const sk = Buffer.concat([seed, pub]);

  const sshString = (s) => {
    const b = Buffer.isBuffer(s) ? s : Buffer.from(s, 'utf8');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(b.length, 0);
    return Buffer.concat([len, b]);
  };

  const pubBlob = Buffer.concat([sshString('ssh-ed25519'), sshString(pub)]);

  const checkint = crypto.randomBytes(4);
  let privSection = Buffer.concat([
    checkint, checkint,
    sshString('ssh-ed25519'),
    sshString(pub),
    sshString(sk),
    sshString(c),
  ]);
  // Pad to a multiple of 8 (cipher block size for ciphername "none"),
  // appending 1, 2, 3, ... so a parser can verify the trailer.
  const pad = [];
  for (let i = 1; (privSection.length + pad.length) % 8 !== 0; i++) pad.push(i);
  privSection = Buffer.concat([privSection, Buffer.from(pad)]);

  const numKeys = Buffer.alloc(4);
  numKeys.writeUInt32BE(1, 0);
  const outer = Buffer.concat([
    Buffer.from('openssh-key-v1\0', 'utf8'),
    sshString('none'),
    sshString('none'),
    sshString(''),
    numKeys,
    sshString(pubBlob),
    sshString(privSection),
  ]);

  const wrapped = outer.toString('base64').match(/.{1,70}/g).join('\n');
  const privatePem =
    '-----BEGIN OPENSSH PRIVATE KEY-----\n' +
    wrapped + '\n' +
    '-----END OPENSSH PRIVATE KEY-----\n';
  const publicSsh = `ssh-ed25519 ${pubBlob.toString('base64')} ${c}`;

  return { privateKey: privatePem, publicKey: publicSsh, pubBlob };
}

function environmentInUse(envId) {
  for (const id of listAgentDirs()) {
    const cfg = readJsonFile(path.join(AGENTS_DIR, id, 'config.json'), {});
    if (cfg.environmentId === envId) return id;
  }
  return null;
}

// All agents referencing this environment, scoped to what the caller may see
// (same team/visibility rules as GET /api/agents — #302, #439).
function agentsUsingEnvironment(envId, scope) {
  const agents = [];
  for (const id of listAgentDirs()) {
    const cfg = readJsonFile(path.join(AGENTS_DIR, id, 'config.json'), {});
    if (cfg.environmentId === envId && visibleAgent(scope, agentMetaForScope(cfg))) {
      agents.push({ id, displayName: cfg.displayName || id });
    }
  }
  return agents;
}

function sshKeyInUse(keyId) {
  for (const envId of listEnvironmentIds()) {
    const env = loadEnvironment(envId);
    const repos = Array.isArray(env?.repositories) ? env.repositories : [];
    if (repos.some(r => r?.sshKeyId === keyId)) return envId;
  }
  return null;
}

/* ─── GitHub Tokens ─────────────────────────────────────────────────── */

function listGithubTokens() {
  return readJsonFile(GH_TOKENS_INDEX, []);
}

function saveGithubTokensIndex(tokens) {
  writeJsonAtomic(GH_TOKENS_INDEX, tokens);
}

function githubTokenFingerprint(token) {
  return 'SHA256:' + crypto.createHash('sha256').update(token).digest('base64').replace(/=+$/, '').slice(0, 16);
}

// Return only a non-sensitive preview (prefix + last 4 chars).
// E.g. "github_pat_…ABCD" or "ghp_…ABCD".
function githubTokenPreview(token) {
  const m = token.match(/^(github_pat_|ghp_|gho_|ghs_|ghu_|ghr_)?(.*)$/);
  const prefix = (m && m[1]) || '';
  const tail = token.slice(-4);
  return `${prefix}…${tail}`;
}

function githubTokenInUse(tokenId) {
  for (const envId of listEnvironmentIds()) {
    const env = loadEnvironment(envId);
    if (env?.githubTokenId === tokenId) return envId;
  }
  return null;
}

/* ─── MCP servers + credentials (helpers) ───────────────────────────── */

function listMcpServerIds() {
  try {
    return fs.readdirSync(MCP_SERVERS_DIR).filter(name => {
      if (name.startsWith('_') || name.startsWith('.')) return false;
      const p = path.join(MCP_SERVERS_DIR, name);
      return fs.statSync(p).isDirectory() && fs.existsSync(path.join(p, 'server.json'));
    });
  } catch {
    return [];
  }
}

function loadMcpServer(serverId) {
  if (!MCP_SERVER_ID_RE.test(serverId)) return null;
  return readJsonFile(path.join(MCP_SERVERS_DIR, serverId, 'server.json'), null);
}

function saveMcpServer(serverId, data) {
  // Path-injection containment (#207): callers validate serverId with
  // MCP_SERVER_ID_RE, but CodeQL does not model a regex.test() early-return as
  // a sanitiser, so re-confine the resolved dir under MCP_SERVERS_DIR here (the
  // fs sink lives in this helper). Never trips for a regex-valid id.
  const base = path.resolve(MCP_SERVERS_DIR);
  const dir = path.resolve(base, serverId);
  const rel = path.relative(base, dir);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Invalid MCP server id');
  fs.mkdirSync(dir, { recursive: true });
  writeJsonAtomic(path.join(dir, 'server.json'), data);
}

function mcpServerInUse(serverId) {
  // Returns the first environment id that references this server, or null.
  for (const envId of listEnvironmentIds()) {
    const env = loadEnvironment(envId);
    const refs = Array.isArray(env?.mcpServers) ? env.mcpServers : [];
    if (refs.some(r => r?.serverId === serverId)) return envId;
  }
  return null;
}

function listMcpCredentials() {
  return readJsonFile(MCP_CREDENTIALS_INDEX, []);
}

function saveMcpCredentialsIndex(list) {
  writeJsonAtomic(MCP_CREDENTIALS_INDEX, list);
}

function mcpCredentialFingerprint(secret) {
  return 'SHA256:' + crypto.createHash('sha256').update(String(secret)).digest('base64').replace(/=+$/, '').slice(0, 16);
}

function mcpCredentialInUse(credId) {
  for (const envId of listEnvironmentIds()) {
    const env = loadEnvironment(envId);
    const refs = Array.isArray(env?.mcpServers) ? env.mcpServers : [];
    if (refs.some(r => r?.credentialId === credId)) return envId;
  }
  return null;
}

/* ─── LLM Endpoints (helpers) ───────────────────────────────────────── */

function listLlmEndpoints() {
  return readJsonFile(LLM_ENDPOINTS_INDEX, []);
}

function saveLlmEndpointsIndex(list) {
  writeJsonAtomic(LLM_ENDPOINTS_INDEX, list);
}

// ─── Model Provider health (#1843) ──────────────────────────────────────────
// A background poller (startLlmHealthPoller, kicked off in app.listen) probes
// every configured provider on an interval and persists the last-known status
// per endpoint in health.json. probeLlmEndpointTest / readLlmEndpointToken are
// hoisted function declarations defined later in this file — safe to call here.

function loadLlmHealthMap() {
  const map = readJsonFile(LLM_HEALTH_INDEX, {});
  return map && typeof map === 'object' && !Array.isArray(map) ? map : {};
}

function saveLlmHealthMap(map) {
  writeJsonAtomic(LLM_HEALTH_INDEX, map);
}

// Cadence + stale thresholds, all env-configurable (AC1 "~5 min default,
// configurable"; AC5 stale window).
function llmHealthConfig() {
  return {
    intervalMs: llmHealth.coerceMs(process.env.AEE_LLM_HEALTH_INTERVAL_MS, llmHealth.DEFAULT_INTERVAL_MS),
    baseMs: llmHealth.coerceMs(process.env.AEE_LLM_HEALTH_BACKOFF_BASE_MS, llmHealth.DEFAULT_BACKOFF_BASE_MS),
    maxMs: llmHealth.coerceMs(process.env.AEE_LLM_HEALTH_BACKOFF_MAX_MS, llmHealth.DEFAULT_BACKOFF_MAX_MS),
    staleMs: llmHealth.coerceMs(process.env.AEE_LLM_HEALTH_STALE_MS, llmHealth.DEFAULT_STALE_MS),
  };
}

// The client-facing health view for one endpoint id (AC3/AC6). No record →
// { status: 'unknown' }.
function llmHealthViewFor(id, map = loadLlmHealthMap()) {
  return llmHealth.healthView(map[id]);
}

// Guard against two overlapping probes of the same endpoint (the poller and an
// on-demand save/selection probe can both target one id).
const llmHealthInFlight = new Set();

// Probe one endpoint and persist the folded health record. Best-effort: never
// throws (probeLlmEndpointTest always resolves within its 8s timeout). Re-reads
// the health map immediately before writing so a concurrent probe's result is
// not clobbered.
async function probeAndRecordHealth(ep) {
  if (!ep || !ep.id || llmHealthInFlight.has(ep.id)) return null;
  llmHealthInFlight.add(ep.id);
  try {
    const token = readLlmEndpointToken(ep.authTokenId);
    const probe = await probeLlmEndpointTest(ep.baseUrl, token, ep.authType);
    const map = loadLlmHealthMap();
    map[ep.id] = llmHealth.applyProbeResult(map[ep.id], probe);
    saveLlmHealthMap(map);
    return map[ep.id];
  } catch (err) {
    console.error(`[LLM-Health] Probe of ${ep.id} failed unexpectedly: ${err.message}`);
    return null;
  } finally {
    llmHealthInFlight.delete(ep.id);
  }
}

// Fire a background probe for an endpoint whose last-known status is stale
// (AC5). Non-blocking — callers (e.g. GET model-options on agent selection)
// don't await it; the next read picks up the refreshed status.
function refreshHealthIfStale(ep) {
  if (!ep || !ep.id) return;
  const cfg = llmHealthConfig();
  const rec = loadLlmHealthMap()[ep.id];
  if (llmHealth.isStale(rec, Date.now(), cfg.staleMs)) {
    probeAndRecordHealth(ep).catch(() => {});
  }
}

// One poller pass: probe every provider whose status is due (interval for a
// healthy one, exponential backoff for a failing one). Sequential so we never
// fan a burst of outbound requests at once. Overlap-guarded.
let llmHealthPassBusy = false;
async function runLlmHealthPass() {
  if (llmHealthPassBusy) return;
  llmHealthPassBusy = true;
  try {
    const endpoints = listLlmEndpoints();
    if (!endpoints.length) return;
    const cfg = llmHealthConfig();
    const dueIds = new Set(llmHealth.selectDueEndpointIds(endpoints, loadLlmHealthMap(), Date.now(), cfg));
    for (const ep of endpoints) {
      if (dueIds.has(ep.id)) await probeAndRecordHealth(ep);
    }
  } catch (err) {
    console.error(`[LLM-Health] Poll pass error: ${err.message}`);
  } finally {
    llmHealthPassBusy = false;
  }
}

let llmHealthTimer = null;
function startLlmHealthPoller() {
  if (llmHealthTimer) return;
  const cfg = llmHealthConfig();
  // Tick granularity: check for due endpoints at most every minute, but never
  // slower than the configured interval — a short interval must still be honored.
  const tickMs = Math.max(15_000, Math.min(60_000, cfg.intervalMs));
  console.log(`[LLM-Health] Starting Model Provider health poller (interval=${Math.round(cfg.intervalMs / 1000)}s)`);
  runLlmHealthPass().catch(() => {});
  llmHealthTimer = setInterval(() => { runLlmHealthPass().catch(() => {}); }, tickMs);
  // Never let the poller hold the process open on shutdown.
  if (typeof llmHealthTimer.unref === 'function') llmHealthTimer.unref();
}

function llmTokenFingerprint(token) {
  return 'SHA256:' + crypto.createHash('sha256').update(token).digest('base64').replace(/=+$/, '').slice(0, 16);
}

function llmTokenPreview(token) {
  if (!token) return '';
  const tail = token.slice(-4);
  return `…${tail}`;
}

function readLlmEndpointToken(authTokenId) {
  if (!authTokenId) return '';
  try {
    return fs.readFileSync(path.join(LLM_KEYS_DIR, authTokenId), 'utf8').trim();
  } catch {
    return '';
  }
}

function writeLlmEndpointToken(authTokenId, token) {
  const p = path.join(LLM_KEYS_DIR, authTokenId);
  fs.writeFileSync(p, token, { mode: 0o600 });
  try { fs.chmodSync(p, 0o600); } catch { /* best effort */ }
}

function deleteLlmEndpointToken(authTokenId) {
  if (!authTokenId) return;
  try { fs.unlinkSync(path.join(LLM_KEYS_DIR, authTokenId)); } catch { /* ignore */ }
}

function llmEndpointInUse(endpointId) {
  for (const envId of listEnvironmentIds()) {
    const env = loadEnvironment(envId);
    if (env?.llmEndpointId === endpointId) return envId;
  }
  return null;
}

function maskLlmEndpoint(ep) {
  if (!ep) return ep;
  const token = readLlmEndpointToken(ep.authTokenId);
  // Normalize the team-scope shape (#800) so every masked record carries an
  // explicit scope / teamId / assignedTeamIds — pre-#800 entries only stamp a
  // `teamId` and are treated as team-scoped owned by that team.
  const { authTokenId, ...rest } = normalizeCredential(ep);
  return {
    ...rest,
    authType: ep.authType === 'oauth-token' ? 'oauth-token' : 'api-key',
    complianceAck: ep.complianceAck || null,
    hasToken: Boolean(token),
    tokenPreview: token ? llmTokenPreview(token) : '',
    tokenFingerprint: token ? llmTokenFingerprint(token) : '',
  };
}

// #2136 finding 3a: a caller who reaches a provider ONLY because it is GLOBAL —
// not through ordinary team/scope visibility — is not entitled to the token
// metadata. `tokenPreview` (a token tail) and `tokenFingerprint` were, before
// global providers existed, seen only by a Team Admin of an assigned team or a
// System Admin (the callers `visibleCredential` admits). A global provider is
// now listed to EVERY user, so publishing one would otherwise widen who sees a
// credential tail. This strips exactly those two fields for a global-only view,
// leaving the rest of the (already token-free) mask unchanged; a caller with
// ordinary reach is byte-identical to before. The full token is never in either
// projection (AC7).
function maskLlmEndpointForCaller(scope, ep) {
  const masked = maskLlmEndpoint(ep);
  if (!masked || visibleCredential(scope, ep)) return masked;
  const { tokenPreview, tokenFingerprint, ...rest } = masked;
  return rest;
}

/* ─── Subscription-OAuth support (authType: 'oauth-token') ──────────────
 * A Model Provider can authenticate the Claude CLI with a long-lived
 * subscription OAuth token (Claude Max / Enterprise seat, minted by
 * `claude setup-token`) instead of an API key against a proxy. The token is
 * stored in the same _keys/ store; the orchestrator injects it as
 * CLAUDE_CODE_OAUTH_TOKEN and strips the ANTHROPIC_* variables for agents
 * bound to such a provider.
 *
 * Compliance: Anthropic's Consumer Terms only permit consumer-subscription
 * OAuth tokens for the subscription owner's own, single-user use — not for
 * serving third parties. Creating/re-keying an oauth-token provider therefore
 * requires an explicit single-user acknowledgment, recorded on the entry as
 * complianceAck { singleUser, confirmedAt, confirmedBy }.
 */

const ANTHROPIC_DIRECT_BASE = 'https://api.anthropic.com';

function oauthProbeHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    'anthropic-beta': 'oauth-2025-04-20',
    'anthropic-version': '2023-06-01',
  };
}

function normalizeAuthType(v) {
  return v === 'oauth-token' ? 'oauth-token' : 'api-key';
}

function buildComplianceAck(req) {
  return {
    singleUser: true,
    confirmedAt: new Date().toISOString(),
    confirmedBy: req.user?.sub || 'admin',
  };
}

// Claim the token captured by a completed setup-token login flow from the
// orchestrator. One-shot: the orchestrator wipes its copy on success. Only
// ever called server-side — the raw token never travels to the browser.
async function claimOauthFlowToken(flowId) {
  const orchestratorUrl = process.env.ORCHESTRATOR_URL || 'http://orchestrator:4002';
  // Validate and reuse the SAME sanitized value in the request URL. The guard
  // must test the exact string that flows into fetch() — testing a separate
  // `String(flowId)` node left the raw `flowId` untrusted on the URL path
  // (SSRF/path-injection, CWE-918). The anchored hex allow-list forbids any
  // host- or path-traversal characters; encodeURIComponent is belt-and-braces.
  const safeFlowId = String(flowId);
  if (!/^[a-f0-9]+$/.test(safeFlowId)) {
    return { error: 'invalid oauthFlowId' };
  }
  try {
    const r = await fetch(`${orchestratorUrl}/internal/llm-auth/flows/${encodeURIComponent(safeFlowId)}/claim`, { method: 'POST' });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) return { error: body.error || `claim failed (HTTP ${r.status})` };
    if (!body.token) return { error: 'login flow returned no token' };
    return { token: body.token };
  } catch (err) {
    return { error: `orchestrator unreachable: ${err.message}` };
  }
}

// Synthetic read-only provider record that mirrors the ANTHROPIC_* variables
// from `.env`. Surfaced through GET /api/llm-env-fallback so the Model
// Providers page can show the operator what the "inherit from .env" choice
// would actually resolve to. Returns null when ANTHROPIC_BASE_URL isn't set.
function buildEnvFallbackProvider() {
  const baseUrl = (process.env.ANTHROPIC_BASE_URL || '').trim();
  if (!baseUrl) return null;
  const token  = (process.env.ANTHROPIC_AUTH_TOKEN || '').trim();
  const sonnet = (process.env.ANTHROPIC_DEFAULT_SONNET_MODEL || 'claude-sonnet-4-6').trim();
  const haiku  = (process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL  || 'claude-haiku-4-5').trim();
  const models = [];
  if (sonnet) models.push({ id: sonnet, displayName: sonnet, kind: 'sonnet' });
  if (haiku && haiku !== sonnet) models.push({ id: haiku, displayName: haiku, kind: 'haiku' });
  return {
    id: '__env__',
    name: 'Inherited from .env',
    baseUrl,
    hasToken: Boolean(token),
    tokenPreview: token ? llmTokenPreview(token) : '',
    tokenFingerprint: token ? llmTokenFingerprint(token) : '',
    models,
    defaultModelId: sonnet || (models[0]?.id ?? null),
    readOnly: true,
    source: '.env',
  };
}

// One-time auto-migration: if no endpoint is registered yet but the legacy
// `.env` configures a base URL, seed a "Default (from .env)" endpoint so
// existing setups keep working without manual UI steps.
function ensureDefaultLlmEndpoint() {
  const existing = listLlmEndpoints();
  if (existing.length > 0) return;
  const baseUrl = process.env.ANTHROPIC_BASE_URL || '';
  if (!baseUrl) return;
  const token = process.env.ANTHROPIC_AUTH_TOKEN || '';
  const sonnet = process.env.ANTHROPIC_DEFAULT_SONNET_MODEL || 'claude-sonnet-4-6';
  const haiku  = process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL  || 'claude-haiku-4-5';
  const id = 'default';
  const authTokenId = token ? `${id}-${Date.now().toString(36)}` : '';
  if (token) writeLlmEndpointToken(authTokenId, token);
  const entry = {
    id,
    name: 'Default (from .env)',
    baseUrl,
    authTokenId,
    models: [
      { id: sonnet, displayName: sonnet, kind: 'sonnet' },
      { id: haiku,  displayName: haiku,  kind: 'haiku'  },
    ],
    createdAt: new Date().toISOString(),
    migratedFromEnv: true,
  };
  saveLlmEndpointsIndex([entry]);
  console.log(`[api] Seeded default LLM endpoint from .env (baseUrl=${baseUrl})`);
}

ensureDefaultLlmEndpoint();

// Plain HTTP/HTTPS GET for proxy probing (test-connection / discover-models).
// Returns { status, body, error }. Never throws.
function httpGetJson(targetUrl, headers = {}, timeoutMs = 8000) {
  return new Promise((resolve) => {
    let parsed;
    try {
      parsed = new URL(targetUrl);
    } catch (err) {
      return resolve({ status: 0, body: null, error: `Invalid URL: ${err.message}` });
    }
    const lib = parsed.protocol === 'https:' ? require('https') : require('http');
    const req = lib.request({
      method: 'GET',
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      headers: { Accept: 'application/json', ...headers },
      timeout: timeoutMs,
    }, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        let body = data;
        try { body = data ? JSON.parse(data) : null; } catch { /* keep as string */ }
        resolve({ status: res.statusCode, body, error: null });
      });
    });
    req.on('error', (err) => resolve({ status: 0, body: null, error: err.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: null, error: 'timeout' }); });
    req.end();
  });
}

// Strip trailing '/' characters with a linear scan. A regex trim like
// `/\/+$/` backtracks O(n²) on a base URL that is a long run of slashes not
// anchored at the end (CodeQL js/polynomial-redos); a charCode scan is linear
// and byte-identical in result (47 === '/').
function trimTrailingSlashes(s) {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 47) end -= 1;
  return s.slice(0, end);
}

// Strip trailing whitespace with a linear scan. A regex trim like `/\s+$/`
// backtracks O(n²) on a long run of whitespace that is not anchored at the end
// (CodeQL js/polynomial-redos); scanning from the end is linear. `/\s/.test(ch)`
// runs on a single character, so it preserves the full `\s` set (incl. Unicode
// whitespace) without any superlinear matching.
function trimTrailingWhitespace(s) {
  let end = s.length;
  while (end > 0 && /\s/.test(s[end - 1])) end -= 1;
  return s.slice(0, end);
}

// Build the URL the LiteLLM proxy exposes its model catalog at. Accepts both
// `https://host` and `https://host/v1` styles by appending `/v1/models` when
// the base URL doesn't already end in /v1 or /models.
function buildModelsUrl(baseUrl) {
  const trimmed = trimTrailingSlashes(baseUrl);
  if (/\/(v1\/)?models$/.test(trimmed)) return trimmed;
  if (/\/v\d+$/.test(trimmed)) return `${trimmed}/models`;
  return `${trimmed}/v1/models`;
}

// Companion to buildModelsUrl for the Anthropic-compatible chat endpoint.
// Appends `/v1/messages` unless the base URL already targets a versioned or
// messages path.
function buildMessagesUrl(baseUrl) {
  const trimmed = trimTrailingSlashes(baseUrl);
  if (/\/messages$/.test(trimmed)) return trimmed;
  if (/\/v\d+$/.test(trimmed)) return `${trimmed}/messages`;
  return `${trimmed}/v1/messages`;
}

// Plain HTTP/HTTPS POST of a JSON body. Mirrors httpGetJson: returns
// { status, body, error } and never throws. Used for one-shot LLM calls.
//
// `signal` (#2087, optional) aborts an in-flight call: a Flow Copilot turn is
// up to 3 × 180 s of LLM work, and before this a disconnect only suppressed the
// DELIVERY of the result — the work ran on, billed, and was discarded. Every
// existing caller passes four arguments and is byte-identical: with no signal
// no listener is attached and nothing about the request changes.
function httpPostJson(targetUrl, headers = {}, bodyObj = {}, timeoutMs = 30000, signal = null) {
  return new Promise((resolve) => {
    if (signal && signal.aborted) {
      return resolve({ status: 0, body: null, error: 'aborted' });
    }
    let parsed;
    try {
      parsed = new URL(targetUrl);
    } catch (err) {
      return resolve({ status: 0, body: null, error: `Invalid URL: ${err.message}` });
    }
    const payload = Buffer.from(JSON.stringify(bodyObj));
    const lib = parsed.protocol === 'https:' ? require('https') : require('http');
    const req = lib.request({
      method: 'POST',
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'Content-Length': payload.length,
        ...headers,
      },
      timeout: timeoutMs,
    }, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        let body = data;
        try { body = data ? JSON.parse(data) : null; } catch { /* keep as string */ }
        settle({ status: res.statusCode, body, error: null });
      });
    });
    // One settle path so the abort listener is always detached — a long-lived
    // signal (one per Copilot turn, up to three calls) must not accumulate
    // listeners from the calls that already finished.
    let done = false;
    const onAbort = () => { req.destroy(); settle({ status: 0, body: null, error: 'aborted' }); };
    function settle(result) {
      if (done) return;
      done = true;
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve(result);
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    req.on('error', (err) => settle({ status: 0, body: null, error: err.message }));
    req.on('timeout', () => { req.destroy(); settle({ status: 0, body: null, error: 'timeout' }); });
    req.write(payload);
    req.end();
  });
}

// Whole-turn wall-clock budget for one Flow Copilot request, kept just under the
// GKE LB backend `timeoutSec: 300` (deploy/k8s/overlays/*/app/ingress.yaml): the
// browser-facing NDJSON response stays open across up to 3 sequential LLM calls
// plus validation, so this bounds that WHOLE response (not one call) — the route
// hands each call only the budget still remaining, and the console closes its own
// stream with a clean `{error:'deadline'}` card ~20s before the edge would return
// a raw 504. A run that steadily streams tokens normally finishes long before it.
// Env-tunable so an operator can match their proxy without a redeploy.
const COPILOT_STREAM_DEADLINE_MS = Number(process.env.AEE_COPILOT_DEADLINE_MS) || 280000;
// Socket-idle guard for ONE streamed upstream call. httpPostStreamText defaults
// this to 60s — fine for a snappy directly-streaming endpoint, but a large flow
// used to fail with a bare "LLM request failed: timeout" long before the turn
// deadline, because the internal Anthropic proxy can BUFFER the SSE (delivering
// no incremental bytes until the whole 16k-token generation is done). During that
// window the socket sits genuinely silent, so a 60s idle timer kills a call that
// is alive and would have completed. For this route the whole-turn deadline is
// the real bound, so we default the idle guard OFF (0) — the call is limited only
// by the remaining deadline — and let an operator opt into a tighter dead-socket
// guard via AEE_COPILOT_INACTIVITY_MS when their endpoint truly streams.
const COPILOT_STREAM_INACTIVITY_MS = Number(process.env.AEE_COPILOT_INACTIVITY_MS) || 0;
// Per-CALL ceiling inside that whole-turn budget (#2131). Handing one call the
// entire remaining budget means a single slow generation can consume the turn
// and leave nothing for the generate-in-parts fallback — so the turn still ends
// in a failure card, just a cleaner one. Capping a call at half the turn means a
// timed-out single generation always leaves the split retry an equal budget for
// its two smaller calls. Derived from the turn deadline so the two stay in step
// when an operator tunes it, and independently overridable.
const COPILOT_CALL_DEADLINE_MS = Number(process.env.AEE_COPILOT_CALL_DEADLINE_MS)
  || Math.round(COPILOT_STREAM_DEADLINE_MS / 2);

/* ─── Health ────────────────────────────────────────────────────────── */

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

/* ─── Maintenance Mode (#501) ────────────────────────────────────────── */
// Central, persisted status endpoint — the single source of truth other
// components (chat UI, trigger processing) can query. No enforcement lives
// here; that is scoped to follow-up issues under epic #508.

app.get('/api/maintenance-mode', (req, res) => {
  res.json(maintenanceMode.getStatus());
});

app.post('/api/maintenance-mode/activate', (req, res) => {
  try {
    maintenanceMode.activate(req.body && req.body.gracePeriodSec);
    res.json(maintenanceMode.getStatus());
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.post('/api/maintenance-mode/deactivate', (req, res) => {
  maintenanceMode.deactivate();
  res.json(maintenanceMode.getStatus());
});

/* ─── Client error telemetry (#1974) ────────────────────────────────── */
// The console's React error boundaries post one report per contained render
// error, so a white-screen trigger is observed centrally instead of only in
// the reporting user's browser console. Purely observational — nothing reads
// this to make a decision.
//
// Its own tight limiter (a fresh instance, so it never shares a counter with
// apiLimiter): the client already dedupes and caps per window, but the server
// must not depend on a client that is by definition misbehaving when it calls.
const clientErrorLimiter = rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests' },
});

app.post('/api/client-errors', clientErrorLimiter, (req, res) => {
  const built = clientErrorLog.buildClientErrorEvent(req.body, { actor: req.user && req.user.sub });
  if (!built.ok) return res.status(400).json({ error: built.error });
  clientErrorLog.record(built.event);
  // Also to the container log, which is the surface an operator already has
  // (the Logs page streams it) — the JSONL file is the durable copy.
  console.warn(clientErrorLog.logLine(built.event));
  res.status(204).end();
});

/* ─── Setup Status ──────────────────────────────────────────────────── */

app.get('/api/setup/status', (req, res) => {
  const llmEndpoints = readJsonFile(LLM_ENDPOINTS_INDEX, []);
  const sshKeys      = readJsonFile(SSH_KEYS_INDEX, []);
  const ghTokens     = readJsonFile(GH_TOKENS_INDEX, []);

  res.json(buildSetupStatus({
    llmCount: llmEndpoints.length,
    sshCount: sshKeys.length,
    ghCount: ghTokens.length,
  }));
});

/* ─── Agents ────────────────────────────────────────────────────────── */

app.get('/api/agents', (req, res) => {
  const scope = getScope(req);
  const ids = listAgentDirs();
  const agents = ids
    .map(id => {
      const cfg = readJsonFile(path.join(AGENTS_DIR, id, 'config.json'), {});
      return { id, ...cfg };
    })
    .filter(a => visibleAgent(scope, agentMetaForScope(a))); // team + visibility scoping (#302)
  res.json(agents);
});

// NOTE: must be registered BEFORE `/api/agents/:id` — otherwise Express
// would match this static path against the parameterized route (with
// id="statuses") and return 404.
// Assemble the FULL (unscoped) per-agent status set: list agent dirs, read each
// config.json exactly once, ask the orchestrator which containers are up, and
// read status.json / dm-room.json / the session pointer only for an enabled,
// running agent (a disabled/offline agent needs none of those). Returns
// `{ cfg, status }` per agent so the caller can apply its own visibility scope
// against the same config it was built from. Pure shaping lives in
// buildAgentStatus (agent-statuses.js, #1677).
async function buildAllAgentStatuses() {
  let runningIds = new Set();
  const orchestratorUrl = process.env.ORCHESTRATOR_URL || 'http://orchestrator:4002';
  try {
    const resp = await fetch(`${orchestratorUrl}/internal/agents/processes`);
    if (resp.ok) {
      const processes = await resp.json();
      for (const p of processes) {
        if (p.running) runningIds.add(p.id);
      }
    }
  } catch { /* orchestrator unreachable — all agents appear offline */ }

  const entries = [];
  for (const id of listAgentDirs()) {
    const cfg = readJsonFile(path.join(AGENTS_DIR, id, 'config.json'), null);
    if (!cfg) continue; // corrupt/unreadable config — excluded, as before
    const running = runningIds.has(id);
    let status = null, dmRoom = null, sessionFileExists = false;
    if (cfg.enabled !== false && running) {
      status = readJsonFile(controlOrAgentPath(id, 'status.json'), null); // pushed copy preferred (#185)
      dmRoom = readJsonFile(path.join(AGENTS_DIR, id, 'dm-room.json'), null);
      sessionFileExists = !!(dmRoom?.roomId &&
        fs.existsSync(controlOrAgentPath(id, 'sessions', dmRoom.roomId + '.current.json'))); // pushed copy preferred (#185)
    }
    entries.push({ cfg, status: buildAgentStatus({ id, cfg, running, status, dmRoom, sessionFileExists }) });
  }
  return entries;
}

// Short-TTL single-flight cache over the full status set. Several console
// surfaces poll this endpoint on a 5s beat (Shell nav badge, Agent-Chat list,
// Maintenance Mode); the front end now shares one poll (#1677), but multiple
// tabs/users and scope-varying callers can still land close together — a ~2s
// TTL collapses those onto one filesystem + orchestrator sweep. Caching the
// in-flight promise also dedups concurrent rebuilds.
let _statusCache = null; // { builtAt, promise }
const STATUS_CACHE_TTL_MS = Number(process.env.AGENT_STATUSES_TTL_MS) || 2000;

function agentStatusEntries() {
  const now = Date.now();
  if (_statusCache && statusCacheFresh(_statusCache.builtAt, now, STATUS_CACHE_TTL_MS)) {
    return _statusCache.promise;
  }
  const promise = buildAllAgentStatuses().catch(err => {
    // Don't cache a failed build — let the next request retry.
    if (_statusCache && _statusCache.promise === promise) _statusCache = null;
    throw err;
  });
  _statusCache = { builtAt: now, promise };
  return promise;
}

app.get('/api/agents/statuses', apiLimiter, async (req, res) => {
  // Scope the status set to the agents the caller may see, using the SAME
  // predicate as GET /api/matrix/agents (#1605). The Agent-Chat nav badges in
  // Shell.jsx aggregate this payload, so an unscoped set leaked the activity of
  // hidden agents and made the badge disagree with the (already-scoped) list.
  // getScope(req) respects the caller's scope, so a System Admin / env
  // single-admin (scope `all`) still sees every agent — the filter is additive,
  // never a hard global cut (open-question 2). The scope filter is applied
  // per-request on top of the shared (cached) build (#1677).
  const scope = getScope(req);
  let entries;
  try {
    entries = await agentStatusEntries();
  } catch {
    return res.status(500).json({ error: 'Failed to read agent statuses' });
  }
  const statuses = entries
    .filter(e => visibleAgent(scope, agentMetaForScope(e.cfg)))
    .map(e => e.status);
  res.json(statuses);
});

/* ─── Orphaned agents — scan + one-off cleanup (#1960) ──────────────────
   An ORPHAN is a `team-member` whose parent team cannot be resolved. Team
   deletion cascades to its members, so orphans are no longer created; these two
   routes clean up an installation that already has some.

   MUST stay registered ABOVE `/api/agents/:id` — Express matches in
   registration order, and `orphans` would otherwise be read as an agent id
   (the same reason `/api/agents/statuses` sits where it does).

   System-Admin-only, deliberately: the scan is installation-wide (an orphan has
   no resolvable team, so there is no team to scope it to) and the cleanup
   deletes agents across every team. Neither is expressible as a team-scoped
   permission. */

// Dry run: what a cleanup WOULD remove. Changes nothing.
app.get('/api/agents/orphans', apiLimiter, async (req, res) => {
  if (!getScope(req).all) {
    return res.status(403).json({ error: 'forbidden: the orphan scan requires System Admin' });
  }
  const orchestratorUrl = process.env.ORCHESTRATOR_URL || 'http://orchestrator:4002';
  try {
    const resp = await fetch(`${orchestratorUrl}/internal/agents/orphans`);
    const data = await resp.json().catch(() => ({}));
    return res.status(resp.status).json(data);
  } catch (err) {
    return res.status(502).json({ error: `Orchestrator unreachable: ${err.message}` });
  }
});

// Act. Idempotent: a second call over an already-clean workspace removes
// nothing and reports an empty plan. The response repeats the plan it acted on
// (`planned`) next to what it managed to remove (`deleted`) and what it could
// not (`warnings`), so a partial sweep is never reported as a clean one.
app.post('/api/agents/orphans/cleanup', heavyLimiter, async (req, res) => {
  if (!getScope(req).all) {
    return res.status(403).json({ error: 'forbidden: the orphan cleanup requires System Admin' });
  }
  const orchestratorUrl = process.env.ORCHESTRATOR_URL || 'http://orchestrator:4002';
  try {
    const resp = await fetch(`${orchestratorUrl}/internal/agents/orphans/cleanup`, { method: 'POST' });
    const data = await resp.json().catch(() => ({}));
    return res.status(resp.status).json(data);
  } catch (err) {
    return res.status(502).json({ error: `Orchestrator unreachable: ${err.message}` });
  }
});

app.get('/api/agents/:id', (req, res) => {
  const { id } = req.params;
  if (!AGENT_ID_RE.test(id)) return res.status(400).json({ error: 'Invalid agent id' });
  const agentDir = path.join(AGENTS_DIR, id);
  const cfg = readJsonFile(path.join(agentDir, 'config.json'), null);
  if (!cfg) return res.status(404).json({ error: 'Agent not found' });
  const triggers = readJsonFile(controlOrAgentPath(id, 'triggers.json'), []); // canonical copy (#185)
  res.json({ id, ...cfg, triggers });
});

// Best-effort: nudge a running agent (SIGUSR2 via the orchestrator) to re-pull
// its triggers + config + dm-room now instead of waiting for the next 60s sync.
// No-op if the agent isn't running. (#185 Phase 2)
function notifyAgentReload(agentId) {
  const orchestratorUrl = process.env.ORCHESTRATOR_URL || 'http://orchestrator:4002';
  fetch(`${orchestratorUrl}/internal/agents/${encodeURIComponent(agentId)}/reload-triggers`, { method: 'POST' })
    .catch(() => {});
}

// Resolve the "<org>/<repo>" that a team member's github-event triggers must
// target, from its bound environment's first repository. The pure `expand*`
// builders (expandGithubChannels / expandDataFlowSteps) emit derived
// github-event triggers WITHOUT a `repo` field — at materialise time it's
// injected from the env (out.repo = vars.repoFullName); the live reconcile path
// must do the same, or the GitHub poller silently skips the trigger
// (`_buildPollPlan` requires `t.repo`) and the subscriber never fires. Returns
// null when unresolvable (no env / no repo / unparseable), in which case we
// leave `repo` unset rather than writing a bogus value.
function memberRepoFullName(cfg) {
  try {
    const env = cfg && cfg.environmentId ? loadEnvironment(cfg.environmentId) : null;
    const repos = env && Array.isArray(env.repositories) ? env.repositories : [];
    const url = repos[0] && repos[0].url;
    if (!url) return null;
    const { org, repo } = parseGitHubUrl(url);
    return `${org}/${repo}`;
  } catch { return null; }
}

// A derived data-flow trigger is one the `expandDataFlowSteps` derivation owns:
// it carries the `dataFlow` marker and the canonical `<consumer>-on-push-<up>`
// id. Manually-authored data-flow triggers (arbitrary ids) don't match and are
// preserved untouched by reconciliation. Kept in sync with process-template.js.
function isDerivedDataFlowTrigger(t, memberId) {
  return t && t.dataFlow === true && typeof t.id === 'string'
    && t.id.startsWith(`${memberId}-on-push-`);
}

// Re-derive the functional data-flow push triggers for a whole team from its
// members' declarative ports (`dataFlow.{dependsOn,inputs,outputs}`), mirroring
// what `expandDataFlowSteps` does at materialise time. This is what makes a live
// team behave like a draft: the ports are the single source of truth for the
// edges, and the runtime wiring is derived on write — no separate trigger
// bookkeeping in the editor. Best-effort and idempotent; only members whose
// trigger set actually changes are written back. Regenerating from ports-stripped
// triggers handles both adds (new port) and removals (dropped port). Members'
// own ids are already full member ids, so no teamId mapping is applied.
async function reconcileTeamDataFlow(teamId) {
  if (!teamId) return;
  const members = [];
  for (const id of listAgentDirs()) {
    const cfg = readJsonFile(path.join(AGENTS_DIR, id, 'config.json'), null);
    if (!cfg || cfg.parentTeamId !== teamId) continue;
    const df = cfg.dataFlow && typeof cfg.dataFlow === 'object' ? cfg.dataFlow : {};
    const triggers = readJsonFile(controlOrAgentPath(id, 'triggers.json'), []);
    members.push({ id, displayName: cfg.displayName || id, triggers: Array.isArray(triggers) ? triggers : [], df, repo: memberRepoFullName(cfg) });
  }
  if (members.length === 0) return;

  // Strip the previously-derived triggers so expandDataFlowSteps regenerates the
  // full current set from the ports (a plain no-op leaves stale ones behind).
  const roles = members.map(m => ({
    id: m.id,
    displayName: m.displayName,
    inputs: Array.isArray(m.df.inputs) ? m.df.inputs : [],
    outputs: Array.isArray(m.df.outputs) ? m.df.outputs : [],
    dependsOn: Array.isArray(m.df.dependsOn) ? m.df.dependsOn : [],
    triggers: m.triggers.filter(t => !isDerivedDataFlowTrigger(t, m.id)),
  }));
  const expanded = expandDataFlowSteps({ roles }).roles;
  const byId = new Map(expanded.map(r => [r.id, r]));
  const norm = (arr) => JSON.stringify([...arr].sort((a, b) => (a.id < b.id ? -1 : 1)));

  for (const m of members) {
    // Preserve each regenerated derived trigger's history-horizon stamp so this
    // rewrite doesn't push the poller's horizon to "now" and drop pending events
    // (#446). Content-compare (order-insensitive on id) so we write when the
    // wiring OR its preserved activatedAt genuinely changed — but skip a pure
    // no-op, which would bump triggers.json mtime for nothing.
    const next = injectDerivedTriggerRepo(
      stampDerivedActivation(byId.get(m.id)?.triggers || [], m.triggers),
      m.repo,
    );
    if (norm(next) === norm(m.triggers)) continue;
    try { await putTriggers(m.id, next); notifyAgentReload(m.id); }
    catch { /* best-effort — never break the originating request */ }
  }
}

// Re-derive the functional GitHub-channel triggers for a whole team from its
// members' declarative `channels` ports (#380), mirroring what
// `expandGithubChannels` does at materialise time. Same pattern as
// reconcileTeamDataFlow: strip the previously-derived `channel:true` triggers,
// regenerate from the ports, and write back only members whose derived set
// actually changed (content-compared, so editing a channel's label/gate updates
// its trigger even though the trigger id is stable). Members already carry full
// ids, so no teamId mapping is applied (a channel `from` is already a member id).
async function reconcileTeamGithubChannels(teamId) {
  if (!teamId) return;
  const members = [];
  for (const id of listAgentDirs()) {
    const cfg = readJsonFile(path.join(AGENTS_DIR, id, 'config.json'), null);
    if (!cfg || cfg.parentTeamId !== teamId) continue;
    const channels = Array.isArray(cfg.channels) ? cfg.channels : [];
    const triggers = readJsonFile(controlOrAgentPath(id, 'triggers.json'), []);
    members.push({ id, displayName: cfg.displayName || id, channels, triggers: Array.isArray(triggers) ? triggers : [], repo: memberRepoFullName(cfg) });
  }
  if (members.length === 0) return;

  const roles = members.map(m => ({
    id: m.id,
    displayName: m.displayName,
    channels: m.channels,
    triggers: m.triggers.filter(t => !isChannelTrigger(t)),
  }));
  const expanded = expandGithubChannels({ roles }).roles;
  const byId = new Map(expanded.map(r => [r.id, r]));
  const norm = (arr) => JSON.stringify([...arr].sort((a, b) => (a.id < b.id ? -1 : 1)));

  for (const m of members) {
    // Preserve each regenerated channel trigger's history-horizon stamp so this
    // rewrite can't push the poller's horizon to "now" and drop a pending PR/issue
    // event (#446 — the exact case that kept the code-reviewer from ever firing).
    const next = injectDerivedTriggerRepo(
      stampDerivedActivation(byId.get(m.id)?.triggers || [], m.triggers),
      m.repo,
    );
    if (norm(next) === norm(m.triggers)) continue;
    try { await putTriggers(m.id, next); notifyAgentReload(m.id); }
    catch { /* best-effort — never break the originating request */ }
  }
}

// The wake-side sibling of reconcileTeamGithubChannels (#2031): re-derive each
// member's `wake-agent` listener from the team's `wakeAgent` outcome actions, so
// wiring a direct hand-off on a LIVE team takes effect without a re-materialise.
// Same discipline throughout — strip the previously-derived triggers, regenerate
// from the ports, write back only members whose set actually changed.
//
// Two deliberate differences from the channel reconciler:
//   - the whole team is the input, not just the edited member. A hand-off is
//     authored on the PRODUCER but the derived listener lands on the TARGET, so
//     an edit to one member's outcomes changes a different member's triggers.
//   - no `stampDerivedActivation`. That stamp exists solely to keep the GitHub
//     poller's per-subscriber history horizon fixed across a rewrite; a
//     `wake-agent` trigger is never polled (`pollerSubscribes` requires
//     `type === 'github-event'`), so it has no horizon to protect and carrying
//     an `activatedAt` onto it would imply one.
async function reconcileTeamWakeHandoffs(teamId) {
  if (!teamId) return;
  const members = [];
  for (const id of listAgentDirs()) {
    const cfg = readJsonFile(path.join(AGENTS_DIR, id, 'config.json'), null);
    if (!cfg || cfg.parentTeamId !== teamId) continue;
    const triggers = readJsonFile(controlOrAgentPath(id, 'triggers.json'), []);
    members.push({
      id, displayName: cfg.displayName || id, outcomes: cfg.outcomes || null,
      triggers: Array.isArray(triggers) ? triggers : [],
    });
  }
  if (members.length === 0) return;

  const roles = members.map(m => ({
    id: m.id,
    displayName: m.displayName,
    outcomes: m.outcomes,
    triggers: m.triggers.filter(t => !isWakeHandoffTrigger(t)),
  }));
  const byId = new Map(expandWakeHandoffs({ roles }).roles.map(r => [r.id, r]));
  const norm = (arr) => JSON.stringify([...arr].sort((a, b) => (a.id < b.id ? -1 : 1)));

  for (const m of members) {
    const next = byId.get(m.id)?.triggers || [];
    if (norm(next) === norm(m.triggers)) continue;
    try { await putTriggers(m.id, next); notifyAgentReload(m.id); }
    catch { /* best-effort — never break the originating request */ }
  }
}

// After any batch of team-member creations over POST /internal/teams/:id/members
// (team create/extend, the single-member "Add member"), re-derive the members'
// direct-hand-off wiring against their MATERIALISED ids (#2030). The portable
// bundle renders every derived `## Outcomes` block AND every `wake-agent`
// listener against ROLE ids (`agent-2`), because that rendering runs on the
// bundle in expandGithubChannels/expandWakeHandoffs. A `wakeAgent`'s `to` is
// remapped to the member id (`<team>-agent-2`) only in the stored `outcomes`
// PORT (buildMemberFromTemplate → remapOutcomeWakeTargets) — so the
// `aee-wake --to <id>` command the producer actually runs from its prompt, and
// the derived listener's `sources`, keep the bare role id and the hand-off
// resolves to nobody (404 unknown-target). These are the very reconcilers a live
// outcomes/port edit already runs (PUT /api/agents/:id); running them once here
// closes the identical gap for a freshly materialised team, rewriting each
// block/listener against the live member ids (reconcileTeamOutcomes also fixes
// each EXCLUSIVE member's stored cfg.systemPrompt, so a stub materialised later
// inherits the corrected prompt). Best-effort — a just-created team must never
// fail on a prompt-block rewrite.
async function reconcileTeamHandoffWiring(teamAgentId) {
  if (!teamAgentId) return;
  try {
    await reconcileTeamOutcomes(teamAgentId);
    await reconcileTeamWakeHandoffs(teamAgentId);
  } catch (err) {
    console.warn(`[API] hand-off wiring reconcile for ${teamAgentId}: ${err.message}`);
  }
}

// Re-render the derived OUTCOMES prompt block (#829) for a whole team from its
// members' declarative `outcomes` ports, mirroring what `expandGithubChannels`
// (via applyDerivedPromptBlocks) does at materialise time. This is the prompt-side
// analogue of reconcileTeamGithubChannels: where that reconciler re-derives the
// runtime triggers, this one re-derives the marker-delimited `## Outcomes` block
// in each member's effective prompt so a live outcomes edit takes effect without
// a re-materialise. Same discipline: best-effort, idempotent, skip no-op writes.
//
// The block belongs in the prompt STRING (AGENT-PROMPT.md, which CLAUDE.md
// `@`-imports per #510 — CLAUDE.md itself is static and never rebuilt for a
// prompt-content change), so we resolve each member's effective base prompt
// (own systemPrompt override, else the parent team's template), re-apply BOTH
// derived blocks (github-io + outcomes — coexistence is handled inside
// applyDerivedPromptBlocks so "open a PR" never doubles), write AGENT-PROMPT.md,
// keep an override member's stored config.systemPrompt in sync (so export /
// prompt-toggle paths see the current block), and mirror the file into the
// agent's isolated volume via notifyAgentReseed. Iterating the whole team (a
// fan-out) matches reconcileTeamGithubChannels; since outcomes are per-agent only
// the edited member's block actually changes — the rest re-render identically and
// are skipped.
async function reconcileTeamOutcomes(teamId) {
  if (!teamId) return;
  const teamCfg = readJsonFile(path.join(AGENTS_DIR, teamId, 'config.json'), null);
  const teamTemplate = teamCfg && typeof teamCfg.systemPromptTemplate === 'string'
    ? teamCfg.systemPromptTemplate : '';
  // Wiring context (#1007): the block now names consumers/reviewers/gates, so
  // collect the whole team (configs + triggers) once before rendering members.
  const members = [];
  for (const id of listAgentDirs()) {
    const cfg = readJsonFile(path.join(AGENTS_DIR, id, 'config.json'), null);
    if (!cfg || cfg.parentTeamId !== teamId) continue;
    const triggers = readJsonFile(controlOrAgentPath(id, 'triggers.json'), []);
    members.push({ id, cfg, displayName: cfg.displayName || id, triggers: Array.isArray(triggers) ? triggers : [] });
  }
  for (const { id, cfg } of members) {
    const cfgPath = path.join(AGENTS_DIR, id, 'config.json');

    // Mode-aware base prompt (#1511): 'exclusive' → the member's own text;
    // 'additional' → team template + the member's addition (a member in this
    // mode stores ONLY the addition in cfg.systemPrompt); 'inherit' → the team
    // template. The derived Outcomes/GitHub blocks are then applied on top.
    const promptMode = resolvePromptMode(cfg);
    const ownText = typeof cfg.systemPrompt === 'string' ? cfg.systemPrompt : '';
    const base = composeMemberPrompt(promptMode, teamTemplate, ownText);
    const wiring = outcomesWiringContext(id, {
      roles: members,
      humans: (teamCfg && Array.isArray(teamCfg.humans)) ? teamCfg.humans : [],
      labels: (teamCfg && Array.isArray(teamCfg.labels)) ? teamCfg.labels : [],
    });
    const nextPrompt = applyDerivedPromptBlocks(base, {
      github: cfg.github, outcomes: cfg.outcomes, ...(wiring ? { wiring } : {}),
    });

    // Persist the re-rendered block onto an EXCLUSIVE member's stored prompt so
    // export (buildProcessTemplate strips it back out) and a later prompt-toggle
    // stay consistent with what the agent reads. For 'additional' the stored
    // systemPrompt is only the addition (team + addition is re-composed on every
    // team-prompt edit), so it must NEVER be overwritten with the composed +
    // derived output. 'inherit' members carry no override — only their
    // AGENT-PROMPT.md is refreshed.
    if (promptMode === PROMPT_MODES.EXCLUSIVE && cfg.systemPrompt !== nextPrompt) {
      cfg.systemPrompt = nextPrompt;
      try { writeJsonAtomic(cfgPath, cfg); } catch { /* best-effort */ }
    }

    const promptPath = path.join(AGENTS_DIR, id, 'AGENT-PROMPT.md');
    let current = null;
    try { current = fs.readFileSync(promptPath, 'utf8'); } catch { current = null; }
    if (current === nextPrompt) continue; // idempotent — no churn

    try {
      const tmp = promptPath + '.tmp';
      fs.writeFileSync(tmp, nextPrompt, 'utf8');
      fs.renameSync(tmp, promptPath);
      notifyAgentReseed(id, ['AGENT-PROMPT.md']);
      notifyAgentReload(id);
    } catch (err) {
      console.error(`[API] Failed to write AGENT-PROMPT.md for ${id} (outcomes reconcile): ${err.message}`);
    }
  }
}

// Guard against a parent-child cycle among a team's members (#377). Walks the
// existing parentMemberId chain: setting `child`'s parent to `parent` is a cycle
// if `child` is already an ancestor of `parent` (or they're equal).
function parentWouldCycle(teamId, childId, parentId) {
  if (!parentId || parentId === childId) return parentId === childId;
  const parentOf = new Map();
  for (const id of listAgentDirs()) {
    const cfg = readJsonFile(path.join(AGENTS_DIR, id, 'config.json'), null);
    if (cfg && cfg.parentTeamId === teamId && typeof cfg.parentMemberId === 'string') {
      parentOf.set(id, cfg.parentMemberId);
    }
  }
  let cur = parentId, seen = new Set();
  while (cur && !seen.has(cur)) {
    if (cur === childId) return true;
    seen.add(cur);
    cur = parentOf.get(cur);
  }
  return false;
}

// Best-effort: after the admin writes a control-plane file (prompt, skill) to the
// pool subpath, ask the orchestrator to mirror those named paths into a running
// isolated agent's dedicated volume (#185 item 5). The orchestrator is the only
// writer that can reach that volume; it's a no-op there when AEE_PER_AGENT_VOLUME
// is off or the agent isn't running. Harmless on the shared-volume path — the
// files we just wrote already live where the agent reads them.
function notifyAgentReseed(agentId, paths) {
  const orchestratorUrl = process.env.ORCHESTRATOR_URL || 'http://orchestrator:4002';
  fetch(`${orchestratorUrl}/internal/agents/${encodeURIComponent(agentId)}/reseed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paths }),
  }).catch(() => {});
}

// Best-effort: after an environment's spawn-time credentials change (today: the
// GitHub PAT it points at), ask the orchestrator to respawn the running agents
// bound to that env so they pick up the new credential. The token is baked into
// each container's environment at spawn time, so without this a rotated PAT
// would only reach a container on its next manual disable/enable.
function notifyEnvCredentialChange(envId, reason) {
  const orchestratorUrl = process.env.ORCHESTRATOR_URL || 'http://orchestrator:4002';
  fetch(`${orchestratorUrl}/internal/environments/${encodeURIComponent(envId)}/respawn-agents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason }),
  }).catch(() => {});
}

// Best-effort: after a human SETS or ROTATES their personal credential (#1570,
// epic #1558 Phase 4), ask the orchestrator to respawn that person's running
// agents so the new secret takes effect — the personal-tier counterpart of
// notifyEnvCredentialChange, scoped to the owner instead of an environment. A
// personal secret is baked into each of the owner's containers at spawn, so
// without this a rotated key/token would only reach them on a manual
// disable/enable. `ownerId` is the credential's `userId`; a falsy owner (an
// env/team/system credential, or the env single-admin) is a no-op.
function notifyOwnerCredentialChange(ownerId, reason) {
  if (!ownerId) return;
  const orchestratorUrl = process.env.ORCHESTRATOR_URL || 'http://orchestrator:4002';
  fetch(`${orchestratorUrl}/internal/owners/${encodeURIComponent(ownerId)}/respawn-agents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason }),
  }).catch(() => {});
}

app.put('/api/agents/:id', apiLimiter, async (req, res) => {
  const { id } = req.params;
  if (!AGENT_ID_RE.test(id)) return res.status(400).json({ error: 'Invalid agent id' });
  // Containment: resolve the agent dir under AGENTS_DIR and reject any id that
  // escapes it. AGENT_ID_RE alone is not modelled as a path sanitiser, so build
  // every id-derived path from the resolved `agentDir` behind this barrier.
  const agentsBaseDir = path.resolve(AGENTS_DIR);
  const agentDir = path.resolve(agentsBaseDir, id);
  const agentRel = path.relative(agentsBaseDir, agentDir);
  if (agentRel.startsWith('..') || path.isAbsolute(agentRel)) return res.status(400).json({ error: 'Invalid agent id' });
  const cfgPath = path.join(agentDir, 'config.json');
  const cfg = readJsonFile(cfgPath, null);
  if (!cfg) return res.status(404).json({ error: 'Agent not found' });
  const { displayName, role, enabled, systemPromptTemplate, systemPrompt, promptMode, skills, skillsOverride, mcpServersOverride, disableMode, teamId, emits, outcomes, dataFlow, parentMemberId, stage, stages, labels, humans, wipLimit, github, channels, assistLlmEndpointId } = req.body;

  // ── Label registry (#928/#981) ────────────────────────────────────────────
  // The gate/brake flags live on the TEAM agent (like `stages`) — the live
  // Flow Editor writes them here. Validate up front so a bad shape can't
  // half-apply: an array of { name, humanGate?, brake? }, deduped by trimmed
  // name. Ignored for non-team agents.
  let normLabels = null;
  if (labels !== undefined) {
    if (labels !== null && !Array.isArray(labels)) {
      return res.status(400).json({ error: 'labels must be an array of { name, humanGate?, brake? }' });
    }
    const seenNames = new Set();
    normLabels = [];
    for (const l of (labels || [])) {
      if (!l || typeof l !== 'object' || Array.isArray(l) || typeof l.name !== 'string' || !l.name.trim()) {
        return res.status(400).json({ error: 'each label needs a non-empty name' });
      }
      const name = l.name.trim();
      if (seenNames.has(name)) continue;
      seenNames.add(name);
      const entry = { name };
      if (l.humanGate === true) entry.humanGate = true;
      if (l.brake === true) entry.brake = true;
      normLabels.push(entry);
    }
  }

  // ── Named human roles (#987) ──────────────────────────────────────────────
  // First-class human flow nodes, persisted on the TEAM agent like `labels` /
  // `stages` — purely declarative, no runtime side-effect (AC9). Validated via
  // the same rules the bundle uses so a live edit and an imported draft agree;
  // normalized to the persisted shape. Ignored for non-team agents.
  let normHumans = null;
  if (humans !== undefined) {
    if (humans !== null && !Array.isArray(humans)) {
      return res.status(400).json({ error: 'humans must be an array of { id, name, description?, stage?, emits?, consumes? }' });
    }
    const vh = validateProcessTemplate({ processTemplateVersion: 1, roles: [], humans: humans || [] }, { allowEmptyRoles: true });
    if (!vh.ok) return res.status(400).json({ error: `Invalid humans: ${vh.error}` });
    // Drop dead producer refs (#2063): a pr/issue consume whose `from` names no
    // existing agent is unremovable via the UI (its remove control lived on the
    // now-deleted producer). Prune against the on-disk roster so it clears on
    // the next humans save — the safety net behind the node-inspector's per-chip
    // remove button. Roster-based, so it stays out of the pure normalizeHumans.
    normHumans = pruneOrphanHumanConsumes(normalizeHumans(humans || []), new Set(listAgentDirs()));
  }

  // ── Assist synthesis provider, team-agent only (#1213) ────────────────────
  // Names the provider the orchestrator's autonomous synthesis (curator
  // auto-promotion, skill distillation) bills against; `''`/`null` clears it
  // (→ .env fallback). Validated here — up front, so a bad shape can't
  // half-apply — against the team's USABLE providers (non-oauth), the same set
  // usableEndpointsForTeam exposes to the console header selector. A stale/
  // foreign/oauth id is rejected 400 rather than silently ignored.
  let normAssistEndpointId; // undefined = untouched, null = clear
  if (assistLlmEndpointId !== undefined) {
    if (cfg.role !== 'team') {
      return res.status(400).json({ error: 'assistLlmEndpointId is only settable on a team agent' });
    }
    if (assistLlmEndpointId === null || assistLlmEndpointId === '') {
      normAssistEndpointId = null;
    } else if (typeof assistLlmEndpointId !== 'string') {
      return res.status(400).json({ error: 'assistLlmEndpointId must be a string endpoint id (or null to clear)' });
    } else {
      const tenant = agentTeamId(cfg);
      const ep = usableEndpointsForTeam(tenant).find(e => e.id === assistLlmEndpointId);
      if (!ep) {
        return res.status(400).json({ error: `assistLlmEndpointId '${assistLlmEndpointId}' is not a provider usable by this team` });
      }
      if (ep.authType === 'oauth-token') {
        return res.status(400).json({ error: 'assistLlmEndpointId cannot be an oauth-token provider (subscription seats are not billable for server-side synthesis)' });
      }
      normAssistEndpointId = assistLlmEndpointId;
    }
  }

  // Config-write authorization (#989): editing an agent requires management
  // rights over its owning team — not mere visibility. Re-parenting to another
  // team additionally requires management rights over the destination team, so a
  // Team Admin can't move an agent into a team they don't administer.
  const scope = getScope(req);
  if (!canManageAgent(scope, agentMetaForScope(cfg))) {
    return res.status(403).json({ error: 'forbidden', code: 'forbidden' });
  }
  if (teamId !== undefined && teamId !== (cfg.teamId || 'default')
      && !canManageAgent(scope, { teamId })) {
    return res.status(403).json({ error: 'forbidden', code: 'forbidden' });
  }

  // Validate the structured OUTCOMES port (#827) up front so a bad shape can't
  // half-apply. `null`/[]/{} clears it (handled at persist below); a non-empty
  // port must pass validateOutcomes (rejects flagged human-gate labels, duplicate
  // option ids, unknown action types).
  if (isAuthoredOutcomes(outcomes)) {
    // Gate-ness is configuration (#928): validate against the owning team's
    // persisted label registry, not against the label's name.
    // `agents` + `roleId` (#2030) are what let the wakeAgent rules resolve a
    // direct hand-off's target on a LIVE team — here `to` is a member id, so
    // the index is the install's agents and the producer is this agent itself.
    const vo = validateOutcomes(outcomes, {
      labels: teamLabelRegistry(cfg.parentTeamId),
      agents: wakeTargetAgentIndex(),
      roleId: id,
    });
    if (!vo.ok) return res.status(400).json({ error: `Invalid outcomes: ${vo.error}` });
  }

  // Reject a newly-introduced unknown skill name on a grant save (#633) — a
  // typo can no longer become a silent dead grant. Names already present in the
  // construct's prior grant are preserved (flagged in the UI, never dropped).
  // Validate before any mutation so a bad grant can't half-apply.
  {
    const known = knownSkillNamesFor(cfg.teamId);
    if (Array.isArray(skills) && cfg.role !== 'team-member') {
      const v = skillGrantValidate.validateGrantNames(skills, known, cfg.skills);
      if (!v.ok) return res.status(400).json({ error: `Unknown skill(s): ${v.unknown.join(', ')} — pick from the list or create them first.` });
    }
    if (Array.isArray(skillsOverride) && cfg.role === 'team-member') {
      const v = skillGrantValidate.validateGrantNames(skillsOverride, known, cfg.skillsOverride);
      if (!v.ok) return res.status(400).json({ error: `Unknown skill(s): ${v.unknown.join(', ')} — pick from the list or create them first.` });
    }
  }

  // Enable/disable goes through the orchestrator so stubs (no token yet)
  // get fully materialized — Matrix user, workspace seeding, agent-runner
  // process — on first activation. For already-materialized agents this
  // just (re)spawns or stops the runner.
  if (enabled !== undefined && enabled !== (cfg.enabled !== false)) {
    const orchestratorUrl = process.env.ORCHESTRATOR_URL || 'http://orchestrator:4002';
    const action = enabled ? 'enable' : 'disable';
    try {
      // When disabling, forward an explicit mode ('drain' or 'abort') if the
      // caller supplied one. Without a mode the orchestrator may return 409
      // with a warning payload — relay that directly to the frontend so the
      // UI can present the drain-vs-abort choice to the user.
      const fetchOpts = { method: 'POST' };
      if (action === 'disable' && disableMode) {
        fetchOpts.headers = { 'Content-Type': 'application/json' };
        fetchOpts.body = JSON.stringify({ mode: disableMode });
      }
      const resp = await fetch(
        `${orchestratorUrl}/internal/agents/${encodeURIComponent(id)}/${action}`,
        fetchOpts,
      );
      const data = await resp.json();
      if (!resp.ok) return res.status(resp.status).json(data);
      // Re-read the updated config — orchestrator wrote the canonical version.
      // On enable, eagerly provision the DM room so the agent is ready before
      // the first message (#184). Best-effort — never blocks the enable result.
      if (action === 'enable') await preCreateAgentDmRoom(id, 'enable');
    } catch (err) {
      return res.status(502).json({ error: `Orchestrator unreachable: ${err.message}` });
    }
  }

  // Team prompt edit: route through the orchestrator so the new template gets
  // pushed to all inheriting members in the same call (their AGENT-PROMPT.md
  // and CLAUDE.md are rewritten in place — see updateTeamPrompt).
  if (cfg.role === 'team' && typeof systemPromptTemplate === 'string') {
    // #990: snapshot the previous template before the orchestrator overwrites it.
    if (systemPromptTemplate !== (cfg.systemPromptTemplate || '')) {
      captureAuthoredPromptEdit(id, {
        field: 'systemPromptTemplate',
        oldContent: typeof cfg.systemPromptTemplate === 'string' ? cfg.systemPromptTemplate : '',
        newContent: systemPromptTemplate, req, action: 'edited',
      });
    }
    const orchestratorUrl = process.env.ORCHESTRATOR_URL || 'http://orchestrator:4002';
    try {
      const resp = await fetch(`${orchestratorUrl}/internal/teams/${encodeURIComponent(id)}/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ systemPromptTemplate }),
      });
      const data = await resp.json();
      if (!resp.ok) return res.status(resp.status).json(data);
    } catch (err) {
      return res.status(502).json({ error: `Orchestrator unreachable: ${err.message}` });
    }
  }

  // Apply the rest of the field updates directly to the on-disk config.
  // (The orchestrator's enable/disable already wrote enabled itself; the
  // team-prompt branch above also wrote canonically.)
  const fresh = readJsonFile(cfgPath, cfg);
  if (displayName !== undefined) fresh.displayName = displayName;
  if (role !== undefined) fresh.role = role;
  // ── Team-owned skill grant (skill-grants.js) ──────────────────────────────
  // `skills` lives on the construct itself: a team agent carries the team's
  // ACTIVE skill set (inherited by every member without a skillsOverride), a
  // standalone agent its own list. The Working Environment no
  // longer carries skills. Propagation to already-materialized workspaces is
  // lazy (next re-seed/enable) — the Knowledge activation flow adds the eager
  // sync in a later phase. Members use skillsOverride below instead.
  if (skills !== undefined && fresh.role !== 'team-member') {
    fresh.skills = Array.isArray(skills)
      ? skills.filter(s => typeof s === 'string' && s.trim()).map(s => s.trim())
      : [];
  }
  // Legacy `emits` input: lift to outcomes on write (#831). Ignored when `outcomes`
  // is also in the request (outcomes wins). Non-empty emits create a degenerate
  // anyOf outcomes unless the agent already has authored outcomes (those take
  // priority). `null`/[] clears only the flat field; empty/clear does not touch
  // any existing outcomes port.
  if (emits !== undefined && outcomes === undefined) {
    const validEmits = Array.isArray(emits) ? emits.filter(e => typeof e === 'string' && e) : [];
    if (validEmits.length && !isAuthoredOutcomes(fresh.outcomes)) {
      fresh.outcomes = normalizeOutcomes({
        mode: 'anyOf',
        options: validEmits.map(l => ({ id: l, title: l, actions: [{ type: 'setLabel', label: l }] })),
      });
    }
    delete fresh.emits;
  }

  // ── Structured OUTCOMES port (#827) ───────────────────────────────────────
  // The successor to `emits`: writing a non-empty outcomes port persists it and
  // CLEARS `emits` (the two never coexist on a config). An empty/null/malformed
  // value clears `outcomes` and leaves any `emits` set above untouched. Both
  // fields are accepted during coexistence — outcomes wins when present.
  let outcomesChanged = false;
  if (outcomes !== undefined) {
    if (isAuthoredOutcomes(outcomes)) {
      fresh.outcomes = normalizeOutcomes(outcomes);
      delete fresh.emits;
    } else {
      delete fresh.outcomes;
    }
    outcomesChanged = true;
  }

  // ── Unified orchestration edges (Process Canvas) ──────────────────────────
  // The declarative data-flow ports are the single source of truth for the
  // dependency + data-flow edges in the Flows graph — the same shape a draft
  // bundle carries on its roles. Writing them here lets the process editor wire
  // a live team exactly like a draft; the functional push triggers are re-derived
  // from these ports below (reconcileTeamDataFlow), mirroring materialise time.
  let dataFlowChanged = false;
  if (dataFlow !== undefined) {
    // An artifact port is matched by its logical `name` when set, else by `path`
    // (#382). Keep whichever of name/path/hint the caller supplied, requiring at
    // least one of name or path so the port has a match key.
    const normArtifacts = (arr) => (Array.isArray(arr) ? arr : [])
      .map(a => (typeof a === 'string' ? { path: a } : a))
      .filter(a => a && typeof a === 'object')
      .map(a => {
        const name = typeof a.name === 'string' ? a.name.trim() : '';
        const hint = typeof a.hint === 'string' ? a.hint.trim() : '';
        const p = typeof a.path === 'string' ? a.path.trim() : '';
        return {
          ...(name ? { name } : {}),
          ...(hint ? { hint } : {}),
          ...(p ? { path: p } : {}),
          ...(a.description ? { description: a.description } : {}),
          // Artifact audience (#981): 'human' declares a person consumes this
          // output (delivery touchpoint) — the only supported value.
          ...(a.audience === 'human' ? { audience: 'human' } : {}),
          // Open-end markers (#1004, concept §4.7): terminal XOR external.
          ...(a.terminal === true ? { terminal: true } : {}),
          ...(a.terminal !== true && a.external && typeof a.external === 'object' && !Array.isArray(a.external)
            ? { external: {
                ...(typeof a.external.note === 'string' && a.external.note.trim()
                  ? { note: a.external.note.trim() } : {}),
              } }
            : {}),
        };
      })
      .filter(a => a.name || a.path);
    const normDeps = (arr) => [...new Set((Array.isArray(arr) ? arr : [])
      .filter(d => typeof d === 'string' && d && d !== id))];
    const next = {};
    const inputs = normArtifacts(dataFlow && dataFlow.inputs);
    const outputs = normArtifacts(dataFlow && dataFlow.outputs);
    const dependsOn = normDeps(dataFlow && dataFlow.dependsOn);
    if (inputs.length) next.inputs = inputs;
    if (outputs.length) next.outputs = outputs;
    if (dependsOn.length) next.dependsOn = dependsOn;
    if (Object.keys(next).length) fresh.dataFlow = next; else delete fresh.dataFlow;
    dataFlowChanged = true;
  }

  // Parent-child hierarchy (#377). `null`/'' clears; a member id sets it, guarded
  // against self- and ancestor-cycles among the team's members.
  if (parentMemberId !== undefined) {
    if (typeof parentMemberId === 'string' && parentMemberId) {
      if (parentWouldCycle(fresh.parentTeamId, id, parentMemberId)) {
        return res.status(400).json({ error: 'that would create a parent cycle' });
      }
      fresh.parentMemberId = parentMemberId;
    } else {
      delete fresh.parentMemberId;
    }
  }

  // Process stage band (#362 E). Empty clears (inherits from parent).
  if (stage !== undefined) {
    if (typeof stage === 'string' && stage.trim()) fresh.stage = stage.trim();
    else delete fresh.stage;
  }

  // Ordered stage list, team-agent only (#674). Mirrors the draft bundle's
  // `stages[]`; live stage-management writes it via liveOps. Display-only —
  // no runtime side-effect. Trimmed + de-duplicated, order preserved; an empty
  // array clears the list (the "no stages defined" state). Ignored for
  // non-team agents (per-agent bands stay on the singular `stage` above).
  if (stages !== undefined && fresh.role === 'team') {
    fresh.stages = Array.isArray(stages)
      ? [...new Set(stages.filter(s => typeof s === 'string' && s.trim()).map(s => s.trim()))]
      : [];
  }

  // Label registry, team-agent only (#981) — validated into normLabels above.
  // Mirrors the bundle's `labels[]`; `teamLabelRegistry` reads it for gate/brake
  // classification on every live graph build. Display/lint-only — no runtime
  // side-effect. `null`/[] clears the registry.
  if (labels !== undefined && fresh.role === 'team') {
    if (normLabels && normLabels.length) fresh.labels = normLabels;
    else delete fresh.labels;
  }

  // Admission control, team-agent only (#2114) — the declarative per-flow WIP
  // limit the orchestrator's dispatch path enforces. Mirrors the bundle's
  // `wipLimit`; unlike `stages`/`labels` this one DOES have a runtime effect, so
  // an unusable value must not half-apply: a positive integer sets the limit,
  // `null`/`0`/absent-from-the-body semantics are split — `null` explicitly
  // clears it (back to unbounded dispatch), anything else invalid is refused.
  if (wipLimit !== undefined && fresh.role === 'team') {
    if (wipLimit === null) delete fresh.wipLimit;
    else {
      const norm = normalizeWipLimit(wipLimit);
      if (!norm) return res.status(400).json({ error: 'wipLimit must be a positive integer, or null to remove the limit' });
      fresh.wipLimit = norm;
    }
  }

  // Named human roles, team-agent only (#987) — validated into normHumans above.
  // Mirrors the bundle's `humans[]`; `teamHumansRegistry` reads it so the live
  // graph binds the #981 touchpoints to the named nodes. No trigger side-effect
  // (AC9), but a reviewer/gate binding feeds the generated Outcomes prompt
  // block (#1007) — reconciled below.
  let humansChanged = false;
  if (humans !== undefined && fresh.role === 'team') {
    const before = JSON.stringify(fresh.humans || []);
    if (normHumans && normHumans.length) fresh.humans = normHumans;
    else delete fresh.humans;
    humansChanged = JSON.stringify(fresh.humans || []) !== before;
  }

  // Assist synthesis provider, team-agent only (#1213) — validated into
  // normAssistEndpointId above. Read by the orchestrator's
  // resolveAssistBindingForTeam; null/'' clears it (→ .env). No runtime respawn:
  // it is read fresh on each autonomous synthesis pass.
  if (normAssistEndpointId !== undefined && fresh.role === 'team') {
    if (normAssistEndpointId) fresh.assistLlmEndpointId = normAssistEndpointId;
    else delete fresh.assistLlmEndpointId;
  }

  // ── GitHub artifact ports (#380) ──────────────────────────────────────────
  // Produce flags (opens PRs/issues) drive the node badge/ports + the producer
  // instruction block; consumed channels drive the on:'github' edges and the
  // derived github-event triggers (re-derived below via reconcileTeamGithubChannels).
  let githubChanged = false;
  if (github !== undefined) {
    const g = github && typeof github === 'object' ? github : {};
    const next = {};
    if (g.producesPr) next.producesPr = true;
    if (g.producesIssue) next.producesIssue = true;
    // Artifact audience (#981): 'human' declares that a person (review/merge)
    // consumes the artifact — the only supported value; anything else is
    // dropped (= unspecified). Meaningless without the produce flag.
    if (next.producesPr && g.prAudience === 'human') next.prAudience = 'human';
    if (next.producesIssue && g.issueAudience === 'human') next.issueAudience = 'human';
    if (Object.keys(next).length) fresh.github = next; else delete fresh.github;
    githubChanged = true;
  }
  let channelsChanged = false;
  if (channels !== undefined) {
    const norm = (Array.isArray(channels) ? channels : [])
      .filter(c => c && (c.artifact === 'pr' || c.artifact === 'issue')
        && typeof c.from === 'string' && c.from && c.from !== id)
      .map(c => ({
        artifact: c.artifact, from: c.from,
        ...(typeof c.label === 'string' && c.label.trim() ? { label: c.label.trim() } : {}),
        ...(c.gate === 'human' ? { gate: 'human' } : {}),
        // Claim opt-out (#958) — must survive the live port write, otherwise
        // reconcileTeamGithubChannels re-stamps the claim the author just turned
        // off. Only the non-default is persisted.
        ...(c.autoClaim === false ? { autoClaim: false } : {}),
        // Internal-channel transport (#1194) — must survive the live port write so
        // reconcileTeamGithubChannels re-derives an internal (poller-excluded)
        // listener. Only meaningful on a labelled, non-human channel; anything else
        // stays poller-delivered, so a stray `transport` on those is dropped here.
        ...(c.transport === 'internal' && typeof c.label === 'string' && c.label.trim() && c.gate !== 'human'
          ? { transport: 'internal' } : {}),
      }));
    if (norm.length) fresh.channels = norm; else delete fresh.channels;
    channelsChanged = true;
  }

  // Reassign the agent to a human Team (#308). Validates against existing
  // teams; metadata-only, so no respawn is needed. When the target is an Agent
  // Team (`role: "team"`) the assignment cascades to every member below (#568)
  // so a knowledge-sharing squad can never be split across tenant Teams.
  let cascadeTeamId = false;
  if (teamId !== undefined) {
    try { fresh.teamId = resolveOwnerTeamId(teamId); }
    catch (err) { return res.status(err.status || 400).json({ error: err.message }); }
    cascadeTeamId = fresh.role === 'team';
  }

  // Team-member inheritance toggles. `null` means "switch to inherit"
  // (delete the field); a string / array means "set the override".
  let promptOverrideChanged = false;
  if (fresh.role === 'team-member') {
    // System-prompt mode (#1511). An explicit `promptMode` selects one of the
    // three modes; an older client that sends only `systemPrompt` is mapped the
    // legacy way (null → inherit, string → exclusive) so nothing regresses (AC7).
    const modeGiven = promptMode === PROMPT_MODES.INHERIT
      || promptMode === PROMPT_MODES.ADDITIONAL
      || promptMode === PROMPT_MODES.EXCLUSIVE;
    if (modeGiven || systemPrompt !== undefined) {
      let mode;
      if (modeGiven) mode = promptMode;
      else if (systemPrompt === null) mode = PROMPT_MODES.INHERIT;
      else mode = PROMPT_MODES.EXCLUSIVE;

      if (mode === PROMPT_MODES.INHERIT) {
        delete fresh.systemPrompt;
        delete fresh.promptMode;
      } else if (mode === PROMPT_MODES.ADDITIONAL) {
        // The agent-specific addition; empty is allowed (composes to the team
        // template alone, AC8). `promptMode` is persisted because this state
        // cannot be inferred from systemPrompt presence.
        fresh.systemPrompt = typeof systemPrompt === 'string' ? systemPrompt : '';
        fresh.promptMode = PROMPT_MODES.ADDITIONAL;
      } else {
        // Exclusive (the renamed "Custom"). Keep the legacy shape — no
        // `promptMode` field — so an existing custom member stays byte-identical
        // (AC6/AC7).
        fresh.systemPrompt = typeof systemPrompt === 'string'
          ? systemPrompt
          : (typeof cfg.systemPrompt === 'string' ? cfg.systemPrompt : '');
        delete fresh.promptMode;
      }
      promptOverrideChanged = true;
    }
    if (skillsOverride === null) {
      delete fresh.skillsOverride;
    } else if (Array.isArray(skillsOverride)) {
      fresh.skillsOverride = skillsOverride;
    }
    if (mcpServersOverride === null) {
      delete fresh.mcpServersOverride;
    } else if (mcpServersOverride !== undefined) {
      try {
        fresh.mcpServersOverride = normalizeMcpServersInput(mcpServersOverride);
      } catch (err) {
        return res.status(400).json({ error: err.message });
      }
    }
  }

  writeJsonAtomic(cfgPath, fresh);

  // Cascade an Agent-Team tenant reassignment to every member (#568). The
  // parent team agent's `teamId` was just written; stamp the same tenant on
  // each `team-member` whose `parentTeamId` points at it so the squad moves as
  // one unit and can never be split across tenants. teamId is metadata-only, so
  // each member write is just a config stamp + reload — no respawn. Partial
  // failures are surfaced (not swallowed) so the UI can report a split (E4).
  if (cascadeTeamId) {
    const memberConfigs = listAgentDirs()
      .map(mid => ({ id: mid, ...readJsonFile(path.join(AGENTS_DIR, mid, 'config.json'), {}) }));
    const members = membersOfTeam(memberConfigs, id);
    const movedMembers = [];
    const failedMembers = [];
    for (const member of members) {
      if (member.teamId === fresh.teamId) { movedMembers.push(member.id); continue; }
      try {
        const memberCfgPath = path.join(AGENTS_DIR, member.id, 'config.json');
        const memberFresh = readJsonFile(memberCfgPath, null);
        if (!memberFresh) { failedMembers.push(member.id); continue; }
        memberFresh.teamId = fresh.teamId;
        writeJsonAtomic(memberCfgPath, memberFresh);
        notifyAgentReload(member.id);
        movedMembers.push(member.id);
      } catch (err) {
        console.error(`[API] Failed to cascade teamId to member ${member.id}: ${err.message}`);
        failedMembers.push(member.id);
      }
    }
    if (failedMembers.length) {
      return res.status(500).json({
        error: `Reassigned the Agent Team but failed to move ${failedMembers.length} member(s): ${failedMembers.join(', ')}. The squad is split across tenants — retry to resolve.`,
        teamId: fresh.teamId,
        movedMembers,
        failedMembers,
      });
    }
  }
  // A team-member's own prompt override was toggled/edited (#510). Because
  // CLAUDE.md now references the prompt via `@AGENT-PROMPT.md`, the effective
  // prompt lives solely in AGENT-PROMPT.md — we only rewrite that file (CLAUDE.md
  // is static and never rebuilt for a prompt change). Resolve the effective
  // prompt (the override string, or — when switching back to inherit — the
  // parent team's systemPromptTemplate), mirror it into the agent's volume, and
  // wake the agent so the next session reads it.
  if (promptOverrideChanged) {
    // #990: version the member's authored OVERRIDE (the field the human edits).
    // Setting an override → 'edited'; switching back to inherit (systemPrompt
    // cleared) → 'inherited' with empty content. cfg still holds the pre-edit
    // override here (fresh was written above; cfg was read before that).
    const prevOverride = (typeof cfg.systemPrompt === 'string') ? cfg.systemPrompt : '';
    const nextOverride = (typeof fresh.systemPrompt === 'string') ? fresh.systemPrompt : '';
    // #1511: version on an authored-text change OR a mode switch, so switching
    // between the three modes is recorded consistently with inherit/edit (AC12).
    const prevMode = resolvePromptMode(cfg);
    const nextMode = resolvePromptMode(fresh);
    if (prevOverride !== nextOverride || prevMode !== nextMode) {
      captureAuthoredPromptEdit(id, {
        field: 'systemPrompt', oldContent: prevOverride, newContent: nextOverride, req,
        action: nextMode === PROMPT_MODES.INHERIT ? 'inherited' : 'edited',
        ...(prevMode !== nextMode ? { note: `prompt mode ${prevMode} → ${nextMode}` } : {}),
      });
    }
    // Compose the effective prompt from the resolved mode (#1511): inherit → the
    // team template; additional → team template + delimited addition; exclusive
    // → the member's own text verbatim.
    let teamTemplate = '';
    if (fresh.parentTeamId) {
      const teamCfg = readJsonFile(path.join(AGENTS_DIR, fresh.parentTeamId, 'config.json'), null);
      if (teamCfg && typeof teamCfg.systemPromptTemplate === 'string') {
        teamTemplate = teamCfg.systemPromptTemplate;
      }
    }
    const resolvedPrompt = composeMemberPrompt(nextMode, teamTemplate, nextOverride);
    const promptPath = path.join(agentDir, 'AGENT-PROMPT.md');
    try {
      const tmp = promptPath + '.tmp';
      fs.writeFileSync(tmp, resolvedPrompt, 'utf8');
      fs.renameSync(tmp, promptPath);
      notifyAgentReseed(id, ['AGENT-PROMPT.md']);
    } catch (err) {
      console.error(`[API] Failed to write AGENT-PROMPT.md for ${id}: ${err.message}`);
    }
  }
  // A data-flow port change re-derives the team's functional push triggers so a
  // live edit takes effect at runtime without a re-materialise (best-effort).
  if (dataFlowChanged && fresh.parentTeamId) {
    await reconcileTeamDataFlow(fresh.parentTeamId);
  }
  // A channel-port change re-derives the team's functional github-event triggers
  // so a live edit takes effect at runtime without a re-materialise (#380). The
  // produce-flag change refreshes the producer block on the next member rebuild
  // (lazy, per the team-env convention) — the flag itself already drives the
  // graph badge + lints immediately.
  if (channelsChanged && fresh.parentTeamId) {
    await reconcileTeamGithubChannels(fresh.parentTeamId);
  }
  // An outcomes-port change re-renders the team's generated `## Outcomes` prompt
  // block (#829) into each affected member's AGENT-PROMPT.md and mirrors it into
  // the isolated volume, so a live edit takes effect without a re-materialise —
  // the prompt-side analogue of the channel/data-flow reconcilers above. The
  // reconciler re-applies BOTH derived blocks (github-io + outcomes) from the
  // stored ports, so openPr/openIssue coexistence stays correct here too; a
  // github-flag-only change keeps the produce block's established lazy refresh.
  if (outcomesChanged && fresh.parentTeamId) {
    await reconcileTeamOutcomes(fresh.parentTeamId);
    // A `wakeAgent` action lives on the same port (#2031), and unlike every
    // other action it needs a RUNTIME listener on its target — without this the
    // hand-off is drawn on the canvas, projected into the producer's prompt, and
    // then dropped by the target's runner as "no enabled wake-agent trigger".
    // Keyed on the same flag rather than on a wake-specific diff: the whole team
    // is re-derived either way, and a no-op member write is already skipped.
    await reconcileTeamWakeHandoffs(fresh.parentTeamId);
  }
  // A humans-registry change on the TEAM agent (reviewer/gate bindings) feeds
  // the members' generated Outcomes blocks (#1007) — re-render them.
  if (humansChanged && fresh.role === 'team') {
    await reconcileTeamOutcomes(id);
  }
  // Wake a running agent so it re-pulls config promptly under volume isolation
  // (#185 Phase 2). On the shared volume the agent re-reads config.json on its
  // next action anyway, so this is just a harmless idempotent re-sync there.
  notifyAgentReload(id);
  res.json({ id, ...fresh });
});

/* ─── Convert a standalone agent into a team of one (#2052) ─────────── */

// The launcher has promised since #1667 that "a single agent is simply a team of
// one"; this is the action that makes it true, in place, for one agent the user
// already has. Thin proxy on purpose: eligibility, the derived team id and every
// re-keying decision live in the orchestrator (`team-conversion.js`), which is
// the only process that can rewrite the prompt file, re-mint plugin scopes and
// respawn the container. Duplicating the rule here would only let the two drift.
app.post('/api/agents/:id/convert-to-team', heavyLimiter, async (req, res) => {
  const { id } = req.params;
  if (!AGENT_ID_RE.test(id)) return res.status(400).json({ error: 'Invalid agent id' });
  const cfg = readJsonFile(path.join(AGENTS_DIR, id, 'config.json'), null);
  if (!cfg) return res.status(404).json({ error: 'Agent not found' });
  // Two gates, because the conversion does two things: it edits this agent AND
  // it creates a team in its tenant. A caller who may do the first but not the
  // second (the ticket's own edge case) must be refused, so the tenant check is
  // made without the ownership escape hatch `agentMetaForScope` grants.
  //
  // #2078: this second gate deliberately stays on the legacy access scope. It
  // asks "may you mint a team here", and team creation is System-Admin-only
  // until P3 makes it self-service — so it is the one place the collapsed
  // boundary must NOT be used, or a standalone agent's owner (who now passes the
  // first gate under D8) could convert their way into owning a team.
  if (denyUnlessCanManageAgent(req, res, { ...cfg, id })) return;
  if (!canManageAgent(getScope(req), { teamId: agentTeamId({ ...cfg, id }) })) {
    return res.status(403).json({ error: 'forbidden', code: 'forbidden' });
  }

  const orchestratorUrl = process.env.ORCHESTRATOR_URL || 'http://orchestrator:4002';
  try {
    const resp = await fetch(
      `${orchestratorUrl}/internal/agents/${encodeURIComponent(id)}/convert-to-team`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force: req.body?.force === true }),
      },
    );
    const data = await resp.json();
    // A 409 carrying `warning` is the busy-agent refusal, not a failure —
    // forward it verbatim so the UI can offer to convert anyway.
    if (!resp.ok) return res.status(resp.status).json(data);
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: `Orchestrator unreachable: ${err.message}` });
  }
});

/* ─── Reset agent to stub state ─────────────────────────────────────── */

app.post('/api/agents/:id/deactivate', apiLimiter, async (req, res) => {
  const { id } = req.params;
  if (!AGENT_ID_RE.test(id)) return res.status(400).json({ error: 'Invalid agent id' });
  const orchestratorUrl = process.env.ORCHESTRATOR_URL || 'http://orchestrator:4002';
  try {
    const { mode } = req.body || {};
    const fetchOpts = { method: 'POST' };
    if (mode) {
      fetchOpts.headers = { 'Content-Type': 'application/json' };
      fetchOpts.body = JSON.stringify({ mode });
    }
    const resp = await fetch(
      `${orchestratorUrl}/internal/agents/${encodeURIComponent(id)}/deactivate`,
      fetchOpts,
    );
    const data = await resp.json();
    // Forward 409 warning payloads to the frontend so the UI can present the
    // drain-vs-hard-stop choice to the user.
    if (!resp.ok) return res.status(resp.status).json(data);
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: `Orchestrator unreachable: ${err.message}` });
  }
});

/* ─── STILLED: BP-instance hand-off — decision pending in #1968 ─────────
 *
 * These four routes are RETAINED but UNREACHABLE. Epic #1961 (remove the
 * BriefingPack model) decided in R4 that the hand-off mechanism keeps its code
 * in the tree with the user interface disconnected, so it can be revived
 * rather than rebuilt; phase #1962 removed the two BriefingPack agent roles,
 * and every route below requires `role === 'bp-instance'`, which the platform
 * can no longer assign. So they answer 409 for any agent that exists.
 *
 *   • #1968 is the ticket that decides their future (revive against the
 *     Flow/Team model, or delete).
 *   • #1528 (direct agent-to-agent messaging) is where the idea lives on
 *     conceptually.
 *   • Do NOT "fix" the bp-instance guards to accept a live role — that is a
 *     product decision #1968 owns, not a code cleanup.
 *
 * One behaviour did change rather than freeze: `candidates.suggested` used to
 * be derived from the bp-explorer briefings dependency graph, which #1962
 * removed; the orchestrator now always returns an empty `suggested` and only
 * `siblings` is populated. See `handoverCandidates` in orchestrator.js.
 *
 * Routes:
 *   GET  /api/agents/:id/handover/candidates  → orchestrator computes
 *        sibling targets (`suggested` always empty since #1962). Proxy only.
 *   GET  /api/agents/:id/handover/git-status  → per-repo commit/push state
 *        of the source agent's workspace, used by the dialog's pre-flight.
 *        Proxy only.
 *   POST /api/agents/:id/handover/nudge       → posts a canned "commit"/
 *        "push" prompt into the source agent's own DM so the agent itself
 *        does the git work. Keeps the audit trail in chat.
 *   POST /api/agents/:id/handover             → fan-out. The orchestrator
 *        re-fetches git-status server-side and refuses unless every repo
 *        is `ready` *or* the caller passes `override: { reason }`. For
 *        each target we (1) materialize/enable via orchestrator,
 *        (2) ensure a DM room with the admin, (3) send a structured
 *        m.text DM containing source-of-work coordinates + the user's
 *        free-text note + onboarding steps. The receiving agent's DM
 *        handler picks it up like any other user message.
 *
 * Submit body shape:
 *   {
 *     targets: [agentId, ...],            // required, non-empty
 *     note: string,                        // optional shared free-text
 *     perTarget: { agentId: noteOverride } // optional, overrides note
 *     override: { reason: string } | null  // required if any source repo is not ready
 *   }
 */

const ORCH_URL = () => process.env.ORCHESTRATOR_URL || 'http://orchestrator:4002';

async function fetchHandoverCandidates(sourceId) {
  const resp = await fetch(`${ORCH_URL()}/internal/agents/${encodeURIComponent(sourceId)}/handover-candidates`);
  if (!resp.ok) return null;
  return resp.json().catch(() => null);
}

async function fetchSourceGitStatus(sourceId) {
  const resp = await fetch(`${ORCH_URL()}/internal/agents/${encodeURIComponent(sourceId)}/workspace/git-status`);
  if (!resp.ok) return null;
  return resp.json().catch(() => null);
}

// Compare the source's workspace repos against a target environment's repo
// list. Returns warning strings the target should know about (missing repo,
// different branch, …). Pure data — never throws.
function repoConsistencyWarnings(sourceRepos, targetEnv) {
  const warnings = [];
  const targetRepos = Array.isArray(targetEnv?.repositories) ? targetEnv.repositories : [];
  for (const src of sourceRepos) {
    if (!src?.url) continue;
    const match = targetRepos.find((r) => r?.url === src.url);
    if (!match) {
      warnings.push(`Target environment does not include repo \`${src.url}\` — the receiving agent will not see this code without an env update.`);
      continue;
    }
    if (src.branch && match.branch && src.branch !== match.branch) {
      warnings.push(`Branch mismatch on \`${src.name || src.url}\`: source is on \`${src.branch}\`, target environment defaults to \`${match.branch}\`. The receiving agent will need to \`git checkout ${src.branch}\` first.`);
    }
  }
  return warnings;
}

// Build the structured Markdown body that goes into a target's DM. Plain
// text fallbacks are safe — the markdown renders in Element & the chat UI,
// and degrades gracefully for any client that ignores it.
function renderHandoverBody({ headerLine, repos, suggestedRow, noteText, override, consistencyWarnings }) {
  const lines = [headerLine, ''];

  const reportable = repos.filter((r) => r.exists);
  if (reportable.length > 0) {
    lines.push('**Source of work**');
    for (const r of reportable) {
      const branch = r.branchActual || r.branch || '(no branch)';
      const head = r.headShort ? ` @ \`${r.headShort}\`` : '';
      const subject = r.headSubject ? ` — _${r.headSubject}_` : '';
      lines.push(`- **${r.name}** — \`${branch}\`${head}${subject}`);
      if (r.remoteUrl) lines.push(`  - remote: \`${r.remoteUrl}\``);
      if (r.upstream) lines.push(`  - upstream: \`${r.upstream}\` (ahead ${r.ahead ?? '?'}, behind ${r.behind ?? '?'})`);
      if (!r.clean) {
        const parts = [];
        if (r.dirty.staged)    parts.push(`${r.dirty.staged} staged`);
        if (r.dirty.unstaged)  parts.push(`${r.dirty.unstaged} unstaged`);
        if (r.dirty.untracked) parts.push(`${r.dirty.untracked} untracked`);
        lines.push(`  - ⚠ uncommitted: ${parts.join(', ')}`);
      }
    }
    lines.push('');
  }

  if (suggestedRow?.reason === 'input-artifact' && Array.isArray(suggestedRow.paths) && suggestedRow.paths.length > 0) {
    lines.push('**Concrete inputs (from BP graph)**');
    for (const p of suggestedRow.paths) lines.push(`- \`${p}\``);
    lines.push('');
  }

  if (noteText) {
    lines.push('**Note from upstream**', noteText, '');
  }

  if (override?.reason) {
    lines.push(`**⚠ Hand-off override** — upstream had unfinished git state. Reason: ${override.reason}`, '');
  }

  if (consistencyWarnings.length > 0) {
    lines.push('**Heads-up**');
    for (const w of consistencyWarnings) lines.push(`- ${w}`);
    lines.push('');
  }

  if (reportable.length > 0) {
    lines.push('**Before you start**');
    let step = 1;
    for (const r of reportable) {
      const branch = r.branchActual || r.branch;
      if (!branch || branch === 'HEAD') continue;
      lines.push(`${step}. \`cd ${r.name} && git fetch && git checkout ${branch} && git pull --ff-only\``);
      step++;
    }
    if (step === 1) {
      lines.push('1. Sync your repo clones (`git fetch && git pull --ff-only`) before reading any files.');
    }
    lines.push(`${step}. Skim \`git log --oneline -5\` in each repo so you know exactly which commits are yours to build on.`);
    lines.push(`${step + 1}. Read your own brief and confirm with the user before making changes.`);
  } else {
    lines.push('Please begin your part of the work — your brief has the full context.');
  }

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

app.get('/api/agents/:id/handover/candidates', apiLimiter, async (req, res) => {
  const { id } = req.params;
  if (!AGENT_ID_RE.test(id)) return res.status(400).json({ error: 'Invalid agent id' });
  try {
    const resp = await fetch(`${ORCH_URL()}/internal/agents/${encodeURIComponent(id)}/handover-candidates`);
    const data = await resp.json();
    if (!resp.ok) return res.status(resp.status).json(data);
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: `Orchestrator unreachable: ${err.message}` });
  }
});

app.get('/api/agents/:id/handover/git-status', heavyLimiter, async (req, res) => {
  const { id } = req.params;
  if (!AGENT_ID_RE.test(id)) return res.status(400).json({ error: 'Invalid agent id' });
  try {
    const resp = await fetch(`${ORCH_URL()}/internal/agents/${encodeURIComponent(id)}/workspace/git-status`);
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) return res.status(resp.status).json(data);
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: `Orchestrator unreachable: ${err.message}` });
  }
});

/* ─── Sync repositories into existing agents (#1342) ─────────────────────────
   The Working Environment form lets you add repositories at any time, but repos
   are only cloned into an agent's workspace at creation. These endpoints clone
   the MISSING repos into existing agents (idempotent — already-cloned repos are
   left untouched) and stream one NDJSON line per repo per agent so the operator
   sees progress. Per-agent (Agent detail) + per-environment fan-out. */

// Open an NDJSON-over-chunked response for streaming per-line progress (the
// POST /api/teams/stream mould — see that handler for the flushHeaders /
// setNoDelay / res.on('close') rationale). Returns { emit, end, isAborted }.
function openNdjsonStream(res) {
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  if (typeof res.socket?.setNoDelay === 'function') res.socket.setNoDelay(true);
  let aborted = false;
  res.on('close', () => { if (!res.writableEnded) aborted = true; });
  return {
    emit(ev) { if (aborted) return; try { res.write(JSON.stringify(ev) + '\n'); } catch { /* socket gone */ } },
    end() { if (!aborted && !res.writableEnded) res.end(); },
    isAborted: () => aborted,
  };
}

const EMPTY_SYNC_SUMMARY = { total: 0, cloned: 0, adjusted: 0, skipped: 0, blocked: 0, failed: 0, retained: 0 };

// Sync one agent by calling the orchestrator's per-agent endpoint and emitting
// agent-scoped progress lines. Never throws — an orchestrator/transport error
// becomes an 'agent-error' line so a per-environment fan-out isn't aborted by a
// single bad agent. Returns { summary } for the caller to accumulate totals.
async function syncOneAgentToStream(agentId, displayName, emit) {
  emit({ type: 'agent', agentId, displayName: displayName || agentId });
  let data;
  try {
    const resp = await fetch(
      `${ORCH_URL()}/internal/agents/${encodeURIComponent(agentId)}/sync-repositories`,
      { method: 'POST' },
    );
    data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const error = (data && data.error) || `HTTP ${resp.status}`;
      emit({ type: 'agent-error', agentId, error });
      return { summary: { ...EMPTY_SYNC_SUMMARY }, repos: [], error };
    }
  } catch (err) {
    const error = `Orchestrator unreachable: ${err.message}`;
    emit({ type: 'agent-error', agentId, error });
    return { summary: { ...EMPTY_SYNC_SUMMARY }, repos: [], error };
  }
  if (data.noWorkspace) {
    // AC24: an un-materialized member has no workspace to clone into. Reported
    // as a skip with the existing reason, and it never fails the run.
    emit({ type: 'agent-skip', agentId, reason: 'no-workspace' });
    return { summary: data.summary || { ...EMPTY_SYNC_SUMMARY }, repos: [], noWorkspace: true };
  }
  const repos = Array.isArray(data.repos) ? data.repos : [];
  for (const r of repos) {
    emit({
      type: 'repo', agentId, name: r.name, url: r.url, status: r.status,
      reason: r.reason || null, detail: r.detail || null, blocked: !!r.blocked,
      applied: Array.isArray(r.applied) ? r.applied : null,
      error: r.error || null, fromCache: !!r.fromCache,
    });
  }
  const summary = data.summary || summarizeSyncRepos(repos);
  emit({ type: 'agent-done', agentId, summary });
  return { summary, repos };
}

// The D6 durable trail (#2066): one audit entry PER AGENT per propagation run.
//
// `auditMutations` already records one line per HTTP request, which for an
// environment fan-out is a single line naming neither the agents nor what
// happened in their workspaces — and the streamed report vanishes the moment
// the dialog closes. Since the propagation now MUTATES existing clones, an
// after-the-fact record of what touched which workspace stops being a nicety.
//
// Best-effort by construction (audit.record swallows its own errors): a trail
// that could fail a propagation would be worse than a missing line.
function recordRepoSyncTrail(req, { agentId, envId, repos, summary, error }) {
  const items = (Array.isArray(repos) ? repos : []).map((r) => ({
    name: r.name,
    outcome: r.status,
    ...(r.reason ? { reason: r.reason } : {}),
    ...(r.detail ? { detail: r.detail } : {}),
    ...(Array.isArray(r.applied) && r.applied.length ? { applied: r.applied } : {}),
    ...(r.error ? { error: r.error } : {}),
  }));
  audit.record({
    ts: new Date().toISOString(),
    actor: (req.user && req.user.username) || 'anonymous',
    action: 'repo-propagation',
    method: 'POST',
    resource: envId
      ? `/api/environments/${envId}/sync-agents`
      : `/api/agents/${agentId}/sync-repositories`,
    teamId: null,
    status: error ? 500 : 200,
    outcome: error ? 'error' : 'success',
    ip: req.ip,
    repoSync: {
      agentId,
      ...(envId ? { environmentId: envId } : {}),
      summary: summary || null,
      repositories: items,
      ...(error ? { agentError: error } : {}),
    },
  });
}

// Local fold, in case the orchestrator omits `summary` (defensive). Mirrors
// summarizeRepoResults in orchestrator/repo-sync.js, including `retained` being
// excluded from `total` — a clone that is no longer declared is not a unit of
// work, so counting it would inflate the progress line with a row nothing acts on.
function summarizeSyncRepos(repos) {
  const list = Array.isArray(repos) ? repos : [];
  return {
    total: list.filter((r) => r.status !== 'retained').length,
    cloned: list.filter((r) => r.status === 'cloned').length,
    adjusted: list.filter((r) => r.status === 'adjusted').length,
    skipped: list.filter((r) => r.status === 'skipped').length,
    blocked: list.filter((r) => r.status === 'skipped' && r.blocked).length,
    failed: list.filter((r) => r.status === 'failed').length,
    retained: list.filter((r) => r.status === 'retained').length,
  };
}

// Per-agent: reconcile the environment's repositories into this one agent's
// workspace — clone what is missing, adjust what diverges where that is safe.
//
// The management gate is AC23's requirement applied here too: since #2066 this
// route no longer only ADDS clones, it can also move a branch and repoint a
// remote in someone else's workspace, so read visibility is not enough. It
// carried no authorisation at all before.
app.post('/api/agents/:id/sync-repositories', heavyLimiter, async (req, res) => {
  const { id } = req.params;
  if (!AGENT_ID_RE.test(id)) return res.status(400).json({ error: 'Invalid agent id' });
  const cfg = readJsonFile(path.join(AGENTS_DIR, id, 'config.json'), null);
  const scope = getScope(req);
  if (!cfg || !visibleAgent(scope, agentMetaForScope(cfg))) return res.status(404).json({ error: 'Agent not found' });
  if (!canManageAgent(scope, agentMetaForScope(cfg))) {
    return res.status(403).json({ error: 'forbidden', code: 'forbidden' });
  }
  const stream = openNdjsonStream(res);
  try {
    stream.emit({ type: 'plan', agentCount: 1 });
    const result = await syncOneAgentToStream(id, cfg.displayName || id, stream.emit);
    recordRepoSyncTrail(req, {
      agentId: id, envId: null, repos: result.repos, summary: result.summary, error: result.error,
    });
    stream.emit({ type: 'complete', agentCount: 1, totals: result.summary });
  } catch (err) {
    stream.emit({ type: 'error', status: 500, error: err.message });
  } finally {
    stream.end();
  }
});

// Per-environment: fan the propagation out to every agent bound to the env.
//
// This is what both the save-time offer and the out-of-date indicator's
// catch-up call (#2066); the manual "Sync all agents" button that used to be
// its only caller is gone.
//
// AC23: the gate is `canManageEnvironment`, not read visibility. It used to
// check only `visibleTeam`, which let a plain Team Member fan a write out into
// other people's workspaces while `PUT`/`DELETE` on the same environment
// required team-admin — and since #2066 the fan-out can also move a branch and
// repoint a remote, not merely add a missing clone.
app.post('/api/environments/:id/sync-agents', heavyLimiter, async (req, res) => {
  const envId = normalizeEnvId(req.params.id);
  const env = loadEnvironment(envId);
  if (!env) return res.status(404).json({ error: 'Environment not found' });
  const scope = getScope(req);
  // #2083: tier-aware — a shared environment carries no `teamId`. #2158: also
  // reachable by a caller with no team assignment at all when the env is global.
  if (!visibleEnvironment(scope, env) && !isGlobalEnvironment(env)) {
    return res.status(404).json({ error: 'Environment not found' });
  }
  if (!canManageEnvironment(scope, env)) {
    return res.status(403).json({ error: 'forbidden', code: 'forbidden' });
  }
  const agents = agentsUsingEnvironment(envId, scope);
  const repoCount = (Array.isArray(env.repositories) ? env.repositories : []).length;

  const stream = openNdjsonStream(res);
  const totals = { ...EMPTY_SYNC_SUMMARY };
  try {
    stream.emit({
      type: 'plan', envId, agentCount: agents.length, repoCount,
      agents: agents.map((a) => ({ id: a.id, displayName: a.displayName })),
    });
    for (const a of agents) {
      // AC25: one bad agent aborts neither the remaining agents nor the
      // remaining repositories — syncOneAgentToStream never throws.
      if (stream.isAborted()) break;
      const result = await syncOneAgentToStream(a.id, a.displayName, stream.emit);
      recordRepoSyncTrail(req, {
        agentId: a.id, envId, repos: result.repos, summary: result.summary, error: result.error,
      });
      for (const key of Object.keys(totals)) totals[key] += result.summary[key] || 0;
    }
    stream.emit({ type: 'complete', agentCount: agents.length, totals });
  } catch (err) {
    stream.emit({ type: 'error', status: 500, error: err.message });
  } finally {
    stream.end();
  }
});

// D4 (#2066): which of an environment's agents are NOT up to date, derived from
// the actual workspace state rather than from a remembered save-time diff — so
// it stays correct after a declined offer, a partial run or a failure, and
// clears on its own once nothing diverges.
//
// Read-only, so it gates on visibility rather than management: a reader who can
// see the environment may see that its agents are behind, but the catch-up
// button behind the indicator posts to sync-agents above and is refused there.
app.get('/api/environments/:id/repo-divergence', apiLimiter, async (req, res) => {
  const envId = normalizeEnvId(req.params.id);
  const env = loadEnvironment(envId);
  if (!env) return res.status(404).json({ error: 'Environment not found' });
  const scope = getScope(req);
  // #2083: tier-aware — a shared environment carries no `teamId`. #2158: also
  // reachable by a caller with no team assignment at all when the env is global.
  if (!visibleEnvironment(scope, env) && !isGlobalEnvironment(env)) {
    return res.status(404).json({ error: 'Environment not found' });
  }

  // The agent set is resolved HERE and handed to the orchestrator, because
  // deciding which agents this caller may see is the console's scoping job.
  const agents = agentsUsingEnvironment(envId, scope);
  if (agents.length === 0) {
    return res.json({ envId, agents: [], outOfDate: 0, canManage: canManageEnvironment(scope, env) });
  }
  try {
    const resp = await fetch(
      `${ORCH_URL()}/internal/environments/${encodeURIComponent(envId)}/repo-divergence`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentIds: agents.map((a) => a.id) }),
      },
    );
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) return res.status(502).json({ error: data.error || `HTTP ${resp.status}` });
    const names = new Map(agents.map((a) => [a.id, a.displayName]));
    return res.json({
      envId,
      agents: (Array.isArray(data.agents) ? data.agents : [])
        .map((a) => ({ ...a, displayName: names.get(a.agentId) || a.agentId })),
      outOfDate: data.outOfDate || 0,
      canManage: canManageEnvironment(scope, env),
    });
  } catch (err) {
    // An unreachable orchestrator must not render as "everything is fine" —
    // the indicator would then be silently wrong rather than absent.
    return res.status(502).json({ error: `Orchestrator unreachable: ${err.message}` });
  }
});

// Post a canned "please commit" / "please push" prompt into the source
// agent's own DM. We send it as the admin user (same path as a manually
// typed message) so the agent picks it up via its normal DM heuristic and
// the entire exchange — including the resulting commits — stays visible in
// the chat history. Used by the pre-flight buttons.
app.post('/api/agents/:id/handover/nudge', handoverLimiter, async (req, res) => {
  const { id } = req.params;
  if (!AGENT_ID_RE.test(id)) return res.status(400).json({ error: 'Invalid agent id' });
  if (!matrix.ADMIN_TOKEN) return res.status(500).json({ error: 'MATRIX_ACCESS_TOKEN not configured' });

  // Re-validate inline at the path.join site — CodeQL recognises inline
  // AGENT_ID_RE.test() as a path-injection sanitizer (js/path-injection)
  // but does not propagate the route-level check through subsequent code.
  if (!AGENT_ID_RE.test(id)) return res.status(400).json({ error: 'Invalid agent id' });
  const sourceCfg = readJsonFile(path.join(AGENTS_DIR, id, 'config.json'), null);
  if (!sourceCfg) return res.status(404).json({ error: 'Agent not found' });

  const { kind, repos } = req.body || {};
  if (kind !== 'commit' && kind !== 'push') {
    return res.status(400).json({ error: "kind must be 'commit' or 'push'" });
  }
  const repoNames = Array.isArray(repos)
    ? repos.filter((r) => typeof r === 'string' && /^[\w.-]+$/.test(r)).slice(0, 10)
    : [];
  const repoHint = repoNames.length > 0
    ? ` (repos: ${repoNames.map((r) => `\`${r}\``).join(', ')})`
    : '';

  const body = kind === 'commit'
    ? `Pre-handoff check: please commit and push every uncommitted change in your workspace${repoHint}.\n\n` +
      'Use clear, scoped commit messages that explain the result of your work — downstream agents will only see the git history. ' +
      'Once everything is on the remote branch, reply with the branch name and the head commit SHA per repo so I can hand off.'
    : `Pre-handoff check: please push your local commits to the remote branch${repoHint}.\n\n` +
      'Reply with the branch name and the resulting head commit SHA per repo so I can hand off.';

  let roomId;
  try {
    const dm = await ensureAgentDmRoom(id);
    roomId = dm.roomId;
  } catch (err) {
    return res.status(502).json({ error: `Could not open conversation: ${err.message}` });
  }

  const txnId = crypto.randomUUID();
  // The pre-handoff check is posted on a person's behalf, so it carries the same
  // author stamp as a typed message (#2065 AC1) and is badged with their initials.
  const preHandoffContent = { msgtype: 'm.text', body };
  const preHandoffAuthor = chatAuthorFor(req);
  if (preHandoffAuthor) preHandoffContent[CHAT_AUTHOR_FIELD] = preHandoffAuthor;
  try {
    const sendResp = await matrix.matrixFetch(matrix.ADMIN_TOKEN,
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${encodeURIComponent(txnId)}`,
      { method: 'PUT', body: preHandoffContent });
    if (sendResp.status >= 400) {
      return res.status(502).json({ error: sendResp.data?.error || `Chat service error ${sendResp.status}` });
    }
    res.json({ ok: true, kind, roomId, eventId: sendResp.data?.event_id || null });
  } catch (err) {
    res.status(502).json({ error: `Chat service unreachable: ${err.message}` });
  }
});

app.post('/api/agents/:id/handover', handoverLimiter, async (req, res) => {
  const { id } = req.params;
  if (!AGENT_ID_RE.test(id)) return res.status(400).json({ error: 'Invalid agent id' });

  const sourceCfg = readJsonFile(path.join(AGENTS_DIR, id, 'config.json'), null);
  if (!sourceCfg) return res.status(404).json({ error: 'Agent not found' });
  if (sourceCfg.role !== 'bp-instance') {
    return res.status(409).json({ error: `Agent '${id}' is not a bp-instance (role=${sourceCfg.role})` });
  }

  const { targets, note, perTarget, override } = req.body || {};
  if (!Array.isArray(targets) || targets.length === 0) {
    return res.status(400).json({ error: 'targets (non-empty array of agent ids) is required' });
  }
  for (const t of targets) {
    if (typeof t !== 'string' || !AGENT_ID_RE.test(t)) {
      return res.status(400).json({ error: `Invalid target agent id: ${String(t).slice(0, 80)}` });
    }
  }
  const sharedNote = typeof note === 'string' ? note.trim() : '';
  const perTargetMap = perTarget && typeof perTarget === 'object' && !Array.isArray(perTarget) ? perTarget : {};
  const overrideReason = override && typeof override === 'object' && typeof override.reason === 'string'
    ? override.reason.trim()
    : '';
  const overrideObj = overrideReason ? { reason: overrideReason } : null;

  if (!matrix.ADMIN_TOKEN) {
    return res.status(500).json({ error: 'MATRIX_ACCESS_TOKEN not configured' });
  }

  // Re-fetch the source git status server-side so we cannot be tricked by a
  // stale browser snapshot. Block unless ready or override-with-reason.
  const gitStatus = await fetchSourceGitStatus(id);
  if (!gitStatus) {
    return res.status(502).json({ error: 'Could not fetch source git status from orchestrator' });
  }
  const sourceRepos = Array.isArray(gitStatus.repos) ? gitStatus.repos : [];
  const sourceReady = Boolean(gitStatus.summary?.ready);
  if (!sourceReady && !overrideObj) {
    const issues = [];
    for (const r of sourceRepos) {
      if (!r.exists) { issues.push(`${r.name}: not cloned`); continue; }
      if (!r.clean)  { issues.push(`${r.name}: uncommitted changes`); continue; }
      if (!r.upstream) { issues.push(`${r.name}: no upstream`); continue; }
      if ((r.ahead || 0) > 0) issues.push(`${r.name}: ${r.ahead} unpushed commit(s)`);
    }
    return res.status(409).json({
      error: 'Source workspace is not hand-off-ready',
      reason: 'git-not-ready',
      issues,
      gitStatus,
      hint: 'Resolve the issues, or pass `override: { reason: "..." }` to proceed anyway.',
    });
  }

  // Pull suggested-target metadata (input-artifact paths etc.) once so we
  // can enrich each per-target body without re-querying the orchestrator
  // inside the loop.
  const candidates = await fetchHandoverCandidates(id).catch(() => null);
  const suggestedById = new Map();
  for (const s of (candidates?.suggested || [])) suggestedById.set(s.agentId, s);

  const orchestratorUrl = ORCH_URL();
  const sourceLabel = sourceCfg.displayName || id;
  const sourceBpHash = sourceCfg.bpId ? String(sourceCfg.bpId).slice(0, 8) : null;
  const headerLine = sourceBpHash
    ? `Hand-off from **${sourceLabel}** (bp:${sourceBpHash}) — your upstream BP signalled it's done.`
    : `Hand-off from **${sourceLabel}** — your upstream agent signalled it's done.`;

  const results = [];
  for (const targetId of targets) {
    const targetCfgPath = path.join(AGENTS_DIR, targetId, 'config.json');
    const targetCfg = readJsonFile(targetCfgPath, null);
    if (!targetCfg) {
      results.push({ agentId: targetId, ok: false, stage: 'lookup', error: 'target not found' });
      continue;
    }

    // Per-target consistency check: does the target's environment know
    // about the source's repo URLs, and on the same default branch?
    const targetEnv = targetCfg.environmentId ? loadEnvironment(targetCfg.environmentId) : null;
    const consistencyWarnings = repoConsistencyWarnings(sourceRepos, targetEnv);

    // 1. Materialize / enable the target via orchestrator (idempotent).
    try {
      const enableResp = await fetch(`${orchestratorUrl}/internal/agents/${encodeURIComponent(targetId)}/enable`, {
        method: 'POST',
      });
      const enableData = await enableResp.json().catch(() => ({}));
      if (!enableResp.ok) {
        results.push({ agentId: targetId, ok: false, stage: 'enable', error: enableData.error || `HTTP ${enableResp.status}` });
        continue;
      }
    } catch (err) {
      results.push({ agentId: targetId, ok: false, stage: 'enable', error: `Orchestrator unreachable: ${err.message}` });
      continue;
    }

    // 2. Ensure DM room. enableAgent rewrites config.json with the new
    // token, so re-read before checking matrix readiness.
    const refreshedCfg = readJsonFile(targetCfgPath, null);
    if (!refreshedCfg?.token) {
      results.push({ agentId: targetId, ok: false, stage: 'enable', error: 'agent could not be activated (no chat account)' });
      continue;
    }
    let roomId;
    try {
      const dm = await ensureAgentDmRoom(targetId);
      roomId = dm.roomId;
    } catch (err) {
      results.push({ agentId: targetId, ok: false, stage: 'dm', error: err.message });
      continue;
    }

    // 3. Build the structured DM body and send it. The receiving agent's
    // DM heuristic in the agent runtime picks it up like any other user
    // message and invokes Claude with the body as the prompt.
    const noteText = (typeof perTargetMap[targetId] === 'string' ? perTargetMap[targetId] : sharedNote).trim();
    const body = renderHandoverBody({
      headerLine,
      repos: sourceRepos,
      suggestedRow: suggestedById.get(targetId),
      noteText,
      override: overrideObj,
      consistencyWarnings,
    });

    // Enqueue the handover message in the target agent's pending queue rather
    // than sending a direct Matrix DM. This avoids the race where the DM arrives
    // before the agent's Matrix client has finished its first sync after being
    // enabled; the agent drains the queue within 5 s of startup, by which time
    // the client is always ready. The orchestrator owns the queue (#185 Phase 2)
    // — routing through it keeps the queue single-writer and reaches the agent
    // even when its volume is isolated.
    try {
      const orchestratorUrl = process.env.ORCHESTRATOR_URL || 'http://orchestrator:4002';
      const r = await fetch(
        `${orchestratorUrl}/internal/agents/${encodeURIComponent(targetId)}/enqueue-pending`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ kind: 'handover-dm', roomId, body, enqueuedAt: new Date().toISOString() }),
        },
      );
      if (!r.ok) throw new Error(`orchestrator HTTP ${r.status}`);
      results.push({
        agentId: targetId,
        ok: true,
        roomId,
        eventId: null,
        displayName: refreshedCfg.displayName || targetId,
        consistencyWarnings,
      });
    } catch (err) {
      results.push({ agentId: targetId, ok: false, stage: 'send', error: `Could not enqueue handover: ${err.message}` });
    }
  }

  const okCount = results.filter((r) => r.ok).length;
  // Always 200 — per-target outcomes are in `results`. The UI shows the
  // breakdown; treating "0 of N succeeded" as a transport-level failure
  // would hide that detail behind apiCall's generic error path.
  res.status(200).json({
    source: { agentId: id, displayName: sourceLabel, bpId: sourceCfg.bpId || null },
    sent: okCount,
    total: results.length,
    override: overrideObj,
    gitStatus,
    results,
  });
});

// Resolve the `{{var}}` substitution set for a LIVE team from its team agent
// config + bound Working Environment, mirroring the wizard's POST /api/teams
// vars (#586, AC-5). The team-level label choices (ready/dispatch/maxParallel)
// aren't persisted on a materialised team, so they fall back to the same
// defaults the wizard uses — a caller may override them in the request body.
// Returns { vars } on success or { error } for a clean 400/404.
function resolveTeamMemberVars(teamId, overrides = {}) {
  const teamCfg = readJsonFile(path.join(AGENTS_DIR, teamId, 'config.json'), null);
  if (!teamCfg) return { error: 'Team not found' };
  const envId = teamCfg.environmentId;
  const env = envId ? loadEnvironment(envId) : null;
  if (!env) return { error: `Team '${teamId}' has no Working Environment` };
  const primary = reposFromEnv(env)[0];
  // A repo-less team (#1623) resolves empty repo vars rather than erroring, so
  // roles can still be added to it after materialization.
  let parsed = null;
  if (primary?.url) {
    try {
      parsed = deriveRepoIdentity(primary.url);
    } catch (err) {
      return { error: `Team repository URL is not parseable: ${err.message}` };
    }
  }
  const branch = primary?.url && typeof primary.branch === 'string' && /^[A-Za-z0-9._/-]+$/.test(primary.branch)
    ? primary.branch
    : 'main';
  const readyLabel = typeof overrides.readyLabel === 'string' && overrides.readyLabel.trim()
    ? overrides.readyLabel.trim() : 'ready';
  const dispatchLabel = typeof overrides.dispatchLabel === 'string' && overrides.dispatchLabel.trim()
    ? overrides.dispatchLabel.trim() : 'dispatch';
  return {
    vars: {
      teamName: teamCfg.displayName || teamId,
      teamId,
      ...repoVars(parsed, primary?.url),
      branch,
      readyLabel,
      dispatchLabel,
      maxParallel: Number.isInteger(overrides.maxParallel) ? overrides.maxParallel : 1,
    },
  };
}

app.post('/api/agents/:teamId/members', heavyLimiter, async (req, res) => {
  const { teamId } = req.params;
  if (!AGENT_ID_RE.test(teamId)) return res.status(400).json({ error: 'Invalid agent id' });
  // Containment check: AGENT_ID_RE already excludes traversal segments,
  // but CodeQL doesn't always recognise the regex as a sanitiser when the
  // value travels through a destructure first. Re-check with path.relative.
  const agentsBaseDir = path.resolve(AGENTS_DIR);
  const teamDir = path.resolve(agentsBaseDir, teamId);
  const rel = path.relative(agentsBaseDir, teamDir);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return res.status(400).json({ error: 'Invalid agent id' });
  }
  if (!fs.existsSync(teamDir)) {
    return res.status(404).json({ error: 'Team not found' });
  }
  // Config-write authorization (#989): adding a member requires management
  // rights over the parent team agent's owning team.
  const teamCfg = readJsonFile(path.join(teamDir, 'config.json'), null);
  if (!canManageAgent(getScope(req), agentMetaForScope(teamCfg || {}))) {
    return res.status(403).json({ error: 'forbidden', code: 'forbidden' });
  }
  // Body is optional. When present it carries the override / config fields
  // the orchestrator's addTeamMember now accepts: { id, displayName,
  // systemPromptOverride, skillsOverride, sessionPolicy, triggers }.
  //
  // Add-role-from-a-template (#586, AC-5): when the body carries a `templateId`
  // instead of a free-form prompt, load that role template and build the
  // member-create body server-side via the SAME buildMemberFromTemplate used by
  // the Team-Setup wizard — so the live-materialised member gets the template's
  // session policy + triggers with per-member `{{repoFullName}}`/`{{agentId}}`
  // (and the rest of the team vars) substituted identically. The orchestrator
  // still enforces member-id uniqueness (409 on collision, E1/AC-7).
  //
  // Materialization preference (#1958): `materialize: false` creates the member
  // as a STUB — config + triggers, no Matrix user, no clone, no container — the
  // mode `addTeamMember` has always supported but this route never asked for.
  // Absent means materialize now, so every pre-#1958 caller is unaffected; the
  // resolved value is written onto the outgoing body EXPLICITLY (rather than
  // left to the orchestrator's `!== false` default) so the two branches below
  // cannot drift apart in what they forward.
  const inBody = req.body || {};
  const materializePref = parseMemberMaterialize(inBody);
  if (materializePref.error) return res.status(400).json({ error: materializePref.error });
  const { materialize } = materializePref;
  let outBody = { ...inBody, materialize };
  if (typeof inBody.templateId === 'string' && inBody.templateId) {
    const template = loadAgentTemplate(inBody.templateId);
    if (!template) return res.status(400).json({ error: `Role template '${inBody.templateId}' not found` });
    const memberId = typeof inBody.id === 'string' && inBody.id ? inBody.id : `${teamId}-${inBody.templateId}`;
    if (!AGENT_ID_RE.test(memberId)) return res.status(400).json({ error: 'Invalid member id' });
    const memberDisplayName = typeof inBody.displayName === 'string' && inBody.displayName.trim()
      ? inBody.displayName.trim() : template.displayName;
    const resolved = resolveTeamMemberVars(teamId, inBody);
    if (resolved.error) return res.status(400).json({ error: resolved.error });
    outBody = buildMemberFromTemplate(template, {
      teamId,
      memberId,
      memberDisplayName,
      vars: { ...resolved.vars, agentId: memberId },
      // Label-suffix stamping and `{{var}}` resolution above are untouched by
      // the mode (#1958, E3): a stub carries the same fully-substituted prompt
      // and triggers a materialized member would, so materializing it later
      // yields an indistinguishable agent (AC3).
      materialize,
    });
  } else if (typeof inBody.processTemplateId === 'string' && inBody.processTemplateId) {
    // Add-role-from-a-PROCESS-template (#1375) is GONE (#1959). It existed only
    // to serve the missing-roles suggestion — the platform inferred which
    // loop-closing role a team lacked and offered a one-click add — and that
    // capability was retired by requester decision, not re-homed.
    //
    // Refused explicitly rather than ignored: silently falling through would
    // create a free-form member named after the role id but WITHOUT the
    // template's prompt, session policy or triggers, which reads as success and
    // is worse than an error. The `templateId` branch above (generic "Add
    // member" from a role template) and the free-form branch are unaffected.
    return res.status(400).json({
      error: 'The missing-roles suggestion was removed (#1959): adding a single role from a '
        + 'process template is no longer supported. Use `templateId` to add a member from a '
        + 'role template, or wire the role in the Flow editor.',
      code: 'process-template-role-removed',
    });
  }
  const orchestratorUrl = process.env.ORCHESTRATOR_URL || 'http://orchestrator:4002';
  try {
    const resp = await fetch(`${orchestratorUrl}/internal/teams/${encodeURIComponent(teamId)}/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(outBody),
    });
    const data = await resp.json();
    if (!resp.ok) return res.status(resp.status).json(data);
    // Adding a member can wire a direct hand-off in either direction (the new
    // member handing off to an existing one, or an existing one to it), so
    // re-derive the whole team's hand-off wiring against the live member ids
    // (#2030) before reporting success — see reconcileTeamHandoffWiring.
    await reconcileTeamHandoffWiring(teamId);
    res.status(201).json(data);
  } catch (err) {
    res.status(502).json({ error: `Orchestrator unreachable: ${err.message}` });
  }
});

app.post('/api/agents', heavyLimiter, async (req, res) => {
  const { id, displayName, role, systemPrompt, environmentId, schedule, taskPrompt, teamId } = req.body;
  if (!id || !displayName || !role || !environmentId) {
    return res.status(400).json({ error: 'id, displayName, role, environmentId required' });
  }
  // Config-write authorization (#989): creating an agent requires management
  // rights over the destination team (default when unspecified).
  if (!canManageAgent(getScope(req), { teamId })) {
    return res.status(403).json({ error: 'forbidden', code: 'forbidden' });
  }
  // Teams may be created without a default prompt — members can carry their
  // own per-role prompts, and the orchestrator stores an empty template.
  if (!systemPrompt && role !== 'team') {
    return res.status(400).json({ error: 'systemPrompt is required for every role except team' });
  }
  if (!loadEnvironment(environmentId)) {
    return res.status(400).json({ error: `Working Environment '${environmentId}' not found` });
  }
  const orchestratorUrl = process.env.ORCHESTRATOR_URL || 'http://orchestrator:4002';
  try {
    const resp = await fetch(`${orchestratorUrl}/internal/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id, displayName, role, systemPrompt, environmentId, schedule, taskPrompt, teamId,
        // Human owner (#2077, D8) — the authenticated caller, resolved here and
        // never taken from the request body. `getScope(req).userId` is null for
        // the env single-admin (no user record), and `ownerFor` omits the key
        // in that case rather than writing a null owner.
        ...ownerFor(req),
      }),
    });
    const data = await resp.json();
    if (!resp.ok) return res.status(resp.status).json(data);
    // Eagerly provision the DM room for the freshly-created agent so it is
    // ready before the first message (#184). Best-effort — never fails create.
    if (data.enabled !== false) await preCreateAgentDmRoom(id, 'create');
    res.status(201).json(data);
  } catch (err) {
    res.status(502).json({ error: `Orchestrator unreachable: ${err.message}` });
  }
});

app.delete('/api/agents/:id', heavyLimiter, async (req, res) => {
  const { id } = req.params;
  if (!AGENT_ID_RE.test(id)) return res.status(400).json({ error: 'Invalid agent id' });
  // Containment check: AGENT_ID_RE already excludes traversal segments,
  // but CodeQL doesn't always recognise the regex as a sanitiser when the
  // value travels through a destructure first. Re-check with path.relative.
  const agentsBaseDir = path.resolve(AGENTS_DIR);
  const agentDir = path.resolve(agentsBaseDir, id);
  const rel = path.relative(agentsBaseDir, agentDir);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return res.status(400).json({ error: 'Invalid agent id' });
  }
  if (!fs.existsSync(agentDir)) return res.status(404).json({ error: 'Agent not found' });
  // Config-write authorization (#989): deleting an agent requires management
  // rights over its owning team.
  const delCfg = readJsonFile(path.join(agentDir, 'config.json'), null);
  if (!canManageAgent(getScope(req), agentMetaForScope(delCfg || {}))) {
    return res.status(403).json({ error: 'forbidden', code: 'forbidden' });
  }
  const orchestratorUrl = process.env.ORCHESTRATOR_URL || 'http://orchestrator:4002';
  try {
    const resp = await fetch(`${orchestratorUrl}/internal/agents/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      return res.status(resp.status).json(data);
    }
    // A team delete cascades to its members. A member the cascade could not
    // remove is residue the caller has to know about (#1960 AC2) — reported in
    // the `{ id, kind, error }` shape the team fan-out's `rollbackWarnings`
    // uses. Only then do we answer with a body: a clean delete still returns a
    // bare 204, so every existing caller is unaffected.
    if (Array.isArray(data.cascadeWarnings) && data.cascadeWarnings.length) {
      return res.status(200).json({
        ok: true,
        cascaded: Array.isArray(data.cascaded) ? data.cascaded : [],
        cascadeWarnings: data.cascadeWarnings,
      });
    }
    res.status(204).end();
  } catch (err) {
    res.status(502).json({ error: `Orchestrator unreachable: ${err.message}` });
  }
});

/* ─── Agent Clone ───────────────────────────────────────────────────── */

// Optional body field:
//   - parentTeamId — graft the clone into an existing team as a member,
//     mirroring /api/agents/import's team-assignment field. Absent → the
//     clone is created as a standalone agent, even when the source itself
//     is a team member.
// On id conflict the response is 409 with `{ code: 'id-conflict', agentId }`,
// same shape as /api/agents/import, so the UI can prompt for a new id inline.
app.post('/api/agents/:id/clone', heavyLimiter, async (req, res) => {
  const { id } = req.params;
  if (!AGENT_ID_RE.test(id)) return res.status(400).json({ error: 'Invalid agent id' });
  const { newId, newDisplayName, parentTeamId } = req.body || {};
  if (!newId || !newDisplayName) {
    return res.status(400).json({ error: 'newId and newDisplayName required' });
  }
  if (!AGENT_ID_RE.test(newId)) {
    return res.status(400).json({ error: `Invalid agent id '${newId}' (allowed: letters, digits, _ - .)` });
  }
  // Containment check for the SOURCE id — AGENT_ID_RE excludes traversal
  // segments, but CodeQL's path-injection query doesn't follow the regex
  // through the destructure; path.resolve + path.relative is the in-flow
  // sanitiser it recognises. Build every id-derived path from the contained dir.
  const cloneAgentsBaseDir = path.resolve(AGENTS_DIR);
  const srcAgentDir = path.resolve(cloneAgentsBaseDir, id);
  const srcRel = path.relative(cloneAgentsBaseDir, srcAgentDir);
  if (srcRel.startsWith('..') || path.isAbsolute(srcRel) || !srcRel) {
    return res.status(400).json({ error: 'Invalid agent id' });
  }
  if (!fs.existsSync(srcAgentDir)) {
    return res.status(404).json({ error: 'Agent not found' });
  }
  if (parentTeamId != null && !AGENT_ID_RE.test(parentTeamId)) {
    return res.status(400).json({ error: 'Invalid parentTeamId' });
  }
  // Containment check — path.resolve + path.relative is the in-flow
  // sanitiser pattern CodeQL recognises for js/path-injection.
  const agentsBaseDir = path.resolve(AGENTS_DIR);
  const targetDir = path.resolve(agentsBaseDir, newId);
  const rel = path.relative(agentsBaseDir, targetDir);
  if (rel.startsWith('..') || path.isAbsolute(rel) || !rel) {
    return res.status(400).json({ error: 'Invalid agent id path' });
  }
  if (fs.existsSync(targetDir)) {
    return res.status(409).json({
      error: `Agent '${newId}' already exists — choose a different id.`,
      code: 'id-conflict',
      agentId: newId,
    });
  }
  // Config-write authorization (#989): cloning creates an agent — require
  // management rights over the source agent's owning team, and (when grafting
  // the clone into a team) over the destination team too.
  const cloneScope = getScope(req);
  const srcCfg = readJsonFile(path.join(srcAgentDir, 'config.json'), null);
  if (!canManageAgent(cloneScope, agentMetaForScope(srcCfg || {}))) {
    return res.status(403).json({ error: 'forbidden', code: 'forbidden' });
  }
  if (parentTeamId != null) {
    const destCfg = readJsonFile(path.join(AGENTS_DIR, parentTeamId, 'config.json'), null);
    // The fallback names the destination Agent Team directly (#2078): with the
    // boundary now read off the config, a bare `{ teamId: parentTeamId }` would
    // resolve to "no team" and fail closed on a team that does exist.
    if (!canManageAgent(cloneScope, agentMetaForScope(destCfg || { id: parentTeamId, role: 'team' }))) {
      return res.status(403).json({ error: 'forbidden', code: 'forbidden' });
    }
  }
  const orchestratorUrl = process.env.ORCHESTRATOR_URL || 'http://orchestrator:4002';
  try {
    const resp = await fetch(`${orchestratorUrl}/internal/agents/${encodeURIComponent(id)}/clone`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ newId, newDisplayName, parentTeamId: parentTeamId || undefined }),
    });
    const data = await resp.json();
    if (!resp.ok) return res.status(resp.status).json(data);
    res.status(201).json(data);
  } catch (err) {
    res.status(502).json({ error: `Orchestrator unreachable: ${err.message}` });
  }
});

/* ─── Extract Agent Template (#1509) ────────────────────────────────── */

// Snapshot a proven live agent — a standalone chat agent OR an individual team
// member — into a reusable, team-neutral USER-tier Agent Template (the inverse
// of team materialisation). One-shot: no ongoing link to the source agent, and
// the source is left completely unchanged (AC-10). A whole team agent — and
// any leftover config naming a role the platform no longer supports — is
// rejected defensively (AC-1); the action is only offered on standalone /
// team-member cards in the UI.
//
// Field mapping lives in the pure extract-template.js module; here we resolve
// the impure inputs off disk: the EFFECTIVE prompt (rendered AGENT-PROMPT.md,
// falling back to the config override — same definition the export path uses),
// the effective skill grant (member override → own skills[] → parent team's),
// the effective sessionPolicy, and the live triggers.json.
app.post('/api/agents/:id/extract-template', (req, res) => {
  const { id } = req.params;
  if (!AGENT_ID_RE.test(id)) return res.status(400).json({ error: 'Invalid agent id' });

  // Contain the source id before any fs read (path.resolve + path.relative is
  // the in-flow sanitiser CodeQL recognises; AGENT_ID_RE alone isn't followed
  // through the destructure). Every id-derived path is built from srcAgentDir.
  const agentsBaseDir = path.resolve(AGENTS_DIR);
  const srcAgentDir = path.resolve(agentsBaseDir, id);
  const srcRel = path.relative(agentsBaseDir, srcAgentDir);
  if (srcRel.startsWith('..') || path.isAbsolute(srcRel) || !srcRel) {
    return res.status(400).json({ error: 'Invalid agent id' });
  }
  const srcCfg = readJsonFile(path.join(srcAgentDir, 'config.json'), null);
  if (!srcCfg) return res.status(404).json({ error: 'Agent not found' });

  // Eligibility (AC-1): only standalone `agent` and `team-member` sources.
  const srcRole = srcCfg.role || 'agent';
  if (srcRole !== 'agent' && srcRole !== 'team-member') {
    return res.status(400).json({
      error: 'Only standalone agents and team members can be extracted into a template.',
      code: 'ineligible-role',
    });
  }

  // Admin-gated over the source agent's owning team (AC-11), same rule as clone.
  if (!canManageAgent(getScope(req), agentMetaForScope(srcCfg))) {
    return res.status(403).json({ error: 'forbidden', code: 'forbidden' });
  }

  const nes = (v) => typeof v === 'string' && v.trim() !== '';
  const { displayName, description, category, patternRole, includeTriggers } = req.body || {};
  const templateId = typeof (req.body || {}).id === 'string' ? req.body.id.trim() : '';
  if (!agentTemplateStore.TEMPLATE_ID_RE.test(templateId)) {
    return res.status(400).json({
      error: 'id must be a slug: lowercase letters, digits and hyphens, not starting with a hyphen',
    });
  }

  // Effective prompt: the rendered AGENT-PROMPT.md (what the agent actually runs
  // with — for a team member this is the applied override, not the base template
  // it was assembled from), falling back to the stored override. Same source of
  // truth as GET /api/process/template.
  const effectivePrompt = readAgentSystemPrompt(id) || srcCfg.systemPrompt || '';

  // Effective skill grant (orchestrator/skill-grants.js semantics): member
  // override → own skills[] → parent team's skills[].
  let parentCfg = null;
  if (srcRole === 'team-member' && srcCfg.parentTeamId) {
    const parentDir = path.resolve(agentsBaseDir, String(srcCfg.parentTeamId));
    const parentRel = path.relative(agentsBaseDir, parentDir);
    if (!parentRel.startsWith('..') && !path.isAbsolute(parentRel)) {
      parentCfg = readJsonFile(path.join(parentDir, 'config.json'), null);
    }
  }
  const effectiveSkills = Array.isArray(srcCfg.skillsOverride) ? srcCfg.skillsOverride
    : Array.isArray(srcCfg.skills) ? srcCfg.skills
      : (parentCfg && Array.isArray(parentCfg.skills)) ? parentCfg.skills
        : [];

  const liveTriggers = readJsonFile(controlOrAgentPath(id, 'triggers.json'), []);

  const template = extractTemplate.buildExtractedTemplate({
    id: templateId,
    displayName: nes(displayName) ? displayName.trim() : (srcCfg.displayName || id),
    description,
    // category/patternRole are user-editable; fall back to inference if omitted.
    category: nes(category) ? category
      : extractTemplate.inferTemplateCategory(srcCfg, liveTriggers),
    patternRole: nes(patternRole) ? patternRole
      : extractTemplate.inferPatternRole(srcCfg,
        extractTemplate.inferTemplateCategory(srcCfg, liveTriggers)),
    prompt: effectivePrompt,
    skills: effectiveSkills,
    sessionPolicy: srcCfg.sessionPolicy || 'persistent',
    triggers: Array.isArray(liveTriggers) ? liveTriggers : [],
    includeTriggers: includeTriggers === true,
  });

  const { valid, errors } = agentTemplateStore.validateTemplate(template, { requireId: true });
  if (!valid) return res.status(400).json({ error: errors[0], errors });

  // Collision across BOTH tiers — never silently overwrite (AC-9). The UI
  // re-suggests an id on this code and lets the operator retry.
  if (readTemplateFile(AGENT_TEMPLATES_DIR, templateId) || readTemplateFile(USER_AGENT_TEMPLATES_DIR, templateId)) {
    return res.status(409).json({
      error: `A template with id '${templateId}' already exists — choose a different id.`,
      code: 'id-conflict',
      templateId,
    });
  }

  const file = agentTemplateStore.safeTemplateFile(USER_AGENT_TEMPLATES_DIR, templateId);
  if (!file) return res.status(400).json({ error: 'Invalid template id' });
  try {
    fs.mkdirSync(USER_AGENT_TEMPLATES_DIR, { recursive: true });
    writeJsonAtomic(file, template);
  } catch (err) {
    return res.status(500).json({ error: `Failed to save template: ${err.message}` });
  }
  res.status(201).json({ id: templateId, origin: 'user' });
});

/* ─── Agent Export / Import ─────────────────────────────────────────── */

// Inline path-containment check — CodeQL recognises includes('..') +
// startsWith(rootPrefix) as a path-injection sanitiser when applied in the
// same function as the sink. Allowed roots are WORKSPACE (agent files) and
// /tmp (scratch dirs from fs.mkdtempSync). Refuses anything else.
// Asynchronous by design: an agent workspace is routinely hundreds of MB over
// tens of thousands of files, and a synchronous copy would block the
// single-threaded API for its whole duration.
async function copyDirRecursiveAsync(src, dst) {
  if (typeof src !== 'string' || src.includes('..') ||
      !(src.startsWith(WORKSPACE + path.sep) || src.startsWith('/tmp' + path.sep))) {
    throw new Error(`copyDirRecursiveAsync: refusing src outside allowed roots: ${src}`);
  }
  if (typeof dst !== 'string' || dst.includes('..') ||
      !(dst.startsWith(WORKSPACE + path.sep) || dst.startsWith('/tmp' + path.sep))) {
    throw new Error(`copyDirRecursiveAsync: refusing dst outside allowed roots: ${dst}`);
  }
  await fs.promises.mkdir(dst, { recursive: true });
  for (const entry of await fs.promises.readdir(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isSymbolicLink()) continue; // skip symlinks for safety
    if (entry.isDirectory()) {
      await copyDirRecursiveAsync(s, d);
    } else {
      await fs.promises.copyFile(s, d);
    }
  }
}

// Mirrors a directory tree as a farm of hard links: same shape, same file
// contents (same inodes), but no data copied and no second copy of the bytes on
// disk. The export needs a tree it can hand to `zip` under a chosen top-level
// name; it does not need the bytes duplicated, and duplicating them costs ~10 s
// and ~545 MB on a real agent workspace.
//
// Same inline containment gate and the same skip-symlinks rule as
// copyDirRecursiveAsync — see there. `skipTop` names top-level entries to leave
// out (the export drops sessions/).
//
// Falls back to a copy per file when linking is refused — a hard link cannot
// cross a filesystem boundary (EXDEV) and some backing stores reject it
// outright — so the result is correct wherever the volumes happen to sit.
const LINK_BATCH = 32;
async function linkDirRecursiveAsync(src, dst, skipTop = new Set()) {
  if (typeof src !== 'string' || src.includes('..') ||
      !(src.startsWith(WORKSPACE + path.sep) || src.startsWith('/tmp' + path.sep))) {
    throw new Error(`linkDirRecursiveAsync: refusing src outside allowed roots: ${src}`);
  }
  if (typeof dst !== 'string' || dst.includes('..') ||
      !(dst.startsWith(WORKSPACE + path.sep) || dst.startsWith('/tmp' + path.sep))) {
    throw new Error(`linkDirRecursiveAsync: refusing dst outside allowed roots: ${dst}`);
  }
  await fs.promises.mkdir(dst, { recursive: true });
  const files = [];
  for (const entry of await fs.promises.readdir(src, { withFileTypes: true })) {
    if (skipTop.has(entry.name)) continue;
    if (entry.isSymbolicLink()) continue; // skip symlinks for safety
    if (entry.isDirectory()) {
      await linkDirRecursiveAsync(path.join(src, entry.name), path.join(dst, entry.name));
    } else if (entry.isFile()) {
      files.push(entry.name);
    }
    // sockets/fifos/devices: nothing an export should carry
  }
  // Linking a file is a metadata operation; issued one await at a time it
  // leaves the fs thread pool idle. Batching is ~5× on the workspace volume
  // (5k files: 229 ms → 44 ms) and matters more still on the copy fallback.
  for (let i = 0; i < files.length; i += LINK_BATCH) {
    await Promise.all(files.slice(i, i + LINK_BATCH).map(async (name) => {
      const s = path.join(src, name);
      const d = path.join(dst, name);
      try {
        await fs.promises.link(s, d);
      } catch {
        await fs.promises.copyFile(s, d);
      }
    }));
  }
}

// Streams a ZIP archive of the agent workspace + manifest.json.
// Excludes the sessions/ directory (conversation history and container logs).
app.get('/api/agents/:id/export', heavyLimiter, async (req, res) => {
  const { id } = req.params;
  if (!AGENT_ID_RE.test(id)) return res.status(400).json({ error: 'Invalid agent id' });
  // Containment check: AGENT_ID_RE excludes traversal segments, but CodeQL's
  // path-injection query doesn't always follow the regex through a destructure.
  // The path.resolve + path.relative pattern is recognised in-flow.
  const agentsBaseDir = path.resolve(AGENTS_DIR);
  const agentDirPath = path.resolve(agentsBaseDir, id);
  const rel = path.relative(agentsBaseDir, agentDirPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return res.status(400).json({ error: 'Invalid agent id' });
  }
  const cfg = readJsonFile(path.join(agentDirPath, 'config.json'), null);
  if (!cfg) return res.status(404).json({ error: 'Agent not found' });

  // Best-effort: resolve orchestrator image info via Podman socket
  let imageInfo = { name: 'orchestrator', tag: 'latest', digest: null };
  try {
    const listResult = await podmanRequest('GET', '/containers/json?all=true');
    if (listResult.status === 200 && Array.isArray(listResult.body)) {
      const orch = listResult.body.find(c =>
        Array.isArray(c.Names) && c.Names.some(n => /orchestrator/.test(n))
      );
      if (orch) {
        const nameTag = orch.Image || '';
        const atIdx = nameTag.indexOf('@');
        const tagPart = atIdx >= 0 ? nameTag.slice(0, atIdx) : nameTag;
        const colonIdx = tagPart.lastIndexOf(':');
        imageInfo = {
          name: colonIdx >= 0 ? tagPart.slice(0, colonIdx) : tagPart,
          tag: colonIdx >= 0 ? tagPart.slice(colonIdx + 1) : 'latest',
          digest: atIdx >= 0 ? nameTag.slice(atIdx + 1) : (orch.ImageID || null),
        };
      }
    }
  } catch { /* Podman unavailable — proceed without image info */ }

  // The archive is streamed straight to the client and never materialises on
  // disk, so all that is staged is the shape `zip` walks: a link farm under the
  // top-level name the importer expects (`workspace/`) plus the manifest. The
  // staging root sits on the workspace volume — a hard link cannot cross a
  // filesystem boundary, and the point of the farm is not copying the bytes.
  // No path segment below carries request-derived data (the id is contained
  // above, the rest is a UUID), which keeps the filesystem sinks clear.
  const stagingDir = path.join(WORKSPACE, '.export-staging', crypto.randomUUID());
  let cleanedUp = false;
  const cleanupStaging = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    // Only the links go — the agent's own files are untouched by rmSync here.
    try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch { /* noop */ }
  };
  try {
    // Excludes sessions/ (conversation history, container logs).
    // linkDirRecursiveAsync carries an inline path-containment check; using it
    // for both files and directories keeps every fs sink behind that gate.
    await linkDirRecursiveAsync(agentDirPath, path.join(stagingDir, 'workspace'), new Set(['sessions']));

    // Agent-specific env vars (sensitive Matrix creds are excluded)
    const envVars = { AGENT_ID: id };
    if (cfg.modelOverride) envVars.AGENT_DEFAULT_MODEL = cfg.modelOverride;

    await fs.promises.writeFile(path.join(stagingDir, 'manifest.json'), JSON.stringify({
      version: '1',
      exportedAt: new Date().toISOString(),
      agentId: id,
      image: imageInfo,
      envVars,
    }, null, 2));

    // `-` as the archive name makes zip write to stdout; -q keeps the per-file
    // listing out of it (see archive.js).
    const { child, done } = streamArchiveTool('zip', ['-r', '-q', '-', '.'], { cwd: stagingDir });

    res.setHeader('Content-Disposition', `attachment; filename="agent-${id}-export.zip"`);
    res.setHeader('Content-Type', 'application/zip');
    // No Content-Length: the size isn't known until the archive is finished,
    // and waiting for that is exactly what this route no longer does.

    // `end: false` keeps the decision to terminate the response here rather
    // than with the pipe: a response ended by zip's stdout closing would look
    // complete to the client even when zip died mid-archive.
    child.stdout.pipe(res, { end: false });

    // Client cancelled the download — stop archiving instead of building the
    // rest of a ZIP nobody is reading.
    let clientGone = false;
    res.on('close', () => {
      if (res.writableFinished) return;
      clientGone = true;
      child.kill('SIGKILL');
    });

    const zipResult = await done;
    cleanupStaging();
    if (clientGone) {
      console.log(`[API] Export of ${id} cancelled by the client`);
    } else if (zipResult.code === 0) {
      res.end();
    } else {
      console.error(`[API] Export failed for ${id}: ${describeArchiveFailure('zip', zipResult)}`);
      // Headers are long gone, so there is no status left to send: destroy the
      // response so the client sees a truncated download rather than a
      // silently corrupt ZIP.
      res.destroy();
    }
  } catch (err) {
    cleanupStaging();
    console.error(`[API] Export failed for ${id}: ${err.message}`);
    if (res.headersSent) res.destroy();
    else res.status(500).json({ error: `Export failed: ${err.message}` });
  }
});

// Accepts a ZIP (field: "file") produced by GET /api/agents/:id/export.
// Creates a new agent workspace from the ZIP contents.
// Returns 409 if an agent with the same ID already exists.
const _importUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024 },
});

// Optional form fields (multipart text parts, alongside `file`):
//   - newId        — assign a different id (e.g. when the exported id is taken).
//   - parentTeamId — graft the imported agent into an existing team as a member.
// On id conflict the response is 409 with `{ code: 'id-conflict', agentId }`
// so the UI can prompt for a new id and resubmit.
app.post('/api/agents/import', heavyLimiter, _importUpload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file provided (field name: file)' });

  const tmpDir = fs.mkdtempSync(path.join('/tmp', 'aee-import-'));
  const zipPath = path.join(tmpDir, 'upload.zip');
  const extractDir = path.join(tmpDir, 'extracted');
  let stagingDir = null;
  try {
    fs.writeFileSync(zipPath, req.file.buffer);
    fs.mkdirSync(extractDir);

    // -q: no per-file listing (see runArchiveTool) — an agent export routinely
    // holds tens of thousands of members.
    const unzipResult = await runArchiveTool('unzip', ['-q', '-o', zipPath, '-d', extractDir]);
    if (unzipResult.code !== 0) {
      console.error(`[API] Import: ${describeArchiveFailure('unzip', unzipResult)}`);
      return res.status(400).json({ error: 'Could not extract ZIP — ensure the file is a valid agent export' });
    }

    // Zip-slip protection: verify all extracted paths stay within extractDir
    const realExtractDir = fs.realpathSync(extractDir);
    function checkExtractedPaths(dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        try {
          const real = fs.realpathSync(full);
          if (!real.startsWith(realExtractDir + path.sep) && real !== realExtractDir) {
            throw new Error(`Unsafe path in ZIP: ${real}`);
          }
        } catch (e) {
          if (e.message && e.message.startsWith('Unsafe')) throw e;
          // realpathSync on a dangling symlink throws ENOENT — skip safely
        }
        if (entry.isDirectory()) checkExtractedPaths(full);
      }
    }
    checkExtractedPaths(extractDir);

    // Validate manifest
    const manifestPath = path.join(extractDir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
      return res.status(400).json({ error: 'Missing manifest.json — not a valid agent export' });
    }
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch {
      return res.status(400).json({ error: 'Corrupt manifest.json' });
    }
    const exportedId = typeof manifest.agentId === 'string' ? manifest.agentId : null;
    if (!exportedId || !AGENT_ID_RE.test(exportedId)) {
      return res.status(400).json({ error: 'Invalid or missing agentId in manifest' });
    }

    // Resolve the target id — operator-supplied `newId` wins over the export's.
    const newIdRaw = typeof req.body.newId === 'string' ? req.body.newId.trim() : '';
    if (newIdRaw && !AGENT_ID_RE.test(newIdRaw)) {
      return res.status(400).json({ error: `Invalid agent id '${newIdRaw}' (allowed: letters, digits, _ - .)` });
    }
    const agentId = newIdRaw || exportedId;
    const parentTeamId = typeof req.body.parentTeamId === 'string' && req.body.parentTeamId.trim()
      ? req.body.parentTeamId.trim() : null;

    // Config-write authorization (#989): importing creates an agent. When
    // grafting into a team, require management rights over that team; a
    // standalone import (arbitrary bundle, untrusted teamId) requires management
    // of the default team — non-default Team Admins should graft via parentTeamId.
    {
      const importScope = getScope(req);
      // The standalone branch still names the legacy default access scope on
      // purpose (#2078): this is a gate on agent *creation*, and re-pointing who
      // may create is P3's contract, not P2's. Re-keying it here would either
      // widen it to every authenticated user (P3, early) or narrow it to System
      // Admins (a regression AC5 forbids). The team branch IS re-keyed — see the
      // clone route for why the fallback names the team explicitly.
      const destMeta = parentTeamId != null
        ? agentMetaForScope(readJsonFile(path.join(AGENTS_DIR, parentTeamId, 'config.json'), null) || { id: parentTeamId, role: 'team' })
        : { teamId: 'default' };
      if (!canManageAgent(importScope, destMeta)) {
        return res.status(403).json({ error: 'forbidden', code: 'forbidden' });
      }
    }

    // Containment check — path.resolve + path.relative is the in-flow
    // sanitiser pattern CodeQL recognises for js/path-injection.
    const agentsBaseDir = path.resolve(AGENTS_DIR);
    const targetDir = path.resolve(agentsBaseDir, agentId);
    const rel = path.relative(agentsBaseDir, targetDir);
    if (rel.startsWith('..') || path.isAbsolute(rel) || !rel) {
      return res.status(400).json({ error: 'Invalid agent id path' });
    }

    // Conflict check — structured so the UI can offer a new id.
    if (fs.existsSync(targetDir)) {
      return res.status(409).json({
        error: `Agent '${agentId}' already exists — choose a different id to import it under.`,
        code: 'id-conflict',
        agentId,
      });
    }

    // Locate the exported workspace.
    const workspaceDir = path.join(extractDir, 'workspace');
    if (!fs.existsSync(workspaceDir)) {
      return res.status(400).json({ error: 'Missing workspace/ directory in ZIP' });
    }

    // Stage the workspace on the shared volume so the orchestrator can read it,
    // then hand off provisioning (fresh Matrix identity, role/team wiring,
    // process spawn) to the orchestrator. The orchestrator owns the agent map
    // and Matrix admin client; the admin-console only prepares the files.
    const stagingRoot = path.join(WORKSPACE, '.import-staging');
    fs.mkdirSync(stagingRoot, { recursive: true });
    stagingDir = path.join(stagingRoot, crypto.randomUUID());
    await copyDirRecursiveAsync(workspaceDir, stagingDir);

    const orchResp = await fetch(`${ORCH_URL()}/internal/agents/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stagingDir, agentId, parentTeamId }),
    });
    const data = await orchResp.json().catch(() => ({}));
    if (!orchResp.ok) {
      // Orchestrator cleans staging on success only; remove it on failure here.
      try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch { /* noop */ }
      return res.status(orchResp.status).json(data.error ? data : { error: `Import failed (orchestrator ${orchResp.status})` });
    }

    const img = manifest.image || {};
    console.log(`[API] Imported agent '${exportedId}' → '${agentId}'${parentTeamId ? ` (team=${parentTeamId})` : ''}: image=${img.name}:${img.tag} digest=${img.digest || 'n/a'} exportedAt=${manifest.exportedAt}`);

    res.status(201).json({
      ok: true,
      agentId: data.id || agentId,
      role: data.role || null,
      parentTeamId: data.parentTeamId || null,
      image: manifest.image || null,
    });
  } catch (err) {
    if (stagingDir) { try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch { /* noop */ } }
    console.error(`[API] Import failed: ${err.message}`);
    res.status(500).json({ error: `Import failed: ${err.message}` });
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
  }
});

/* ─── Agent Prompt ──────────────────────────────────────────────────── */

// #990 (docs/prompt-version-history-concept.md): record the pre-edit authored
// prompt as a retained version before a write overwrites it. Best-effort — a
// stamping failure never breaks the primary prompt write. `field` is
// 'systemPromptTemplate' for a team, else 'systemPrompt'. `by` comes from the
// acting human (skillActor), so history is attributed to the person.
function captureAuthoredPromptEdit(id, { field, oldContent, newContent, req, action = 'edited', note }) {
  try {
    // Containment: every caller AGENT_ID_RE-validates `id`, which already
    // excludes traversal, but CodeQL doesn't model the regex as a sanitiser once
    // the value travels through a call — re-check with path.relative before fs.
    const agentsBaseDir = path.resolve(AGENTS_DIR);
    const agentDir = path.resolve(agentsBaseDir, id);
    const rel = path.relative(agentsBaseDir, agentDir);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
    const existing = promptHistory.readPromptHistory(agentDir);
    const next = promptHistory.stampPromptHistory(existing, {
      field,
      oldContent: oldContent == null ? '' : String(oldContent),
      newContent: newContent == null ? '' : String(newContent),
      by: skillActor(req),
      action,
      note,
    });
    promptHistory.writePromptHistory(agentDir, next);
    return next;
  } catch (err) {
    console.warn(`[API] prompt-history capture failed for ${id}: ${err.message}`);
    return null;
  }
}

// The authored-prompt field an agent versions, and its current authored content
// (the string the human edits), resolved from config + AGENT-PROMPT.md. A team
// versions its `systemPromptTemplate`; everyone else versions `systemPrompt`
// (materialized in AGENT-PROMPT.md). Returns { field, content }.
function resolveAuthoredPrompt(id, cfg) {
  if (cfg && cfg.role === 'team') {
    return { field: 'systemPromptTemplate', content: typeof cfg.systemPromptTemplate === 'string' ? cfg.systemPromptTemplate : '' };
  }
  // Prefer the materialized AGENT-PROMPT.md (the byte-exact authored text); fall
  // back to config.systemPrompt when the file isn't there yet.
  const fallback = (cfg && typeof cfg.systemPrompt === 'string') ? cfg.systemPrompt : '';
  // Containment re-check (see captureAuthoredPromptEdit) — `id` is AGENT_ID_RE-
  // validated upstream; confirm the resolved dir stays under AGENTS_DIR for CodeQL.
  const agentsBaseDir = path.resolve(AGENTS_DIR);
  const agentDir = path.resolve(agentsBaseDir, id);
  const rel = path.relative(agentsBaseDir, agentDir);
  let content = fallback;
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
    try { content = fs.readFileSync(path.join(agentDir, 'AGENT-PROMPT.md'), 'utf8'); }
    catch { content = fallback; }
  }
  return { field: 'systemPrompt', content };
}

app.get('/api/agents/:id/prompt', (req, res) => {
  const { id } = req.params;
  if (!AGENT_ID_RE.test(id)) return res.status(400).json({ error: 'Invalid agent id' });
  const agentsBaseDir = path.resolve(AGENTS_DIR);
  const agentDir = path.resolve(agentsBaseDir, id);
  const rel = path.relative(agentsBaseDir, agentDir);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return res.status(400).json({ error: 'Invalid agent id' });
  const promptPath = path.join(agentDir, 'AGENT-PROMPT.md');
  if (!fs.existsSync(agentDir)) return res.status(404).json({ error: 'Agent not found' });
  let content = '';
  try { content = fs.readFileSync(promptPath, 'utf8'); } catch { /* file may not exist yet */ }
  res.json({ content });
});

app.put('/api/agents/:id/prompt', apiLimiter, (req, res) => {
  const { id } = req.params;
  if (!AGENT_ID_RE.test(id)) return res.status(400).json({ error: 'Invalid agent id' });
  const agentsBaseDir = path.resolve(AGENTS_DIR);
  const agentDir = path.resolve(agentsBaseDir, id);
  const rel = path.relative(agentsBaseDir, agentDir);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return res.status(400).json({ error: 'Invalid agent id' });
  if (!fs.existsSync(agentDir)) return res.status(404).json({ error: 'Agent not found' });
  // Config-write authorization (#989): a prompt edit is a management action, not
  // a visibility one — require team-admin rights over the agent's owning team.
  const promptCfg = readJsonFile(path.join(agentDir, 'config.json'), null);
  if (!canManageAgent(getScope(req), agentMetaForScope(promptCfg || {}))) {
    return res.status(403).json({ error: 'forbidden', code: 'forbidden' });
  }
  const { content } = req.body;
  if (typeof content !== 'string') return res.status(400).json({ error: 'content must be a string' });
  const promptPath = path.join(agentDir, 'AGENT-PROMPT.md');
  // #990: snapshot the previous authored prompt before we overwrite it. (Rollback
  // has its own route that stamps action:'reverted'; a direct edit here is 'edited'.)
  const cfg = readJsonFile(path.join(agentDir, 'config.json'), null);
  const prev = resolveAuthoredPrompt(id, cfg);
  captureAuthoredPromptEdit(id, {
    field: 'systemPrompt', oldContent: prev.content, newContent: content, req, action: 'edited',
  });
  const tmp = promptPath + '.tmp';
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, promptPath);
  // Mirror exactly what we wrote into an isolated agent's volume (#185 item 5).
  // Only AGENT-PROMPT.md — CLAUDE.md references the prompt via `@AGENT-PROMPT.md`
  // (#510), so rewriting this one file is sufficient and the static CLAUDE.md
  // never needs a rebuild for a prompt edit.
  notifyAgentReseed(id, ['AGENT-PROMPT.md']);
  res.json({ ok: true });
});

/* ─── Agent Prompt version history (#990) ────────────────────────────── */

// GET the bounded version history (content-free summary + preview snippets).
app.get('/api/agents/:id/prompt-history', (req, res) => {
  const { id } = req.params;
  if (!AGENT_ID_RE.test(id)) return res.status(400).json({ error: 'Invalid agent id' });
  const agentsBaseDir = path.resolve(AGENTS_DIR);
  const agentDir = path.resolve(agentsBaseDir, id);
  const rel = path.relative(agentsBaseDir, agentDir);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return res.status(400).json({ error: 'Invalid agent id' });
  if (!fs.existsSync(agentDir)) return res.status(404).json({ error: 'Agent not found' });
  const cfg = readJsonFile(path.join(agentDir, 'config.json'), null);
  const existing = promptHistory.readPromptHistory(agentDir);
  if (!existing) {
    // No history yet — report the field the agent versions so the UI can render
    // an empty state without a second request.
    const { field } = resolveAuthoredPrompt(id, cfg);
    return res.json({ v: promptHistory.HISTORY_V, field, currentVersion: 0, history: [] });
  }
  res.json(promptHistory.summarize(existing));
});

// GET the full stored content of one version (for diff / preview before revert).
app.get('/api/agents/:id/prompt-history/:version', (req, res) => {
  const { id, version } = req.params;
  if (!AGENT_ID_RE.test(id)) return res.status(400).json({ error: 'Invalid agent id' });
  const agentsBaseDir = path.resolve(AGENTS_DIR);
  const agentDir = path.resolve(agentsBaseDir, id);
  const rel = path.relative(agentsBaseDir, agentDir);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return res.status(400).json({ error: 'Invalid agent id' });
  if (!fs.existsSync(agentDir)) return res.status(404).json({ error: 'Agent not found' });
  const existing = promptHistory.readPromptHistory(agentDir);
  const entry = promptHistory.findVersion(existing, version);
  if (!entry) return res.status(404).json({ error: `Version ${version} not retained` });
  res.json(entry);
});

// POST rollback to an earlier version. The target content is re-applied through
// the SAME write path a normal edit uses (so preview stays byte-identical to what
// is seeded); capture then records a new head with action:'reverted'. Never
// destructive — a rollback is itself a new version.
app.post('/api/agents/:id/prompt-history/:version/revert', apiLimiter, async (req, res) => {
  const { id, version } = req.params;
  if (!AGENT_ID_RE.test(id)) return res.status(400).json({ error: 'Invalid agent id' });
  const agentsBaseDir = path.resolve(AGENTS_DIR);
  const agentDir = path.resolve(agentsBaseDir, id);
  const rel = path.relative(agentsBaseDir, agentDir);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return res.status(400).json({ error: 'Invalid agent id' });
  const cfgPath = path.join(agentDir, 'config.json');
  const cfg = readJsonFile(cfgPath, null);
  if (!cfg) return res.status(404).json({ error: 'Agent not found' });
  const existing = promptHistory.readPromptHistory(agentDir);
  const target = promptHistory.findVersion(existing, version);
  if (!target) return res.status(404).json({ error: `Version ${version} not retained` });
  const summary = promptHistory.summarize(existing);
  const note = `from v${summary.currentVersion} to v${target.version}`;
  const targetContent = typeof target.content === 'string' ? target.content : '';

  try {
    if (cfg.role === 'team') {
      // Route through the orchestrator so the reverted template is pushed to all
      // inheriting members (same path as updateTeamPrompt).
      captureAuthoredPromptEdit(id, {
        field: 'systemPromptTemplate',
        oldContent: typeof cfg.systemPromptTemplate === 'string' ? cfg.systemPromptTemplate : '',
        newContent: targetContent, req, action: 'reverted', note,
      });
      const orchestratorUrl = process.env.ORCHESTRATOR_URL || 'http://orchestrator:4002';
      const resp = await fetch(`${orchestratorUrl}/internal/teams/${encodeURIComponent(id)}/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ systemPromptTemplate: targetContent }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) return res.status(resp.status).json(data);
    } else if (cfg.role === 'team-member') {
      // A member revert re-establishes an override (or switches back to inherit
      // when the target version was an inherit-clear, i.e. empty content).
      const fresh = readJsonFile(cfgPath, cfg);
      const prev = resolveAuthoredPrompt(id, cfg);
      captureAuthoredPromptEdit(id, { field: 'systemPrompt', oldContent: prev.content, newContent: targetContent, req, action: 'reverted', note });
      // #1511: the version-history field is the authored override text. Preserve
      // the member's current mode when restoring it — an 'additional' member's
      // restored text is its addition (re-composed with the team template), not a
      // full override. An empty target always means inherit.
      const teamCfg = fresh.parentTeamId ? readJsonFile(path.join(AGENTS_DIR, fresh.parentTeamId, 'config.json'), null) : null;
      const teamTemplate = (teamCfg && typeof teamCfg.systemPromptTemplate === 'string') ? teamCfg.systemPromptTemplate : '';
      const curMode = resolvePromptMode(cfg);
      let resolvedPrompt;
      if (targetContent.length === 0) {
        delete fresh.systemPrompt; // inherit
        delete fresh.promptMode;
        resolvedPrompt = teamTemplate;
      } else if (curMode === PROMPT_MODES.ADDITIONAL) {
        fresh.systemPrompt = targetContent;
        fresh.promptMode = PROMPT_MODES.ADDITIONAL;
        resolvedPrompt = composeMemberPrompt(PROMPT_MODES.ADDITIONAL, teamTemplate, targetContent);
      } else {
        fresh.systemPrompt = targetContent; // exclusive
        delete fresh.promptMode;
        resolvedPrompt = targetContent;
      }
      writeJsonAtomic(cfgPath, fresh);
      const promptPath = path.join(agentDir, 'AGENT-PROMPT.md');
      const tmp = promptPath + '.tmp';
      fs.writeFileSync(tmp, resolvedPrompt, 'utf8');
      fs.renameSync(tmp, promptPath);
      notifyAgentReseed(id, ['AGENT-PROMPT.md']);
    } else {
      // Standalone agent (or any other role) — raw AGENT-PROMPT.md rewrite.
      const prev = resolveAuthoredPrompt(id, cfg);
      captureAuthoredPromptEdit(id, { field: 'systemPrompt', oldContent: prev.content, newContent: targetContent, req, action: 'reverted', note });
      const promptPath = path.join(agentDir, 'AGENT-PROMPT.md');
      const tmp = promptPath + '.tmp';
      fs.writeFileSync(tmp, targetContent, 'utf8');
      fs.renameSync(tmp, promptPath);
      notifyAgentReseed(id, ['AGENT-PROMPT.md']);
    }
  } catch (err) {
    return res.status(502).json({ error: `Revert failed: ${err.message}` });
  }

  const updated = promptHistory.summarize(promptHistory.readPromptHistory(agentDir));
  res.json({ ok: true, revertedTo: target.version, currentVersion: updated.currentVersion, history: updated.history });
});

/* ─── Agent Model Selection ─────────────────────────────────────────── */

// The CREDENTIAL tenant of an agent — which access scope's model providers, SSH
// keys and GitHub tokens it may use. A team-member inherits it from its parent
// Agent Team; `parentTeamId` is an Agent-Team id and is never itself a tenant
// (see resolveAgentTenant in scope.js).
//
// NOT an authorization answer since #2078 — use `agentMetaForScope` for that.
// Credential records are still stamped with access-scope ids until P5 re-points
// them, which is why this hop survives the D1 collapse; it retires with them.
function agentTeamId(cfg) {
  return resolveAgentTenant(cfg, (id) => (
    AGENT_ID_RE.test(id) ? readJsonFile(path.join(AGENTS_DIR, id, 'config.json'), null) : null
  ));
}

// The minimal agent shape visibleAgent()/canManageAgent() need: the ACCESS
// boundary plus the owner. Since #2078 the boundary is the Agent Team read
// straight off the config (agent-team.js) — no parent read, no fs access — and
// is `null` for a standalone `role: 'agent'`, which ownership then decides (D8).
// `visibility` is gone from the shape: nothing ever wrote the field and D8
// retires it (concept §3.5).
function agentMetaForScope(cfg) {
  return { teamId: resolveAgentTeam(cfg), ownerId: cfg && cfg.ownerId };
}

// Config-write authorization guard (#989). Derives the agent's owning team from
// its on-disk config and 403s the response when the caller lacks team-admin
// management rights over it. Returns true when it has already sent a denial (the
// route should `return` immediately), false when the caller may proceed. Accepts
// either the agent directory or an already-loaded config object.
function denyUnlessCanManageAgent(req, res, agentDirOrCfg) {
  const cfg = typeof agentDirOrCfg === 'string'
    ? readJsonFile(path.join(agentDirOrCfg, 'config.json'), null)
    : agentDirOrCfg;
  if (!canManageAgent(getScope(req), agentMetaForScope(cfg || {}))) {
    res.status(403).json({ error: 'forbidden', code: 'forbidden' });
    return true;
  }
  return false;
}

// The D9 Team-Member boundary on the WORK plane (#2080, epic #2076 P2 / AC7b) —
// the express half of `team-member-boundary.js`, which carries the §6 matrix,
// the decision and the reasoning.
//
// `denyUnlessCanManageAgent` above serves the config plane, where a route is
// entirely a mutation. The work plane is different: reads and writes share a
// route prefix (`…/workspace/`, `…/context/`), so the split cannot be a mount
// and has to be per-route — which is why this is a middleware rather than a
// second `app.use`. It is applied to the ten `manage`-class routes of the
// matrix and to nothing else; `work-plane-boundary-routes.test.js` asserts
// exactly that, in both directions.
//
// Refuses 404 while the agent is invisible and only then 403, so a caller who
// cannot see an agent never learns it exists from a write attempt.
const requireAgentManage = createAgentManageGate({
  getScope,
  loadAgentMeta: (id) => {
    const cfg = readJsonFile(path.join(AGENTS_DIR, id, 'config.json'), null);
    // An unreadable or absent config means the agent's access boundary is
    // unknown. Fail closed as absent rather than guessing a tenant — the same
    // rule `work-plane-access.js` applies for the same reason.
    return cfg ? agentMetaForScope(cfg) : null;
  },
  isValidAgentId: (id) => AGENT_ID_RE.test(id),
  visibleAgent,
  canManageAgent,
});

// The Model Providers a given team is entitled to use — team-owned endpoints
// plus system-scoped endpoints assigned to that team. This is the ONLY set an
// agent may be switched to (no cross-team leakage), and — unlike
// visibleCredential — it is role-independent, so a plain Team Member sees the
// same curated set a Team Admin does (#302 credential listing stays closed to
// members; this is a narrower, agent-scoped surface).
// Model-provider reachability = the generic team/scope rule OR the global-
// provider rule (#2136). The global check lives HERE, at the provider call
// sites, and never inside scope.js's `visibleCredential`/`credentialVisibleToTeam`
// (which also gate SSH keys and GitHub tokens — finding 2). `isGlobalProvider`
// re-reads `global && scope==='system' && authType!=='oauth-token'` on every call
// (finding 1), so a provider that was published global and later mutated (e.g.
// switched to a subscription seat) is no longer reachable through these.
function providerVisible(scope, ep) {
  return isGlobalProvider(ep) || visibleCredential(scope, ep);
}
function providerUsableByTeam(ep, teamId) {
  return isGlobalProvider(ep) || credentialVisibleToTeam(ep, teamId);
}

function usableEndpointsForTeam(teamId) {
  return listLlmEndpoints().filter(ep => providerUsableByTeam(ep, teamId));
}

// The non-secret projection of an endpoint sent to the chat UI (never a token).
function publicEndpointView(ep) {
  if (!ep) return null;
  return {
    id: ep.id,
    name: ep.name || ep.id,
    // System/Team scope so the chat selector can render the same scope badge as
    // the header assist selector (#1670 AC3). Mirrors maskAssistProvider's rule:
    // legacy endpoints with no `scope` field are treated as team-owned.
    scope: ep.scope === 'system' ? 'system' : 'team',
    // #2136: so the chat/env provider picker can badge a global provider. Derived
    // via isGlobalProvider (not echoing the raw flag) so a record carrying a stale
    // `global: true` — e.g. one since switched to a subscription seat — is not
    // badged global in the picker (finding 3b).
    global: isGlobalProvider(ep),
    authType: ep.authType === 'oauth-token' ? 'oauth-token' : 'api-key',
    baseUrl: ep.baseUrl || '',
    defaultModelId: ep.defaultModelId || null,
    models: ep.models || [],
  };
}

// The effective endpoint id an agent runs on: a per-agent provider override
// wins over the environment's binding (mirrors resolveLlmBindingForAgent in the
// orchestrator).
function effectiveEndpointId(cfg, env) {
  return (cfg && cfg.llmEndpointOverride) || (env && env.llmEndpointId) || null;
}

// Resolve everything the chat UI needs to render the model + provider picker for
// an agent: the effective endpoint+catalog (override wins over the env binding),
// the environment-level default, the agent-level model override, and the curated
// set of providers this agent's team may switch to.
app.get('/api/agents/:id/model-options', (req, res) => {
  const { id } = req.params;
  if (!AGENT_ID_RE.test(id)) return res.status(400).json({ error: 'Invalid agent id' });
  const cfgPath = path.join(AGENTS_DIR, id, 'config.json');
  const cfg = readJsonFile(cfgPath, null);
  if (!cfg) return res.status(404).json({ error: 'Agent not found' });
  // Fail closed for team-foreign callers — a 404 avoids leaking existence.
  const scope = getScope(req);
  if (!visibleAgent(scope, agentMetaForScope(cfg))) {
    return res.status(404).json({ error: 'Agent not found' });
  }
  const env = cfg.environmentId ? loadEnvironment(cfg.environmentId) : null;
  const effEndpointId = effectiveEndpointId(cfg, env);
  const endpoint = effEndpointId
    ? listLlmEndpoints().find(e => e.id === effEndpointId)
    : null;
  const teamId = agentTeamId(cfg);
  // AC5: the bound provider's last-known health, so Agent Chat can warn (non-
  // blocking) when the agent's endpoint is currently red. This GET fires on
  // agent selection — trigger a fresh on-demand probe if the status is stale so
  // the warning isn't shown off an old reading (non-blocking; the reading here
  // stays honest and a subsequent open reflects the refresh).
  if (endpoint) refreshHealthIfStale(endpoint);
  res.json({
    endpointId:     endpoint?.id || null,
    endpointName:   endpoint?.name || null,
    authType:       endpoint ? (endpoint.authType === 'oauth-token' ? 'oauth-token' : 'api-key') : null,
    baseUrl:        endpoint?.baseUrl || null,
    // Persisted health of the effective bound endpoint (#1843); 'unknown' when
    // never probed / no endpoint bound.
    endpointHealth: endpoint ? llmHealthViewFor(endpoint.id) : llmHealth.healthView(null),
    // The provider is bound at the env level unless the agent carries an override.
    endpointOverride: cfg.llmEndpointOverride || null,
    envEndpointId:  env?.llmEndpointId || null,
    // env-level pin wins; otherwise show whatever the registry default is so
    // the picker label matches what the agent will actually use.
    defaultModelId: env?.defaultModelId || endpoint?.defaultModelId || null,
    override:       cfg.modelOverride || null,
    models:         endpoint?.models || [],
    // Curated set of providers this agent's team may switch to (never tokens).
    endpoints:      usableEndpointsForTeam(teamId).map(publicEndpointView),
    // #1213: the team agent's assist-synthesis provider (curator promotion /
    // distillation bill against it). Team-agent-only; null on other roles.
    assistLlmEndpointId: cfg.role === 'team' ? (cfg.assistLlmEndpointId || null) : null,
    // Whether THIS caller may actually change the model/provider — a management
    // action (#989), so the picker is read-only for a plain Team Member.
    canSwitch:      canManageAgent(scope, agentMetaForScope(cfg)),
    teamId,
  });
});

app.patch('/api/agents/:id/model', apiLimiter, (req, res) => {
  const { id } = req.params;
  if (!AGENT_ID_RE.test(id)) return res.status(400).json({ error: 'Invalid agent id' });
  const cfgPath = path.join(AGENTS_DIR, id, 'config.json');
  const cfg = readJsonFile(cfgPath, null);
  if (!cfg) return res.status(404).json({ error: 'Agent not found' });
  // Config-write authorization (#989): changing the model is a management
  // action — require team-admin rights over the agent's owning team, not mere
  // visibility (a plain Team Member may see the agent but not reconfigure it).
  const scope = getScope(req);
  if (!canManageAgent(scope, agentMetaForScope(cfg))) {
    return res.status(403).json({ error: 'forbidden', code: 'forbidden' });
  }
  const { modelId } = req.body || {};

  // null / "" / undefined → clear override (fall back to env default)
  if (modelId === null || modelId === undefined || modelId === '') {
    if ('modelOverride' in cfg) {
      delete cfg.modelOverride;
      writeJsonAtomic(cfgPath, cfg);
    }
    return res.json({ override: null });
  }

  if (typeof modelId !== 'string') {
    return res.status(400).json({ error: 'modelId must be a string or null' });
  }

  // Validate against the EFFECTIVE endpoint's catalog (a per-agent provider
  // override wins over the env binding) so an agent can't be pinned to a model
  // the active provider doesn't actually serve.
  const env = cfg.environmentId ? loadEnvironment(cfg.environmentId) : null;
  const effEndpointId = effectiveEndpointId(cfg, env);
  if (!effEndpointId) {
    return res.status(400).json({ error: 'No LLM endpoint bound — set a provider before overriding the model' });
  }
  const endpoint = listLlmEndpoints().find(e => e.id === effEndpointId);
  if (!endpoint) {
    return res.status(400).json({ error: `LLM endpoint '${effEndpointId}' not found` });
  }
  if (!(endpoint.models || []).some(m => m.id === modelId)) {
    return res.status(400).json({ error: `Model '${modelId}' is not in endpoint '${endpoint.id}' catalog` });
  }

  cfg.modelOverride = modelId;
  writeJsonAtomic(cfgPath, cfg);
  res.json({ override: modelId });
});

// Switch the Model Provider (LLM endpoint) for a single agent. Unlike the model
// override (read live by the runtime), the provider is injected at container
// spawn time, so a change requires a one-agent respawn — done best-effort after
// the config write. Permission model (see docs/multi-user-concept.md):
//   • the caller must have team-admin management rights over the agent's owning
//     team (#989) — not mere visibility — 403 else
//   • the target endpoint must be in the agent team's curated, usable set
//     (credentialVisibleToTeam) — never a provider the team isn't entitled to,
//     not even for a System Admin — 403 else
app.patch('/api/agents/:id/provider', apiLimiter, async (req, res) => {
  const { id } = req.params;
  if (!AGENT_ID_RE.test(id)) return res.status(400).json({ error: 'Invalid agent id' });
  const cfgPath = path.join(AGENTS_DIR, id, 'config.json');
  const cfg = readJsonFile(cfgPath, null);
  if (!cfg) return res.status(404).json({ error: 'Agent not found' });
  const scope = getScope(req);
  if (!canManageAgent(scope, agentMetaForScope(cfg))) {
    return res.status(403).json({ error: 'forbidden', code: 'forbidden' });
  }

  const { endpointId } = req.body || {};
  const teamId = agentTeamId(cfg);

  // null / "" / undefined → clear the override (back to the env default).
  if (endpointId === null || endpointId === undefined || endpointId === '') {
    if ('llmEndpointOverride' in cfg) {
      delete cfg.llmEndpointOverride;
      // A model pin that only made sense on the overridden provider is dropped;
      // the env provider re-validates its own default anyway.
      pruneIncompatibleModelOverride(cfg, effectiveEndpointId(cfg, cfg.environmentId ? loadEnvironment(cfg.environmentId) : null));
      writeJsonAtomic(cfgPath, cfg);
    }
    const respawned = await respawnAgentBestEffort(id, 'provider-override-cleared');
    return res.json({ endpointOverride: null, respawned });
  }

  if (typeof endpointId !== 'string') {
    return res.status(400).json({ error: 'endpointId must be a string or null' });
  }
  const target = usableEndpointsForTeam(teamId).find(ep => ep.id === endpointId);
  if (!target) {
    return res.status(403).json({
      error: `Model provider '${endpointId}' is not available for team '${teamId}'`,
      code: 'forbidden',
    });
  }

  cfg.llmEndpointOverride = endpointId;
  // Drop a stale model pin the new provider doesn't serve, so the agent falls
  // back to the new provider's default instead of failing at invocation.
  pruneIncompatibleModelOverride(cfg, endpointId);
  writeJsonAtomic(cfgPath, cfg);
  const respawned = await respawnAgentBestEffort(id, 'provider-override-changed');
  res.json({ endpointOverride: endpointId, respawned });
});

// Clear cfg.modelOverride when it isn't in the (resolved) endpoint's catalog.
function pruneIncompatibleModelOverride(cfg, endpointId) {
  if (!cfg.modelOverride) return;
  const ep = endpointId ? listLlmEndpoints().find(e => e.id === endpointId) : null;
  if (!ep || !(ep.models || []).some(m => m.id === cfg.modelOverride)) {
    delete cfg.modelOverride;
  }
}

// Ask the orchestrator to recreate the agent's running container so a new
// spawn-time binding takes effect. Best-effort: a stopped orchestrator or a
// disabled/stub agent simply yields respawned:false, never an API error.
async function respawnAgentBestEffort(id, reason) {
  const orchestratorUrl = process.env.ORCHESTRATOR_URL || 'http://orchestrator:4002';
  try {
    const r = await fetch(`${orchestratorUrl}/internal/agents/${encodeURIComponent(id)}/respawn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason }),
    });
    if (!r.ok) return false;
    const body = await r.json().catch(() => ({}));
    return Boolean(body && body.respawned);
  } catch (err) {
    console.error(`[api] respawn ${id} failed: ${err.message}`);
    return false;
  }
}

// Ask the orchestrator to rebuild an agent's CLAUDE.md after a config change
// the prompt is gated on (#1286: the `/context` section appears iff a mount is
// set). Best-effort — the config write has already succeeded either way.
async function rebuildAgentPromptBestEffort(id, reason) {
  const orchestratorUrl = process.env.ORCHESTRATOR_URL || 'http://orchestrator:4002';
  try {
    const r = await fetch(`${orchestratorUrl}/internal/agents/${encodeURIComponent(id)}/prompt-rebuild`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason }),
    });
    if (!r.ok) return false;
    const body = await r.json().catch(() => ({}));
    return Boolean(body && body.rebuilt);
  } catch (err) {
    console.error(`[api] prompt rebuild ${id} failed: ${err.message}`);
    return false;
  }
}

/* ─── Read-only host-folder context mount (#1283) ───────────────────────── */

// The mount is a LOCAL/self-hosted-only feature: a host bind-mount has no
// meaning behind IAP/GKE (hard-off, first check). On the podman runtime it is
// always offered; on Kubernetes it renders as a hostPath volume — "host" means
// the node — so it takes the explicit AEE_K8S_CONTEXT_HOSTPATH=1 opt-in
// (#1319, kind/local single-node clusters only; hosted GKE never sets it).
// The provisioning side (orchestrator CONTEXT_MOUNT_RUNTIME_OK) mirrors this
// guard.
function isLocalContextMountEnv() {
  if (process.env.IAP_AUDIENCE) return false;
  const rt = String(process.env.AEE_CONTAINER_RUNTIME || 'podman').toLowerCase();
  return (rt !== 'kubernetes' && rt !== 'k8s') || process.env.AEE_K8S_CONTEXT_HOSTPATH === '1';
}

// Shape an agent config's resolved context folders for the API (#1290). One
// entry per mounted folder — legacy single folder and multi-folder alike —
// carrying the browse `key` (its in-container target, which the workspace
// browser uses to key each read-only root). Empty for an agent with no mount.
function shapeContextMounts(cfg) {
  return resolveContextMounts(cfg || {}).map((m) => ({
    name: m.name,
    hostPath: m.path,
    slug: m.slug,
    target: m.target,
    key: m.target,
    readWrite: m.readWrite === true,
  }));
}

// Whether the read-only host-folder context mount is offered in this
// environment, plus the fixed in-container target. The UI reads this to disable
// the control (with an explanation) on the hosted stack (AC8).
app.get('/api/context-mount/capability', (req, res) => {
  res.json({ supported: isLocalContextMountEnv(), mountPath: CONTEXT_MOUNT_TARGET });
});

// Set / clear the agent's read-only host-folder context mount. Like the provider
// override, the mount is baked at container spawn time, so a change requires a
// one-agent respawn — done best-effort after the config write (AC6). Guards:
//   • local/self-hosted only — 400 behind IAP, and on k8s without the
//     AEE_K8S_CONTEXT_HOSTPATH opt-in (AC8, #1319)
//   • the caller must have management rights over the agent's owning team (#989)
//   • the host path must pass basic server-side validation (AC7)
// A `team` agent hosts no container, so a mount there is meaningless → 400.
app.patch('/api/agents/:id/context-mount', apiLimiter, async (req, res) => {
  const { id } = req.params;
  if (!AGENT_ID_RE.test(id)) return res.status(400).json({ error: 'Invalid agent id' });
  if (!isLocalContextMountEnv()) {
    return res.status(400).json({
      error: 'Host-folder context mounts are only available in the local / self-hosted environment',
      code: 'context-mount-unsupported',
    });
  }
  const cfgPath = path.join(AGENTS_DIR, id, 'config.json');
  const cfg = readJsonFile(cfgPath, null);
  if (!cfg) return res.status(404).json({ error: 'Agent not found' });
  const scope = getScope(req);
  if (!canManageAgent(scope, agentMetaForScope(cfg))) {
    return res.status(403).json({ error: 'forbidden', code: 'forbidden' });
  }
  if (cfg.role === 'team') {
    return res.status(400).json({ error: 'A team agent hosts no container; set the context mount on its members instead' });
  }

  // Multi-folder path (#1290): a `mounts` array supersedes the single-path body.
  // Each entry is validated + given a stable slug by the pure normalizer; the
  // whole legacy single-folder shape is dropped so the two never coexist on disk.
  if (req.body && Array.isArray(req.body.mounts)) {
    const norm = normalizeContextMountsInput(req.body.mounts);
    if (!norm.ok) return res.status(400).json({ error: norm.error, code: 'invalid-host-path' });
    let changed = false;
    if (norm.mounts.length === 0) {
      // Empty array → clear every folder (back to no external context).
      if ('contextMounts' in cfg || 'contextMount' in cfg || 'contextMountRw' in cfg) {
        delete cfg.contextMounts;
        delete cfg.contextMount;
        delete cfg.contextMountRw;
        changed = true;
      }
    } else {
      cfg.contextMounts = norm.mounts;
      // Never keep the legacy single-folder keys alongside the array.
      delete cfg.contextMount;
      delete cfg.contextMountRw;
      changed = true;
    }
    if (changed) writeJsonAtomic(cfgPath, cfg);
    // Rebuild the prompt before the respawn so the new container starts with the
    // enumerated Context Folders section already in its CLAUDE.md (or without it
    // when cleared) — the agent is never told about a folder it cannot read.
    const reason = norm.mounts.length ? 'context-mount-changed' : 'context-mount-cleared';
    if (changed) await rebuildAgentPromptBestEffort(id, reason);
    const respawned = changed ? await respawnAgentBestEffort(id, reason) : false;
    return res.json({ mounts: shapeContextMounts(cfg), mountPath: CONTEXT_MOUNT_TARGET, respawned });
  }

  const hostPath = req.body ? req.body.path : undefined;
  // Read-write opt-in (#1289): strictly boolean-true enables it; anything else
  // (absent / false / non-boolean) stays read-only, the safe default.
  const readWrite = !!(req.body && req.body.readWrite === true);
  // null / '' / undefined → clear the mount (back to no external context).
  if (hostPath === null || hostPath === undefined || hostPath === '') {
    let changed = false;
    if ('contextMount' in cfg || 'contextMountRw' in cfg || 'contextMounts' in cfg) {
      delete cfg.contextMount;
      delete cfg.contextMountRw;
      delete cfg.contextMounts;
      writeJsonAtomic(cfgPath, cfg);
      changed = true;
    }
    // Drop the `/context` section from the prompt before the container loses
    // the mount, so the agent is never told about a folder it cannot read.
    if (changed) await rebuildAgentPromptBestEffort(id, 'context-mount-cleared');
    const respawned = changed ? await respawnAgentBestEffort(id, 'context-mount-cleared') : false;
    return res.json({ contextMount: null, readWrite: false, mounts: [], mountPath: CONTEXT_MOUNT_TARGET, respawned });
  }

  if (typeof hostPath !== 'string') {
    return res.status(400).json({ error: 'path must be a string host directory (or null to clear)' });
  }
  const v = validateHostMountPath(hostPath);
  if (!v.ok) return res.status(400).json({ error: v.error, code: 'invalid-host-path' });

  cfg.contextMount = v.path;
  // Persist the access-mode flag only when read-write is on: a read-only mount
  // carries no `contextMountRw` key, so its config (and the container spec built
  // from it) stays byte-identical to a pre-#1289 agent (AC7).
  if (readWrite) cfg.contextMountRw = true;
  else delete cfg.contextMountRw;
  // A single-path write is the legacy shape → never leave a multi-folder array
  // behind (switching from many folders back to one clears the rest).
  delete cfg.contextMounts;
  writeJsonAtomic(cfgPath, cfg);
  // Tell the agent the folder exists (#1286) — a mount nobody documented is a
  // mount nobody uses. Rebuilt before the respawn so the new container starts
  // with the section already in its CLAUDE.md.
  await rebuildAgentPromptBestEffort(id, 'context-mount-changed');
  const respawned = await respawnAgentBestEffort(id, 'context-mount-changed');
  res.json({ contextMount: v.path, readWrite, mounts: shapeContextMounts(cfg), mountPath: CONTEXT_MOUNT_TARGET, respawned });
});

/* ─── Browsing the context mount (#1286) ─────────────────────────────────
 * The mounted host folder is visible only inside the agent's container, so
 * these routes are pure proxies onto the orchestrator's read-only browse
 * endpoints — this container never touches the container engine for agent
 * data, and there is deliberately no write counterpart to any of them.
 */

// One-shot call onto an orchestrator context-browse endpoint. Returns the
// parsed body plus its status so each route can pass the orchestrator's honest
// error (agent not running, path refused, folder unmounted) straight through.
async function fetchContextBrowse(agentId, kind, relPath) {
  const orchestratorUrl = process.env.ORCHESTRATOR_URL || 'http://orchestrator:4002';
  const url = `${orchestratorUrl}/internal/agents/${encodeURIComponent(agentId)}/context/${kind}`
            + `?path=${encodeURIComponent(relPath || '')}`;
  const r = await fetch(url);
  const body = await r.json().catch(() => ({}));
  return { status: r.status, body };
}

// Whether this agent has a context folder at all — drives the virtual root in
// the workspace browser. Read straight from config; no container involved, so
// it answers the same for a stopped agent.
app.get('/api/agents/:agentId/context/status', apiLimiter, (req, res) => {
  const { agentId } = req.params;
  if (!AGENT_ID_RE.test(agentId)) return res.status(400).json({ error: 'Invalid agent id' });
  // Resolved through the canonical containment helper (realpath +
  // path.relative), so the config read cannot leave the agents tree even if the
  // id pattern ever loosens — the same barrier the workspace routes use.
  const cfgPath = safeAgentPath(agentId, 'config.json');
  if (!cfgPath) return res.status(404).json({ error: 'Agent not found' });
  const cfg = readJsonFile(cfgPath, null);
  if (!cfg) return res.status(404).json({ error: 'Agent not found' });
  // #1290: one entry per mounted folder (legacy single folder and multi-folder
  // alike). `mounts` drives one read-only root per folder in the workspace
  // browser; the top-level `hostPath`/`readWrite` mirror the first folder for
  // backward compatibility with any older caller.
  const mounts = shapeContextMounts(cfg);
  const first = mounts[0] || null;
  res.json({
    enabled: mounts.length > 0,
    mounts,
    hostPath: first ? first.hostPath : null,
    readWrite: !!(first && first.readWrite),
    mountPath: CONTEXT_MOUNT_TARGET,
    supported: isLocalContextMountEnv(),
  });
});

/* ─── Agent-scoped repositories (#2067) ──────────────────────────────────────
 * A repository attached to ONE agent, outside its Working Environment. The
 * orchestrator owns every rule (the pure `orchestrator/agent-repositories.js`)
 * and every side effect (clone, delete, prompt rebuild); these three routes are
 * the authorization boundary and nothing else — deliberately thin, so no part
 * of the decision exists twice.
 *
 * AC12 / D4: attaching or removing is a MANAGEMENT act (it pulls foreign code
 * into a container), so both mutations are gated by `canManageAgent` — the
 * `PATCH /api/agents/:id/context-mount` precedent, and the first per-agent gate
 * on this family of routes: the neighbouring `/api/agents/:id/workspace/*`
 * routes carry none, which is a pre-existing gap this ticket does not widen.
 * Reading the list is gated by `visibleAgent` instead, because the Workspace
 * view shows the repositories to a chat-only user; what that user does not get
 * is the action.
 */

// Resolve the agent's config and the caller's rights over it in one place, so
// the read and the two mutations cannot drift in who they let through.
function resolveAgentRepoAccess(req, id, { manage }) {
  if (!AGENT_ID_RE.test(id)) return { status: 400, error: 'Invalid agent id' };
  const cfgPath = safeAgentPath(id, 'config.json');
  if (!cfgPath) return { status: 404, error: 'Agent not found' };
  const cfg = readJsonFile(cfgPath, null);
  if (!cfg) return { status: 404, error: 'Agent not found' };
  const scope = getScope(req);
  const meta = agentMetaForScope(cfg);
  const manageable = canManageAgent(scope, meta);
  if (manage) {
    if (!manageable) return { status: 403, error: 'forbidden', code: 'forbidden' };
  } else if (!visibleAgent(scope, agentMetaForScope(cfg))) {
    return { status: 404, error: 'Agent not found' };
  }
  return { cfg, canManage: manageable };
}

// Relay an orchestrator repositories response verbatim. The orchestrator maps
// each pure-planner refusal code onto a status already, and its message is the
// one the two surfaces render — re-wording it here would give the same refusal
// two different texts depending on which container answered.
async function proxyAgentRepositories(res, id, method, body, extra = {}) {
  try {
    const resp = await fetch(`${ORCH_URL()}/internal/agents/${encodeURIComponent(id)}/repositories`, {
      method,
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    });
    const payload = await resp.json().catch(() => ({ error: 'Malformed orchestrator response' }));
    // `canManage` is added HERE, not upstream: the orchestrator's :4002 API
    // never learns which HUMAN is asking — since #1456 it authenticates the
    // calling *service or agent*, not the console's end user. It rides on every
    // response so the panel can disable what the server would refuse (the
    // `GET /api/matrix/agents` precedent), while the refusal itself stays
    // server-side on the two mutating routes.
    return res.status(resp.status).json(resp.ok ? { ...payload, ...extra } : payload);
  } catch (err) {
    return res.status(502).json({ error: `Orchestrator unreachable: ${err.message}` });
  }
}

// The merged environment+agent list. Each agent-scoped entry carries the git
// facts a removal confirmation names (AC9), so the dialog needs no second call.
app.get('/api/agents/:id/repositories', apiLimiter, async (req, res) => {
  const access = resolveAgentRepoAccess(req, req.params.id, { manage: false });
  if (access.status) return res.status(access.status).json({ error: access.error, ...(access.code ? { code: access.code } : {}) });
  return proxyAgentRepositories(res, req.params.id, 'GET', undefined, { canManage: access.canManage });
});

// Attach one repository to this agent and clone it. heavyLimiter: this runs a
// real `git clone`, like the sync routes next door.
app.post('/api/agents/:id/repositories', heavyLimiter, async (req, res) => {
  const access = resolveAgentRepoAccess(req, req.params.id, { manage: true });
  if (access.status) return res.status(access.status).json({ error: access.error, ...(access.code ? { code: access.code } : {}) });
  const b = req.body && typeof req.body === 'object' ? req.body : {};
  // Whitelisted, not forwarded wholesale: D5 forbids a per-repository
  // credential, and the orchestrator's normalizer drops unknown keys anyway —
  // dropping them here too keeps the wire contract readable.
  return proxyAgentRepositories(res, req.params.id, 'POST', {
    url: typeof b.url === 'string' ? b.url : '',
    branch: typeof b.branch === 'string' ? b.branch : null,
    sshKeyId: typeof b.sshKeyId === 'string' ? b.sshKeyId : null,
    readOnly: b.readOnly === true,
  }, { canManage: access.canManage });
});

// Detach one repository and delete its working copy (AC9). The URL travels in
// the body rather than the path: a repository URL is not path-safe, and the
// list is keyed by URL, not by an id we would otherwise have to invent.
app.delete('/api/agents/:id/repositories', heavyLimiter, async (req, res) => {
  const access = resolveAgentRepoAccess(req, req.params.id, { manage: true });
  if (access.status) return res.status(access.status).json({ error: access.error, ...(access.code ? { code: access.code } : {}) });
  const b = req.body && typeof req.body === 'object' ? req.body : {};
  return proxyAgentRepositories(res, req.params.id, 'DELETE', {
    url: typeof b.url === 'string' ? b.url : '',
  }, { canManage: access.canManage });
});

// Provisioned custom slash commands for an agent (#1796, foundation for #1797).
// Returns [{ command, name, namespace, skill, invocation, description }] read
// from the agent's seeded-commands.json — the truth the composer autocomplete
// (#1797) consumes. Proxies the orchestrator, which owns the manifest and its
// state-dir migration; a downstream reader gets name + description per command.
app.get('/api/agents/:agentId/commands', apiLimiter, async (req, res) => {
  const { agentId } = req.params;
  if (!AGENT_ID_RE.test(agentId)) return res.status(400).json({ error: 'Invalid agent id' });
  try {
    const resp = await fetch(`${ORCH_URL()}/internal/agents/${encodeURIComponent(agentId)}/commands`);
    const body = await resp.json().catch(() => null);
    if (!resp.ok || !body || body.ok === false) {
      return res.status(resp.status === 200 ? 502 : resp.status).json({ error: (body && body.error) || 'Reading provisioned commands failed' });
    }
    res.json({ agentId, commands: Array.isArray(body.commands) ? body.commands : [] });
  } catch (err) {
    console.error(`[api] commands ${agentId} failed: ${err.message}`);
    res.status(502).json({ error: 'Reading provisioned commands failed' });
  }
});

// Directory listing inside the mounted folder.
app.get('/api/agents/:agentId/context/tree', apiLimiter, async (req, res) => {
  const { agentId } = req.params;
  if (!AGENT_ID_RE.test(agentId)) return res.status(400).json({ error: 'Invalid agent id' });
  const relPath = typeof req.query.path === 'string' ? req.query.path : '';
  try {
    const { status, body } = await fetchContextBrowse(agentId, 'tree', relPath);
    res.status(status).json(body);
  } catch (err) {
    console.error(`[api] context tree ${agentId} failed: ${err.message}`);
    res.status(502).json({ error: 'Reading the context folder failed' });
  }
});

// File content for the viewer. The orchestrator returns capped base64; the
// binary / raster-image detection and the response shape are the SAME as the
// workspace `/file` route, so the viewer needs no special case.
app.get('/api/agents/:agentId/context/file', apiLimiter, async (req, res) => {
  const { agentId } = req.params;
  if (!AGENT_ID_RE.test(agentId)) return res.status(400).json({ error: 'Invalid agent id' });
  const relPath = typeof req.query.path === 'string' ? req.query.path : '';
  let status; let body;
  try {
    ({ status, body } = await fetchContextBrowse(agentId, 'file', relPath));
  } catch (err) {
    console.error(`[api] context file ${agentId} failed: ${err.message}`);
    return res.status(502).json({ error: 'Reading the context folder failed' });
  }
  if (status >= 300) return res.status(status).json(body);
  const buf = Buffer.from(String(body.content || ''), 'base64');
  const probe = buf.slice(0, Math.min(buf.length, 8192));
  const isBinary = probe.includes(0);
  const imageType = isBinary ? detectRasterImageType(buf) : null;
  res.json({
    path: body.path || '',
    size: typeof body.size === 'number' ? body.size : buf.length,
    truncated: !!body.truncated,
    binary: isBinary,
    imageType,
    content: isBinary ? null : buf.toString('utf8'),
    mtime: typeof body.mtime === 'number' ? body.mtime : 0,
    readOnly: true,
  });
});

// Inline image bytes — same contract as the workspace `/image` route (supported
// raster formats only, detected by magic bytes, never by extension).
app.get('/api/agents/:agentId/context/image', apiLimiter, async (req, res) => {
  const { agentId } = req.params;
  if (!AGENT_ID_RE.test(agentId)) return res.status(400).json({ error: 'Invalid agent id' });
  const relPath = typeof req.query.path === 'string' ? req.query.path : '';
  let status; let body;
  try {
    ({ status, body } = await fetchContextBrowse(agentId, 'download', relPath));
  } catch (err) {
    console.error(`[api] context image ${agentId} failed: ${err.message}`);
    return res.status(502).json({ error: 'Reading the context folder failed' });
  }
  if (status >= 300) return res.status(status).json(body);
  const buf = Buffer.from(String(body.content || ''), 'base64');
  const contentType = imageContentType(detectRasterImageType(buf));
  if (!contentType) return res.status(415).json({ error: 'unsupported image type' });
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Length', buf.length);
  res.setHeader('Content-Disposition', 'inline');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(buf);
});

// Raw download. Capped by the orchestrator (the bytes travel base64 through an
// exec pipe, not a file stream) — a file over the cap arrives truncated, so it
// is refused outright rather than silently corrupted.
app.get('/api/agents/:agentId/context/download', apiLimiter, async (req, res) => {
  const { agentId } = req.params;
  if (!AGENT_ID_RE.test(agentId)) return res.status(400).json({ error: 'Invalid agent id' });
  const relPath = typeof req.query.path === 'string' ? req.query.path : '';
  let status; let body;
  try {
    ({ status, body } = await fetchContextBrowse(agentId, 'download', relPath));
  } catch (err) {
    console.error(`[api] context download ${agentId} failed: ${err.message}`);
    return res.status(502).json({ error: 'Reading the context folder failed' });
  }
  if (status >= 300) return res.status(status).json(body);
  if (body.truncated) {
    return res.status(413).json({
      error: 'File is too large to download through the context folder',
      code: 'too-large',
    });
  }
  const buf = Buffer.from(String(body.content || ''), 'base64');
  const filename = path.basename(String(body.path || 'download'));
  const encoded = encodeURIComponent(filename).replace(/'/g, '%27');
  res.setHeader('Content-Disposition', `attachment; filename="${encoded}"; filename*=UTF-8''${encoded}`);
  res.setHeader('Content-Length', buf.length);
  res.setHeader('Content-Type', 'application/octet-stream');
  res.end(buf);
});

/* ─── Agent Triggers ────────────────────────────────────────────────── */

app.get('/api/agents/:id/triggers', (req, res) => {
  const { id } = req.params;
  if (!AGENT_ID_RE.test(id)) return res.status(400).json({ error: 'Invalid agent id' });
  // Resolve the agent root through safeAgentPath so its path.relative
  // return-value barrier clears the CodeQL js/path-injection sink; null when
  // the dir is absent, byte-equivalent to the previous existsSync 404.
  const agentDir = safeAgentPath(id, '');
  if (!agentDir) return res.status(404).json({ error: 'Agent not found' });
  const triggers = readJsonFile(controlOrAgentPath(id, 'triggers.json'), []); // canonical copy (#185)
  res.json(Array.isArray(triggers) ? triggers : []);
});

// Read-only proxy to the orchestrator's allowlisted script content. Used by
// the trigger UI to render baked-in helper scripts (e.g. multi-agent-bid)
// inline so operators can see what the preCheckScript actually does.
const SCRIPT_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
app.get('/api/scripts/:name', apiLimiter, async (req, res) => {
  const { name } = req.params;
  if (!SCRIPT_NAME_RE.test(name)) {
    return res.status(400).json({ error: 'invalid script name' });
  }
  try {
    const orchestratorUrl = process.env.ORCHESTRATOR_URL || 'http://orchestrator:4002';
    const upstream = await fetch(`${orchestratorUrl}/internal/scripts/${encodeURIComponent(name)}`);
    const body = await upstream.text();
    res.status(upstream.status).type(upstream.headers.get('content-type') || 'application/json').send(body);
  } catch (err) {
    res.status(502).json({ error: `orchestrator unreachable: ${err.message}` });
  }
});

// #185 Phase 2: the orchestrator owns the canonical triggers.json (on the
// control plane when the agent's volume is isolated). Admin CRUD computes the
// new full array and PUTs it through the orchestrator, which persists it and
// signals the agent (SIGUSR2) to re-pull. We read the current array via
// controlOrAgentPath so it works on both the shared and isolated layouts.
async function putTriggers(agentId, triggers) {
  const orchestratorUrl = process.env.ORCHESTRATOR_URL || 'http://orchestrator:4002';
  const r = await fetch(
    `${orchestratorUrl}/internal/agents/${encodeURIComponent(agentId)}/triggers`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ triggers }),
    },
  );
  if (!r.ok) throw new Error(`orchestrator HTTP ${r.status}`);
}

app.post('/api/agents/:id/triggers', apiLimiter, async (req, res) => {
  const { id } = req.params;
  if (!AGENT_ID_RE.test(id)) return res.status(400).json({ error: 'Invalid agent id' });
  // Containment check: AGENT_ID_RE already excludes traversal segments, but
  // CodeQL doesn't recognise the regex as a sanitiser once the value is
  // destructured. Re-anchor under AGENTS_DIR with path.relative.
  const agentsBaseDir = path.resolve(AGENTS_DIR);
  const agentDir = path.resolve(agentsBaseDir, id);
  const rel = path.relative(agentsBaseDir, agentDir);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return res.status(400).json({ error: 'Invalid agent id' });
  if (!fs.existsSync(agentDir)) return res.status(404).json({ error: 'Agent not found' });
  // Config-write authorization (#989): triggers are agent config — gate on
  // team-admin management rights, not visibility.
  if (denyUnlessCanManageAgent(req, res, agentDir)) return;
  const cur = readJsonFile(controlOrAgentPath(id, 'triggers.json'), []);
  const triggers = Array.isArray(cur) ? cur : [];
  const newTrigger = { id: `t${Date.now()}`, ...req.body };
  // Raw-layer guard (#1006, concept §4.8): one event per github-event trigger
  // + claim shape — enforced server-side so no surface (engine dialog, panel,
  // direct API) can persist a non-conformant listener unchallenged again.
  const te = rawTriggerError(newTrigger);
  if (te) return res.status(400).json({ error: te });
  // Internal-channel transport (#1174): a mistyped value would silently leave
  // the listener poller-delivered while the producer runs `aee-emit` — checked
  // here (route-level), mirroring validateProcessTemplate's bundle check.
  const tpe = triggerTransportError(newTrigger);
  if (tpe) return res.status(400).json({ error: tpe });
  // At most one active chat-launched loop per agent (#1020 AC8). A launched
  // loop is a one-off run; a second launch while one runs would race two
  // runners, so reject it — the composer reflects the running state and
  // offers Stop instead of Start.
  if (launchedLoopConflict(triggers, newTrigger)) {
    return res.status(409).json({ error: 'A loop is already running for this agent. Stop it before starting another.' });
  }
  if (newTrigger.type === 'github-event') {
    const now = new Date().toISOString();
    if (!newTrigger.createdAt) newTrigger.createdAt = now;
    if (!newTrigger.activatedAt) newTrigger.activatedAt = now;
  }
  triggers.push(newTrigger);
  try {
    await putTriggers(id, triggers);
  } catch (err) {
    return res.status(502).json({ error: `Could not save triggers: ${err.message}` });
  }
  // A new listener is a CONSUMER write (#1007): sibling producers' generated
  // Outcomes blocks name their consumers, so re-render the team. Best-effort.
  await reconcileTeamOutcomesForAgent(id);
  res.status(201).json(newTrigger);
});

app.put('/api/agents/:id/triggers/:triggerId', apiLimiter, async (req, res) => {
  const { id, triggerId } = req.params;
  if (!AGENT_ID_RE.test(id)) return res.status(400).json({ error: 'Invalid agent id' });
  // Containment check (see POST handler): re-anchor under AGENTS_DIR so CodeQL
  // sees the traversal barrier even after the id is destructured.
  const agentsBaseDir = path.resolve(AGENTS_DIR);
  const agentDir = path.resolve(agentsBaseDir, id);
  const rel = path.relative(agentsBaseDir, agentDir);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return res.status(400).json({ error: 'Invalid agent id' });
  if (!fs.existsSync(agentDir)) return res.status(404).json({ error: 'Agent not found' });
  // Config-write authorization (#989): triggers are agent config — gate on
  // team-admin management rights, not visibility.
  if (denyUnlessCanManageAgent(req, res, agentDir)) return;
  const cur = readJsonFile(controlOrAgentPath(id, 'triggers.json'), []);
  const triggers = Array.isArray(cur) ? cur : [];
  const idx = triggers.findIndex(t => t.id === triggerId);
  if (idx === -1) return res.status(404).json({ error: 'Trigger not found' });
  const prev = triggers[idx];
  const merged = { ...prev, ...req.body, id: triggerId };
  // Trigger-level `emits` was removed (#783): the agent/role level is canonical.
  // Ignore any supplied `emits` and drop a legacy field so an edit never
  // re-persists it (a persisted-but-ignored value can't create a phantom edge).
  delete merged.emits;
  delete merged.emitsDerived;
  // Raw-layer guard (#1006, §4.8): reject a multi-event github-event trigger /
  // invalid claim — except a pre-existing multi-event trigger passing through
  // UNCHANGED (the LegacyMultiEventNote migration flow keeps working).
  const te = rawTriggerError(merged, prev);
  if (te) return res.status(400).json({ error: te });
  // Internal-channel transport (#1174) — same route-level check as POST.
  const tpe = triggerTransportError(merged);
  if (tpe) return res.status(400).json({ error: tpe });
  if (merged.type === 'github-event') {
    const now = new Date().toISOString();
    // Refresh the activation horizon on a disable→enable flip so a
    // re-enabled trigger drops the backlog that accrued while it was off.
    if (prev.enabled === false && merged.enabled !== false) merged.activatedAt = now;
    // Backfill the stamps on any edit of a legacy unstamped trigger. Its
    // horizon was already drifting with the triggers.json mtime; stamping it
    // now makes it stable for all subsequent edits (#320 review follow-up).
    if (!merged.createdAt) merged.createdAt = now;
    if (!merged.activatedAt) merged.activatedAt = now;
  }
  triggers[idx] = merged;
  try {
    await putTriggers(id, triggers);
  } catch (err) {
    return res.status(502).json({ error: `Could not save triggers: ${err.message}` });
  }
  // Consumer write (#1007) — see the POST handler.
  await reconcileTeamOutcomesForAgent(id);
  res.json(triggers[idx]);
});

// The trigger-delete choke-point, factored so both the DELETE route and the
// hill-climb applier (#1225) run the exact same write + reconcile. Returns the
// removed trigger object (or null if it wasn't present) so a caller can retain
// it (the applier keeps the deleted trigger JSON as its undo payload). Throws on
// a write failure.
async function deleteAgentTrigger(id, triggerId) {
  const cur = readJsonFile(controlOrAgentPath(id, 'triggers.json'), []);
  const triggers = Array.isArray(cur) ? cur : [];
  const removed = triggers.find(t => t && t.id === triggerId) || null;
  const filtered = triggers.filter(t => t.id !== triggerId);
  await putTriggers(id, filtered);
  // Consumer write (#1007) — a trigger write changes who consumes its siblings'
  // labels, so re-render the team's Outcomes blocks.
  await reconcileTeamOutcomesForAgent(id);
  return removed;
}

// The trigger-restore choke-point, factored so the hill-climb rollback (#1226)
// re-creates a retained trigger through the exact same write + reconcile as a
// normal add. Re-inserts the trigger JSON verbatim (keeping its original id so a
// rolled-back trigger-hygiene card restores the exact object that was deleted).
// Idempotent: if a trigger with that id already exists it is left untouched.
// Throws on a write failure. Returns the restored trigger (or the existing one).
async function restoreAgentTrigger(id, trigger) {
  if (!trigger || typeof trigger !== 'object' || !trigger.id) {
    throw new Error('no retained trigger to restore');
  }
  const cur = readJsonFile(controlOrAgentPath(id, 'triggers.json'), []);
  const triggers = Array.isArray(cur) ? cur : [];
  const existing = triggers.find(t => t && t.id === trigger.id);
  if (existing) return existing;
  triggers.push(trigger);
  await putTriggers(id, triggers);
  // A restored listener is a CONSUMER write (#1007) — re-render the team's
  // generated Outcomes blocks.
  await reconcileTeamOutcomesForAgent(id);
  return trigger;
}

app.delete('/api/agents/:id/triggers/:triggerId', apiLimiter, async (req, res) => {
  const { id, triggerId } = req.params;
  if (!AGENT_ID_RE.test(id)) return res.status(400).json({ error: 'Invalid agent id' });
  // Containment check (see POST handler): re-anchor under AGENTS_DIR so CodeQL
  // sees the traversal barrier even after the id is destructured.
  const agentsBaseDir = path.resolve(AGENTS_DIR);
  const agentDir = path.resolve(agentsBaseDir, id);
  const rel = path.relative(agentsBaseDir, agentDir);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return res.status(400).json({ error: 'Invalid agent id' });
  if (!fs.existsSync(agentDir)) return res.status(404).json({ error: 'Agent not found' });
  // Config-write authorization (#989): triggers are agent config — gate on
  // team-admin management rights, not visibility.
  if (denyUnlessCanManageAgent(req, res, agentDir)) return;
  try {
    await deleteAgentTrigger(id, triggerId);
  } catch (err) {
    return res.status(502).json({ error: `Could not save triggers: ${err.message}` });
  }
  res.status(204).end();
});

// Internal-channel transport (#1174): value + shape hygiene for a trigger write.
// The failure mode of a bad value is silent (the listener stays in the poller
// plan and `aee-emit` wakes nobody), so it is rejected, not tolerated. Kept
// route-level — the bundle-side twin lives in validateProcessTemplate.
function triggerTransportError(t) {
  if (t.transport === undefined) return null;
  if (t.transport !== 'internal' && t.transport !== 'github') {
    return "transport must be 'internal' or 'github'";
  }
  if (t.transport === 'internal'
      && !(t.type === 'github-event' && typeof t.labelFilter === 'string' && t.labelFilter.trim())) {
    return "transport 'internal' requires a github-event label listener (labelFilter)";
  }
  return null;
}

// A trigger write on a team member changes WHO CONSUMES its siblings' labels —
// re-render the team's generated Outcomes blocks (#1007). Best-effort: a
// reconcile failure never breaks the originating trigger request.
async function reconcileTeamOutcomesForAgent(agentId) {
  try {
    const cfg = readJsonFile(path.join(AGENTS_DIR, agentId, 'config.json'), null);
    if (cfg && cfg.parentTeamId) await reconcileTeamOutcomes(cfg.parentTeamId);
  } catch (err) {
    console.error(`[API] outcomes reconcile after trigger write on ${agentId} failed: ${err.message}`);
  }
}

function readAgentSystemPrompt(id) {
  try {
    const agentsRoot = path.resolve(AGENTS_DIR);
    const promptPath = path.resolve(agentsRoot, id, 'AGENT-PROMPT.md');
    if (promptPath !== agentsRoot && !promptPath.startsWith(agentsRoot + path.sep)) return '';
    return fs.readFileSync(promptPath, 'utf8');
  } catch { return ''; }
}

// Live migration (#783, AC8): trigger-level `emits` was removed. An already-
// materialised agent may still carry `emits` on a trigger in its triggers.json.
// Tolerate-and-lift at graph-build time so no label hand-off edge is lost: merge
// any trigger-level emit into the agent-level set the graph builders read. Pure;
// deduped, agent-level labels first. (No write-back — the read is tolerant.)
function liftAgentEmits(cfgEmits, triggers) {
  const base = Array.isArray(cfgEmits) ? cfgEmits.filter(e => typeof e === 'string' && e) : [];
  const lifted = [];
  for (const t of (Array.isArray(triggers) ? triggers : [])) {
    if (t && Array.isArray(t.emits)) {
      for (const e of t.emits) if (typeof e === 'string' && e) lifted.push(e);
    }
  }
  return lifted.length ? [...new Set([...base, ...lifted])] : base;
}

/* ─── Process graph (Process Canvas #329) ───────────────────────────────
 * Aggregates agents (or role templates) + their triggers into the
 * orchestration graph the canvas renders, in one call. Label hand-off edges
 * are derived exclusively from the agent/role level `emits` (#414/#783);
 * trigger-level emits were removed. A trigger only contributes its listen
 * side (labelFilter / events); it emits nothing.
 *   - live level (default, or ?team=<id> to scope to one team): agent-level
 *     `emits` from each agent's config.json.
 *   - template level (?templates=1 or ?templates=a,b): the role-template
 *     catalog's own `emits`, `{{var}}` tokens left raw. */

function truthyParam(v) { return v === '1' || v === 'true' || v === ''; }

// The authoritative gate/brake label registry of a LIVE team (#928). Persisted on
// the team agent at materialisation, exactly like `stages` — the live graph has no
// bundle to read `labels[]` from, and gate-ness is no longer inferable from the
// label's name. Unknown team / no registry → [] (every label is a plain agent
// label; channel `gate: 'human'` ports still classify on their own).
function teamLabelRegistry(teamId) {
  if (!teamId || !AGENT_ID_RE.test(teamId)) return [];
  const cfg = readJsonFile(path.join(AGENTS_DIR, teamId, 'config.json'), {});
  return Array.isArray(cfg.labels)
    ? cfg.labels.filter(l => l && typeof l.name === 'string' && l.name.trim())
    : [];
}

// Every addressable agent, as the `{id, parentTeamId, teamId}` metadata a
// `wakeAgent` target check needs (#2030). Deliberately install-WIDE, not
// team-scoped: a `to` naming a real agent in another team must read as the
// honest "outside this team" (§6) rather than "not a role in this flow", and
// that distinction is only possible if the out-of-team agents are in the index.
// Metadata only — no prompt, no token, nothing a validator has no business
// reading. Unreadable config → skipped, so a residue dir never blocks a save.
function wakeTargetAgentIndex() {
  const out = [];
  for (const id of listAgentDirs()) {
    const cfg = readJsonFile(path.join(AGENTS_DIR, id, 'config.json'), null);
    if (!cfg) continue;
    out.push({
      id,
      ...(cfg.parentTeamId ? { parentTeamId: cfg.parentTeamId } : {}),
      ...(cfg.teamId ? { teamId: cfg.teamId } : {}),
    });
  }
  return out;
}

// The named human roles of a LIVE team (#987). Persisted on the team agent like
// `labels`/`stages`; the live graph builders bind the #981 gate/brake/delivery
// touchpoints to these named nodes. Unknown team / no registry → [] (every
// touchpoint keeps the generic `@human` actor).
function teamHumansRegistry(teamId) {
  if (!teamId || !AGENT_ID_RE.test(teamId)) return [];
  const cfg = readJsonFile(path.join(AGENTS_DIR, teamId, 'config.json'), {});
  return Array.isArray(cfg.humans) ? cfg.humans : [];
}

app.get('/api/process/graph', (req, res) => {
  const templatesParam = req.query.templates;

  // Template-level blueprint graph. Label hand-off edges come from each
  // template's role-level `emits` (#414/#783); triggers contribute only their
  // listen side.
  if (templatesParam !== undefined) {
    const ids = truthyParam(String(templatesParam))
      ? listAgentTemplateIds()
      : String(templatesParam).split(',').map(s => s.trim()).filter(Boolean);
    const agents = [];
    for (const id of ids) {
      const t = loadAgentTemplate(id);
      if (!t) continue;
      const triggers = (t.triggers || []).map(tr => ({
        id: tr.id, type: tr.type, events: tr.events, labelFilter: tr.labelFilter,
        cron: tr.cron, at: tr.at, enabled: tr.enabled, channel: tr.channel,
        claim: tr.claim, // #958 — else the preview graph lints every listener as unclaimed
      }));
      agents.push({
        id: t.id, role: 'template', displayName: t.displayName || t.id,
        sessionPolicy: t.sessionPolicy || 'persistent', environmentId: null, triggers,
        emits: Array.isArray(t.emits) ? t.emits : [],
        outcomes: t.outcomes || null, // structured OUTCOMES port (#827)
        github: t.github || null, channels: Array.isArray(t.channels) ? t.channels : [],
      });
    }
    return res.json({ level: 'template', team: null, ...buildProcessGraph(agents) });
  }

  // Live graph — agent-level `emits` from each agent's config.json (#414/#783).
  // Optionally scoped to one team.
  const team = typeof req.query.team === 'string' && req.query.team.trim()
    ? req.query.team.trim() : null;
  if (team && !AGENT_ID_RE.test(team)) return res.status(400).json({ error: 'Invalid team id' });

  const agents = [];
  for (const id of listAgentDirs()) {
    const cfg = readJsonFile(path.join(AGENTS_DIR, id, 'config.json'), {});
    const role = cfg.role || 'agent';
    if (role === 'team') continue; // template holder — no triggers of its own
    if (team && cfg.parentTeamId !== team) continue;
    const triggers = readJsonFile(controlOrAgentPath(id, 'triggers.json'), []);
    agents.push({
      id, role, displayName: cfg.displayName || id,
      sessionPolicy: cfg.sessionPolicy || 'persistent',
      environmentId: cfg.environmentId || null,
      triggers: Array.isArray(triggers) ? triggers : [],
      // Agent-level label hand-offs, lifting any legacy trigger-level emit (AC8).
      emits: liftAgentEmits(cfg.emits, triggers),
      outcomes: cfg.outcomes || null, // structured OUTCOMES port (#827), supersedes emits
      github: cfg.github || null, channels: Array.isArray(cfg.channels) ? cfg.channels : [],
    });
  }
  const teamHumans = teamHumansRegistry(team);
  res.json({ level: 'live', team, humans: teamHumans, ...buildProcessGraph(agents, { labels: teamLabelRegistry(team), humans: teamHumans }) });
});

// Build a graph from an imported bundle (no persistence) so the canvas can
// render it as a blueprint (#334). Reuses the same pure builder.
app.post('/api/process/graph', (req, res) => {
  const raw = req.body && req.body.processTemplate;
  // Drafts (#345) may be empty works-in-progress.
  const v = validateProcessTemplate(raw, { allowEmptyRoles: true });
  if (!v.ok) return res.status(400).json({ error: `Invalid processTemplate: ${v.error}` });
  // Map legacy pr-review roles (#347) onto the #380 channel ports so old drafts render.
  const bundle = liftTriggerEmits(normalizeLegacyReview(raw));
  const agents = bundle.roles.map(r => ({
    id: r.id, role: 'template', displayName: r.displayName || r.id,
    sessionPolicy: r.sessionPolicy || 'persistent',
    // Agent-level emitted labels (#414 canonicalises emits to agent level) —
    // without them a bundle's label hand-offs render as human-set edges.
    emits: Array.isArray(r.emits) ? r.emits : [],
    // Structured OUTCOMES port (#827) — projected by buildProcessGraph.
    outcomes: r.outcomes || null,
    // GitHub artifact ports (#380) drive the badge/ports + channel edges.
    github: r.github || null, channels: Array.isArray(r.channels) ? r.channels : [],
    triggers: (r.triggers || []).map(t => ({ ...t, emits: Array.isArray(t.emits) ? t.emits : [] })),
  }));
  res.json({
    level: 'template', team: null, imported: true, name: bundle.name,
    // The bundle's own registries are the authority: labels for gate/brake
    // classification (#928), humans for the named-role bindings (#987).
    humans: Array.isArray(bundle.humans) ? bundle.humans : [],
    ...buildProcessGraph(agents, { labels: bundle.labels, humans: bundle.humans }),
  });
});

/* ─── Knowledge Flow (Shared Agent Learning, Phase 2) ───────────────────────
 * Read-only aggregation of the team Knowledge Base into the lane/node/edge model
 * the KnowledgeFlow page renders (T0 agent → T1 team KB → T2 skill), plus a lean
 * summary for the LearningBadge, a live SSE feed of harvests, and a provenance
 * drill-down. All heavy logic is in the pure builders (knowledge-graph.js /
 * knowledge-links.js); these routes are the IO shell that gathers KB entries off
 * the shared volume (the orchestrator-maintained canonical clone, agent-checkout
 * fallback), skills, and agent metadata — mirroring how /api/process/graph
 * gathers its inputs. */

const KNOWLEDGE_CLONE_ROOT = path.join(WORKSPACE, 'knowledge');
const KNOWLEDGE_EVENTS_FILE = path.join(WORKSPACE, 'knowledge-events', 'events.jsonl');
const KB_KINDS = ['fact', 'entity', 'convention'];
const KB_DEFAULT_DIRS = { fact: 'facts', entity: 'entities', convention: 'conventions' };
const KB_DEFAULT_STORE_PATH = 'docs/agent-knowledge/';

function kbParseLine(line) {
  try {
    const o = JSON.parse(line);
    return o && typeof o === 'object' && !Array.isArray(o) ? o : null;
  } catch { return null; }
}

// The team an agent shares KNOWLEDGE with — the AGENT team (the squad: a
// member's `parentTeamId`, a `team` agent's own id), NOT the human tenant Team
// (`teamId`, #299/#302, which is backfilled onto every agent and would lump all
// squads into 'default'). Standalone agents without a squad fall back to their
// human team. Mirrors the orchestrator's agentKnowledgeTeamId.
function agentKnowledgeTeam(cfg) {
  if (!cfg) return 'default';
  if (typeof cfg.parentTeamId === 'string' && cfg.parentTeamId.trim()) return cfg.parentTeamId;
  if (cfg.role === 'team' && typeof cfg.id === 'string' && cfg.id.trim()) return cfg.id;
  return cfg.teamId || 'default';
}

// Knowledge-team visibility: a knowledge team (agent squad) is visible when the
// caller can see the HUMAN team any of its agents belongs to. Admin scopes
// (all:true) short-circuit. Falls back to a direct id match so a membership that
// (unusually) names the squad id keeps working.
function knowledgeTeamVisible(scope, knowledgeTeamId) {
  if (!scope) return false;
  if (scope.all) return true;
  if (visibleTeam(scope, knowledgeTeamId)) return true;
  for (const id of listAgentDirs()) {
    const cfg = readJsonFile(path.join(AGENTS_DIR, id, 'config.json'), {});
    if (agentKnowledgeTeam(cfg) !== knowledgeTeamId) continue;
    if (visibleTeam(scope, cfg.teamId)) return true;
  }
  return false;
}

// Resolve a team's KB store-relative path (e.g. docs/agent-knowledge/) from any
// of its agents' environments — a team shares one env → one KB config.
function resolveTeamStorePath(teamId) {
  for (const id of listAgentDirs()) {
    const cfg = readJsonFile(path.join(AGENTS_DIR, id, 'config.json'), {});
    if (agentKnowledgeTeam(cfg) !== teamId || !cfg.environmentId) continue;
    // #570: the KB store path is keyed per team — overlay the team's overrides.
    const env = knowledgeSuggestions.mergeTeamKnowledgeConfig(loadEnvironment(cfg.environmentId), loadTeamKnowledgeOverrides(teamId));
    const p = env && env.knowledgeStore && typeof env.knowledgeStore.path === 'string'
      ? env.knowledgeStore.path : null;
    if (p) return p.replace(/^\/+|\/+$/g, '') + '/';
  }
  return KB_DEFAULT_STORE_PATH;
}

// Resolve a team's KB repo web URL for provenance links (sourceRefs → PR/issue).
function resolveTeamRepoUrl(teamId) {
  for (const id of listAgentDirs()) {
    const cfg = readJsonFile(path.join(AGENTS_DIR, id, 'config.json'), {});
    if (agentKnowledgeTeam(cfg) !== teamId || !cfg.environmentId) continue;
    // #570: the KB repoRef is keyed per team — overlay the team's overrides.
    const env = knowledgeSuggestions.mergeTeamKnowledgeConfig(loadEnvironment(cfg.environmentId), loadTeamKnowledgeOverrides(teamId));
    const ref = env && env.knowledgeStore && env.knowledgeStore.repoRef;
    if (ref && ref.url) return ref.url;
    const repos = (env && env.repositories) || [];
    if (repos[0] && repos[0].url) return repos[0].url;
  }
  return null;
}

function teamAgentIds(teamId) {
  return listAgentDirs().filter(id => {
    const cfg = readJsonFile(path.join(AGENTS_DIR, id, 'config.json'), {});
    return agentKnowledgeTeam(cfg) === teamId;
  });
}

// Kind → { dir, file }, honouring a store's manifest if present, else defaults.
function kbKindDirs(storeRoot) {
  const m = readJsonFile(path.join(storeRoot, 'knowledge.manifest.json'), null);
  if (m && m.kinds && typeof m.kinds === 'object') {
    const out = [];
    for (const k of KB_KINDS) {
      const e = m.kinds[k];
      if (e && typeof e.dir === 'string' && typeof e.file === 'string') {
        out.push({ dir: e.dir.replace(/\/+$/, ''), file: e.file });
      }
    }
    if (out.length) return out;
  }
  return KB_KINDS.map(k => ({ dir: KB_DEFAULT_DIRS[k], file: `${KB_DEFAULT_DIRS[k]}.jsonl` }));
}

function kbReadStore(entries, storeRoot) {
  for (const { dir, file } of kbKindDirs(storeRoot)) {
    const kindDir = path.join(storeRoot, dir);
    const shardsDir = path.join(kindDir, 'shards');
    let shardNames = [];
    try { shardNames = fs.readdirSync(shardsDir).filter(n => n.endsWith('.jsonl')); } catch { /* none */ }
    const files = shardNames.map(n => path.join(shardsDir, n));
    const canonical = path.join(kindDir, file);
    if (fs.existsSync(canonical)) files.push(canonical);
    for (const fp of files) {
      let raw;
      try { raw = fs.readFileSync(fp, 'utf8'); } catch { continue; }
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        const e = kbParseLine(line);
        if (e) entries.push(e);
      }
    }
  }
}

// originAgent → knowledge team, for re-homing entries at read time. Entries are
// stamped with the CLI's KNOWLEDGE_TEAM_ID at harvest, which historically was
// the human tenant team ('default' for everyone) — and two squads can share one
// env, i.e. one KB store, so the store location alone can't separate them
// either. The recording agent's squad is authoritative.
function knowledgeTeamByAgent() {
  const map = new Map();
  for (const id of listAgentDirs()) {
    const cfg = readJsonFile(path.join(AGENTS_DIR, id, 'config.json'), {});
    map.set(id, agentKnowledgeTeam({ ...cfg, id: cfg.id || id }));
  }
  return map;
}

const KNOWLEDGE_ARCHIVED_DIR = path.join(WORKSPACE, 'knowledge-archived');
const KNOWLEDGE_REVIEW_DIR = path.join(WORKSPACE, 'knowledge-review');
const KNOWLEDGE_VALIDITY_DIR = path.join(WORKSPACE, 'knowledge-validity');

function readArchivedIdsFor(teamId) {
  const arr = readJsonFile(path.join(KNOWLEDGE_ARCHIVED_DIR, `${path.basename(teamId)}.json`), []);
  return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string') : [];
}

function readReviewDecisionsFor(teamId) {
  const obj = readJsonFile(path.join(KNOWLEDGE_REVIEW_DIR, `${path.basename(teamId)}.json`), {});
  return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
}

// #916: per-team validity sidecar { <id>: { validTo?, supersededBy? } } — the
// orchestrator is the writer; read here so the overlay holds even when the
// canonical clone's re-projection lags.
function readValidityFor(teamId) {
  const obj = readJsonFile(path.join(KNOWLEDGE_VALIDITY_DIR, `${path.basename(teamId)}.json`), {});
  return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
}

// #917: per-team auto-load trigger sidecar { <id>: loadTriggers[] } — same
// orchestrator-writes/console-reads posture.
const KNOWLEDGE_TRIGGERS_DIR = path.join(WORKSPACE, 'knowledge-triggers');
function readTriggersFor(teamId) {
  const obj = readJsonFile(path.join(KNOWLEDGE_TRIGGERS_DIR, `${path.basename(teamId)}.json`), {});
  return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
}

// Gather a team's KB entries from the canonical clone (preferred, fresh) or,
// when it doesn't exist yet, union the shards from every team agent's checkout.
// dedupById in the builder converges regardless of how many stale copies we see.
// Entries are re-homed to their origin agent's squad, and the operator-decision
// overlays (archive, supervised review) are re-applied at read time so they hold
// even when the git-sync side lags (see overlayStatuses).
function gatherTeamEntries(teamId) {
  let entries = [];
  const warnings = [];
  if (!AGENT_ID_RE.test(teamId)) return { entries, warnings };
  const storeRel = resolveTeamStorePath(teamId);
  const cloneRoot = path.join(KNOWLEDGE_CLONE_ROOT, path.basename(teamId));
  const cloneStore = path.join(cloneRoot, storeRel);
  if (fs.existsSync(path.join(cloneRoot, '.git')) && fs.existsSync(cloneStore)) {
    kbReadStore(entries, cloneStore);
  } else {
    for (const agentId of teamAgentIds(teamId)) {
      const store = path.join(AGENTS_DIR, agentId, 'knowledge', storeRel);
      if (fs.existsSync(store)) kbReadStore(entries, store);
    }
    warnings.push(`no canonical KB clone for team '${teamId}'; read from agent checkouts`);
  }

  // Re-home each entry to its origin agent's squad; an unknown origin keeps the
  // entry in the team whose store we are reading. Then drop sibling squads'
  // entries (a shared env means a shared store — the canonical clone can carry
  // both squads' shards).
  const originTeams = knowledgeTeamByAgent();
  entries = entries
    .map((e) => {
      if (!e || typeof e !== 'object') return e;
      const t = (typeof e.originAgent === 'string' && originTeams.get(e.originAgent)) || teamId;
      return e.teamId === t ? e : { ...e, teamId: t };
    })
    .filter((e) => !e || typeof e !== 'object' || e.teamId === teamId);

  // Operator-decision overlays: this team's stores plus (legacy) the 'default'
  // human-team store, so decisions taken before the squad re-homing still hold.
  const archived = new Set(readArchivedIdsFor(teamId));
  const decisions = { ...readReviewDecisionsFor(teamId) };
  if (teamId !== 'default') {
    for (const id of readArchivedIdsFor('default')) archived.add(id);
    for (const [k, v] of Object.entries(readReviewDecisionsFor('default'))) {
      if (!(k in decisions)) decisions[k] = v;
    }
  }
  const reviewOn = knowledgeReviewOn(teamKnowledgeEnv(teamId)); // #570: per-team config
  entries = overlayStatuses(entries, { archivedIds: archived, decisions, reviewOn });
  // #916: validity is a field overlay (never a status) — same legacy-'default'
  // merge as the archive store so pre-re-homing decisions still hold.
  const validity = { ...readValidityFor(teamId) };
  if (teamId !== 'default') {
    for (const [k, v] of Object.entries(readValidityFor('default'))) {
      if (!(k in validity)) validity[k] = v;
    }
  }
  entries = overlayValidity(entries, validity);
  // #917: auto-load triggers — same authoritative field overlay + legacy merge.
  const triggers = { ...readTriggersFor(teamId) };
  if (teamId !== 'default') {
    for (const [k, v] of Object.entries(readTriggersFor('default'))) {
      if (!(k in triggers)) triggers[k] = v;
    }
  }
  entries = overlayLoadTriggers(entries, triggers);
  return { entries, warnings };
}

// Which teams does this scope + membership resolve to?
function knowledgeScopeTeams(parsed, scope) {
  if (parsed.kind === 'team') return [parsed.id];
  if (parsed.kind === 'agent') {
    const cfg = readJsonFile(path.join(AGENTS_DIR, parsed.id, 'config.json'), {});
    return [agentKnowledgeTeam({ ...cfg, id: cfg.id || parsed.id })];
  }
  // global: every team that has agents, narrowed by membership scope.
  const teams = new Set();
  for (const id of listAgentDirs()) {
    const cfg = readJsonFile(path.join(AGENTS_DIR, id, 'config.json'), {});
    teams.add(agentKnowledgeTeam({ ...cfg, id: cfg.id || id }));
  }
  return [...teams].filter(t => knowledgeTeamVisible(scope, t));
}

// Fire-and-forget refresh of a team's canonical clone before we read it, so the
// on-disk shards are current. Never waits beyond a short timeout.
function refreshTeamCloneBestEffort(teamId) {
  const url = `${ORCH_URL()}/internal/knowledge/refresh`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 2500);
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ teamId }),
    signal: ctrl.signal,
  }).catch(() => {}).finally(() => clearTimeout(timer));
}

function gatherKnowledgeAgents(scope, teamIds) {
  const set = new Set(teamIds);
  const agents = [];
  for (const id of listAgentDirs()) {
    const cfg = readJsonFile(path.join(AGENTS_DIR, id, 'config.json'), {});
    if (cfg.role === 'team') continue; // template holder, not a contributor
    const teamId = agentKnowledgeTeam({ ...cfg, id: cfg.id || id });
    if (!set.has(teamId)) continue;
    if (!visibleAgent(scope, agentMetaForScope(cfg))) continue;
    agents.push({ id, parentTeamId: teamId, environmentId: cfg.environmentId || null, displayName: cfg.displayName || id });
  }
  return agents;
}

// The provenance.json a Phase-3 promotion writes beside SKILL.md — carries the
// entryIds that drive the graph's T1→T2 edge + the originTeamId for the global
// lane. Absent for hand-authored / pre-Phase-3 skills (edge simply not drawn).
function readSkillProvenance(dir) {
  const p = readJsonFile(path.join(dir, 'provenance.json'), null);
  return p && typeof p === 'object' ? p : null;
}

function gatherKnowledgeSkills(scope) {
  const skills = [];
  const poolSkillsDir = path.join(POOL_DIR, 'skills');
  try {
    fs.readdirSync(poolSkillsDir).forEach(name => {
      const dir = path.join(poolSkillsDir, name);
      if (!fs.existsSync(path.join(dir, 'SKILL.md'))) return;
      const s = { name, tier: 'global' };
      const prov = readSkillProvenance(dir);
      if (prov) {
        s.provenance = prov;
        if (prov.originTeamId) s.originTeamId = prov.originTeamId;
      }
      skills.push(s);
    });
  } catch { /* no pool skills */ }
  for (const ts of listTeamSkills(null)) {
    if (!knowledgeTeamVisible(scope, ts.teamId)) continue;
    const s = { name: ts.name, tier: 'team', teamId: ts.teamId };
    const dir = safeTeamSkillDir(ts.teamId, ts.name);
    const prov = dir ? readSkillProvenance(dir) : null;
    if (prov) s.provenance = prov;
    skills.push(s);
  }
  return skills;
}

// Validate a scope query param; unknown / malformed → global.
function knowledgeScopeParam(req) {
  const raw = typeof req.query.scope === 'string' ? req.query.scope.trim() : '';
  const parsed = parseScope(raw);
  if ((parsed.kind === 'agent' || parsed.kind === 'team') && !AGENT_ID_RE.test(parsed.id)) {
    return parseScope('global');
  }
  return parsed;
}

app.get('/api/knowledge/graph', async (req, res) => {
  const scope = getScope(req);
  const parsed = knowledgeScopeParam(req);
  const teamIds = knowledgeScopeTeams(parsed, scope);

  await Promise.all(teamIds.map(refreshTeamCloneBestEffort));

  const entries = [];
  const warnings = [];
  for (const teamId of teamIds) {
    const g = gatherTeamEntries(teamId);
    entries.push(...g.entries);
    warnings.push(...g.warnings);
  }
  const agents = gatherKnowledgeAgents(scope, teamIds);
  const skills = gatherKnowledgeSkills(scope);
  const includeArchived = req.query.includeArchived === '1' || req.query.includeArchived === 'true';
  const graph = buildKnowledgeGraph({ scope: parsed.scope, entries, skills, agents, now: Date.now(), warnings, includeArchived });
  augmentPendingPromotions(graph, teamIds);
  augmentSkillActivation(graph, parsed);
  await augmentDigestInclusion(graph, teamIds);
  await augmentSkillRoles(graph, teamIds);
  augmentDisplaySummary(graph, entries);
  await augmentRetrievalStats(graph, teamIds);
  res.json(graph);
});

// Overlay the human-readable summary (#635) on every item node: `summary` is the
// persisted, LLM-generated field carried on the canonical entry (null when not yet
// backfilled), and `displaySummary` is what the overview table renders — the
// persisted summary when present, else a deterministic heuristic derived from the
// raw `text` so a row is NEVER blank (AC4). Computed in the route (like
// augmentDigestInclusion) so the pure graph builder stays entries+skills only.
function augmentDisplaySummary(graph, entries) {
  if (!graph || !Array.isArray(graph.nodes)) return;
  const byId = new Map();
  for (const e of Array.isArray(entries) ? entries : []) {
    if (e && typeof e.id === 'string') byId.set(e.id, e);
  }
  for (const node of graph.nodes) {
    if (node.kind !== 'item') continue;
    const entry = byId.get(String(node.id).slice(5));
    const persisted = entry && typeof entry.summary === 'string' && entry.summary.trim() ? entry.summary.trim() : null;
    node.summary = persisted;
    node.displaySummary = persisted || knowledgeSuggestions.buildHeuristicSummary(node.text || (entry && entry.text) || '');
  }
}

// Overlay the digest-inclusion truth (memory/knowledge unification, Phase 3):
// mark every item node that currently sits inside its team's knowledge digest
// — guaranteed in the agents' context at session start — as opposed to the
// search-only long tail. Asked live from the orchestrator, which computes it
// with the same pure builder that writes knowledge-digest.md, so the badge can
// never disagree with the file the agents import. Best-effort: an unreachable
// orchestrator just means no badges.
async function augmentDigestInclusion(graph, teamIds) {
  if (!graph || !Array.isArray(graph.nodes)) return;
  const included = new Set();
  await Promise.all((teamIds || []).map(async (teamId) => {
    try {
      const resp = await fetch(`${ORCH_URL()}/internal/teams/${encodeURIComponent(teamId)}/knowledge/digest-status`);
      if (!resp.ok) return;
      const data = await resp.json();
      for (const id of (Array.isArray(data.includedIds) ? data.includedIds : [])) included.add(id);
    } catch { /* best effort */ }
  }));
  if (included.size === 0) return;
  for (const node of graph.nodes) {
    if (node.kind === 'item' && included.has(String(node.id).slice(5))) node.inDigest = true;
  }
}

// Overlay the read-side retrieval truth (#915) on every item node: when was the
// entry last returned by a `knowledge search`/`list` (strong signal) or inlined
// into a digest build (weak signal), and how often. Sourced from the
// orchestrator's per-team aggregate — never the live feed. Best-effort: an
// unreachable orchestrator just means no "last used" info (nodes stay unmarked,
// which the UI renders as "never used" only when the stats fetch succeeded).
async function augmentRetrievalStats(graph, teamIds) {
  if (!graph || !Array.isArray(graph.nodes)) return;
  const byId = new Map();
  let anyStats = false;
  await Promise.all((teamIds || []).map(async (teamId) => {
    try {
      const resp = await fetch(`${ORCH_URL()}/internal/teams/${encodeURIComponent(teamId)}/knowledge/retrieval-stats`);
      if (!resp.ok) return;
      const data = await resp.json();
      anyStats = true;
      const entries = data && data.entries && typeof data.entries === 'object' ? data.entries : {};
      for (const [id, row] of Object.entries(entries)) byId.set(id, row);
    } catch { /* best effort */ }
  }));
  if (!anyStats) return;
  graph.retrievalStats = true; // the UI may distinguish "no data yet" from "endpoint down"
  for (const node of graph.nodes) {
    if (node.kind !== 'item') continue;
    const row = byId.get(String(node.id).slice(5));
    if (!row) continue;
    let last = '';
    for (const k of ['lastSearchAt', 'lastDigestAt', 'lastScopedAt']) {
      const v = typeof row[k] === 'string' ? row[k] : '';
      if (v > last) last = v;
    }
    if (last) node.lastUsedAt = last;
    const hits = (Number.isInteger(row.searchHits) ? row.searchHits : 0)
      + (Number.isInteger(row.digestCount) ? row.digestCount : 0)
      + (Number.isInteger(row.scopedCount) ? row.scopedCount : 0);
    if (hits > 0) node.usageCount = hits;
    if (Number.isInteger(row.searchHits) && row.searchHits > 0) node.searchHits = row.searchHits;
  }
}

// Overlay the audience ROLES on every skill node (#781 §3.5 role surfacing): a skill
// mapped to a domain shows "for: developer, reworker". Read-time only — sourced from
// the team's domains doc via the orchestrator (a domain's skill name is `skill||id`,
// both already clean slugs). Best-effort, mutates `graph` in place; a skill with no
// mapped domain simply carries no `roles` (the UI renders nothing).
async function augmentSkillRoles(graph, teamIds) {
  if (!graph || !Array.isArray(graph.nodes)) return;
  const rolesBySkill = new Map();
  await Promise.all((teamIds || []).map(async (teamId) => {
    try {
      const resp = await fetch(`${ORCH_URL()}/internal/knowledge/domains`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ teamId, op: 'read' }),
      });
      if (!resp.ok) return;
      const data = await resp.json().catch(() => ({}));
      const domains = data && data.doc && Array.isArray(data.doc.domains) ? data.doc.domains : [];
      for (const d of domains) {
        const name = typeof d.skill === 'string' && d.skill ? d.skill : d.id;
        if (name && Array.isArray(d.roles) && d.roles.length) rolesBySkill.set(name, d.roles.slice());
      }
    } catch { /* best effort */ }
  }));
  if (rolesBySkill.size === 0) return;
  for (const node of graph.nodes) {
    if (node.kind === 'skill' && rolesBySkill.has(node.label)) node.roles = rolesBySkill.get(node.label);
  }
}

// Overlay the ACTIVATION truth on every skill node of a team-scoped graph
// (team-owned skills, phase 2): is the skill in the team agent's `skills[]`,
// and which members actually carry it in their workspace? Member state is read
// from the seeded-skills manifest the orchestrator maintains
// (/workspace/agents/<id>/.agent-studio/seeded-skills.json) — the grant list alone
// can't tell whether a running member was seeded before or after a name was
// added. Also adds ghost nodes for adopted global skills that the lane filter
// wouldn't render (active list ∌ origin team). Mutates `graph` in place; no-op
// outside team scope or when the squad has no team agent.
function augmentSkillActivation(graph, parsed) {
  if (!graph || !Array.isArray(graph.nodes) || parsed.kind !== 'team') return;
  const teamId = parsed.id;
  const teamCfg = readJsonFile(path.join(AGENTS_DIR, teamId, 'config.json'), null);
  if (!teamCfg || teamCfg.role !== 'team') return;
  const teamSkills = Array.isArray(teamCfg.skills) ? teamCfg.skills : [];

  let members = [];
  try {
    members = fs.readdirSync(AGENTS_DIR)
      .map(id => readJsonFile(path.join(AGENTS_DIR, id, 'config.json'), null))
      .filter(c => c && c.role === 'team-member' && c.parentTeamId === teamId);
  } catch { /* no agents dir */ }
  const manifests = new Map(members.map(m => [
    m.id,
    readJsonFile(path.join(resolveAgentStateDir(path.join(AGENTS_DIR, m.id)), 'seeded-skills.json'), {}) || {},
  ]));
  // #776 §3: per-member auto-reconcile state so a stuck `pending` member surfaces
  // a Retry + the last error/time instead of a silent "Sync now".
  const reconciles = new Map(members.map(m => [
    m.id,
    readJsonFile(path.join(resolveAgentStateDir(path.join(AGENTS_DIR, m.id)), 'skill-reconcile.json'), {}) || {},
  ]));

  // Ghost nodes for active-list skills the lane filter didn't render
  // (adopted global skills with a foreign/no origin team).
  const skillNodes = graph.nodes.filter(n => n.kind === 'skill');
  const rendered = new Set(skillNodes.map(n => n.label));
  for (const name of teamSkills) {
    if (rendered.has(name)) continue;
    const node = { id: `skill:${name}`, lane: 'global', kind: 'skill', label: name, tier: 'global', adopted: true };
    graph.nodes.push(node);
    skillNodes.push(node);
  }

  for (const node of skillNodes) {
    const name = node.label;
    const inList = teamSkills.includes(name);
    // Pool availability (#739 AC4): a member stuck on `pending` most often means
    // the skill's source file was deleted from every pool tier, so every
    // per-member sync errors out and no retry can ever succeed. Surface it as a
    // node-level flag the UI turns into a plain "restore from archive" recovery
    // hint instead of a dead-end "Sync now". Team skills resolve team-first then
    // global (the agent tier is a member's own copy, N/A for an inherited grant).
    let sourceMissing = false;
    if (inList) {
      const teamSrc = resolveSkillSourceDir(name, 'team', teamId);
      const globalSrc = resolveSkillSourceDir(name, 'global');
      const present = (teamSrc && fs.existsSync(teamSrc)) || (globalSrc && fs.existsSync(globalSrc));
      sourceMissing = !present;
    }
    const driftStates = [];
    node.activation = {
      active: inList,
      sourceMissing,
      members: members.map(m => {
        const hasOverride = Array.isArray(m.skillsOverride);
        const granted = hasOverride ? m.skillsOverride.includes(name) : inList;
        const seededEntry = (manifests.get(m.id) || {})[name];
        const seeded = !!seededEntry;
        const state = !m.token ? 'stub'
          : (hasOverride && !granted) ? 'excluded-override'
          : seeded ? 'active'
          : granted ? 'pending'
          : 'inactive';
        const out = { agentId: m.id, displayName: m.displayName || m.id, state };
        // #776 §3: when a member is `pending`, expose the auto-reconcile progress
        // so the UI reads "syncing…" by default and only offers Retry (with the
        // reason + timestamp) once the reconcile loop has actually reported an
        // error for this skill — a bounded-retry, self-healing rollout.
        if (state === 'pending') {
          const rc = (reconciles.get(m.id) || {})[name];
          if (rc && (rc.lastError || rc.attempts)) {
            out.reconcile = {
              attempts: rc.attempts || 0,
              lastError: rc.lastError || null,
              lastAttemptAt: rc.lastAttemptAt || null,
              exhausted: (rc.attempts || 0) >= 5,
            };
          }
        }
        // Drift (#629 AC2) is meaningful only for a copy that was actually
        // seeded into this member's workspace — the seeded entry is the anchor.
        if (seeded) {
          const origin = seededEntry.tier
            // #750: a team-tier copy's source lives in the AGENT team's pool
            // (parentTeamId — the same key the overlay's sourceMissing check and
            // the orchestrator seed/sync use), not the member's human tenant teamId.
            ? { tier: seededEntry.tier, teamId: seededEntry.tier === 'team' ? (m.parentTeamId || m.teamId) : undefined, sourceHash: seededEntry.contentHash }
            : null;
          const copyDir = path.join(AGENTS_DIR, m.id, 'skills', name);
          let sourceDir = origin ? resolveSkillSourceDir(name, origin.tier, origin.teamId) : null;
          // #750 follow-up: a skill promoted/moved from the team tier into the
          // global pool leaves the per-member manifest still pinned to
          // `tier: "team"`, so the recorded team source dir is gone — the drift
          // resolver would report `orphaned` ("source deleted") even though an
          // identically-named source now lives in the global pool and the copy is
          // in sync with it. Fall back team-first-then-global (the same order the
          // orchestrator seed/sync and the node-level sourceMissing check use)
          // before classifying, so a team→global move no longer looks like a
          // deleted source.
          if (origin && origin.tier === 'team' && !hasSkillFile(sourceDir)) {
            const globalSrc = resolveSkillSourceDir(name, 'global');
            if (hasSkillFile(globalSrc)) sourceDir = globalSrc;
          }
          const d = skillDrift.copyDriftState({ copyDir, sourceHash: origin && origin.sourceHash, sourceDir });
          out.drift = d.state;
          driftStates.push(d.state);
        }
        return out;
      }),
    };
    node.drift = skillDrift.rollupDrift(driftStates);
  }
}

// Overlay "needs review" edges + ghost skill nodes (Phase 4) for open promotion
// candidates whose converged fact is a node in this graph — the pending promotion
// the operator still has to approve (a gated/deferred auto-promotion, or a
// level-2 suggestion). Derived from the candidate store in the route so the pure
// graph builder stays a function of entries+skills only. No-op when there are no
// open candidates (mutates `graph` in place).
function augmentPendingPromotions(graph, teamIds) {
  if (!graph || !Array.isArray(graph.nodes)) return;
  const itemIds = new Set(graph.nodes.filter(n => n.kind === 'item').map(n => n.id));
  if (itemIds.size === 0) return;
  const seen = new Set();
  for (const teamId of teamIds) {
    for (const c of readCandidateStore(teamId)) {
      if (!c || c.status !== 'open' || !c.canonicalId) continue;
      const itemNodeId = `item:${c.canonicalId}`;
      if (!itemIds.has(itemNodeId) || seen.has(c.id)) continue;
      seen.add(c.id);
      const label = (c.draft && c.draft.name) || knowledgeSuggestions.slugifySkillName(c.text, c.kind);
      graph.nodes.push({
        id: `pending:${c.id}`, lane: 'global', kind: 'pending', label,
        suggestionId: c.id, teamId, gateReason: c.gateReason || null,
        autoDrafted: !!c.autoDrafted,
      });
      graph.edges.push({ from: itemNodeId, to: `pending:${c.id}`, kind: 'promoted', pending: true });
    }
  }
}

app.get('/api/knowledge/summary', async (req, res) => {
  const scope = getScope(req);
  const parsed = knowledgeScopeParam(req);
  const teamIds = knowledgeScopeTeams(parsed, scope);
  const entries = [];
  for (const teamId of teamIds) entries.push(...gatherTeamEntries(teamId).entries);
  res.json(summarizeKnowledge({ scope: parsed.scope, entries, now: Date.now() }));
});

// Read-side retrieval aggregate (#915): per-entry "last used" truth + the
// `since` baseline. Proxies the orchestrator's per-team aggregate store.
app.get('/api/knowledge/retrieval-stats', async (req, res) => {
  const scope = getScope(req);
  const teamId = typeof req.query.team === 'string' ? req.query.team : '';
  if (!AGENT_ID_RE.test(teamId)) return res.status(400).json({ error: 'team is required' });
  if (!knowledgeTeamVisible(scope, teamId)) return res.status(404).json({ error: 'not found' });
  try {
    const r = await fetch(`${ORCH_URL()}/internal/teams/${encodeURIComponent(teamId)}/knowledge/retrieval-stats`);
    const out = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(502).json({ error: (out && out.error) || 'retrieval-stats failed' });
    res.json(out);
  } catch (err) {
    res.status(502).json({ error: `orchestrator unreachable: ${err.message}` });
  }
});

app.get('/api/knowledge/item/:id', (req, res) => {
  const scope = getScope(req);
  const { id } = req.params;
  const teamId = typeof req.query.teamId === 'string' ? req.query.teamId : '';
  if (!/^[0-9a-f]{12}$/.test(id)) return res.status(400).json({ error: 'invalid id' });
  if (!AGENT_ID_RE.test(teamId)) return res.status(400).json({ error: 'invalid teamId' });
  if (!knowledgeTeamVisible(scope, teamId)) return res.status(404).json({ error: 'not found' });

  const { entries } = gatherTeamEntries(teamId);
  // Prefer a live entry over a merge tombstone of the same id (Phase 3).
  const entry = entries.find(e => e && e.id === id && e.status !== 'merged')
    || entries.find(e => e && e.id === id) || null;
  if (!entry) return res.status(404).json({ error: 'not found' });

  const originAgent = typeof entry.originAgent === 'string' ? entry.originAgent : null;
  const correlationId = typeof entry.correlationId === 'string' ? entry.correlationId : null;
  const roomId = originAgent && correlationId ? findRoomForCorrelation(originAgent, correlationId) : null;
  const repoUrl = resolveTeamRepoUrl(teamId);
  const sourceRefs = Array.isArray(entry.sourceRefs) ? entry.sourceRefs : [];

  const links = {
    originAgent: originAgent ? { agentId: originAgent, href: `/chats/${encodeURIComponent(originAgent)}` } : null,
    session: originAgent ? knowledgeLinks.buildSessionDeepLink({ agentId: originAgent, roomId, correlationId }) : null,
    sourceRefs: sourceRefs
      .map(ref => ({ kind: ref && ref.kind, ref: ref && ref.ref, url: knowledgeLinks.buildSourceRefUrl(ref, repoUrl) }))
      .filter(r => r.url),
  };
  res.json({ entry, links });
});

// Archive / unarchive a canonical KB entry (Phase 4 manual curation). Proxies to
// the orchestrator (the canonical-file writer). Non-destructive — the shards stay.
app.post('/api/knowledge/item/:id/archive', apiLimiter, async (req, res) => {
  const scope = getScope(req);
  const { id } = req.params;
  const teamId = typeof req.body?.teamId === 'string' ? req.body.teamId : '';
  if (!/^[0-9a-f]{12}$/.test(id)) return res.status(400).json({ error: 'invalid id' });
  if (!AGENT_ID_RE.test(teamId)) return res.status(400).json({ error: 'teamId is required' });
  if (!knowledgeTeamVisible(scope, teamId)) return res.status(403).json({ error: 'forbidden' });
  const archived = req.body?.archived !== false;
  try {
    const r = await fetch(`${ORCH_URL()}/internal/knowledge/archive`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ teamId, id, archived }),
    });
    const out = await r.json().catch(() => ({}));
    if (!r.ok || !out.ok) return res.status(r.status === 400 ? 400 : 502).json({ error: (out && out.error) || 'archive failed' });
    res.json({ ok: true, id, archived });
  } catch (err) {
    res.status(502).json({ error: `orchestrator unreachable: ${err.message}` });
  }
});

// Set / clear a KB entry's validity window (#916 bitemporal validity). Proxies
// to the orchestrator (sidecar writer + canonical re-projection). Setting
// validTo expires the entry everywhere active on that date; null/'' clears it
// (idempotent round trip). supersededBy records semantic replacement and never
// by itself hides the entry.
app.post('/api/knowledge/item/:id/validity', apiLimiter, async (req, res) => {
  const scope = getScope(req);
  const { id } = req.params;
  const teamId = typeof req.body?.teamId === 'string' ? req.body.teamId : '';
  if (!/^[0-9a-f]{12}$/.test(id)) return res.status(400).json({ error: 'invalid id' });
  if (!AGENT_ID_RE.test(teamId)) return res.status(400).json({ error: 'teamId is required' });
  if (!knowledgeTeamVisible(scope, teamId)) return res.status(403).json({ error: 'forbidden' });
  try {
    const r = await fetch(`${ORCH_URL()}/internal/knowledge/validity`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        teamId, id,
        validTo: typeof req.body?.validTo === 'string' ? req.body.validTo : null,
        supersededBy: typeof req.body?.supersededBy === 'string' ? req.body.supersededBy : null,
      }),
    });
    const out = await r.json().catch(() => ({}));
    if (!r.ok || !out.ok) return res.status(r.status === 400 ? 400 : 502).json({ error: (out && out.error) || 'validity update failed' });
    res.json({ ok: true, id, validTo: out.validTo ?? null, supersededBy: out.supersededBy ?? null });
  } catch (err) {
    res.status(502).json({ error: `orchestrator unreachable: ${err.message}` });
  }
});

// Set / clear a KB entry's auto-load triggers (#917 scoped knowledge). Proxies
// to the orchestrator (sidecar writer + canonical re-projection). An empty
// list clears. Operator-only in v1 — agents don't author triggers.
app.post('/api/knowledge/item/:id/triggers', apiLimiter, async (req, res) => {
  const scope = getScope(req);
  const { id } = req.params;
  const teamId = typeof req.body?.teamId === 'string' ? req.body.teamId : '';
  if (!/^[0-9a-f]{12}$/.test(id)) return res.status(400).json({ error: 'invalid id' });
  if (!AGENT_ID_RE.test(teamId)) return res.status(400).json({ error: 'teamId is required' });
  if (!knowledgeTeamVisible(scope, teamId)) return res.status(403).json({ error: 'forbidden' });
  try {
    const r = await fetch(`${ORCH_URL()}/internal/knowledge/triggers`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ teamId, id, loadTriggers: Array.isArray(req.body?.loadTriggers) ? req.body.loadTriggers : [] }),
    });
    const out = await r.json().catch(() => ({}));
    if (!r.ok || !out.ok) return res.status(r.status === 400 ? 400 : 502).json({ error: (out && out.error) || 'triggers update failed' });
    res.json({ ok: true, id, loadTriggers: out.loadTriggers || [] });
  } catch (err) {
    res.status(502).json({ error: `orchestrator unreachable: ${err.message}` });
  }
});

// Nominate a KB entry for promotion (operator-initiated, from the agent-chat
// Knowledge tab). Raises a promotion-suggestion card for the entry's convergence
// cluster — works below the convergence threshold too; never promotes by itself.
// Proxies the same orchestrator endpoint the `knowledge nominate` CLI uses.
app.post('/api/knowledge/item/:id/nominate', apiLimiter, async (req, res) => {
  const scope = getScope(req);
  const { id } = req.params;
  const agentId = typeof req.body?.agentId === 'string' ? req.body.agentId : '';
  const note = typeof req.body?.note === 'string' ? req.body.note : undefined;
  if (!/^[0-9a-f]{12}$/.test(id)) return res.status(400).json({ error: 'invalid id' });
  if (!AGENT_ID_RE.test(agentId)) return res.status(400).json({ error: 'agentId is required' });
  const cfg = readJsonFile(path.join(AGENTS_DIR, agentId, 'config.json'), null);
  if (!cfg) return res.status(404).json({ error: 'agent not found' });
  if (!visibleAgent(scope, agentMetaForScope(cfg))) return res.status(403).json({ error: 'forbidden' });
  try {
    const r = await fetch(`${ORCH_URL()}/internal/agents/${encodeURIComponent(agentId)}/knowledge/nominate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entryId: id, note }),
    });
    const out = await r.json().catch(() => ({}));
    if (!r.ok || !out.ok) return res.status(r.status === 400 ? 400 : 502).json({ error: (out && out.error) || 'nominate failed' });
    res.json({ ok: true, candidate: out.candidate });
  } catch (err) {
    res.status(502).json({ error: `orchestrator unreachable: ${err.message}` });
  }
});

// Locate which of an agent's session logs holds a row with `correlationId`.
// Returns the roomId or null. A hit in a rotated archive (`<room>.<seq>.jsonl`,
// #673) resolves back to its base room, not the archive stem. Capped read/file.
function findRoomForCorrelation(agentId, correlationId) {
  if (!AGENT_ID_RE.test(agentId)) return null;
  const dir = controlOrAgentPath(agentId, 'sessions');
  let files;
  try { files = fs.readdirSync(dir).filter(n => n.endsWith('.jsonl')); } catch { return null; }
  for (const name of files) {
    let raw;
    try { raw = fs.readFileSync(path.join(dir, name), 'utf8'); } catch { continue; }
    if (!raw.includes(correlationId)) continue; // cheap pre-filter
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      const row = kbParseLine(line);
      if (row && row.correlationId === correlationId) return baseRoomOfSessionFile(name, files);
    }
  }
  return null;
}

// Live feed — tails the append-only events file the orchestrator writes, applies
// the scope filter, forwards matching harvest/promotion events. Same byte-offset
// + fs.watch tailer as the session-log stream (/session/:roomId/stream).
app.get('/api/knowledge/stream', (req, res) => {
  const parsed = knowledgeScopeParam(req);
  const scope = parsed.scope;
  const filepath = KNOWLEDGE_EVENTS_FILE;
  const dirpath = path.dirname(filepath);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  let cursor;
  if (req.query.since !== undefined) {
    cursor = Math.max(0, parseInt(req.query.since, 10) || 0);
  } else {
    try { cursor = fs.existsSync(filepath) ? fs.statSync(filepath).size : 0; } catch { cursor = 0; }
  }

  let lineBuf = '';
  let fileWatcher = null;
  let dirWatcher = null;
  let draining = false;
  let pending = false;
  let closed = false;

  const writeEvent = (obj) => { try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch { /* noop */ } };
  const writeCursor = () => writeEvent({ type: '_cursor', cursor });

  try { res.write(': ready\n\n'); } catch { /* noop */ }
  writeCursor();
  const heartbeat = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* noop */ } }, 15000);

  const emitLine = (line) => {
    const ev = kbParseLine(line);
    if (ev && knowledgeLinks.matchesScope(ev, scope)) writeEvent(ev);
  };

  const drain = () => {
    if (closed) return;
    if (draining) { pending = true; return; }
    draining = true;
    let size;
    try {
      if (!fs.existsSync(filepath)) { draining = false; if (pending) { pending = false; setImmediate(drain); } return; }
      size = fs.statSync(filepath).size;
    } catch { draining = false; return; }
    if (size < cursor) { cursor = 0; lineBuf = ''; writeEvent({ type: '_truncated' }); }
    if (size === cursor) { draining = false; if (pending) { pending = false; setImmediate(drain); } return; }
    const stream = fs.createReadStream(filepath, { start: cursor, end: size - 1, encoding: 'utf8' });
    stream.on('data', (chunk) => {
      lineBuf += chunk;
      let idx;
      while ((idx = lineBuf.indexOf('\n')) >= 0) {
        const line = lineBuf.slice(0, idx);
        lineBuf = lineBuf.slice(idx + 1);
        if (line.trim()) emitLine(line);
      }
    });
    stream.on('error', () => { draining = false; if (pending) { pending = false; setImmediate(drain); } });
    stream.on('end', () => { cursor = size; writeCursor(); draining = false; if (pending) { pending = false; setImmediate(drain); } });
  };

  const startFileWatcher = () => {
    if (fileWatcher || closed) return;
    try {
      fileWatcher = fs.watch(filepath, { persistent: false }, () => drain());
      fileWatcher.on('error', () => { try { fileWatcher.close(); } catch { /* noop */ } fileWatcher = null; startDirWatcher(); });
    } catch { fileWatcher = null; startDirWatcher(); }
  };
  const startDirWatcher = () => {
    if (dirWatcher || closed) return;
    try { fs.mkdirSync(dirpath, { recursive: true }); } catch { /* noop */ }
    try {
      dirWatcher = fs.watch(dirpath, { persistent: false }, (_evt, fname) => {
        if (closed) return;
        if (fname && fname !== path.basename(filepath)) return;
        if (fs.existsSync(filepath)) {
          try { dirWatcher.close(); } catch { /* noop */ }
          dirWatcher = null;
          startFileWatcher();
          drain();
        }
      });
      dirWatcher.on('error', () => { try { dirWatcher.close(); } catch { /* noop */ } dirWatcher = null; });
    } catch { dirWatcher = null; }
  };

  if (fs.existsSync(filepath)) { startFileWatcher(); drain(); } else { startDirWatcher(); }

  req.on('close', () => {
    closed = true;
    clearInterval(heartbeat);
    if (fileWatcher) { try { fileWatcher.close(); } catch { /* noop */ } fileWatcher = null; }
    if (dirWatcher) { try { dirWatcher.close(); } catch { /* noop */ } dirWatcher = null; }
    try { res.end(); } catch { /* noop */ }
  });
});

/* ─── Promotion suggestions + promote (Shared Agent Learning, Phase 3) ──────
 * Autonomy level 2 ("Suggest"): the orchestrator collector raises promotion
 * candidates into a per-team store; these routes list them (with a heuristic
 * SKILL.md draft), optionally polish the draft with the LLM, and — on the
 * operator's confirm — execute promote(from→to) by writing the skill + a
 * MANDATORY provenance.json to the target tier. No auto-promotion: a skill is
 * only ever written from an explicit operator POST here. */

const KNOWLEDGE_SUGGESTIONS_DIR = path.join(WORKSPACE, 'knowledge-suggestions');

function readCandidateStore(teamId) {
  if (!AGENT_ID_RE.test(teamId)) return [];
  const arr = readJsonFile(path.join(KNOWLEDGE_SUGGESTIONS_DIR, `${path.basename(teamId)}.json`), []);
  return Array.isArray(arr) ? arr : [];
}

app.get('/api/knowledge/promotion-suggestions', (req, res) => {
  const scope = getScope(req);
  const teamId = typeof req.query.team === 'string' ? req.query.team : '';
  if (!AGENT_ID_RE.test(teamId)) return res.status(400).json({ error: 'team is required' });
  if (!knowledgeTeamVisible(scope, teamId)) return res.status(404).json({ error: 'not found' });
  // #775: the Suggested-tab inbox reads `open`; the triage view's "Dismissed"
  // filter reads `?status=dismissed` so a turned-down suggestion stays queryable
  // for un-dismiss. #776: the "Stale" filter reads `?status=stale` (auto-hygiene
  // aged them out of the default inbox). Any other value falls back to `open`.
  const wanted = ['dismissed', 'stale'].includes(req.query.status) ? req.query.status : 'open';
  const rows = readCandidateStore(teamId).filter(c => c && c.status === wanted);
  // Auto-match (#553, AC4): pre-compute whether each converged cluster fits an
  // existing team-tier skill (the default promotion home), so the dialog can
  // pre-select "extend" with that target. Default stays "create new" (null).
  const eligible = eligibleExtendSkills(scope, teamId, 'team');
  const suggestions = rows.map(c => {
    const view = knowledgeSuggestions.promotionSuggestionView(c, c.draft);
    view.matchedSkill = knowledgeSuggestions.matchExistingSkill(c, eligible);
    if (c.dismissReason) view.dismissReason = c.dismissReason;
    if (c.dismissedAt) view.dismissedAt = c.dismissedAt;
    if (c.staleAt) view.staleAt = c.staleAt;
    return view;
  });
  res.json({ team: teamId, status: wanted, suggestions });
});

// Optional LLM polish of a candidate's SKILL.md — operator-initiated (Draft with
// AI). Heuristic fallback on any failure (mirrors /api/agent-ports/suggest).
// Not persisted server-side: the dialog holds the returned draft.
app.post('/api/knowledge/promotion-suggestions/:id/draft', heavyLimiter, async (req, res) => {
  const scope = getScope(req);
  const teamId = typeof req.body?.team === 'string' ? req.body.team : '';
  if (!AGENT_ID_RE.test(teamId)) return res.status(400).json({ error: 'team is required' });
  if (!knowledgeTeamVisible(scope, teamId)) return res.status(404).json({ error: 'not found' });
  const cand = readCandidateStore(teamId).find(c => c && c.id === req.params.id);
  if (!cand) return res.status(404).json({ error: 'suggestion not found' });

  const heuristic = knowledgeSuggestions.buildHeuristicSkillDraft(cand);
  const fallback = () => res.json({ draft: heuristic, source: 'heuristic' });

  const target = resolveAssistTarget(req);
  if (target.selectionError) return sendAssistSelectionError(res, target);
  if (target.error) return fallback();
  const url = buildMessagesUrl(target.baseUrl);
  const headers = {
    'anthropic-version': '2023-06-01',
    ...(target.token ? { Authorization: `Bearer ${target.token}`, 'x-api-key': target.token } : {}),
  };
  const payload = { model: target.model, ...knowledgeSuggestions.buildSkillDraftRequest(cand) };
  const result = await httpPostJson(url, headers, payload);
  if (result.error || result.status < 200 || result.status >= 300) return fallback();
  const skillMd = extractMessageText(result.body);
  if (!skillMd) return fallback();
  // #921: the LLM is instructed to open with frontmatter, but the round-trip
  // contract (promoted ≡ imported) must hold even when it disobeys — inject any
  // missing key from the heuristic draft's derived values (no-op when complete).
  const withFm = knowledgeSuggestions.ensureSkillFrontmatter(skillMd, {
    name: heuristic.name, description: heuristic.description,
  });
  res.json({ draft: { name: heuristic.name, skillMd: withFm, llmDrafted: true }, source: 'llm', model: target.model, meta: assistMeta(target) });
});

// Resolve an operator-selected set of KB entry ids into an ad-hoc candidate
// (manual "combine into skill" — no stored candidate exists). Prefers live
// entries over merge tombstones, exactly like /api/knowledge/item/:id.
function adHocCandidate(teamId, entryIds) {
  const ids = [...new Set((Array.isArray(entryIds) ? entryIds : [])
    .filter(x => typeof x === 'string' && /^[0-9a-f]{12}$/.test(x)))];
  if (ids.length === 0) return null;
  const { entries } = gatherTeamEntries(teamId);
  const picked = [];
  for (const id of ids) {
    const e = entries.find(x => x && x.id === id && x.status !== 'merged')
      || entries.find(x => x && x.id === id);
    if (e) picked.push(e);
  }
  if (picked.length === 0) return null;
  return knowledgeSuggestions.candidateFromEntries(picked, { teamId, source: 'manual' });
}

// Ad-hoc SKILL.md draft over an operator-selected entry set (manual combine —
// there is no stored candidate to draft from). Same LLM-with-heuristic-fallback
// contract as the suggestion draft; `heuristicOnly: true` skips the LLM so the
// dialog can prefill instantly.
app.post('/api/knowledge/draft', heavyLimiter, async (req, res) => {
  const scope = getScope(req);
  const teamId = typeof req.body?.team === 'string' ? req.body.team : '';
  if (!AGENT_ID_RE.test(teamId)) return res.status(400).json({ error: 'team is required' });
  if (!knowledgeTeamVisible(scope, teamId)) return res.status(404).json({ error: 'not found' });
  const cand = adHocCandidate(teamId, req.body?.entryIds);
  if (!cand) return res.status(404).json({ error: 'no matching KB entries' });

  const heuristic = knowledgeSuggestions.buildHeuristicSkillDraft(cand);
  const fallback = () => res.json({ draft: heuristic, source: 'heuristic', entryIds: cand.entryIds });
  if (req.body?.heuristicOnly) return fallback();

  const target = resolveAssistTarget(req);
  if (target.selectionError) return sendAssistSelectionError(res, target);
  if (target.error) return fallback();
  const url = buildMessagesUrl(target.baseUrl);
  const headers = {
    'anthropic-version': '2023-06-01',
    ...(target.token ? { Authorization: `Bearer ${target.token}`, 'x-api-key': target.token } : {}),
  };
  const payload = { model: target.model, ...knowledgeSuggestions.buildSkillDraftRequest(cand) };
  const result = await httpPostJson(url, headers, payload);
  if (result.error || result.status < 200 || result.status >= 300) return fallback();
  const skillMd = extractMessageText(result.body);
  if (!skillMd) return fallback();
  // #921: same disobedient-model guard as the suggestion draft above.
  const withFm = knowledgeSuggestions.ensureSkillFrontmatter(skillMd, {
    name: heuristic.name, description: heuristic.description,
  });
  res.json({ draft: { name: heuristic.name, skillMd: withFm, llmDrafted: true }, source: 'llm', model: target.model, entryIds: cand.entryIds, meta: assistMeta(target) });
});

// Generate-and-store human-readable summaries (#635, AC3) for a team's KB entries
// that don't have one yet. Idempotent: entries that already carry a `summary` are
// skipped, so a reload issues NO new LLM call. Only REAL LLM summaries are
// persisted (via the orchestrator, which writes the field onto the canonical
// entry) — when no LLM target exists or a call fails, nothing is persisted and the
// overview table falls back to the deterministic heuristic at read (AC4), so a
// backfill NEVER throws and a row is never blank. Bounded per request so a large
// backlog can't stall one call; the client re-triggers while `remaining > 0`.
app.post('/api/knowledge/summaries/backfill', heavyLimiter, async (req, res) => {
  const scope = getScope(req);
  const teamId = typeof req.body?.team === 'string' ? req.body.team
    : (typeof req.body?.teamId === 'string' ? req.body.teamId : '');
  if (!AGENT_ID_RE.test(teamId)) return res.status(400).json({ error: 'team is required' });
  if (!knowledgeTeamVisible(scope, teamId)) return res.status(404).json({ error: 'not found' });

  const MAX_PER_REQUEST = 40;
  const { entries } = gatherTeamEntries(teamId);
  const missing = (Array.isArray(entries) ? entries : []).filter(
    (e) => e && typeof e.id === 'string' && /^[0-9a-f]{12}$/.test(e.id)
      && e.status !== 'merged'
      && typeof e.text === 'string' && e.text.trim() !== ''
      && !(typeof e.summary === 'string' && e.summary.trim() !== ''),
  );
  const remaining = Math.max(0, missing.length - MAX_PER_REQUEST);
  const batch = missing.slice(0, MAX_PER_REQUEST);
  if (batch.length === 0) return res.json({ generated: 0, persisted: 0, remaining: 0, source: 'none' });

  // Resolve the assist target ONCE per request (not per entry) — the whole
  // batch bills against the one selected provider.
  const target = resolveAssistTarget(req);
  if (target.selectionError) return sendAssistSelectionError(res, target);
  // No LLM target: persist nothing (heuristic is display-only). Report the count
  // so the caller knows these render via the read-time fallback (AC4).
  if (target.error) return res.json({ generated: 0, persisted: 0, remaining, source: 'heuristic', reason: target.error });

  const url = buildMessagesUrl(target.baseUrl);
  const headers = {
    'anthropic-version': '2023-06-01',
    ...(target.token ? { Authorization: `Bearer ${target.token}`, 'x-api-key': target.token } : {}),
  };
  const summaries = {};
  let failures = 0;
  // Sequential: one entry = one short /v1/messages call, bounded by MAX_PER_REQUEST.
  for (const e of batch) {
    try {
      const payload = { model: target.model, ...knowledgeSuggestions.buildSummaryRequest(e) };
      const result = await httpPostJson(url, headers, payload);
      if (result.error || result.status < 200 || result.status >= 300) { failures += 1; continue; }
      const text = extractMessageText(result.body);
      const clean = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '';
      if (clean) summaries[e.id] = clean; else failures += 1;
    } catch { failures += 1; }
  }

  const ids = Object.keys(summaries);
  if (ids.length === 0) return res.json({ generated: 0, persisted: 0, remaining, source: 'llm', failures, meta: assistMeta(target) });

  try {
    const r = await fetch(`${ORCH_URL()}/internal/knowledge/summaries`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ teamId, summaries }),
    });
    const out = await r.json().catch(() => ({}));
    if (!r.ok || !out.ok) return res.status(502).json({ error: (out && out.error) || 'summary persist failed' });
    res.json({ generated: ids.length, persisted: out.persisted || ids.length, remaining, source: 'llm', model: target.model, failures, meta: assistMeta(target) });
  } catch (err) {
    res.status(502).json({ error: `orchestrator unreachable: ${err.message}` });
  }
});

// Re-synthesise an EXISTING skill together with the converged knowledge (#553,
// AC5) into one coherent, editable document. Mirrors /api/knowledge/draft's
// LLM-with-heuristic-fallback contract; `heuristicOnly: true` skips the LLM so the
// dialog can prefill instantly. Purely a preview — nothing is written here; the
// operator submits the (edited) result to /api/knowledge/promote { mode: 'extend' }.
app.post('/api/knowledge/extend-draft', heavyLimiter, async (req, res) => {
  const scope = getScope(req);
  const teamId = typeof req.body?.team === 'string' ? req.body.team
    : (typeof req.body?.teamId === 'string' ? req.body.teamId : '');
  if (!AGENT_ID_RE.test(teamId)) return res.status(400).json({ error: 'team is required' });
  if (!knowledgeTeamVisible(scope, teamId)) return res.status(404).json({ error: 'not found' });
  const tier = req.body?.tier === 'global' ? 'global' : 'team';
  const targetName = typeof req.body?.targetName === 'string' ? req.body.targetName : '';
  if (!knowledgeSuggestions.SKILL_NAME_RE.test(targetName)) return res.status(400).json({ error: 'invalid target skill name' });

  const target = resolveExtendTarget(teamId, tier, targetName);
  if (target.error) return res.status(target.notFound ? 404 : 400).json({ error: target.error });

  const cand = (req.body?.suggestionId
    ? readCandidateStore(teamId).find(c => c && c.id === req.body.suggestionId) || null
    : null)
    || adHocCandidate(teamId, req.body?.entryIds);
  if (!cand) return res.status(404).json({ error: 'no matching KB entries' });

  const heuristic = knowledgeSuggestions.buildHeuristicSkillExtension(target.existingSkillMd, cand);
  const fallback = () => res.json({
    draft: { skillMd: heuristic.skillMd, llmDrafted: false }, source: 'heuristic',
    added: heuristic.added, entryIds: cand.entryIds,
  });
  if (req.body?.heuristicOnly) return fallback();

  const gen = resolveAssistTarget(req);
  if (gen.selectionError) return sendAssistSelectionError(res, gen);
  if (gen.error) return fallback();
  const url = buildMessagesUrl(gen.baseUrl);
  const headers = {
    'anthropic-version': '2023-06-01',
    ...(gen.token ? { Authorization: `Bearer ${gen.token}`, 'x-api-key': gen.token } : {}),
  };
  const payload = { model: gen.model, ...knowledgeSuggestions.buildSkillExtensionRequest(target.existingSkillMd, cand) };
  const result = await httpPostJson(url, headers, payload);
  if (result.error || result.status < 200 || result.status >= 300) return fallback();
  const skillMd = extractMessageText(result.body);
  if (!skillMd) return fallback();
  res.json({ draft: { skillMd, llmDrafted: true }, source: 'llm', model: gen.model, entryIds: cand.entryIds, meta: assistMeta(gen) });
});

app.post('/api/knowledge/promotion-suggestions/:id/dismiss', apiLimiter, async (req, res) => {
  const scope = getScope(req);
  const teamId = typeof req.body?.team === 'string' ? req.body.team : '';
  if (!AGENT_ID_RE.test(teamId)) return res.status(400).json({ error: 'team is required' });
  if (!knowledgeTeamVisible(scope, teamId)) return res.status(403).json({ error: 'forbidden' });
  // #775: an optional structured reason travels with the dismissal. The
  // orchestrator validates it against its closed set (free text is dropped).
  const reason = typeof req.body?.reason === 'string' ? req.body.reason : null;
  try {
    await fetch(`${ORCH_URL()}/internal/knowledge/dismiss`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ teamId, suggestionId: req.params.id, reason }),
    });
  } catch { /* best-effort — lifecycle is a convenience, not a gate */ }
  res.json({ ok: true });
});

// #775: restore a previously-dismissed suggestion to the open inbox (the triage
// view's Un-dismiss action). Mirrors dismiss — the underlying lessons are never
// touched, only the candidate's lifecycle status.
app.post('/api/knowledge/promotion-suggestions/:id/undismiss', apiLimiter, async (req, res) => {
  const scope = getScope(req);
  const teamId = typeof req.body?.team === 'string' ? req.body.team : '';
  if (!AGENT_ID_RE.test(teamId)) return res.status(400).json({ error: 'team is required' });
  if (!knowledgeTeamVisible(scope, teamId)) return res.status(403).json({ error: 'forbidden' });
  try {
    await fetch(`${ORCH_URL()}/internal/knowledge/undismiss`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ teamId, suggestionId: req.params.id }),
    });
  } catch { /* best-effort — lifecycle is a convenience, not a gate */ }
  res.json({ ok: true });
});

// #559: after a successful promote/extend, remove (archive) the source KB entries
// the new skill now supersedes. Best-effort — NEVER rolls the promotion back and
// never throws: a failure returns a warning the caller surfaces to the operator
// (AC7) while the skill stays in place. Only called when the operator left the
// pre-ticked checkbox checked (opt-in at the API layer via removeSourceKnowledge
// === true), so every existing promotion caller is byte-for-byte unaffected (AC11).
async function cleanupPromotedSource(teamId, entryIds, skill) {
  try {
    const r = await fetch(`${ORCH_URL()}/internal/knowledge/promote-cleanup`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ teamId, entryIds, skill }),
    });
    const out = await r.json().catch(() => ({}));
    if (!r.ok || !out.ok) {
      return { removed: 0, warning: (out && out.error) || `source cleanup failed (HTTP ${r.status})` };
    }
    return { removed: out.removed || 0 };
  } catch (err) {
    return { removed: 0, warning: `source cleanup unreachable: ${err.message}` };
  }
}

// promote(from → to): write the operator-approved skill + provenance.json to the
// target tier. Generalises /api/skills/promote-to-global (agent→team, team→global).
app.post('/api/knowledge/promote', heavyLimiter, async (req, res) => {
  const scope = getScope(req);
  const teamId = typeof req.body?.teamId === 'string' ? req.body.teamId : '';
  if (!AGENT_ID_RE.test(teamId)) return res.status(400).json({ error: 'teamId is required' });
  if (!knowledgeTeamVisible(scope, teamId)) return res.status(403).json({ error: 'forbidden' });

  // extend (issue #553): fold the converged knowledge into an EXISTING skill
  // instead of creating a new one. The operator-approved (re-synthesised) SKILL.md
  // replaces the target's content and its provenance UNIONS the new entry ids onto
  // the existing record. Tier is symmetric to a promotion target (team→team /
  // team→global). SKILL.md is only ever written here, on submit, so a failed LLM
  // re-synthesis (which happens earlier in /extend-draft) never touches the skill.
  if (req.body?.mode === 'extend') {
    const v = knowledgeSuggestions.validateExtension(req.body);
    if (!v.ok) return res.status(400).json({ error: v.error });

    const target = resolveExtendTarget(teamId, v.to, v.targetName);
    if (target.error) return res.status(target.notFound ? 404 : 400).json({ error: target.error });

    // E5: reject an empty / identical (no-op) submit.
    if (trimTrailingWhitespace(v.skillMd) === trimTrailingWhitespace(target.existingSkillMd)) {
      return res.status(400).json({ error: 'no changes: submitted content is identical to the existing skill' });
    }

    // Provenance source (same as create): stored candidate for a suggestion card,
    // else an ad-hoc candidate rebuilt from the selected entries (manual combine).
    const cand = (req.body.suggestionId
      ? readCandidateStore(teamId).find(c => c && c.id === req.body.suggestionId) || null
      : null)
      || adHocCandidate(teamId, v.entryIds);

    const existingProv = readSkillProvenance(target.dir) || {};
    const extendedBy = (req.user && (req.user.sub || req.user.username)) || 'operator';
    const prov = knowledgeSuggestions.extendSkillProvenance({
      existingProv, from: v.from, to: v.to, teamId, entryIds: v.entryIds, candidate: cand, extendedBy,
    });
    // #639: write the re-synthesised content + unioned provenance in place and
    // continue the EXISTING skill's chain (mode 'chain') via the shared core. The
    // extend target is supposed to already exist, so there is no collision gate
    // here (planSkillWrite's allowExisting case) — the write is unconditional.
    const wrote = commitSkillWrite({
      destDir: target.dir,
      skillMd: v.skillMd,
      provenance: prov,
      stamp: {
        mode: 'chain', name: v.targetName, by: skillActor(req), action: 'extended',
        note: `folded ${Array.isArray(v.entryIds) ? v.entryIds.length : 0} converged ${(Array.isArray(v.entryIds) && v.entryIds.length === 1) ? 'lesson' : 'lessons'}`,
      },
    });
    if (wrote.error) return res.status(500).json({ error: `Failed to write skill: ${wrote.error}` });

    // Best-effort: orchestrator flips the candidate lifecycle, emits a distinct
    // "extension" feed event, and (team tier) re-syncs the refreshed content to
    // every agent that already has the skill active (AC9/AC10).
    try {
      await fetch(`${ORCH_URL()}/internal/knowledge/promoted`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          teamId, suggestionId: req.body.suggestionId || null,
          ...(Array.isArray(req.body.suggestionIds) && req.body.suggestionIds.length ? { suggestionIds: req.body.suggestionIds } : {}),
          skill: { name: v.targetName, tier: v.to }, entryIds: v.entryIds, extend: true,
        }),
      });
    } catch { /* best-effort */ }

    // #559: remove the source knowledge folded into this skill (AC2 — extend path;
    // AC6 — only after the SKILL.md/provenance write above succeeded). Only the
    // entries added in THIS action are candidates (E3 — v.entryIds, not the skill's
    // whole historical backing set). Opt-in, best-effort, never rolls back.
    let cleanup = null;
    if (req.body.removeSourceKnowledge === true) {
      cleanup = await cleanupPromotedSource(teamId, v.entryIds, { name: v.targetName, tier: v.to });
    }

    return res.status(200).json({ name: v.targetName, tier: v.to, teamId, provenance: prov, extended: true, ...(cleanup ? { cleanup } : {}) });
  }

  // agent→team lift (Phase 4): the source is a private AGENT skill. Resolve it and
  // pre-fill skillMd + entryIds from its SKILL.md / provenance.json, so the caller
  // only names the source and provenance is carried forward (still mandatory).
  let liftProv = null;
  let liftSrcId = null;
  if (req.body?.from === 'agent') {
    const agentId = typeof req.body.agentId === 'string' ? req.body.agentId : '';
    if (!AGENT_ID_RE.test(agentId)) return res.status(400).json({ error: 'agentId is required for an agent→team lift' });
    const name = typeof req.body.name === 'string' ? req.body.name : '';
    if (!knowledgeSuggestions.SKILL_NAME_RE.test(name)) return res.status(400).json({ error: 'invalid skill name' });
    const agentsBaseDir = path.resolve(AGENTS_DIR);
    const srcDir = path.resolve(agentsBaseDir, agentId, 'skills', name);
    const srcRel = path.relative(agentsBaseDir, srcDir);
    if (srcRel.startsWith('..') || path.isAbsolute(srcRel)) return res.status(400).json({ error: 'invalid agent id or skill name' });
    const srcSkill = path.join(srcDir, 'SKILL.md');
    if (!fs.existsSync(srcSkill)) return res.status(404).json({ error: `agent skill '${name}' not found for '${agentId}'` });
    liftSrcId = skillSourceIdentity(srcDir);
    liftProv = readSkillProvenance(srcDir) || {};
    if (!req.body.skillMd) { try { req.body.skillMd = fs.readFileSync(srcSkill, 'utf8'); } catch { /* validated below */ } }
    if (!Array.isArray(req.body.entryIds) || req.body.entryIds.length === 0) {
      req.body.entryIds = Array.isArray(liftProv.entryIds) ? liftProv.entryIds : [];
    }
  }

  const v = knowledgeSuggestions.validatePromotion(req.body);
  if (!v.ok) return res.status(400).json({ error: v.error });

  // Provenance source: the stored candidate when the promotion came from a
  // suggestion card, else an ad-hoc candidate rebuilt from the selected entries
  // (manual combine) — so originAgents/sessions/sourceRefs are never lost.
  const cand = (req.body.suggestionId
    ? readCandidateStore(teamId).find(c => c && c.id === req.body.suggestionId) || null
    : null)
    || (v.from === 'team' ? adHocCandidate(teamId, v.entryIds) : null);

  // Destination dir by target tier (same containment guards as promote-to-global).
  let dstDir;
  if (v.to === 'team') {
    dstDir = safeTeamSkillDir(teamId, v.name);
    if (!dstDir) return res.status(400).json({ error: 'Invalid team id or skill name' });
  } else {
    dstDir = safeGlobalSkillDir(v.name);
    if (!dstDir) return res.status(400).json({ error: 'Invalid skill name' });
  }
  const dstExists = fs.existsSync(path.join(dstDir, 'SKILL.md'));
  const wp = skillTransfer.planSkillWrite({ onCollision: req.body.overwrite ? 'overwrite' : 'reject', exists: dstExists });
  if (!wp.ok) return res.status(409).json({ error: `Skill '${v.name}' already exists`, exists: true });

  const promotedBy = (req.user && (req.user.sub || req.user.username)) || 'operator';
  const prov = v.from === 'agent'
    ? {
        fromTier: 'agent', toTier: v.to, teamId,
        entryIds: v.entryIds,
        canonicalId: (liftProv && liftProv.canonicalId) || v.entryIds[0] || null,
        originAgents: Array.isArray(liftProv && liftProv.originAgents) ? liftProv.originAgents : [],
        convergence: Array.isArray(liftProv && liftProv.convergence)
          ? liftProv.convergence
          : (Array.isArray(liftProv && liftProv.originAgents) ? liftProv.originAgents : []),
        sourceRefs: Array.isArray(liftProv && liftProv.sourceRefs) ? liftProv.sourceRefs : [],
        sessions: Array.isArray(liftProv && liftProv.sessions) ? liftProv.sessions : [],
        originTeamId: (liftProv && liftProv.originTeamId) || teamId,
        liftedFrom: { tier: 'agent', agentId: req.body.agentId, name: v.name },
        promotedAt: new Date().toISOString(), promotedBy,
      }
    : knowledgeSuggestions.buildSkillProvenance({
        from: v.from, to: v.to, teamId, entryIds: v.entryIds, candidate: cand, promotedBy,
      });
  // #625/#639: an agent→team lift records the agent origin; a KB→skill promote
  // is authored here (no origin). SKILL.md is written by content, so this is a
  // fresh instance chain (mode 'copy' — discards any stale copied manifest). The
  // write + stamp go through the shared file-write core.
  const stamp = v.from === 'agent'
    ? {
        mode: 'copy', name: v.name, by: skillActor(req), action: 'lifted',
        origin: skillOrigin({ tier: 'agent', agentId: req.body.agentId, sourceVersion: liftSrcId && liftSrcId.sourceVersion, sourceHash: liftSrcId && liftSrcId.sourceHash }),
      }
    : { mode: 'copy', name: v.name, by: skillActor(req), action: 'promoted' };
  const wrote = commitSkillWrite({ destDir: dstDir, overwrite: wp.overwrite, skillMd: v.skillMd, provenance: prov, stamp });
  if (wrote.error) return res.status(500).json({ error: `Failed to write skill: ${wrote.error}` });

  // Best-effort: orchestrator flips the candidate lifecycle + emits the feed event.
  try {
    await fetch(`${ORCH_URL()}/internal/knowledge/promoted`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        teamId, suggestionId: req.body.suggestionId || null,
        ...(Array.isArray(req.body.suggestionIds) && req.body.suggestionIds.length ? { suggestionIds: req.body.suggestionIds } : {}),
        skill: { name: v.name, tier: v.to }, entryIds: v.entryIds,
      }),
    });
  } catch { /* best-effort */ }

  // #559: remove the source knowledge folded into this new skill (AC2 — create
  // path; AC6 — only after the write above). Opt-in via the pre-ticked checkbox,
  // best-effort, never rolls back. Absent on an agent→team lift (no checkbox in
  // that UI) so lifts are untouched.
  let cleanup = null;
  if (req.body.removeSourceKnowledge === true) {
    cleanup = await cleanupPromotedSource(teamId, v.entryIds, { name: v.name, tier: v.to });
  }

  res.status(201).json({
    name: v.name, tier: v.to, teamId, provenance: prov,
    ...(cleanup ? { cleanup } : {}),
    // #921: non-blocking — the skill was written; the caller may surface that it
    // lacks the import-grade frontmatter header.
    ...(Array.isArray(v.warnings) && v.warnings.length ? { warnings: v.warnings } : {}),
  });
});

// List an agent's PRIVATE (agent-tier) skills — the bottom rung of the skill
// ladder. They live in the agent's own pool and never appear in the shared
// knowledge graph, so the operator lifts them to the team (agent→team) from here.
app.get('/api/agents/:id/private-skills', (req, res) => {
  const scope = getScope(req);
  const { id } = req.params;
  if (!AGENT_ID_RE.test(id)) return res.status(400).json({ error: 'invalid agent id' });
  // Containment guard: AGENT_ID_RE excludes traversal segments, but CodeQL does
  // not recognise the regex as a sanitiser once `id` travels through a
  // destructure, so re-verify with path.relative before any fs access and build
  // every downstream path from the contained dir (house idiom, cf. ~L2578).
  const agentsBaseDir = path.resolve(AGENTS_DIR);
  const agentDir = path.resolve(agentsBaseDir, id);
  const agentRel = path.relative(agentsBaseDir, agentDir);
  if (agentRel.startsWith('..') || path.isAbsolute(agentRel)) return res.status(400).json({ error: 'invalid agent id' });
  const cfg = readJsonFile(path.join(agentDir, 'config.json'), null);
  if (!cfg) return res.status(404).json({ error: 'agent not found' });
  // The lift target is the agent's SQUAD pool (/workspace/teams/<squad>/skills).
  const teamId = agentKnowledgeTeam({ ...cfg, id: cfg.id || id });
  if (!visibleAgent(scope, agentMetaForScope(cfg))) return res.status(403).json({ error: 'forbidden' });
  // Seed-time skill grants land in the same per-agent skills dir — they are
  // copies of pool skills, not agent-authored knowledge, so they are not
  // "private" and must not surface as lift candidates. The grant is team-owned
  // (orchestrator/skill-grants.js): member override wins, else the construct's
  // own skills[], else the parent team's list. `team-member` is the only
  // inheriting role — `bp-instance` went with the BriefingPack model (#1962).
  const parentId = cfg.role === 'team-member' ? cfg.parentTeamId : null;
  // parentId originates from the agent's own config rather than the request,
  // but contain it the same way before reading so no unvalidated value ever
  // reaches fs (keeps CodeQL's taint tracker satisfied here too).
  let parentCfg = null;
  if (parentId) {
    const parentDir = path.resolve(agentsBaseDir, String(parentId));
    const parentRel = path.relative(agentsBaseDir, parentDir);
    if (!parentRel.startsWith('..') && !path.isAbsolute(parentRel)) {
      parentCfg = readJsonFile(path.join(parentDir, 'config.json'), null);
    }
  }
  const granted = new Set(
    Array.isArray(cfg.skillsOverride) ? cfg.skillsOverride
    : Array.isArray(cfg.skills) ? cfg.skills
    : (parentCfg && Array.isArray(parentCfg.skills)) ? parentCfg.skills
    : []);
  const skillsDir = path.join(agentDir, 'skills');
  const skills = [];
  try {
    for (const name of fs.readdirSync(skillsDir)) {
      if (granted.has(name)) continue;
      const dir = path.join(skillsDir, name);
      if (!fs.existsSync(path.join(dir, 'SKILL.md'))) continue;
      const prov = readSkillProvenance(dir);
      skills.push({ name, provenance: prov || null });
    }
  } catch { /* no private pool yet */ }
  skills.sort((a, b) => a.name.localeCompare(b.name));
  res.json({ agentId: id, teamId, skills });
});

// ── Skill (de)activation (team-owned skills, phase 2) ───────────────────────
// One-click activation from the Knowledge page: proxies the orchestrator's
// idempotent list-edit + additive workspace file sync. `teamId` is the SQUAD
// (team agent id) the Knowledge page is scoped to; when the target turns out
// to be a standalone agent the per-agent route is used instead. Covered by the
// audit trail (#305) like every /api mutation.
async function proxySkillActivation(req, res, active) {
  const { teamId, skillName, includeMembers, onlyMembers } = req.body || {};
  if (typeof teamId !== 'string' || !AGENT_ID_RE.test(teamId)) {
    return res.status(400).json({ error: 'teamId (agent id of the team) required' });
  }
  if (typeof skillName !== 'string' || !SKILL_NAME_RE.test(skillName)) {
    return res.status(400).json({ error: 'skillName required (letters, digits, -, _)' });
  }
  const cfg = readJsonFile(path.join(AGENTS_DIR, teamId, 'config.json'), null);
  if (!cfg) return res.status(404).json({ error: 'team not found' });
  const scope = getScope(req);
  // D9 (#2080): activating a skill edits the GRANT (`skills[]` / a member's
  // `skillsOverride`) before it syncs any file, so this is an agent-settings
  // change — Team Admin only, not merely visible. It was `visibleAgent`, which
  // let any member of the owning team re-grant its skills.
  if (!canManageAgent(scope, agentMetaForScope(cfg))) return res.status(403).json({ error: 'forbidden' });
  const orchestratorUrl = process.env.ORCHESTRATOR_URL || 'http://orchestrator:4002';
  const route = cfg.role === 'team'
    ? `/internal/teams/${encodeURIComponent(teamId)}/skills/${active ? 'activate' : 'deactivate'}`
    : `/internal/agents/${encodeURIComponent(teamId)}/skills/${active ? 'activate' : 'deactivate'}`;
  try {
    const resp = await fetch(`${orchestratorUrl}${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        skillName,
        ...(Array.isArray(includeMembers) ? { includeMembers } : {}),
        ...(Array.isArray(onlyMembers) ? { onlyMembers } : {}),
      }),
    });
    const data = await resp.json().catch(() => ({}));
    return res.status(resp.status).json(data);
  } catch (err) {
    return res.status(502).json({ error: `Orchestrator unreachable: ${err.message}` });
  }
}

app.post('/api/knowledge/activate', apiLimiter, (req, res) => proxySkillActivation(req, res, true));
app.post('/api/knowledge/deactivate', apiLimiter, (req, res) => proxySkillActivation(req, res, false));

// ── Plugin grant (#1547) ────────────────────────────────────────────────────
// The plugin sibling of the skill activation above, and routed the same way:
// the caller names an agent construct, and whether that resolves to the team
// route or the single-agent route is decided from its role, not by the client.
// Everything else — granularity grantability, installed-ness, override
// semantics — is re-enforced by the orchestrator, which owns the grant store.
async function proxyPluginActivation(req, res, active) {
  const { agentId, pluginId, scopeGranularity, includeMembers } = req.body || {};
  if (typeof agentId !== 'string' || !AGENT_ID_RE.test(agentId)) {
    return res.status(400).json({ error: 'agentId (agent or team construct) required' });
  }
  if (typeof pluginId !== 'string' || !PLUGIN_ID_RE.test(pluginId)) {
    return res.status(400).json({ error: 'pluginId required (lowercase slug)' });
  }
  const cfg = readJsonFile(path.join(AGENTS_DIR, agentId, 'config.json'), null);
  if (!cfg) return res.status(404).json({ error: 'agent not found' });
  const scope = getScope(req);
  // D9 (#2080): the plugin sibling of the skill grant above, and the same
  // reasoning — a grant decides what privilege-holding CLI the agent can reach,
  // which is squarely "agent settings (… plugins …)" in §6's matrix.
  if (!canManageAgent(scope, agentMetaForScope(cfg))) return res.status(403).json({ error: 'forbidden' });

  const orchestratorUrl = process.env.ORCHESTRATOR_URL || 'http://orchestrator:4002';
  const route = cfg.role === 'team'
    ? `/internal/teams/${encodeURIComponent(agentId)}/plugins/${active ? 'activate' : 'deactivate'}`
    : `/internal/agents/${encodeURIComponent(agentId)}/plugins/${active ? 'activate' : 'deactivate'}`;
  try {
    const resp = await fetch(`${orchestratorUrl}${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pluginId,
        ...(typeof scopeGranularity === 'string' ? { scopeGranularity } : {}),
        ...(Array.isArray(includeMembers) ? { includeMembers } : {}),
      }),
    });
    const data = await resp.json().catch(() => ({}));
    return res.status(resp.status).json(data);
  } catch (err) {
    return res.status(502).json({ error: `Orchestrator unreachable: ${err.message}` });
  }
}

app.post('/api/agents/:id/plugins/activate', apiLimiter, (req, res) => {
  req.body = { ...(req.body || {}), agentId: req.params.id };
  return proxyPluginActivation(req, res, true);
});
app.post('/api/agents/:id/plugins/deactivate', apiLimiter, (req, res) => {
  req.body = { ...(req.body || {}), agentId: req.params.id };
  return proxyPluginActivation(req, res, false);
});

// ── Skill drift resync (#629 AC3/AC4) ───────────────────────────────────────
// Deliver the current source content to seeded copies through the orchestrator's
// drift-gated additive sync. Body: { name, scope: { teamId?, agentId? } }.
// A per-copy `outdated` is resynced; `diverged`/`conflict`/`orphaned`/`unknown`
// is refused (never auto-overwritten) and surfaced with a manual-path hint.
// Bulk "Sync all outdated" for a team is the { name, scope: { teamId } } form.
app.post('/api/skills/resync', apiLimiter, async (req, res) => {
  const { name, scope } = req.body || {};
  const skillName = typeof name === 'string' ? name : (req.body || {}).skillName;
  if (typeof skillName !== 'string' || !SKILL_NAME_RE.test(skillName)) {
    return res.status(400).json({ error: 'name required (letters, digits, -, _)' });
  }
  const s = scope && typeof scope === 'object' ? scope : {};
  const teamId = typeof s.teamId === 'string' ? s.teamId : null;
  const agentId = typeof s.agentId === 'string' ? s.agentId : null;
  if (!teamId && !agentId) return res.status(400).json({ error: 'scope.teamId or scope.agentId required' });
  if (teamId && !AGENT_ID_RE.test(teamId)) return res.status(400).json({ error: 'invalid scope.teamId' });
  if (agentId && !AGENT_ID_RE.test(agentId)) return res.status(400).json({ error: 'invalid scope.agentId' });

  // Scope-visibility: the caller must be able to see the targeted construct.
  const anchorId = teamId || agentId;
  const cfg = readJsonFile(path.join(AGENTS_DIR, anchorId, 'config.json'), null);
  if (!cfg) return res.status(404).json({ error: 'target not found' });
  const callerScope = getScope(req);
  if (!visibleAgent(callerScope, agentMetaForScope(cfg))) return res.status(403).json({ error: 'forbidden' });

  const orchestratorUrl = process.env.ORCHESTRATOR_URL || 'http://orchestrator:4002';
  try {
    const resp = await fetch(`${orchestratorUrl}/internal/skills/resync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skillName, ...(teamId ? { teamId } : {}), ...(agentId ? { agentId } : {}) }),
    });
    const data = await resp.json().catch(() => ({}));
    return res.status(resp.status).json(data);
  } catch (err) {
    return res.status(502).json({ error: `Orchestrator unreachable: ${err.message}` });
  }
});

// The environment a team shares (from any of its agents' configs). Mirrors the
// orchestrator's resolveTeamEnvId; used only to read/display config here.
function teamEnvironment(teamId) {
  let ids;
  try { ids = fs.readdirSync(AGENTS_DIR); } catch { return null; }
  for (const id of ids) {
    const cfg = readJsonFile(path.join(AGENTS_DIR, id, 'config.json'), null);
    if (!cfg) continue;
    if (agentKnowledgeTeam({ ...cfg, id: cfg.id || id }) === teamId && cfg.environmentId) {
      const env = loadEnvironment(cfg.environmentId);
      if (env) return env;
    }
  }
  return null;
}

// Per-team knowledge-config overrides (#570). The orchestrator persists the four
// knowledge-config groups per team at /workspace/teams/<teamId>/knowledge-config.json;
// this is the read-only mirror (api.js never cross-requires the orchestrator).
function loadTeamKnowledgeOverrides(teamId) {
  if (!AGENT_ID_RE.test(String(teamId || ''))) return {};
  const raw = readJsonFile(path.join(WORKSPACE, 'teams', teamId, 'knowledge-config.json'), null);
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
}

// The team's effective knowledge env: the shared environment overlaid with the
// team's per-team overrides (#570). Every knowledge read path resolves config
// through this so two teams sharing one env report independent settings.
function teamKnowledgeEnv(teamId) {
  return knowledgeSuggestions.mergeTeamKnowledgeConfig(teamEnvironment(teamId), loadTeamKnowledgeOverrides(teamId));
}

// Auto-resync gate (#629 AC5): after a source skill is EDITED, fan the drift-
// gated resync out to every affected team whose resync mode is `auto`. The
// default `review` changes nothing (dependent copies simply show `outdated`
// until an operator resyncs them). Best-effort + fire-and-forget: an edit must
// never fail or block because auto-resync could not fan out. The orchestrator's
// resyncSkill is itself drift-gated (only `outdated` copies are overwritten;
// diverged/conflict/orphaned/unknown are refused), so this is safe to fire even
// for a team that also carries its own team-tier copy of the name.
function autoResyncOnEdit(skillName, { tier, teamId } = {}) {
  const orchestratorUrl = process.env.ORCHESTRATOR_URL || 'http://orchestrator:4002';
  let targetTeams = [];
  if (tier === 'team') {
    if (teamId) targetTeams = [teamId];
  } else {
    // Global edit: every team agent that grants the skill (members resolve it
    // team-first, so a team with its own copy is a no-op resync — see above).
    let ids;
    try { ids = fs.readdirSync(AGENTS_DIR); } catch { ids = []; }
    for (const id of ids) {
      const cfg = readJsonFile(path.join(AGENTS_DIR, id, 'config.json'), null);
      if (cfg && cfg.role === 'team' && Array.isArray(cfg.skills) && cfg.skills.includes(skillName)) {
        targetTeams.push(cfg.id || id);
      }
    }
  }
  for (const tid of targetTeams) {
    let mode;
    try { mode = knowledgeSuggestions.resolveSkillResyncMode(teamKnowledgeEnv(tid)); } catch { mode = null; }
    if (mode !== 'auto') continue; // default `review`: leave copies outdated
    fetch(`${orchestratorUrl}/internal/skills/resync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skillName, teamId: tid }),
    }).catch(() => { /* best-effort */ });
  }
}

// Team autonomy level (0..3, default 1). Local read — api.js does not import the
// orchestrator's knowledge-store; the clamp mirrors knowledgeAutonomyLevel.
// NOTE the `env ? … : undefined` shape: `Number(null)` is 0, so the previous
// `Number(env && env.knowledgeAutonomy)` silently displayed level 0 ("Off") for
// a team whose env could not be resolved — while the system actually ran at the
// default level 1.
function teamAutonomyLevel(env) {
  const raw = env ? env.knowledgeAutonomy : undefined;
  if (raw === null || raw === undefined || raw === '') return 1;
  const n = Number(raw);
  if (!Number.isInteger(n)) return 1;
  return Math.max(0, Math.min(3, n));
}

// Supervised-review flag (default off) — mirrors orchestrator knowledgeReviewEnabled.
function knowledgeReviewOn(env) {
  const raw = env ? env.knowledgeReview : undefined;
  if (raw === true) return true;
  if (typeof raw === 'string') return raw === 'true' || raw === '1';
  return false;
}

// Knowledge storage location (repo/branch/path) for a team, for the Knowledge
// Flow storage control (#558). Local read mirror — api.js does not cross-require
// the orchestrator's knowledge-store. Secrets are never present on the stored
// shape (repoRef carries only credential *ids*, never the secret), so this is
// safe to return as-is. Defaults mirror KNOWLEDGE_BRANCH / DEFAULT_KB_PATH so an
// unconfigured team reports today's in-repo behaviour (AC-6).
const KB_DEFAULT_BRANCH = 'agent-knowledge';
const KB_DEFAULT_PATH = 'docs/agent-knowledge/';
function knowledgeStoreView(env) {
  const raw = env && typeof env.knowledgeStore === 'object' && env.knowledgeStore ? env.knowledgeStore : {};
  const mode = raw.mode === 'own-repo' ? 'own-repo' : 'in-repo';
  let pathVal = typeof raw.path === 'string' && raw.path.trim() !== '' ? raw.path.trim() : KB_DEFAULT_PATH;
  if (!pathVal.endsWith('/')) pathVal += '/';
  const ref = raw.repoRef && typeof raw.repoRef === 'object' ? raw.repoRef : null;
  const repoRef = ref && typeof ref.url === 'string' && ref.url.trim() !== '' ? {
    url: ref.url.trim(),
    branch: typeof ref.branch === 'string' ? ref.branch.trim() : '',
    sshKeyId: typeof ref.sshKeyId === 'string' ? ref.sshKeyId.trim() : '',
    githubTokenId: typeof ref.githubTokenId === 'string' ? ref.githubTokenId.trim() : '',
  } : null;
  const branch = (repoRef && repoRef.branch) || KB_DEFAULT_BRANCH;
  return { mode, path: pathVal, branch, repoRef };
}

// The team env's own repositories (url + branch + credential ids, no secrets),
// so the storage control can offer "the repo already used by this team" as the
// in-repo target and pre-fill its credentials.
function teamRepositories(env) {
  const repos = env && Array.isArray(env.repositories) ? env.repositories : [];
  return repos
    .filter((r) => r && typeof r.url === 'string' && r.url.trim() !== '')
    .map((r) => ({
      url: r.url.trim(),
      branch: typeof r.branch === 'string' ? r.branch.trim() : '',
      sshKeyId: typeof r.sshKeyId === 'string' ? r.sshKeyId.trim() : '',
    }));
}

// Promotion gate policy for a team (Phase 4) + its autonomy level, for the
// Knowledge Flow gate switches.
app.get('/api/knowledge/gates', (req, res) => {
  const scope = getScope(req);
  const teamId = typeof req.query.team === 'string' ? req.query.team : '';
  if (!AGENT_ID_RE.test(teamId)) return res.status(400).json({ error: 'team is required' });
  if (!knowledgeTeamVisible(scope, teamId)) return res.status(404).json({ error: 'not found' });
  // #570: knowledge config (autonomy / review / gates / storage) is keyed PER
  // TEAM, so overlay the team's own overrides onto its shared environment. Two
  // teams reusing one environment therefore report independent settings, and the
  // config is no longer "shared with" sibling teams (sharedWith is always empty).
  const env = teamKnowledgeEnv(teamId);
  res.json({
    team: teamId,
    autonomy: teamAutonomyLevel(env),
    review: knowledgeReviewOn(env),
    gates: knowledgeSuggestions.resolvePromotionGates(env),
    environment: env && env.id ? { id: env.id, name: env.name || env.id } : null,
    sharedWith: [],
    store: knowledgeStoreView(env),
    repositories: teamRepositories(env),
    githubTokenId: env && typeof env.githubTokenId === 'string' ? env.githubTokenId : '',
    decayHorizonDays: knowledgeSuggestions.resolveDecayHorizonDays(env), // #919
  });
});

// Set the per-team decay horizon (#919): after how many unused days the nightly
// sweep PROPOSES retiring a lesson (0 = off). Proxies the orchestrator's
// knowledge-config writer — the same per-team override file as autonomy/gates.
app.put('/api/knowledge/decay', apiLimiter, async (req, res) => {
  const scope = getScope(req);
  const teamId = typeof req.body?.teamId === 'string' ? req.body.teamId : '';
  const days = Number(req.body?.decayHorizonDays);
  if (!AGENT_ID_RE.test(teamId)) return res.status(400).json({ error: 'teamId is required' });
  if (!knowledgeTeamVisible(scope, teamId)) return res.status(403).json({ error: 'forbidden' });
  if (!Number.isInteger(days) || days < 0) return res.status(400).json({ error: 'decayHorizonDays must be a non-negative integer (0 = off)' });
  try {
    const r = await fetch(`${ORCH_URL()}/internal/knowledge/config`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ teamId, config: { decayHorizonDays: days } }),
    });
    const out = await r.json().catch(() => ({}));
    if (!r.ok || !out.ok) return res.status(502).json({ error: (out && out.error) || 'decay config update failed' });
    res.json({ ok: true, decayHorizonDays: days });
  } catch (err) {
    res.status(502).json({ error: `orchestrator unreachable: ${err.message}` });
  }
});

// Curation health (#919): the 30-day counters + silent-convergence status the
// nightly pass persists. `status:"unknown"` until the first pass has run.
app.get('/api/knowledge/curation-health', async (req, res) => {
  const scope = getScope(req);
  const teamId = typeof req.query.team === 'string' ? req.query.team : '';
  if (!AGENT_ID_RE.test(teamId)) return res.status(400).json({ error: 'team is required' });
  if (!knowledgeTeamVisible(scope, teamId)) return res.status(404).json({ error: 'not found' });
  try {
    const r = await fetch(`${ORCH_URL()}/internal/teams/${encodeURIComponent(teamId)}/knowledge/curation-health`);
    const out = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(502).json({ error: (out && out.error) || 'curation-health failed' });
    res.json(out);
  } catch (err) {
    res.status(502).json({ error: `orchestrator unreachable: ${err.message}` });
  }
});

// Flip one promotion transition between "auto" and "review" (the operator's one
// switch). Proxies to the orchestrator, the env-config writer.
app.put('/api/knowledge/gates', apiLimiter, async (req, res) => {
  const scope = getScope(req);
  const teamId = typeof req.body?.teamId === 'string' ? req.body.teamId : '';
  const transition = typeof req.body?.transition === 'string' ? req.body.transition : '';
  const mode = typeof req.body?.mode === 'string' ? req.body.mode : '';
  if (!AGENT_ID_RE.test(teamId)) return res.status(400).json({ error: 'teamId is required' });
  if (!knowledgeTeamVisible(scope, teamId)) return res.status(403).json({ error: 'forbidden' });
  if (!knowledgeSuggestions.PROMOTION_TRANSITIONS.includes(transition)) return res.status(400).json({ error: 'invalid transition' });
  if (!knowledgeSuggestions.GATE_MODES.includes(mode)) return res.status(400).json({ error: 'invalid mode' });
  try {
    const r = await fetch(`${ORCH_URL()}/internal/knowledge/gates`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ teamId, transition, mode }),
    });
    const out = await r.json().catch(() => ({}));
    if (!r.ok || !out.ok) return res.status(502).json({ error: (out && out.error) || 'gate update failed' });
    res.json({ ok: true, gates: out.gates });
  } catch (err) {
    res.status(502).json({ error: `orchestrator unreachable: ${err.message}` });
  }
});

// ── Skill domains (#780, skill-aggregation Phase 2) ─────────────────────────────
// The persistent domain taxonomy a team routes converged clusters against + the
// soft skill-budget state (both surfaced in the Knowledge UI). All logic + storage
// live in the orchestrator (knowledge-domains.js); these proxy to it.
const DOMAIN_OPS = new Set(['add', 'rename', 'merge', 'split', 'remove', 'confirm', 'seed', 'bootstrap']);

app.get('/api/knowledge/domains', async (req, res) => {
  const scope = getScope(req);
  const teamId = typeof req.query.team === 'string' ? req.query.team : '';
  if (!AGENT_ID_RE.test(teamId)) return res.status(400).json({ error: 'team is required' });
  if (!knowledgeTeamVisible(scope, teamId)) return res.status(404).json({ error: 'not found' });
  try {
    const r = await fetch(`${ORCH_URL()}/internal/knowledge/domains`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ teamId, op: 'read' }),
    });
    const out = await r.json().catch(() => ({}));
    if (!r.ok || !out.ok) return res.status(502).json({ error: (out && out.error) || 'domains read failed' });
    res.json({ team: teamId, doc: out.doc, budget: out.budget });
  } catch (err) {
    res.status(502).json({ error: `orchestrator unreachable: ${err.message}` });
  }
});

// Operator CRUD (rename/merge/split/add/remove) + seed/bootstrap/confirm. Domain
// changes are always a human decision, so this is a plain authenticated mutation.
app.post('/api/knowledge/domains', apiLimiter, async (req, res) => {
  const scope = getScope(req);
  const teamId = typeof req.body?.teamId === 'string' ? req.body.teamId : '';
  const op = typeof req.body?.op === 'string' ? req.body.op : '';
  if (!AGENT_ID_RE.test(teamId)) return res.status(400).json({ error: 'teamId is required' });
  if (!knowledgeTeamVisible(scope, teamId)) return res.status(403).json({ error: 'forbidden' });
  if (!DOMAIN_OPS.has(op)) return res.status(400).json({ error: 'invalid op' });
  // #1214: `bootstrap` is the only op that runs an LLM synthesis in the orchestrator,
  // so it must bill against the caller's header-selected assist provider (same 403/400
  // semantics as the nine console assist routes). We forward IDS ONLY over the internal
  // hop — the orchestrator reads the token locally from `_keys/`, so it never travels
  // the wire. Deterministic ops (add/rename/merge/…) skip enforcement entirely.
  let assistTarget = null;
  if (op === 'bootstrap') {
    assistTarget = resolveAssistTarget(req);
    if (assistTarget.selectionError) return sendAssistSelectionError(res, assistTarget);
    if (assistTarget.error) return res.status(400).json({ error: assistTarget.error });
  }
  try {
    const forward = { ...req.body, teamId, op };
    if (assistTarget && assistTarget.endpointId) {
      forward.assistEndpointId = assistTarget.endpointId; // env fallback (endpointId=null) → orchestrator uses .env
      forward.model = assistTarget.model;
    }
    const r = await fetch(`${ORCH_URL()}/internal/knowledge/domains`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(forward),
    });
    const out = await r.json().catch(() => ({}));
    if (!r.ok || !out.ok) return res.status(400).json({ error: (out && out.error) || 'domain op failed' });
    const payload = { ok: true, doc: out.doc, budget: out.budget, proposed: out.proposed, fallback: out.fallback };
    if (assistTarget) payload.meta = assistMeta(assistTarget); // "which key paid for this" (#1211 §4.5)
    res.json(payload);
  } catch (err) {
    res.status(502).json({ error: `orchestrator unreachable: ${err.message}` });
  }
});

// ── Distillation pass (#781 §3.4) ──────────────────────────────────────────────
// Re-synthesise a whole team skill. `apply:false` (default) previews old/new for a
// diff; `apply:true` writes only on a usable re-synthesis (LLM failure leaves the
// skill byte-identical). Proxies to the orchestrator (owns the skill files + LLM seam).
app.post('/api/knowledge/distill', apiLimiter, async (req, res) => {
  const scope = getScope(req);
  const teamId = typeof req.body?.teamId === 'string' ? req.body.teamId : '';
  const skill = typeof req.body?.skill === 'string' ? req.body.skill : '';
  const apply = req.body?.apply === true;
  if (!AGENT_ID_RE.test(teamId)) return res.status(400).json({ error: 'teamId is required' });
  if (!knowledgeTeamVisible(scope, teamId)) return res.status(403).json({ error: 'forbidden' });
  if (!skill) return res.status(400).json({ error: 'skill is required' });
  try {
    const r = await fetch(`${ORCH_URL()}/internal/knowledge/distill`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ teamId, skill, apply }),
    });
    const out = await r.json().catch(() => ({}));
    if (r.status === 404) return res.status(404).json({ error: (out && out.error) || 'skill not found' });
    if (!r.ok || !out.ok) return res.status(502).json({ error: (out && out.error) || 'distill failed' });
    res.json({ ok: true, changed: out.changed, reason: out.reason, skill: out.skill, old: out.old, new: out.new, entryCount: out.entryCount, mode: out.mode });
  } catch (err) {
    res.status(502).json({ error: `orchestrator unreachable: ${err.message}` });
  }
});

// ── Consolidation migration (#781 §4) ──────────────────────────────────────────
// Operator-driven, one-time-per-team, resumable. Ops: read | plan | start | advance
// | route-remaining. The actual per-domain synthesis + archive + atomic grant swap
// runs through POST /api/skills/merge (fed the `merge` inputs the `plan`/`start` ops
// return). Proxies to the orchestrator (owns the progress doc + corpus).
const CONSOLIDATION_OPS = new Set(['read', 'plan', 'start', 'advance', 'route-remaining']);
app.post('/api/knowledge/consolidation', apiLimiter, async (req, res) => {
  const scope = getScope(req);
  const teamId = typeof req.body?.teamId === 'string' ? req.body.teamId : '';
  const op = typeof req.body?.op === 'string' ? req.body.op : 'read';
  if (!AGENT_ID_RE.test(teamId)) return res.status(400).json({ error: 'teamId is required' });
  if (!knowledgeTeamVisible(scope, teamId)) return res.status(403).json({ error: 'forbidden' });
  if (!CONSOLIDATION_OPS.has(op)) return res.status(400).json({ error: 'invalid op' });
  try {
    const r = await fetch(`${ORCH_URL()}/internal/knowledge/consolidation`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...req.body, teamId, op }),
    });
    const out = await r.json().catch(() => ({}));
    if (!r.ok || !out.ok) return res.status(out.error && r.status === 400 ? 400 : 502).json({ error: (out && out.error) || 'consolidation op failed' });
    res.json({ ok: true, state: out.state, plan: out.plan, merges: out.merges });
  } catch (err) {
    res.status(502).json({ error: `orchestrator unreachable: ${err.message}` });
  }
});

// ── Autonomy dial (0..3) — the master human-in-control switch ──────────────────
// The Knowledge Flow page drives this: it turns the whole learning system Off /
// Share / Suggest / Auto-curate. Proxies to the orchestrator, the env-config
// writer. GET /api/knowledge/gates already returns the current level for display.
app.put('/api/knowledge/autonomy', apiLimiter, async (req, res) => {
  const scope = getScope(req);
  const teamId = typeof req.body?.teamId === 'string' ? req.body.teamId : '';
  const level = Number(req.body?.level);
  if (!AGENT_ID_RE.test(teamId)) return res.status(400).json({ error: 'teamId is required' });
  if (!knowledgeTeamVisible(scope, teamId)) return res.status(403).json({ error: 'forbidden' });
  if (!Number.isInteger(level) || level < 0 || level > 3) return res.status(400).json({ error: 'level must be an integer 0..3' });
  try {
    const r = await fetch(`${ORCH_URL()}/internal/knowledge/autonomy`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ teamId, level }),
    });
    const out = await r.json().catch(() => ({}));
    if (!r.ok || !out.ok) return res.status(502).json({ error: (out && out.error) || 'autonomy update failed' });
    res.json({ ok: true, autonomy: out.autonomy });
  } catch (err) {
    res.status(502).json({ error: `orchestrator unreachable: ${err.message}` });
  }
});

// ── Knowledge storage location (repo/branch/path), per team (#558) ──────────
// The Knowledge Flow storage control drives this. For a separate knowledge repo
// (own-repo) we first run the existing ls-remote probe (reachability + access)
// and REJECT an unreachable/unauthorized target before persisting (AC-2); in-repo
// only re-points branch/path within the team's already-validated env repo, so it
// needs no probe. Then proxies to the orchestrator, which normalizes, persists
// onto the shared env, and refreshes the canonical clone at the NEW location
// (AC-4/AC-7). Knowledge already stored at the old location is left in place
// (AC-5 — the UI confirms this before calling).
app.put('/api/knowledge/store', apiLimiter, async (req, res) => {
  const scope = getScope(req);
  const teamId = typeof req.body?.teamId === 'string' ? req.body.teamId : '';
  if (!AGENT_ID_RE.test(teamId)) return res.status(400).json({ error: 'teamId is required' });
  if (!knowledgeTeamVisible(scope, teamId)) return res.status(403).json({ error: 'forbidden' });

  const input = req.body?.store && typeof req.body.store === 'object' ? req.body.store : {};
  const mode = input.mode === 'own-repo' ? 'own-repo' : 'in-repo';
  const ref = input.repoRef && typeof input.repoRef === 'object' ? input.repoRef : {};
  const url = typeof ref.url === 'string' ? ref.url.trim() : '';
  const branch = typeof input.branch === 'string' ? input.branch.trim() : '';
  const kbPath = typeof input.path === 'string' ? input.path.trim() : '';
  const sshKeyId = typeof ref.sshKeyId === 'string' ? ref.sshKeyId.trim() : '';
  const githubTokenId = typeof ref.githubTokenId === 'string' ? ref.githubTokenId.trim() : '';

  if (mode === 'own-repo' && !url) {
    return res.status(400).json({ error: 'a separate knowledge repository requires a repo URL' });
  }
  if (sshKeyId) {
    if (!SSH_KEY_ID_RE.test(sshKeyId)) return res.status(400).json({ error: 'invalid SSH key id' });
    if (!listSshKeys().some((k) => k.id === sshKeyId)) return res.status(400).json({ error: `SSH key '${sshKeyId}' not found` });
  }
  if (githubTokenId) {
    if (!GH_TOKEN_ID_RE.test(githubTokenId)) return res.status(400).json({ error: 'invalid GitHub token id' });
    if (!listGithubTokens().some((t) => t.id === githubTokenId)) return res.status(400).json({ error: `GitHub token '${githubTokenId}' not found` });
  }

  // AC-2: reachability + access probe for a separate knowledge repo.
  if (mode === 'own-repo') {
    try {
      const probe = await fetch(`${ORCH_URL()}/internal/repository-check`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, sshKeyId: sshKeyId || null, githubTokenId: githubTokenId || null }),
      });
      const pr = await probe.json().catch(() => ({}));
      if (!probe.ok || !pr.ok) {
        return res.status(400).json({ error: (pr && pr.error) || 'knowledge repository is not reachable', probe: pr });
      }
    } catch (err) {
      return res.status(502).json({ error: `repository probe failed: ${err.message}` });
    }
  }

  try {
    const r = await fetch(`${ORCH_URL()}/internal/knowledge/store`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        teamId,
        store: { mode, path: kbPath, branch, repoRef: { url, sshKeyId, githubTokenId } },
      }),
    });
    const out = await r.json().catch(() => ({}));
    if (!r.ok || !out.ok) return res.status(502).json({ error: (out && out.error) || 'store update failed' });
    res.json({ ok: true, store: out.store, warnings: out.warnings || [] });
  } catch (err) {
    res.status(502).json({ error: `orchestrator unreachable: ${err.message}` });
  }
});

// ── Supervised-review toggle ────────────────────────────────────────────────
// When on, newly-learned facts are HELD for human approval before they enter the
// shared team KB (see GET /api/knowledge/review-queue). Proxies to the orchestrator.
app.put('/api/knowledge/review-mode', apiLimiter, async (req, res) => {
  const scope = getScope(req);
  const teamId = typeof req.body?.teamId === 'string' ? req.body.teamId : '';
  if (!AGENT_ID_RE.test(teamId)) return res.status(400).json({ error: 'teamId is required' });
  if (!knowledgeTeamVisible(scope, teamId)) return res.status(403).json({ error: 'forbidden' });
  const enabled = req.body?.enabled === true || req.body?.enabled === 'true';
  try {
    const r = await fetch(`${ORCH_URL()}/internal/knowledge/review-mode`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ teamId, enabled }),
    });
    const out = await r.json().catch(() => ({}));
    if (!r.ok || !out.ok) return res.status(502).json({ error: (out && out.error) || 'review-mode update failed' });
    res.json({ ok: true, review: out.review });
  } catch (err) {
    res.status(502).json({ error: `orchestrator unreachable: ${err.message}` });
  }
});

// ── Review queue — facts held for human approval before entering the shared KB ──
// Returns the pending (and, with ?include=rejected, rejected) entries for a team,
// each with the same provenance the drill-down uses, so the operator can judge a
// fact before letting it into the team's knowledge. Empty unless the team runs in
// supervised-review mode. Membership-scoped like the other knowledge reads.
app.get('/api/knowledge/review-queue', async (req, res) => {
  const scope = getScope(req);
  const teamId = typeof req.query.team === 'string' ? req.query.team : '';
  if (!AGENT_ID_RE.test(teamId)) return res.status(400).json({ error: 'team is required' });
  if (!knowledgeTeamVisible(scope, teamId)) return res.status(404).json({ error: 'not found' });
  await refreshTeamCloneBestEffort(teamId);
  const { entries, warnings } = gatherTeamEntries(teamId);
  const only = req.query.include === 'rejected' ? null : 'pending';
  const items = selectReviewQueue(entries, { only });
  res.json({ team: teamId, review: knowledgeReviewOn(teamKnowledgeEnv(teamId)), items, warnings }); // #570: per-team config
});

// ── Approve / reject / reset a held KB entry ────────────────────────────────
app.post('/api/knowledge/item/:id/review', apiLimiter, async (req, res) => {
  const scope = getScope(req);
  const teamId = typeof req.body?.teamId === 'string' ? req.body.teamId : '';
  const id = typeof req.params.id === 'string' ? req.params.id : '';
  const decision = typeof req.body?.decision === 'string' ? req.body.decision : '';
  if (!AGENT_ID_RE.test(teamId)) return res.status(400).json({ error: 'teamId is required' });
  if (!knowledgeTeamVisible(scope, teamId)) return res.status(403).json({ error: 'forbidden' });
  if (!/^[0-9a-f]{12}$/.test(id)) return res.status(400).json({ error: 'invalid id' });
  if (!['approved', 'rejected', 'reset'].includes(decision)) return res.status(400).json({ error: 'invalid decision' });
  try {
    const r = await fetch(`${ORCH_URL()}/internal/knowledge/review`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ teamId, id, decision }),
    });
    const out = await r.json().catch(() => ({}));
    if (!r.ok || !out.ok) return res.status(502).json({ error: (out && out.error) || 'review update failed' });
    res.json({ ok: true, id, decision });
  } catch (err) {
    res.status(502).json({ error: `orchestrator unreachable: ${err.message}` });
  }
});

// ── Directed cross-team sharing — route a learned skill sideways ───────────────
// A human copies an existing skill from the global pool (or one team's pool) into
// ANOTHER team's pool, so knowledge learned in one stage/team reaches another
// directly (not only via broadcast-to-global). Always operator-initiated;
// provenance is preserved + stamped with the lateral share.
app.post('/api/knowledge/share-to-team', apiLimiter, async (req, res) => {
  const scope = getScope(req);
  const v = knowledgeSuggestions.validateShareToTeam(req.body, { teamIdRe: AGENT_ID_RE });
  if (!v.ok) return res.status(400).json({ error: v.error });
  if (!knowledgeTeamVisible(scope, v.targetTeamId)) return res.status(403).json({ error: 'forbidden (target team)' });
  if (v.from === 'team' && !knowledgeTeamVisible(scope, v.sourceTeamId)) return res.status(403).json({ error: 'forbidden (source team)' });

  // Resolve the source skill dir (containment-guarded), read SKILL.md + provenance.
  let srcDir;
  if (v.from === 'team') {
    srcDir = safeTeamSkillDir(v.sourceTeamId, v.name);
    if (!srcDir) return res.status(400).json({ error: 'invalid source team or skill name' });
  } else {
    srcDir = safeGlobalSkillDir(v.name);
    if (!srcDir) return res.status(400).json({ error: 'invalid skill name' });
  }
  const srcSkill = path.join(srcDir, 'SKILL.md');
  if (!fs.existsSync(srcSkill)) return res.status(404).json({ error: `skill '${v.name}' not found in the ${v.from} source` });

  const dstDir = safeTeamSkillDir(v.targetTeamId, v.name);
  if (!dstDir) return res.status(400).json({ error: 'invalid target team or skill name' });
  const dstExists = fs.existsSync(path.join(dstDir, 'SKILL.md'));
  const wp = skillTransfer.planSkillWrite({ onCollision: req.body.overwrite ? 'overwrite' : 'reject', exists: dstExists });
  if (!wp.ok) return res.status(409).json({ error: `Skill '${v.name}' already exists in team '${v.targetTeamId}'`, exists: true });

  const sharedBy = (req.user && (req.user.sub || req.user.username)) || 'operator';
  const prov = knowledgeSuggestions.buildShareProvenance({
    from: v.from, sourceTeamId: v.sourceTeamId, targetTeamId: v.targetTeamId, name: v.name,
    sourceProvenance: readSkillProvenance(srcDir), sharedBy,
  });
  const shareSrcId = skillSourceIdentity(srcDir);
  // #639: a lateral share now copies the FULL skill directory (copyFrom: srcDir)
  // — SKILL.md rides along unchanged (same content as before), plus any extra
  // files the skill carries. The share-specific provenance override is written
  // AFTER the copy so it replaces the dragged-along provenance.json; the stamp is
  // a fresh copy (mode 'copy') recording where it came from (#625).
  const wrote = commitSkillWrite({
    destDir: dstDir,
    overwrite: wp.overwrite,
    copyFrom: srcDir,
    provenance: prov,
    stamp: {
      mode: 'copy', name: v.name, by: skillActor(req), action: 'shared',
      origin: skillOrigin({ tier: v.from, teamId: v.from === 'team' ? v.sourceTeamId : undefined, sourceVersion: shareSrcId.sourceVersion, sourceHash: shareSrcId.sourceHash }),
    },
  });
  if (wrote.error) return res.status(500).json({ error: `Failed to write shared skill: ${wrote.error}` });
  res.status(201).json({ name: v.name, tier: 'team', teamId: v.targetTeamId, from: v.from, sourceTeamId: v.sourceTeamId, provenance: prov });
});

/* ─── Unified orchestration graph (Unified Orchestration #362 / #365) ───────
 * One graph over the live orchestration concept, via the pure builder in
 * unified-graph.js:
 *   - live: live agents → process-style nodes (label/timer/review/event edges).
 *     Optional ?team=<id> scope. Persisted emits only (no silent derivation,
 *     unless ?derive=1).
 * Shape is { unifiedFlowVersion, source, nodes, edges, gates, labels, lints }.
 *
 * The second source — `?workspace=<path>`, a read-only projection of a
 * BriefingPack directory fetched from bp-explorer — was removed in #1965
 * (epic #1961 Phase 4) along with the Flows page's BP listing that was its only
 * caller. `?workspace=` is now simply an unknown query parameter: the live
 * branch below runs, exactly as it does for any other unrecognised param. */
app.get('/api/flows/graph', async (req, res) => {
  // Live source — agents as unified nodes (data-flow ports empty for now).
  const team = typeof req.query.team === 'string' && req.query.team.trim()
    ? req.query.team.trim() : null;
  if (team && !AGENT_ID_RE.test(team)) return res.status(400).json({ error: 'Invalid team id' });

  const nodes = [];
  for (const id of listAgentDirs()) {
    const cfg = readJsonFile(path.join(AGENTS_DIR, id, 'config.json'), {});
    const role = cfg.role || 'agent';
    if (role === 'team') continue; // template holder — no triggers of its own
    if (team && cfg.parentTeamId !== team) continue;
    const raw = readJsonFile(controlOrAgentPath(id, 'triggers.json'), []);
    const triggers = Array.isArray(raw) ? raw : [];
    // Data-flow ports persisted at materialise time (#379) so the live graph
    // of an imported team still renders its dependency/artifact edges.
    const df = cfg.dataFlow && typeof cfg.dataFlow === 'object' ? cfg.dataFlow : {};
    nodes.push({
      id, role, displayName: cfg.displayName || id,
      sessionPolicy: cfg.sessionPolicy || 'persistent',
      environmentId: cfg.environmentId || null, triggers,
      // Agent-level label hand-offs, lifting any legacy trigger-level emit (AC8).
      emits: liftAgentEmits(cfg.emits, triggers),
      outcomes: cfg.outcomes || null, // structured OUTCOMES port (#827), supersedes emits
      inputs: Array.isArray(df.inputs) ? df.inputs : [],
      outputs: Array.isArray(df.outputs) ? df.outputs : [],
      dependsOn: Array.isArray(df.dependsOn) ? df.dependsOn : [],
      parent: typeof cfg.parentMemberId === 'string' ? cfg.parentMemberId : null,
      content: readAgentSystemPrompt(id), // expandable prompt in the unified viewer
      stage: typeof cfg.stage === 'string' ? cfg.stage : '',
      // GitHub artifact ports (#380): produce flags + consumed channels.
      github: cfg.github || null,
      channels: Array.isArray(cfg.channels) ? cfg.channels : [],
    });
  }
  // Ordered stage names persisted on the team agent (#stage-order) drive the
  // client's layered layout, so a materialised draft keeps its stage columns.
  let stages = [];
  if (team) {
    const teamCfg = readJsonFile(path.join(AGENTS_DIR, team, 'config.json'), {});
    if (Array.isArray(teamCfg.stages)) stages = teamCfg.stages.filter(s => typeof s === 'string');
  }
  const teamHumans = teamHumansRegistry(team);
  res.json({
    unifiedFlowVersion: 1, source: 'live', team, stages, humans: teamHumans,
    ...buildUnifiedGraph(nodes, undefined, { labels: teamLabelRegistry(team), humans: teamHumans }),
  });
});

// GET /api/teams/:teamId/flow-anomalies — observe-only stall detection (#959).
// Team-scoped proxy to the orchestrator's deterministic detector; the anomaly
// panel in the Flows view renders the result. Read-only, no repair.
app.get('/api/teams/:teamId/flow-anomalies', apiLimiter, async (req, res) => {
  const teamId = req.params.teamId;
  if (!AGENT_ID_RE.test(teamId)) return res.status(400).json({ error: 'Invalid team id' });
  const scope = getScope(req);
  if (!visibleTeam(scope, teamId)) return res.status(404).json({ error: 'Team not found' });
  try {
    const resp = await fetch(`${ORCH_URL()}/internal/teams/${encodeURIComponent(teamId)}/flow-anomalies`);
    const data = await resp.json().catch(() => ({}));
    return res.status(resp.status).json(data);
  } catch (err) {
    return res.status(502).json({ error: `Orchestrator unreachable: ${err.message}` });
  }
});

// GET /api/teams/:teamId/tickets — the ticket ledger (#2115, flow-control
// concept §4.1). Team-scoped read-only proxy to the orchestrator's reconciler,
// which derives each work item's TRUE lifecycle state from GitHub evidence and
// names the blocker holding it. Observe-only — no repair, no mutation — so it is
// gated exactly like `flow-anomalies`: visibility only, no `canManageTeam`.
app.get('/api/teams/:teamId/tickets', apiLimiter, async (req, res) => {
  const teamId = req.params.teamId;
  if (!AGENT_ID_RE.test(teamId)) return res.status(400).json({ error: 'Invalid team id' });
  const scope = getScope(req);
  if (!visibleTeam(scope, teamId)) return res.status(404).json({ error: 'Team not found' });
  try {
    const resp = await fetch(`${ORCH_URL()}/internal/teams/${encodeURIComponent(teamId)}/tickets`);
    const data = await resp.json().catch(() => ({}));
    return res.status(resp.status).json(data);
  } catch (err) {
    return res.status(502).json({ error: `Orchestrator unreachable: ${err.message}` });
  }
});

// GET /api/teams/:teamId/hill-climb/metrics — latest persisted run-metrics
// snapshot (hill-climbing loop Phase 1, #1222). Team-scoped read-only proxy;
// the Improvements panel (#1223) renders the metric tiles from this.
app.get('/api/teams/:teamId/hill-climb/metrics', apiLimiter, async (req, res) => {
  const teamId = req.params.teamId;
  if (!AGENT_ID_RE.test(teamId)) return res.status(400).json({ error: 'Invalid team id' });
  const scope = getScope(req);
  if (!visibleTeam(scope, teamId)) return res.status(404).json({ error: 'Team not found' });
  try {
    const resp = await fetch(`${ORCH_URL()}/internal/teams/${encodeURIComponent(teamId)}/hill-climb/metrics`);
    const data = await resp.json().catch(() => ({}));
    return res.status(resp.status).json(data);
  } catch (err) {
    return res.status(502).json({ error: `Orchestrator unreachable: ${err.message}` });
  }
});

// POST /api/teams/:teamId/hill-climb/run — manual pass (#1222 metrics + #1224
// analyst). Same code path as the daily scheduled pass; a run while one is
// already in flight returns 409 pass-running. Team-scoped + audited.
//
// The orchestrator pass computes the metrics snapshot AND folds the deterministic
// heuristic improvement cards into the store (the honest fallback), returning a
// secret-free `digest`. When the team's autonomy dial is ≥ 1 and a Model Provider
// resolves for this caller, we then run the server-side one-shot analyst
// (`resolveAssistTarget` — skips oauth-token providers, same discipline as
// port-suggestion) over that digest and hand any validated cards back to the
// orchestrator's merge endpoint, which re-validates + merges them under the
// budget rules. If no provider resolves or the LLM fails, the heuristic cards
// still stand — the pass is never blocked on the analyst. Cards are proposals only.
app.post('/api/teams/:teamId/hill-climb/run', apiLimiter, async (req, res) => {
  const teamId = req.params.teamId;
  if (!AGENT_ID_RE.test(teamId)) return res.status(400).json({ error: 'Invalid team id' });
  const scope = getScope(req);
  if (!visibleTeam(scope, teamId)) return res.status(404).json({ error: 'Team not found' });
  try {
    const resp = await fetch(`${ORCH_URL()}/internal/teams/${encodeURIComponent(teamId)}/hill-climb/run`, {
      method: 'POST',
    });
    const data = await resp.json().catch(() => ({}));
    if (resp.status !== 200 || data.maintenance || !data.digest || (data.autonomy != null && data.autonomy < 1)) {
      return res.status(resp.status).json(data);
    }
    // Server-side analyst step (#1224). A selection error (403/400) surfaces so
    // the picker can nudge; a soft/misconfigured target quietly keeps heuristics.
    const target = resolveAssistTarget(req);
    if (target.selectionError) return res.status(resp.status).json({ ...data, analyst: 'skipped' });
    if (target.error) return res.status(resp.status).json({ ...data, analyst: 'no-provider' });
    let analyst = 'no-cards';
    try {
      const url = buildMessagesUrl(target.baseUrl);
      const headers = {
        'anthropic-version': '2023-06-01',
        ...(target.token ? { Authorization: `Bearer ${target.token}`, 'x-api-key': target.token } : {}),
      };
      const payload = { model: target.model, ...buildHillClimbAnalystRequest(data.digest) };
      const result = await httpPostJson(url, headers, payload);
      if (!result.error && result.status >= 200 && result.status < 300) {
        const cards = parseHillClimbCards(extractMessageText(result.body));
        if (cards.length) {
          const mergeResp = await fetch(`${ORCH_URL()}/internal/teams/${encodeURIComponent(teamId)}/hill-climb/cards/merge`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cards }),
          });
          const merged = await mergeResp.json().catch(() => ({}));
          if (mergeResp.status === 200) {
            return res.status(200).json({ ...data, cards: merged.cards, analystMerge: merged.merge, analyst: 'llm', meta: assistMeta(target) });
          }
        }
      }
    } catch { /* analyst failure → heuristic cards already stand */ }
    return res.status(resp.status).json({ ...data, analyst });
  } catch (err) {
    return res.status(502).json({ error: `Orchestrator unreachable: ${err.message}` });
  }
});

// GET /api/teams/:teamId/hill-climb/cards — the persisted improvement cards
// (#1224). Team-scoped read-only proxy; the Improvements panel (#1223) renders
// the open cards + closed ledger from this.
app.get('/api/teams/:teamId/hill-climb/cards', apiLimiter, async (req, res) => {
  const teamId = req.params.teamId;
  if (!AGENT_ID_RE.test(teamId)) return res.status(400).json({ error: 'Invalid team id' });
  const scope = getScope(req);
  if (!visibleTeam(scope, teamId)) return res.status(404).json({ error: 'Team not found' });
  try {
    const resp = await fetch(`${ORCH_URL()}/internal/teams/${encodeURIComponent(teamId)}/hill-climb/cards`);
    const data = await resp.json().catch(() => ({}));
    return res.status(resp.status).json(data);
  } catch (err) {
    return res.status(502).json({ error: `Orchestrator unreachable: ${err.message}` });
  }
});

// POST /api/teams/:teamId/hill-climb/cards/:cardId/dismiss — dismiss a card
// (#1224) so it is not re-raised. Team-scoped + audited. Card-state only — no
// apply path runs in this ticket.
app.post('/api/teams/:teamId/hill-climb/cards/:cardId/dismiss', apiLimiter, async (req, res) => {
  const teamId = req.params.teamId;
  const cardId = req.params.cardId;
  if (!AGENT_ID_RE.test(teamId)) return res.status(400).json({ error: 'Invalid team id' });
  const scope = getScope(req);
  if (!visibleTeam(scope, teamId)) return res.status(404).json({ error: 'Team not found' });
  try {
    const resp = await fetch(`${ORCH_URL()}/internal/teams/${encodeURIComponent(teamId)}/hill-climb/cards/${encodeURIComponent(cardId)}/dismiss`, {
      method: 'POST',
    });
    const data = await resp.json().catch(() => ({}));
    return res.status(resp.status).json(data);
  } catch (err) {
    return res.status(502).json({ error: `Orchestrator unreachable: ${err.message}` });
  }
});

// POST /api/teams/:teamId/hill-climb/cards/:cardId/apply — the gated applier
// (#1225, concept §3.3). Runs a card's declared apply path through an existing
// audited console choke-point *as the acting human* (this endpoint is itself a
// mutating /api call, so `audit.auditMutations` records it under req.user; for a
// prompt change the choke-point also stamps `.agent-studio/prompt-history.json`), then
// asks the orchestrator to record the applied card (timestamp + config-version
// reference + baseline snapshot + undo payload) for #1226 to measure.
//
// Gates, all server-side so a direct API call can't bypass them: autonomy 2
// required (0/1 deny); only an open card applies; only executable classes apply
// (trigger-hygiene is wired first — DELETE /api/agents/:id/triggers/:tid); the
// trigger guard rejects intrinsic/derived/human-gate triggers; and a card whose
// target trigger changed since detection is refused with 409 stale-card.
app.post('/api/teams/:teamId/hill-climb/cards/:cardId/apply', apiLimiter, async (req, res) => {
  const teamId = req.params.teamId;
  const cardId = req.params.cardId;
  if (!AGENT_ID_RE.test(teamId)) return res.status(400).json({ error: 'Invalid team id' });
  const scope = getScope(req);
  if (!visibleTeam(scope, teamId)) return res.status(404).json({ error: 'Team not found' });

  // 1) Pull the card + the team's autonomy from the store (the orchestrator is
  //    the authority on both).
  let cards; let autonomy;
  try {
    const resp = await fetch(`${ORCH_URL()}/internal/teams/${encodeURIComponent(teamId)}/hill-climb/cards`);
    const data = await resp.json().catch(() => ({}));
    if (resp.status !== 200) return res.status(resp.status).json(data);
    cards = Array.isArray(data.cards) ? data.cards : [];
    autonomy = data.autonomy;
  } catch (err) {
    return res.status(502).json({ error: `Orchestrator unreachable: ${err.message}` });
  }
  const card = cards.find(c => c && c.id === cardId);
  if (!card) return res.status(404).json({ error: 'card not found' });
  // Autonomy 0/1 deny apply (not merely hide it).
  if (!(autonomy >= 2)) {
    return res.status(403).json({ error: 'autonomy-locked', code: 'autonomy-locked', autonomy });
  }
  if (card.status !== 'open') {
    return res.status(409).json({ error: 'card-not-open', code: 'card-not-open', status: card.status });
  }
  if (!hillClimbApplyGuard.isExecutableClass(card.class)) {
    return res.status(422).json({
      error: 'card-not-applicable', code: 'card-not-applicable', class: card.class,
      message: `apply for '${card.class}' cards is not wired yet — only trigger-hygiene applies in this release`,
    });
  }

  // 2) trigger-hygiene apply path: DELETE /api/agents/:id/triggers/:tid.
  const ref = hillClimbApplyGuard.parseTriggerRef(card);
  if (!ref || !AGENT_ID_RE.test(ref.agentId)) {
    return res.status(422).json({ error: 'card does not name a valid trigger', code: 'card-not-applicable' });
  }
  const agentDir = path.join(AGENTS_DIR, ref.agentId);
  const agentCfg = readJsonFile(path.join(agentDir, 'config.json'), null);
  // The card's target must still be a live member of this team (else re-detect).
  if (!agentCfg || (agentCfg.parentTeamId !== teamId && ref.agentId !== teamId)) {
    return res.status(409).json({ error: 'stale-card', code: 'stale-card', reason: `agent '${ref.agentId}' is not a live member of this team — re-detect first` });
  }
  // Config-write authorization (#989): deleting a trigger is a management action.
  if (denyUnlessCanManageAgent(req, res, agentDir)) return;

  const triggers = readJsonFile(controlOrAgentPath(ref.agentId, 'triggers.json'), []);
  const liveTrigger = (Array.isArray(triggers) ? triggers : []).find(t => t && t.id === ref.triggerId) || null;
  // Staleness: the target trigger must still exist (AC 409 stale-card).
  const staleReason = hillClimbApplyGuard.staleTriggerReason(card, liveTrigger);
  if (staleReason) {
    return res.status(409).json({ error: 'stale-card', code: 'stale-card', reason: staleReason });
  }
  // Guard: never delete an intrinsic/derived/human-gate trigger (AC).
  const teamCfg = readJsonFile(path.join(AGENTS_DIR, teamId, 'config.json'), null);
  const guardReason = hillClimbApplyGuard.triggerApplyGuardError(liveTrigger, {
    humanGateLabels: hillClimbApplyGuard.humanGateLabelSet(teamCfg),
  });
  if (guardReason) {
    return res.status(403).json({ error: 'protected-trigger', code: 'protected-trigger', reason: guardReason });
  }

  // 3) Execute the mutation through the shared choke-point (audited under
  //    req.user via the mounted auditMutations middleware).
  let deletedTrigger;
  try {
    deletedTrigger = await deleteAgentTrigger(ref.agentId, ref.triggerId);
  } catch (err) {
    return res.status(502).json({ error: `Could not delete trigger: ${err.message}` });
  }

  // 4) Record the applied card (undo payload = the deleted trigger JSON).
  const appliedBy = (req.user && (req.user.sub || req.user.username)) || 'operator';
  const undo = { kind: 'restore-trigger', agentId: ref.agentId, trigger: deletedTrigger };
  const configVersionRef = { kind: 'trigger-delete', agentId: ref.agentId, triggerId: ref.triggerId, at: new Date().toISOString() };
  try {
    const resp = await fetch(`${ORCH_URL()}/internal/teams/${encodeURIComponent(teamId)}/hill-climb/cards/${encodeURIComponent(cardId)}/apply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appliedBy, undo, configVersionRef }),
    });
    const data = await resp.json().catch(() => ({}));
    if (resp.status !== 200) {
      // The mutation succeeded but the card couldn't be marked — surface it
      // honestly so the operator knows the trigger is already gone.
      return res.status(502).json({ error: 'applied-not-recorded', code: 'applied-not-recorded', applied: true, deletedTrigger, recordStatus: resp.status, recordError: data.error });
    }
    return res.status(200).json({ teamId, applied: true, card: data.card, deletedTrigger });
  } catch (err) {
    return res.status(502).json({ error: 'applied-not-recorded', code: 'applied-not-recorded', applied: true, deletedTrigger, recordError: err.message });
  }
});

// POST /api/teams/:teamId/hill-climb/cards/:cardId/rollback — the rollback
// applier (#1226, concept §6). A regressed card carries a rollback plan; this
// runs its undo path through the SAME existing audited console choke-point as
// the apply (so `audit.auditMutations` records the reversal under req.user),
// then asks the orchestrator to mark the card rolled-back with a fresh cooldown.
// A rollback is always a human click — never auto-reverted (§6).
//
// Gates mirror the apply route, all server-side: autonomy 2 required (0/1 deny);
// only a `regressed` card rolls back; only executable plan kinds run
// (restore-trigger is wired first — re-creates the retained trigger JSON through
// the trigger choke-point). Non-wired kinds (prompt-revert / restore-port /
// restore-value) are refused rather than half-reverted, exactly as apply refuses
// their apply paths.
app.post('/api/teams/:teamId/hill-climb/cards/:cardId/rollback', apiLimiter, async (req, res) => {
  const teamId = req.params.teamId;
  const cardId = req.params.cardId;
  if (!AGENT_ID_RE.test(teamId)) return res.status(400).json({ error: 'Invalid team id' });
  const scope = getScope(req);
  if (!visibleTeam(scope, teamId)) return res.status(404).json({ error: 'Team not found' });

  // 1) Pull the card + autonomy from the store (the orchestrator is authority).
  let cards; let autonomy;
  try {
    const resp = await fetch(`${ORCH_URL()}/internal/teams/${encodeURIComponent(teamId)}/hill-climb/cards`);
    const data = await resp.json().catch(() => ({}));
    if (resp.status !== 200) return res.status(resp.status).json(data);
    cards = Array.isArray(data.cards) ? data.cards : [];
    autonomy = data.autonomy;
  } catch (err) {
    return res.status(502).json({ error: `Orchestrator unreachable: ${err.message}` });
  }
  const card = cards.find(c => c && c.id === cardId);
  if (!card) return res.status(404).json({ error: 'card not found' });
  if (!(autonomy >= 2)) {
    return res.status(403).json({ error: 'autonomy-locked', code: 'autonomy-locked', autonomy });
  }
  if (card.status !== 'regressed') {
    return res.status(409).json({ error: 'card-not-regressed', code: 'card-not-regressed', status: card.status });
  }
  const plan = card.rollback && card.rollback.plan ? card.rollback.plan : null;
  if (!plan || !plan.kind) {
    return res.status(422).json({ error: 'no-rollback-plan', code: 'no-rollback-plan' });
  }

  // 2) Execute the rollback plan. Only restore-trigger is wired in this release
  //    (mirrors the applier's executable-class discipline).
  let undoResult = null;
  if (plan.kind === 'restore-trigger') {
    if (!plan.agentId || !AGENT_ID_RE.test(plan.agentId) || !plan.trigger || !plan.trigger.id) {
      return res.status(422).json({ error: 'rollback-plan-incomplete', code: 'rollback-plan-incomplete' });
    }
    const agentDir = path.join(AGENTS_DIR, plan.agentId);
    const agentCfg = readJsonFile(path.join(agentDir, 'config.json'), null);
    if (!agentCfg || (agentCfg.parentTeamId !== teamId && plan.agentId !== teamId)) {
      return res.status(409).json({ error: 'stale-card', code: 'stale-card', reason: `agent '${plan.agentId}' is not a live member of this team` });
    }
    // Config-write authorization (#989): re-creating a trigger is a management action.
    if (denyUnlessCanManageAgent(req, res, agentDir)) return;
    try {
      const restored = await restoreAgentTrigger(plan.agentId, plan.trigger);
      undoResult = { kind: 'restore-trigger', agentId: plan.agentId, triggerId: restored.id };
    } catch (err) {
      return res.status(502).json({ error: `Could not restore trigger: ${err.message}` });
    }
  } else {
    return res.status(422).json({
      error: 'rollback-not-applicable', code: 'rollback-not-applicable', kind: plan.kind,
      message: `rollback for '${plan.kind}' is not wired yet — only restore-trigger rolls back in this release`,
    });
  }

  // 3) Record the rolled-back card (fresh cooldown so the object re-enters
  //    detection only after a full window).
  const rolledBackBy = (req.user && (req.user.sub || req.user.username)) || 'operator';
  try {
    const resp = await fetch(`${ORCH_URL()}/internal/teams/${encodeURIComponent(teamId)}/hill-climb/cards/${encodeURIComponent(cardId)}/rollback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rolledBackBy, undoResult }),
    });
    const data = await resp.json().catch(() => ({}));
    if (resp.status !== 200) {
      return res.status(502).json({ error: 'rolled-back-not-recorded', code: 'rolled-back-not-recorded', rolledBack: true, undoResult, recordStatus: resp.status, recordError: data.error });
    }
    return res.status(200).json({ teamId, rolledBack: true, card: data.card, undoResult });
  } catch (err) {
    return res.status(502).json({ error: 'rolled-back-not-recorded', code: 'rolled-back-not-recorded', rolledBack: true, undoResult, recordError: err.message });
  }
});

// GET /api/teams/:teamId/members — running/busy/trigger state for every
// member, feeding the team-wide disable/enable preview dialog.
app.get('/api/teams/:teamId/members', apiLimiter, async (req, res) => {
  const teamId = req.params.teamId;
  if (!AGENT_ID_RE.test(teamId)) return res.status(400).json({ error: 'Invalid team id' });
  const scope = getScope(req);
  if (!visibleTeam(scope, teamId)) return res.status(404).json({ error: 'Team not found' });
  try {
    const resp = await fetch(`${ORCH_URL()}/internal/teams/${encodeURIComponent(teamId)}/members`);
    const data = await resp.json().catch(() => ({}));
    return res.status(resp.status).json(data);
  } catch (err) {
    return res.status(502).json({ error: `Orchestrator unreachable: ${err.message}` });
  }
});

// POST /api/teams/:teamId/disable — bulk-disable every enabled member.
// Body: { mode: 'drain' | 'abort' }, required.
app.post('/api/teams/:teamId/disable', apiLimiter, async (req, res) => {
  const teamId = req.params.teamId;
  if (!AGENT_ID_RE.test(teamId)) return res.status(400).json({ error: 'Invalid team id' });
  const scope = getScope(req);
  if (!visibleTeam(scope, teamId)) return res.status(404).json({ error: 'Team not found' });
  const mode = req.body?.mode;
  if (mode !== 'drain' && mode !== 'abort') return res.status(400).json({ error: "mode must be 'drain' or 'abort'" });
  try {
    const resp = await fetch(`${ORCH_URL()}/internal/teams/${encodeURIComponent(teamId)}/disable`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode }),
    });
    const data = await resp.json().catch(() => ({}));
    return res.status(resp.status).json(data);
  } catch (err) {
    return res.status(502).json({ error: `Orchestrator unreachable: ${err.message}` });
  }
});

// POST /api/teams/:teamId/enable — bulk-enable every member the earlier
// disable tagged disabledByTeam.
app.post('/api/teams/:teamId/enable', apiLimiter, async (req, res) => {
  const teamId = req.params.teamId;
  if (!AGENT_ID_RE.test(teamId)) return res.status(400).json({ error: 'Invalid team id' });
  const scope = getScope(req);
  if (!visibleTeam(scope, teamId)) return res.status(404).json({ error: 'Team not found' });
  try {
    const resp = await fetch(`${ORCH_URL()}/internal/teams/${encodeURIComponent(teamId)}/enable`, { method: 'POST' });
    const data = await resp.json().catch(() => ({}));
    return res.status(resp.status).json(data);
  } catch (err) {
    return res.status(502).json({ error: `Orchestrator unreachable: ${err.message}` });
  }
});

/* Derive a unified graph from a draft/imported bundle (#367) — the editable
 * counterpart of POST /api/process/graph. Maps the process-template bundle
 * (roles may carry inputs/outputs/dependsOn) through the unified model so the
 * draft editor renders label + dependency + artifact edges and unified lints. */
app.post('/api/flows/graph', (req, res) => {
  const raw = req.body && req.body.processTemplate;
  const v = validateProcessTemplate(raw, { allowEmptyRoles: true });
  if (!v.ok) return res.status(400).json({ error: `Invalid processTemplate: ${v.error}` });
  // Map legacy pr-review roles (#347) onto the #380 channel ports so old drafts render.
  const bundle = liftTriggerEmits(normalizeLegacyReview(raw));
  const flow = processTemplateToUnified(bundle);
  const bundleHumans = Array.isArray(bundle.humans) ? bundle.humans : [];
  res.json({
    unifiedFlowVersion: flow.unifiedFlowVersion, source: 'draft', imported: true, name: bundle.name,
    // Ordered stage names drive the layered layout on the client (#stage-order).
    stages: Array.isArray(bundle.stages) ? bundle.stages.filter(s => typeof s === 'string') : [],
    // The bundle's own registries drive gate/brake classification (#928) and the
    // named human-role bindings (#987).
    humans: bundleHumans,
    ...buildUnifiedGraph(flow.nodes, flow.edges, { labels: flow.labels, humans: bundleHumans }),
  });
});

/* ─── Process template bundle (export, #334) ────────────────────────────
 * GET /api/process/template?team=<id>
 * Returns a portable bundle (roles + prompts + triggers incl emits, gates,
 * labels) — the Process Canvas export / import format. */
app.get('/api/process/template', (req, res) => {
  const roleEntries = [];   // for the bundle (prompt + full triggers)
  const graphAgents = [];   // for gates/labels via buildProcessGraph

  const team = typeof req.query.team === 'string' && req.query.team.trim() ? req.query.team.trim() : null;
  if (team && !AGENT_ID_RE.test(team)) return res.status(400).json({ error: 'Invalid team id' });
  let teamName = team;
  let teamStages = [];
  let teamHillClimb = null;
  let teamWipLimit = null;
  if (team) {
    const teamCfg = readJsonFile(path.join(AGENTS_DIR, team, 'config.json'), null);
    if (teamCfg?.displayName) teamName = teamCfg.displayName;
    if (Array.isArray(teamCfg?.stages)) teamStages = teamCfg.stages.filter(s => typeof s === 'string');
    // Hill-climb collector config (#1222) round-trips like stages; normalizeHillClimb
    // (in buildProcessTemplate) drops applied-card/snapshot state so only config travels.
    teamHillClimb = teamCfg?.hillClimb || null;
    // Admission control (#2114) — the per-flow WIP limit lives on the team agent
    // like stages/labels, so the export carries it back into a portable bundle.
    teamWipLimit = normalizeWipLimit(teamCfg?.wipLimit);
  }
  for (const id of listAgentDirs()) {
    const cfg = readJsonFile(path.join(AGENTS_DIR, id, 'config.json'), {});
    const role = cfg.role || 'agent';
    if (role === 'team') continue;
    if (team && cfg.parentTeamId !== team) continue;
    const triggers = readJsonFile(controlOrAgentPath(id, 'triggers.json'), []);
    const tlist = Array.isArray(triggers) ? triggers : [];
    // Effective prompt the agent actually runs (rendered AGENT-PROMPT.md),
    // falling back to the config override.
    const systemPrompt = readAgentSystemPrompt(id) || cfg.systemPrompt || '';
    // Lift any legacy trigger-level emit to the agent level (#783) so the export
    // carries label hand-offs canonically and loses no edge.
    const emits = liftAgentEmits(cfg.emits, tlist);
    // Structured OUTCOMES port (#827): exported when authored, and it supersedes
    // `emits` (the two never both ride an exported role — buildProcessTemplate
    // enforces the same rule).
    const authoredOutcomes = isAuthoredOutcomes(cfg.outcomes);
    // Data-flow ports (#379) + hierarchy (#377) persisted on the member config.
    // Carried into the exported role so buildProcessTemplate can round-trip them
    // — without these the draft graph loses the dependency/artifact edges and
    // the human-delivery touchpoints the live team renders (the count/layout
    // divergence between a team and an Edit-as-draft of it). buildProcessTemplate
    // reduces the member-id `dependsOn`/`parent` to portable role keys.
    const df = cfg.dataFlow && typeof cfg.dataFlow === 'object' ? cfg.dataFlow : {};
    roleEntries.push({
      id, displayName: cfg.displayName || id, role,
      sessionPolicy: cfg.sessionPolicy || 'persistent', systemPrompt, triggers: tlist,
      ...(authoredOutcomes ? { outcomes: cfg.outcomes } : (emits.length ? { emits } : {})),
      ...(typeof cfg.stage === 'string' && cfg.stage ? { stage: cfg.stage } : {}),
      ...(Array.isArray(df.inputs) && df.inputs.length ? { inputs: df.inputs } : {}),
      ...(Array.isArray(df.outputs) && df.outputs.length ? { outputs: df.outputs } : {}),
      ...(Array.isArray(df.dependsOn) && df.dependsOn.length ? { dependsOn: df.dependsOn } : {}),
      ...(typeof cfg.parentMemberId === 'string' && cfg.parentMemberId ? { parent: cfg.parentMemberId } : {}),
    });
    // `channels` rides along so a channel's `gate: 'human'` classifies its routing
    // label as a gate in the exported registry too (#928).
    graphAgents.push({
      id, role, triggers: tlist, emits, outcomes: cfg.outcomes || null,
      channels: Array.isArray(cfg.channels) ? cfg.channels : [],
    });
  }
  // The team's persisted registry is the gate/brake authority (#928); the graph
  // echoes it back in `labels[]` so the exported bundle round-trips its flags.
  const g = buildProcessGraph(graphAgents, { labels: teamLabelRegistry(team) });
  res.json(buildProcessTemplate({
    name: teamName || 'process', level: 'live', teamId: team || undefined,
    roles: roleEntries, gates: g.gates, labels: g.labels, stages: teamStages,
    // Named human roles (#987) round-trip with the bundle so an exported team
    // re-materialises its human boxes and Edit-as-draft carries them.
    humans: teamHumansRegistry(team),
    // Hill-climb collector config (#1222) rides along on the team agent.
    hillClimb: teamHillClimb,
    // Admission control (#2114) rides along on the team agent, same as above.
    wipLimit: teamWipLimit,
  }));
});

/* ─── Flow Copilot (#1068/#1070, spec #1047) ────────────────────────────
 * Natural-language flow generation/revision. Stateless: the client resends the
 * conversation + current bundle each turn; generate → sanitize → STRICT
 * validate → lint → repair (≤ 2 iterations) lives in flow-copilot.js. This
 * route only resolves the model (same posture as /api/agent-prompt/generate —
 * no heuristic fallback exists at whole-flow scope, so no provider is a hard
 * 400) and owns the LLM transport. Mutating POST → audited automatically.
 *
 * A turn can take 20–60s (up to 3 LLM calls), so the response is NDJSON
 * progress lines (#1070) in the /api/teams/stream mould: request-shape and
 * provider errors stay plain 400 JSON (headers not sent yet); once generation
 * starts, `{type:'phase', …}` events stream as the loop advances, terminated
 * by `{type:'result', …Phase-1 payload}` or `{type:'error', status, error}`. */
app.post('/api/process/copilot', heavyLimiter, async (req, res) => {
  const body = req.body || {};
  const messages = Array.isArray(body.messages) ? body.messages : null;
  if (!messages || !messages.length) return res.status(400).json({ error: 'messages must be a non-empty array' });
  for (const m of messages) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string') {
      return res.status(400).json({ error: "each message needs role 'user'|'assistant' and string content" });
    }
  }
  if (body.bundle !== undefined && (body.bundle === null || typeof body.bundle !== 'object' || Array.isArray(body.bundle))) {
    return res.status(400).json({ error: 'bundle must be an object' });
  }

  // Server-side size guard (#1404): measure the full system prompt before
  // starting the NDJSON stream so we can return a plain 400. This fires when
  // the serialised bundle JSON + format doc + conventions addendum would exceed
  // the threshold, which causes a 504 timeout from the upstream LLM proxy.
  if (body.bundle !== undefined) {
    const formatDoc = readFormatDoc();
    const addendum = readPromptAddendum();
    const size = measureCopilotSystemPrompt({ formatDoc, addendum, bundle: body.bundle });
    if (size > SYSTEM_PROMPT_CHAR_LIMIT) {
      return res.status(400).json({
        error: 'bundle-too-large',
        message: `The bundle is too large for the Flow Copilot to process (${size.toLocaleString()} chars; limit ${SYSTEM_PROMPT_CHAR_LIMIT.toLocaleString()}). Make small, targeted requests — describe one role at a time rather than pasting the full bundle JSON.`,
      });
    }
  }

  const target = resolveAssistTarget(req);
  if (target.selectionError) return sendAssistSelectionError(res, target);
  if (target.error) return res.status(400).json({ error: target.error });

  const url = buildMessagesUrl(target.baseUrl);
  const headers = {
    'anthropic-version': '2023-06-01',
    ...(target.token ? { Authorization: `Bearer ${target.token}`, 'x-api-key': target.token } : {}),
  };
  // A stopped or disconnected turn ends the SERVER-side work (#2087, D2).
  // Before this, `aborted` only suppressed delivery: `runCopilot` took no
  // signal and the transport accepted none, so a disconnect could leave up to
  // MAX_REPAIR_ITERATIONS + 1 = 3 LLM calls running, billed, and discarded. The
  // client's Stop is an `AbortController` on its own fetch, so it arrives here
  // as the same `res.on('close')` a tab close does — one cancellation path for
  // both (AC9, AC14); the signal is threaded into httpPostStreamText so the
  // streamed request already in flight is destroyed, not merely ignored.
  const turnAbort = new AbortController();

  // Whole-bundle generations are big (16k max_tokens) and can take minutes.
  // STREAM the upstream call (httpPostStreamText forces stream:true) so bytes
  // flow the whole time — the internal Anthropic proxy never sees one long
  // silent non-streaming request, which is the second way a large flow used to
  // 504 — and forward a throttled progress heartbeat carrying the running reply
  // size so the composer shows real movement instead of a frozen "Generating…".
  const turnStartedAt = Date.now();
  const callLlm = async (payload) => {
    let heartbeatAt = 0;
    // The budget left for this call is the whole-turn ceiling minus what earlier
    // calls (generation + any repairs) already spent — never below a small floor,
    // and never more than one call's share of the turn (#2131), so a slow single
    // generation fails early enough for the split retry to still fit.
    const remainingMs = COPILOT_STREAM_DEADLINE_MS - (Date.now() - turnStartedAt);
    const deadlineMs = Math.max(5000, Math.min(COPILOT_CALL_DEADLINE_MS, remainingMs));
    // Idle guard: default to the remaining deadline (so a buffered, byteless-but-
    // alive generation is bounded ONLY by the deadline and never prematurely
    // "timeout"s), and only tighten it when an operator sets an explicit value.
    // Capped at the remaining deadline so it can never outlive the turn.
    const inactivityMs = COPILOT_STREAM_INACTIVITY_MS
      ? Math.min(COPILOT_STREAM_INACTIVITY_MS, deadlineMs)
      : deadlineMs;
    const result = await httpPostStreamText(url, headers, { model: target.model, ...payload }, {
      deadlineMs,
      inactivityMs,
      signal: turnAbort.signal,
      onProgress: (chars) => {
        const now = Date.now();
        if (now - heartbeatAt < 750) return; // a status line needs no more than ~1/s
        heartbeatAt = now;
        emit({ ...lastPhaseEv, chars });
      },
    });
    if (result.error || result.status < 200 || result.status >= 300) {
      const detail = result.error
        || (result.body && (result.body.error?.message || result.body.error || result.body.message))
        || `HTTP ${result.status}`;
      throw new Error(`LLM request failed: ${detail}`);
    }
    return result.text;
  };

  // NDJSON stream plumbing — see POST /api/teams/stream for the rationale of
  // flushHeaders/setNoDelay and of watching res (not req) for disconnect.
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  if (typeof res.socket?.setNoDelay === 'function') {
    res.socket.setNoDelay(true);
  }
  let aborted = false;
  res.on('close', () => {
    if (!res.writableEnded) {
      aborted = true;
      // #2087: stop the work, not just its delivery.
      turnAbort.abort();
    }
  });
  function emit(ev) {
    if (aborted) return;
    try {
      res.write(JSON.stringify(ev) + '\n');
    } catch { /* socket gone */ }
  }

  // The last phase runCopilot announced, so the streaming heartbeat inside
  // callLlm can re-emit it with the running reply size attached (carrying its
  // `iteration` on a repair pass) without runCopilot needing to know it streams.
  let lastPhaseEv = { type: 'phase', phase: 'generating' };
  const onProgress = (ev) => {
    if (ev && ev.type === 'phase' && ev.phase) lastPhaseEv = ev;
    emit(ev);
  };

  // Provenance first (§4.5): the NDJSON stream announces which provider + model
  // is paying for this turn before any generation begins.
  emit({ type: 'assist', ...assistMeta(target).assist });

  try {
    const out = await runCopilot({
      bundle: body.bundle, messages, callLlm, onProgress, signal: turnAbort.signal,
    });
    emit({ type: 'result', ...out, model: target.model, meta: assistMeta(target) });
  } catch (err) {
    // A stopped turn is not a failure (#2087): the socket is already gone, so
    // `emit` is a no-op anyway, but classifying it keeps a deliberate Stop out
    // of the error path — nothing is left to report and no proposal is built.
    if (isCopilotAborted(err)) {
      // nothing to emit — the client asked for this and is no longer listening
    } else {
      // Transport failure with no bundle to fall back to, or no parseable reply
      // at all. "Model couldn't get lint-clean" is NOT an error — runCopilot
      // returns ok:false for that. The event carries a stable `code` (#2131) so
      // the composer can render plain-language guidance instead of relaying the
      // raw transport string as its headline; `error` keeps that raw detail for
      // the card's debug expander.
      const failure = classifyTurnFailure(err);
      emit({ type: 'error', status: failure.status, code: failure.code, error: failure.detail });
    }
  }
  if (!aborted) res.end();
});

/* ─── Helper Chat (#1734, spec docs/helper-chat-concept.md) ──────────────
 * POST /api/helper/chat — the in-console documentation assistant. Grounds the
 * model on the vendored docs corpus (#1733, ./helper-chat/corpus.js) and streams
 * the reply as an NDJSON delta/done stream, the same transport as the Flow
 * Copilot above. Request-shape / provider errors stay plain JSON (400/403,
 * headers not yet sent); once the stream opens, `{type:'delta',text}` then
 * `{type:'done'}` (or `{type:'error',message}`) flow. The handler lives in its
 * own module for testability (api.js has no isolated harness); the LLM transport
 * helpers are injected from here. Auth is the global /api gate (auth.js), same as
 * every other /api route including the copilot route above. */
const helperChatHandler = createHelperChatHandler({
  resolveAssistTarget,
  buildMessagesUrl,
  httpPostJson,
  extractMessageText,
  assistMeta,
  sendAssistSelectionError,
});
app.post('/api/helper/chat', heavyLimiter, helperChatHandler);

/* ─── Process-template registry (#419) ──────────────────────────────────
 * Curated whole-process templates — the process-level analogue of the
 * agent-template catalog. Seeded from orchestrator/skill-pool/process-templates/
 * into the pool volume via `make seed-process-templates`; read-only here. */
const PROCESS_TEMPLATES_DIR = path.join(POOL_DIR, 'process-templates');

app.get('/api/process-templates', (_req, res) => {
  res.json({ templates: listProcessTemplates(PROCESS_TEMPLATES_DIR) });
});

app.get('/api/process-templates/:id', (req, res) => {
  const b = loadProcessTemplate(PROCESS_TEMPLATES_DIR, req.params.id);
  if (!b) return res.status(404).json({ error: 'Process template not found' });
  res.json(b);
});

/* ─── Plugin registry (#1547) ────────────────────────────────────────────
 * Reference plugins ship under plugins/<id>/ and are seeded into the pool
 * (/pool/plugins/) by `make seed-plugins`. INSTALLING copies one into the
 * operator registry (/workspace/plugins/<id>/), which is what makes the
 * orchestrator start its broker sidecar.
 *
 * Install is a deliberate, System-Admin-only action rather than something the
 * seed does implicitly: a plugin's sidecar holds real privilege (plugin #1
 * mounts the host Podman socket), so a human confirms the declared
 * capabilities before anything privileged runs. Installing still grants
 * NOTHING to any agent — that is the separate grant step (§4.4). */
const POOL_PLUGINS_DIR = path.join(POOL_DIR, 'plugins');
const REGISTRY_PLUGINS_DIR = path.join(WORKSPACE, 'plugins');
const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

// Read + validate one plugin.json under a base dir. Never throws; an invalid
// plugin is reported WITH its errors rather than hidden, so an operator can see
// why something they dropped in isn't installable.
function readPluginDir(baseDir, id) {
  if (!PLUGIN_ID_RE.test(id)) return { id, ok: false, errors: ['invalid plugin id'], manifest: null };
  const file = path.join(baseDir, id, 'plugin.json');
  // Containment: id is regex-bounded above (no dots, no slashes), so the join
  // cannot escape — re-checked here because this path is attacker-adjacent.
  if (!path.resolve(file).startsWith(path.resolve(baseDir) + path.sep)) {
    return { id, ok: false, errors: ['invalid plugin id'], manifest: null };
  }
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (err) { return { id, ok: false, errors: [`cannot read plugin.json: ${err.message}`], manifest: null }; }
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (err) { return { id, ok: false, errors: [`invalid JSON: ${err.message}`], manifest: null }; }
  const result = validatePluginManifest(parsed);
  if (result.ok && result.manifest.id !== id) {
    return { id, ok: false, errors: [`manifest id "${result.manifest.id}" does not match directory "${id}"`], manifest: null };
  }
  return { id, ok: result.ok, errors: result.errors, manifest: result.manifest };
}

function listPluginDirs(baseDir) {
  try {
    return fs.readdirSync(baseDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('_') && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort();
  } catch { return []; }
}

// Fetch command .md files from GitHub Contents API at install time (#1798).
// Returns { fileCount } on success; throws on any network or API error.
// Offline installs are not supported — a network failure rolls back the install.
const GH_FETCH_HEADERS = { 'User-Agent': 'aee-plugin-install/1', 'Accept': 'application/vnd.github+json' };

// List a repo directory via the GitHub Contents API. Throws with a message that
// names the directory + ref (so a mis-pointed path reads clearly, cf. #1859).
async function ghListContents(repo, dirPath, encodedRef, ref) {
  const url = `https://api.github.com/repos/${repo}/contents/${dirPath}?ref=${encodedRef}`;
  const resp = await fetch(url, { headers: GH_FETCH_HEADERS, signal: AbortSignal.timeout(30_000) });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`GitHub API ${resp.status} listing ${dirPath}@${ref}: ${body.slice(0, 200)}`);
  }
  const listing = await resp.json();
  if (!Array.isArray(listing)) throw new Error('GitHub Contents API: expected an array for directory listing');
  return listing;
}

async function ghDownloadFile(file) {
  const resp = await fetch(file.download_url, { headers: GH_FETCH_HEADERS, signal: AbortSignal.timeout(30_000) });
  if (!resp.ok) throw new Error(`GitHub: failed to download ${file.name}: ${resp.status}`);
  return resp.text();
}

// Fetch one repo directory tree (recursively) into destAbs, optionally filtered
// by an `includeRe` filename regex and chmod 0755'd when `exec`. Returns the
// number of files written.
async function fetchScaffoldTree(repo, repoDir, destAbs, encodedRef, ref, { exec = false, includeRe = null } = {}) {
  const listing = await ghListContents(repo, repoDir, encodedRef, ref);
  fs.mkdirSync(destAbs, { recursive: true });
  let count = 0;
  for (const item of listing) {
    if (item.type === 'dir') {
      // An `include` filter means the caller is cherry-picking files from THIS
      // directory (e.g. only `*-template.md` out of a `templates/` dir that also
      // holds a `commands/` subdir) — so a filtered entry stays flat and never
      // descends. Unfiltered entries copy the whole tree.
      if (includeRe) continue;
      count += await fetchScaffoldTree(repo, `${repoDir}/${item.name}`, path.join(destAbs, item.name), encodedRef, ref, { exec, includeRe });
    } else if (item.type === 'file' && item.download_url) {
      if (includeRe && !includeRe.test(item.name)) continue;
      const content = await ghDownloadFile(item);
      const dest = path.join(destAbs, item.name);
      fs.writeFileSync(dest, content, 'utf8');
      if (exec) { try { fs.chmodSync(dest, 0o755); } catch { /* best effort */ } }
      count += 1;
    }
  }
  return count;
}

// Fetch a command-only plugin's install-time content from GitHub: the command
// `.md` files (optionally placeholder-resolved for spec-kit, #1865) plus any
// declared scaffold trees (the `.specify/` project layout). Everything lands in
// destDir/commands + destDir/scaffold/<dest>, pinned to the manifest ref.
async function fetchPluginCommandsFromGithub(pluginFetch, destDir, { namespace = 'speckit' } = {}) {
  const { repo, ref } = pluginFetch;
  const commandsDir = pluginFetch.commandsDir || 'commands';
  const encodedRef = encodeURIComponent(ref);

  // ── commands ──
  const listing = await ghListContents(repo, commandsDir, encodedRef, ref);
  const mdFiles = listing.filter((f) => f.type === 'file' && f.name.endsWith('.md') && f.download_url);
  fs.mkdirSync(path.join(destDir, 'commands'), { recursive: true });
  for (const file of mdFiles) {
    let content = await ghDownloadFile(file);
    if (pluginFetch.resolveCommands) {
      content = resolveSpecKitCommand(content, {
        scriptVariant: pluginFetch.scriptVariant || 'sh',
        agentName: 'claude',
        namespace,
      });
      // Fail loud rather than seed a half-resolved command: an unresolved
      // placeholder (a `{SCRIPT}` with no `scripts.sh`, or an unmapped
      // `__SPECKIT_COMMAND_*__` cross-ref) means the command would break at
      // runtime. The install then rolls back (#1865).
      if (hasUnresolvedPlaceholders(content)) {
        throw new Error(`unresolved placeholder(s) in ${file.name} after resolution`);
      }
    }
    fs.writeFileSync(path.join(destDir, 'commands', file.name), content, 'utf8');
  }

  // ── scaffold (the runnable project layout the commands depend on) ──
  let scaffoldFileCount = 0;
  for (const entry of pluginFetch.scaffold || []) {
    const includeRe = entry.include ? new RegExp(entry.include) : null;
    const destAbs = path.join(destDir, 'scaffold', entry.dest);
    scaffoldFileCount += await fetchScaffoldTree(repo, entry.repoDir, destAbs, encodedRef, ref, { exec: !!entry.exec, includeRe });
  }

  return { fileCount: mdFiles.length, scaffoldFileCount };
}

// Read installed-version.json written by fetchPluginCommandsFromGithub at install time.
function readInstalledVersion(registryDir, id) {
  try {
    return JSON.parse(fs.readFileSync(path.join(registryDir, id, 'installed-version.json'), 'utf8'));
  } catch { return null; }
}

async function notifyPluginReconcile() {
  const orchestratorUrl = process.env.ORCHESTRATOR_URL || 'http://orchestrator:4002';
  try {
    const resp = await fetch(`${orchestratorUrl}/internal/plugins/reconcile`, { method: 'POST' });
    return resp.ok ? await resp.json() : { error: `orchestrator returned ${resp.status}` };
  } catch (err) {
    // The registry write already succeeded; a down orchestrator just means the
    // sidecar starts at its next boot reconcile. Surfaced, never fatal.
    return { error: err.message };
  }
}

app.get('/api/plugins', apiLimiter, async (req, res) => {
  const installedIds = listPluginDirs(REGISTRY_PLUGINS_DIR);
  const installed = installedIds.map((id) => readPluginDir(REGISTRY_PLUGINS_DIR, id));
  const available = listPluginDirs(POOL_PLUGINS_DIR)
    .filter((id) => !installedIds.includes(id))
    .map((id) => readPluginDir(POOL_PLUGINS_DIR, id));

  // Which sidecars are actually up — an installed plugin whose broker is not
  // running is a real state an operator needs to see, not an error.
  let running = {};
  const orchestratorUrl = process.env.ORCHESTRATOR_URL || 'http://orchestrator:4002';
  try {
    const resp = await fetch(`${orchestratorUrl}/internal/plugins`);
    if (resp.ok) {
      const body = await resp.json();
      for (const p of body.plugins || []) running[p.id] = !!p.sidecarRunning;
    }
  } catch { /* orchestrator unreachable — report unknown rather than false */ }

  res.json({
    installed: installed.map((p) => {
      const iv = readInstalledVersion(REGISTRY_PLUGINS_DIR, p.id);
      return { ...p, installed: true, sidecarRunning: running[p.id] ?? null, ...(iv ? { installedVersion: iv } : {}) };
    }),
    available: available.map((p) => ({ ...p, installed: false, sidecarRunning: false })),
    canManage: !!getScope(req).all,
  });
});

app.post('/api/plugins/:id/install', heavyLimiter, async (req, res) => {
  if (!getScope(req).all) return res.status(403).json({ error: 'System Admin required' });
  const id = req.params.id;
  const entry = readPluginDir(POOL_PLUGINS_DIR, id);
  if (!entry.ok) {
    return res.status(entry.errors[0] && /cannot read/.test(entry.errors[0]) ? 404 : 400)
      .json({ error: `plugin '${id}' is not installable`, errors: entry.errors });
  }
  const dest = path.join(REGISTRY_PLUGINS_DIR, id);
  if (fs.existsSync(dest)) return res.status(409).json({ error: `plugin '${id}' is already installed` });
  try {
    fs.mkdirSync(REGISTRY_PLUGINS_DIR, { recursive: true });
    fs.cpSync(path.join(POOL_PLUGINS_DIR, id), dest, { recursive: true });
  } catch (err) {
    return res.status(500).json({ error: `install failed: ${err.message}` });
  }

  // Fetch-at-install: if the manifest declares a fetch source, download command
  // files from GitHub now and pin the version. Offline installs are not supported
  // (docs/plugin-system-concept.md §4.9). Roll back on any failure.
  let installedVersion = null;
  if (entry.manifest.fetch && entry.manifest.fetch.source === 'github') {
    try {
      const { fileCount, scaffoldFileCount } = await fetchPluginCommandsFromGithub(entry.manifest.fetch, dest, {
        namespace: (entry.manifest.commands && entry.manifest.commands.namespace) || 'speckit',
      });
      installedVersion = {
        repo: entry.manifest.fetch.repo,
        ref: entry.manifest.fetch.ref,
        fetchedAt: new Date().toISOString(),
        fileCount,
        ...(scaffoldFileCount ? { scaffoldFileCount } : {}),
      };
      fs.writeFileSync(path.join(dest, 'installed-version.json'), JSON.stringify(installedVersion, null, 2));
    } catch (err) {
      try { fs.rmSync(dest, { recursive: true, force: true }); } catch { /* noop */ }
      return res.status(502).json({ error: `command fetch failed: ${err.message}` });
    }
  }

  const reconcile = await notifyPluginReconcile();
  res.json({ id, installed: true, manifest: entry.manifest, ...(installedVersion ? { installedVersion } : {}), reconcile });
});

app.delete('/api/plugins/:id', heavyLimiter, async (req, res) => {
  if (!getScope(req).all) return res.status(403).json({ error: 'System Admin required' });
  const id = req.params.id;
  if (!PLUGIN_ID_RE.test(id)) return res.status(400).json({ error: 'invalid plugin id' });
  const dest = path.join(REGISTRY_PLUGINS_DIR, id);
  if (!path.resolve(dest).startsWith(path.resolve(REGISTRY_PLUGINS_DIR) + path.sep)) {
    return res.status(400).json({ error: 'invalid plugin id' });
  }
  if (!fs.existsSync(dest)) return res.status(404).json({ error: `plugin '${id}' is not installed` });
  try {
    fs.rmSync(dest, { recursive: true, force: true });
  } catch (err) {
    return res.status(500).json({ error: `uninstall failed: ${err.message}` });
  }
  // Existing grants are deliberately LEFT ALONE: uninstalling is an operator
  // action on the registry, not a mass revoke. The orchestrator's reconcile
  // stops the orphaned sidecar, and a grant with no installed manifest seeds
  // nothing and prompts nothing — so the agent simply stops being told about a
  // capability whose broker is gone.
  const reconcile = await notifyPluginReconcile();
  res.json({ id, installed: false, reconcile });
});

/* ─── §4.8 live UI-extension stack (Network Plan Phase 2, #1562) ─────────
 * The console makes the pure primitives in plugin-ui-proxy.js live: it proxies
 * a UI-bearing plugin's own iframe UI from its sidecar, enforcing ui.routes[]
 * minRole at the proxy (the plugin re-enforcing it is the SECOND defense line,
 * §4.8), forwarding the authenticated user + effective role as SIGNED headers,
 * and exposing the scopes a plugin was granted to. Sidecar truth (address,
 * running) comes from the orchestrator — the admin-console image copies only
 * api/*.js and never learns the container-naming rule. */

// The shared plugin scope-token signing secret, written by the orchestrator at
// /workspace/plugins/_secret (0600). The console only READS it — it must never
// create one, or the two sides would diverge and every signature would fail to
// verify at the broker. null when the orchestrator has not booted yet.
function readPluginSigningSecret() {
  try {
    const raw = fs.readFileSync(path.join(REGISTRY_PLUGINS_DIR, '_secret'), 'utf8');
    const secret = String(raw).trim();
    return secret || null;
  } catch { return null; }
}

async function orchestratorGetJson(pathname) {
  const orchestratorUrl = process.env.ORCHESTRATOR_URL || 'http://orchestrator:4002';
  const resp = await fetch(`${orchestratorUrl}${pathname}`);
  const body = await resp.json().catch(() => null);
  return { status: resp.status, ok: resp.ok, body };
}

// Internal label fast-path (#1858): after a human-applied flow label is written
// through the GitHub Issues plugin (writeLabel(...,'add')), tell the
// orchestrator so it wakes the poller-subscribed listener immediately rather
// than waiting on the flaky GitHub Events API. Best-effort, fire-and-forget —
// the label is already on GitHub, so a failure here just falls back to the
// poller (the pre-#1858 behaviour). Label→trigger resolution stays entirely in
// the orchestrator (single source of truth); the console only reports the fact.
function notifyGithubLabelApplied({ repo, number, label, kind, actor }) {
  const orchestratorUrl = process.env.ORCHESTRATOR_URL || 'http://orchestrator:4002';
  fetch(`${orchestratorUrl}/internal/github-label-applied`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repo, number, label, kind: kind || 'issue', actor: actor || null }),
  })
    .then((r) => { if (!r.ok) console.warn(`[label-fastpath] orchestrator responded ${r.status}`); })
    .catch((err) => console.warn(`[label-fastpath] notify failed: ${err.message}`));
}

// GET /api/plugins/:id/scopes — the scopes the plugin was granted to, derived
// (in plugin-ui-proxy.deriveScopeList) ONLY from grants that already exist and
// then narrowed to the scopes the caller can see. Discovery is not a new read
// privilege, and must not become a cross-team one either.
app.get('/api/plugins/:id/scopes', apiLimiter, async (req, res) => {
  const id = req.params.id;
  if (!PLUGIN_ID_RE.test(id)) return res.status(400).json({ error: 'invalid plugin id' });
  let granted;
  try {
    granted = await orchestratorGetJson(`/internal/plugins/${encodeURIComponent(id)}/granted-agents`);
  } catch (err) {
    return res.status(502).json({ error: `orchestrator unreachable: ${err.message}` });
  }
  if (granted.status === 404) return res.status(404).json({ error: `plugin '${id}' is not installed` });
  if (!granted.ok || !granted.body) return res.status(502).json({ error: 'could not resolve plugin grants' });
  const all = deriveScopeList(granted.body.grantedAgents, granted.body.directory);
  res.json({ pluginId: id, scopes: visibleScopes(getScope(req), all) });
});

// ALL /plugins/:id/ui and /plugins/:id/ui/* — the UI proxy. NOT under /api, so
// the session gate is applied explicitly (a session-less request is refused
// here, before anything plugin-specific runs). Streamed rather than buffered so
// document PUTs and future uploads work.
function pluginUiProxy(req, res) {
  const id = req.params.id;
  if (!PLUGIN_ID_RE.test(id)) return res.status(400).json({ error: 'invalid plugin id' });

  // Installed + UI-bearing, or there is nothing to serve (an uninstalled or
  // non-UI plugin 404s — AC).
  const entry = readPluginDir(REGISTRY_PLUGINS_DIR, id);
  if (!entry.ok || !entry.manifest || !entry.manifest.ui || !Array.isArray(entry.manifest.ui.routes)) {
    return res.status(404).json({ error: `plugin '${id}' has no UI` });
  }

  // A globally-visible plugin's general UI is reachable by every authenticated
  // user without a team grant (#1599). It never bypasses INSTALL (readPluginDir
  // above already 404s an uninstalled plugin) and never widens agent capability.
  const globalVisible = isGloballyVisibleUi(entry.manifest);

  (async () => {
    // Resolve the grant so the proxy stops serving the moment the last grant is
    // revoked (AC), and so the viewer's effective role is judged only against
    // teams the plugin is actually granted to.
    let granted;
    try {
      granted = await orchestratorGetJson(`/internal/plugins/${encodeURIComponent(id)}/granted-agents`);
    } catch (err) {
      return res.status(502).json({ error: `orchestrator unreachable: ${err.message}` });
    }
    if (!granted.ok || !granted.body) return res.status(502).json({ error: 'could not resolve plugin grants' });
    const grantedAgents = granted.body.grantedAgents || [];
    // Without a grant, a non-global plugin has nothing to serve; a global one is
    // served to every authenticated user (still install-gated, above).
    if (!grantedAgents.length && !globalVisible) {
      return res.status(403).json({ error: `plugin '${id}' is not granted to any agent` });
    }
    const grantedTeamIds = [...new Set(grantedAgents.map((g) => g.teamId).filter(Boolean))];

    const scope = getScope(req);
    // Grant-derived role first (so a team-admin/system-admin keeps elevated
    // access); a purely-global viewer falls back to an ordinary team-member of
    // the general routes, so an elevated route stays refused by enforceUiRoute.
    const viewerRole = effectiveViewerRole(scope, grantedTeamIds, { globalVisible });
    if (!viewerRole) return res.status(403).json({ error: 'you do not have access to this plugin' });

    const subPath = uiSubPath(req.originalUrl || req.url, id);
    const decision = enforceUiRoute(entry.manifest, subPath, viewerRole);
    if (!decision.allowed) {
      // The refusal comes from the CONSOLE proxy, not the sidecar (§4.8 — the
      // sidecar enforcing it again is the second line, not the first).
      return res.status(403).json({ error: `refused: ${decision.reason}`, minRole: decision.minRole });
    }

    // Sidecar address + liveness from the orchestrator.
    let ep;
    try {
      ep = await orchestratorGetJson(`/internal/plugins/${encodeURIComponent(id)}/ui-endpoint`);
    } catch (err) {
      return res.status(502).json({ error: `orchestrator unreachable: ${err.message}` });
    }
    if (ep.status === 404) return res.status(404).json({ error: `plugin '${id}' is not installed` });
    if (!ep.ok || !ep.body || !ep.body.endpoint) return res.status(502).json({ error: 'no sidecar endpoint' });
    if (!ep.body.running) return res.status(503).json({ error: `plugin '${id}' broker is not running` });

    const secret = readPluginSigningSecret();
    if (!secret) return res.status(503).json({ error: 'plugin signing secret unavailable' });
    const viewer = {
      sub: (req.user && req.user.username) || '',
      role: viewerRole,
      teamIds: scope.all ? grantedTeamIds : grantedTeamIds.filter((t) => scope.teamIds.has(t)),
    };
    const signed = signViewerHeaders(viewer, secret);

    // Stream-proxy to the sidecar's UI mount. The broker serves its UI under
    // /ui, so the console-relative sub-path maps onto <endpoint>/ui<subPath>.
    let target;
    try { target = new URL(`${ep.body.endpoint}/ui${subPath === '/' ? '' : subPath}`); }
    catch { return res.status(502).json({ error: 'bad sidecar endpoint' }); }
    // Carry the original query string through unchanged.
    const qs = (req.originalUrl || req.url).split('?')[1];
    if (qs) target.search = qs;

    const lib = target.protocol === 'https:' ? require('https') : require('http');
    const headers = {};
    for (const [k, v] of Object.entries(req.headers || {})) {
      const lk = k.toLowerCase();
      // Never forward the console session cookie, and strip any inbound signed
      // identity header so a client cannot inject its own before we sign.
      if (lk === 'cookie' || lk === 'content-length' || lk.startsWith('x-aee-plugin-')) continue;
      headers[k] = v;
    }
    Object.assign(headers, signed, { host: target.host });

    // express.json() already consumed a JSON body upstream (it is mounted
    // globally, before any route). Re-serialise it so a document PUT still
    // reaches the sidecar; any other content type was left untouched and is
    // streamed straight through.
    const parsedBody = req._body === true;
    let payload = null;
    if (parsedBody) {
      payload = Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body == null ? {} : req.body));
      headers['content-length'] = String(payload.length);
    }

    // #1858: a successful label-ADD through the GitHub Issues plugin (its UI
    // posts to `/api/label` with { repo, number, label, action }) is the fast-
    // path trigger. Detected here on the request so both the #1730 workflow-
    // trigger buttons and manual labeling — both go through writeLabel — are
    // covered; the orchestrator is notified only once the upstream write
    // succeeds (2xx). Scoped to the github-issues plugin (the dominant human-
    // labeling path); labels set in the GitHub web UI stay poller-only.
    const isLabelAdd = id === 'github-issues'
      && req.method === 'POST'
      && subPath === '/api/label'
      && parsedBody
      && req.body && req.body.action === 'add'
      && typeof req.body.repo === 'string'
      && Number.isInteger(req.body.number)
      && typeof req.body.label === 'string' && req.body.label.trim();

    const upstream = lib.request(
      { hostname: target.hostname, port: target.port, path: target.pathname + target.search, method: req.method, headers },
      (up) => {
        if (isLabelAdd && up.statusCode >= 200 && up.statusCode < 300) {
          notifyGithubLabelApplied({
            repo: req.body.repo,
            number: req.body.number,
            label: String(req.body.label).trim(),
            kind: 'issue', // the GitHub Issues plugin lists issues
            actor: viewer.sub || null,
          });
        }
        res.status(up.statusCode || 502);
        for (const [k, v] of Object.entries(up.headers || {})) {
          if (k.toLowerCase() === 'transfer-encoding') continue;
          res.setHeader(k, v);
        }
        up.pipe(res);
      },
    );
    upstream.on('error', (err) => {
      if (!res.headersSent) res.status(502).json({ error: `sidecar proxy failed: ${err.message}` });
    });
    if (parsedBody) { upstream.end(payload); }
    else { req.pipe(upstream); }
  })();
}

app.all('/plugins/:id/ui', spaLimiter, auth.requireAuth, pluginUiProxy);
app.all('/plugins/:id/ui/*', spaLimiter, auth.requireAuth, pluginUiProxy);

/* ─── Process drafts (Process Canvas v2, #344) ──────────────────────────
 * A draft is an editable process-template bundle that exists before any team
 * is materialised. Pure document storage — no agent/Matrix side effects.
 * Persisted at /workspace/process-drafts/<id>.json. */
const PROCESS_DRAFTS_DIR = path.join(WORKSPACE, 'process-drafts');
const DRAFT_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

// Resolve a draft path, hard-guarding against traversal (CodeQL-friendly:
// AGENT_ID_RE-style regex + path.resolve containment check).
function draftPath(id) {
  const root = path.resolve(PROCESS_DRAFTS_DIR);
  const p = path.resolve(root, `${id}.json`);
  if (p !== path.join(root, `${id}.json`)) return null;
  if (!p.startsWith(root + path.sep)) return null;
  return p;
}
// deriveUniqueDraftId is the shared pure slug helper imported from
// process-template.js (single source of truth for id derivation, #581).
const draftExists = (id) => fs.existsSync(draftPath(id));
function readDraft(id) {
  const p = draftPath(id);
  if (!p || !fs.existsSync(p)) return null;
  return readJsonFile(p, null);
}
function listDraftIds() {
  try {
    return fs.readdirSync(PROCESS_DRAFTS_DIR).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5));
  } catch { return []; /* dir not created yet */ }
}
// User records, keyed by id — the only thing the draft surfaces need them for is
// turning an access-set id into a display name (AC16) and projecting the Share
// picker (D2/D11). Read fresh per request like getScope does; the file is small.
function usersById() {
  const map = new Map();
  for (const u of readJsonFile(USERS_INDEX, [])) if (u && u.id) map.set(u.id, u);
  return map;
}
// DD3 (#2068) — strip a deleted human from every draft's access set. Unlike the
// unshare route this MAY empty a set (DD3a): the draft is retained and stays
// reachable by a System Admin, because silently destroying a document during a
// user deletion is not recoverable. `createdBy` is left as history. Returns how
// many records changed, for the log line.
function stripUserFromDrafts(userId) {
  let changed = 0;
  for (const id of listDraftIds()) {
    const d = readDraft(id);
    if (!d) continue;
    const next = draftAccess.stripUserFromDraft(d, userId);
    if (!next.changed) continue;
    writeJsonAtomic(draftPath(id), { ...d, accessUserIds: next.accessUserIds });
    changed++;
  }
  return changed;
}

// AC15 — drafts that predate #2068 carry no access set at all, and the gate
// above is fail-closed, so without this they would become System-Admin-only on
// upgrade day. DD4 gives each of them `createdBy` = the first System Admin and
// an access set of ALL current users, which is the literal reading of #2041 D6:
// today's access is preserved exactly and nobody loses anything. Re-runs are
// no-ops (a record with an `accessUserIds` array is already stamped), so this is
// safe in the `app.listen` callback beside the other startup backfills.
function backfillDraftAccess() {
  const users = readJsonFile(USERS_INDEX, []);
  const systemAdminId = draftAccess.firstSystemAdminId(users);
  const allUserIds = users.filter(u => u && u.id).map(u => u.id);
  let stamped = 0;
  for (const id of listDraftIds()) {
    const d = readDraft(id);
    if (!d) continue;
    const result = draftAccess.migrateDraftAccess(d, { systemAdminId, allUserIds });
    if (!result.changed) continue;
    try { writeJsonAtomic(draftPath(id), result.draft); stamped++; }
    catch { /* best effort per draft — never block startup */ }
  }
  if (stamped > 0) console.log(`[Admin] Draft access backfill stamped ${stamped} draft(s)`);
}

// AC3 — the by-id gate, applied identically by every route below. Answers with
// the AC7 indistinguishable-404 so the endpoint never confirms that a draft the
// caller may not see exists.
function requireDraftAccess(req, res, id) {
  if (!DRAFT_ID_RE.test(id)) { res.status(400).json({ error: 'Invalid draft id' }); return null; }
  const verdict = draftAccess.authorizeDraft(getScope(req), readDraft(id));
  if (!verdict.ok) { res.status(verdict.status).json({ error: verdict.error }); return null; }
  return verdict.draft;
}

app.get('/api/process/drafts', (req, res) => {
  const scope = getScope(req);
  const users = usersById();
  const drafts = listDraftIds().map(id => {
    const d = readDraft(id);
    if (!d) return null;
    // AC6 — the list filter is the same predicate as the by-id gate; a System
    // Admin (scope.all) sees every draft (DD7).
    if (!draftAccess.canAccessDraft(scope, d)) return null;
    return {
      id,
      name: d.name || id,
      roleCount: Array.isArray(d.roles) ? d.roles.length : 0,
      updatedAt: d.updatedAt || null,
      // AC16 — private vs shared, and who created one the viewer did not. Never
      // a raw user id: the list has no way to render one.
      ...draftAccess.draftAccessView(d, { viewerId: scope.userId, usersById: users }),
    };
  }).filter(Boolean).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  res.json(drafts);
});

app.post('/api/process/drafts', apiLimiter, (req, res) => {
  const name = typeof req.body?.name === 'string' && req.body.name.trim() ? req.body.name.trim() : 'Untitled flow';
  // Derive a unique slug id from the name (#581 shared helper).
  const id = deriveUniqueDraftId(name, { exists: draftExists });
  const now = new Date().toISOString();
  // Seed from an imported bundle if provided, else an empty skeleton.
  let bundle = emptyDraftBundle(name);
  if (req.body?.processTemplate) {
    const v = validateProcessTemplate(req.body.processTemplate, { allowEmptyRoles: true });
    if (!v.ok) return res.status(400).json({ error: `Invalid processTemplate: ${v.error}` });
    // Strip the access fields off an imported bundle (#2068): an exported and
    // re-imported draft belongs to the importer, and must never carry a foreign
    // access set in.
    bundle = { ...draftAccess.stripAccessFields(req.body.processTemplate), name };
  }
  // AC1 — `createdBy` is resolved from the authenticated caller, never from the
  // request body (the `PUT /api/me/preferences` rule), and the access set starts
  // as exactly the creator.
  const draft = { ...bundle, id, createdAt: now, updatedAt: now, ...draftAccess.newDraftAccess(getScope(req)) };
  fs.mkdirSync(PROCESS_DRAFTS_DIR, { recursive: true });
  writeJsonAtomic(draftPath(id), draft);
  res.status(201).json(draft);
});

app.get('/api/process/drafts/:id', (req, res) => {
  const d = requireDraftAccess(req, res, req.params.id);
  if (!d) return undefined;
  return res.json(d);
});

// The resolved access set behind the Share dialog. Same projection as the
// picker (D2/D11 — display name and email only), so the dialog never learns
// anything about a colleague the directory would not have told it.
app.get('/api/process/drafts/:id/access', (req, res) => {
  const d = requireDraftAccess(req, res, req.params.id);
  if (!d) return undefined;
  return res.json({ users: draftAccess.resolveAccessList(d, usersById()) });
});

// Share (DD2 — available to everyone already in the access set, with no action
// reserved to the creator). Writes ONLY the access set: the bundle is untouched,
// so a share can never be a way to smuggle a template edit past validation.
app.post('/api/process/drafts/:id/access', apiLimiter, (req, res) => {
  const { id } = req.params;
  const d = requireDraftAccess(req, res, id);
  if (!d) return undefined;
  const userId = typeof req.body?.userId === 'string' ? req.body.userId.trim() : '';
  // D3 — existing accounts only; there are no invitations of people without one.
  if (!usersById().has(userId)) return res.status(400).json({ error: 'Unknown user' });
  const result = draftAccess.addAccess(d, userId);
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  if (result.changed) writeJsonAtomic(draftPath(id), { ...d, accessUserIds: result.accessUserIds });
  return res.json({ users: draftAccess.resolveAccessList({ accessUserIds: result.accessUserIds }, usersById()) });
});

// Unshare. Anyone in the set may remove anyone (DD2), including themselves —
// that is how leaving a shared draft works — but AC9 refuses the removal that
// would empty the set and points at Delete draft instead.
app.delete('/api/process/drafts/:id/access/:userId', apiLimiter, (req, res) => {
  const { id, userId } = req.params;
  const d = requireDraftAccess(req, res, id);
  if (!d) return undefined;
  const result = draftAccess.removeAccess(d, userId);
  if (!result.ok) return res.status(result.status).json({ error: result.error, code: result.code });
  if (result.changed) writeJsonAtomic(draftPath(id), { ...d, accessUserIds: result.accessUserIds });
  return res.json({ users: draftAccess.resolveAccessList({ accessUserIds: result.accessUserIds }, usersById()) });
});

app.put('/api/process/drafts/:id', apiLimiter, (req, res) => {
  const { id } = req.params;
  const existing = requireDraftAccess(req, res, id);
  if (!existing) return undefined;
  // AC4 — the access fields are server-owned. This route spreads the whole
  // request body onto the record and `validateProcessTemplate` is not a
  // whitelist, so the incoming copy is dropped here and the stored one carried
  // over below, exactly the way `createdAt` is. The ordinary save route must
  // never be a way to widen access.
  const body = draftAccess.stripAccessFields(req.body || {});
  // Drafts are works-in-progress — empty role sets are allowed here (only
  // materialisation requires a non-empty set).
  const v = validateProcessTemplate(body, { allowEmptyRoles: true });
  if (!v.ok) return res.status(400).json({ error: v.error });
  // Empty/whitespace names are rejected: keep the previous name (and thus id).
  const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : existing.name;
  // Re-derive the storage id from the plain-text name whenever the name changes
  // (#581), so the id always reflects the current name. The draft's own id is
  // treated as free (no spurious `-2` when the slug is unchanged), and a
  // collision with another draft reuses the creation-time suffix behaviour.
  const newId = name === existing.name
    ? id
    : deriveUniqueDraftId(name, { currentId: id, exists: draftExists });
  const draft = {
    ...body,
    id: newId,
    name,
    createdAt: existing.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    // AC5 — the clients read the whole bundle and write it back, so a field they
    // do not re-emit would be silently lost on the next save. Carried from the
    // stored record, which is also what makes sharing survive a rename (the
    // branch below rewrites the draft under a new id).
    ...draftAccess.carryAccessFields(existing),
  };
  // Copilot chat history (#1071) — storage metadata like id/createdAt, never
  // part of the portable bundle. Normalized on write: whitelisted fields only,
  // capped length; anything malformed is dropped rather than persisted.
  const copilot = sanitizeCopilotHistory(body.copilot);
  if (copilot) draft.copilot = copilot; else delete draft.copilot;
  // Write the new-id entry first, then remove the old one, so a crash mid-rename
  // leaves the old record rather than losing the draft. No orphan/duplicate
  // remains once both steps complete (AC7).
  writeJsonAtomic(draftPath(newId), draft);
  if (newId !== id) {
    const oldPath = draftPath(id);
    try { if (oldPath && fs.existsSync(oldPath)) fs.rmSync(oldPath); } catch { /* best-effort */ }
  }
  res.json(draft);
});

app.delete('/api/process/drafts/:id', apiLimiter, (req, res) => {
  const { id } = req.params;
  // Delete is available to every holder (DD2/AC8) — the confirmation naming the
  // other people who lose it is the only thing between a mis-click and someone
  // else's work, and it lives on the client.
  if (!requireDraftAccess(req, res, id)) return undefined;
  const p = draftPath(id);
  if (!p || !fs.existsSync(p)) return res.status(404).json({ error: 'Draft not found' });
  fs.rmSync(p);
  return res.status(204).end();
});

/* Import a BriefingPack hierarchy as a process draft (#377). Walks the mission
 * directory on the shared workspace volume, parses each `brief.md`'s YAML front
 * matter, and maps the result through briefingsToUnified →
 * unifiedToProcessTemplate, so the brief.md body becomes each role's prompt and
 * the parent-child hierarchy, depends_on, artifacts and stage are preserved.
 * The result is persisted as a new editable draft. Read-only against the BP
 * source (no brief.md write-back).
 *
 * The BriefingPack model is being retired (epic #1961), and this route is the
 * one piece of it that is deliberately kept: it is the migration path off the
 * model, so it has to outlive it. #1965 (Phase 4) therefore re-implemented the
 * read in Node (`briefings-fs.js`) instead of fetching from bp-explorer, which
 * is what lets Phase 2 (#1963) delete that service.
 *
 * The request shape changed with that port, and had to: the old body took a
 * bare absolute `workspace` path, which no containment barrier ever saw
 * (bp-explorer did its own prefix check on the far side of an HTTP hop). It now
 * takes `{ agentId, path }` and resolves through `safeAgentPath` — the same
 * realpath-and-contain resolver every sibling workspace handler uses — so a
 * pack tree outside the agent's workspace root is refused here rather than
 * trusted. `path` is relative to the agent root and may be omitted for the root
 * itself.
 *
 * One behavioural difference from the service, deliberately not ported: packs
 * are read from the CHECKED-OUT tree only. bp-explorer additionally overlaid
 * unmerged `agent/*` branches **and** local worktrees (`.worktrees/`,
 * `.claude/worktrees/`), replacing two fields that both reach the draft — the
 * `brief.md` **body** (status-gated; feeds each role's drafted prompt) and its
 * **artifacts** (no status gate at all; feed the role's inputs/outputs). See
 * the note in `briefings-fs.js` for the full account and why chasing copies the
 * platform no longer writes is not worth a git spawn per request. */
app.post('/api/process/drafts/import-briefings', apiLimiter, (req, res) => {
  const agentId = typeof req.body?.agentId === 'string' ? req.body.agentId.trim() : '';
  if (!agentId) return res.status(400).json({ error: 'agentId is required' });
  if (!AGENT_ID_RE.test(agentId)) return res.status(400).json({ error: 'Invalid agent id' });
  const relPath = typeof req.body?.path === 'string' ? req.body.path.trim() : '';

  const missionDir = safeAgentPath(agentId, relPath);
  if (!missionDir) {
    // Covers all three refusals — unknown agent, traversal / absolute path, and
    // an outward-pointing symlink — deliberately without saying which, so the
    // response is not a probe for what exists outside the workspace root.
    return res.status(400).json({ error: 'invalid mission directory for that agent' });
  }

  let packs;
  let skipped;
  try {
    ({ packs, skipped } = readBriefingPacks(missionDir));
  } catch (err) {
    // A missing / empty / unparseable pack tree is a user-fixable condition,
    // so it must read as a sentence rather than a stack trace. Anything else is
    // a real fault and keeps its 500.
    if (err instanceof BriefingsError) return res.status(err.status).json({ error: err.message });
    return res.status(500).json({ error: `Could not read the mission directory: ${err.message}` });
  }

  const where = relPath ? `${agentId}/${relPath}` : agentId;
  const name = typeof req.body?.name === 'string' && req.body.name.trim()
    ? req.body.name.trim() : `Imported: ${where}`;
  const bundle = { ...unifiedToProcessTemplate(briefingsToUnified(packs, { name })), name };

  // Persist as a new draft (same id derivation as POST /api/process/drafts).
  const id = deriveUniqueDraftId(name, { exists: draftExists });
  const now = new Date().toISOString();
  // Same stamp as POST /api/process/drafts (#2068 AC1) — there are five
  // draft-creating entry points on the client, so the stamp belongs in the
  // route rather than in each caller.
  const draft = { ...bundle, id, sourceBriefings: where, createdAt: now, updatedAt: now, ...draftAccess.newDraftAccess(getScope(req)) };
  fs.mkdirSync(PROCESS_DRAFTS_DIR, { recursive: true });
  writeJsonAtomic(draftPath(id), draft);
  // `skipped` names the packs that carried no resolvable id and so contribute
  // no role. It is an **API-level diagnostic and nothing more**: it rides the
  // 201 so a caller — a script, or a future UI — can see that the draft has
  // fewer roles than the tree had packs. It is NOT surfaced to the person doing
  // the import: this dialog closes and navigates to the new draft on success,
  // and the Flows page has no notice surface to render it in, so an honest
  // claim stops here rather than at "the user is warned".
  //
  // Deliberately not written into the persisted draft: that is a
  // process-template bundle, and a read-time diagnostic is not part of its
  // shape. Omitted when nothing was skipped, so the normal response body is
  // byte-identical to before this ticket (asserted in bp-removal-guard.test.js).
  const partial = Array.isArray(skipped) && skipped.length > 0;
  res.status(201).json(partial ? { ...draft, skipped } : draft);
});

/* ─── Skills ────────────────────────────────────────────────────────── */

// ── Skill identity manifest (#625, docs/skill-lifecycle-concept.md §2) ──
// Best-effort `skill.json` stamping helpers. Stamping is never allowed to break
// the primary skill write, so every call is wrapped and swallows errors.

// "operator:<sub>" actor string for a human-driven write (concept §2.2).
function skillActor(req) {
  const sub = req && req.user && (req.user.sub || req.user.username);
  return sub ? 'operator:' + sub : 'operator';
}

// Stamp (or update) a skill dir's manifest. Continues the dir's existing chain.
function stampSkill(dir, opts) {
  try { return skillManifest.stampSkillDir(dir, opts); } catch { return null; }
}

// Capture a source skill's identity ({sourceVersion, sourceHash}) for recording
// an `origin` on a copy. Prefers the source manifest's stamped values; falls
// back to a freshly computed hash when the source is not yet stamped.
function skillSourceIdentity(srcDir) {
  let man = null;
  try { man = skillManifest.readManifest(srcDir); } catch { /* none */ }
  let sourceHash = man && man.contentHash;
  if (!sourceHash) { try { sourceHash = skillManifest.hashSkillDir(srcDir); } catch { sourceHash = undefined; } }
  return { sourceVersion: man && man.version, sourceHash };
}

// Build an `origin` object, dropping absent (undefined/null) fields so the
// serialized manifest stays clean.
function skillOrigin(fields) {
  const out = {};
  for (const k of Object.keys(fields)) {
    if (fields[k] !== undefined && fields[k] !== null) out[k] = fields[k];
  }
  return out;
}

// The additive identity fields (#625, AC6) surfaced on Skills API responses.
function skillManifestSummary(dir) {
  try {
    const man = skillManifest.readManifest(dir);
    if (!man) return {};
    return { version: man.version, contentHash: man.contentHash, updatedAt: man.updatedAt };
  } catch { return {}; }
}

// The skill's one-line frontmatter description (#633) for the grant-picker
// tooltip. Best-effort — returns {} when there's no SKILL.md or no description.
function skillDescriptionSummary(skillMdPath) {
  try {
    const md = fs.readFileSync(skillMdPath, 'utf8');
    const desc = skillImport.parseFrontmatterField(md, 'description');
    return desc ? { description: desc } : {};
  } catch { return {}; }
}

// Resolve the CURRENT on-disk directory of a skill's source at the given tier
// (#629). tier `global` → the global pool; tier `team` → the owning team's pool.
// Returns the path even when the dir no longer exists (the caller / drift glue
// detects deletion by the absent SKILL.md), or null when the tier/name is
// unroutable. Mirrors the seed-time team-first-then-global resolution — the tier
// the copy recorded at seed/copy time is authoritative here.
// A resolved source dir counts as "present" only when it actually carries a
// SKILL.md — the same signal skill-drift.js uses to tell a real source from a
// deleted one (an empty dir would otherwise hash as in-sync).
function hasSkillFile(dir) {
  if (!dir) return false;
  try { return fs.existsSync(path.join(dir, 'SKILL.md')); } catch { return false; }
}

function resolveSkillSourceDir(name, tier, teamId) {
  if (!SKILL_NAME_RE.test(String(name || ''))) return null;
  if (tier === 'team') return safeTeamSkillDir(teamId, name);
  if (tier === 'global') {
    const base = path.resolve(POOL_DIR, 'skills');
    const dir = path.resolve(base, name);
    const rel = path.relative(base, dir);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
    return dir;
  }
  return null;
}

// The drift summary (#629, AC2) surfaced on a skill COPY in API responses: the
// per-copy state (in-sync|outdated|diverged|conflict|orphaned|unknown), whether
// an automatic resync may touch it, and the source version currently available.
// `origin` is the copy's recorded lineage (from its own skill.json); a copy with
// no origin/anchor is hand-authored → no drift block (returns {}).
function skillDriftSummary(copyDir, origin) {
  const o = origin && typeof origin === 'object' ? origin : null;
  if (!o || !o.tier) return {};
  const sourceDir = resolveSkillSourceDir(path.basename(copyDir), o.tier, o.teamId);
  const { state } = skillDrift.copyDriftState({ copyDir, sourceHash: o.sourceHash, sourceDir });
  const summary = { drift: state, resyncable: skillManifest.isResyncable(state) };
  let srcMan = null;
  try { srcMan = sourceDir ? skillManifest.readManifest(sourceDir) : null; } catch { srcMan = null; }
  if (srcMan && Number.isInteger(srcMan.version)) summary.sourceVersion = srcMan.version;
  return summary;
}

// Agent-tier dirs are stamped lazily on first API read (agents own those dirs,
// so the backfill deliberately skips them — concept §2.2).
function lazyStampAgentSkill(dir, agentId) {
  try {
    if (!skillManifest.readManifest(dir)) {
      skillManifest.stampSkillDir(dir, { by: 'agent:' + agentId, action: 'created' });
    }
  } catch { /* best effort */ }
}

// Stamp a fresh copy: the copied source `skill.json` (dragged along by cpSync)
// is discarded so the destination starts its own instance chain at v1 with the
// given action + origin (concept §3.1 — every copy stamps origin + a history
// entry). Does not touch content, so the content hash is unaffected.
function stampSkillCopy(dstDir, opts) {
  try { fs.rmSync(path.join(dstDir, skillManifest.MANIFEST_FILENAME), { force: true }); } catch { /* none */ }
  return stampSkill(dstDir, opts);
}

// ── Shared skill-file-write core (#639, concept §3.2) ──────────────────────
// The ONE place a skill directory is materialised on disk + stamped. Every
// endpoint that lands a skill (POST /api/skills/transfer, and the KB endpoints
// /api/knowledge/{promote,share-to-team}) funnels its file write here, so the
// cpSync/mkdir/manifest-stamp sequence lives once. The pure collision decision
// stays in skill-transfer.planSkillWrite (unit-tested); this helper only does IO.
//
//   destDir     absolute target skill dir.
//   overwrite   rm the dir first (from planSkillWrite — an overwrite collision).
//   copyFrom    when set, cpSync the WHOLE source dir (provenance/extra files ride
//               along); when absent, just mkdir destDir and write the given files.
//   skillMd     optional SKILL.md content (a trailing newline is ensured).
//   provenance  optional provenance.json object — written AFTER any copyFrom, so
//               it overrides the copied-along provenance (share/lift/promote).
//   stamp       optional { mode:'copy'|'chain', name, by, action, origin?, note? }:
//               'copy' → stampSkillCopy (fresh v1 chain, discards dragged manifest);
//               'chain' → stampSkill (continues the target's chain — the extend case).
// Returns { ok: true } or { error } (the content write failed — the caller 500s;
// stamping is best-effort and never surfaced as an error).
function commitSkillWrite({ destDir, overwrite, copyFrom, skillMd, provenance, stamp }) {
  // #515 (js/path-injection): destDir is composed by callers from a user-supplied
  // skill name. Every skill write lands under the team-tier root (/workspace/teams)
  // or the global skill pool (/pool/skills), so re-assert containment *here* — the
  // CodeQL-legible path.relative barrier co-located with the fs sinks, since the
  // callers' guards live in a different function and don't reach the sink. A bare
  // SKILL_NAME_RE regex is not recognised as a traversal barrier; this is. Callers
  // keep their own guards — this is the last line of defence right at the write.
  const resolvedDest = path.resolve(destDir);
  const relFromTeams = path.relative(path.resolve(WORKSPACE, 'teams'), resolvedDest);
  const relFromPool = path.relative(path.resolve(POOL_DIR, 'skills'), resolvedDest);
  const underTeams = !!relFromTeams && !relFromTeams.startsWith('..') && !path.isAbsolute(relFromTeams);
  const underPool = !!relFromPool && !relFromPool.startsWith('..') && !path.isAbsolute(relFromPool);
  if (!underTeams && !underPool) return { error: 'skill destination escapes the skills root' };
  destDir = resolvedDest;
  try {
    if (overwrite) fs.rmSync(destDir, { recursive: true, force: true });
    if (copyFrom) {
      fs.mkdirSync(path.dirname(destDir), { recursive: true });
      fs.cpSync(copyFrom, destDir, { recursive: true });
    } else {
      fs.mkdirSync(destDir, { recursive: true });
    }
    if (skillMd !== undefined) {
      fs.writeFileSync(path.join(destDir, 'SKILL.md'), skillMd.endsWith('\n') ? skillMd : skillMd + '\n');
    }
    if (provenance !== undefined) {
      fs.writeFileSync(path.join(destDir, 'provenance.json'), JSON.stringify(provenance, null, 2));
    }
  } catch (err) {
    return { error: err.message };
  }
  if (stamp) {
    const s = { name: stamp.name, by: stamp.by, action: stamp.action };
    if (stamp.origin !== undefined) s.origin = stamp.origin;
    if (stamp.note !== undefined) s.note = stamp.note;
    if (stamp.mode === 'chain') stampSkill(destDir, s);
    else stampSkillCopy(destDir, s);
  }
  return { ok: true };
}

// ── Two-tier skill pool (#306) ──────────────────────────────────────────
// Global pool: /pool/skills (System-Admin managed, visible to all).
// Team pool:   /workspace/teams/<teamId>/skills (Team-Admin managed, scoped
// to the team). Agents receive global + their owning team's pool at seed time
// (the orchestrator resolves team-first then global). These helpers manage the
// team pool; the global pool keeps its existing /pool/skills paths untouched.
const POOL_TEAM_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

// True when a human Team with this id exists in the teams index.
function resolveTeamExists(teamId) {
  const teams = readJsonFile(TEAMS_INDEX, []);
  return Array.isArray(teams) && teams.some(t => t.id === teamId);
}

// Resolve a team skill directory with a containment check, or null if invalid.
function safeTeamSkillDir(teamId, name) {
  if (!POOL_TEAM_ID_RE.test(teamId || '') || !SKILL_NAME_RE.test(name || '')) return null;
  const base = path.resolve(WORKSPACE, 'teams', teamId, 'skills');
  const dir = path.resolve(base, name);
  const rel = path.relative(base, dir);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return dir;
}

// Global-pool skill dir with the CodeQL-legible containment guard — the twin of
// safeTeamSkillDir for the global tier. A raw path.join(POOL_DIR,'skills',name)
// with only a SKILL_NAME_RE guard is functionally safe but is NOT recognised by
// CodeQL js/path-injection as a traversal barrier; the path.relative idiom is.
// Returns null on an invalid or escaping name.
function safeGlobalSkillDir(name) {
  if (!SKILL_NAME_RE.test(name || '')) return null;
  const base = path.resolve(POOL_DIR, 'skills');
  const dir = path.resolve(base, name);
  const rel = path.relative(base, dir);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return dir;
}

// Agent-tier skill dir with the CodeQL-legible containment guard — the agent
// twin of safeTeamSkillDir/safeGlobalSkillDir for a per-agent skill copy under
// /workspace/agents/<agentId>/skills. A raw path.join(AGENTS_DIR, agentId,
// 'skills', name) with only AGENT_ID_RE + SKILL_NAME_RE guards is functionally
// safe but is NOT recognised by CodeQL js/path-injection as a traversal
// barrier; the path.relative idiom on the returned value is. Contains BOTH the
// agent id (dir) and the skill name (leaf). Returns null on an invalid or
// escaping id/name. Unlike safeAgentPath it does not realpath, so it resolves a
// not-yet-existing skill dir (callers check existence and 404 themselves).
function safeAgentSkillDir(agentId, name) {
  if (!AGENT_ID_RE.test(agentId || '') || !SKILL_NAME_RE.test(name || '')) return null;
  const base = path.resolve(AGENTS_DIR);
  const dir = path.resolve(base, agentId, 'skills', name);
  const rel = path.relative(base, dir);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return dir;
}

// List team skills, optionally filtered to one team. Each is tagged with its
// owning teamId so the UI (and a future membership filter, #302) can scope it.
function listTeamSkills(filterTeamId) {
  const out = [];
  const teamsRoot = path.join(WORKSPACE, 'teams');
  let teamDirs;
  try { teamDirs = fs.readdirSync(teamsRoot); } catch { return out; }
  for (const teamId of teamDirs) {
    if (!POOL_TEAM_ID_RE.test(teamId)) continue;
    if (filterTeamId && teamId !== filterTeamId) continue;
    const dir = path.join(teamsRoot, teamId, 'skills');
    let names;
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names) {
      const skillMd = path.join(dir, name, 'SKILL.md');
      if (fs.existsSync(skillMd)) out.push({ name, source: 'team', teamId, path: skillMd });
    }
  }
  return out;
}

// The set of skill names grantable to a construct owned by `teamId` (#633):
// the global pool plus that team's own team-tier pool (team-first resolution).
// Used to reject a newly-introduced unknown name on a grant save.
function knownSkillNamesFor(teamId) {
  const names = new Set();
  try {
    for (const name of fs.readdirSync(path.join(POOL_DIR, 'skills'))) {
      if (fs.existsSync(path.join(POOL_DIR, 'skills', name, 'SKILL.md'))) names.add(name);
    }
  } catch { /* no pool skills dir */ }
  if (teamId) {
    for (const s of listTeamSkills(teamId)) names.add(s.name);
  }
  return names;
}

// Resolve the on-disk target of an "extend an existing skill" (#553) at the given
// tier, with the same containment guards as the promote destination. Returns
// { dir, skillMdPath, existingSkillMd } or { error, notFound? }.
function resolveExtendTarget(teamId, tier, name) {
  let dir;
  if (tier === 'team') {
    dir = safeTeamSkillDir(teamId, name);
    if (!dir) return { error: 'Invalid team id or skill name' };
  } else if (tier === 'global') {
    dir = safeGlobalSkillDir(name);
    if (!dir) return { error: 'Invalid skill name' };
  } else {
    return { error: 'invalid tier' };
  }
  const skillMdPath = path.join(dir, 'SKILL.md');
  if (!fs.existsSync(skillMdPath)) return { error: `Skill '${name}' does not exist`, notFound: true };
  let existingSkillMd = '';
  try { existingSkillMd = fs.readFileSync(skillMdPath, 'utf8'); } catch { /* treated as empty */ }
  return { dir, skillMdPath, existingSkillMd };
}

// The skills eligible as an extend target for a given promotion tier (#553, AC2):
// team-tier skills of `teamId` for a team→team extend, the global pool for
// team→global. Each carries its provenance entryIds so the auto-matcher (AC4) can
// score entry-id lineage.
function eligibleExtendSkills(scope, teamId, tier) {
  const out = [];
  if (tier === 'team') {
    for (const s of listTeamSkills(teamId)) {
      if (!visibleTeam(scope, s.teamId)) continue;
      const prov = readSkillProvenance(path.dirname(s.path));
      out.push({ name: s.name, tier: 'team', teamId: s.teamId, entryIds: Array.isArray(prov && prov.entryIds) ? prov.entryIds : [] });
    }
  } else if (tier === 'global') {
    const poolSkillsDir = path.join(POOL_DIR, 'skills');
    try {
      for (const name of fs.readdirSync(poolSkillsDir)) {
        const dir = path.join(poolSkillsDir, name);
        if (!fs.existsSync(path.join(dir, 'SKILL.md'))) continue;
        const prov = readSkillProvenance(dir);
        out.push({ name, tier: 'global', entryIds: Array.isArray(prov && prov.entryIds) ? prov.entryIds : [] });
      }
    } catch { /* no pool skills dir */ }
  }
  return out;
}

// A compact provenance summary (#632, AC2) surfaced on Skills list rows so the
// UI can render provenance chips (auto/shared-from-team/imported) without a
// second fetch. Absent for hand-authored skills (no provenance.json). Full
// provenance lives on the lineage endpoint's `provenance` field.
function skillProvenanceSummary(dir) {
  const prov = readSkillProvenance(dir);
  if (!prov) return {};
  const out = { provenance: true };
  if (prov.originTeamId) out.originTeamId = prov.originTeamId;
  if (Array.isArray(prov.entryIds)) out.entryCount = prov.entryIds.length;
  return out;
}

// Gather EVERY known copy of a skill name across the tiers the caller can see
// (#632, AC2) — the global pool copy, every visible team copy, every visible
// agent copy — each tagged with its display identity, version summary, and
// per-copy drift state. This is the fs-bound half (reads manifests + hashes
// dirs); the pure assembler (skill-lineage.js) dedups, sorts, marks the viewed
// copy, and summarizes. A copy with no recorded origin simply carries no drift.
function gatherSkillCopies(name, scope) {
  const copies = [];
  if (!SKILL_NAME_RE.test(String(name || ''))) return copies;

  const globalDir = safeGlobalSkillDir(name);
  if (globalDir && fs.existsSync(path.join(globalDir, 'SKILL.md'))) {
    let origin = null;
    try { const man = skillManifest.readManifest(globalDir); origin = man && man.origin; } catch { /* none */ }
    const d = skillDriftSummary(globalDir, origin);
    copies.push({ tier: 'global', ...skillManifestSummary(globalDir), ...skillProvenanceSummary(globalDir), drift: d.drift, resyncable: d.resyncable, sourceVersion: d.sourceVersion });
  }

  for (const ts of listTeamSkills(null)) {
    if (ts.name !== name || !visibleTeam(scope, ts.teamId)) continue;
    const dir = safeTeamSkillDir(ts.teamId, name);
    if (!dir) continue;
    let origin = null;
    try { const man = skillManifest.readManifest(dir); origin = man && man.origin; } catch { /* none */ }
    const d = skillDriftSummary(dir, origin);
    copies.push({ tier: 'team', teamId: ts.teamId, ...skillManifestSummary(dir), ...skillProvenanceSummary(dir), drift: d.drift, resyncable: d.resyncable, sourceVersion: d.sourceVersion });
  }

  for (const agentId of listAgentDirs()) {
    const cfg = readJsonFile(path.join(AGENTS_DIR, agentId, 'config.json'), {});
    if (!visibleAgent(scope, agentMetaForScope(cfg))) continue;
    const agentSkillsBase = path.resolve(AGENTS_DIR, agentId, 'skills');
    const dir = path.resolve(agentSkillsBase, name);
    const drel = path.relative(agentSkillsBase, dir);
    if (drel.startsWith('..') || path.isAbsolute(drel)) continue;
    if (!fs.existsSync(path.join(dir, 'SKILL.md'))) continue;
    lazyStampAgentSkill(dir, agentId);
    const seededManifest = readJsonFile(path.join(resolveAgentStateDir(path.join(AGENTS_DIR, agentId)), 'seeded-skills.json'), {}) || {};
    const seeded = seededManifest[name];
    const origin = seeded && seeded.tier
      ? { tier: seeded.tier, teamId: seeded.tier === 'team' ? cfg.teamId : undefined, sourceHash: seeded.contentHash }
      : null;
    const d = skillDriftSummary(dir, origin);
    copies.push({ tier: 'agent', agentId, teamId: cfg.teamId, ...skillManifestSummary(dir), drift: d.drift, resyncable: d.resyncable, sourceVersion: d.sourceVersion });
  }
  return copies;
}

app.get('/api/skills', (req, res) => {
  const scope = getScope(req);
  const skills = [];
  const seen = new Set();

  // Pool (shared / global) skills — always visible to everyone.
  const poolSkillsDir = path.join(POOL_DIR, 'skills');
  try {
    fs.readdirSync(poolSkillsDir).forEach(name => {
      const skillMd = path.join(poolSkillsDir, name, 'SKILL.md');
      if (fs.existsSync(skillMd) && !seen.has(name)) {
        seen.add(name);
        skills.push({ name, source: 'pool', path: skillMd, ...skillDescriptionSummary(skillMd), ...skillManifestSummary(path.dirname(skillMd)), ...skillProvenanceSummary(path.dirname(skillMd)) });
      }
    });
  } catch { /* no pool skills dir */ }

  // Team-scoped skills (#306), narrowed to the caller's teams (#302). An
  // explicit `?teamId=<id>` narrows further; a team the caller can't see is
  // dropped by visibleTeam.
  const filterTeam = typeof req.query.teamId === 'string' ? req.query.teamId : null;
  skills.push(...listTeamSkills(filterTeam)
    .filter(s => visibleTeam(scope, s.teamId))
    .map(s => {
      const dir = path.dirname(s.path);
      let origin = null;
      try { const man = skillManifest.readManifest(dir); origin = man && man.origin; } catch { /* none */ }
      return { ...s, ...skillDescriptionSummary(s.path), ...skillManifestSummary(dir), ...skillProvenanceSummary(dir), ...skillDriftSummary(dir, origin) };
    }));

  // Agent skills — visible only when the owning agent is visible (#302), so an
  // agent's skills don't leak its existence across teams.
  for (const agentId of listAgentDirs()) {
    const cfg = readJsonFile(path.join(AGENTS_DIR, agentId, 'config.json'), {});
    if (!visibleAgent(scope, agentMetaForScope(cfg))) continue;
    const agentSkillsDir = path.join(AGENTS_DIR, agentId, 'skills');
    // A seeded agent copy anchors its drift on the source hash recorded at seed
    // time in .agent-studio/seeded-skills.json — NOT on the copy's own skill.json origin
    // (agent-tier dirs are stamped without one). Build a synthetic origin from it.
    const seededManifest = readJsonFile(path.join(resolveAgentStateDir(path.join(AGENTS_DIR, agentId)), 'seeded-skills.json'), {}) || {};
    try {
      fs.readdirSync(agentSkillsDir).forEach(name => {
        const skillMd = path.join(agentSkillsDir, name, 'SKILL.md');
        if (fs.existsSync(skillMd)) {
          const key = `${agentId}/${name}`;
          if (!seen.has(key)) {
            seen.add(key);
            const dir = path.join(agentSkillsDir, name);
            lazyStampAgentSkill(dir, agentId);
            const seeded = seededManifest[name];
            const origin = seeded && seeded.tier
              ? { tier: seeded.tier, teamId: seeded.tier === 'team' ? cfg.teamId : undefined, sourceHash: seeded.contentHash }
              : null;
            // Carry the owning team so the UI can deep-link the "share it" path
            // into the (team-scoped) Knowledge page for this agent (#1144).
            skills.push({ name, source: 'agent', agentId, teamId: cfg.teamId, path: skillMd, ...skillDescriptionSummary(skillMd), ...skillManifestSummary(dir), ...skillProvenanceSummary(dir), ...skillDriftSummary(dir, origin) });
          }
        }
      });
    } catch { /* no agent skills dir */ }
  }

  res.json(skills);
});

app.get('/api/skills/:name/content', (req, res) => {
  const { name } = req.params;
  const { source, agentId } = req.query;
  if (!SKILL_NAME_RE.test(name)) return res.status(400).json({ error: 'Invalid skill name' });

  let skillPath;
  if (source === 'agent' && typeof agentId === 'string' && AGENT_ID_RE.test(agentId)) {
    skillPath = path.join(AGENTS_DIR, path.basename(agentId), 'skills', path.basename(name), 'SKILL.md');
  } else if (source === 'agent') {
    return res.status(400).json({ error: 'Invalid agent id' });
  } else if (source === 'team') {
    const dir = safeTeamSkillDir(req.query.teamId, name);
    if (!dir) return res.status(400).json({ error: 'Invalid team id or skill name' });
    skillPath = path.join(dir, 'SKILL.md');
  } else {
    skillPath = path.join(POOL_DIR, 'skills', path.basename(name), 'SKILL.md');
  }

  if (!fs.existsSync(skillPath)) return res.status(404).json({ error: 'Skill not found' });
  const content = fs.readFileSync(skillPath, 'utf8');
  const dir = path.dirname(skillPath);
  if (source === 'agent') lazyStampAgentSkill(dir, path.basename(agentId));
  res.json({ content, ...skillManifestSummary(dir) });
});

// Full lineage view for one skill copy (#632, epic #624 phase 5) — the data the
// Skills detail panel's Versions + Lineage tabs render: the viewed copy's
// version history + origin (its skill.json), its knowledge provenance
// (provenance.json), and every known copy of the same name across tiers with
// drift. `?source=pool|team|agent` (+ `teamId`/`agentId`) identifies the viewed
// copy; visibility is scope-gated per tier. The pure assembler shapes the view.
app.get('/api/skills/:name/lineage', (req, res) => {
  const { name } = req.params;
  if (!SKILL_NAME_RE.test(name)) return res.status(400).json({ error: 'Invalid skill name' });
  const scope = getScope(req);

  const source = typeof req.query.source === 'string' ? req.query.source : 'pool';
  const qTeamId = typeof req.query.teamId === 'string' ? req.query.teamId : undefined;
  const qAgentId = typeof req.query.agentId === 'string' ? req.query.agentId : undefined;

  let viewed;
  let viewedDir;
  if (source === 'agent') {
    if (!qAgentId || !AGENT_ID_RE.test(qAgentId)) return res.status(400).json({ error: 'Invalid agent id' });
    const cfg = readJsonFile(path.join(AGENTS_DIR, qAgentId, 'config.json'), null);
    if (!cfg || !visibleAgent(scope, agentMetaForScope(cfg))) return res.status(404).json({ error: 'Skill not found' });
    viewed = { tier: 'agent', agentId: qAgentId, teamId: cfg.teamId };
    viewedDir = safeAgentSkillDir(qAgentId, name);
    if (!viewedDir) return res.status(400).json({ error: 'Invalid agent id or skill name' });
  } else if (source === 'team') {
    viewedDir = safeTeamSkillDir(qTeamId, name);
    if (!viewedDir) return res.status(400).json({ error: 'Invalid team id or skill name' });
    if (!visibleTeam(scope, qTeamId)) return res.status(404).json({ error: 'Skill not found' });
    viewed = { tier: 'team', teamId: qTeamId };
  } else {
    viewedDir = safeGlobalSkillDir(name);
    if (!viewedDir) return res.status(400).json({ error: 'Invalid skill name' });
    viewed = { tier: 'global' };
  }
  if (!fs.existsSync(path.join(viewedDir, 'SKILL.md'))) return res.status(404).json({ error: 'Skill not found' });

  let manifest = null;
  try { manifest = skillManifest.readManifest(viewedDir); } catch { manifest = null; }
  const provenance = readSkillProvenance(viewedDir);
  const copies = gatherSkillCopies(name, scope);

  res.json(skillLineage.assembleLineage({ name, viewed, manifest, provenance, copies }));
});

/* ─── Skill directory contents (multi-file browser/editor) ───────────── */

const SKILL_FILE_MAX_BYTES = 512 * 1024; // 512 KB read cap per file

// Resolve a skill's root directory for the given source. Returns the absolute
// path or null when the source/name/agentId are invalid. Does not check that
// the directory exists.
function skillRootDir(source, name, agentId, teamId) {
  if (typeof name !== 'string' || !SKILL_NAME_RE.test(name)) return null;
  if (source === 'agent') {
    if (typeof agentId !== 'string' || !AGENT_ID_RE.test(agentId)) return null;
    return path.join(AGENTS_DIR, path.basename(agentId), 'skills', path.basename(name));
  }
  if (source === 'team') {
    return safeTeamSkillDir(teamId, name); // null when teamId/name invalid
  }
  return path.join(POOL_DIR, 'skills', path.basename(name));
}

// Resolve a relative file path inside a skill directory, refusing anything
// that escapes the root (traversal, absolute paths, outward symlinks). Mirrors
// safeAgentPath. Returns the absolute path on success, null otherwise. The
// target file must already exist (realpath fails on ENOENT).
function safeSkillFilePath(rootDir, relFile) {
  let realRoot;
  try { realRoot = fs.realpathSync(rootDir); } catch { return null; }
  const normalized = path.normalize(String(relFile || '').replace(/^\/+/, ''));
  if (!normalized || normalized === '.') return null;
  if (normalized.split(path.sep).some(seg => seg === '..')) return null;
  const target = path.resolve(realRoot, normalized);
  let realTarget;
  try { realTarget = fs.realpathSync(target); } catch { return null; }
  // Canonical path.relative containment idiom — recognised as a CodeQL
  // js/path-injection barrier on the returned value; behaviour-equivalent to
  // the previous `startsWith(realRoot + sep)` check.
  const rel = path.relative(realRoot, realTarget);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return realTarget;
}

// Recursively list regular files in a skill directory (relative POSIX paths).
// Symlinked directories are not descended (withFileTypes reports them as
// non-directories), which also prevents symlink loops.
function listSkillFiles(rootDir) {
  const out = [];
  const walk = (dir, rel) => {
    if (out.length > 2000) return; // defensive cap
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const d of entries) {
      const relPath = rel ? `${rel}/${d.name}` : d.name;
      const full = path.join(dir, d.name);
      if (d.isDirectory()) {
        walk(full, relPath);
      } else if (d.isFile()) {
        let size = 0;
        try { size = fs.statSync(full).size; } catch { /* transient */ }
        out.push({ path: relPath, size });
      }
    }
  };
  walk(rootDir, '');
  out.sort((a, b) => a.path.localeCompare(b.path, undefined, { sensitivity: 'base' }));
  return out;
}

// List every file in a skill directory (not just SKILL.md) so the registry can
// show what a skill actually contains (scripts, data, sub-skills, …).
app.get('/api/skills/:name/files', (req, res) => {
  const { name } = req.params;
  const { source, agentId, teamId } = req.query;
  const root = skillRootDir(source, name, agentId, teamId);
  if (!root) return res.status(400).json({ error: 'Invalid skill name, agent id or team id' });
  if (!fs.existsSync(path.join(root, 'SKILL.md'))) return res.status(404).json({ error: 'Skill not found' });
  res.json({ files: listSkillFiles(root) });
});

// Read a single file from a skill directory. Caps reads and flags binary files
// (NUL byte in the prefix) so the UI can show a placeholder instead of garbage.
app.get('/api/skills/:name/file', (req, res) => {
  const { name } = req.params;
  const { source, agentId, file, teamId } = req.query;
  const root = skillRootDir(source, name, agentId, teamId);
  if (!root) return res.status(400).json({ error: 'Invalid skill name, agent id or team id' });
  const target = safeSkillFilePath(root, file);
  if (!target) return res.status(400).json({ error: 'invalid path' });

  let st;
  try { st = fs.statSync(target); } catch { return res.status(404).json({ error: 'not found' }); }
  if (!st.isFile()) return res.status(400).json({ error: 'not a file' });

  const truncated = st.size > SKILL_FILE_MAX_BYTES;
  const readSize = Math.min(st.size, SKILL_FILE_MAX_BYTES);
  let buf;
  try {
    const fd = fs.openSync(target, 'r');
    try {
      buf = Buffer.alloc(readSize);
      if (readSize > 0) fs.readSync(fd, buf, 0, readSize, 0);
    } finally { fs.closeSync(fd); }
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  const probe = buf.slice(0, Math.min(buf.length, 8192));
  const isBinary = probe.includes(0);
  res.json({
    path: String(file),
    size: st.size,
    truncated,
    binary: isBinary,
    content: isBinary ? null : buf.toString('utf8'),
  });
});

// Overwrite a single file inside a POOL skill directory. Agent skills stay
// read-only (mirrors PUT /api/skills/:name). Only existing files are editable
// — safeSkillFilePath rejects paths that don't resolve to an existing file,
// so this cannot create new files or escape the skill directory.
app.put('/api/skills/:name/file', (req, res) => {
  const { name } = req.params;
  const { source, file, teamId } = req.query;
  if (source === 'agent') {
    return res.status(403).json({ error: 'Agent skills are read-only from the registry. Promote the skill to the pool to edit it.' });
  }
  const root = skillRootDir(source, name, undefined, teamId);
  if (!root) return res.status(400).json({ error: 'Invalid skill name or team id' });
  const target = safeSkillFilePath(root, file);
  if (!target) return res.status(400).json({ error: 'invalid path' });
  if (!fs.statSync(target).isFile()) return res.status(400).json({ error: 'not a file' });

  const { content } = req.body || {};
  if (typeof content !== 'string') return res.status(400).json({ error: 'content must be a string' });
  try {
    fs.writeFileSync(target, content, 'utf8');
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
  stampSkill(root, { name, by: skillActor(req), action: 'edited' });
  autoResyncOnEdit(name, source === 'team' ? { tier: 'team', teamId } : { tier: 'global' });
  res.json({ path: String(file), source: 'pool' });
});

// Stream a ZIP archive of an entire skill directory (pool or agent source).
// The archive contains a single top-level folder named after the skill, so it
// round-trips cleanly through POST /api/skills/import.
app.get('/api/skills/:name/export', heavyLimiter, async (req, res) => {
  const { name } = req.params;
  const { source, agentId, teamId } = req.query;
  const root = skillRootDir(source, name, agentId, teamId);
  if (!root) return res.status(400).json({ error: 'Invalid skill name, agent id or team id' });
  if (!fs.existsSync(path.join(root, 'SKILL.md'))) return res.status(404).json({ error: 'Skill not found' });

  const parentDir = path.dirname(root);
  const dirName = path.basename(root);
  // Scratch dir is created inside the try: this handler is async, so a throw
  // outside it would surface as an unhandled rejection instead of a 500.
  let zipDir = null;
  try {
    // Scratch zip lives in /tmp so `zip -r` doesn't try to archive its own output.
    zipDir = fs.mkdtempSync(path.join('/tmp', 'skill-zip-'));
    const zipPath = path.join(zipDir, 'skill.zip');
    const zipResult = await runArchiveTool('zip', ['-r', '-q', zipPath, dirName], { cwd: parentDir });
    if (zipResult.code !== 0) {
      throw new Error(describeArchiveFailure('zip', zipResult));
    }
    const stat = fs.statSync(zipPath);
    res.setHeader('Content-Disposition', `attachment; filename="skill-${name}.zip"`);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Length', stat.size);
    const stream = fs.createReadStream(zipPath);
    stream.on('close', () => { try { fs.rmSync(zipDir, { recursive: true, force: true }); } catch { /* noop */ } });
    stream.pipe(res);
  } catch (err) {
    if (zipDir) { try { fs.rmSync(zipDir, { recursive: true, force: true }); } catch { /* noop */ } }
    console.error(`[API] Skill export failed for ${name}: ${err.message}`);
    res.status(500).json({ error: `Export failed: ${err.message}` });
  }
});

// Accepts a ZIP (field: "file") of a skill directory and imports it into a pool
// tier with an identity round-trip (#628, concept §3.5). The ZIP may carry the
// files at its root or nested under a single top-level folder (as produced by
// /export). Form fields: `tier` (global | team, default global), `teamId` (for
// the team tier), `name` (overrides the inferred skill name), `onCollision`
// (reject | overwrite | rename, default reject — aligned with the transfer
// engine). The target tier is permission-gated like a transfer (Team Admin →
// own team pool, System Admin → global). The pure validator/planner lives in
// skill-import.js; this endpoint does the file work.
const _skillImportUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

app.post('/api/skills/import', heavyLimiter, _skillImportUpload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file provided (field name: file)' });

  const tmpDir = fs.mkdtempSync(path.join('/tmp', 'skill-import-'));
  const zipPath = path.join(tmpDir, 'upload.zip');
  const extractDir = path.join(tmpDir, 'extracted');
  try {
    fs.writeFileSync(zipPath, req.file.buffer);
    fs.mkdirSync(extractDir);

    // A .skill file is just a ZIP under the hood, so unzip handles both .zip and
    // .skill uploads — extraction is content-based and ignores the file extension.
    const unzipResult = await runArchiveTool('unzip', ['-q', '-o', zipPath, '-d', extractDir]);
    if (unzipResult.code !== 0) {
      console.error(`[API] Skill import: ${describeArchiveFailure('unzip', unzipResult)}`);
      return res.status(400).json({ error: 'Could not extract archive — ensure the file is a valid .zip or .skill skill archive' });
    }

    // Zip-slip protection: verify every extracted path stays within extractDir.
    const realExtractDir = fs.realpathSync(extractDir);
    function checkExtractedPaths(dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        try {
          const real = fs.realpathSync(full);
          if (!real.startsWith(realExtractDir + path.sep) && real !== realExtractDir) {
            throw new Error(`Unsafe path in ZIP: ${real}`);
          }
        } catch (e) {
          if (e.message && e.message.startsWith('Unsafe')) throw e;
          // realpathSync on a dangling symlink throws ENOENT — skip safely
        }
        if (entry.isDirectory()) checkExtractedPaths(full);
      }
    }
    checkExtractedPaths(extractDir);

    // Locate the skill root inside the archive: either SKILL.md at the top, or
    // a single top-level directory that contains SKILL.md.
    const topEntries = fs.readdirSync(extractDir, { withFileTypes: true })
      .filter(e => e.name !== '__MACOSX');
    let skillRoot = null;
    let inferredName = null;
    if (fs.existsSync(path.join(extractDir, 'SKILL.md'))) {
      skillRoot = extractDir;
    } else {
      const dirs = topEntries.filter(e => e.isDirectory());
      if (dirs.length === 1 && fs.existsSync(path.join(extractDir, dirs[0].name, 'SKILL.md'))) {
        skillRoot = path.join(extractDir, dirs[0].name);
        inferredName = dirs[0].name;
      }
    }
    if (!skillRoot) {
      return res.status(400).json({ error: 'Archive does not contain a SKILL.md (at the root or in a single top-level folder)' });
    }

    // AC2: validate the archive's SKILL.md — frontmatter must carry a non-empty
    // name + description. (Zip-slip + the 50 MB multer cap are the other AC2
    // guards, enforced above / by the upload middleware.)
    let skillMd = '';
    try { skillMd = fs.readFileSync(path.join(skillRoot, 'SKILL.md'), 'utf8'); } catch { /* handled below */ }
    const md = skillImport.validateSkillMd(skillMd);
    if (!md.ok) return res.status(400).json({ error: md.error });

    // Validate + plan the import target (tier / name / collision + permission).
    const rawName = (typeof req.body?.name === 'string' && req.body.name.trim()) || inferredName;
    const plan = skillImport.planImport(
      { tier: req.body?.tier, teamId: req.body?.teamId, onCollision: req.body?.onCollision, name: rawName },
      { skillNameRe: SKILL_NAME_RE, teamIdRe: POOL_TEAM_ID_RE },
    );
    if (!plan.ok) return res.status(400).json({ error: plan.error });

    // Permission gate — the transfer rules (Team Admin for a team pool, System
    // Admin for global). Reuses the shared permit checker.
    const scope = getScope(req);
    const permit = skillTransfer.permitTransfer(plan.permission, {
      systemAdmin: !!scope.all,
      isTeamAdmin: (teamId) => canManageTeam(scope, teamId),
    });
    if (!permit.ok) return res.status(403).json({ error: permit.error });

    if (plan.tier === 'team' && !resolveTeamExists(plan.teamId)) {
      return res.status(400).json({ error: `Team '${plan.teamId}' not found` });
    }

    // Resolve the destination honouring the collision mode (containment-guarded
    // via the shared resolver, so CodeQL sees the guard in-flow).
    let destName = plan.name;
    if (plan.onCollision === 'rename') {
      destName = skillTransfer.resolveCollisionName(plan.name, (n) => transferSkillExistsAt(plan, n));
    } else if (plan.onCollision === 'reject' && transferSkillExistsAt(plan, plan.name)) {
      return res.status(409).json({ error: `Skill '${plan.name}' already exists at the destination`, exists: true });
    }
    const dst = resolveTransferSkillDir(plan, destName);
    if (dst.error) return res.status(400).json({ error: dst.error });

    // Copy the whole skill dir (embedded skill.json + provenance.json carried
    // forward by cpSync).
    if (plan.onCollision === 'overwrite') fs.rmSync(dst.dir, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(dst.dir), { recursive: true });
    fs.cpSync(skillRoot, dst.dir, { recursive: true });

    // Identity round-trip (AC3/AC4): honour an embedded skill.json — the version
    // chain continues and an `imported` event is appended (forceHistory records
    // it even when the content is byte-identical), origin becomes external. A
    // foreign archive with no manifest is stamped fresh at v1, action `imported`.
    stampSkill(dst.dir, {
      name: destName, by: skillActor(req), action: 'imported',
      origin: { tier: 'external' }, forceHistory: true,
    });
    appendSkillFeedEvent({ type: 'skill-imported', ref: plan, name: destName, by: skillActor(req) });

    const source = plan.tier === 'team' ? 'team' : 'pool';
    const out = { name: destName, source };
    if (plan.tier === 'team') out.teamId = plan.teamId;
    res.status(201).json(out);
  } catch (err) {
    console.error(`[API] Skill import failed: ${err.message}`);
    res.status(500).json({ error: `Import failed: ${err.message}` });
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
  }
});

app.post('/api/skills', (req, res) => {
  const { name, content = '', source, teamId } = req.body || {};
  if (typeof name !== 'string' || !SKILL_NAME_RE.test(name)) {
    return res.status(400).json({ error: 'Invalid skill name' });
  }
  // Team-scoped skill (#306): write into /workspace/teams/<teamId>/skills.
  if (source === 'team') {
    const skillDir = safeTeamSkillDir(teamId, name);
    if (!skillDir) return res.status(400).json({ error: 'Invalid team id or skill name' });
    if (!resolveTeamExists(teamId)) return res.status(400).json({ error: `Team '${teamId}' not found` });
    const skillPath = path.join(skillDir, 'SKILL.md');
    if (fs.existsSync(skillPath)) {
      return res.status(409).json({ error: `Skill '${name}' already exists in team '${teamId}'` });
    }
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(skillPath, typeof content === 'string' ? content : '', 'utf8');
    stampSkill(skillDir, { name, by: skillActor(req), action: 'created' });
    return res.status(201).json({ name, source: 'team', teamId });
  }
  const skillDir = path.join(POOL_DIR, 'skills', path.basename(name));
  const skillPath = path.join(skillDir, 'SKILL.md');
  if (fs.existsSync(skillPath)) {
    return res.status(409).json({ error: `Skill '${name}' already exists` });
  }
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(skillPath, typeof content === 'string' ? content : '', 'utf8');
  stampSkill(skillDir, { name, by: skillActor(req), action: 'created' });
  res.status(201).json({ name, source: 'pool' });
});

// Promote a skill from an agent workspace into the shared pool, copying the
// ENTIRE skill directory (SKILL.md plus any scripts/assets) recursively so it
// can be reused by other agents. Refuses to clobber an existing pool skill
// unless `overwrite: true` is passed.
// DEPRECATED (#626): superseded by POST /api/skills/transfer. The agent→global
// cell is retired from the transition matrix (go via the team tier), so this
// path is kept only for older clients and removed from the UI.
app.post('/api/skills/promote', (req, res) => {
  const { agentId, name, overwrite = false } = req.body || {};
  if (typeof name !== 'string' || !SKILL_NAME_RE.test(name)) {
    return res.status(400).json({ error: 'Invalid skill name' });
  }
  if (typeof agentId !== 'string' || !AGENT_ID_RE.test(agentId)) {
    return res.status(400).json({ error: 'Invalid agent id' });
  }

  // Containment check: AGENT_ID_RE / SKILL_NAME_RE already exclude traversal
  // segments, but the path.resolve + path.relative pattern is what CodeQL's
  // path-injection query recognises in-flow.
  const agentsBaseDir = path.resolve(AGENTS_DIR);
  const srcDir = path.resolve(agentsBaseDir, agentId, 'skills', name);
  const srcRel = path.relative(agentsBaseDir, srcDir);
  if (srcRel.startsWith('..') || path.isAbsolute(srcRel)) {
    return res.status(400).json({ error: 'Invalid agent id or skill name' });
  }
  const poolSkillsBaseDir = path.resolve(POOL_DIR, 'skills');
  const dstDir = path.resolve(poolSkillsBaseDir, name);
  const dstRel = path.relative(poolSkillsBaseDir, dstDir);
  if (dstRel.startsWith('..') || path.isAbsolute(dstRel)) {
    return res.status(400).json({ error: 'Invalid skill name' });
  }

  if (!fs.existsSync(path.join(srcDir, 'SKILL.md'))) {
    return res.status(404).json({ error: `Skill '${name}' not found for agent '${agentId}'` });
  }
  if (fs.existsSync(dstDir) && !overwrite) {
    return res.status(409).json({ error: `Skill '${name}' already exists in the pool`, exists: true });
  }

  const srcId = skillSourceIdentity(srcDir);
  try {
    if (overwrite) fs.rmSync(dstDir, { recursive: true, force: true });
    fs.cpSync(srcDir, dstDir, { recursive: true });
  } catch (err) {
    return res.status(500).json({ error: `Failed to promote skill: ${err.message}` });
  }
  stampSkillCopy(dstDir, {
    name, by: skillActor(req), action: 'promoted',
    origin: skillOrigin({ tier: 'agent', agentId, sourceVersion: srcId.sourceVersion, sourceHash: srcId.sourceHash }),
  });
  res.status(201).json({ name, source: 'pool', overwritten: !!overwrite });
});

// Install a pool skill into an EXISTING agent's workspace. This delegates to
// the orchestrator's skill-activation path (`/internal/agents/:id/skills/
// activate`) so install WRITES THE GRANT (config `skills[]` / a team-member's
// `skillsOverride`), not just an ad-hoc file copy — a subsequent full re-seed
// then retains the skill and the seeded manifest can no longer diverge from the
// grant (#630 AC1). Activation is the concept's default last step of every
// pool-filling flow. Refuses to clobber an existing agent skill unless
// `overwrite: true` is passed. The running agent picks the skill up on its next
// invocation (additive sync, no respawn).
app.post('/api/skills/install', async (req, res) => {
  const { agentId, name, overwrite = false } = req.body || {};
  if (typeof name !== 'string' || !SKILL_NAME_RE.test(name)) {
    return res.status(400).json({ error: 'Invalid skill name' });
  }
  if (typeof agentId !== 'string' || !AGENT_ID_RE.test(agentId)) {
    return res.status(400).json({ error: 'Invalid agent id' });
  }

  // Containment check: AGENT_ID_RE / SKILL_NAME_RE already exclude traversal
  // segments, but the path.resolve + path.relative pattern is what CodeQL's
  // path-injection query recognises in-flow.
  const agentsBaseDir = path.resolve(AGENTS_DIR);
  const agentDirPath = path.resolve(agentsBaseDir, agentId);
  const dstDir = path.resolve(agentDirPath, 'skills', name);
  const dstRel = path.relative(agentsBaseDir, dstDir);
  if (dstRel.startsWith('..') || path.isAbsolute(dstRel)) {
    return res.status(400).json({ error: 'Invalid agent id or skill name' });
  }

  const cfg = readJsonFile(path.join(agentDirPath, 'config.json'), null);
  if (!cfg) return res.status(404).json({ error: `Agent '${agentId}' not found` });
  // A stub (not yet materialized) has no workspace to install into; enabling it
  // would re-seed from the environment anyway. Require a materialized agent.
  if (cfg.enabled === false || !cfg.token) {
    return res.status(409).json({ error: `Agent '${agentId}' is not active — enable it before installing skills` });
  }
  const scope = getScope(req);
  // D9 (#2080): "Install into agent" writes the grant and copies files into the
  // workspace — an agent-settings change, so Team Admin only. Was
  // `visibleAgent`, i.e. any member of the owning team.
  if (!canManageAgent(scope, agentMetaForScope(cfg))) return res.status(403).json({ error: 'forbidden' });
  // Refuse to clobber a skill the agent already carries unless overwrite:true —
  // an existing workspace dir OR a grant already listing the name both count.
  // Resolve the grant inline the same way as elsewhere (team-owned, orchestrator/
  // skill-grants.js): member override wins, else own skills[], else the parent
  // team's list. `team-member` is the only inheriting role — `bp-instance` went
  // with the BriefingPack model (#1962). The admin-console does not
  // cross-require orchestrator code.
  const parentId = cfg.role === 'team-member' ? cfg.parentTeamId : null;
  const parentCfg = parentId ? readJsonFile(path.join(AGENTS_DIR, parentId, 'config.json'), null) : null;
  const granted = Array.isArray(cfg.skillsOverride) ? cfg.skillsOverride
    : Array.isArray(cfg.skills) ? cfg.skills
    : (parentCfg && Array.isArray(parentCfg.skills)) ? parentCfg.skills
    : [];
  if ((fs.existsSync(dstDir) || granted.includes(name)) && !overwrite) {
    return res.status(409).json({ error: `Agent '${agentId}' already has a skill named '${name}'`, exists: true });
  }

  // Delegate the grant edit + workspace sync to the orchestrator so its
  // in-memory config map, the seeded manifest, and CLAUDE.md all stay consistent
  // with the grant (the team-first source resolution matches a full re-seed).
  const orchestratorUrl = process.env.ORCHESTRATOR_URL || 'http://orchestrator:4002';
  try {
    const resp = await fetch(`${orchestratorUrl}/internal/agents/${encodeURIComponent(agentId)}/skills/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skillName: name }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) return res.status(resp.status).json(data);
    if (data?.result?.status === 'error') {
      return res.status(404).json({ error: data.result.error || `Skill '${name}' not found in the pool` });
    }
    return res.status(201).json({ name, agentId, installed: true, overwritten: !!overwrite });
  } catch (err) {
    return res.status(502).json({ error: `Orchestrator unreachable: ${err.message}` });
  }
});

app.put('/api/skills/:name', (req, res) => {
  const { name } = req.params;
  const { source } = req.query;
  if (!SKILL_NAME_RE.test(name)) return res.status(400).json({ error: 'Invalid skill name' });
  if (source === 'agent') {
    return res.status(403).json({ error: 'Agent skills are read-only from the registry. Use the propagation flow to promote a skill to the pool.' });
  }
  const { content } = req.body || {};
  if (typeof content !== 'string') return res.status(400).json({ error: 'content must be a string' });
  if (source === 'team') {
    const dir = safeTeamSkillDir(req.query.teamId, name);
    if (!dir) return res.status(400).json({ error: 'Invalid team id or skill name' });
    const teamSkillPath = path.join(dir, 'SKILL.md');
    if (!fs.existsSync(teamSkillPath)) return res.status(404).json({ error: 'Skill not found' });
    fs.writeFileSync(teamSkillPath, content, 'utf8');
    stampSkill(dir, { name, by: skillActor(req), action: 'edited' });
    autoResyncOnEdit(name, { tier: 'team', teamId: req.query.teamId });
    return res.json({ name, source: 'team', teamId: req.query.teamId });
  }
  const skillDir = path.join(POOL_DIR, 'skills', path.basename(name));
  const skillPath = path.join(skillDir, 'SKILL.md');
  if (!fs.existsSync(skillPath)) return res.status(404).json({ error: 'Skill not found' });
  fs.writeFileSync(skillPath, content, 'utf8');
  stampSkill(skillDir, { name, by: skillActor(req), action: 'edited' });
  autoResyncOnEdit(name, { tier: 'global' });
  res.json({ name, source: 'pool' });
});

/* ─── Uniform guarded skill deletion (#627, docs/skill-lifecycle-concept.md §3.3)
 * One rule on all three tiers, replacing the old mix (guarded global / blind
 * team / 403 agent): a delete is GUARDED (refused while a granting construct's
 * name RESOLVES to the tier being deleted, unless `cascade` deactivates those
 * grants first), snapshots the dir to the shared skill-archive before removing
 * it (restorable), and is permission-gated (Team Admin for a team skill, System
 * Admin for global/agent). The pure planner/validator/prune lives in
 * skill-deletion.js; this endpoint does the file work + orchestrator cascade. */

// Where does `name` resolve for an agent construct — agent → team → global,
// mirroring orchestrator/skill-source.js against the admin-console mounts.
// Returns the tier ref the grant currently lands on, or null when nothing
// backs the name anywhere.
function resolveGrantTier(agentId, teamId, name) {
  const agentDir = path.join(AGENTS_DIR, path.basename(agentId), 'skills', path.basename(name));
  if (fs.existsSync(path.join(agentDir, 'SKILL.md'))) return { tier: 'agent', agentId };
  const teamDir = safeTeamSkillDir(teamId, name);
  if (teamDir && fs.existsSync(path.join(teamDir, 'SKILL.md'))) return { tier: 'team', teamId };
  const globalDir = path.join(POOL_DIR, 'skills', path.basename(name));
  if (fs.existsSync(path.join(globalDir, 'SKILL.md'))) return { tier: 'global' };
  return null;
}

// The grants that would be stranded by deleting `plan`'s tier: every construct
// that grants the name AND whose resolution currently lands on the tier being
// deleted (concept §3.3 — "refuse while a grant resolves to this tier"). An
// inheriting member is represented by its squad's grant (its own config carries
// no skills[]); a squad / standalone / override-member is named directly.
function blockingGrantsForDeletion(plan) {
  const out = [];
  let ids;
  try { ids = fs.readdirSync(AGENTS_DIR); } catch { return out; }
  for (const id of ids) {
    const cfg = readJsonFile(path.join(AGENTS_DIR, id, 'config.json'), null);
    if (!cfg) continue;
    const hasOverride = Array.isArray(cfg.skillsOverride) && cfg.skillsOverride.includes(plan.name);
    const grants = hasOverride || (Array.isArray(cfg.skills) && cfg.skills.includes(plan.name));
    if (!grants) continue;
    const teamId = cfg.teamId || DEFAULT_TEAM_ID;
    const r = resolveGrantTier(cfg.id || id, teamId, plan.name);
    if (!r) continue;
    const hits = plan.tier === 'team' ? (r.tier === 'team' && r.teamId === plan.teamId)
      : plan.tier === 'agent' ? (r.tier === 'agent' && r.agentId === plan.agentId)
      : (r.tier === 'global');
    if (hits) out.push({ id: cfg.id || id, teamId, role: cfg.role, parentTeamId: cfg.parentTeamId, hasOverride });
  }
  return out;
}

// Cascade: deactivate every blocking grant through the orchestrator's existing
// (de)activation path (workspace sync + manifest + CLAUDE.md rebuild) so the
// same code that would toggle a skill off does the retirement. Best-effort —
// the caller re-scans the guard afterwards and only deletes if it is clear.
async function cascadeDeactivateForDeletion(plan) {
  const orchestratorUrl = process.env.ORCHESTRATOR_URL || 'http://orchestrator:4002';
  const blocking = blockingGrantsForDeletion(plan);
  const teamCalls = new Map(); // squadId -> Set(override memberIds to strip)
  const agentCalls = new Set();
  for (const b of blocking) {
    if (b.role === 'team') { if (!teamCalls.has(b.id)) teamCalls.set(b.id, new Set()); }
    else if (b.role === 'team-member' && b.parentTeamId) {
      if (!teamCalls.has(b.parentTeamId)) teamCalls.set(b.parentTeamId, new Set());
      if (b.hasOverride) teamCalls.get(b.parentTeamId).add(b.id);
    } else { agentCalls.add(b.id); }
  }
  const results = [];
  for (const [squadId, includeMembers] of teamCalls) {
    try {
      const resp = await fetch(`${orchestratorUrl}/internal/teams/${encodeURIComponent(squadId)}/skills/deactivate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skillName: plan.name, includeMembers: [...includeMembers] }),
      });
      results.push({ squadId, status: resp.status });
    } catch (err) { results.push({ squadId, error: err.message }); }
  }
  for (const agentId of agentCalls) {
    try {
      const resp = await fetch(`${orchestratorUrl}/internal/agents/${encodeURIComponent(agentId)}/skills/deactivate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skillName: plan.name }),
      });
      results.push({ agentId, status: resp.status });
    } catch (err) { results.push({ agentId, error: err.message }); }
  }
  return results;
}

// Reconstruct a tier ref from an archive segment (`global` / `team-<id>` /
// `agent-<id>`) for archive entries with no meta sidecar (e.g. move snapshots).
function segToRef(seg, name) {
  if (seg === 'global') return { tier: 'global', name };
  if (seg.startsWith('team-')) return { tier: 'team', teamId: seg.slice(5), name };
  if (seg.startsWith('agent-')) return { tier: 'agent', agentId: seg.slice(6), name };
  return null;
}

// Snapshot a skill dir to the shared archive before deletion (restorable — AC3).
// Uses the SAME `<tierSeg>/<name>-<hash>-<ts>` layout skill-transfer.js's move
// archive writes, plus an archive-meta.json sidecar carrying the tier the skill
// came from so a restore round-trips its metadata. Returns { id, dir } or null.
function archiveDeletedSkill(srcDir, plan, name, srcId, req, now = Date.now()) {
  try {
    const { seg, stamp, id } = skillDeletion.archiveStamp(plan, name, srcId.sourceHash, now);
    const base = path.resolve(WORKSPACE, 'skill-archive');
    const dst = path.resolve(base, seg, stamp);
    const rel = path.relative(base, dst);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.cpSync(srcDir, dst, { recursive: true });
    fs.writeFileSync(path.join(dst, 'archive-meta.json'), JSON.stringify({
      id, tier: plan.tier, name, teamId: plan.teamId, agentId: plan.agentId,
      hash: srcId.sourceHash || null, version: srcId.sourceVersion,
      deletedAt: new Date(now).toISOString(), by: skillActor(req),
    }, null, 2));
    return { id, dir: dst };
  } catch { return null; }
}

// Append a skill lifecycle event (skill-deleted / skill-restored, issue item 6)
// to the shared knowledge live feed. Best-effort, same file the transfer event
// and (de)activation events use.
function appendSkillFeedEvent({ type, ref, name, archiveId, by }) {
  try {
    fs.mkdirSync(path.dirname(KNOWLEDGE_EVENTS_FILE), { recursive: true });
    fs.appendFileSync(KNOWLEDGE_EVENTS_FILE, JSON.stringify({
      type, ts: new Date().toISOString(),
      tier: ref.tier,
      teamId: ref.tier === 'team' ? ref.teamId : undefined,
      agentId: ref.tier === 'agent' ? ref.agentId : undefined,
      skillName: name, archiveId: archiveId || undefined, by,
    }) + '\n');
  } catch { /* best effort */ }
}

app.delete('/api/skills/:name', heavyLimiter, async (req, res) => {
  // 1. Validate + plan (pure). `source` is the historic query alias for `tier`;
  //    query + body are merged so the CLI query-string form and a JSON body both
  //    work. Regexes are the api.js originals so a valid plan is always writable.
  const plan = skillDeletion.planDeletion(
    { ...req.query, ...(req.body || {}), name: req.params.name },
    { skillNameRe: SKILL_NAME_RE, agentIdRe: AGENT_ID_RE, teamIdRe: POOL_TEAM_ID_RE },
  );
  if (!plan.ok) return res.status(400).json({ error: plan.error });

  // 2. Permission gate: Team Admin for a team skill (AC4 — no System Admin
  //    needed), System Admin for global/agent.
  const scope = getScope(req);
  const permit = skillDeletion.permitDeletion(plan.permission, {
    systemAdmin: !!scope.all,
    isTeamAdmin: (teamId) => canManageTeam(scope, teamId),
  });
  if (!permit.ok) return res.status(403).json({ error: permit.error });

  // 3. Resolve the target dir (containment-guarded) + verify it exists.
  const target = resolveTransferSkillDir(plan, plan.name);
  if (target.error) return res.status(400).json({ error: target.error });
  if (!fs.existsSync(path.join(target.dir, 'SKILL.md'))) {
    return res.status(404).json({ error: 'Skill not found' });
  }

  // 4. Snapshot FIRST (a cascade on the agent tier removes the very dir), then
  //    guard / cascade. Roll the snapshot back if the delete is ultimately
  //    refused so a blocked attempt never leaves an orphan archive.
  const srcId = skillSourceIdentity(target.dir);
  const archived = archiveDeletedSkill(target.dir, plan, plan.name, srcId, req);

  // 5. Uniform guard: refuse while a grant resolves to this tier. `cascade`
  //    deactivates the blocking grants first, then we re-scan.
  let cascade = null;
  if (plan.cascade) cascade = await cascadeDeactivateForDeletion(plan);
  const blocking = blockingGrantsForDeletion(plan);
  if (blocking.length > 0) {
    if (archived) { try { fs.rmSync(archived.dir, { recursive: true, force: true }); } catch { /* best effort */ } }
    return res.status(409).json({
      error: 'Skill is in use',
      agents: blocking.map((b) => b.id),
      hint: plan.cascade ? 'grants remain after cascade' : 'pass cascade:true to deactivate the blocking grants first',
    });
  }

  // 6. Remove the tier's copy (a cascade on the agent tier may already have
  //    removed it — rmSync is then a no-op).
  try { fs.rmSync(target.dir, { recursive: true, force: true }); }
  catch (err) {
    return res.status(500).json({ error: `Failed to delete skill: ${err.message}` });
  }

  // 7. Live-feed event (issue item 6).
  appendSkillFeedEvent({ type: 'skill-deleted', ref: plan, name: plan.name, archiveId: archived && archived.id, by: skillActor(req) });

  res.json({
    deleted: plan.name,
    tier: plan.tier,
    teamId: plan.teamId,
    agentId: plan.agentId,
    cascade: plan.cascade,
    cascadeResults: cascade || undefined,
    archive: archived ? archived.id : null,
  });
});

/* ─── Skill archive: list / restore / prune (#627, AC3) ──────────────────── */

// GET /api/skills/archive — list restorable deletion (and move) snapshots,
// newest-first. Metadata comes from the archive-meta.json sidecar, falling back
// to parsing the stamp for meta-less (pre-#627 / move) entries. Team-tier
// entries are filtered by the caller's scope (global always visible).
app.get('/api/skills/archive', (req, res) => {
  const base = path.resolve(WORKSPACE, 'skill-archive');
  const scope = getScope(req);
  const out = [];
  let segs;
  try { segs = fs.readdirSync(base); } catch { return res.json({ archives: [] }); }
  for (const seg of segs) {
    let stamps;
    try { stamps = fs.readdirSync(path.join(base, seg)); } catch { continue; }
    for (const stamp of stamps) {
      const dir = path.join(base, seg, stamp);
      try { if (!fs.statSync(dir).isDirectory()) continue; } catch { continue; }
      const id = `${seg}/${stamp}`;
      const meta = readJsonFile(path.join(dir, 'archive-meta.json'), null);
      const parsed = skillDeletion.parseArchiveId(id) || {};
      const tier = meta && meta.tier ? meta.tier : (segToRef(seg, parsed.name) || {}).tier;
      const teamId = meta ? meta.teamId : (seg.startsWith('team-') ? seg.slice(5) : undefined);
      const agentId = meta ? meta.agentId : (seg.startsWith('agent-') ? seg.slice(6) : undefined);
      if (!scope.all && tier === 'team' && !canManageTeam(scope, teamId)) continue;
      out.push({
        id, tier, teamId, agentId,
        name: (meta && meta.name) || parsed.name,
        hash: (meta && meta.hash) || parsed.hash || null,
        deletedAt: (meta && meta.deletedAt) || (parsed.ts ? new Date(parsed.ts).toISOString() : null),
        by: meta ? meta.by : undefined,
      });
    }
  }
  out.sort((a, b) => String(b.deletedAt || '').localeCompare(String(a.deletedAt || '')));
  res.json({ archives: out });
});

// POST /api/skills/archive/restore { id, overwrite? } — copy a snapshot back to
// its origin tier (content + metadata round-trip; the meta sidecar is excluded
// from the restored dir). Permission-gated the same way as a delete at that
// tier. Refuses to clobber an existing skill unless `overwrite: true`.
app.post('/api/skills/archive/restore', heavyLimiter, (req, res) => {
  const { id, overwrite = false } = req.body || {};
  const parsed = skillDeletion.parseArchiveId(id);
  if (!parsed) return res.status(400).json({ error: 'invalid archive id' });
  const base = path.resolve(WORKSPACE, 'skill-archive');
  const srcDir = path.resolve(base, parsed.seg, parsed.stamp);
  const rel = path.relative(base, srcDir);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return res.status(400).json({ error: 'invalid archive id' });
  if (!fs.existsSync(path.join(srcDir, 'SKILL.md'))) return res.status(404).json({ error: 'archive not found' });

  const meta = readJsonFile(path.join(srcDir, 'archive-meta.json'), null);
  const ref = meta && meta.tier
    ? { tier: meta.tier, teamId: meta.teamId, agentId: meta.agentId, name: meta.name || parsed.name }
    : segToRef(parsed.seg, parsed.name);
  if (!ref || !ref.name) return res.status(400).json({ error: 'cannot resolve archive tier' });

  const scope = getScope(req);
  const permit = skillDeletion.permitDeletion(skillDeletion.requiredPermission(ref), {
    systemAdmin: !!scope.all,
    isTeamAdmin: (teamId) => canManageTeam(scope, teamId),
  });
  if (!permit.ok) return res.status(403).json({ error: permit.error });

  const dst = resolveTransferSkillDir(ref, ref.name);
  if (dst.error) return res.status(400).json({ error: dst.error });
  if (fs.existsSync(path.join(dst.dir, 'SKILL.md')) && !overwrite) {
    return res.status(409).json({ error: `skill '${ref.name}' already exists at the ${ref.tier} tier`, exists: true });
  }
  try {
    if (overwrite) fs.rmSync(dst.dir, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(dst.dir), { recursive: true });
    fs.cpSync(srcDir, dst.dir, { recursive: true, filter: (s) => path.basename(s) !== 'archive-meta.json' });
  } catch (err) {
    return res.status(500).json({ error: `Failed to restore skill: ${err.message}` });
  }
  appendSkillFeedEvent({ type: 'skill-restored', ref, name: ref.name, archiveId: id, by: skillActor(req) });
  res.status(201).json({ restored: ref.name, tier: ref.tier, teamId: ref.teamId, agentId: ref.agentId, from: id });
});

// POST /api/skills/archive/prune { retentionDays? } — remove snapshots older
// than the retention window (default 90d). Which ids to drop is decided by the
// unit-tested pure helper planArchivePrune; System-Admin only.
app.post('/api/skills/archive/prune', (req, res) => {
  const scope = getScope(req);
  if (!scope.all) return res.status(403).json({ error: 'forbidden: retention prune requires System Admin' });
  const retentionDays = Number.isFinite(req.body?.retentionDays) ? req.body.retentionDays : skillDeletion.DEFAULT_RETENTION_DAYS;
  const base = path.resolve(WORKSPACE, 'skill-archive');
  const entries = [];
  let segs;
  try { segs = fs.readdirSync(base); } catch { return res.json({ pruned: [], retentionDays }); }
  for (const seg of segs) {
    let stamps;
    try { stamps = fs.readdirSync(path.join(base, seg)); } catch { continue; }
    for (const stamp of stamps) {
      const id = `${seg}/${stamp}`;
      const meta = readJsonFile(path.join(base, seg, stamp, 'archive-meta.json'), null);
      const parsed = skillDeletion.parseArchiveId(id);
      entries.push({ id, deletedAt: (meta && meta.deletedAt) || (parsed && parsed.ts != null ? parsed.ts : undefined) });
    }
  }
  const pruned = [];
  for (const id of skillDeletion.planArchivePrune(entries, { retentionDays })) {
    const p = skillDeletion.parseArchiveId(id);
    if (!p) continue;
    const dir = path.resolve(base, p.seg, p.stamp);
    const r = path.relative(base, dir);
    if (r.startsWith('..') || path.isAbsolute(r)) continue;
    try { fs.rmSync(dir, { recursive: true, force: true }); pruned.push(id); } catch { /* best effort */ }
  }
  res.json({ pruned, retentionDays });
});

// Two-stage promotion (#306, relates to #173): promote a TEAM skill up to the
// GLOBAL pool. The team-tier copy is the Team-Admin's curation; lifting it into
// the shared global catalog is now ALSO a Team-Admin act (#2178/G8/H5a) — not
// only System-Admin — since publishing does not by itself grant the skill to
// any other team (a team still has to be granted it separately, so visibility
// stays "created by sharing"). Copies the whole skill directory recursively.
// Refuses to clobber an existing global skill unless `overwrite: true`.
// DEPRECATED (#626): the team→global cell is now the unified POST
// /api/skills/transfer ({from:{tier:'team',teamId}, to:{tier:'global'}}). Kept
// for older clients; the UI promotes via the transfer engine. The permission
// check is reused from there so the two paths can never disagree (#2178).
app.post('/api/skills/promote-to-global', (req, res) => {
  const { name, teamId, overwrite = false } = req.body || {};
  if (typeof name !== 'string' || !SKILL_NAME_RE.test(name)) {
    return res.status(400).json({ error: 'Invalid skill name' });
  }
  const srcDir = safeTeamSkillDir(teamId, name);
  if (!srcDir) return res.status(400).json({ error: 'Invalid team id or skill name' });
  const scope = getScope(req);
  const permit = skillTransfer.permitTransfer(
    skillTransfer.requiredPermission({ tier: 'team', teamId }, { tier: 'global' }, 'copy'),
    { systemAdmin: !!scope.all, isTeamAdmin: (tid) => canManageTeam(scope, tid) },
  );
  if (!permit.ok) return res.status(403).json({ error: permit.error });
  if (!fs.existsSync(path.join(srcDir, 'SKILL.md'))) {
    return res.status(404).json({ error: `Skill '${name}' not found in team '${teamId}'` });
  }
  // Containment for the global destination (matches the /promote pattern).
  const poolSkillsBaseDir = path.resolve(POOL_DIR, 'skills');
  const dstDir = path.resolve(poolSkillsBaseDir, name);
  const dstRel = path.relative(poolSkillsBaseDir, dstDir);
  if (dstRel.startsWith('..') || path.isAbsolute(dstRel)) {
    return res.status(400).json({ error: 'Invalid skill name' });
  }
  if (fs.existsSync(dstDir) && !overwrite) {
    return res.status(409).json({ error: `Skill '${name}' already exists in the global pool`, exists: true });
  }
  const srcId = skillSourceIdentity(srcDir);
  try {
    if (overwrite) fs.rmSync(dstDir, { recursive: true, force: true });
    fs.cpSync(srcDir, dstDir, { recursive: true });
  } catch (err) {
    return res.status(500).json({ error: `Failed to promote skill: ${err.message}` });
  }
  stampSkillCopy(dstDir, {
    name, by: skillActor(req), action: 'promoted',
    origin: skillOrigin({ tier: 'team', teamId, sourceVersion: srcId.sourceVersion, sourceHash: srcId.sourceHash }),
  });
  res.status(201).json({ name, source: 'pool', fromTeam: teamId, overwritten: !!overwrite });
});

/* ─── Unified skill tier-transfer (#626, docs/skill-lifecycle-concept.md §3) ──
 * One endpoint for every cell of the tier-transition matrix (adopt / lift /
 * share / promote, in copy or move flavour). The pure planner+validator lives
 * in skill-transfer.js; this endpoint does the file work: copy the whole skill
 * dir (provenance.json carried forward), stamp the target's skill.json with the
 * transfer action + origin, on `move` guard-then-retire the source (archive
 * snapshot + delete), and best-effort activate a team target. */

// Resolve a from/to tier reference to its on-disk skill dir, containment-guarded
// with the same path.resolve + path.relative pattern the other skill endpoints
// use (so CodeQL's path-injection query sees the guard in-flow). Returns
// { dir } or { error }. `ref` is a validated ref from the planner.
function resolveTransferSkillDir(ref, name) {
  if (ref.tier === 'team') {
    const dir = safeTeamSkillDir(ref.teamId, name);
    return dir ? { dir } : { error: 'invalid team id or skill name' };
  }
  if (ref.tier === 'global') {
    const base = path.resolve(POOL_DIR, 'skills');
    const dir = path.resolve(base, name);
    const rel = path.relative(base, dir);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return { error: 'invalid skill name' };
    return { dir };
  }
  // agent tier (source only — the planner rejects agent targets).
  const base = path.resolve(AGENTS_DIR);
  const dir = path.resolve(base, ref.agentId, 'skills', name);
  const rel = path.relative(base, dir);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return { error: 'invalid agent id or skill name' };
  return { dir };
}

// Does a skill by this name already exist at the destination tier? Used as the
// existsFn for the deterministic collision rename.
function transferSkillExistsAt(toRef, name) {
  const r = resolveTransferSkillDir(toRef, name);
  if (r.error) return true; // an unrepresentable name is "taken" — never picked
  return fs.existsSync(path.join(r.dir, 'SKILL.md'));
}

// Agent constructs that grant `name` (skills[] or skillsOverride), each with its
// owning human teamId — the basis for the move-would-strand-grants guard.
function agentsGrantingSkill(name) {
  const out = [];
  let ids;
  try { ids = fs.readdirSync(AGENTS_DIR); } catch { return out; }
  for (const id of ids) {
    const cfg = readJsonFile(path.join(AGENTS_DIR, id, 'config.json'), null);
    if (!cfg) continue;
    const granted = (Array.isArray(cfg.skills) && cfg.skills.includes(name)) ||
      (Array.isArray(cfg.skillsOverride) && cfg.skillsOverride.includes(name));
    if (granted) out.push({ id: cfg.id || id, teamId: cfg.teamId || DEFAULT_TEAM_ID });
  }
  return out;
}

// Copy a skill dir to the visible archive before a move retires it (concept
// §3.2 — a move keeps a recoverable snapshot, it does not destroy). Best-effort.
function archiveSkillDir(srcDir, fromRef, name, hash) {
  try {
    const tierSeg = fromRef.tier === 'team' ? `team-${fromRef.teamId}`
      : fromRef.tier === 'agent' ? `agent-${fromRef.agentId}` : 'global';
    const stamp = `${name}-${hash || 'nohash'}-${Date.now()}`;
    const base = path.resolve(WORKSPACE, 'skill-archive');
    const dst = path.resolve(base, tierSeg, stamp);
    const rel = path.relative(base, dst);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.cpSync(srcDir, dst, { recursive: true });
    return dst;
  } catch { return null; }
}

// Best-effort activation of a freshly-landed team skill on every squad (role
// 'team' agent) of the owning human team. Activation is keyed by squad id, not
// the human team id that keys the pool dir (see the two-keyspace note), so we
// fan out to each squad. Never rolls the transfer back on failure.
async function activateTransferredTeamSkill(humanTeamId, name) {
  const orchestratorUrl = process.env.ORCHESTRATOR_URL || 'http://orchestrator:4002';
  const results = [];
  let ids;
  try { ids = fs.readdirSync(AGENTS_DIR); } catch { return results; }
  for (const id of ids) {
    const cfg = readJsonFile(path.join(AGENTS_DIR, id, 'config.json'), null);
    if (!cfg || cfg.role !== 'team' || (cfg.teamId || DEFAULT_TEAM_ID) !== humanTeamId) continue;
    const squadId = cfg.id || id;
    try {
      const resp = await fetch(`${orchestratorUrl}/internal/teams/${encodeURIComponent(squadId)}/skills/activate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skillName: name }),
      });
      results.push({ squadId, status: resp.status });
    } catch (err) {
      results.push({ squadId, error: err.message });
    }
  }
  return results;
}

app.post('/api/skills/transfer', heavyLimiter, async (req, res) => {
  // 1. Validate + plan (pure). Regexes are the api.js originals so a valid plan
  //    is always writable by the dir resolvers below.
  const plan = skillTransfer.planTransfer(req.body, {
    skillNameRe: SKILL_NAME_RE, agentIdRe: AGENT_ID_RE, teamIdRe: POOL_TEAM_ID_RE,
  });
  if (!plan.ok) return res.status(400).json({ error: plan.error });

  // 2. Permission gate — map the caller's scope to transfer capabilities.
  const scope = getScope(req);
  const permit = skillTransfer.permitTransfer(plan.permission, {
    systemAdmin: !!scope.all,
    isTeamAdmin: (teamId) => canManageTeam(scope, teamId),
  });
  if (!permit.ok) return res.status(403).json({ error: permit.error });

  // 3. Resolve source + verify it exists.
  const src = resolveTransferSkillDir(plan.from, plan.name);
  if (src.error) return res.status(400).json({ error: `from: ${src.error}` });
  if (!fs.existsSync(path.join(src.dir, 'SKILL.md'))) {
    return res.status(404).json({ error: `skill '${plan.name}' not found at the source` });
  }

  // 4. Resolve destination name honouring the collision mode.
  let destName = plan.name;
  if (plan.onCollision === 'rename') {
    destName = skillTransfer.resolveCollisionName(plan.name, (n) => transferSkillExistsAt(plan.to, n));
  } else if (plan.onCollision === 'reject' && transferSkillExistsAt(plan.to, plan.name)) {
    return res.status(409).json({ error: `skill '${plan.name}' already exists at the destination`, exists: true });
  }
  const dst = resolveTransferSkillDir(plan.to, destName);
  if (dst.error) return res.status(400).json({ error: `to: ${dst.error}` });

  // No-op self-transfer guard beyond the planner's team→team same-team check:
  // a copy onto its own resolved dir would clobber the source.
  if (path.resolve(dst.dir) === path.resolve(src.dir)) {
    return res.status(400).json({ error: 'source and destination resolve to the same location' });
  }

  // 5. Move guard: refuse to strand grants. A move to GLOBAL never strands (the
  //    universal fallback remains); a move to a TEAM tier can orphan grantees
  //    outside that team unless a global copy of the name still exists.
  if (plan.retireSource && plan.to.tier === 'team') {
    // Route the global-copy probe through the containment-guarded resolver (same
    // path.resolve + path.relative guard as every other tier lookup) so CodeQL's
    // path-injection query sees the guard in-flow — destName is already validated
    // against SKILL_NAME_RE by the planner, this keeps the check consistent + safe.
    const globalCopyRemains = transferSkillExistsAt({ tier: 'global' }, destName) && plan.from.tier !== 'global';
    if (!globalCopyRemains) {
      const stranded = agentsGrantingSkill(plan.name).filter(a => a.teamId !== plan.to.teamId);
      if (stranded.length > 0 && req.body.force !== true) {
        return res.status(409).json({
          error: 'move would strand skill grants outside the target team',
          agents: stranded.map(a => a.id),
          hint: 'pass force:true to move anyway',
        });
      }
    }
  }

  // 6. Capture source identity BEFORE the copy (for the origin stamp).
  const srcId = skillSourceIdentity(src.dir);

  // 7+8. Copy the whole dir (provenance.json rides along via cpSync) and stamp
  //      the target's skill.json — a fresh v1 chain recording the transfer action
  //      (adopted|promoted|lifted|shared|moved) and where it came from. Both go
  //      through the shared file-write core (#639).
  const wrote = commitSkillWrite({
    destDir: dst.dir,
    overwrite: plan.onCollision === 'overwrite',
    copyFrom: src.dir,
    stamp: {
      mode: 'copy', name: destName, by: skillActor(req), action: plan.action,
      origin: skillOrigin({
        tier: plan.from.tier,
        teamId: plan.from.tier === 'team' ? plan.from.teamId : undefined,
        agentId: plan.from.tier === 'agent' ? plan.from.agentId : undefined,
        sourceVersion: srcId.sourceVersion, sourceHash: srcId.sourceHash,
      }),
    },
  });
  if (wrote.error) return res.status(500).json({ error: `Failed to copy skill: ${wrote.error}` });

  // 9. Move: archive-snapshot then retire the source.
  let archived = null;
  if (plan.retireSource) {
    archived = archiveSkillDir(src.dir, plan.from, plan.name, srcId.sourceHash);
    try { fs.rmSync(src.dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  // 10. Best-effort activation of a team target (default on) + a live-feed event.
  let activation = null;
  if (plan.activate && plan.to.tier === 'team') {
    activation = await activateTransferredTeamSkill(plan.to.teamId, destName);
  }
  try {
    fs.mkdirSync(path.dirname(KNOWLEDGE_EVENTS_FILE), { recursive: true });
    fs.appendFileSync(KNOWLEDGE_EVENTS_FILE, JSON.stringify({
      type: 'skill-transfer',
      ts: new Date().toISOString(),
      teamId: plan.to.tier === 'team' ? plan.to.teamId : undefined,
      skillName: destName,
      action: plan.action,
      semanticAction: plan.semanticAction,
      from: plan.from,
      to: plan.to,
      mode: plan.mode,
      renamed: destName !== plan.name ? plan.name : undefined,
      by: skillActor(req),
    }) + '\n');
  } catch { /* best effort */ }

  res.status(201).json({
    name: destName,
    requestedName: plan.name,
    from: plan.from,
    to: plan.to,
    mode: plan.mode,
    action: plan.action,
    semanticAction: plan.semanticAction,
    renamed: destName !== plan.name,
    retiredSource: plan.retireSource,
    archived: archived || undefined,
    activate: plan.activate,
    activation: activation || undefined,
  });
});

/* ─── Skill merge (#631, concept §3.4) ───────────────────────────────────
 * Fold N existing skills into ONE target skill: draft a combined SKILL.md
 * (LLM-synthesised with a deterministic concat fallback), UNION the sources'
 * provenance.json into the target's, carry the sources' extra files over
 * (collisions namespaced under files/<source-name>/…), migrate every grant
 * naming a retired source to the target, and retire the sources through the
 * archive-and-delete path. The pure planner (skill-merge.js) validates the
 * request + computes the grant/file/provenance plans; this endpoint does the IO. */

// Read a merge source's on-disk facts: dir, whether it exists, its SKILL.md,
// provenance.json, content hash, and its carried extra-file relative paths.
function readMergeSource(ref) {
  const r = resolveTransferSkillDir(ref, ref.name);
  if (r.error) return { ref, error: r.error };
  const dir = r.dir;
  const exists = fs.existsSync(path.join(dir, 'SKILL.md'));
  if (!exists) return { ref, dir, exists: false };
  let skillMd = '';
  try { skillMd = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'); } catch { /* empty */ }
  const prov = readSkillProvenance(dir);
  const { sourceHash } = skillSourceIdentity(dir);
  return { ref, dir, exists: true, skillMd, prov, hash: sourceHash || null, files: listSkillDirFiles(dir) };
}

// List a skill dir's files as posix-relative paths (for planFileMerge). Excludes
// nothing here — isCarriedFile does the sidecar/_archive filtering in the planner.
function listSkillDirFiles(dir) {
  const out = [];
  const walk = (rel) => {
    let entries;
    try { entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(childRel);
      else if (e.isFile()) out.push(childRel);
    }
  };
  walk('');
  return out;
}

// Every agent construct as the plain shape planGrantMigration consumes.
function readAllConstructs() {
  const out = [];
  let ids;
  try { ids = fs.readdirSync(AGENTS_DIR); } catch { return out; }
  for (const id of ids) {
    const cfg = readJsonFile(path.join(AGENTS_DIR, id, 'config.json'), null);
    if (!cfg) continue;
    out.push({
      id: cfg.id || id, role: cfg.role,
      skills: cfg.skills, skillsOverride: cfg.skillsOverride,
      parentTeamId: cfg.parentTeamId, teamId: cfg.teamId || DEFAULT_TEAM_ID,
    });
  }
  return out;
}

// Execute the grant-migration plan through the orchestrator's existing
// (de)activation endpoints (workspace sync + manifest + CLAUDE.md rebuild). For
// each affected construct: activate the target FIRST (so no member is left
// without the skill in the gap), then deactivate every source it granted. A team
// step fans out to inheriting members; an agent step edits one construct's own
// grant. Best-effort, per-construct — activation of a target a construct's tier
// can't resolve (a pathological cross-team merge) simply no-ops its workspace
// copy while the grant name is still rewritten. Never rolls the merge back.
async function migrateGrantsForMerge(sources, target) {
  const gm = skillMerge.planGrantMigration(readAllConstructs(), { sources, target });
  const orchestratorUrl = ORCH_URL();
  const call = async (base, id, verb, skillName) => {
    try {
      const resp = await fetch(`${orchestratorUrl}/internal/${base}/${encodeURIComponent(id)}/skills/${verb}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skillName }),
      });
      return { verb, skillName, status: resp.status };
    } catch (err) { return { verb, skillName, error: err.message }; }
  };
  const run = async (base, steps) => {
    const results = [];
    for (const step of steps) {
      const ops = [];
      if (step.addTarget) ops.push(await call(base, step.id, 'activate', target.name));
      for (const n of step.removes) ops.push(await call(base, step.id, 'deactivate', n));
      results.push({ id: step.id, ops });
    }
    return results;
  };
  return { teams: await run('teams', gm.teams), agents: await run('agents', gm.agents) };
}

// POST /api/skills/merge-draft — synthesise a combined SKILL.md preview from the
// sources (nothing persisted). LLM-with-heuristic-fallback, same shape as
// /api/knowledge/draft; `heuristicOnly:true` skips the LLM for an instant prefill.
app.post('/api/skills/merge-draft', heavyLimiter, async (req, res) => {
  const plan = skillMerge.planMerge(req.body, {
    skillNameRe: SKILL_NAME_RE, agentIdRe: AGENT_ID_RE, teamIdRe: POOL_TEAM_ID_RE, requireDraft: false,
  });
  if (!plan.ok) return res.status(400).json({ error: plan.error });

  const scope = getScope(req);
  const permit = skillMerge.permitMerge(plan.permission, {
    systemAdmin: !!scope.all, isTeamAdmin: (teamId) => canManageTeam(scope, teamId),
  });
  if (!permit.ok) return res.status(403).json({ error: permit.error });

  const infos = plan.sources.map(readMergeSource);
  const missing = infos.find((i) => !i.exists);
  if (missing) return res.status(404).json({ error: `source skill '${missing.ref.name}' not found`, ref: missing.ref });

  const draftSources = infos.map((i) => ({ name: i.ref.name, tier: i.ref.tier, skillMd: i.skillMd }));
  const heuristic = knowledgeSuggestions.buildHeuristicSkillMerge(draftSources, { targetName: plan.target.name });
  const fallback = () => res.json({ draft: heuristic, source: 'heuristic' });
  if (req.body?.heuristicOnly) return fallback();

  const target = resolveAssistTarget(req);
  if (target.selectionError) return sendAssistSelectionError(res, target);
  if (target.error) return fallback();
  const url = buildMessagesUrl(target.baseUrl);
  const headers = {
    'anthropic-version': '2023-06-01',
    ...(target.token ? { Authorization: `Bearer ${target.token}`, 'x-api-key': target.token } : {}),
  };
  const payload = { model: target.model, ...knowledgeSuggestions.buildSkillMergeRequest(draftSources) };
  const result = await httpPostJson(url, headers, payload);
  if (result.error || result.status < 200 || result.status >= 300) return fallback();
  const skillMd = extractMessageText(result.body);
  if (!skillMd) return fallback();
  res.json({ draft: { name: plan.target.name, skillMd, llmDrafted: true }, source: 'llm', model: target.model, meta: assistMeta(target) });
});

// POST /api/skills/merge — commit the merge: write the target from the operator's
// draft, union provenance, carry extra files, migrate grants + retire sources.
app.post('/api/skills/merge', heavyLimiter, async (req, res) => {
  // 1. Validate + plan (pure). A committing merge requires a non-empty draft.
  const plan = skillMerge.planMerge(req.body, {
    skillNameRe: SKILL_NAME_RE, agentIdRe: AGENT_ID_RE, teamIdRe: POOL_TEAM_ID_RE, requireDraft: true,
  });
  if (!plan.ok) return res.status(400).json({ error: plan.error });

  // 2. Permission gate — target-tier (Team Admin for a team target, System Admin
  //    for a global target).
  const scope = getScope(req);
  const permit = skillMerge.permitMerge(plan.permission, {
    systemAdmin: !!scope.all, isTeamAdmin: (teamId) => canManageTeam(scope, teamId),
  });
  if (!permit.ok) return res.status(403).json({ error: permit.error });

  // 3. Resolve + verify every source exists.
  const infos = plan.sources.map(readMergeSource);
  const missing = infos.find((i) => !i.exists);
  if (missing) return res.status(404).json({ error: `source skill '${missing.ref.name}' not found`, ref: missing.ref });

  // 4. Resolve the target dir (containment-guarded) + collision check.
  const dst = resolveTransferSkillDir(plan.target, plan.target.name);
  if (dst.error) return res.status(400).json({ error: `target: ${dst.error}` });
  const targetIsSource = infos.some((i) => path.resolve(i.dir) === path.resolve(dst.dir));
  if (fs.existsSync(path.join(dst.dir, 'SKILL.md')) && !req.body.overwrite && !targetIsSource) {
    return res.status(409).json({ error: `skill '${plan.target.name}' already exists at the target`, exists: true });
  }

  // 5. Provenance union + mergedFrom history (concept §3.4).
  const hashByKey = new Map(infos.map((i) => [skillMerge.refKey(i.ref), i.hash]));
  const mergedFrom = skillMerge.buildMergedFrom(plan.sources, (s) => hashByKey.get(skillMerge.refKey(s)) || null);
  const prov = skillMerge.mergeProvenance({
    sourceProvs: infos.map((i) => i.prov),
    target: plan.target,
    mergedFrom,
    mergedBy: skillActor(req),
  });

  // 6. Write the target (draft SKILL.md + provenance.json).
  const draft = plan.draft;
  try {
    if (req.body.overwrite && !targetIsSource) fs.rmSync(dst.dir, { recursive: true, force: true });
    fs.mkdirSync(dst.dir, { recursive: true });
    fs.writeFileSync(path.join(dst.dir, 'SKILL.md'), draft.endsWith('\n') ? draft : draft + '\n');
    fs.writeFileSync(path.join(dst.dir, 'provenance.json'), JSON.stringify(prov, null, 2));
  } catch (err) {
    return res.status(500).json({ error: `Failed to write merged skill: ${err.message}` });
  }

  // 7. Carry the sources' extra files over. A path in exactly one source keeps its
  //    location; a path in >1 source is namespaced under files/<source-name>/… so
  //    no source silently wins.
  const fileMerge = skillMerge.planFileMerge(infos.map((i) => ({ name: i.ref.name, files: i.files })));
  const dirByName = new Map(infos.map((i) => [i.ref.name, i.dir]));
  for (const copy of fileMerge.copies) {
    const fromDir = dirByName.get(copy.sourceName);
    if (!fromDir) continue;
    try {
      const from = path.resolve(fromDir, copy.from);
      const to = path.resolve(dst.dir, copy.to);
      // Containment guard: never write outside the target dir.
      if (path.relative(path.resolve(dst.dir), to).startsWith('..')) continue;
      if (path.resolve(from) === to) continue; // target is one of the sources — skip self-copy
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
    } catch { /* best-effort per file */ }
  }

  // 8. Stamp the target's skill.json — a fresh v1 chain with the `merged` action;
  //    record mergedFrom on the history entry + top-level for the lineage view.
  stampSkillCopy(dst.dir, {
    name: plan.target.name, by: skillActor(req), action: 'merged',
    note: `merged ${plan.sources.length} skills: ${plan.sources.map((s) => s.name).join(', ')}`,
  });
  try {
    const man = skillManifest.readManifest(dst.dir);
    if (man) {
      man.mergedFrom = mergedFrom;
      if (Array.isArray(man.history) && man.history[0]) man.history[0].mergedFrom = mergedFrom;
      skillManifest.writeManifest(dst.dir, man);
    }
  } catch { /* best-effort */ }

  // 9. Grant migration + source retirement (only when retiring — keeping the
  //    sources means keeping their grants). Migration rewrites every grant naming
  //    a retired source to the target, then the sources are archived + removed.
  let grantMigration = null;
  const archived = [];
  if (plan.retireSources) {
    grantMigration = await migrateGrantsForMerge(plan.sources, plan.target);
    for (const i of infos) {
      if (path.resolve(i.dir) === path.resolve(dst.dir)) continue; // never retire the target
      const srcId = skillSourceIdentity(i.dir);
      const snap = archiveDeletedSkill(i.dir, i.ref, i.ref.name, srcId, req);
      if (snap) archived.push({ name: i.ref.name, id: snap.id });
      try { fs.rmSync(i.dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  }

  // 10. Live-feed event (skill-merged).
  try {
    fs.mkdirSync(path.dirname(KNOWLEDGE_EVENTS_FILE), { recursive: true });
    fs.appendFileSync(KNOWLEDGE_EVENTS_FILE, JSON.stringify({
      type: 'skill-merged',
      ts: new Date().toISOString(),
      tier: plan.target.tier,
      teamId: plan.target.tier === 'team' ? plan.target.teamId : undefined,
      skillName: plan.target.name,
      sources: plan.sources.map((s) => s.name),
      retiredSources: plan.retireSources,
      by: skillActor(req),
    }) + '\n');
  } catch { /* best-effort */ }

  res.status(201).json({
    name: plan.target.name,
    target: plan.target,
    sources: plan.sources,
    retiredSources: plan.retireSources,
    provenance: prov,
    mergedFrom,
    collisions: fileMerge.collisions,
    archived: archived.length ? archived : undefined,
    grantMigration: grantMigration || undefined,
  });
});

/* ─── LLM Config ─────────────────────────────────────────────────────── */

app.get('/api/llm-config', (req, res) => {
  const token = process.env.ANTHROPIC_AUTH_TOKEN || '';
  const maskedToken = token.length > 4
    ? '•'.repeat(Math.min(token.length - 4, 12)) + token.slice(-4)
    : token ? '••••' : '';
  res.json({
    baseUrl:     process.env.ANTHROPIC_BASE_URL || '',
    authToken:   maskedToken,
    sonnetModel: process.env.ANTHROPIC_DEFAULT_SONNET_MODEL || 'claude-sonnet-4-6',
    haikuModel:  process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL  || 'claude-haiku-4-5',
  });
});

/* ─── LLM Endpoints ─────────────────────────────────────────────────── */

function slugifyId(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

function validateModels(models) {
  if (!Array.isArray(models)) return 'models must be an array';
  for (const m of models) {
    if (!m || typeof m.id !== 'string' || !m.id.trim()) return 'every model needs a non-empty id';
    // contextWindow is optional (populated by discovery, #1717) but when set it
    // must be a positive number — a malformed value would surface as a bogus
    // limit in the chat header.
    if (m.contextWindow !== undefined && m.contextWindow !== null
        && !(typeof m.contextWindow === 'number' && m.contextWindow > 0)) {
      return 'contextWindow must be a positive number when set';
    }
  }
  return null;
}

// Normalize an endpoint-level defaultModelId against a models list:
//   - undefined / null / '' → null (no default chosen)
//   - non-empty string      → must match an entry's id, otherwise error
function normalizeEndpointDefaultModel(defaultModelId, models) {
  if (defaultModelId === undefined || defaultModelId === null || defaultModelId === '') {
    return { defaultModelId: null };
  }
  if (typeof defaultModelId !== 'string') {
    return { error: 'defaultModelId must be a string or null' };
  }
  const trimmed = defaultModelId.trim();
  if (!Array.isArray(models) || !models.some(m => m.id === trimmed)) {
    return { error: `defaultModelId '${trimmed}' is not in the endpoint's models list` };
  }
  return { defaultModelId: trimmed };
}

// The endpoint's effective default — operator-chosen value, or first model as
// a backstop so callers that don't yet pick one explicitly still get something
// usable (mirrors the previous models[0] behaviour).
function pickEndpointDefaultModel(ep) {
  if (!ep) return null;
  if (ep.defaultModelId) return ep.defaultModelId;
  const first = (ep.models || [])[0];
  return first?.id || null;
}

app.get('/api/llm-endpoints', (req, res) => {
  // Team-scoped (#800), mirroring GET /api/ssh-keys: a non-System-Admin sees
  // only system-scoped providers assigned to a team they administer plus
  // team-scoped providers owned by such a team. System Admins / env admin see
  // all. This also scopes the agent/env provider picker (AC10), which fetches
  // this same endpoint.
  const scope = getScope(req);
  const healthMap = loadLlmHealthMap();
  res.json(listLlmEndpoints()
    .filter(ep => providerVisible(scope, ep))
    // Merge the persisted health status (#1843) so the Model Providers table
    // renders it on page load with no click (AC3). No record → 'unknown' (AC6).
    // maskLlmEndpointForCaller drops the token tail/fingerprint for a global-only
    // view (#2136 finding 3a) — an ordinary-reach caller is unchanged.
    .map(ep => ({ ...maskLlmEndpointForCaller(scope, ep), health: llmHealth.healthView(healthMap[ep.id]) })));
});

// Selection options for the global assist model selector (#1210). Distinct from
// GET /api/llm-endpoints (the management list, visibleCredential-filtered): this
// is filtered by assistSelectableEndpoint — membership-based, any role, so a
// plain Team Member sees the providers their team may bill AI helpers against —
// and masked to just what the picker needs (never a token, never a baseUrl).
// `envFallbackActive` flags the bootstrap case (no providers registered anywhere
// + ANTHROPIC_BASE_URL set), where the selector shows a read-only ".env" chip.
// Session-gated by the /api auth mount.
app.get('/api/assist/model-options', (req, res) => {
  const scope = getScope(req);
  res.json(buildAssistModelOptions(scope, listLlmEndpoints(), {
    envBaseUrl: process.env.ANTHROPIC_BASE_URL || '',
  }));
});

// Read-only view of the ANTHROPIC_* variables from `.env`, surfaced as a
// provider-shaped record so the Model Providers page can show the operator
// what "inherit from .env" resolves to. Never selectable as an llmEndpointId.
app.get('/api/llm-env-fallback', (req, res) => {
  res.json(buildEnvFallbackProvider());
});

app.get('/api/llm-endpoints/:id', (req, res) => {
  const scope = getScope(req);
  const ep = listLlmEndpoints().find(e => e.id === req.params.id);
  // Fail closed: a provider the caller may not see is reported as absent (#800),
  // so a Team Admin cannot probe another team's provider ids by-id.
  if (!ep || !providerVisible(scope, ep)) return res.status(404).json({ error: 'LLM endpoint not found' });
  // Global-only caller gets the token tail/fingerprint stripped (#2136 finding 3a).
  res.json({ ...maskLlmEndpointForCaller(scope, ep), health: llmHealthViewFor(ep.id) });
});

app.post('/api/llm-endpoints', apiLimiter, async (req, res) => {
  const { name, baseUrl, authToken, models, defaultModelId, id: rawId,
          authType: rawAuthType, complianceAck, oauthFlowId } = req.body || {};
  const authType = normalizeAuthType(rawAuthType);
  const isOauth = authType === 'oauth-token';
  if (!name || typeof name !== 'string') return res.status(400).json({ error: 'name is required' });
  if (!isOauth && (!baseUrl || typeof baseUrl !== 'string')) return res.status(400).json({ error: 'baseUrl is required' });
  if (isOauth && complianceAck !== true) {
    return res.status(400).json({ error: 'Subscription auth requires the explicit single-user compliance confirmation (complianceAck).' });
  }
  // Resolve requested ownership (#800): a `system` provider carries an
  // assignedTeamIds set (System-Admin only); otherwise a team-scoped provider
  // owned by one team. Enforce the create gate — a Team Admin may self-serve
  // only team-scoped providers for a team they administer.
  const scope = getScope(req);
  let ownership;
  try { ownership = resolveCredentialOwnership(req.body); }
  catch (err) { return res.status(err.status || 400).json({ error: err.message }); }
  // Global provider (#2136): a System-Admin-only publish flag. A global provider
  // carries no team assignment at all, so it is always system-scoped-with-no-
  // teams — override the resolved ownership before the create gate so the two
  // agree. `resolveGlobalFlag` refuses a non-admin (403) or an oauth seat (400).
  const globalGate = resolveGlobalFlag({ wantGlobal: req.body?.global, currentGlobal: false, scopeAll: scope.all, isOauth });
  if (globalGate.error) return res.status(globalGate.status).json({ error: globalGate.error, code: globalGate.code });
  if (globalGate.global) ownership = { scope: 'system', teamId: null, assignedTeamIds: [] };
  if (!canCreateCredential(scope, ownership)) {
    return res.status(403).json({ error: 'forbidden: you may not create this provider', code: 'forbidden' });
  }
  if (!isOauth) {
    try { new URL(baseUrl); } catch { return res.status(400).json({ error: 'baseUrl must be a valid URL' }); }
  }
  const modelList = Array.isArray(models) ? models : [];
  const modelErr = validateModels(modelList);
  if (modelErr) return res.status(400).json({ error: modelErr });
  const normalizedModels = modelList.map(m => ({
    id: m.id,
    displayName: m.displayName || m.id,
    ...(m.kind ? { kind: m.kind } : {}),
    ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
    ...(m.notes ? { notes: m.notes } : {}),
  }));
  const def = normalizeEndpointDefaultModel(defaultModelId, normalizedModels);
  if (def.error) return res.status(400).json({ error: def.error });

  const existing = listLlmEndpoints();
  let id;
  if (rawId !== undefined && rawId !== null && String(rawId).trim() !== '') {
    id = String(rawId).trim();
    if (!/^[a-z0-9-]+$/.test(id)) return res.status(400).json({ error: 'id must contain lowercase letters, digits and hyphens only' });
    if (existing.some(e => e.id === id)) return res.status(409).json({ error: `LLM endpoint id '${id}' already exists` });
  } else {
    id = slugifyId(name) || `ep-${Date.now()}`;
    if (existing.some(e => e.id === id)) id = `${id}-${Date.now().toString(36)}`;
  }

  // Resolve the token: manual paste (authToken) or a completed setup-token
  // login flow (oauthFlowId — claimed server-side from the orchestrator).
  let tokenValue = (authToken && typeof authToken === 'string') ? authToken.trim() : '';
  if (isOauth && !tokenValue && oauthFlowId) {
    const claim = await claimOauthFlowToken(oauthFlowId);
    if (claim.error) return res.status(502).json({ error: `Could not obtain token from login flow: ${claim.error}` });
    tokenValue = claim.token;
  }
  if (isOauth && !tokenValue) {
    return res.status(400).json({ error: 'Subscription auth needs a token — complete the login flow or paste a setup-token value.' });
  }

  let authTokenId = '';
  if (tokenValue) {
    authTokenId = `${id}-${Date.now().toString(36)}`;
    writeLlmEndpointToken(authTokenId, tokenValue);
  }

  const entry = {
    id,
    name,
    scope: ownership.scope,
    teamId: ownership.teamId,
    assignedTeamIds: ownership.assignedTeamIds,
    ...(globalGate.global ? { global: true } : {}),
    baseUrl: isOauth ? '' : baseUrl,
    authType,
    ...(isOauth ? { complianceAck: buildComplianceAck(req) } : {}),
    authTokenId,
    models: normalizedModels,
    defaultModelId: def.defaultModelId,
    createdAt: new Date().toISOString(),
  };
  saveLlmEndpointsIndex([...existing, entry]);
  // AC4: probe on save so a freshly-saved broken endpoint is flagged
  // immediately. Best-effort (never throws; ~8s worst case only on an actually
  // unreachable endpoint — exactly when the signal is worth waiting for).
  const health = await probeAndRecordHealth(entry);
  res.status(201).json({ ...maskLlmEndpoint(entry), health: llmHealth.healthView(health) });
});

app.put('/api/llm-endpoints/:id', apiLimiter, async (req, res) => {
  const list = listLlmEndpoints();
  const idx = list.findIndex(e => e.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'LLM endpoint not found' });
  const current = list[idx];
  const { name, baseUrl, authToken, models, defaultModelId,
          authType: rawAuthType, complianceAck, oauthFlowId } = req.body || {};

  // Team-scope enforcement (#800): the caller must be able to manage this
  // provider at all (System Admin, or the Team Admin of a team-scoped
  // provider's owning team — never a system-scoped provider for a Team Admin).
  const scope = getScope(req);
  if (!canManageCredential(scope, current)) {
    return res.status(403).json({ error: 'forbidden: you may not manage this provider', code: 'forbidden' });
  }
  // Optional scope / team-assignment change. Only a System Admin may reassign
  // (AC8), and a move must not orphan an environment that still references the
  // provider (AC edge case). The resolved ownership is stamped onto `next` below.
  const cur = normalizeCredential(current);
  const b = req.body || {};
  const reassigning = ('scope' in b) || ('teamId' in b) || ('assignedTeamIds' in b);
  let ownership = { scope: cur.scope, teamId: cur.teamId, assignedTeamIds: cur.assignedTeamIds };
  if (reassigning) {
    if (!canReassignCredential(scope)) {
      return res.status(403).json({ error: 'forbidden: only a System Admin may reassign a provider', code: 'forbidden' });
    }
    try {
      ownership = resolveCredentialOwnership({
        scope: 'scope' in b ? b.scope : cur.scope,
        teamId: b.teamId,
        assignedTeamIds: b.assignedTeamIds,
      });
    } catch (err) { return res.status(err.status || 400).json({ error: err.message }); }
    const inUse = llmEndpointInUse(current.id);
    if (inUse) {
      const env = loadEnvironment(inUse);
      const envTeam = (env && env.teamId) || 'default';
      const candidate = { ...current, scope: ownership.scope, teamId: ownership.teamId, assignedTeamIds: ownership.assignedTeamIds };
      // Provider path (#2136): a global provider is usable by every team, so it is
      // never orphaned — use the provider-specific predicate, not the generic one.
      if (!providerUsableByTeam(candidate, envTeam)) {
        return res.status(409).json({
          error: `Provider is used by environment '${inUse}' (team '${envTeam}'); reassignment would orphan it. Detach it first.`,
        });
      }
    }
  }

  // The effective auth type after this update. Switching to subscription auth
  // demands a fresh explicit single-user confirmation.
  const nextAuthType = rawAuthType !== undefined
    ? normalizeAuthType(rawAuthType)
    : normalizeAuthType(current.authType);
  const isOauth = nextAuthType === 'oauth-token';
  if (isOauth && normalizeAuthType(current.authType) !== 'oauth-token' && complianceAck !== true) {
    return res.status(400).json({ error: 'Switching to subscription auth requires the explicit single-user compliance confirmation (complianceAck).' });
  }

  if (baseUrl !== undefined && !(isOauth && baseUrl === '')) {
    if (typeof baseUrl !== 'string' || !baseUrl) return res.status(400).json({ error: 'baseUrl must be a non-empty string' });
    try { new URL(baseUrl); } catch { return res.status(400).json({ error: 'baseUrl must be a valid URL' }); }
  }
  if (!isOauth && normalizeAuthType(current.authType) === 'oauth-token' && !(baseUrl && typeof baseUrl === 'string')) {
    return res.status(400).json({ error: 'Switching to api-key auth requires a baseUrl.' });
  }
  if (models !== undefined) {
    const modelErr = validateModels(models);
    if (modelErr) return res.status(400).json({ error: modelErr });
  }

  // Global provider toggle (#2136). Changing the flag is System-Admin-only
  // (mirrors canReassignCredential — it changes who can reach the provider), and
  // a subscription seat can never be global. A global provider carries no team
  // assignment, so publishing one overrides the ownership to system-with-no-teams
  // (idempotent: re-saving a global provider re-asserts the same shape). A no-op
  // (flag unchanged) is not gated, so a Team Admin editing an already-global
  // provider's models is not refused for a change they did not make.
  const globalGate = resolveGlobalFlag({
    wantGlobal: ('global' in b) ? b.global : undefined,
    currentGlobal: current.global === true,
    scopeAll: scope.all,
    isOauth,
  });
  if (globalGate.error) return res.status(globalGate.status).json({ error: globalGate.error, code: globalGate.code });
  if (globalGate.global) ownership = { scope: 'system', teamId: null, assignedTeamIds: [] };

  const next = { ...current };
  // Persist the (possibly unchanged) canonical ownership shape (#800).
  next.scope = ownership.scope;
  next.teamId = ownership.teamId;
  next.assignedTeamIds = ownership.assignedTeamIds;
  // Global flag (#2136): stamped when set, and removed when retracted so a
  // non-global record is byte-clean (no dangling `global: false`).
  if (globalGate.global) next.global = true; else delete next.global;
  next.authType = nextAuthType;
  if (isOauth) {
    if (normalizeAuthType(current.authType) !== 'oauth-token' || complianceAck === true) {
      next.complianceAck = buildComplianceAck(req);
    }
    if (baseUrl === undefined) next.baseUrl = '';
  } else {
    delete next.complianceAck;
  }
  if (name !== undefined)    next.name    = String(name);
  if (baseUrl !== undefined) next.baseUrl = isOauth ? '' : baseUrl;
  if (models !== undefined)  next.models  = models.map(m => ({
    id: m.id,
    displayName: m.displayName || m.id,
    ...(m.kind ? { kind: m.kind } : {}),
    ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
    ...(m.notes ? { notes: m.notes } : {}),
  }));

  // Validate the default against the *resulting* models list. If the request
  // sends a new defaultModelId, use it; otherwise re-check the existing one
  // against any new model list (so dropping a model that was the default
  // either errors or, if not sent, is silently cleared).
  if (defaultModelId !== undefined) {
    const def = normalizeEndpointDefaultModel(defaultModelId, next.models);
    if (def.error) return res.status(400).json({ error: def.error });
    next.defaultModelId = def.defaultModelId;
  } else if (models !== undefined && current.defaultModelId) {
    const stillThere = (next.models || []).some(m => m.id === current.defaultModelId);
    next.defaultModelId = stillThere ? current.defaultModelId : null;
  }

  // Token rotation: if `authToken` is a non-empty string, replace; if it's an
  // empty string, clear; if undefined, leave the existing token alone. For
  // subscription auth a completed login flow (oauthFlowId) is an alternative
  // source — claimed server-side, never round-tripped through the browser.
  let newTokenValue;
  if (isOauth && oauthFlowId) {
    const claim = await claimOauthFlowToken(oauthFlowId);
    if (claim.error) return res.status(502).json({ error: `Could not obtain token from login flow: ${claim.error}` });
    newTokenValue = claim.token;
  } else if (authToken !== undefined) {
    newTokenValue = (typeof authToken === 'string' && authToken.trim()) ? authToken.trim() : '';
  }
  if (newTokenValue !== undefined) {
    if (newTokenValue) {
      const newId = current.authTokenId || `${current.id}-${Date.now().toString(36)}`;
      writeLlmEndpointToken(newId, newTokenValue);
      if (newId !== current.authTokenId && current.authTokenId) {
        deleteLlmEndpointToken(current.authTokenId);
      }
      next.authTokenId = newId;
    } else {
      if (current.authTokenId) deleteLlmEndpointToken(current.authTokenId);
      next.authTokenId = '';
    }
  }
  // Switching to subscription auth must not leave the endpoint tokenless —
  // the CLI has nothing to authenticate with then.
  if (isOauth && !next.authTokenId) {
    return res.status(400).json({ error: 'Subscription auth needs a token — complete the login flow or paste a setup-token value.' });
  }

  next.updatedAt = new Date().toISOString();
  list[idx] = next;
  saveLlmEndpointsIndex(list);
  // AC4: re-probe on save so an edit (e.g. a repointed base URL or a rotated
  // token) reflects its new reachability immediately. Best-effort.
  const health = await probeAndRecordHealth(next);
  res.json({ ...maskLlmEndpoint(next), health: llmHealth.healthView(health) });
});

app.put('/api/llm-endpoints/:id/models', apiLimiter, (req, res) => {
  const list = listLlmEndpoints();
  const idx = list.findIndex(e => e.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'LLM endpoint not found' });
  // Same manage gate as the full PUT (#800): editing the model list / default
  // model is a mutation, rejected for a provider the caller may not manage.
  const scope = getScope(req);
  if (!canManageCredential(scope, list[idx])) {
    return res.status(403).json({ error: 'forbidden: you may not manage this provider', code: 'forbidden' });
  }
  const models = req.body && Array.isArray(req.body.models) ? req.body.models : req.body;
  const modelErr = validateModels(models);
  if (modelErr) return res.status(400).json({ error: modelErr });
  const normalizedModels = models.map(m => ({
    id: m.id,
    displayName: m.displayName || m.id,
    ...(m.kind ? { kind: m.kind } : {}),
    ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
    ...(m.notes ? { notes: m.notes } : {}),
  }));
  // Drop a stale defaultModelId if the new model list no longer contains it.
  const prevDefault = list[idx].defaultModelId || null;
  const stillValid = prevDefault && normalizedModels.some(m => m.id === prevDefault);
  list[idx] = {
    ...list[idx],
    models: normalizedModels,
    defaultModelId: stillValid ? prevDefault : null,
    updatedAt: new Date().toISOString(),
  };
  saveLlmEndpointsIndex(list);
  res.json(maskLlmEndpoint(list[idx]));
});

app.delete('/api/llm-endpoints/:id', apiLimiter, (req, res) => {
  const list = listLlmEndpoints();
  const ep = list.find(e => e.id === req.params.id);
  if (!ep) return res.status(404).json({ error: 'LLM endpoint not found' });
  // Manage gate (#800): a Team Admin may delete only team-scoped providers of a
  // team they administer, never a system-scoped one.
  const scope = getScope(req);
  if (!canManageCredential(scope, ep)) {
    return res.status(403).json({ error: 'forbidden: you may not manage this provider', code: 'forbidden' });
  }
  const usedBy = llmEndpointInUse(ep.id);
  if (usedBy) {
    return res.status(409).json({ error: `LLM endpoint is used by environment '${usedBy}'. Detach it first.` });
  }
  if (ep.authTokenId) deleteLlmEndpointToken(ep.authTokenId);
  saveLlmEndpointsIndex(list.filter(e => e.id !== ep.id));
  // Drop the endpoint's persisted health record so it doesn't orphan (#1843).
  const healthMap = loadLlmHealthMap();
  if (ep.id in healthMap) { delete healthMap[ep.id]; saveLlmHealthMap(healthMap); }
  res.status(204).end();
});

// The bound-agents discovery deps, shared by the two routes below so their view
// of "which agents are bound, and which of them may this caller see" cannot
// drift. `isVisible` is the #1501 fix: seeing the *provider* (visibleCredential)
// says nothing about seeing an *agent*, which has its own rules (team membership
// since #2078, plus ownership for a standalone agent), so a system-scoped
// credential shared across teams used to disclose every consumer's id, display
// name and role to any Team Admin who could merely view it.
function boundAgentDeps(scope) {
  return {
    loadEnvironment,
    effectiveEndpointId,
    loadTeamConfig: teamId => readJsonFile(path.join(AGENTS_DIR, teamId, 'config.json'), null),
    isVisible: cfg => visibleAgent(scope, agentMetaForScope(cfg)),
  };
}

function loadAllAgentConfigs() {
  return listAgentDirs().map(id => readJsonFile(path.join(AGENTS_DIR, id, 'config.json'), null));
}

// Returns enabled, materialized agents whose effective LLM endpoint is :id.
// Used by the UI to prompt a respawn after credential rotation. Discovery
// logic lives in respawn-agents.js (pure, unit-tested) — this route only
// does I/O (loading configs) and wires the result into a JSON response.
//
// Agents the caller may not see are reported as a COUNT, never omitted (#1501):
// an operator deciding whether to rotate a shared credential needs the true
// blast radius even when the identities in it are none of their business.
app.get('/api/llm-endpoints/:id/bound-agents', apiLimiter, (req, res) => {
  const scope = getScope(req);
  const ep = listLlmEndpoints().find(e => e.id === req.params.id);
  if (!ep || !providerVisible(scope, ep)) return res.status(404).json({ error: 'LLM endpoint not found' });
  const { visible, hidden } = discoverBoundAgents(loadAllAgentConfigs(), ep.id, boundAgentDeps(scope));
  res.json({ agents: visible, hidden: hiddenBlastRadius(hidden) });
});

// Respawn all enabled agents bound to :id so they pick up the rotated credential
// without requiring a manual disable→enable cycle. Discovery + the bounded
// worker-pool both live in respawn-agents.js (pure, unit-tested); this route
// does I/O and decides the default concurrency policy.
app.post('/api/llm-endpoints/:id/respawn-agents', apiLimiter, async (req, res) => {
  const scope = getScope(req);
  const ep = listLlmEndpoints().find(e => e.id === req.params.id);
  if (!ep || !providerVisible(scope, ep)) return res.status(404).json({ error: 'LLM endpoint not found' });
  if (!canManageCredential(scope, ep)) return res.status(403).json({ error: 'forbidden', code: 'forbidden' });
  const { visible, hidden } = discoverBoundAgents(loadAllAgentConfigs(), ep.id, boundAgentDeps(scope));
  // EVERY bound agent is respawned, visible to this caller or not (#1501). The
  // credential owner has a legitimate reason to fix every consumer, and skipping
  // the invisible ones would leave them silently running on the rotated-away
  // credential — defeating the point of the feature to protect a metadata leak
  // that the response projection below closes instead.
  const agents = [...visible, ...hidden];
  // Bounded concurrency: an unbounded Promise.all here would fan out one
  // stop+recreate container-lifecycle call per agent simultaneously, which
  // can overwhelm the orchestrator's libpod socket and the host's container
  // runtime on a large squad (observed directly while load-testing this
  // route against 45+ agents). RESPAWN_CONCURRENCY lets an operator tune it
  // for their hardware; the default is conservative for a local Podman host.
  const requestedConcurrency = Number(process.env.RESPAWN_CONCURRENCY) || 5;
  const outcome = await respawnWithConcurrency(
    agents.map(a => a.id),
    requestedConcurrency,
    id => respawnAgentBestEffort(id, 'llm-credential-rotated'),
  );
  const visibleIds = new Set(visible.map(a => a.id));
  const projected = projectRespawnOutcome(outcome, visibleIds);
  const blastRadius = hiddenBlastRadius(hidden);
  // The log line carries the hidden counts, not the hidden ids — the same rule
  // the response follows, so reading the server log is not a way around it.
  if (blastRadius.count > 0) {
    console.log(`[llm-respawn] endpoint=${ep.id} respawned=${outcome.respawned.length} skipped=${outcome.skipped.length}`
      + ` hidden=${blastRadius.count} hiddenTeams=${blastRadius.teamCount} hiddenStandalone=${blastRadius.standalone}`
      + ` hiddenRespawned=${projected.hiddenRespawned} hiddenSkipped=${projected.hiddenSkipped}`);
  }
  res.json({
    respawned: projected.respawned,
    skipped: projected.skipped,
    hidden: {
      ...blastRadius,
      respawned: projected.hiddenRespawned,
      skipped: projected.hiddenSkipped,
    },
  });
});

// Pull a human-readable failure reason out of a proxy's error response body and
// combine it with the HTTP status. Without this a LiteLLM key whose budget is
// exhausted answers /v1/models with a 400 whose body says exactly why
// ("Budget has been exceeded! …") — but the probe used to drop the body and
// surface a bare "HTTP 400", so the operator had no idea it was a spend cap.
// Shapes handled: LiteLLM/OpenAI `{ error: { message, type, code } }`, a plain
// `{ error: "msg" }` or `{ message: "msg" }`, and a non-JSON string body.
function describeProbeFailure(status, body) {
  let detail = null;
  if (body && typeof body === 'object') {
    const e = body.error;
    if (e && typeof e === 'object' && typeof e.message === 'string') detail = e.message;
    else if (typeof e === 'string') detail = e;
    else if (typeof body.message === 'string') detail = body.message;
  } else if (typeof body === 'string' && body.trim()) {
    detail = body.trim();
  }
  const base = status ? `HTTP ${status}` : 'request failed';
  return detail ? `${base} — ${detail}` : base;
}

// Shared between the stored-endpoint routes (use the persisted token) and the
// stateless probe routes (use the token from the request body, so the form can
// test a draft endpoint before saving). Subscription-OAuth endpoints always
// probe the real Anthropic API (there is no proxy base URL) with the Bearer +
// oauth beta header the CLI itself uses.
function llmProbeTarget(baseUrl, token, authType) {
  if (normalizeAuthType(authType) === 'oauth-token') {
    return {
      url: buildModelsUrl(ANTHROPIC_DIRECT_BASE),
      headers: token ? oauthProbeHeaders(token) : {},
    };
  }
  return {
    url: buildModelsUrl(baseUrl),
    headers: token ? { Authorization: `Bearer ${token}`, 'x-api-key': token } : {},
  };
}

async function probeLlmEndpointTest(baseUrl, token, authType) {
  const { url, headers } = llmProbeTarget(baseUrl, token, authType);
  const result = await httpGetJson(url, headers);
  const ok = result.status >= 200 && result.status < 300;
  return {
    ok,
    url,
    status: result.status,
    error: result.error || (ok ? null : describeProbeFailure(result.status, result.body)),
    sample: ok && result.body && typeof result.body === 'object'
      ? Array.isArray(result.body?.data) ? result.body.data.slice(0, 3) : result.body
      : null,
  };
}

async function probeLlmEndpointDiscover(baseUrl, token, authType) {
  const { url, headers } = llmProbeTarget(baseUrl, token, authType);
  const result = await httpGetJson(url, headers);
  if (result.error || result.status < 200 || result.status >= 300) {
    return { error: result.error || describeProbeFailure(result.status, result.body), url, status: result.status };
  }
  // OpenAI-compatible shape: { data: [{ id, ... }] }; LiteLLM also exposes
  // model_info on each entry. Normalize to our { id, displayName, kind?,
  // contextWindow? } — capturing the provider-reported input context window
  // (#1717) so the real limit, not a guessed 200K, drives the chat header.
  const raw = Array.isArray(result.body?.data) ? result.body.data
            : Array.isArray(result.body)       ? result.body
            : [];
  const models = normalizeDiscoveredModels(raw);
  return { url, count: models.length, models };
}

function validateProbeBody(body) {
  const authType = normalizeAuthType(body?.authType);
  const baseUrl = body?.baseUrl;
  if (authType !== 'oauth-token') {
    if (!baseUrl || typeof baseUrl !== 'string') return { error: 'baseUrl is required' };
    try { new URL(baseUrl); } catch { return { error: 'baseUrl must be a valid URL' }; }
  }
  const authToken = body?.authToken;
  if (authToken !== undefined && authToken !== null && typeof authToken !== 'string') {
    return { error: 'authToken must be a string' };
  }
  return {
    authType,
    baseUrl: authType === 'oauth-token' ? '' : baseUrl,
    token: (typeof authToken === 'string' && authToken.trim()) ? authToken.trim() : '',
  };
}

app.post('/api/llm-endpoints/:id/test', heavyLimiter, async (req, res) => {
  const scope = getScope(req);
  const ep = listLlmEndpoints().find(e => e.id === req.params.id);
  // A stored-token probe is a "use" of the provider — allowed for any caller
  // who can see it (incl. a Team Admin's assigned system provider), absent
  // otherwise (#800). The raw token is never returned, only a pass/fail probe.
  if (!ep || !providerVisible(scope, ep)) return res.status(404).json({ error: 'LLM endpoint not found' });
  const token = readLlmEndpointToken(ep.authTokenId);
  res.json(await probeLlmEndpointTest(ep.baseUrl, token, ep.authType));
});

app.post('/api/llm-endpoints/:id/discover-models', heavyLimiter, async (req, res) => {
  const scope = getScope(req);
  const ep = listLlmEndpoints().find(e => e.id === req.params.id);
  if (!ep || !providerVisible(scope, ep)) return res.status(404).json({ error: 'LLM endpoint not found' });
  const token = readLlmEndpointToken(ep.authTokenId);
  const result = await probeLlmEndpointDiscover(ep.baseUrl, token, ep.authType);
  if (result.error) return res.status(502).json(result);
  res.json(result);
});

// Stateless probe routes — accept baseUrl + authToken directly so the create
// form (and edit-with-unsaved-token) can verify before persisting. The single
// path segment after /api/llm-endpoints/ keeps these from colliding with the
// /:id/{test,discover-models} routes above.
app.post('/api/llm-endpoints/probe-test', heavyLimiter, async (req, res) => {
  const parsed = validateProbeBody(req.body);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  res.json(await probeLlmEndpointTest(parsed.baseUrl, parsed.token, parsed.authType));
});

app.post('/api/llm-endpoints/probe-discover-models', heavyLimiter, async (req, res) => {
  const parsed = validateProbeBody(req.body);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const result = await probeLlmEndpointDiscover(parsed.baseUrl, parsed.token, parsed.authType);
  if (result.error) return res.status(502).json(result);
  res.json(result);
});

/* ─── Subscription-OAuth login flows (proxy to the orchestrator) ─────────
 * The orchestrator runs `claude setup-token` under a PTY and exposes the flow
 * state on its internal API. These proxies surface start/status/code/cancel
 * to the Model Providers page. The one-shot token claim is deliberately NOT
 * proxied — it happens server-side inside POST/PUT /api/llm-endpoints, so the
 * raw token never reaches the browser.
 */

const LLM_AUTH_FLOW_ID_RE = /^[a-f0-9]+$/;

async function proxyLlmAuthFlow(res, method, subPath, body) {
  const orchestratorUrl = process.env.ORCHESTRATOR_URL || 'http://orchestrator:4002';
  try {
    const r = await fetch(`${orchestratorUrl}/internal/llm-auth/flows${subPath}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const payload = await r.json().catch(() => ({}));
    res.status(r.status).json(payload);
  } catch (err) {
    res.status(502).json({ error: `orchestrator unreachable: ${err.message}` });
  }
}

app.post('/api/llm-auth/flows', heavyLimiter, (req, res) => {
  proxyLlmAuthFlow(res, 'POST', '', null);
});

app.get('/api/llm-auth/flows/:id', (req, res) => {
  if (!LLM_AUTH_FLOW_ID_RE.test(req.params.id)) return res.status(400).json({ error: 'invalid flow id' });
  proxyLlmAuthFlow(res, 'GET', `/${req.params.id}`, null);
});

app.post('/api/llm-auth/flows/:id/code', apiLimiter, (req, res) => {
  if (!LLM_AUTH_FLOW_ID_RE.test(req.params.id)) return res.status(400).json({ error: 'invalid flow id' });
  const code = typeof req.body?.code === 'string' ? req.body.code : '';
  proxyLlmAuthFlow(res, 'POST', `/${req.params.id}/code`, { code });
});

app.delete('/api/llm-auth/flows/:id', apiLimiter, (req, res) => {
  if (!LLM_AUTH_FLOW_ID_RE.test(req.params.id)) return res.status(400).json({ error: 'invalid flow id' });
  proxyLlmAuthFlow(res, 'DELETE', `/${req.params.id}`, null);
});

/* ─── Agent-prompt generation (LLM-assisted authoring) ──────────────────
 * The Flow editor's "Add role" dialog lets the operator turn a role name plus
 * a few keyword notes into a polished system/agent prompt instead of writing
 * one by hand. We reuse the same LLM the stack already talks to: a registered
 * Model Provider endpoint when present, otherwise the ANTHROPIC_* fallback
 * from .env. This is a stateless, one-shot completion — nothing is persisted.
 */

// The raw ANTHROPIC_* fallback — used only in the bootstrap case (no Model
// Provider registered platform-wide). Kept identical to the pre-#1211 behaviour
// so a freshly-installed stack with just a `.env` proxy keeps working with zero
// configuration. Subscription-OAuth is not involved here (bootstrap installs
// have no providers at all).
function envFallbackTarget() {
  const baseUrl = (process.env.ANTHROPIC_BASE_URL || '').trim();
  if (!baseUrl) {
    return { error: 'No LLM endpoint configured. Add one on the Model Providers page or set ANTHROPIC_BASE_URL.' };
  }
  const model = (process.env.ANTHROPIC_DEFAULT_SONNET_MODEL || 'claude-sonnet-4-6').trim();
  return { baseUrl, token: (process.env.ANTHROPIC_AUTH_TOKEN || '').trim(), model, endpointId: null, endpointName: '.env' };
}

// Resolve the Model Provider + model an assist call must bill against (#1211,
// concept §4.5). This is the server-side authority: the client's selection
// (X-Assist-Model header, or legacy body.llmEndpointId) is validated against
// the caller's team visibility (assistSelectableEndpoint) and never trusted to
// pick a provider its teams may not use. The pure decision lives in
// assist-target.js; here we add the impure bits (scope, registry, token read,
// .env material) and stamp req.assistMeta for the audit trail.
//
// Returns one of:
//   { selectionError: { status, code, error } } — a 403 (not permitted) or 400
//       (unselected while providers exist). Callers MUST surface it and never
//       mask it behind a heuristic fallback (that would re-open the billing bug).
//   { error }                — a resolved-but-misconfigured provider, or the
//       bootstrap .env fallback with no base URL. Same shape resolveGeneration-
//       Target used, so existing routes treat it exactly as before.
//   { baseUrl, token, model, endpointId, endpointName } — ready to call.
function resolveAssistTarget(req, { requireSelection = true } = {}) {
  const scope = getScope(req);
  const decision = resolveAssistSelection({
    scope,
    endpoints: listLlmEndpoints(),
    selection: parseAssistSelection(req),
    requireSelection,
  });
  if (decision.selectionError) return decision;
  if (decision.error) return { error: decision.error };
  if (decision.env) {
    const env = envFallbackTarget();
    if (!env.error) req.assistMeta = { endpointId: env.endpointId, model: env.model };
    return env;
  }
  const target = {
    baseUrl: decision.baseUrl,
    token: readLlmEndpointToken(decision.endpoint.authTokenId),
    model: decision.model,
    endpointId: decision.endpointId,
    endpointName: decision.endpointName,
  };
  req.assistMeta = { endpointId: target.endpointId, model: target.model };
  return target;
}

// Provenance block echoed on every assist response (#1211 §4.5) — "which key
// paid for this". endpointId is null for the .env bootstrap fallback.
function assistMeta(target) {
  return { assist: { endpointId: target.endpointId ?? null, model: target.model } };
}

// Send a resolveAssistTarget selection error (403/400) as JSON. Returns true so
// route bodies can `if (target.selectionError) return sendAssistSelectionError(res, target);`.
function sendAssistSelectionError(res, target) {
  const e = target.selectionError;
  res.status(e.status).json({ error: e.error, code: e.code });
  return true;
}

// Meta-prompt: instruct the LLM to author a reusable agent/system prompt for a
// role in an autonomous software-delivery flow, from the role name + notes.
function buildAgentPromptGenerationRequest(roleName, notes) {
  const noteBlock = notes
    ? `Additional notes / keywords from the operator:\n${notes}`
    : 'The operator gave no extra notes — infer sensible responsibilities from the role name alone.';
  const instruction = [
    `You write system prompts for AI agents that participate in an autonomous software-delivery team.`,
    `Each agent works from its own workspace, talks to a human over chat, and may react to GitHub events.`,
    ``,
    `Write the system prompt for a role called "${roleName}".`,
    noteBlock,
    ``,
    `Requirements for the prompt you produce:`,
    `- Speak directly to the agent in the second person ("You are …").`,
    `- Open with a one-line identity, then cover the agent's responsibilities, how it should collaborate/hand off, and its quality bar.`,
    `- Keep it practical and concise (roughly 120–250 words). Use short paragraphs or bullet points.`,
    `- Do NOT invent specific tool names, repo names, file paths, or credentials.`,
    `- Output ONLY the prompt text itself — no preamble, no headings like "System prompt:", no surrounding quotes or code fences.`,
  ].join('\n');
  return {
    max_tokens: 1024,
    messages: [{ role: 'user', content: instruction }],
  };
}

// Pull the assistant text out of an Anthropic Messages API response.
function extractMessageText(body) {
  const blocks = body?.content;
  if (!Array.isArray(blocks)) return '';
  return blocks
    .filter(b => b?.type === 'text' && typeof b.text === 'string')
    .map(b => b.text)
    .join('')
    .trim();
}

app.post('/api/agent-prompt/generate', heavyLimiter, async (req, res) => {
  const roleName = typeof req.body?.roleName === 'string' ? req.body.roleName.trim() : '';
  const notes    = typeof req.body?.notes === 'string' ? req.body.notes.trim() : '';
  if (!roleName) return res.status(400).json({ error: 'roleName is required' });

  const target = resolveAssistTarget(req);
  if (target.selectionError) return sendAssistSelectionError(res, target);
  if (target.error) return res.status(400).json({ error: target.error });

  const url = buildMessagesUrl(target.baseUrl);
  const headers = {
    'anthropic-version': '2023-06-01',
    ...(target.token ? { Authorization: `Bearer ${target.token}`, 'x-api-key': target.token } : {}),
  };
  const payload = { model: target.model, ...buildAgentPromptGenerationRequest(roleName, notes) };

  const result = await httpPostJson(url, headers, payload);
  if (result.error || result.status < 200 || result.status >= 300) {
    const detail = result.error
      || (result.body && (result.body.error?.message || result.body.error || result.body.message))
      || `HTTP ${result.status}`;
    return res.status(502).json({ error: `LLM request failed: ${detail}` });
  }
  const prompt = extractMessageText(result.body);
  if (!prompt) return res.status(502).json({ error: 'LLM returned an empty prompt' });
  res.json({ prompt, model: target.model, meta: assistMeta(target) });
});

/* ─── Port suggestion for custom composer roles (#423) ──────────────────
 * Suggests the catalog-v2 wiring surface (patternRole / sessionPolicy /
 * produce flags) for a user-defined role: one stateless LLM call when a
 * generation target resolves, deterministic keyword heuristic otherwise.
 * The response is a SUGGESTION — the dialog shows it as editable fields the
 * user confirms; nothing is applied silently. */
app.post('/api/agent-ports/suggest', heavyLimiter, async (req, res) => {
  const roleName = typeof req.body?.roleName === 'string' ? req.body.roleName.trim() : '';
  const notes = typeof req.body?.notes === 'string' ? req.body.notes.trim() : '';
  const stageName = typeof req.body?.stageName === 'string' ? req.body.stageName.trim() : '';
  if (!roleName) return res.status(400).json({ error: 'roleName is required' });

  const fallback = () => res.json({
    suggestion: heuristicPortSuggestion({ roleName, notes }),
    source: 'heuristic',
  });

  const target = resolveAssistTarget(req);
  if (target.selectionError) return sendAssistSelectionError(res, target);
  if (target.error) return fallback();

  const url = buildMessagesUrl(target.baseUrl);
  const headers = {
    'anthropic-version': '2023-06-01',
    ...(target.token ? { Authorization: `Bearer ${target.token}`, 'x-api-key': target.token } : {}),
  };
  const payload = { model: target.model, ...buildPortSuggestionRequest(roleName, notes, stageName) };
  const result = await httpPostJson(url, headers, payload);
  if (result.error || result.status < 200 || result.status >= 300) return fallback();
  const suggestion = parsePortSuggestion(extractMessageText(result.body));
  if (!suggestion) return fallback();
  res.json({ suggestion, source: 'llm', model: target.model, meta: assistMeta(target) });
});

/* ─── Outcome suggestion for the Routing tab (#828) ─────────────────────
 * Proposes a structured `outcomes` port (mode + options) for an agent/role
 * from its name + system prompt. One stateless LLM call when a generation
 * target resolves, deterministic keyword heuristic otherwise. The response is
 * a SUGGESTION — the Routing tab renders it unconfirmed-highlighted and
 * persists nothing until the operator confirms (concept decision 5). */
app.post('/api/agent-outcomes/suggest', heavyLimiter, async (req, res) => {
  const roleName = typeof req.body?.roleName === 'string' ? req.body.roleName.trim() : '';
  let prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : '';
  if (!roleName && !prompt) return res.status(400).json({ error: 'roleName or prompt is required' });
  // #2032: the peer roles a suggested `wakeAgent` may name, and this role's own
  // id so a self-hand-off is refused. Optional — an older client sends neither
  // and the suggester then says "do not use wakeAgent" rather than inviting a
  // guess. `wakePeerList` filters out actor pseudo-nodes and human roles; the
  // SAME list is the `agents` source `parseOutcomeSuggestion` validates
  // against, so an invented target sinks the suggestion instead of persisting.
  const suggestPeers = wakePeerList(req.body?.peers, req.body?.roleId);
  const suggestRoleId = typeof req.body?.roleId === 'string' ? req.body.roleId.trim() : '';
  const suggestSources = { agents: suggestPeers, ...(suggestRoleId ? { roleId: suggestRoleId } : {}) };

  const fallback = () => res.json({
    suggestion: heuristicOutcomeSuggestion({ roleName, prompt }),
    source: 'heuristic',
  });

  const target = resolveAssistTarget(req);
  if (target.selectionError) return sendAssistSelectionError(res, target);
  if (target.error) return fallback();

  const url = buildMessagesUrl(target.baseUrl);
  const headers = {
    'anthropic-version': '2023-06-01',
    ...(target.token ? { Authorization: `Bearer ${target.token}`, 'x-api-key': target.token } : {}),
  };
  const payload = {
    model: target.model,
    ...buildOutcomeSuggestionRequest(roleName, prompt, undefined, {
      peers: suggestPeers, roleId: suggestRoleId,
    }),
  };
  const result = await httpPostJson(url, headers, payload);
  if (result.error || result.status < 200 || result.status >= 300) return fallback();
  const suggestion = parseOutcomeSuggestion(extractMessageText(result.body), suggestSources);
  if (!suggestion) return fallback();
  res.json({ suggestion, source: 'llm', model: target.model, meta: assistMeta(target) });
});

/* ─── MCP server registry ───────────────────────────────────────────── */

// The legacy pool-wide /api/mcp endpoints (which wrote /pool/.claude/settings.json
// directly) have been replaced by a per-environment registry. Each entry lives at
// /workspace/mcp-servers/<id>/server.json; environments reference servers by id
// and pair them with a credential, and the orchestrator materializes the merged
// MCP block into each agent's own .claude/settings.json at seed time.

app.get('/api/mcp-servers', (req, res) => {
  const scope = getScope(req);
  const out = listMcpServerIds()
    .map(id => loadMcpServer(id))
    .filter(Boolean)
    // #2083: tier-aware. The old comment ("missing teamId → default team") had
    // been stale since #2078 removed that collapse from `visibleTeam` (§8.4);
    // what it must do now is also reach a SHARED server, which carries no
    // `teamId` at all.
    // #2158: a GLOBAL MCP server is visible to everyone regardless of team
    // assignment, same rule as the environment list above.
    .filter(s => visibleEnvironment(scope, s) || isGlobalEnvironment(s))
    .map(s => {
      const transport = s.transport || 'stdio';
      const tplKey = transport === 'stdio' ? 'env' : 'headers';
      const template = (s[tplKey] && typeof s[tplKey] === 'object') ? s[tplKey] : {};
      return {
        id: s.id,
        name: s.name || s.id,
        description: s.description || '',
        transport,
        command: s.command || null,
        args: Array.isArray(s.args) ? s.args : [],
        url: s.url || null,
        templateKeys: Object.keys(template),
        templateField: tplKey,
        requiresCredential: serverNeedsCredential(s),
        // #2158 AC8: a DERIVED reach field, like `publicEndpointView`'s
        // `global: isGlobalProvider(ep)` — never an echoed raw flag, so the
        // badge can never show a global record that has stopped qualifying.
        global: isGlobalEnvironment(s),
      };
    });
  res.json(out);
});

app.get('/api/mcp-servers/:id', (req, res) => {
  const { id } = req.params;
  if (!MCP_SERVER_ID_RE.test(id)) return res.status(400).json({ error: 'Invalid server id' });
  const s = loadMcpServer(id);
  if (!s) return res.status(404).json({ error: 'MCP server not found' });
  // #2083 / concept §11.3: this read was ungated and returned the raw stanza,
  // including any `${credential}` template keys. 404 rather than 403 so the
  // route is not an existence oracle. #2158: also reachable when global —
  // deliberately still 404, never 403, so the refusal shape is unchanged.
  if (!visibleEnvironment(getScope(req), s) && !isGlobalEnvironment(s)) {
    return res.status(404).json({ error: 'MCP server not found' });
  }
  res.json(s);
});

// Validation lives in one place so POST and PUT agree on what's a legal stanza.
// Transport-specific:
//   stdio   → command (required), args (optional), env (template)
//   http    → url (required), headers (template)
//   sse     → url (required), headers (template)
// `env` and `headers` are mutually exclusive on the wire — supplying the wrong
// one for the chosen transport is a 400 so operators don't silently set keys
// that the seed step won't propagate.
function buildMcpServerStanza({ existing, body }) {
  const merged = { ...(existing || {}) };
  const transport = body.transport !== undefined ? body.transport : (existing?.transport || 'stdio');
  if (!['stdio', 'http', 'sse'].includes(transport)) {
    return { error: "transport must be 'stdio', 'http' or 'sse'" };
  }
  merged.transport = transport;

  if (body.name !== undefined) merged.name = body.name;
  if (body.description !== undefined) merged.description = body.description;

  if (transport === 'stdio') {
    if (body.command !== undefined) merged.command = body.command;
    if (body.args !== undefined) merged.args = Array.isArray(body.args) ? body.args : [];
    if (body.env !== undefined) merged.env = (body.env && typeof body.env === 'object') ? body.env : {};
    if (body.url !== undefined || body.headers !== undefined) {
      return { error: "stdio servers don't accept `url` or `headers` — use command/args/env" };
    }
    delete merged.url;
    delete merged.headers;
    if (!merged.command) return { error: 'command is required for stdio transport' };
  } else {
    if (body.url !== undefined) merged.url = body.url;
    if (body.headers !== undefined) merged.headers = (body.headers && typeof body.headers === 'object') ? body.headers : {};
    if (body.command !== undefined || body.args !== undefined || body.env !== undefined) {
      return { error: `${transport} servers don't accept \`command\`/\`args\`/\`env\` — use url/headers` };
    }
    delete merged.command;
    delete merged.args;
    delete merged.env;
    if (!merged.url) return { error: `url is required for ${transport} transport` };
  }

  return { stanza: merged };
}

app.post('/api/mcp-servers', apiLimiter, (req, res) => {
  const body = req.body || {};
  const { id, name } = body;
  if (!id || !MCP_SERVER_ID_RE.test(id)) {
    return res.status(400).json({ error: 'id required, lowercase letters/digits/dashes only' });
  }
  if (!name || typeof name !== 'string') return res.status(400).json({ error: 'name is required' });
  if (loadMcpServer(id)) return res.status(409).json({ error: `MCP server '${id}' already exists` });

  const built = buildMcpServerStanza({ existing: null, body });
  if (built.error) return res.status(400).json({ error: built.error });

  // #2083 — the tier, and the FIRST write authorization these routes have ever
  // had (concept §11.3: `POST`/`PUT`/`DELETE /api/mcp-servers` carried none,
  // unlike `/api/mcp-credentials` beside them and unlike every environment
  // route). Adding a shared tier without it would have left the tier decorative:
  // any authenticated caller could re-assign a shared server to their own team.
  // It IS a behaviour change for a plain Team Member, and it is the change
  // §11.3 asks for.
  let ownership;
  try { ownership = resolveTieredOwnership(body); }
  catch (err) { return res.status(err.status || 400).json({ error: err.message }); }
  const mcpCreateScope = getScope(req);

  // #2158 decision 6: for MCP servers `global` is SET at create time only — the
  // console form stays create-only (`tiered-resource-form-wiring.test.js:95` is
  // not amended), but `PUT` below still honours the flag so retraction never
  // needs delete-and-recreate (AC3a). `currentGlobal` is always `false` here.
  // A global server carries no team assignment at all, so publishing one
  // overrides the resolved ownership to system-with-no-teams BEFORE the
  // create gate — mirroring `POST /api/environments` / `POST /api/llm-endpoints`.
  const globalFlag = resolveEnvGlobalFlag({
    wantGlobal: body.global,
    currentGlobal: false,
    scopeAll: mcpCreateScope.all,
  });
  if (globalFlag.error) {
    return res.status(globalFlag.status).json({ error: globalFlag.error, code: globalFlag.code });
  }
  if (globalFlag.global) ownership = { scope: 'system', teamId: null, assignedTeamIds: [] };

  if (!canCreateEnvironment(mcpCreateScope, ownership)) {
    return res.status(403).json({ error: 'forbidden', code: 'forbidden' });
  }

  const data = {
    id,
    name,
    ...tierOwnershipFields(ownership),
    description: built.stanza.description || '',
    transport: built.stanza.transport,
    ...(built.stanza.transport === 'stdio'
      ? { command: built.stanza.command, args: built.stanza.args || [], env: built.stanza.env || {} }
      : { url: built.stanza.url, headers: built.stanza.headers || {} }),
    createdAt: new Date().toISOString(),
  };
  // #2158 AC6: written only when true — no dangling `global: false` on disk.
  if (globalFlag.global) data.global = true;
  saveMcpServer(id, data);
  res.status(201).json(data);
});

app.put('/api/mcp-servers/:id', apiLimiter, (req, res) => {
  const { id } = req.params;
  if (!MCP_SERVER_ID_RE.test(id)) return res.status(400).json({ error: 'Invalid server id' });
  const existing = loadMcpServer(id);
  if (!existing) return res.status(404).json({ error: 'MCP server not found' });
  // #2083 / §11.3 — this route had no authorization at all, and no re-parenting
  // check either (the environment PUT has required rights over the TARGET team
  // since #989).
  const mcpScope = getScope(req);
  if (!canManageEnvironment(mcpScope, existing)) {
    return res.status(403).json({ error: 'forbidden', code: 'forbidden' });
  }

  const built = buildMcpServerStanza({ existing, body: req.body || {} });
  if (built.error) return res.status(400).json({ error: built.error });

  const merged = { ...built.stanza, updatedAt: new Date().toISOString() };

  // #2158 AC3a: `PUT` sets AND clears `global` for a System Admin through the
  // same `resolveEnvGlobalFlag` gate as environments — decision 6 makes the
  // MCP *form* create-only, not the API, so retracting (or re-publishing) a
  // global MCP server never requires delete-and-recreate, which would break
  // every `mcpServers[].serverId` binding and every already-seeded agent
  // settings file. Omitting `global` from the body keeps the current value.
  // Resolved BEFORE the re-tier block below for the same reason as the
  // environment PUT: a global record's forced system-with-no-teams shape must
  // win over any teamId/scope/assignedTeamIds the same body also sent.
  const mcpGlobalFlag = resolveEnvGlobalFlag({
    wantGlobal: req.body?.global,
    currentGlobal: existing.global === true,
    scopeAll: mcpScope.all,
  });
  if (mcpGlobalFlag.error) {
    return res.status(mcpGlobalFlag.status).json({ error: mcpGlobalFlag.error, code: mcpGlobalFlag.code });
  }

  // Ownership (#302, tiered by #2083). `buildMcpServerStanza` spreads
  // `existing`, so the old tier fields ride along on `built.stanza` and must be
  // restated explicitly — writing them from the resolved ownership is what
  // stops a stale `teamId` surviving a promotion to the shared tier. The
  // re-tier gate is the environment PUT's, for the reasons documented there.
  if (mcpGlobalFlag.global) {
    const nextOwnership = { scope: 'system', teamId: null, assignedTeamIds: [] };
    if (isRetier(existing, nextOwnership) && !canRetierEnvironment(mcpScope)) {
      return res.status(403).json({ error: 'Only a System Admin may change which teams an MCP server belongs to', code: 'forbidden' });
    }
    Object.assign(merged, tierOwnershipFields(nextOwnership));
  } else if (req.body && (req.body.teamId !== undefined || req.body.scope !== undefined
                   || req.body.assignedTeamIds !== undefined)) {
    let nextOwnership;
    try { nextOwnership = resolveTieredOwnership(req.body); }
    catch (err) { return res.status(err.status || 400).json({ error: err.message }); }
    if (isRetier(existing, nextOwnership) && !canRetierEnvironment(mcpScope)) {
      return res.status(403).json({ error: 'Only a System Admin may change which teams an MCP server belongs to', code: 'forbidden' });
    }
    Object.assign(merged, tierOwnershipFields(nextOwnership));
  } else {
    Object.assign(merged, tierOwnershipFields(existing));
  }

  if (mcpGlobalFlag.global) merged.global = true;
  else delete merged.global;

  saveMcpServer(id, merged);
  res.json(merged);
});

app.delete('/api/mcp-servers/:id', apiLimiter, (req, res) => {
  const { id } = req.params;
  if (!MCP_SERVER_ID_RE.test(id)) return res.status(400).json({ error: 'Invalid server id' });
  const existing = loadMcpServer(id);
  if (!existing) return res.status(404).json({ error: 'MCP server not found' });
  // #2083 / §11.3 — third of the three ungated writes. Deleting a registry
  // entry other teams may be running against was open to any caller.
  if (!canManageEnvironment(getScope(req), existing)) {
    return res.status(403).json({ error: 'forbidden', code: 'forbidden' });
  }
  const usedBy = mcpServerInUse(id);
  if (usedBy) return res.status(409).json({ error: `MCP server is used by environment '${usedBy}'. Detach it first.` });
  // Path-injection containment (#208): re-confine the resolved server dir under
  // MCP_SERVERS_DIR — MCP_SERVER_ID_RE alone is not CodeQL-legible for the sink.
  const mcpServersBaseDir = path.resolve(MCP_SERVERS_DIR);
  const serverDir = path.resolve(mcpServersBaseDir, id);
  const relServerDir = path.relative(mcpServersBaseDir, serverDir);
  if (relServerDir.startsWith('..') || path.isAbsolute(relServerDir)) return res.status(400).json({ error: 'Invalid server id' });
  try { fs.rmSync(serverDir, { recursive: true, force: true }); } catch { /* ignore */ }
  res.status(204).end();
});

/* ─── MCP credentials ───────────────────────────────────────────────── */

app.get('/api/mcp-credentials', (req, res) => {
  // Metadata only — never the raw secret.
  const scope = getScope(req);
  res.json(listMcpCredentials().filter(c => visibleTeam(scope, c.teamId))); // (#302)
});

app.post('/api/mcp-credentials', apiLimiter, (req, res) => {
  const { name, serverId, secret, id: rawId, teamId } = req.body || {};
  if (!name || typeof name !== 'string') return res.status(400).json({ error: 'name is required' });
  if (!secret || typeof secret !== 'string') return res.status(400).json({ error: 'secret (string) is required' });
  let ownerTeamId;
  try { ownerTeamId = resolveOwnerTeamId(teamId); }
  catch (err) { return res.status(err.status || 400).json({ error: err.message }); }
  // Config-write authorization (#989): creating an MCP credential requires
  // team-admin management rights over its owning team.
  if (!canManageEnvironment(getScope(req), { teamId: ownerTeamId })) {
    return res.status(403).json({ error: 'forbidden', code: 'forbidden' });
  }
  if (serverId !== undefined && serverId !== null && !MCP_SERVER_ID_RE.test(serverId)) {
    return res.status(400).json({ error: 'Invalid serverId' });
  }
  if (serverId && !loadMcpServer(serverId)) {
    return res.status(400).json({ error: `MCP server '${serverId}' does not exist` });
  }

  const existing = listMcpCredentials();
  let id;
  if (rawId !== undefined && rawId !== null && String(rawId).trim() !== '') {
    id = String(rawId).trim();
    if (!MCP_CREDENTIAL_ID_RE.test(id)) return res.status(400).json({ error: 'id must contain lowercase letters, digits and hyphens only' });
    if (existing.some(c => c.id === id)) return res.status(409).json({ error: `MCP credential id '${id}' already exists` });
  } else {
    const baseId = name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    id = baseId || `cred-${Date.now()}`;
    if (existing.some(c => c.id === id)) {
      id = `${id}-${Date.now().toString(36)}`;
    }
  }
  if (!MCP_CREDENTIAL_ID_RE.test(id)) return res.status(400).json({ error: 'Invalid credential id' });

  const mcpCredsRoot = path.resolve(MCP_CREDENTIALS_KEYS_DIR);
  const credPath = path.resolve(mcpCredsRoot, path.basename(id));
  if (credPath !== mcpCredsRoot && !credPath.startsWith(mcpCredsRoot + path.sep)) {
    return res.status(400).json({ error: 'Invalid credential id' });
  }
  fs.writeFileSync(credPath, secret, { mode: 0o600 });
  try { fs.chmodSync(credPath, 0o600); } catch { /* best effort */ }

  const entry = {
    id,
    name,
    teamId: ownerTeamId,
    serverId: serverId || null,
    fingerprint: mcpCredentialFingerprint(secret),
    createdAt: new Date().toISOString(),
  };
  saveMcpCredentialsIndex([...existing, entry]);
  res.status(201).json(entry);
});

app.delete('/api/mcp-credentials/:id', apiLimiter, (req, res) => {
  const { id } = req.params;
  if (!MCP_CREDENTIAL_ID_RE.test(id)) return res.status(400).json({ error: 'Invalid credential id' });
  const creds = listMcpCredentials();
  const cred = creds.find(c => c.id === id);
  if (!cred) return res.status(404).json({ error: 'MCP credential not found' });
  // Config-write authorization (#989): deleting an MCP credential requires
  // team-admin management rights over its owning team.
  if (!canManageEnvironment(getScope(req), { teamId: cred.teamId })) {
    return res.status(403).json({ error: 'forbidden', code: 'forbidden' });
  }
  const usedBy = mcpCredentialInUse(id);
  if (usedBy) return res.status(409).json({ error: `MCP credential is used by environment '${usedBy}'. Detach it first.` });
  // Path-injection containment (#211): re-confine the resolved key file under
  // MCP_CREDENTIALS_KEYS_DIR — MCP_CREDENTIAL_ID_RE alone is not CodeQL-legible.
  const mcpCredsBaseDir = path.resolve(MCP_CREDENTIALS_KEYS_DIR);
  const credFile = path.resolve(mcpCredsBaseDir, id);
  const relCredFile = path.relative(mcpCredsBaseDir, credFile);
  if (relCredFile.startsWith('..') || path.isAbsolute(relCredFile)) return res.status(400).json({ error: 'Invalid credential id' });
  try { fs.unlinkSync(credFile); } catch { /* ignore */ }
  saveMcpCredentialsIndex(creds.filter(c => c.id !== id));
  res.status(204).end();
});

// True iff at least one entry in the server's substitution template references
// the `${credential}` placeholder. The template lives under `env` for stdio
// servers and `headers` for http/sse — check whichever is present so the
// answer doesn't depend on whether the operator picked the right field name.
function serverNeedsCredential(server) {
  if (!server) return false;
  const transport = server.transport || 'stdio';
  const tpl = transport === 'stdio' ? server.env : server.headers;
  if (!tpl || typeof tpl !== 'object') return false;
  return Object.values(tpl).some(v => typeof v === 'string' && v.includes('${credential}'));
}

/* ─── Containers ────────────────────────────────────────────────────── */

app.get('/api/containers', apiLimiter, async (req, res) => {
  const orchestratorUrl = process.env.ORCHESTRATOR_URL || 'http://orchestrator:4002';
  try {
    const resp = await fetch(`${orchestratorUrl}/internal/agents/processes`);
    if (!resp.ok) return res.json([]);
    const processes = await resp.json();
    // Normalize to the shape the Logs page expects: { name, state }
    res.json(processes.map(p => ({
      name: `agent-${p.id}`,
      state: p.running ? 'running' : 'exited',
      pid: p.pid,
    })));
  } catch {
    res.json([]);
  }
});

/* ─── Log streaming (SSE) ───────────────────────────────────────────── */

app.get('/api/logs/stream', (req, res) => {
  const container = req.query.container || 'orchestrator';
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const opts = {
    socketPath: PODMAN_SOCK,
    path: `/v4.0.0/libpod/containers/${container}/logs?follow=true&stdout=true&stderr=true&tail=200`,
    method: 'GET',
  };
  const req2 = http.request(opts, (logRes) => {
    logRes.on('data', (chunk) => {
      // Podman multiplexes stdout/stderr with 8-byte header — strip it
      // Header: [stream_type(1), 0,0,0, size(4)] then payload
      let offset = 0;
      while (offset < chunk.length) {
        if (chunk.length - offset < 8) break;
        const size = chunk.readUInt32BE(offset + 4);
        const line = chunk.slice(offset + 8, offset + 8 + size).toString('utf8').trimEnd();
        if (line) res.write(`data: ${JSON.stringify(line)}\n\n`);
        offset += 8 + size;
      }
    });
    logRes.on('end', () => res.write('event: close\ndata: {}\n\n'));
  });
  req2.on('error', (err) => res.write(`data: ${JSON.stringify('[log error: ' + err.message + ']')}\n\n`));
  req2.end();
  req.on('close', () => req2.destroy());
});

/* ─── Working Environments ──────────────────────────────────────────── */

function normalizeEnvId(raw) {
  return String(raw || '').toLowerCase().replace(/[^a-z0-9-]/g, '');
}

// Accept the new `repositories: [...]` array or the legacy single `repository`
// payload, validate referenced SSH keys exist, and return the normalized array.
// Throws on validation failure so the caller can surface a 400.
function normalizeRepositoriesInput(repositories, legacyRepository) {
  let raw;
  if (Array.isArray(repositories)) {
    raw = repositories;
  } else if (legacyRepository && typeof legacyRepository === 'object') {
    raw = legacyRepository.url ? [legacyRepository] : [];
  } else {
    raw = [];
  }

  const cleaned = [];
  const knownKeys = listSshKeys();
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const url = typeof entry.url === 'string' ? entry.url.trim() : '';
    if (!url) continue;
    const sshKeyId = entry.sshKeyId || null;
    if (sshKeyId && !knownKeys.some(k => k.id === sshKeyId)) {
      throw new Error(`SSH key '${sshKeyId}' not found`);
    }
    cleaned.push({
      url,
      branch: entry.branch ? String(entry.branch).trim() || null : null,
      sshKeyId: sshKeyId || null,
      // Read-only marker (#1813): the repo is cloned as reference only and the
      // agent is told not to push to it. Defaults off — an entry without the
      // flag (every pre-#1813 environment) round-trips as writable, unchanged.
      readOnly: entry.readOnly === true,
    });
  }
  return cleaned;
}

// Validate the MCP server refs an environment carries: each entry must point at
// a known server id; credentialId is optional but, when present, must exist.
// Throws on validation failure so the caller can surface a 400.
function normalizeMcpServersInput(input) {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) throw new Error('mcpServers must be an array');
  const knownCreds = listMcpCredentials();
  const cleaned = [];
  for (const entry of input) {
    if (!entry || typeof entry !== 'object') continue;
    const serverId = typeof entry.serverId === 'string' ? entry.serverId.trim() : '';
    if (!serverId) continue;
    if (!MCP_SERVER_ID_RE.test(serverId)) throw new Error(`Invalid mcpServers.serverId: ${serverId}`);
    if (!loadMcpServer(serverId)) throw new Error(`MCP server '${serverId}' not found`);
    let credentialId = null;
    if (entry.credentialId) {
      credentialId = String(entry.credentialId).trim();
      if (!MCP_CREDENTIAL_ID_RE.test(credentialId)) throw new Error(`Invalid mcpServers.credentialId: ${credentialId}`);
      if (!knownCreds.some(c => c.id === credentialId)) throw new Error(`MCP credential '${credentialId}' not found`);
    }
    cleaned.push({ serverId, credentialId });
  }
  return cleaned;
}

/* ─── Teams data model (#299) ───────────────────────────────────────────
 * Thin proxy onto the orchestrator's /internal/admin/* surface, which owns the
 * Team / user / membership store. These are the *human* Team endpoints — the
 * tenant/visibility scope — distinct from the Agent-Team wizard at POST
 * /api/teams. Auth & list-filtering are deliberately out of scope here.
 */
// Low-level call onto the orchestrator's /internal/admin/* surface. Resolves to
// `{ status, data }` so scope-aware handlers can inspect/filter the payload
// before responding; rejects only on transport failure (surfaced as 502).
function callAdmin(method, subPath, body) {
  const orchestratorUrl = process.env.ORCHESTRATOR_URL || 'http://orchestrator:4002';
  const init = { method, headers: { 'Content-Type': 'application/json' } };
  if (method === 'POST' || method === 'PUT') {
    init.body = JSON.stringify(body || {});
  }
  return fetch(`${orchestratorUrl}/internal/admin/${subPath}`, init).then(async (resp) => {
    const text = await resp.text();
    return { status: resp.status, data: text ? JSON.parse(text) : {} };
  });
}

// Straight pass-through (used after the caller has already been authorized).
function proxyAdmin(req, res, subPath) {
  return callAdmin(req.method, subPath, req.body)
    .then(({ status, data }) => res.status(status).json(data))
    .catch((err) => res.status(502).json({ error: `Orchestrator unreachable: ${err.message}` }));
}

function adminQuery(req) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(req.query || {})) {
    if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  }
  const s = qs.toString();
  return s ? `?${s}` : '';
}

// Deny a management action the caller isn't authorized for (#584). Returns true
// (and has already sent a 403) when denied, so callers early-return on it.
function denyAdmin(res, reason) {
  res.status(403).json({ error: reason || 'Forbidden', code: 'forbidden' });
  return true;
}

// ── Admin surface: scope-filtered reads + role-gated mutations (#584) ────────
// The env admin and System Admins keep `all: true` (full visibility, no
// regression to the single-operator setup). Non-admins see only teams they
// belong to, only users/memberships within those teams, and may mutate only a
// team they are the team-admin of. Team/user record creation and global role
// assignment stay System-Admin actions (docs/multi-user-concept.md §3).

// Teams — list is filtered to the caller's own teams (AC1).
app.get('/api/admin/teams', (req, res) => {
  const scope = getScope(req);
  return callAdmin('GET', 'teams')
    .then(({ status, data }) => {
      if (status >= 400 || !Array.isArray(data)) return res.status(status).json(data);
      res.json(scope.all ? data : data.filter(t => visibleTeam(scope, t.id)));
    })
    .catch((err) => res.status(502).json({ error: `Orchestrator unreachable: ${err.message}` }));
});
// RETIRED (#2081 AC3, epic #2076 P3). This route minted an access SCOPE, and it
// was System-Admin-only for the reason the old comment gave: "a fresh team has
// no members, so a non-admin creator could not even see it afterwards". P1's
// owner model plus the creator membership `POST /api/teams` now writes remove
// that obstacle, and D1 collapses the two layers — an **Agent Team** is the
// team. Creating one is self-service through `POST /api/teams` and its stream
// twin, so there is exactly one creation path and it is not admin-gated.
//
// 410, not 404: the resource is gone on purpose, and a `Gone` naming its
// successor is the difference between "this API changed" and "my request was
// malformed". The remaining `/api/admin/teams` verbs stay — `teams/index.json`
// is still the live source for the Access page and the team dropdowns until the
// P5 successor retires it (concept A3.3) — so existing scopes stay readable,
// editable and deletable; only minting NEW ones is closed.
app.post('/api/admin/teams', apiLimiter, (_req, res) => {
  return res.status(410).json({
    error: 'Team creation has moved: create an Agent Team with POST /api/teams. '
      + 'Access scopes are no longer created separately.',
    code: 'team-create-retired',
  });
});
app.get('/api/admin/teams/:id', (req, res) => {
  const scope = getScope(req);
  if (!visibleTeam(scope, req.params.id)) return res.status(404).json({ error: 'Team not found' });
  return proxyAdmin(req, res, `teams/${encodeURIComponent(req.params.id)}`);
});
app.put('/api/admin/teams/:id', apiLimiter, (req, res) => {
  const scope = getScope(req);
  if (!canManageTeam(scope, req.params.id)) return denyAdmin(res, 'You may not manage this team');
  return proxyAdmin(req, res, `teams/${encodeURIComponent(req.params.id)}`);
});
app.delete('/api/admin/teams/:id', apiLimiter, (req, res) => {
  const scope = getScope(req);
  if (!canManageTeam(scope, req.params.id)) return denyAdmin(res, 'You may not manage this team');
  return proxyAdmin(req, res, `teams/${encodeURIComponent(req.params.id)}`);
});

// The OPEN user directory (#2041 D2, first built for #2068's draft Share
// picker). Deliberately NOT `/api/admin/users`: that route returns the whole
// record — subject, `systemAdmin`, `githubHandle`, `hasPassword` — and is
// narrowed to users who share one of the caller's teams, which would make a
// colleague on another team unshareable. Sharing needs the opposite: every
// account, and only what is needed to recognise a person.
//
// So the projection is display name and email ONLY — never the `systemAdmin`
// flag (D2) and never the GitHub handle (D11) — and it is read straight from
// the users index rather than proxied, because there is nothing to filter.
app.get('/api/users/directory', (req, res) => {
  res.json(draftAccess.userDirectory(readJsonFile(USERS_INDEX, [])));
});

// Users — list/read filtered to users who share one of the caller's teams
// (AC2). Global user-record CRUD + role assignment is System-Admin only (§3).
app.get('/api/admin/users', (req, res) => {
  const scope = getScope(req);
  const memberships = readJsonFile(MEMBERSHIPS_INDEX, []);
  return callAdmin('GET', `users${adminQuery(req)}`)
    .then(({ status, data }) => {
      if (status >= 400 || !Array.isArray(data)) return res.status(status).json(data);
      res.json(scope.all ? data : data.filter(u => visibleUser(scope, u.id, memberships)));
    })
    .catch((err) => res.status(502).json({ error: `Orchestrator unreachable: ${err.message}` }));
});
app.post('/api/admin/users', apiLimiter, (req, res) => {
  const scope = getScope(req);
  if (!scope.all) return denyAdmin(res, 'Only a System Admin may manage user records');
  return proxyAdmin(req, res, 'users');
});
app.get('/api/admin/users/:id', (req, res) => {
  const scope = getScope(req);
  const memberships = readJsonFile(MEMBERSHIPS_INDEX, []);
  if (!visibleUser(scope, req.params.id, memberships)) return res.status(404).json({ error: 'User not found' });
  return proxyAdmin(req, res, `users/${encodeURIComponent(req.params.id)}`);
});
app.put('/api/admin/users/:id', apiLimiter, (req, res) => {
  const scope = getScope(req);
  if (!scope.all) return denyAdmin(res, 'Only a System Admin may manage user records');
  return proxyAdmin(req, res, `users/${encodeURIComponent(req.params.id)}`);
});
app.delete('/api/admin/users/:id', apiLimiter, (req, res) => {
  const scope = getScope(req);
  if (!scope.all) return denyAdmin(res, 'Only a System Admin may manage user records');
  // DD3 (#2068) — the departing human is stripped from every draft's access set.
  // Done here rather than in `teamsStore.deleteUser` because the admin-console
  // API is the only writer of /workspace/process-drafts; the orchestrator would
  // be a second one racing it. Runs only after the record is really gone, and is
  // best-effort: a failed strip must not turn a completed offboarding into an
  // error, and the next run of the same delete would repeat it.
  return callAdmin('DELETE', `users/${encodeURIComponent(req.params.id)}`)
    .then(({ status, data }) => {
      if (status < 400) {
        try { stripUserFromDrafts(req.params.id); }
        catch (err) { console.error(`[Admin] Draft access strip failed for user ${req.params.id}: ${err.message}`); }
      }
      return res.status(status).json(data);   // same response shape as proxyAdmin
    })
    .catch((err) => res.status(502).json({ error: `Orchestrator unreachable: ${err.message}` }));
});
// Local password set/clear (#374). The verify path is NOT proxied here — it is
// called directly by the public login route (see auth.js), pre-session.
app.post('/api/admin/users/:id/password', apiLimiter, (req, res) => {
  const scope = getScope(req);
  if (!scope.all) return denyAdmin(res, 'Only a System Admin may set user passwords');
  return proxyAdmin(req, res, `users/${encodeURIComponent(req.params.id)}/password`);
});
app.delete('/api/admin/users/:id/password', apiLimiter, (req, res) => {
  const scope = getScope(req);
  if (!scope.all) return denyAdmin(res, 'Only a System Admin may clear user passwords');
  return proxyAdmin(req, res, `users/${encodeURIComponent(req.params.id)}/password`);
});

// Self-service per-user preferences (#1437). A logged-in user updates their OWN
// profile settings (currently just the Agent-Chat transcript font size) without
// System-Admin rights. The write is pinned to the caller's OWN resolved userId
// (never an id from the request), so — unlike the admin CRUD above — it can
// touch no other user's record. Since #2059 every authenticated caller resolves
// to a record, so the `scope.userId == null` arm below is a fail-closed guard
// rather than a state a signed-in human can be in — it used to be the env
// single-admin's permanent condition, which is why `PUT /api/me/preferences`
// was a silent no-op for the only principal a fresh stack had. It still accepts
// the value (so the client's optimistic apply + localStorage fallback work) and
// still reports it as not persisted. teamsStore.updateUser is the authoritative
// validator (range / integer check → 400).
app.put('/api/me/preferences', apiLimiter, (req, res) => {
  const scope = getScope(req);
  const patch = {};
  if (req.body && req.body.chatFontSize !== undefined) {
    patch.chatFontSize = req.body.chatFontSize;
  }
  if (Object.keys(patch).length === 0) {
    return res.status(400).json({ error: 'No supported preference in request body', code: 'no_preference' });
  }
  if (scope.userId == null) {
    return res.json({ persisted: false });
  }
  return callAdmin('PUT', `users/${encodeURIComponent(scope.userId)}`, patch)
    .then(({ status, data }) => {
      if (status >= 400) return res.status(status).json(data);
      res.json({ persisted: true, user: data });
    })
    .catch((err) => res.status(502).json({ error: `Orchestrator unreachable: ${err.message}` }));
});

// Memberships — list filtered to the caller's teams (AC2); mutations require
// team-admin of the target team (AC3).
app.get('/api/admin/memberships', (req, res) => {
  const scope = getScope(req);
  return callAdmin('GET', `memberships${adminQuery(req)}`)
    .then(({ status, data }) => {
      if (status >= 400 || !Array.isArray(data)) return res.status(status).json(data);
      res.json(scope.all ? data : data.filter(m => visibleTeam(scope, m.teamId)));
    })
    .catch((err) => res.status(502).json({ error: `Orchestrator unreachable: ${err.message}` }));
});
app.post('/api/admin/memberships', apiLimiter, (req, res) => {
  const scope = getScope(req);
  const teamId = req.body && req.body.teamId;
  if (!canManageTeam(scope, teamId)) return denyAdmin(res, 'You may not manage members of this team');
  return proxyAdmin(req, res, 'memberships');
});
app.delete('/api/admin/memberships', apiLimiter, (req, res) => {
  const scope = getScope(req);
  const teamId = req.query && req.query.teamId;
  if (!canManageTeam(scope, teamId)) return denyAdmin(res, 'You may not manage members of this team');
  return proxyAdmin(req, res, `memberships${adminQuery(req)}`);
});

/* ─── Agent toolchain registry (#1940, concept docs/agent-toolchains-concept.md §3)
 *
 * The operator-curated list of agent container images a Working Environment may
 * select from. It exists because the alternative — a free-text image field on
 * the environment — is a privilege-escalation path, not a convenience:
 * `startAgentProcess` injects the environment's SSH identity, its GitHub PAT and
 * the model credential into every agent container, so whoever types the image
 * reference runs arbitrary code with those secrets.
 *
 * The authorisation split therefore copies the plugin registry rather than
 * inventing a second model (`POST /api/plugins/:id/install`, System-Admin-only):
 *   - a SYSTEM ADMIN registers/removes a toolchain — the only place in the whole
 *     product where an image reference is accepted from a client;
 *   - a TEAM ADMIN selects a registered one by ID on their environment, and can
 *     do nothing else. `PUT /api/environments/:id` validates the id against this
 *     registry and stores the id; the orchestrator resolves it to an image at
 *     spawn time (orchestrator/toolchain-registry.js).
 * Both gates are SERVER-SIDE 403s (AC6), not hidden buttons.
 *
 * This ticket ships the mechanism and no toolchain: the `toolchains/<id>/`
 * source tree, `make toolchain-images` and the first JVM variant are #1941,
 * which fills this registry rather than replacing it.
 */
const TOOLCHAINS_DIR = path.join(WORKSPACE, 'toolchains');
const TOOLCHAINS_INDEX = path.join(TOOLCHAINS_DIR, 'index.json');

// Re-validated on every read (the plugin-registry.js discipline) — this file is
// the boundary that keeps a Team Admin from introducing an image reference, so a
// hand-edited entry is rejected here too, not only at the route that wrote it.
function listToolchains() {
  const { toolchains } = normalizeToolchainRegistry(readJsonFile(TOOLCHAINS_INDEX, []));
  return toolchains;
}

function saveToolchains(list) {
  fs.mkdirSync(TOOLCHAINS_DIR, { recursive: true });
  writeJsonAtomic(TOOLCHAINS_INDEX, list);
}

// The SHIPPED variants (#1941): `toolchains/<id>/toolchain.json` from this
// repository, seeded into the pool by `make seed-toolchains` exactly like a
// reference plugin. Seeding installs nothing — it only makes the manifest
// readable here, so installing a variant is picking an id whose description an
// operator just read, instead of retyping an image reference from a Dockerfile.
//
// `_`-prefixed directories hold material shared between variants (the bootstrap
// script), never a variant — the same convention `listPluginDirs` uses.
const POOL_TOOLCHAINS_DIR = path.join(POOL_DIR, 'toolchains');

// Where a variant's image actually lives in THIS deployment (#1941 AC11). A
// manifest declares the bare `repo:tag` the build produces; a cluster pulls the
// same image from its Artifact Registry under the release's tag. Both halves
// arrive as env vars on the deployment (the overlay patch that carries
// AGENT_IMAGE, pinned per release by deploy/k8s/set-images.sh) and are empty on
// a local Podman stack.
//
// The console is DISPLAY-ONLY here. The registry entry it persists keeps the
// manifest's bare tag and the orchestrator resolves the deployment reference at
// spawn time — persisting a release-pinned reference would go stale on the next
// release. This is used to show an operator what will actually be pulled, and
// the console gets the same two env vars for exactly that reason: shown from one
// side and resolved from the other, the install review would otherwise describe
// an image the cluster never pulls.
function toolchainImageRef(image) {
  return resolveToolchainImage(image, {
    prefix: process.env.AEE_TOOLCHAIN_IMAGE_PREFIX || '',
    tag: process.env.AEE_TOOLCHAIN_IMAGE_TAG || '',
  });
}

// Read + validate one seeded manifest. Never throws: an invalid manifest is
// reported WITH its errors rather than hidden, so an operator can see why a
// variant they expected is not installable (the readPluginDir discipline).
function readSeededToolchain(id) {
  if (!/^[a-z0-9][a-z0-9._-]{0,39}$/.test(id)) return { id, ok: false, errors: ['invalid toolchain id'] };
  const file = path.join(POOL_TOOLCHAINS_DIR, id, 'toolchain.json');
  // Containment: the id is regex-bounded above (no slashes), re-checked here
  // because this path is attacker-adjacent.
  if (!path.resolve(file).startsWith(path.resolve(POOL_TOOLCHAINS_DIR) + path.sep)) {
    return { id, ok: false, errors: ['invalid toolchain id'] };
  }
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (err) { return { id, ok: false, errors: [`cannot read toolchain.json: ${err.message}`] }; }
  const v = validateToolchainManifest(parsed, { dirId: id });
  if (!v.ok) return { id, ok: false, errors: v.errors };
  return { id, ok: true, manifest: v.manifest };
}

function listSeededToolchains() {
  let entries = [];
  try {
    entries = fs.readdirSync(POOL_TOOLCHAINS_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('_') && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort();
  } catch { return []; }
  return entries.map(readSeededToolchain);
}

// Which environments currently select a toolchain — used to refuse a removal
// that would leave an environment pointing at nothing (its agents would then
// refuse to spawn with `toolchain-not-registered`, which is correct but a
// terrible way to find out).
function environmentsUsingToolchain(toolchainId) {
  return listEnvironmentIds().map(loadEnvironment).filter(Boolean)
    .filter((e) => (e.toolchainId || null) === toolchainId)
    .map((e) => ({ id: e.id, name: e.name }));
}

// Readable by any authenticated user: a Team Admin has to see the options to
// pick one, and an entry carries no secret (a name, a description and an image
// reference the operator chose to publish).
app.get('/api/toolchains', (req, res) => {
  const toolchains = listToolchains().map((t) => ({
    ...t,
    environments: environmentsUsingToolchain(t.id),
    // What the orchestrator will ACTUALLY pull for this entry (#1941 AC11).
    // The stored `image` is the manifest's bare tag; on a cluster the pull is
    // from the Artifact Registry under the pinned release tag. Reported next to
    // it rather than instead of it, so an operator debugging an ImagePullBackOff
    // can see both the registered name and the resolved reference.
    effectiveImage: toolchainImageRef(t.image),
  }));
  // The shipped-but-not-yet-installed variants (#1941), each with the
  // plain-language description the System Admin is meant to read BEFORE
  // installing. An invalid manifest is listed with its errors rather than
  // dropped, so "where is the JVM toolchain?" has an answer.
  const installed = new Set(toolchains.map((t) => t.id));
  const available = listSeededToolchains()
    .filter((entry) => !installed.has(entry.id))
    .map((entry) => (entry.ok
      ? {
        ...toolchainFromManifest(entry.manifest),
        effectiveImage: toolchainImageRef(entry.manifest.image),
        versionManager: entry.manifest.versionManager,
        ok: true,
      }
      : { id: entry.id, ok: false, errors: entry.errors }));
  res.json({
    toolchains,
    available,
    // The installation-wide default every environment without a toolchain uses
    // (AC1/AC9) — shown so an operator can see what "no toolchain" resolves to.
    defaultImage: process.env.AGENT_IMAGE || BUILTIN_AGENT_IMAGE,
    runtime: normalizeToolchainRuntime(process.env.AEE_CONTAINER_RUNTIME),
    canManage: !!getScope(req).all,
  });
});

app.post('/api/toolchains', heavyLimiter, (req, res) => {
  if (!getScope(req).all) return res.status(403).json({ error: 'System Admin required' });
  const body = req.body || {};
  // TWO DOORS, ONE GATEKEEPER (#1941). A bare `{ id }` installs a SHIPPED
  // variant: the image reference is then read from the seeded manifest, so the
  // operator never retypes it and cannot typo it. Anything else is still the
  // #1940 path — a hand-registered entry for an image this repository does not
  // ship. Either way the result goes through `validateToolchain` before it is
  // persisted, and either way what is PERSISTED is the reference as declared:
  // the deployment's registry path and release tag are applied at spawn time
  // (AC11), so this file never carries a reference that a release can stale.
  let candidate = body;
  if (body.id && body.image === undefined) {
    const seeded = readSeededToolchain(String(body.id));
    if (!seeded.ok) {
      return res.status(400).json({
        error: `Toolchain '${body.id}' is not available to install: ${seeded.errors.join('; ')}. `
          + 'Shipped toolchains reach the pool via `make seed-toolchains`; for anything else, supply the image reference.',
        errors: seeded.errors,
      });
    }
    candidate = toolchainFromManifest(seeded.manifest);
  }
  const v = validateToolchain(candidate);
  if (!v.ok) return res.status(400).json({ error: v.errors[0], errors: v.errors });
  const list = listToolchains();
  if (list.some((t) => t.id === v.toolchain.id)) {
    return res.status(409).json({ error: `Toolchain '${v.toolchain.id}' already exists` });
  }
  saveToolchains([...list, v.toolchain]);
  res.status(201).json(v.toolchain);
});

app.delete('/api/toolchains/:id', heavyLimiter, (req, res) => {
  if (!getScope(req).all) return res.status(403).json({ error: 'System Admin required' });
  const id = String(req.params.id || '');
  const list = listToolchains();
  if (!list.some((t) => t.id === id)) {
    return res.status(404).json({ error: `Toolchain '${id}' not found` });
  }
  const usedBy = environmentsUsingToolchain(id);
  if (usedBy.length) {
    return res.status(409).json({
      error: `Toolchain '${id}' is selected by ${usedBy.length} Working Environment(s): `
        + `${usedBy.map((e) => e.name || e.id).join(', ')}. Clear it there first.`,
      environments: usedBy,
    });
  }
  saveToolchains(list.filter((t) => t.id !== id));
  res.status(204).end();
});

// Resolve a client-supplied toolchain SELECTION (an id, never an image) against
// the registry. A Team Admin may only name something a System Admin registered —
// this is the enforcement point for that half of AC6, and the reason no
// environment route ever reads an `image` field from a request body.
function resolveToolchainSelection(toolchainId) {
  if (toolchainId === undefined || toolchainId === null || toolchainId === '') {
    return { toolchainId: null };
  }
  if (typeof toolchainId !== 'string') return { error: 'toolchainId must be a string' };
  const found = listToolchains().find((t) => t.id === toolchainId.trim());
  if (!found) {
    return { error: `Toolchain '${toolchainId}' is not registered. A System Admin must add it first.` };
  }
  return { toolchainId: found.id };
}

app.get('/api/environments', (req, res) => {
  const scope = getScope(req);
  // #2083: tier-aware. Was `visibleTeam(scope, e.teamId)`, which reaches a
  // team-tier record only — a shared environment carries no `teamId` at all, so
  // the old filter hid every one of them from everybody but an admin.
  const envs = listEnvironmentIds().map(loadEnvironment).filter(Boolean)
    // #2158: a GLOBAL environment is visible to everyone regardless of team
    // assignment — `isGlobalEnvironment` re-reads its own preconditions, so
    // this can never widen past what the record currently qualifies for.
    .filter(e => visibleEnvironment(scope, e) || isGlobalEnvironment(e))
    .map(e => {
      const agents = agentsUsingEnvironment(e.id, scope); // (#439)
      return { ...e, agents, agentCount: agents.length, canManage: canManageEnvironment(scope, e) };
    });
  res.json(envs);
});

app.get('/api/environments/:id', (req, res) => {
  const env = loadEnvironment(req.params.id);
  if (!env) return res.status(404).json({ error: 'Environment not found' });
  const scope = getScope(req);
  // #2083: this read was ungated (concept §11.4) — any authenticated caller
  // could fetch any environment by id and read its repositories, its
  // `githubTokenId` and its MCP references. A tier the read-one path ignores is
  // decorative, so the gate lands with the tier. 404 rather than 403, matching
  // `GET /api/llm-endpoints/:id`, so the route is not an existence oracle.
  if (!visibleEnvironment(scope, env) && !isGlobalEnvironment(env)) {
    return res.status(404).json({ error: 'Environment not found' });
  }
  const agents = agentsUsingEnvironment(env.id, scope); // (#439)
  res.json({ ...env, agents, agentCount: agents.length, canManage: canManageEnvironment(scope, env) });
});

// Resolve and validate { llmEndpointId, defaultModelId } against the registry.
// Returns { error } on failure, { llmEndpointId, defaultModelId } on success.
//
// When the caller binds an endpoint but doesn't explicitly pick a model,
// inherit the endpoint's registry-level default. That makes "set the default
// once in the Model Registry → every new env starts on it" the default flow,
// without forcing every form to know about the endpoint catalogue.
function resolveLlmBinding(llmEndpointId, defaultModelId) {
  if (!llmEndpointId) {
    if (defaultModelId) return { error: 'defaultModelId requires llmEndpointId' };
    return { llmEndpointId: null, defaultModelId: null };
  }
  const ep = listLlmEndpoints().find(e => e.id === llmEndpointId);
  if (!ep) return { error: `LLM endpoint '${llmEndpointId}' not found` };
  if (defaultModelId) {
    const known = (ep.models || []).some(m => m.id === defaultModelId);
    if (!known) return { error: `Model '${defaultModelId}' is not in endpoint '${ep.id}' catalog` };
    return { llmEndpointId: ep.id, defaultModelId };
  }
  return { llmEndpointId: ep.id, defaultModelId: pickEndpointDefaultModel(ep) };
}

// #2158 AC9: publishing a global environment whose bound model provider is
// NEITHER global nor system-scoped is refused — reusing `isGlobalProvider`
// rather than a second "is this provider shareable" rule, because a reachable
// environment whose agents cannot obtain a model is worse than no environment
// (a global env promises "every team, including teams created later" reaches
// it — a team-scoped provider breaks that promise on the first message). The
// refusal names the provider. Only called on a PUBLISH TRANSITION (global
// turning true this request), never on an ordinary save of an already-broken
// record, so a broken one stays repairable. No provider bound at all is legal
// (an env can be repo-less and provider-less both) and refuses nothing here.
function refuseGlobalEnvironmentUnusableProvider(llmEndpointId) {
  if (!llmEndpointId) return null;
  const ep = listLlmEndpoints().find(e => e.id === llmEndpointId);
  if (!ep || isGlobalProvider(ep)) return null;
  return `Cannot publish this environment as global: its model provider '${ep.name || ep.id}' is not itself global or system-scoped`;
}

app.post('/api/environments', heavyLimiter, (req, res) => {
  // `skills` is accepted-and-discarded: the skill grant is team-owned
  // (orchestrator/skill-grants.js) and lives on the agent constructs — the
  // Working Environment is a pure infrastructure template. Old clients may
  // still send the field; it is ignored so it can't silently grant anything.
  const { name, description, repositories, repository, additionalContext, githubTokenId, llmEndpointId, defaultModelId, mcpServers, teamId, toolchainId } = req.body || {};
  const id = normalizeEnvId(req.body?.id);
  if (!id) return res.status(400).json({ error: 'id is required (a-z, 0-9, -)' });
  if (!name) return res.status(400).json({ error: 'name is required' });
  if (loadEnvironment(id)) return res.status(409).json({ error: `Environment '${id}' already exists` });

  // #2083: ownership is now the three-tier triple, resolved and validated by the
  // SAME function the four credential kinds use — one validator for every
  // tiered resource, so "which teams exist" cannot be answered two ways.
  // `actingUserId` is deliberately NOT passed: see the note on
  // `resolveTieredOwnership`, which is why a `personal` request is refused here.
  let ownership;
  try { ownership = resolveTieredOwnership(req.body); }
  catch (err) { return res.status(err.status || 400).json({ error: err.message }); }

  // #2158: the global flag (AC1/AC3/AC4) — System-Admin-only to set, exactly
  // like the `global` model-provider flag (#2136). `currentGlobal` is always
  // `false` on create. A global environment carries no team assignment at
  // all, so publishing one overrides the resolved ownership to
  // system-with-no-teams BEFORE the create gate below, mirroring
  // `POST /api/llm-endpoints` — so the two can never disagree about whether
  // this is a shared-tier create.
  const createScope = getScope(req);
  const globalFlag = resolveEnvGlobalFlag({
    wantGlobal: req.body?.global,
    currentGlobal: false,
    scopeAll: createScope.all,
  });
  if (globalFlag.error) {
    return res.status(globalFlag.status).json({ error: globalFlag.error, code: globalFlag.code });
  }
  if (globalFlag.global) ownership = { scope: 'system', teamId: null, assignedTeamIds: [] };

  // Config-write authorization (#989, tiered by #2083): creating a team-tier
  // environment requires team-admin rights over its owning team; creating a
  // SHARED one is System-Admin-only (§5.2 — declaring a resource cross-tenant
  // is an operator act).
  if (!canCreateEnvironment(createScope, ownership)) {
    return res.status(403).json({ error: 'forbidden', code: 'forbidden' });
  }

  let normalizedRepos;
  try {
    normalizedRepos = normalizeRepositoriesInput(repositories, repository);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  // Validate githubTokenId if set
  if (githubTokenId) {
    const tokens = listGithubTokens();
    if (!tokens.some(t => t.id === githubTokenId)) {
      return res.status(400).json({ error: `GitHub token '${githubTokenId}' not found` });
    }
  }

  let normalizedMcp;
  try {
    normalizedMcp = normalizeMcpServersInput(mcpServers);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const llm = resolveLlmBinding(llmEndpointId, defaultModelId);
  if (llm.error) return res.status(400).json({ error: llm.error });

  // Agent toolchain (#1940): an ID from the operator registry, resolved to an
  // image server-side at spawn time. Never an image string from the client.
  const toolchain = resolveToolchainSelection(toolchainId);
  if (toolchain.error) return res.status(400).json({ error: toolchain.error });

  // #2158 AC9: publishing (this create IS the publish transition, since a
  // fresh record starts non-global) refuses a bound provider that is neither
  // global nor system-scoped — a reachable environment whose agents cannot
  // obtain a model is worse than no environment.
  if (globalFlag.global) {
    const providerRefusal = refuseGlobalEnvironmentUnusableProvider(llm.llmEndpointId);
    if (providerRefusal) return res.status(400).json({ error: providerRefusal, code: 'global-provider-unusable' });
  }

  const env = {
    id,
    name,
    description: description || '',
    // #2083: the tier triple, written explicitly from the resolved ownership
    // (never spread from the request body) so a client cannot smuggle a field
    // into the shape the predicates read. A team-tier create is byte-identical
    // to a pre-#2083 one apart from the now-explicit `scope`/`assignedTeamIds`.
    ...tierOwnershipFields(ownership),
    repositories: normalizedRepos,
    githubTokenId: githubTokenId || null,
    mcpServers: normalizedMcp,
    llmEndpointId: llm.llmEndpointId,
    defaultModelId: llm.defaultModelId,
    additionalContext: additionalContext || '',
    createdAt: new Date().toISOString(),
  };
  // Written only when a toolchain was actually selected, so an environment
  // without one is byte-identical to a pre-#1940 environment on disk (AC1) —
  // the same discipline as contextMountRw (#1289).
  if (toolchain.toolchainId) env.toolchainId = toolchain.toolchainId;
  // #2158 AC6: written only when true — no dangling `global: false` on disk.
  if (globalFlag.global) env.global = true;
  saveEnvironment(id, env);
  res.status(201).json(env);
});

app.put('/api/environments/:id', apiLimiter, (req, res) => {
  const env = loadEnvironment(req.params.id);
  if (!env) return res.status(404).json({ error: 'Environment not found' });
  // Config-write authorization (#989): editing an environment requires team-admin
  // management rights over its owning team; re-parenting also over the target.
  const envScope = getScope(req);
  if (!canManageEnvironment(envScope, env)) {
    return res.status(403).json({ error: 'forbidden', code: 'forbidden' });
  }
  const prevGithubTokenId = env.githubTokenId || null;
  const prevLlmEndpointId = env.llmEndpointId || null;
  const prevDefaultModelId = env.defaultModelId || null;
  const prevToolchainId = env.toolchainId || null;
  // The repository list as PERSISTED, captured before the write and echoed on
  // the response (#2066). The save-time offer's diff is computed from this and
  // the saved list, both server-supplied — which is what makes it impossible
  // for the offer to act on a list the browser has been holding since before
  // another admin saved the same environment.
  const prevRepositories = Array.isArray(env.repositories)
    ? env.repositories.map((r) => ({ ...r }))
    : [];
  // `skills` from old clients is accepted-and-discarded — the grant is
  // team-owned (see POST above); a legacy env.skills field on disk is left
  // untouched (dead after the orchestrator's startup migration).
  const { name, description, repositories, repository, additionalContext, githubTokenId, llmEndpointId, defaultModelId, mcpServers, teamId, toolchainId } = req.body || {};

  if (githubTokenId) {
    const tokens = listGithubTokens();
    if (!tokens.some(t => t.id === githubTokenId)) {
      return res.status(400).json({ error: `GitHub token '${githubTokenId}' not found` });
    }
  }

  // #2158: publish/retract the global flag (AC1/AC3/AC6/AC9) — resolved
  // BEFORE the re-tier block below, because a global record carries no team
  // assignment at all, and forcing that shape has to WIN over any
  // teamId/scope/assignedTeamIds the same body also sent (mirrors
  // `PUT /api/llm-endpoints`, where a global toggle overrides the resolved
  // ownership the same way). Only a System Admin may flip the flag itself
  // (`resolveEnvGlobalFlag`'s own gate — independent of `canManageEnvironment`
  // above, since a shared record's assigned admins may edit its content but
  // not decide its reach). Omitting `global` from the body keeps the current
  // value (the #2136 "an ordinary save must not drop it" rule).
  const globalFlag = resolveEnvGlobalFlag({
    wantGlobal: req.body?.global,
    currentGlobal: env.global === true,
    scopeAll: envScope.all,
  });
  if (globalFlag.error) {
    return res.status(globalFlag.status).json({ error: globalFlag.error, code: globalFlag.code });
  }

  // #2083: ownership is now a tier, so an update may re-TIER the record. The
  // gate splits along the line §5.2 draws, and the split is the whole reason a
  // shared environment is usable at all:
  //
  //   • deciding WHICH teams reach it (a tier change, a cross-team move, a
  //     change of assignments) is System-Admin-only — `canRetierEnvironment`;
  //   • editing its CONTENT is self-service for every team-admin the record
  //     already reaches, which the `canManageEnvironment` gate above allows.
  //
  // `isRetier` is what decides which of the two a given body asks for, so a
  // client that echoes the record's own unchanged ownership back (which the
  // console's form does on every save) is not treated as an operator act. The
  // last literal `|| 'default'` on the environment path goes with it (§8.4).
  //
  // #2158: when publishing (or re-asserting) global, the tier is FORCED to
  // system-with-no-teams regardless of what the body's own tier fields say —
  // a global record is always system-scoped with an empty `assignedTeamIds`,
  // and letting the two disagree is exactly the "hand-edited, stale record"
  // shape `isGlobalEnvironment` refuses to trust.
  if (globalFlag.global) {
    const nextOwnership = { scope: 'system', teamId: null, assignedTeamIds: [] };
    if (isRetier(env, nextOwnership) && !canRetierEnvironment(envScope)) {
      return res.status(403).json({ error: 'Only a System Admin may change which teams an environment belongs to', code: 'forbidden' });
    }
    Object.assign(env, tierOwnershipFields(nextOwnership));
  } else if (teamId !== undefined || req.body?.scope !== undefined || req.body?.assignedTeamIds !== undefined) {
    let nextOwnership;
    try { nextOwnership = resolveTieredOwnership(req.body); }
    catch (err) { return res.status(err.status || 400).json({ error: err.message }); }
    if (isRetier(env, nextOwnership) && !canRetierEnvironment(envScope)) {
      return res.status(403).json({ error: 'Only a System Admin may change which teams an environment belongs to', code: 'forbidden' });
    }
    // Written even when it is NOT a re-tier, so a legacy record acquires its
    // explicit `scope` on the next ordinary save rather than staying implicit
    // forever.
    Object.assign(env, tierOwnershipFields(nextOwnership));
  }

  // Only re-validate the LLM binding if either field was explicitly sent.
  if (llmEndpointId !== undefined || defaultModelId !== undefined) {
    const nextEndpoint = llmEndpointId !== undefined ? llmEndpointId : env.llmEndpointId;
    const nextModel    = defaultModelId !== undefined ? defaultModelId : env.defaultModelId;
    const llm = resolveLlmBinding(nextEndpoint, nextModel);
    if (llm.error) return res.status(400).json({ error: llm.error });
    env.llmEndpointId  = llm.llmEndpointId;
    env.defaultModelId = llm.defaultModelId;
  }

  if (globalFlag.global && env.global !== true) {
    // A PUBLISH TRANSITION (was not global, now is) — refuse an unusable
    // provider binding (AC9), reading the FINAL llmEndpointId (any change in
    // this same request already applied above). An ordinary save of an
    // already-global, already-broken record is not blocked here, so it stays
    // repairable.
    const providerRefusal = refuseGlobalEnvironmentUnusableProvider(env.llmEndpointId);
    if (providerRefusal) return res.status(400).json({ error: providerRefusal, code: 'global-provider-unusable' });
  }
  // #2158 AC6: cleared explicitly rather than left as a dangling `false`.
  if (globalFlag.global) env.global = true;
  else delete env.global;

  if (name !== undefined) env.name = name;
  if (description !== undefined) env.description = description;
  if (repositories !== undefined || repository !== undefined) {
    try {
      env.repositories = normalizeRepositoriesInput(repositories, repository);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    delete env.repository;
  }
  if (githubTokenId !== undefined) env.githubTokenId = githubTokenId || null;
  if (mcpServers !== undefined) {
    try {
      env.mcpServers = normalizeMcpServersInput(mcpServers);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  }
  if (additionalContext !== undefined) env.additionalContext = additionalContext;
  if (toolchainId !== undefined) {
    const toolchain = resolveToolchainSelection(toolchainId);
    if (toolchain.error) return res.status(400).json({ error: toolchain.error });
    // Clearing it DELETES the key rather than storing null, so an environment
    // that never had a toolchain — or had one and gave it up — is byte-identical
    // to a pre-#1940 environment on disk (AC1).
    if (toolchain.toolchainId) env.toolchainId = toolchain.toolchainId;
    else delete env.toolchainId;
  }
  env.updatedAt = new Date().toISOString();
  saveEnvironment(env.id, env);
  // Spawn-time bindings (GitHub PAT, LLM provider/model, the container image) are
  // baked into each agent container at start, so a change only takes effect on
  // respawn. Respawn the env's running agents whenever any of them changed —
  // otherwise a provider switch at the environment level would silently not apply
  // until a manual disable→enable. (A per-agent override is handled by
  // PATCH /agents/:id/provider.)
  //
  // The toolchain (#1940 AC5) rides this exact path, and it must: a container's
  // image is immutable for its whole lifetime, so a toolchain change reaches a
  // RUNNING agent only by recreating it. The console warns about the interruption
  // before the save, as the personal-credential rotate panel does.
  if ((env.githubTokenId || null) !== prevGithubTokenId) {
    notifyEnvCredentialChange(env.id, 'githubTokenId-changed');
  } else if ((env.toolchainId || null) !== prevToolchainId) {
    notifyEnvCredentialChange(env.id, 'toolchain-changed');
  } else if ((env.llmEndpointId || null) !== prevLlmEndpointId
          || (env.defaultModelId || null) !== prevDefaultModelId) {
    notifyEnvCredentialChange(env.id, 'llm-endpoint-changed');
  }
  // AC7: the save is already committed at this point. Whatever the caller does
  // with `previousRepositories` — offer, decline, crash — the environment stays
  // persisted exactly as submitted; no path here rolls it back.
  res.json({ ...env, previousRepositories: prevRepositories });
});

app.delete('/api/environments/:id', apiLimiter, (req, res) => {
  const env = loadEnvironment(req.params.id);
  if (!env) return res.status(404).json({ error: 'Environment not found' });
  // Config-write authorization (#989): deleting an environment requires team-admin
  // management rights over its owning team.
  if (!canManageEnvironment(getScope(req), env)) {
    return res.status(403).json({ error: 'forbidden', code: 'forbidden' });
  }
  const usedBy = environmentInUse(env.id);
  if (usedBy) {
    return res.status(409).json({ error: `Environment is used by agent '${usedBy}'. Delete the agent first.` });
  }
  fs.rmSync(path.join(ENVIRONMENTS_DIR, env.id), { recursive: true, force: true });
  res.status(204).end();
});

// Probe a repo URL (optionally with one of our SSH keys) to verify the agent
// will actually be able to clone it. Delegates to the orchestrator since only
// that container has git/openssh and the SSH key files mounted.
app.post('/api/repositories/check', heavyLimiter, async (req, res) => {
  const { url, sshKeyId, githubTokenId } = req.body || {};
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ ok: false, error: 'url is required' });
  }
  if (sshKeyId) {
    if (!SSH_KEY_ID_RE.test(sshKeyId)) {
      return res.status(400).json({ ok: false, error: 'Invalid SSH key id' });
    }
    const keys = listSshKeys();
    if (!keys.some(k => k.id === sshKeyId)) {
      return res.status(400).json({ ok: false, error: `SSH key '${sshKeyId}' not found` });
    }
  }
  if (githubTokenId) {
    if (!GH_TOKEN_ID_RE.test(githubTokenId)) {
      return res.status(400).json({ ok: false, error: 'Invalid GitHub token id' });
    }
    const tokens = listGithubTokens();
    if (!tokens.some(t => t.id === githubTokenId)) {
      return res.status(400).json({ ok: false, error: `GitHub token '${githubTokenId}' not found` });
    }
  }
  const orchestratorUrl = process.env.ORCHESTRATOR_URL || 'http://orchestrator:4002';
  try {
    const resp = await fetch(`${orchestratorUrl}/internal/repository-check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, sshKeyId: sshKeyId || null, githubTokenId: githubTokenId || null }),
    });
    const data = await resp.json();
    res.status(resp.status).json(data);
  } catch (err) {
    res.status(502).json({ ok: false, error: `Probe failed: ${err.message}` });
  }
});

/* ─── Quick-Start Wizard ────────────────────────────────────────────── */

// parseGitHubUrl / deriveRepoIdentity are extracted to ./repo-identity (required
// at the top of this file) so the URL parsing is unit-testable in isolation.

// Reduce any GitHub URL form to a canonical "<org>/<repo>" string for
// equality checks across SSH/HTTPS variants. Returns null for unparseable
// input so callers can fall back to literal comparison.
function githubRepoKey(url) {
  try {
    const { org, repo } = parseGitHubUrl(url);
    return `${org.toLowerCase()}/${repo.toLowerCase()}`;
  } catch {
    return null;
  }
}

function slugifyRepoSegment(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function findEnvByRepoUrl(targetUrl) {
  const targetKey = githubRepoKey(targetUrl);
  for (const envId of listEnvironmentIds()) {
    const env = loadEnvironment(envId);
    const repos = Array.isArray(env?.repositories) ? env.repositories : [];
    const match = repos.some(r => {
      const u = typeof r?.url === 'string' ? r.url.trim() : '';
      if (!u) return false;
      if (u === targetUrl) return true;
      const k = githubRepoKey(u);
      return targetKey && k && k === targetKey;
    });
    if (match) return env;
  }
  return null;
}

function findStandaloneAgentForEnv(envId) {
  const matches = [];
  for (const id of listAgentDirs()) {
    const cfg = readJsonFile(path.join(AGENTS_DIR, id, 'config.json'), null);
    if (!cfg || cfg.environmentId !== envId) continue;
    // Accept legacy 'expert' configs that haven't been migrated yet.
    if (cfg.role !== 'agent' && cfg.role !== 'expert') continue;
    matches.push(cfg);
  }
  matches.sort((a, b) => a.id.localeCompare(b.id));
  return matches[0] || null;
}

function quickstartSystemPrompt(org, repo) {
  return [
    `You are an assistant for the GitHub repository **${org}/${repo}**.`,
    ``,
    `The repository is cloned into your workspace at \`./${repo}/\`. Use Read, Grep, Glob, and the Bash tool (git, build tools) to explore and modify the code.`,
    ``,
    `When the user asks a question, ground your answer in the actual repo state, not guesses. When making changes, follow the project's existing conventions and commit with a clear message.`,
  ].join('\n');
}

// One-shot: from a GitHub URL, ensure a Working Environment exists for the
// repo, and return (or create) a default agent bound to it. Reuses
// existing artefacts when possible so repeat clicks are safe.
app.post('/api/quickstart', heavyLimiter, async (req, res) => {
  const { url, githubTokenId, sshKeyId } = req.body || {};

  let parsed;
  try {
    parsed = parseGitHubUrl(url);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  const { org, repo, sshUrl } = parsed;

  const tokens = listGithubTokens();
  if (tokens.length === 0) {
    return res.status(400).json({
      error: 'No GitHub token configured. Add one under "GitHub Tokens" first.',
      code: 'no_token',
    });
  }
  let chosenTokenId;
  if (githubTokenId) {
    if (!tokens.some(t => t.id === githubTokenId)) {
      return res.status(400).json({ error: `GitHub token '${githubTokenId}' not found` });
    }
    chosenTokenId = githubTokenId;
  } else {
    chosenTokenId = tokens[0].id;
  }

  // SSH key is required because we clone via SSH (git@github.com:...). The
  // GitHub PAT above stays the credential for API actions (gh-as-agent,
  // event polling); the two are deliberately split — see CLAUDE.md.
  const sshKeys = listSshKeys();
  if (sshKeys.length === 0) {
    return res.status(400).json({
      error: 'No SSH key configured. Add one under "SSH Keys" first.',
      code: 'no_ssh_key',
    });
  }
  let chosenSshKeyId;
  if (sshKeyId) {
    if (!sshKeys.some(k => k.id === sshKeyId)) {
      return res.status(400).json({ error: `SSH key '${sshKeyId}' not found` });
    }
    chosenSshKeyId = sshKeyId;
  } else {
    chosenSshKeyId = sshKeys[0].id;
  }

  // 1. Probe the remote: validates SSH auth + reachability, and resolves the
  // default branch so we don't assume "main" (a previous version did, which
  // silently failed on repos defaulting to master/release/etc.).
  // null means "let git use whatever HEAD the remote advertises at clone time".
  const orchestratorUrl = process.env.ORCHESTRATOR_URL || 'http://orchestrator:4002';
  let resolvedBranch = null;
  try {
    const probeResp = await fetch(`${orchestratorUrl}/internal/repository-check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: sshUrl, sshKeyId: chosenSshKeyId }),
    });
    const probe = await probeResp.json().catch(() => ({}));
    if (!probe.ok) {
      return res.status(400).json({
        error: probe.error
          ? `Cannot reach repository over SSH: ${probe.error}`
          : 'Cannot reach repository over SSH (check the SSH key has access).',
        code: 'repo_unreachable',
      });
    }
    if (probe.branch) resolvedBranch = probe.branch;
  } catch (err) {
    return res.status(502).json({ error: `Repository probe failed: ${err.message}` });
  }

  // 2. Reuse env if any references this repo URL, else create a new one.
  let env = findEnvByRepoUrl(sshUrl);
  let envReused = !!env;
  let tokenAttachRefused = false;

  if (!env) {
    const baseEnvId = `repo-${slugifyRepoSegment(org)}-${slugifyRepoSegment(repo)}` || 'repo';
    let envId = baseEnvId;
    let suffix = 2;
    while (loadEnvironment(envId)) {
      envId = `${baseEnvId}-${suffix++}`;
    }
    const llmBinding = pickDefaultLlmBinding();
    env = {
      id: envId,
      name: `${org}/${repo}`,
      description: `Quick-start environment for ${org}/${repo}`,
      repositories: [{ url: sshUrl, branch: resolvedBranch, sshKeyId: chosenSshKeyId }],
      githubTokenId: chosenTokenId,
      ...llmBinding,
      additionalContext: '',
      createdAt: new Date().toISOString(),
    };
    saveEnvironment(envId, env);
  } else if (!env.githubTokenId) {
    // Existing env without a token — attach the chosen one so the clone works,
    // but ONLY when the caller may actually manage this environment (#2158
    // AC11). Environments are now discoverable by every user via the global
    // tier, so writing env.githubTokenId unconditionally here let any
    // authenticated caller attach a credential to a system-tier record they
    // cannot otherwise touch, just by POSTing a repo URL that happens to
    // match a reused env. The wider ungated-reuse leak (returning another
    // team's agent, the missing-scope-stamp write on a freshly created env)
    // is deliberately left to #2071 — this only closes the mutation.
    if (canManageEnvironment(getScope(req), env)) {
      env.githubTokenId = chosenTokenId;
      env.updatedAt = new Date().toISOString();
      saveEnvironment(env.id, env);
    } else {
      tokenAttachRefused = true;
    }
  }

  const tokenWarning = tokenAttachRefused
    ? 'This working environment has no GitHub token and you do not have permission to attach one. An administrator can add it under "Working Environments".'
    : null;

  const llmWarning = env.llmEndpointId
    ? null
    : 'No LLM endpoint is registered. Register one under "LLM Endpoints" and bind it to the Working Environment before chatting — otherwise the agent will fail on its first message.';

  // 2. Reuse an existing standalone agent on this env, else create one.
  const existingAgent = findStandaloneAgentForEnv(env.id);
  if (existingAgent) {
    return res.status(200).json({
      reused: true,
      environment: { id: env.id, name: env.name, reused: envReused },
      agent: { id: existingAgent.id, displayName: existingAgent.displayName },
      ...(llmWarning ? { llmWarning } : {}),
      ...(tokenWarning ? { tokenWarning } : {}),
    });
  }

  const baseAgentId = `${slugifyRepoSegment(repo)}-agent` || 'repo-agent';
  let agentId = baseAgentId;
  let agentSuffix = 2;
  while (fs.existsSync(path.join(AGENTS_DIR, agentId))) {
    agentId = `${baseAgentId}-${agentSuffix++}`;
  }
  const displayName = `${repo} Agent`;
  const systemPrompt = quickstartSystemPrompt(org, repo);

  let agentResp;
  try {
    const resp = await fetch(`${orchestratorUrl}/internal/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: agentId,
        displayName,
        role: 'agent',
        systemPrompt,
        environmentId: env.id,
        // Human owner (#2077, D8) — the authenticated creator.
        ...ownerFor(req),
      }),
    });
    agentResp = await resp.json();
    if (!resp.ok) return res.status(resp.status).json(agentResp);
  } catch (err) {
    return res.status(502).json({ error: `Orchestrator unreachable: ${err.message}` });
  }

  res.status(201).json({
    reused: false,
    environment: { id: env.id, name: env.name, reused: envReused },
    agent: { id: agentId, displayName },
    seed: agentResp,
    ...(llmWarning ? { llmWarning } : {}),
    ...(tokenWarning ? { tokenWarning } : {}),
  });
});

// One-shot: create a repo-less Working Environment bound to a chosen Model
// Provider plus one standalone chat agent — no GitHub URL, SSH key, or token
// (#1624). The credential-free sibling of POST /api/quickstart; it deliberately
// leaves that repo-first flow untouched. Pure validation + id derivation live in
// quickstart-llm.js; this handler resolves the live registry and writes the
// env / agent.
app.post('/api/quickstart/llm', heavyLimiter, async (req, res) => {
  const { displayName, llmEndpointId } = req.body || {};

  // Resolve the provider against the live registry, then validate purely. An
  // empty llmEndpointId yields { llmEndpointId: null } (no error), which the
  // validator rejects as "select a provider".
  const binding = resolveLlmBinding(llmEndpointId, undefined);
  const validated = validateQuickstartLlmInput({
    displayName,
    binding,
    endpointCount: listLlmEndpoints().length,
  });
  if (validated.error) {
    return res.status(400).json({ error: validated.error, ...(validated.code ? { code: validated.code } : {}) });
  }
  const { name } = validated;

  // One repo-less environment per agent (isolation, matching the repo-first flow).
  const envId = llmEnvId(name, id => !!loadEnvironment(id));
  const env = {
    id: envId,
    name,
    description: `LLM-only environment for ${name}`,
    repositories: [],
    githubTokenId: null,
    llmEndpointId: validated.llmEndpointId,
    defaultModelId: validated.defaultModelId,
    additionalContext: '',
    createdAt: new Date().toISOString(),
  };
  saveEnvironment(envId, env);

  const agentId = llmAgentId(name, id => fs.existsSync(path.join(AGENTS_DIR, id)));
  const systemPrompt = quickstartLlmSystemPrompt(name);
  const orchestratorUrl = process.env.ORCHESTRATOR_URL || 'http://orchestrator:4002';

  let agentResp;
  try {
    const resp = await fetch(`${orchestratorUrl}/internal/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: agentId,
        displayName: name,
        role: 'agent',
        systemPrompt,
        environmentId: envId,
        // Human owner (#2077, D8) — the authenticated creator.
        ...ownerFor(req),
      }),
    });
    agentResp = await resp.json();
    if (!resp.ok) return res.status(resp.status).json(agentResp);
  } catch (err) {
    return res.status(502).json({ error: `Orchestrator unreachable: ${err.message}` });
  }

  res.status(201).json({
    reused: false,
    mode: 'llm',
    environment: { id: envId, name: env.name, reused: false },
    agent: { id: agentId, displayName: name },
    seed: agentResp,
  });
});

/* ─── Team-Setup wizard ────────────────────────────────────────────────
 *
 * One-shot endpoint that materialises an entire team of role-specialised
 * agents from a small wizard payload. Reads role templates from the pool
 * (/pool/agent-templates/*.json), then in-order:
 *
 *   1. Validates input + checks credentials exist.
 *   2. Computes per-role envId/agentId from the team slug.
 *   3. Pre-flight collision check. mode="create" (default) refuses any
 *      pre-existing resource; mode="extend" skips them and adds the rest.
 *   4. Creates N envs (one per role) — saveEnvironment writes to disk.
 *   5. For each role, POSTs to orchestrator /internal/agents (extended
 *      protocol — accepts `team`, `sessionPolicy`, `triggers`).
 *   6. Pre-creates DM rooms with the admin user so trigger-driven runs
 *      have a destination from minute one.
 *   7. On any failure: rollback created envs + agents in reverse order.
 *
 * The orchestrator-side createAgent already handles the heavy lifting:
 * Matrix user provisioning, repo clone, workspace seeding, runner spawn.
 * This endpoint just orchestrates the *team-shaped* sequence around it.
 */

const TEAM_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

// Two-tier role-template store (#587): repo-seeded defaults in the pool volume
// (AGENT_TEMPLATES_DIR) overlaid by a durable user store (USER_AGENT_TEMPLATES_DIR).
// Both loaders are overlay-aware, so every consumer — the summary endpoint, the
// Flow Editor picker, the Team-Setup wizard, and team materialisation — picks up
// UI edits/creates without a redeploy or re-seed (AC-7).
function listTemplateIdsIn(dir) {
  try {
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.json') && /^[a-z0-9][a-z0-9-]*\.json$/.test(f))
      .map(f => f.slice(0, -5));
  } catch {
    return [];
  }
}

function readTemplateFile(dir, id) {
  const p = agentTemplateStore.safeTemplateFile(dir, id);
  if (!p) return null;
  try {
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (err) {
    console.error(`[Templates] Cannot load template ${id} from ${dir}: ${err.message}`);
    return null;
  }
}

// Effective id list = union of both tiers, sorted.
function listAgentTemplateIds() {
  return [...new Set([
    ...listTemplateIdsIn(AGENT_TEMPLATES_DIR),
    ...listTemplateIdsIn(USER_AGENT_TEMPLATES_DIR),
  ])].sort();
}

// Effective template: the user overlay wins over the seeded default.
function loadAgentTemplate(id) {
  if (!agentTemplateStore.TEMPLATE_ID_RE.test(id || '')) return null;
  return readTemplateFile(USER_AGENT_TEMPLATES_DIR, id)
    || readTemplateFile(AGENT_TEMPLATES_DIR, id);
}

// Read-only template summary for the wizard's role-cards step. Strips the
// long prompt text to keep the response small — wizard doesn't need it,
// the backend reads the canonical version at create time.
app.get('/api/agent-templates', (_req, res) => {
  const out = [];
  for (const id of listAgentTemplateIds()) {
    const t = loadAgentTemplate(id);
    if (!t) continue;
    const origin = agentTemplateStore.templateOrigin(
      !!readTemplateFile(AGENT_TEMPLATES_DIR, id),
      !!readTemplateFile(USER_AGENT_TEMPLATES_DIR, id),
    );
    out.push({
      id: t.id,
      displayName: t.displayName,
      description: t.description,
      icon: t.icon,
      category: t.category,
      sessionPolicy: t.sessionPolicy,
      // Which tier this effective template comes from (#587): 'default'
      // (seeded, read-only), 'user' (UI-created) or 'override' (UI edit of a
      // seeded default — can be reset to default).
      origin,
      defaultEnabled: t.defaultEnabled !== false,
      // Catalog v2 (#420): the normalised composition surface (patternRole /
      // stageAffinity / ports) consumed by the wiring-suggestion feature
      // (port-suggestion.js) and the Flow Editor.
      ...normalizeTemplatePorts(t),
      triggerSummary: (t.triggers || []).map(tr => ({
        id: tr.id,
        type: tr.type,
        events: tr.events || null,
        cron: tr.cron || null,
        description: tr.description || null,
        intrinsic: tr.intrinsic === true,
        preCheckScript: tr.preCheckScript || null,
        preCheckEnvKeys: tr.preCheckEnv && typeof tr.preCheckEnv === 'object'
          ? Object.keys(tr.preCheckEnv)
          : [],
      })),
    });
  }
  res.json({ templates: out });
});

// ─── Role-template CRUD (#587) ──────────────────────────────────────────────
// UI-based management of role templates, mirroring the skills-registry CRUD:
// server-side validation, slug/id guard, traversal-safe writes. All writes land
// in the user store (USER_AGENT_TEMPLATES_DIR); the seeded defaults stay
// read-only. Reads above overlay user over default, so a subsequent GET (and
// the picker / wizard) reflect the change without a re-seed.

// View a single template's full, editable definition + which tier it is.
// The response carries the raw promptTemplate + triggers (for the Flow Editor's
// "add role from a template" flow, #586 — the picker pre-fills a draft role and
// keeps `{{vars}}` raw) plus the normalised composition surface
// (`normalizeTemplatePorts`: patternRole / stageAffinity / ports) and `origin`
// (the #587 tier: default / user / override).
app.get('/api/agent-templates/:id', (req, res) => {
  const { id } = req.params;
  if (!agentTemplateStore.TEMPLATE_ID_RE.test(id)) {
    return res.status(400).json({ error: 'Invalid template id' });
  }
  const template = loadAgentTemplate(id);
  if (!template) return res.status(404).json({ error: 'Template not found' });
  const origin = agentTemplateStore.templateOrigin(
    !!readTemplateFile(AGENT_TEMPLATES_DIR, id),
    !!readTemplateFile(USER_AGENT_TEMPLATES_DIR, id),
  );
  res.json({ template: { ...template, ...normalizeTemplatePorts(template) }, origin });
});

// Create a new template. Requires a unique, slug-valid id and the minimum
// fields (id, displayName, prompt/promptTemplate); nothing is persisted on
// invalid input.
app.post('/api/agent-templates', (req, res) => {
  const { valid, errors, value } = agentTemplateStore.validateTemplate(req.body || {}, { requireId: true });
  if (!valid) return res.status(400).json({ error: errors[0], errors });
  const { id } = value;
  if (readTemplateFile(AGENT_TEMPLATES_DIR, id) || readTemplateFile(USER_AGENT_TEMPLATES_DIR, id)) {
    return res.status(409).json({ error: `A template with id '${id}' already exists` });
  }
  const file = agentTemplateStore.safeTemplateFile(USER_AGENT_TEMPLATES_DIR, id);
  if (!file) return res.status(400).json({ error: 'Invalid template id' });
  try {
    fs.mkdirSync(USER_AGENT_TEMPLATES_DIR, { recursive: true });
    writeJsonAtomic(file, value);
  } catch (err) {
    return res.status(500).json({ error: `Failed to save template: ${err.message}` });
  }
  res.status(201).json({ id, origin: 'user' });
});

// Edit an existing template. Persists to the user store — editing a seeded
// default creates an override that shadows it. Last-write-wins (E4).
app.put('/api/agent-templates/:id', (req, res) => {
  const { id } = req.params;
  if (!agentTemplateStore.TEMPLATE_ID_RE.test(id)) {
    return res.status(400).json({ error: 'Invalid template id' });
  }
  const { valid, errors, value } = agentTemplateStore.validateTemplate(req.body || {}, { expectId: id });
  if (!valid) return res.status(400).json({ error: errors[0], errors });
  const hasDefault = !!readTemplateFile(AGENT_TEMPLATES_DIR, id);
  const hasUser = !!readTemplateFile(USER_AGENT_TEMPLATES_DIR, id);
  if (!hasDefault && !hasUser) return res.status(404).json({ error: 'Template not found' });
  const file = agentTemplateStore.safeTemplateFile(USER_AGENT_TEMPLATES_DIR, id);
  if (!file) return res.status(400).json({ error: 'Invalid template id' });
  try {
    fs.mkdirSync(USER_AGENT_TEMPLATES_DIR, { recursive: true });
    writeJsonAtomic(file, { ...value, id });
  } catch (err) {
    return res.status(500).json({ error: `Failed to save template: ${err.message}` });
  }
  res.json({ id, origin: agentTemplateStore.templateOrigin(hasDefault, true) });
});

// Delete a template. For a user-only template this removes it entirely; for an
// override of a seeded default this removes the overlay and reverts to the
// default (reset-to-default, D2). A built-in with no overlay is read-only.
app.delete('/api/agent-templates/:id', (req, res) => {
  const { id } = req.params;
  if (!agentTemplateStore.TEMPLATE_ID_RE.test(id)) {
    return res.status(400).json({ error: 'Invalid template id' });
  }
  const file = agentTemplateStore.safeTemplateFile(USER_AGENT_TEMPLATES_DIR, id);
  if (!file) return res.status(400).json({ error: 'Invalid template id' });
  const hasUser = fs.existsSync(file);
  const hasDefault = !!readTemplateFile(AGENT_TEMPLATES_DIR, id);
  if (!hasUser) {
    if (hasDefault) {
      return res.status(409).json({
        error: `'${id}' is a built-in template and cannot be deleted. Edit it to create an override you can reset to default.`,
      });
    }
    return res.status(404).json({ error: 'Template not found' });
  }
  try {
    fs.rmSync(file, { force: true });
  } catch (err) {
    return res.status(500).json({ error: `Failed to delete template: ${err.message}` });
  }
  res.json({ deleted: id, revertedToDefault: hasDefault });
});

// Generic, role-agnostic team prompt. Each member can override this with
// its role-specific prompt; members that don't override inherit this text
// and pick up edits via /api/agents/:id PUT (systemPromptTemplate).
function defaultTeamPrompt(vars) {
  // A repo-less team (#1623) has no repository to collaborate on and no GitHub
  // hand-off surface, so drop the repo sentence and the gh-as-agent line.
  const lines = [
    vars.repoFullName
      ? `You are a member of the team **${vars.teamName}**, which collaborates on the repository \`${vars.repoFullName}\`.`
      : `You are a member of the team **${vars.teamName}**.`,
    ``,
    `Other team members may have different responsibilities (requirements gathering, implementation, reviews, documentation). Stay in your own role and do not overlap with the others.`,
  ];
  if (vars.repoFullName) {
    lines.push(`When you create PRs, issues or comments on GitHub, use \`gh-as-agent\` so your identity is stamped cleanly.`);
  }
  return lines.join('\n');
}

// GitHub label names accept basically anything except they must be 1–50
// chars, no leading/trailing whitespace, and our prompt embedding wants a
// plain identifier (no quotes / backticks / template syntax).
const READY_LABEL_RE = /^[^\s`"'{}<>][^\s`"'{}<>]{0,49}$/;
// Same shape for the dispatcher's output label — the Dispatcher applies
// this to issues it releases to the Developer team.
const DISPATCH_LABEL_RE = READY_LABEL_RE;
// WIP cap the Dispatcher enforces. Allow 1–50 — beyond that the load on
// the LLM / git side becomes a real concern and we'd want an explicit
// product decision rather than a slider.
const MAX_PARALLEL_MIN = 1;
const MAX_PARALLEL_MAX = 50;

// The wizard doesn't surface an LLM endpoint chooser yet. Without binding
// one on the env, the in-chat model picker shows "(no endpoint)" disabled
// for every team-member — which is how teams looked broken compared to
// hand-created agents (where the user picks an endpoint via the env editor).
// Pick the first registered endpoint as a silent default; its operator-set
// default model (or, as a backstop, the first entry in its catalogue) becomes
// the env-level default. The user can change either later.
function pickDefaultLlmBinding() {
  const endpoints = listLlmEndpoints();
  if (endpoints.length === 0) return { llmEndpointId: null, defaultModelId: null };
  const ep = endpoints[0];
  return {
    llmEndpointId: ep.id,
    defaultModelId: pickEndpointDefaultModel(ep),
  };
}

// Keep old name so existing call sites in Team-Setup still compile.
const defaultLlmEndpointForTeam = pickDefaultLlmBinding;

// Normalize the `roles` payload: accepts string[] (legacy/backward-compat)
// or Array<{id, count}> (new multi-instance shape). Returns an array of
// {id, count} objects with count clamped to [1, 10].
function normalizeRolesInput(raw) {
  if (!Array.isArray(raw)) return null;
  return raw.map(r => {
    if (typeof r === 'string') return { id: r, count: 1 };
    const id = typeof r.id === 'string' ? r.id : null;
    const count = Number.isInteger(r.count) && r.count >= 1 && r.count <= 10 ? r.count : 1;
    return { id, count };
  });
}

// Expand normalized roles into planned member entries. count=1 keeps the
// legacy `<teamId>-<roleId>` id; count>1 produces numbered suffixes.
function planMembers(teamId, normalizedRoles, loadTemplate) {
  const planned = [];
  for (const { id: roleId, count } of normalizedRoles) {
    const t = loadTemplate(roleId);
    if (count === 1) {
      planned.push({ roleId, template: t, memberId: `${teamId}-${roleId}`, instanceIndex: null });
    } else {
      for (let i = 1; i <= count; i++) {
        planned.push({ roleId, template: t, memberId: `${teamId}-${roleId}-${i}`, instanceIndex: i });
      }
    }
  }
  return planned;
}

// Suggest a random label suffix for the team-setup wizard (#902).
app.get('/api/teams/suggest-suffix', (req, res) => {
  res.json({ suffix: generateSuffix() });
});

// Deterministic label color derived from the suffix string: hash to an HSL hue,
// convert to a readable pastel-ish hex color. Two teams with different suffixes
// get visually distinct label colors in the GitHub UI.
function suffixLabelColor(suffix) {
  let h = 0;
  for (let i = 0; i < suffix.length; i++) h = (h * 31 + suffix.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  // Fixed saturation + lightness for a consistent pastel palette.
  const s = 65, l = 60;
  const a = s * Math.min(l, 100 - l) / 100;
  const f = n => {
    const k = (n + hue / 30) % 12;
    const c = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    return Math.round(255 * c / 100).toString(16).padStart(2, '0');
  };
  return `${f(0)}${f(8)}${f(4)}`;
}

// Best-effort label provisioning call to the orchestrator after materialisation.
// Creates missing GitHub labels for the stamped token set. Failures are warnings.
async function provisionGithubLabels(orchestratorUrl, envId, tokenSet, suffix) {
  if (!suffix || !tokenSet || !tokenSet.size) return [];
  try {
    const color = suffixLabelColor(suffix);
    const resp = await fetch(
      `${orchestratorUrl}/internal/environments/${encodeURIComponent(envId)}/github-labels`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ labels: [...tokenSet], color }),
      },
    );
    const data = await resp.json().catch(() => ({}));
    if (data.warnings?.length) return data.warnings;
    return [];
  } catch (err) {
    return [`Label provisioning: ${err.message}`];
  }
}

app.post('/api/teams', heavyLimiter, async (req, res) => {
  const body = req.body || {};
  const { teamId, teamName, mcpServers } = body;
  // repository + githubTokenId may be supplied directly (legacy Team-Setup
  // wizard, which auto-creates an env) OR derived from a reused Working
  // Environment (environmentId, below) — so they are mutable here.
  let { repository, githubTokenId } = body;
  // A team can be materialised onto an existing Working Environment instead of
  // having one auto-created from a repo URL + credentials. When environmentId
  // is supplied we pull the repo/branch/credentials from that env and skip the
  // env-creation phase entirely.
  const environmentId = (typeof body.environmentId === 'string' && body.environmentId.trim())
    ? normalizeEnvId(body.environmentId)
    : null;
  // Initial team skill set (team-owned grant, orchestrator/skill-grants.js):
  // lands on the TEAM AGENT's `skills[]`, never on the environment — members
  // inherit it unless they carry a skillsOverride. Supplied by the wizard's
  // Knowledge step.
  const initialSkills = Array.isArray(body.skills)
    ? body.skills.filter(s => typeof s === 'string' && s.trim()).map(s => s.trim())
    : [];
  const mode = body.mode === 'extend' ? 'extend' : 'create';
  // Initial knowledge-*learning* config (autonomy / review / gates, #567) from the
  // wizard's Knowledge step. Reduced to a minimal non-default patch; null when the
  // operator left every control on its default, so a defaulted wizard persists
  // nothing and the team reads byte-identically to a pre-#567 team (AC-4). Only
  // honoured in create mode — extend keeps the existing team's config.
  const knowledgeConfigPatch = mode === 'create'
    ? knowledgeSuggestions.normalizeWizardKnowledgeConfig(body.knowledgeConfig)
    : null;
  // Deferred materialization: when false, members are created as stubs (config
  // + triggers only, no Matrix user / clone / process), shown in the UI and
  // materialized on demand via enable. Avoids dozens of clones up front for a
  // large process.
  // Default true preserves the existing immediate-materialization behaviour.
  const materializeMembers = body.materializeMembers !== false;
  const readyLabel = (typeof body.readyLabel === 'string' && body.readyLabel.trim())
    ? body.readyLabel.trim()
    : 'ready';
  if (!READY_LABEL_RE.test(readyLabel)) {
    return res.status(400).json({
      error: 'readyLabel must be 1–50 chars and contain no whitespace or quote/brace characters',
    });
  }
  const dispatchLabel = (typeof body.dispatchLabel === 'string' && body.dispatchLabel.trim())
    ? body.dispatchLabel.trim()
    : 'dispatch';
  if (!DISPATCH_LABEL_RE.test(dispatchLabel)) {
    return res.status(400).json({
      error: 'dispatchLabel must be 1–50 chars and contain no whitespace or quote/brace characters',
    });
  }
  // GitHub label names are case-insensitive — `Dispatch` and `dispatch`
  // would collide despite passing a strict `===` check.
  if (dispatchLabel.toLowerCase() === readyLabel.toLowerCase()) {
    return res.status(400).json({
      error: 'dispatchLabel and readyLabel must differ — the Dispatcher needs a distinct label to release issues to the Developer',
    });
  }
  // Reject non-integer / out-of-range explicitly rather than silently
  // coercing — a stray `"3"` or `1.5` from the caller would otherwise be
  // swallowed and turned into the default, with no feedback.
  if (body.maxParallel !== undefined && !Number.isInteger(body.maxParallel)) {
    return res.status(400).json({
      error: `maxParallel must be an integer in [${MAX_PARALLEL_MIN}, ${MAX_PARALLEL_MAX}]`,
    });
  }
  const maxParallel = body.maxParallel ?? 1;
  if (maxParallel < MAX_PARALLEL_MIN || maxParallel > MAX_PARALLEL_MAX) {
    return res.status(400).json({
      error: `maxParallel must be an integer in [${MAX_PARALLEL_MIN}, ${MAX_PARALLEL_MAX}]`,
    });
  }
  // Label suffix (#902): optional short base36 tag applied once to all label
  // tokens at materialisation so parallel teams/stacks on one repo don't
  // cross-trigger. Empty/absent = standard shared label vocabulary.
  const labelSuffix = (typeof body.labelSuffix === 'string' && body.labelSuffix.trim())
    ? body.labelSuffix.trim()
    : '';
  {
    const sv = validateSuffix(labelSuffix);
    if (!sv.ok) return res.status(400).json({ error: sv.error });
  }

  // ── 1. Validate input ─────────────────────────────────────────────
  if (typeof teamId !== 'string' || !TEAM_ID_RE.test(teamId)) {
    return res.status(400).json({ error: 'teamId must be a lowercase slug, 1–40 chars, [a-z0-9-]' });
  }
  if (typeof teamName !== 'string' || !teamName.trim()) {
    return res.status(400).json({ error: 'teamName required' });
  }
  // Reject unknown initial skill names (#633) — in create mode the team pool
  // does not exist yet, so this validates against the global pool only, which
  // is exactly the create-mode picker contract (global-only). No prior grant to
  // preserve on a fresh team, so every name must be a real skill.
  {
    const v = skillGrantValidate.validateGrantNames(initialSkills, knownSkillNamesFor(teamId), []);
    if (!v.ok) return res.status(400).json({ error: `Unknown skill(s): ${v.unknown.join(', ')} — pick from the list or create them first.` });
  }

  // Resolve a reused Working Environment (if any) into the repository +
  // credential inputs the rest of the pipeline expects. The env was validated
  // when it was created, so we trust its stored repo/token here.
  // A reused env may legitimately carry ZERO repositories (#1623): the team and
  // its members are then created repo-less — nothing is cloned and GitHub
  // hand-off channels are unavailable. Only the reused-env path supports this;
  // the legacy auto-create path still needs a repo to build the env from.
  let repoLess = false;
  if (environmentId) {
    const reusedEnv = loadEnvironment(environmentId);
    if (!reusedEnv) {
      return res.status(400).json({ error: `Working environment '${environmentId}' not found` });
    }
    const primary = reposFromEnv(reusedEnv)[0];
    if (primary?.url) {
      repository = { url: primary.url, branch: primary.branch || 'main', sshKeyId: primary.sshKeyId || null };
    } else {
      repoLess = true;
      repository = null;
    }
    githubTokenId = reusedEnv.githubTokenId || null;
  } else if (!repository || !repository.url) {
    // No environment to reuse AND no repository declared: create the team with
    // NO infrastructure at all (#2081 AC6, #2041 D7). The env auto-created below
    // already handles a null `parsed` by writing `repositories: []`, so this is
    // the same repo-less team #1623 shipped for the reused-env path — what
    // changes is only that the platform stops demanding a repo, an SSH key and
    // a PAT before a brand-new user is allowed to have a team at all. A
    // repository that IS declared keeps every existing check.
    repoLess = true;
    repository = null;
  }

  if (!repoLess) {
    if (!repository?.url) {
      return res.status(400).json({ error: 'repository.url required' });
    }
    // The legacy path (no environmentId) auto-creates an env from an SSH deploy
    // key, so sshKeyId stays mandatory there. A reused env may clone over HTTPS
    // with just a PAT, so sshKeyId is optional in that path.
    if (!environmentId && !repository.sshKeyId) {
      return res.status(400).json({ error: 'repository.url and repository.sshKeyId required' });
    }
  }
  let parsed = null;
  if (!repoLess) {
    try {
      parsed = deriveRepoIdentity(repository.url);
    } catch (err) {
      return res.status(400).json({ error: `Invalid repository URL: ${err.message}` });
    }
  }
  const branch = !repoLess && typeof repository.branch === 'string' && /^[A-Za-z0-9._/-]+$/.test(repository.branch)
    ? repository.branch
    : 'main';

  // ── 2. Credentials must already exist (Pre-Flight) ────────────────
  if (repository?.sshKeyId && !listSshKeys().some(k => k.id === repository.sshKeyId)) {
    return res.status(400).json({ error: `SSH key '${repository.sshKeyId}' not found` });
  }
  // The auto-created env path requires a GitHub PAT *when it has a repository to
  // reach*: the token exists to clone and to drive `gh`. A repo-less team has
  // nothing to authenticate against, so demanding one there would re-impose the
  // pre-configuration AC6 removes. A reused env may legitimately carry none
  // (e.g. SSH-only clone), so only validate a token when one is set.
  if (!environmentId && !repoLess) {
    if (typeof githubTokenId !== 'string' || !listGithubTokens().some(t => t.id === githubTokenId)) {
      return res.status(400).json({ error: `GitHub token '${githubTokenId}' not found` });
    }
  } else if (githubTokenId && !listGithubTokens().some(t => t.id === githubTokenId)) {
    return res.status(400).json({ error: `GitHub token '${githubTokenId}' not found` });
  }

  // MCP refs are validated up-front so a bad serverId/credentialId aborts the
  // request before any agent/env/Matrix-user has been created.
  let normalizedMcpServers;
  try {
    normalizedMcpServers = normalizeMcpServersInput(mcpServers);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  // ── 3. Roles must map to known catalog templates OR inline custom roles ──
  // Inline roles come from an imported Process Canvas bundle (#334): either as
  // `customRoles` (pseudo-template shape) or a whole `processTemplate` bundle.
  // They are resolved exactly like catalog templates by the materialisation
  // loop below (var substitution over prompt + triggers).
  let customRolesRaw = Array.isArray(body.customRoles) ? body.customRoles : [];
  if (body.processTemplate) {
    const v = validateProcessTemplate(body.processTemplate);
    if (!v.ok) return res.status(400).json({ error: `Invalid processTemplate: ${v.error}` });
    // Expand GitHub channels (#380) into consumer github-event triggers + the
    // producer instruction block, then data-flow edges (#379) into `push`
    // triggers scoped to each upstream agent, before flattening to custom roles.
    // normalizeLegacyReview maps any legacy pr-review roles (#347) onto channels.
    customRolesRaw = templateToCustomRoles(
      expandDataFlowSteps(
        // expandWakeHandoffs (#2031) runs INSIDE expandGithubChannels' input so
        // the single derived-prompt pass at the tail of that expander is still
        // the last thing to touch each role's systemPrompt.
        expandGithubChannels(
          expandWakeHandoffs(liftTriggerEmits(normalizeLegacyReview(body.processTemplate))),
          { teamId },
        ),
        { teamId },
      )
    );
  }
  // Ordered stage names from the bundle — stored on the team agent so the live
  // graph reproduces the draft's stage layout (per-node stage rides on each
  // member's config; this is the column *order*).
  const bundleStages = Array.isArray(body.processTemplate?.stages)
    ? body.processTemplate.stages.filter(s => typeof s === 'string')
    : [];
  // Authoritative gate/brake label registry (#928) — normalized to the persisted
  // shape so the live graph reads booleans back, never a stray truthy value.
  let bundleLabels = Array.isArray(body.processTemplate?.labels)
    ? body.processTemplate.labels
      .filter(l => l && typeof l.name === 'string' && l.name.trim())
      .map(l => ({ name: l.name.trim(), humanGate: !!l.humanGate, brake: !!l.brake }))
    : [];
  // Named human roles (#987) — normalized to the persisted shape and stored on
  // the team agent (like `stages`/`labels`) so the live graph binds the #981
  // touchpoints to the named nodes. Never materialise into an agent.
  const bundleHumans = normalizeHumans(body.processTemplate?.humans);
  // Hill-climb collector config (#1222) — normalized to the known config keys and
  // stored on the team agent (like `stages`/`labels`) so an imported bundle keeps
  // its collector config. null when the bundle never configured it.
  const bundleHillClimb = normalizeHillClimb(body.processTemplate?.hillClimb);
  // Admission control (#2114) — the declarative per-flow WIP limit, stored on the
  // team agent (like `stages`/`labels`) because the orchestrator's dispatch path
  // reads the team config, never a draft. null when the bundle set no limit, in
  // which case dispatch stays unbounded exactly as before.
  const bundleWipLimit = normalizeWipLimit(body.processTemplate?.wipLimit);

  // Label-suffix stamping (#902): one-shot rename applied to the member array
  // + bundle label registry before any agent is created. No-op when labelSuffix
  // is empty (byte-identical output). Warnings surface un-stamped prompt mentions.
  let suffixWarnings = [];
  let suffixTokenSet = null;
  if (labelSuffix) {
    const stamped = applyLabelSuffix(customRolesRaw, bundleLabels, labelSuffix);
    customRolesRaw = stamped.members;
    bundleLabels = stamped.bundleLabels;
    suffixWarnings = stamped.warnings;
    suffixTokenSet = stamped.tokenSet;
  }

  const customMap = new Map(customRolesRaw.map(r => [r.id, r]));
  const resolveTemplate = (id) => customMap.get(id) || loadAgentTemplate(id);

  // `roles` may be omitted when inline roles are supplied — synthesise it.
  let rolesInput = body.roles;
  if ((!Array.isArray(rolesInput) || rolesInput.length === 0) && customMap.size > 0) {
    rolesInput = [...customMap.keys()].map(id => ({ id, count: 1 }));
  }
  const normalizedRoles = normalizeRolesInput(rolesInput);
  if (!normalizedRoles || normalizedRoles.length === 0) {
    return res.status(400).json({ error: 'roles must be a non-empty array of template ids (or supply customRoles / processTemplate)' });
  }
  const knownIds = new Set(listAgentTemplateIds());
  const unknown = normalizedRoles.map(r => r.id).filter(id => !knownIds.has(id) && !customMap.has(id));
  if (unknown.length) {
    return res.status(400).json({
      error: `Unknown roles: ${unknown.join(', ')}`,
      knownRoles: [...knownIds],
    });
  }
  const seenRoleIds = new Set();
  for (const r of normalizedRoles) {
    if (seenRoleIds.has(r.id)) return res.status(400).json({ error: `Duplicate role id: ${r.id}` });
    seenRoleIds.add(r.id);
  }

  // ── 4. Plan resource ids ──────────────────────────────────────────
  // v2 shape: 1 env + 1 team agent + N team-members. Naming:
  //   env id        = teamId
  //   team agent id = teamId
  //   member id     = `<teamId>-<roleId>` (count=1) or `<teamId>-<roleId>-N` (count>1)
  // A reused Working Environment keeps its own id (env id != teamId); otherwise
  // the env is auto-created under the teamId.
  const envId = environmentId || teamId;
  const teamAgentId = teamId;
  const planned = planMembers(teamId, normalizedRoles, resolveTemplate);
  for (const p of planned) {
    if (!AGENT_ID_RE.test(p.memberId)) {
      return res.status(400).json({ error: `Computed memberId '${p.memberId}' is invalid` });
    }
  }

  const envExists = !!loadEnvironment(envId);
  // Containment check — teamAgentId (= teamId) and each memberId are
  // TEAM_ID_RE/AGENT_ID_RE-validated, but CodeQL's js/path-injection query
  // doesn't recognise the regex as a barrier; path.resolve + path.relative is
  // the in-flow sanitiser it does recognise. Build every id-derived fs path
  // from the contained dir.
  const teamsAgentsRoot = path.resolve(AGENTS_DIR);
  const teamAgentDir = path.resolve(teamsAgentsRoot, teamAgentId);
  const teamAgentRel = path.relative(teamsAgentsRoot, teamAgentDir);
  if (teamAgentRel.startsWith('..') || path.isAbsolute(teamAgentRel)) {
    return res.status(400).json({ error: 'Invalid teamId path' });
  }
  // Inspect the existing agent (if any) so we can distinguish "an actual
  // team blocks this id" from "some unrelated agent (a plain agent, or a
  // leftover config naming a retired role) blocks this id". The first is a real
  // collision the user can resolve via extend; the second is an id
  // conflict and `mode: extend` would be a lie.
  const existingTeamCfg = fs.existsSync(teamAgentDir)
    ? readJsonFile(path.join(teamAgentDir, 'config.json'), null)
    : null;
  const teamExists = !!existingTeamCfg && existingTeamCfg.role === 'team';
  const teamIdTakenByOther = !!existingTeamCfg && existingTeamCfg.role !== 'team';
  // Read each planned member's config so residue classification is symmetric
  // with `teamExists` — a bare directory must never outrank a readable config
  // (#1525). Containment via path.resolve + path.relative is the CodeQL barrier.
  const memberEntries = planned.map(p => {
    const memberDir = path.resolve(teamsAgentsRoot, p.memberId);
    const memberRel = path.relative(teamsAgentsRoot, memberDir);
    if (memberRel.startsWith('..') || path.isAbsolute(memberRel)) {
      return { memberId: p.memberId, exists: false, config: null };
    }
    const exists = fs.existsSync(memberDir);
    return {
      memberId: p.memberId,
      exists,
      config: exists ? readJsonFile(path.join(memberDir, 'config.json'), null) : null,
    };
  });
  const residue = classifyMemberResidue(memberEntries, teamId);
  const { existingMembers } = residue;

  // One shared decision with the streaming handler (#1525) — a config-less /
  // provisioning-stub leftover is an adoptable orphan, not a collision.
  const decision = decideTeamCreate({ mode, teamExists, teamIdTakenByOther, residue });
  if (decision.type === 'conflict-team') {
    return res.status(409).json({
      error: `Cannot use teamId '${teamId}': an agent with this id already exists ` +
        `with role '${existingTeamCfg.role}'. Pick a different teamId or delete ` +
        `the existing agent first.`,
    });
  }
  if (decision.type === 'conflict-members') {
    const list = decision.members.map(m => `${m.memberId} (role '${m.role}')`).join(', ');
    return res.status(409).json({
      error: `Cannot create team '${teamId}': the id(s) ${list} already belong to ` +
        `unrelated agent(s). Pick a different teamId or delete the existing agent(s) first.`,
    });
  }
  if (decision.type === 'extend-missing-team') {
    return res.status(409).json({
      error: `Cannot extend: team '${teamId}' does not exist yet. Use mode: "create" first.`,
    });
  }
  if (decision.type === 'collision') {
    // Real collision = an actual team or member exists. An env-only orphan and
    // a config-less agent-dir orphan are both adopted (recovered) below.
    return res.status(409).json({
      error: 'Resources for this team already exist',
      existing: {
        env: envExists ? envId : null,
        team: teamExists ? teamAgentId : null,
        members: decision.existingMembers,
      },
      suggestion: 'Pass `mode: "extend"` to add only the missing roles.',
    });
  }

  // decision.type === 'proceed' — leftover orphan dirs to clean before create.
  const orphansToClean = decision.orphansToClean;
  let toCreate;
  if (mode === 'extend') {
    // Who may CREATE a team is P3's contract (#2081): creating one is
    // self-service for any authenticated user (D1), but EXTENDING one adds
    // members to a team that already exists and belongs to somebody, which the
    // D9 matrix makes a Team-Admin action. Both handlers were ungated, so under
    // private-by-default any authenticated caller could have grown a stranger's
    // team. Gated on the same `canManageAgent`/`agentMetaForScope` pair every
    // other team-mutating route uses, so the rule cannot drift from theirs, and
    // placed here — after validation, before the first write.
    if (!canManageAgent(getScope(req), agentMetaForScope(existingTeamCfg))) {
      return res.status(403).json({ error: 'forbidden', code: 'forbidden' });
    }
    // Enforce suffix consistency: added roles must use the stored suffix.
    const storedSuffix = existingTeamCfg.labelSuffix || '';
    if (labelSuffix !== storedSuffix) {
      return res.status(400).json({
        error: `labelSuffix mismatch: team '${teamId}' was created with suffix '${storedSuffix || '(none)'}'; ` +
          `extending it with '${labelSuffix || '(none)'}' would create mismatched labels.`,
      });
    }
    toCreate = planned.filter(p => !existingMembers.includes(p.memberId));
    if (toCreate.length === 0) {
      return res.status(200).json({
        teamId,
        teamName,
        created: [],
        skipped: planned.map(p => p.memberId),
        message: 'All requested roles already exist on this team; nothing to do.',
      });
    }
  } else {
    toCreate = planned;
  }
  // Never overwrite a deliberately reused environment — only adopt an orphan
  // env that was auto-created under this teamId by a prior aborted run.
  const adoptOrphanEnv = mode === 'create' && envExists && !environmentId;

  // ── 5. Substitution variables for templates ───────────────────────
  // When the team includes a Dispatcher, the Developer is wired to react
  // to the dispatch label. Without a Dispatcher, `{{dispatchLabel}}` falls
  // back to the ready label so the Developer still works on bare `ready`-
  // labeled issues (legacy single-stage flow).
  const hasDispatcher = normalizedRoles.some(r => r.id === 'dispatcher');
  const effectiveDispatchLabel = hasDispatcher ? dispatchLabel : readyLabel;
  const vars = {
    teamName,
    teamId,
    ...repoVars(parsed, repository?.url),
    branch,
    readyLabel,
    dispatchLabel: effectiveDispatchLabel,
    maxParallel,
  };

  // ── 6. Atomic create with rollback ────────────────────────────────
  // Track everything we created so we can undo cleanly. `extend` mode
  // tracks NOTHING from before our call — pre-existing env/team are
  // preserved on rollback even if the new members fail.
  const created = { env: null, team: null, members: [], dms: [] };
  const orchestratorUrl = process.env.ORCHESTRATOR_URL || 'http://orchestrator:4002';

  // A rollback that could not delete something must be loud (#1525 AC3):
  // record the failed cleanup (with the leftover id) into `rollbackWarnings`
  // so the caller learns about residue instead of being told all was well.
  const rollbackWarnings = [];
  const rollbackDelete = async (id, kind) => {
    try {
      const resp = await fetch(`${orchestratorUrl}/internal/agents/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (!resp.ok && resp.status !== 404) {
        const data = await resp.json().catch(() => ({}));
        const detail = data.error || `HTTP ${resp.status}`;
        console.error(`[Team] Rollback: failed to delete ${kind} ${id}: ${detail}`);
        rollbackWarnings.push({ id, kind, error: detail });
      }
    } catch (err) {
      console.error(`[Team] Rollback: failed to delete ${kind} ${id}: ${err.message}`);
      rollbackWarnings.push({ id, kind, error: err.message });
    }
  };

  const rollback = async (reason) => {
    console.warn(`[Team] Rolling back ${teamId}: ${reason}`);
    for (const memberId of [...created.members].reverse()) {
      await rollbackDelete(memberId, 'member');
    }
    if (created.team) {
      await rollbackDelete(created.team, 'team');
    }
    if (created.env) {
      try {
        const environmentsRoot = path.resolve(ENVIRONMENTS_DIR);
        const envPath = path.resolve(environmentsRoot, String(created.env));
        if (envPath === environmentsRoot || envPath.startsWith(environmentsRoot + path.sep)) {
          fs.rmSync(envPath, { recursive: true, force: true });
        } else {
          console.error(`[Team] Rollback: refused to delete env outside root: ${created.env}`);
        }
      } catch (err) {
        console.error(`[Team] Rollback: failed to delete env ${created.env}: ${err.message}`);
      }
    }
  };

  try {
    // Phase 0 — adopt orphans. Config-less / provisioning-stub leftover dirs
    // from a prior aborted create are deleted through the audited agent-delete
    // choke-point so a same-id retry starts clean (#1525). Not tracked in the
    // rollback set — they were garbage before this request.
    for (const orphanId of orphansToClean) {
      const resp = await fetch(`${orchestratorUrl}/internal/agents/${encodeURIComponent(orphanId)}`, { method: 'DELETE' });
      if (!resp.ok && resp.status !== 404) {
        const data = await resp.json().catch(() => ({}));
        throw new Error(`Cleanup of leftover '${orphanId}': ${data.error || `HTTP ${resp.status}`}`);
      }
    }

    // Phase A — single shared environment: pure infrastructure (repo, SSH
    // key, PAT, MCP). Skills are team-owned and live on the team agent below.
    if (!envExists || adoptOrphanEnv) {
      const env = {
        id: envId,
        name: teamName,
        description: `Working environment for team '${teamName}'.`,
        repositories: parsed ? [{ url: parsed.httpsUrl, branch, sshKeyId: repository.sshKeyId }] : [],
        githubTokenId,
        mcpServers: normalizedMcpServers,
        ...defaultLlmEndpointForTeam(),
        additionalContext: '',
        // Owned by the team it was auto-created for (#2081). Without this the
        // record carries no tier at all, which since #2078 dropped the
        // `|| 'default'` fallback makes it invisible to everyone but a System
        // Admin — including the human who just created the team.
        ...creatorEnvironmentOwnership(teamAgentId),
        createdAt: new Date().toISOString(),
      };
      saveEnvironment(envId, env);
      created.env = envId;
    }

    // Phase B — the team agent itself. Generic shared prompt; suppress the
    // first-member auto-create (the wizard adds members itself with role
    // overrides in Phase C).
    if (!teamExists) {
      const teamPrompt = defaultTeamPrompt(vars);
      const resp = await fetch(`${orchestratorUrl}/internal/agents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: teamAgentId,
          displayName: teamName,
          role: 'team',
          systemPrompt: teamPrompt,
          environmentId: envId,
          skipFirstMember: true,
          // The team's ACTIVE skill set (team-owned grant) — inherited by
          // every member without a skillsOverride.
          skills: initialSkills,
          // Ordered stage names for the process graph's layered layout (#stage-order).
          ...(bundleStages.length ? { stages: bundleStages } : {}),
          // Named human roles (#987) — held on the team agent like stages/labels.
          ...(bundleHumans.length ? { humans: bundleHumans } : {}),
          // Hill-climb collector config (#1222) — held on the team agent like stages.
          ...(bundleHillClimb ? { hillClimb: bundleHillClimb } : {}),
          // Admission control (#2114) — held on the team agent like hillClimb.
          ...(bundleWipLimit ? { wipLimit: bundleWipLimit } : {}),
          // Authoritative gate/brake label registry (#928): the live graph has no
          // bundle to read it from and gate-ness is no longer inferable from the
          // label's name, so the team agent holds it — same pattern as `stages`.
          ...(bundleLabels.length ? { labels: bundleLabels } : {}),
          // Label suffix (#902): stored so extend-mode adds roles with the same
          // suffix and Flow-Editor dialogs can pre-fill new label inputs.
          ...(labelSuffix ? { labelSuffix } : {}),
          // Human owner (#2077, D8) — the authenticated creator of the team.
          ...ownerFor(req),
        }),
      });
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}));
        throw new Error(`Team agent ${teamAgentId}: ${data.error || `HTTP ${resp.status}`}`);
      }
      created.team = teamAgentId;
      // The creator becomes this team's Team Admin, in the same operation
      // (#2081 AC1, #2041 D1). The `ownerId` stamped above is not enough on its
      // own: a `role: 'team'` agent IS its own access boundary, so
      // `visibleAgent`/`canManageAgent` take the membership branch and a
      // creator with no prior membership could not see the team they had just
      // made. `planCreatorMembership` is what keeps the two handlers writing it
      // under identical conditions — exactly once, and never on an extend.
      //
      // Fatal, not best-effort: "in the same operation" is the acceptance
      // criterion, and a team whose creator cannot see it is worse than no team
      // at all — the `catch` below rolls the whole create back.
      const creatorMembership = planCreatorMembership({
        userId: getScope(req).userId,
        teamAgentId,
        teamCreated: true,
      });
      if (creatorMembership) {
        const { status, data } = await callAdmin('POST', 'memberships', creatorMembership);
        if (status >= 400) {
          throw new Error(`Team admin membership for ${teamAgentId}: ${(data && data.error) || `HTTP ${status}`}`);
        }
      }
    }

    // Phase C — team-members, one per selected role. Each one carries a
    // role-specific prompt override (so the team's generic prompt stays
    // useful as a fallback) and the role's full triggers.json.
    for (const p of toCreate) {
      const memberVars = { ...vars, agentId: p.memberId };
      // Member display name is the role name only (optionally numbered for
      // multi-instance roles). The parent team name is intentionally NOT
      // prepended — UIs already group members under their team, so prefixing
      // would just duplicate the team name and make every label long.
      const memberDisplayName = p.instanceIndex !== null
        ? `${p.template.displayName} ${p.instanceIndex}`
        : p.template.displayName;
      // Single source of truth for the member-create body (shared with the
      // streaming endpoint and the Flow Editor's add-role-from-template, #586):
      // prompt + triggers substituted per-member; declarative ports carried.
      const memberBody = buildMemberFromTemplate(p.template, {
        teamId, memberId: p.memberId, memberDisplayName, vars: memberVars,
        materialize: materializeMembers,
      });
      const resp = await fetch(`${orchestratorUrl}/internal/teams/${encodeURIComponent(teamAgentId)}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(memberBody),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        throw new Error(`Member ${p.memberId}: ${data.error || `HTTP ${resp.status}`}`);
      }
      // Same clone-warning-as-fatal treatment as the streaming endpoint —
      // a wizard-created team without its repo is a broken setup, not a
      // graceful degradation.
      const cloneWarning = (data.warnings || []).find(w => /^git clone /.test(w));
      if (cloneWarning) {
        created.members.push(p.memberId);
        throw new Error(`Member ${p.memberId}: ${cloneWarning}`);
      }
      created.members.push(p.memberId);
    }

    // Re-derive direct-hand-off wiring against the members' materialised ids
    // (#2030) now that every member exists — see reconcileTeamHandoffWiring.
    await reconcileTeamHandoffWiring(teamAgentId);

    // Phase C.5 — persist the wizard's knowledge-learning config (#567). Fatal
    // like the clone check: a team created with the operator's chosen autonomy /
    // review / gates silently falling back to defaults would violate AC-3, so a
    // failure here rolls the whole team back. Only fires when the patch is
    // non-null (a defaulted wizard writes nothing — AC-4) and only in create mode.
    if (knowledgeConfigPatch) {
      const kResp = await fetch(`${orchestratorUrl}/internal/knowledge/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ teamId, config: knowledgeConfigPatch }),
      });
      const kData = await kResp.json().catch(() => ({}));
      if (!kResp.ok || !kData.ok) {
        throw new Error(`knowledge config: ${kData.error || `HTTP ${kResp.status}`}`);
      }
    }

    // Phase D — DM rooms (best-effort). Members without DMs miss trigger
    // output until a chat is opened; we keep going on failure. Skipped for
    // deferred (stub) members — they have no Matrix user yet; the DM room is
    // created when the stub is materialized + a chat is opened.
    if (materializeMembers) {
      for (const p of toCreate) {
        try {
          const r = await ensureAgentDmRoom(p.memberId);
          created.dms.push({ agentId: p.memberId, roomId: r.roomId });
        } catch (err) {
          console.warn(`[Team] DM pre-create skipped for ${p.memberId}: ${err.message}`);
        }
      }
    }

    res.status(201).json({
      teamId,
      teamName,
      env: envId,
      team: teamAgentId,
      created: created.members,
      materialized: materializeMembers,
      skipped: planned
        .filter(p => !toCreate.some(c => c.memberId === p.memberId))
        .map(p => p.memberId),
      dms: created.dms,
      ...(suffixWarnings.length ? { warnings: suffixWarnings } : {}),
    });

    // Phase E — label provisioning (best-effort, after response sent).
    // Create the stamped labels in the target repo so `gh issue edit --add-label`
    // doesn't fail on a label that doesn't exist yet. Failures are logged only.
    provisionGithubLabels(orchestratorUrl, envId, suffixTokenSet, labelSuffix)
      .then(provWarn => {
        if (provWarn.length) console.warn(`[Team] Label provisioning warnings for ${teamId}:`, provWarn);
      })
      .catch(err => console.warn(`[Team] Label provisioning error for ${teamId}: ${err.message}`));
  } catch (err) {
    await rollback(err.message);
    res.status(500).json({
      error: `Team creation failed: ${err.message}`,
      // A partial rollback is worse when silent (#1525 AC3): name the leftovers.
      ...(rollbackWarnings.length ? { rollbackWarnings } : {}),
    });
  }
});

/* ─── Team setup — streaming variant ────────────────────────────────────
   Same input/output as POST /api/teams, but emits NDJSON progress events
   as the materialization proceeds. The frontend uses this for the live
   progress UI in the Team-Setup wizard. */

app.post('/api/teams/stream', heavyLimiter, async (req, res) => {
  // Plain NDJSON over chunked transfer; no SSE wrapping. The wizard reads
  // chunks via the fetch streams API and parses one JSON object per line.
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  // Send headers + open the chunked body NOW. Without this, Node holds the
  // response open until enough body bytes accumulate, so the wizard sees no
  // events for the entire ~10s the team-agent clone takes — and then every
  // queued event arrives in one burst when the request ends.
  res.flushHeaders();
  // Keep the underlying socket free of Nagle batching so each per-step
  // write hits the wire immediately instead of waiting up to 200ms for a
  // companion packet that never comes (every event is its own short line).
  if (typeof res.socket?.setNoDelay === 'function') {
    res.socket.setNoDelay(true);
  }

  // Track whether the *socket* is gone, not whether the request body has
  // been fully consumed. `req.on('close')` fires as soon as Node finishes
  // reading the body — which happens right after `express.json()` runs,
  // i.e. before our handler even reaches the first await. Listening on it
  // would short-circuit every write past that point. `res.on('close')`
  // fires only on actual client disconnect (or after we've called res.end
  // ourselves), which is what we actually want.
  let aborted = false;
  res.on('close', () => {
    if (!res.writableEnded) aborted = true;
  });

  function emit(ev) {
    if (aborted) return;
    try {
      res.write(JSON.stringify(ev) + '\n');
    } catch { /* socket gone */ }
  }
  function fail(status, errorMsg) {
    emit({ type: 'error', status, error: errorMsg });
    if (!aborted) res.end();
  }

  const body = req.body || {};
  const { teamId, teamName, mcpServers } = body;
  // See POST /api/teams: repository/githubTokenId are mutable so they can be
  // derived from a reused Working Environment (environmentId).
  let { repository, githubTokenId } = body;
  const environmentId = (typeof body.environmentId === 'string' && body.environmentId.trim())
    ? normalizeEnvId(body.environmentId)
    : null;
  // Initial team skill set (team-owned grant, orchestrator/skill-grants.js):
  // lands on the TEAM AGENT's `skills[]`, never on the environment — members
  // inherit it unless they carry a skillsOverride. Supplied by the wizard's
  // Knowledge step.
  const initialSkills = Array.isArray(body.skills)
    ? body.skills.filter(s => typeof s === 'string' && s.trim()).map(s => s.trim())
    : [];
  const mode = body.mode === 'extend' ? 'extend' : 'create';
  // Initial knowledge-learning config (#567) — see the non-streaming handler above.
  const knowledgeConfigPatch = mode === 'create'
    ? knowledgeSuggestions.normalizeWizardKnowledgeConfig(body.knowledgeConfig)
    : null;
  const readyLabel = (typeof body.readyLabel === 'string' && body.readyLabel.trim())
    ? body.readyLabel.trim()
    : 'ready';
  const dispatchLabel = (typeof body.dispatchLabel === 'string' && body.dispatchLabel.trim())
    ? body.dispatchLabel.trim()
    : 'dispatch';
  // Label suffix (#902) — see the non-streaming handler above.
  const labelSuffix = (typeof body.labelSuffix === 'string' && body.labelSuffix.trim())
    ? body.labelSuffix.trim()
    : '';
  // Deferred materialization (#1955) — see the non-streaming handler above for
  // the full rationale. BOTH launch surfaces (the Team-Setup wizard and the Flow
  // Editor's Materialize dialog) submit here, so the flag has to be honoured on
  // this path as well; reading it anywhere else left the checkbox inert. Default
  // true, so a caller that omits it (or the wizard, which sends an explicit
  // true) keeps the immediate-materialization behaviour byte-for-byte.
  const materializeMembers = body.materializeMembers !== false;

  // ── 1. Validate input ─────────────────────────────────────────────
  if (!READY_LABEL_RE.test(readyLabel)) {
    return fail(400, 'readyLabel must be 1–50 chars and contain no whitespace or quote/brace characters');
  }
  if (!DISPATCH_LABEL_RE.test(dispatchLabel)) {
    return fail(400, 'dispatchLabel must be 1–50 chars and contain no whitespace or quote/brace characters');
  }
  // GitHub label names are case-insensitive — `Dispatch` and `dispatch`
  // would collide despite passing a strict `===` check.
  if (dispatchLabel.toLowerCase() === readyLabel.toLowerCase()) {
    return fail(400, 'dispatchLabel and readyLabel must differ — the Dispatcher needs a distinct label to release issues to the Developer');
  }
  // Reject non-integer / out-of-range explicitly rather than silently
  // coercing — a stray `"3"` or `1.5` from the caller would otherwise be
  // swallowed and turned into the default, with no feedback.
  if (body.maxParallel !== undefined && !Number.isInteger(body.maxParallel)) {
    return fail(400, `maxParallel must be an integer in [${MAX_PARALLEL_MIN}, ${MAX_PARALLEL_MAX}]`);
  }
  const maxParallel = body.maxParallel ?? 1;
  if (maxParallel < MAX_PARALLEL_MIN || maxParallel > MAX_PARALLEL_MAX) {
    return fail(400, `maxParallel must be an integer in [${MAX_PARALLEL_MIN}, ${MAX_PARALLEL_MAX}]`);
  }
  {
    const sv = validateSuffix(labelSuffix);
    if (!sv.ok) return fail(400, sv.error);
  }
  if (typeof teamId !== 'string' || !TEAM_ID_RE.test(teamId)) {
    return fail(400, 'teamId must be a lowercase slug, 1–40 chars, [a-z0-9-]');
  }
  if (typeof teamName !== 'string' || !teamName.trim()) {
    return fail(400, 'teamName required');
  }
  // Reject unknown initial skill names (#633) — create-mode team pool doesn't
  // exist yet, so this validates against the global pool only (create-mode
  // picker contract). No prior grant on a fresh team.
  {
    const v = skillGrantValidate.validateGrantNames(initialSkills, knownSkillNamesFor(teamId), []);
    if (!v.ok) return fail(400, `Unknown skill(s): ${v.unknown.join(', ')} — pick from the list or create them first.`);
  }

  // Reuse an existing Working Environment when environmentId is supplied.
  // A reused env may carry ZERO repositories (#1623) — the team is then created
  // repo-less (nothing cloned, no GitHub hand-offs). Mirrors POST /api/teams.
  let repoLess = false;
  if (environmentId) {
    const reusedEnv = loadEnvironment(environmentId);
    if (!reusedEnv) {
      return fail(400, `Working environment '${environmentId}' not found`);
    }
    const primary = reposFromEnv(reusedEnv)[0];
    if (primary?.url) {
      repository = { url: primary.url, branch: primary.branch || 'main', sshKeyId: primary.sshKeyId || null };
    } else {
      repoLess = true;
      repository = null;
    }
    githubTokenId = reusedEnv.githubTokenId || null;
  } else if (!repository || !repository.url) {
    // No environment to reuse AND no repository declared: create the team with
    // NO infrastructure at all (#2081 AC6, #2041 D7). The env auto-created below
    // already handles a null `parsed` by writing `repositories: []`, so this is
    // the same repo-less team #1623 shipped for the reused-env path — what
    // changes is only that the platform stops demanding a repo, an SSH key and
    // a PAT before a brand-new user is allowed to have a team at all. A
    // repository that IS declared keeps every existing check.
    repoLess = true;
    repository = null;
  }

  if (!repoLess) {
    if (!repository?.url) {
      return fail(400, 'repository.url required');
    }
    if (!environmentId && !repository.sshKeyId) {
      return fail(400, 'repository.url and repository.sshKeyId required');
    }
  }
  let parsed = null;
  if (!repoLess) {
    try {
      parsed = deriveRepoIdentity(repository.url);
    } catch (err) {
      return fail(400, `Invalid repository URL: ${err.message}`);
    }
  }
  const branch = !repoLess && typeof repository.branch === 'string' && /^[A-Za-z0-9._/-]+$/.test(repository.branch)
    ? repository.branch
    : 'main';

  if (repository?.sshKeyId && !listSshKeys().some(k => k.id === repository.sshKeyId)) {
    return fail(400, `SSH key '${repository.sshKeyId}' not found`);
  }
  // Repo-less needs no PAT — mirror of the non-streaming handler (#2081 AC6).
  if (!environmentId && !repoLess) {
    if (typeof githubTokenId !== 'string' || !listGithubTokens().some(t => t.id === githubTokenId)) {
      return fail(400, `GitHub token '${githubTokenId}' not found`);
    }
  } else if (githubTokenId && !listGithubTokens().some(t => t.id === githubTokenId)) {
    return fail(400, `GitHub token '${githubTokenId}' not found`);
  }
  let normalizedMcpServers;
  try {
    normalizedMcpServers = normalizeMcpServersInput(mcpServers);
  } catch (err) {
    return fail(400, err.message);
  }
  // Inline roles (parity with POST /api/teams): either `customRoles` or a whole
  // `processTemplate` bundle (Process Canvas import / wizard Process step, #422).
  let customRolesRaw = Array.isArray(body.customRoles) ? body.customRoles : [];
  if (body.processTemplate) {
    const v = validateProcessTemplate(body.processTemplate);
    if (!v.ok) return fail(400, `Invalid processTemplate: ${v.error}`);
    customRolesRaw = templateToCustomRoles(
      expandDataFlowSteps(
        // expandWakeHandoffs (#2031) runs INSIDE expandGithubChannels' input so
        // the single derived-prompt pass at the tail of that expander is still
        // the last thing to touch each role's systemPrompt.
        expandGithubChannels(
          expandWakeHandoffs(liftTriggerEmits(normalizeLegacyReview(body.processTemplate))),
          { teamId },
        ),
        { teamId },
      )
    );
  }
  const bundleStages = Array.isArray(body.processTemplate?.stages)
    ? body.processTemplate.stages.filter(s => typeof s === 'string')
    : [];
  // Authoritative gate/brake label registry (#928) — normalized to the persisted
  // shape so the live graph reads booleans back, never a stray truthy value.
  let bundleLabels = Array.isArray(body.processTemplate?.labels)
    ? body.processTemplate.labels
      .filter(l => l && typeof l.name === 'string' && l.name.trim())
      .map(l => ({ name: l.name.trim(), humanGate: !!l.humanGate, brake: !!l.brake }))
    : [];
  // Named human roles (#987) — normalized to the persisted shape and stored on
  // the team agent (like `stages`/`labels`) so the live graph binds the #981
  // touchpoints to the named nodes. Never materialise into an agent.
  const bundleHumans = normalizeHumans(body.processTemplate?.humans);
  // Hill-climb collector config (#1222) — normalized to the known config keys and
  // stored on the team agent (like `stages`/`labels`) so an imported bundle keeps
  // its collector config. null when the bundle never configured it.
  const bundleHillClimb = normalizeHillClimb(body.processTemplate?.hillClimb);
  // Admission control (#2114) — the declarative per-flow WIP limit, stored on the
  // team agent (like `stages`/`labels`) because the orchestrator's dispatch path
  // reads the team config, never a draft. null when the bundle set no limit, in
  // which case dispatch stays unbounded exactly as before.
  const bundleWipLimit = normalizeWipLimit(body.processTemplate?.wipLimit);

  // Label-suffix stamping (#902) — see the non-streaming handler.
  let suffixWarnings = [];
  let suffixTokenSet = null;
  if (labelSuffix) {
    const stamped = applyLabelSuffix(customRolesRaw, bundleLabels, labelSuffix);
    customRolesRaw = stamped.members;
    bundleLabels = stamped.bundleLabels;
    suffixWarnings = stamped.warnings;
    suffixTokenSet = stamped.tokenSet;
  }

  const customMap = new Map(customRolesRaw.map(r => [r.id, r]));
  const resolveTemplate = (id) => customMap.get(id) || loadAgentTemplate(id);

  let rolesInput = body.roles;
  if ((!Array.isArray(rolesInput) || rolesInput.length === 0) && customMap.size > 0) {
    rolesInput = [...customMap.keys()].map(id => ({ id, count: 1 }));
  }
  const normalizedRoles = normalizeRolesInput(rolesInput);
  if (!normalizedRoles || normalizedRoles.length === 0) {
    return fail(400, 'roles must be a non-empty array of template ids (or supply customRoles / processTemplate)');
  }
  const knownIds = new Set(listAgentTemplateIds());
  const unknown = normalizedRoles.map(r => r.id).filter(id => !knownIds.has(id) && !customMap.has(id));
  if (unknown.length) {
    return fail(400, `Unknown roles: ${unknown.join(', ')}`);
  }
  const seenRoleIds = new Set();
  for (const r of normalizedRoles) {
    if (seenRoleIds.has(r.id)) return fail(400, `Duplicate role id: ${r.id}`);
    seenRoleIds.add(r.id);
  }

  // ── 2. Plan ───────────────────────────────────────────────────────
  // A reused Working Environment keeps its own id; otherwise auto-create under teamId.
  const envId = environmentId || teamId;
  const teamAgentId = teamId;
  const planned = planMembers(teamId, normalizedRoles, resolveTemplate);
  for (const p of planned) {
    if (!AGENT_ID_RE.test(p.memberId)) {
      return fail(400, `Computed memberId '${p.memberId}' is invalid`);
    }
  }

  const envExists = !!loadEnvironment(envId);
  // Distinguish "the id is taken by an actual team" (extend can recover)
  // from "the id is taken by some unrelated agent role" (extend is a lie,
  // surface the real conflict).
  const agentsRoot = path.resolve(AGENTS_DIR);
  const teamAgentPath = path.resolve(agentsRoot, teamAgentId);
  const teamAgentRel = path.relative(agentsRoot, teamAgentPath);
  if (teamAgentRel.startsWith('..') || path.isAbsolute(teamAgentRel)) {
    return fail(400, 'Invalid teamId path');
  }
  const existingTeamCfg = fs.existsSync(teamAgentPath)
    ? readJsonFile(path.join(teamAgentPath, 'config.json'), null)
    : null;
  const teamExists = !!existingTeamCfg && existingTeamCfg.role === 'team';
  const teamIdTakenByOther = !!existingTeamCfg && existingTeamCfg.role !== 'team';
  // Read each planned member's config so residue classification is symmetric
  // with `teamExists` — a bare directory must never outrank a readable config
  // (#1525). The path.resolve + path.relative containment is the CodeQL-
  // recognised js/path-injection barrier for the id-derived config read.
  const memberEntries = [];
  for (const p of planned) {
    const memberPath = path.resolve(agentsRoot, p.memberId);
    const memberRel = path.relative(agentsRoot, memberPath);
    if (memberRel.startsWith('..') || path.isAbsolute(memberRel)) {
      return fail(400, `Computed memberId '${p.memberId}' resolves outside AGENTS_DIR`);
    }
    const exists = fs.existsSync(memberPath);
    memberEntries.push({
      memberId: p.memberId,
      exists,
      config: exists ? readJsonFile(path.join(memberPath, 'config.json'), null) : null,
    });
  }
  const residue = classifyMemberResidue(memberEntries, teamId);
  const { existingMembers } = residue;

  // One shared decision (with the non-streaming handler) — a config-less /
  // provisioning-stub leftover is an adoptable orphan, not a collision, so a
  // partial rollback can never deadlock a same-id retry into extend mode.
  const decision = decideTeamCreate({ mode, teamExists, teamIdTakenByOther, residue });
  if (decision.type === 'conflict-team') {
    return fail(409,
      `Cannot use teamId '${teamId}': an agent with this id already exists ` +
      `with role '${existingTeamCfg.role}'. Pick a different teamId or delete ` +
      `the existing agent first.`);
  }
  if (decision.type === 'conflict-members') {
    const list = decision.members.map(m => `${m.memberId} (role '${m.role}')`).join(', ');
    return fail(409,
      `Cannot create team '${teamId}': the id(s) ${list} already belong to ` +
      `unrelated agent(s). Pick a different teamId or delete the existing agent(s) first.`);
  }
  if (decision.type === 'extend-missing-team') {
    return fail(409, `Cannot extend: team '${teamId}' does not exist yet. Use mode: "create" first.`);
  }
  if (decision.type === 'collision') {
    // Real collision = a genuine team or member exists. An ENV-ONLY orphan is
    // a different beast (adopted below); a config-less agent-dir orphan is now
    // adopted too, so this only fires for an actual working team.
    emit({
      type: 'collision',
      existing: {
        env: envExists ? envId : null,
        team: teamExists ? teamAgentId : null,
        members: decision.existingMembers,
      },
      suggestion: 'Pass `mode: "extend"` to add only the missing roles.',
    });
    return res.end();
  }

  // decision.type === 'proceed' — leftover orphan dirs to clean before create.
  const orphansToClean = decision.orphansToClean;
  let toCreate;
  if (mode === 'extend') {
    // Extending an existing team is Team-Admin-only (#2081) — see the twin in
    // `POST /api/teams` for why. `fail()` rather than `res.status()`: this
    // handler has already opened the NDJSON stream.
    if (!canManageAgent(getScope(req), agentMetaForScope(existingTeamCfg))) {
      return fail(403, 'You may not extend this team');
    }
    // Enforce suffix consistency on extend — mirror the non-streaming handler.
    const storedSuffix = existingTeamCfg.labelSuffix || '';
    if (labelSuffix !== storedSuffix) {
      return fail(400,
        `labelSuffix mismatch: team '${teamId}' was created with suffix '${storedSuffix || '(none)'}'; ` +
        `extending it with '${labelSuffix || '(none)'}' would create mismatched labels.`);
    }
    toCreate = planned.filter(p => !existingMembers.includes(p.memberId));
    if (toCreate.length === 0) {
      emit({
        type: 'complete',
        result: {
          teamId, teamName,
          created: [],
          skipped: planned.map(p => p.memberId),
          message: 'All requested roles already exist on this team; nothing to do.',
        },
      });
      return res.end();
    }
  } else {
    toCreate = planned;
  }

  // ── 3. Substitution variables for templates ───────────────────────
  // When the team includes a Dispatcher, the Developer is wired to react
  // to the dispatch label. Without a Dispatcher, `{{dispatchLabel}}` falls
  // back to the ready label so the Developer still works on bare `ready`-
  // labeled issues (legacy single-stage flow).
  const hasDispatcher = normalizedRoles.some(r => r.id === 'dispatcher');
  const effectiveDispatchLabel = hasDispatcher ? dispatchLabel : readyLabel;
  const vars = {
    teamName, teamId,
    ...repoVars(parsed, repository?.url),
    branch, readyLabel,
    dispatchLabel: effectiveDispatchLabel,
    maxParallel,
  };

  // Adopt-orphan: in mode:create the env may already exist as a leftover
  // (no team, no members). Treat it as a step we own — overwrite with the
  // user's submitted settings and include it in the rollback set. A
  // deliberately reused env (environmentId) is never overwritten.
  const adoptOrphanEnv = mode === 'create' && envExists && !environmentId;

  // ── 4. Announce the plan up front so the wizard can render every
  // step as `pending` — gives the user the full progress shape, not a
  // tickertape that only reveals work as it happens.
  const plan = [];
  if (orphansToClean.length) {
    plan.push({ id: 'cleanup', label: `Clean up ${orphansToClean.length} leftover agent director${orphansToClean.length === 1 ? 'y' : 'ies'}` });
  }
  if (!envExists || adoptOrphanEnv) {
    plan.push({
      id: 'env',
      label: adoptOrphanEnv
        ? `Reuse working environment (${envId})`
        : `Create working environment (${envId})`,
    });
  }
  if (!teamExists) plan.push({ id: 'team', label: `Create team agent (${teamAgentId})` });
  for (const p of toCreate) {
    // Say which mode the step runs in (#1955 AC4) — a stub create writes config
    // + triggers only, so labelling it the same as a full materialization would
    // claim a Matrix user, a clone and a container that never happen.
    plan.push({
      id: `member:${p.memberId}`,
      label: materializeMembers
        ? `Create member: ${p.template.displayName}`
        : `Create member (stub): ${p.template.displayName}`,
    });
  }
  if (knowledgeConfigPatch) plan.push({ id: 'knowledge', label: 'Apply knowledge-learning settings' });
  // No DM phase for stub members — they have no Matrix user yet (#1955), so the
  // step is neither planned nor run rather than announced and silently skipped.
  if (toCreate.length > 0 && materializeMembers) plan.push({ id: 'dms', label: 'Prepare agent conversations' });
  emit({ type: 'plan', steps: plan });

  // ── 5. Atomic create with rollback ────────────────────────────────
  const created = { env: null, team: null, members: [], dms: [] };
  const orchestratorUrl = process.env.ORCHESTRATOR_URL || 'http://orchestrator:4002';

  // A rollback that could not delete something must be LOUD (#1525 AC3): a
  // silent partial rollback is what leaves the invisible residue in the first
  // place. Surface a failed cleanup as a warning event naming the leftover id
  // (and log it) instead of reporting success.
  const rollbackDelete = async (id, kind) => {
    const warn = (detail) => {
      console.error(`[Team:stream] Rollback: failed to delete ${kind} ${id}: ${detail}`);
      emit({
        type: 'warning',
        message: `Rollback could not remove ${kind} '${id}' (${detail}) — a leftover ` +
          `directory may remain under /workspace/agents/. A same-id retry will clean it up automatically.`,
      });
    };
    try {
      const resp = await fetch(`${orchestratorUrl}/internal/agents/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (!resp.ok && resp.status !== 404) {
        const data = await resp.json().catch(() => ({}));
        warn(data.error || `HTTP ${resp.status}`);
      }
    } catch (err) {
      warn(err.message);
    }
  };

  const rollback = async (reason) => {
    console.warn(`[Team:stream] Rolling back ${teamId}: ${reason}`);
    for (const memberId of [...created.members].reverse()) {
      await rollbackDelete(memberId, 'member');
    }
    if (created.team) {
      await rollbackDelete(created.team, 'team');
    }
    if (created.env) {
      try {
        // created.env is envId (TEAM_ID_RE / normalizeEnvId), but CodeQL's
        // js/path-injection query doesn't recognise those as barriers; contain
        // it under ENVIRONMENTS_DIR with the path.resolve + path.relative
        // idiom (mirrors the non-streaming handler's rollback) before rmSync.
        const environmentsRoot = path.resolve(ENVIRONMENTS_DIR);
        const envPath = path.resolve(environmentsRoot, String(created.env));
        const rel = path.relative(environmentsRoot, envPath);
        if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
          fs.rmSync(envPath, { recursive: true, force: true });
        } else {
          console.error(`[Team:stream] Rollback: refused to delete env outside root: ${created.env}`);
        }
      } catch (err) {
        console.error(`[Team:stream] Rollback: failed to delete env ${created.env}: ${err.message}`);
      }
    }
  };

  try {
    // Phase 0 — adopt orphans. Config-less / provisioning-stub leftover dirs
    // (a prior aborted create) are deleted through the same audited choke-point
    // as any agent delete, so a same-id `create` retry starts from a clean
    // slate instead of colliding with dead residue (#1525). Not tracked in the
    // rollback set: they were garbage before this request touched them.
    if (orphansToClean.length) {
      emit({ type: 'step', id: 'cleanup', status: 'running' });
      for (const orphanId of orphansToClean) {
        const resp = await fetch(`${orchestratorUrl}/internal/agents/${encodeURIComponent(orphanId)}`, { method: 'DELETE' });
        if (!resp.ok && resp.status !== 404) {
          const data = await resp.json().catch(() => ({}));
          throw new Error(`Cleanup of leftover '${orphanId}': ${data.error || `HTTP ${resp.status}`}`);
        }
      }
      emit({ type: 'step', id: 'cleanup', status: 'done' });
    }

    if (!envExists || adoptOrphanEnv) {
      emit({ type: 'step', id: 'env', status: 'running' });
      const env = {
        id: envId,
        name: teamName,
        description: `Working environment for team '${teamName}'.`,
        repositories: parsed ? [{ url: parsed.httpsUrl, branch, sshKeyId: repository.sshKeyId }] : [],
        githubTokenId,
        mcpServers: normalizedMcpServers,
        ...defaultLlmEndpointForTeam(),
        additionalContext: '',
        // Owned by the team it was auto-created for (#2081). Without this the
        // record carries no tier at all, which since #2078 dropped the
        // `|| 'default'` fallback makes it invisible to everyone but a System
        // Admin — including the human who just created the team.
        ...creatorEnvironmentOwnership(teamAgentId),
        createdAt: new Date().toISOString(),
      };
      saveEnvironment(envId, env);
      created.env = envId;
      emit({ type: 'step', id: 'env', status: 'done' });
    }

    if (!teamExists) {
      emit({ type: 'step', id: 'team', status: 'running' });
      const teamPrompt = defaultTeamPrompt(vars);
      const resp = await fetch(`${orchestratorUrl}/internal/agents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: teamAgentId,
          displayName: teamName,
          role: 'team',
          systemPrompt: teamPrompt,
          environmentId: envId,
          skipFirstMember: true,
          // The team's ACTIVE skill set (team-owned grant) — inherited by
          // every member without a skillsOverride.
          skills: initialSkills,
          // Ordered stage names for the process graph's layered layout.
          ...(bundleStages.length ? { stages: bundleStages } : {}),
          // Named human roles (#987) — held on the team agent like stages/labels.
          ...(bundleHumans.length ? { humans: bundleHumans } : {}),
          // Hill-climb collector config (#1222) — held on the team agent like stages.
          ...(bundleHillClimb ? { hillClimb: bundleHillClimb } : {}),
          // Admission control (#2114) — held on the team agent like hillClimb.
          ...(bundleWipLimit ? { wipLimit: bundleWipLimit } : {}),
          // Authoritative gate/brake label registry (#928) — see the sibling
          // materialise path; the live graph reads it back off the team agent.
          ...(bundleLabels.length ? { labels: bundleLabels } : {}),
          // Label suffix (#902) — see the non-streaming handler.
          ...(labelSuffix ? { labelSuffix } : {}),
          // Human owner (#2077, D8) — the authenticated creator of the team.
          ...ownerFor(req),
        }),
      });
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}));
        throw new Error(`Team agent ${teamAgentId}: ${data.error || `HTTP ${resp.status}`}`);
      }
      created.team = teamAgentId;
      // The creator becomes this team's Team Admin, in the same operation
      // (#2081 AC1, #2041 D1). The `ownerId` stamped above is not enough on its
      // own: a `role: 'team'` agent IS its own access boundary, so
      // `visibleAgent`/`canManageAgent` take the membership branch and a
      // creator with no prior membership could not see the team they had just
      // made. `planCreatorMembership` is what keeps the two handlers writing it
      // under identical conditions — exactly once, and never on an extend.
      //
      // Fatal, not best-effort: "in the same operation" is the acceptance
      // criterion, and a team whose creator cannot see it is worse than no team
      // at all — the `catch` below rolls the whole create back.
      const creatorMembership = planCreatorMembership({
        userId: getScope(req).userId,
        teamAgentId,
        teamCreated: true,
      });
      if (creatorMembership) {
        const { status, data } = await callAdmin('POST', 'memberships', creatorMembership);
        if (status >= 400) {
          throw new Error(`Team admin membership for ${teamAgentId}: ${(data && data.error) || `HTTP ${status}`}`);
        }
      }
      emit({ type: 'step', id: 'team', status: 'done' });
    }

    for (const p of toCreate) {
      const stepId = `member:${p.memberId}`;
      emit({ type: 'step', id: stepId, status: 'running' });
      const memberVars = { ...vars, agentId: p.memberId };
      // Member display name is the role name only (optionally numbered for
      // multi-instance roles). The parent team name is intentionally NOT
      // prepended — UIs already group members under their team, so prefixing
      // would just duplicate the team name and make every label long.
      const memberDisplayName = p.instanceIndex !== null
        ? `${p.template.displayName} ${p.instanceIndex}`
        : p.template.displayName;
      // Same member-create body as the non-streaming endpoint + the Flow Editor
      // add-role-from-template (#586). `materialize` is threaded exactly as the
      // non-streaming handler does (#1955) — this is the request path both UI
      // surfaces use, so leaving it to the orchestrator default is what made the
      // Materialize dialog's checkbox inert.
      const memberBody = buildMemberFromTemplate(p.template, {
        teamId, memberId: p.memberId, memberDisplayName, vars: memberVars,
        materialize: materializeMembers,
      });
      const resp = await fetch(`${orchestratorUrl}/internal/teams/${encodeURIComponent(teamAgentId)}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(memberBody),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        emit({ type: 'step', id: stepId, status: 'error', error: data.error || `HTTP ${resp.status}` });
        throw new Error(`Member ${p.memberId}: ${data.error || `HTTP ${resp.status}`}`);
      }
      // The orchestrator's seedAgentWorkspace catches clone failures into a
      // `warnings` array rather than throwing, because some seed steps are
      // genuinely optional (skill copies, missing template files). For a
      // wizard-created team though, the repo IS load-bearing — an agent
      // without its repo is a mute box. Treat any clone warning as fatal
      // so the user gets a real error in the progress card and the
      // half-baked team gets rolled back, instead of a green "ready" with
      // empty workspaces. Inert in stub mode — a stub create never seeds a
      // workspace, so it returns no warnings; the clone happens at enable.
      const cloneWarning = (data.warnings || []).find(w => /^git clone /.test(w));
      if (cloneWarning) {
        emit({ type: 'step', id: stepId, status: 'error', error: cloneWarning });
        // Track the member so rollback removes its half-built state.
        created.members.push(p.memberId);
        throw new Error(`Member ${p.memberId}: ${cloneWarning}`);
      }
      created.members.push(p.memberId);
      emit({ type: 'step', id: stepId, status: 'done' });
    }

    // Re-derive direct-hand-off wiring against the members' materialised ids
    // (#2030) now that every member exists — see reconcileTeamHandoffWiring.
    await reconcileTeamHandoffWiring(teamAgentId);

    // Persist the wizard's knowledge-learning config (#567) — fatal, like the
    // clone check: falling back to defaults would violate AC-3. Only fires for a
    // non-default patch (AC-4) in create mode.
    if (knowledgeConfigPatch) {
      emit({ type: 'step', id: 'knowledge', status: 'running' });
      const kResp = await fetch(`${orchestratorUrl}/internal/knowledge/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ teamId, config: knowledgeConfigPatch }),
      });
      const kData = await kResp.json().catch(() => ({}));
      if (!kResp.ok || !kData.ok) {
        const msg = kData.error || `HTTP ${kResp.status}`;
        emit({ type: 'step', id: 'knowledge', status: 'error', error: msg });
        throw new Error(`knowledge config: ${msg}`);
      }
      emit({ type: 'step', id: 'knowledge', status: 'done' });
    }

    // DM rooms (best-effort). Skipped entirely for deferred (stub) members —
    // they have no Matrix user yet, so the room is created when the stub is
    // materialized and a chat is opened (#1955; mirrors the non-streaming path).
    if (toCreate.length > 0 && materializeMembers) {
      emit({ type: 'step', id: 'dms', status: 'running' });
      for (const p of toCreate) {
        try {
          const r = await ensureAgentDmRoom(p.memberId);
          created.dms.push({ agentId: p.memberId, roomId: r.roomId });
        } catch (err) {
          console.warn(`[Team:stream] DM pre-create skipped for ${p.memberId}: ${err.message}`);
        }
      }
      emit({ type: 'step', id: 'dms', status: 'done' });
    }

    // Emit any suffix coverage warnings as separate warning events before
    // the complete event so the wizard can render them in the result step.
    for (const w of suffixWarnings) {
      emit({ type: 'warning', message: w });
    }
    // Phase E — label provisioning (best-effort, before complete event).
    // Emit provisioning warnings as individual warning events so the wizard
    // result step can surface them inline.
    const provWarn = await provisionGithubLabels(orchestratorUrl, envId, suffixTokenSet, labelSuffix);
    for (const w of provWarn) {
      emit({ type: 'warning', message: w });
    }

    emit({
      type: 'complete',
      result: {
        teamId, teamName,
        env: envId,
        team: teamAgentId,
        created: created.members,
        // Which mode actually ran (#1955 AC4) — same key the non-streaming
        // handler echoes, so a caller reads it identically on both paths.
        materialized: materializeMembers,
        skipped: planned
          .filter(p => !toCreate.some(c => c.memberId === p.memberId))
          .map(p => p.memberId),
        dms: created.dms,
        ...(suffixWarnings.length ? { warnings: [...suffixWarnings, ...provWarn] } : (provWarn.length ? { warnings: provWarn } : {})),
      },
    });
    res.end();
  } catch (err) {
    await rollback(err.message);
    emit({ type: 'error', status: 500, error: `Team creation failed: ${err.message}` });
    if (!aborted) res.end();
  }
});

/* ─── Blueprints ────────────────────────────────────────────────────── */

app.get('/api/blueprints', apiLimiter, async (req, res) => {
  const orchestratorUrl = process.env.ORCHESTRATOR_URL || 'http://orchestrator:4002';
  try {
    const resp = await fetch(`${orchestratorUrl}/internal/blueprints`);
    const data = await resp.json();
    res.status(resp.status).json(data);
  } catch (err) {
    res.status(502).json({ error: `Orchestrator unreachable: ${err.message}` });
  }
});

app.post('/api/blueprints', heavyLimiter, async (req, res) => {
  const { id, displayName, role, systemPrompt, environmentId } = req.body || {};
  if (!id || !displayName || !role || !environmentId) {
    return res.status(400).json({ error: 'id, displayName, role, environmentId required' });
  }
  // Teams may be created without a default prompt — members can carry their
  // own per-role prompts, and the orchestrator stores an empty template.
  if (!systemPrompt && role !== 'team') {
    return res.status(400).json({ error: 'systemPrompt is required for every role except team' });
  }
  const orchestratorUrl = process.env.ORCHESTRATOR_URL || 'http://orchestrator:4002';
  try {
    const resp = await fetch(`${orchestratorUrl}/internal/blueprints`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, displayName, role, systemPrompt, environmentId }),
    });
    const data = await resp.json();
    res.status(resp.status).json(data);
  } catch (err) {
    res.status(502).json({ error: `Orchestrator unreachable: ${err.message}` });
  }
});

app.put('/api/blueprints/:id', apiLimiter, async (req, res) => {
  const { displayName, role, systemPrompt } = req.body || {};
  const orchestratorUrl = process.env.ORCHESTRATOR_URL || 'http://orchestrator:4002';
  try {
    const resp = await fetch(`${orchestratorUrl}/internal/blueprints/${encodeURIComponent(req.params.id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName, role, systemPrompt }),
    });
    const data = await resp.json();
    res.status(resp.status).json(data);
  } catch (err) {
    res.status(502).json({ error: `Orchestrator unreachable: ${err.message}` });
  }
});

app.delete('/api/blueprints/:id', apiLimiter, async (req, res) => {
  const orchestratorUrl = process.env.ORCHESTRATOR_URL || 'http://orchestrator:4002';
  try {
    const resp = await fetch(`${orchestratorUrl}/internal/blueprints/${encodeURIComponent(req.params.id)}`, {
      method: 'DELETE',
    });
    if (resp.status === 200 || resp.status === 204) return res.status(204).end();
    const data = await resp.json().catch(() => ({}));
    res.status(resp.status).json(data);
  } catch (err) {
    res.status(502).json({ error: `Orchestrator unreachable: ${err.message}` });
  }
});

app.post('/api/blueprints/:id/instances', heavyLimiter, async (req, res) => {
  const { instanceId, displayName } = req.body || {};
  if (!instanceId || !displayName) {
    return res.status(400).json({ error: 'instanceId and displayName required' });
  }
  const bpId = req.params.id;
  if (!BP_PARAM_RE.test(bpId)) return res.status(400).json({ error: 'invalid blueprint id' });
  const normalizedId = instanceId.toLowerCase().replace(/[^a-z0-9-]/g, '');
  if (!normalizedId) {
    return res.status(400).json({ error: 'instanceId must contain at least one valid character (a-z, 0-9, -)' });
  }
  const orchestratorUrl = process.env.ORCHESTRATOR_URL || 'http://orchestrator:4002';
  try {
    const resp = await fetch(
      `${orchestratorUrl}/internal/blueprints/${encodeURIComponent(bpId)}/instances`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instanceId: normalizedId, displayName }),
      }
    );
    const data = await resp.json();
    res.status(resp.status).json(data);
  } catch (err) {
    res.status(502).json({ error: `Orchestrator unreachable: ${err.message}` });
  }
});

app.get('/api/blueprints/:id/memory/:file', apiLimiter, async (req, res) => {
  const bpId = req.params.id;
  const bpFile = req.params.file;
  if (!BP_PARAM_RE.test(bpId) || !BP_FILE_RE.test(bpFile)) {
    return res.status(400).json({ error: 'invalid blueprint id or file' });
  }
  const orchestratorUrl = process.env.ORCHESTRATOR_URL || 'http://orchestrator:4002';
  try {
    const resp = await fetch(
      `${orchestratorUrl}/internal/blueprints/${encodeURIComponent(bpId)}/memory/${encodeURIComponent(bpFile)}`
    );
    if (!resp.ok) return res.status(resp.status).json({ error: 'Not found' });
    const content = await resp.text();
    res.json({ content });
  } catch (err) {
    res.status(502).json({ error: `Orchestrator unreachable: ${err.message}` });
  }
});

app.put('/api/blueprints/:id/memory/:file', apiLimiter, express.text({ type: '*/*' }), async (req, res) => {
  const bpId = req.params.id;
  const bpFile = req.params.file;
  if (!BP_PARAM_RE.test(bpId) || !BP_FILE_RE.test(bpFile)) {
    return res.status(400).json({ error: 'invalid blueprint id or file' });
  }
  const orchestratorUrl = process.env.ORCHESTRATOR_URL || 'http://orchestrator:4002';
  try {
    const resp = await fetch(
      `${orchestratorUrl}/internal/blueprints/${encodeURIComponent(bpId)}/memory/${encodeURIComponent(bpFile)}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'text/plain' },
        body: typeof req.body === 'string' ? req.body : JSON.stringify(req.body),
      }
    );
    const data = await resp.json().catch(() => ({}));
    res.status(resp.status).json(data);
  } catch (err) {
    res.status(502).json({ error: `Orchestrator unreachable: ${err.message}` });
  }
});

/* ─── SSH Keys ──────────────────────────────────────────────────────── */

app.get('/api/ssh-keys', (req, res) => {
  // Return only metadata — never the private key. Scoped to the caller (#798):
  // Team Admins see system credentials assigned to a team they administer plus
  // team credentials they own; System Admins see all.
  const scope = getScope(req);
  res.json(listSshKeys().map(normalizeCredential).filter(k => visibleCredential(scope, k)));
});

app.post('/api/ssh-keys', apiLimiter, (req, res) => {
  const { name, privateKey, id: rawId } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name is required' });
  if (!privateKey || typeof privateKey !== 'string') {
    return res.status(400).json({ error: 'privateKey (string) is required' });
  }
  const scope = getScope(req);
  let ownership;
  try { ownership = resolveCredentialOwnership(req.body, scope.userId); }
  catch (err) { return res.status(err.status || 400).json({ error: err.message }); }
  if (!canCreateCredential(scope, ownership)) {
    return res.status(403).json({ error: 'forbidden: you may not create this credential', code: 'forbidden' });
  }
  const trimmed = privateKey.trim();
  if (!/-----BEGIN [A-Z ]+PRIVATE KEY-----/.test(trimmed)) {
    return res.status(400).json({ error: 'privateKey does not look like an SSH private key' });
  }

  const existing = listSshKeys();
  let id;
  if (rawId !== undefined && rawId !== null && String(rawId).trim() !== '') {
    id = String(rawId).trim();
    if (!SSH_KEY_ID_RE.test(id)) return res.status(400).json({ error: 'id must contain lowercase letters, digits and hyphens only' });
    if (existing.some(k => k.id === id)) return res.status(409).json({ error: `SSH key id '${id}' already exists` });
  } else {
    // Generate a stable, filesystem-safe id from the name
    const baseId = name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    id = baseId || `key-${Date.now()}`;
    if (existing.some(k => k.id === id)) {
      id = `${id}-${Date.now().toString(36)}`;
    }
  }
  // Re-check the derived id against the strict allowlist — the .replace
  // chain above is correct, but the explicit regex test is what CodeQL
  // recognises as a path-injection sanitizer.
  if (!SSH_KEY_ID_RE.test(id)) return res.status(400).json({ error: 'Invalid ssh key id' });

  const keyPath = path.join(SSH_KEYS_DIR, path.basename(id));
  fs.writeFileSync(keyPath, trimmed.endsWith('\n') ? trimmed : trimmed + '\n', { mode: 0o600 });
  try { fs.chmodSync(keyPath, 0o600); } catch { /* best effort */ }

  const entry = {
    id,
    name,
    scope: ownership.scope,
    teamId: ownership.teamId,
    assignedTeamIds: ownership.assignedTeamIds,
    ...(ownership.userId ? { userId: ownership.userId } : {}),
    fingerprint: sshKeyFingerprint(trimmed),
    createdAt: new Date().toISOString(),
  };
  saveSshKeysIndex([...existing, entry]);
  // Setting a personal credential also propagates to the owner's running agents
  // (#1570 Phase 4) — a no-op for a team/system credential (falsy userId).
  if (entry.scope === 'personal') notifyOwnerCredentialChange(entry.userId, 'personal-ssh-key-set');
  res.status(201).json(normalizeCredential(entry));
});

// Server-side keypair generation. Returns the public key once so the user
// can paste it into GitHub; the private key never leaves the workspace.
app.post('/api/ssh-keys/generate', heavyLimiter, (req, res) => {
  const { name, comment, id: rawId } = req.body || {};
  if (!name || typeof name !== 'string') {
    return res.status(400).json({ error: 'name is required' });
  }
  const scope = getScope(req);
  let ownership;
  try { ownership = resolveCredentialOwnership(req.body, scope.userId); }
  catch (err) { return res.status(err.status || 400).json({ error: err.message }); }
  if (!canCreateCredential(scope, ownership)) {
    return res.status(403).json({ error: 'forbidden: you may not create this credential', code: 'forbidden' });
  }
  const existing = listSshKeys();
  let id;
  if (rawId !== undefined && rawId !== null && String(rawId).trim() !== '') {
    id = String(rawId).trim();
    if (!SSH_KEY_ID_RE.test(id)) return res.status(400).json({ error: 'id must contain lowercase letters, digits and hyphens only' });
    if (existing.some(k => k.id === id)) return res.status(409).json({ error: `SSH key id '${id}' already exists` });
  } else {
    const baseId = name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    id = baseId || `key-${Date.now()}`;
    if (existing.some(k => k.id === id)) {
      id = `${id}-${Date.now().toString(36)}`;
    }
  }

  const safeComment = (typeof comment === 'string' && comment.trim()) || `aee-${id}`;
  const { privateKey: privText, publicKey: pubText, pubBlob } = generateOpensshEd25519Keypair(safeComment);

  // Inline regex test directly before path.join so CodeQL recognises the
  // path-injection sanitizer (same pattern as POST /api/ssh-keys above).
  if (!SSH_KEY_ID_RE.test(id)) return res.status(400).json({ error: 'Invalid ssh key id' });
  const keyPath = path.join(SSH_KEYS_DIR, path.basename(id));
  fs.writeFileSync(keyPath, privText, { mode: 0o600 });
  try { fs.chmodSync(keyPath, 0o600); } catch { /* best effort */ }

  const entry = {
    id,
    name,
    scope: ownership.scope,
    teamId: ownership.teamId,
    assignedTeamIds: ownership.assignedTeamIds,
    ...(ownership.userId ? { userId: ownership.userId } : {}),
    fingerprint: sshFingerprintFromPubBlob(pubBlob),
    createdAt: new Date().toISOString(),
  };
  saveSshKeysIndex([...existing, entry]);
  // Setting a personal credential also propagates to the owner's running agents
  // (#1570 Phase 4) — a no-op for a team/system credential (falsy userId).
  if (entry.scope === 'personal') notifyOwnerCredentialChange(entry.userId, 'personal-ssh-key-set');
  res.status(201).json({ ...normalizeCredential(entry), publicKey: pubText });
});

// Reassign / rename an SSH key (#798). Renaming a team-scoped key is available
// to that team's Team Admins; changing scope or team assignment (incl. a
// cross-team move) is System-Admin only. A move that would leave a referencing
// environment unable to see the key is refused (409) rather than orphaning it.
app.patch('/api/ssh-keys/:id', apiLimiter, (req, res) => {
  const { id } = req.params;
  if (!SSH_KEY_ID_RE.test(id)) return res.status(400).json({ error: 'Invalid ssh key id' });
  const scope = getScope(req);
  const keys = listSshKeys();
  const cred = keys.find(k => k.id === id);
  if (!cred) return res.status(404).json({ error: 'SSH key not found' });
  if (!canManageCredential(scope, cred)) {
    return res.status(403).json({ error: 'forbidden: you may not manage this credential', code: 'forbidden' });
  }
  const updated = applyCredentialPatch({ res, cred, scope, body: req.body, inUse: sshKeyInUse(id), label: 'SSH key' });
  if (!updated) return; // applyCredentialPatch already sent the error
  saveSshKeysIndex(keys.map(k => (k.id === id ? updated : k)));
  res.json(normalizeCredential(updated));
});

app.delete('/api/ssh-keys/:id', apiLimiter, (req, res) => {
  const { id } = req.params;
  if (!SSH_KEY_ID_RE.test(id)) return res.status(400).json({ error: 'Invalid ssh key id' });
  const scope = getScope(req);
  const keys = listSshKeys();
  const cred = keys.find(k => k.id === id);
  if (!cred) return res.status(404).json({ error: 'SSH key not found' });
  if (!canManageCredential(scope, cred)) {
    return res.status(403).json({ error: 'forbidden: you may not manage this credential', code: 'forbidden' });
  }
  const usedBy = sshKeyInUse(id);
  if (usedBy) {
    return res.status(409).json({ error: `SSH key is used by environment '${usedBy}'. Detach it first.` });
  }
  try { fs.unlinkSync(path.join(SSH_KEYS_DIR, path.basename(id))); } catch { /* ignore */ }
  saveSshKeysIndex(keys.filter(k => k.id !== id));
  res.status(204).end();
});

// Rotate a PERSONAL SSH key in place (#1568 AC4): replace the stored private key
// — pasted or server-generated — while keeping the same credential id, name and
// owner. Personal-tier ONLY: a team/system key is deliberately rotated by
// creating a new credential and repointing the environment (see the admin page
// copy), so an in-place secret swap that silently changes what many agents use
// is refused here. Owner-gated via canManageCredential — the personal tier has
// no scope.all bypass, so not even a System Admin can rotate someone else's key.
app.post('/api/ssh-keys/:id/rotate', heavyLimiter, (req, res) => {
  const { id } = req.params;
  if (!SSH_KEY_ID_RE.test(id)) return res.status(400).json({ error: 'Invalid ssh key id' });
  const scope = getScope(req);
  const keys = listSshKeys();
  const cred = keys.find(k => k.id === id);
  if (!cred) return res.status(404).json({ error: 'SSH key not found' });
  if (normalizeCredential(cred).scope !== 'personal') {
    return res.status(400).json({
      error: 'Only a personal SSH key can be rotated in place; rotate a team/system key by creating a new one and repointing the environment.',
      code: 'rotate-personal-only',
    });
  }
  if (!canManageCredential(scope, cred)) {
    return res.status(403).json({ error: 'forbidden: you may not manage this credential', code: 'forbidden' });
  }

  const { privateKey, generate, comment } = req.body || {};
  // Re-assert the strict id allowlist directly before the fs sink so CodeQL
  // recognises the path-injection sanitizer (same pattern as the create routes).
  if (!SSH_KEY_ID_RE.test(id)) return res.status(400).json({ error: 'Invalid ssh key id' });
  const keyPath = path.join(SSH_KEYS_DIR, path.basename(id));

  let fingerprint, publicKey;
  if (generate) {
    const safeComment = (typeof comment === 'string' && comment.trim()) || `aee-${id}`;
    const { privateKey: privText, publicKey: pubText, pubBlob } = generateOpensshEd25519Keypair(safeComment);
    fs.writeFileSync(keyPath, privText, { mode: 0o600 });
    try { fs.chmodSync(keyPath, 0o600); } catch { /* best effort */ }
    fingerprint = sshFingerprintFromPubBlob(pubBlob);
    publicKey = pubText;
  } else {
    if (!privateKey || typeof privateKey !== 'string') {
      return res.status(400).json({ error: 'privateKey (string) is required, or set generate:true' });
    }
    const trimmed = privateKey.trim();
    if (!/-----BEGIN [A-Z ]+PRIVATE KEY-----/.test(trimmed)) {
      return res.status(400).json({ error: 'privateKey does not look like an SSH private key' });
    }
    fs.writeFileSync(keyPath, trimmed.endsWith('\n') ? trimmed : trimmed + '\n', { mode: 0o600 });
    try { fs.chmodSync(keyPath, 0o600); } catch { /* best effort */ }
    fingerprint = sshKeyFingerprint(trimmed);
  }

  const updated = { ...cred, fingerprint, rotatedAt: new Date().toISOString() };
  saveSshKeysIndex(keys.map(k => (k.id === id ? updated : k)));
  // Propagate the rotated secret to the owner's running agents (#1570 Phase 4).
  notifyOwnerCredentialChange(updated.userId, 'personal-ssh-key-rotated');
  const body = normalizeCredential(updated);
  res.status(200).json(publicKey ? { ...body, publicKey } : body);
});

/* ─── GitHub Tokens ─────────────────────────────────────────────────── */

app.get('/api/github-tokens', (req, res) => {
  // Metadata only — never the raw token. Caller-scoped (#798), same model as
  // SSH keys: Team Admins see system tokens assigned to a team they administer
  // plus team tokens they own; System Admins see all.
  const scope = getScope(req);
  res.json(listGithubTokens().map(normalizeCredential).filter(t => visibleCredential(scope, t)));
});

app.post('/api/github-tokens', apiLimiter, (req, res) => {
  const { name, token, id: rawId } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name is required' });
  if (!token || typeof token !== 'string') {
    return res.status(400).json({ error: 'token (string) is required' });
  }
  const scope = getScope(req);
  let ownership;
  try { ownership = resolveCredentialOwnership(req.body, scope.userId); }
  catch (err) { return res.status(err.status || 400).json({ error: err.message }); }
  if (!canCreateCredential(scope, ownership)) {
    return res.status(403).json({ error: 'forbidden: you may not create this credential', code: 'forbidden' });
  }
  const trimmed = token.trim();
  if (!/^(github_pat_|ghp_|gho_|ghs_|ghu_|ghr_)[A-Za-z0-9_]{20,}$/.test(trimmed)) {
    return res.status(400).json({
      error: "token does not look like a GitHub token (expected prefix github_pat_, ghp_, gho_, ghs_, ghu_ or ghr_)",
    });
  }

  const existing = listGithubTokens();
  let id;
  if (rawId !== undefined && rawId !== null && String(rawId).trim() !== '') {
    id = String(rawId).trim();
    if (!GH_TOKEN_ID_RE.test(id)) return res.status(400).json({ error: 'id must contain lowercase letters, digits and hyphens only' });
    if (existing.some(t => t.id === id)) return res.status(409).json({ error: `GitHub token id '${id}' already exists` });
  } else {
    const baseId = name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    id = baseId || `token-${Date.now()}`;
    if (existing.some(t => t.id === id)) {
      id = `${id}-${Date.now().toString(36)}`;
    }
  }
  if (!GH_TOKEN_ID_RE.test(id)) return res.status(400).json({ error: 'Invalid token id' });

  const tokenPath = path.join(GH_TOKENS_DIR, path.basename(id));
  fs.writeFileSync(tokenPath, trimmed, { mode: 0o600 });
  try { fs.chmodSync(tokenPath, 0o600); } catch { /* best effort */ }

  const entry = {
    id,
    name,
    scope: ownership.scope,
    teamId: ownership.teamId,
    assignedTeamIds: ownership.assignedTeamIds,
    ...(ownership.userId ? { userId: ownership.userId } : {}),
    preview: githubTokenPreview(trimmed),
    fingerprint: githubTokenFingerprint(trimmed),
    createdAt: new Date().toISOString(),
  };
  saveGithubTokensIndex([...existing, entry]);
  // Setting a personal credential also propagates to the owner's running agents
  // (#1570 Phase 4) — a no-op for a team/system credential (falsy userId).
  if (entry.scope === 'personal') notifyOwnerCredentialChange(entry.userId, 'personal-github-token-set');
  res.status(201).json(normalizeCredential(entry));
});

// Reassign / rename a GitHub token (#798) — same role model as SSH keys above.
app.patch('/api/github-tokens/:id', apiLimiter, (req, res) => {
  const { id } = req.params;
  if (!GH_TOKEN_ID_RE.test(id)) return res.status(400).json({ error: 'Invalid token id' });
  const scope = getScope(req);
  const tokens = listGithubTokens();
  const cred = tokens.find(t => t.id === id);
  if (!cred) return res.status(404).json({ error: 'GitHub token not found' });
  if (!canManageCredential(scope, cred)) {
    return res.status(403).json({ error: 'forbidden: you may not manage this credential', code: 'forbidden' });
  }
  const updated = applyCredentialPatch({ res, cred, scope, body: req.body, inUse: githubTokenInUse(id), label: 'GitHub token' });
  if (!updated) return;
  saveGithubTokensIndex(tokens.map(t => (t.id === id ? updated : t)));
  res.json(normalizeCredential(updated));
});

app.delete('/api/github-tokens/:id', apiLimiter, (req, res) => {
  const { id } = req.params;
  if (!GH_TOKEN_ID_RE.test(id)) return res.status(400).json({ error: 'Invalid token id' });
  const scope = getScope(req);
  const tokens = listGithubTokens();
  const cred = tokens.find(t => t.id === id);
  if (!cred) return res.status(404).json({ error: 'GitHub token not found' });
  if (!canManageCredential(scope, cred)) {
    return res.status(403).json({ error: 'forbidden: you may not manage this credential', code: 'forbidden' });
  }
  const usedBy = githubTokenInUse(id);
  if (usedBy) {
    return res.status(409).json({ error: `GitHub token is used by environment '${usedBy}'. Detach it first.` });
  }
  try { fs.unlinkSync(path.join(GH_TOKENS_DIR, path.basename(id))); } catch { /* ignore */ }
  saveGithubTokensIndex(tokens.filter(t => t.id !== id));
  res.status(204).end();
});

// Rotate a PERSONAL GitHub token in place (#1568 AC4) — same model as the SSH
// rotate above: replace the stored secret, recompute preview + fingerprint, keep
// the id/name/owner. Personal-tier ONLY and owner-gated (no scope.all bypass).
app.post('/api/github-tokens/:id/rotate', apiLimiter, (req, res) => {
  const { id } = req.params;
  if (!GH_TOKEN_ID_RE.test(id)) return res.status(400).json({ error: 'Invalid token id' });
  const scope = getScope(req);
  const tokens = listGithubTokens();
  const cred = tokens.find(t => t.id === id);
  if (!cred) return res.status(404).json({ error: 'GitHub token not found' });
  if (normalizeCredential(cred).scope !== 'personal') {
    return res.status(400).json({
      error: 'Only a personal GitHub token can be rotated in place; rotate a team/system token by creating a new one and repointing the environment.',
      code: 'rotate-personal-only',
    });
  }
  if (!canManageCredential(scope, cred)) {
    return res.status(403).json({ error: 'forbidden: you may not manage this credential', code: 'forbidden' });
  }
  const { token } = req.body || {};
  if (!token || typeof token !== 'string') return res.status(400).json({ error: 'token (string) is required' });
  const trimmed = token.trim();
  if (!/^(github_pat_|ghp_|gho_|ghs_|ghu_|ghr_)[A-Za-z0-9_]{20,}$/.test(trimmed)) {
    return res.status(400).json({
      error: "token does not look like a GitHub token (expected prefix github_pat_, ghp_, gho_, ghs_, ghu_ or ghr_)",
    });
  }
  if (!GH_TOKEN_ID_RE.test(id)) return res.status(400).json({ error: 'Invalid token id' });
  const tokenPath = path.join(GH_TOKENS_DIR, path.basename(id));
  fs.writeFileSync(tokenPath, trimmed, { mode: 0o600 });
  try { fs.chmodSync(tokenPath, 0o600); } catch { /* best effort */ }
  const updated = {
    ...cred,
    preview: githubTokenPreview(trimmed),
    fingerprint: githubTokenFingerprint(trimmed),
    rotatedAt: new Date().toISOString(),
  };
  saveGithubTokensIndex(tokens.map(t => (t.id === id ? updated : t)));
  // Propagate the rotated secret to the owner's running agents (#1570 Phase 4).
  notifyOwnerCredentialChange(updated.userId, 'personal-github-token-rotated');
  res.status(200).json(normalizeCredential(updated));
});

/* ─── GitHub repo probe — wizard helper ───────────────────────────────
   POST /api/github/probe { url, githubTokenId } → { ok, repo, defaultBranch,
                                                     branches: [name, …] }
   Used by the Team-Setup wizard to (a) verify the URL is reachable with
   the picked token before the user commits to it, and (b) populate the
   branch dropdown with the repo's actual branches instead of a free-text
   field. Falls back to { ok: false, error } on parse / auth / 404 — the
   wizard surfaces that to the user. */

app.post('/api/github/probe', heavyLimiter, async (req, res) => {
  const { url, githubTokenId } = req.body || {};
  let parsed;
  try {
    parsed = parseGitHubUrl(url);
  } catch (err) {
    return res.json({ ok: false, error: err.message });
  }
  if (typeof githubTokenId !== 'string' || !GH_TOKEN_ID_RE.test(githubTokenId)) {
    return res.json({ ok: false, error: 'githubTokenId required' });
  }
  if (!listGithubTokens().some(t => t.id === githubTokenId)) {
    return res.json({ ok: false, error: `GitHub token '${githubTokenId}' not found` });
  }
  const safeTokenId = path.basename(githubTokenId);
  let token;
  try {
    token = fs.readFileSync(path.join(GH_TOKENS_DIR, safeTokenId), 'utf8').trim();
  } catch (err) {
    return res.json({ ok: false, error: `Cannot read token: ${err.message}` });
  }
  if (!token) return res.json({ ok: false, error: 'Token file is empty' });

  const headers = {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'agent-studio-wizard',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const apiBase = `${githubApiBase()}/repos/${encodeURIComponent(parsed.org)}/${encodeURIComponent(parsed.repo)}`;
  try {
    const repoResp = await fetch(apiBase, { headers });
    if (repoResp.status === 404) {
      return res.json({ ok: false, error: 'Repository not found (or token has no access).' });
    }
    if (repoResp.status === 401 || repoResp.status === 403) {
      return res.json({ ok: false, error: `GitHub auth failed (HTTP ${repoResp.status}). Check the token's scopes — needs at least repo:read.` });
    }
    if (!repoResp.ok) {
      return res.json({ ok: false, error: `GitHub API HTTP ${repoResp.status}` });
    }
    const repoMeta = await repoResp.json();

    // Pull up to 200 branches (2 pages of 100). Repos with more branches
    // than that don't fit a dropdown well anyway — surface a hint and let
    // the user type a name manually if they need a deeper one.
    const branches = [];
    let truncated = false;
    for (let page = 1; page <= 2; page++) {
      const r = await fetch(`${apiBase}/branches?per_page=100&page=${page}`, { headers });
      if (!r.ok) break;
      const list = await r.json();
      branches.push(...list.map(b => b.name));
      if (list.length < 100) break;
      if (page === 2 && list.length === 100) truncated = true;
    }
    return res.json({
      ok: true,
      repo: `${repoMeta.full_name}`,
      defaultBranch: repoMeta.default_branch,
      branches,
      truncated,
    });
  } catch (err) {
    return res.json({ ok: false, error: `Network: ${err.message}` });
  }
});

/* ─── Coordinator Workflow ──────────────────────────────────────────── */

/*
 * AC 1: Check whether .github/workflows/coordinator.yml exists in the target repo.
 * GET /api/repos/coordinator-workflow?repo=<owner>/<name>&githubTokenId=<id>
 * Returns { exists: true|false, sha: <sha if exists> }
 */
app.get('/api/repos/coordinator-workflow', coordinatorWorkflowLimiter, async (req, res) => {
  const { repo, githubTokenId } = req.query;
  if (typeof repo !== 'string' || !repo.includes('/')) {
    return res.status(400).json({ error: 'repo query param required (owner/name)' });
  }
  if (typeof githubTokenId !== 'string' || !GH_TOKEN_ID_RE.test(githubTokenId)) {
    return res.status(400).json({ error: 'githubTokenId query param required' });
  }
  if (!listGithubTokens().some(t => t.id === githubTokenId)) {
    return res.status(400).json({ error: `GitHub token '${githubTokenId}' not found` });
  }
  const safeTokenId = path.basename(githubTokenId);
  let token;
  try {
    token = fs.readFileSync(path.join(GH_TOKENS_DIR, safeTokenId), 'utf8').trim();
  } catch (err) {
    return res.status(500).json({ error: `Cannot read token: ${err.message}` });
  }
  const [owner, repoName] = repo.split('/');
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'agent-studio-wizard',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const url = `${githubApiBase()}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}/contents/.github/workflows/coordinator.yml`;
  try {
    const r = await fetch(url, { headers });
    if (r.status === 404) return res.json({ exists: false });
    if (!r.ok) return res.status(r.status).json({ error: `GitHub API HTTP ${r.status}` });
    const data = await r.json();
    return res.json({ exists: true, sha: data.sha });
  } catch (err) {
    return res.status(500).json({ error: `Network: ${err.message}` });
  }
});

/*
 * AC 3 / AC 5 / AC 6: Install (or update) the coordinator workflow in the target repo.
 * POST /api/repos/coordinator-workflow
 * Body: { repo: "owner/name", githubTokenId: "<id>" }
 * Commits .github/workflows/coordinator.yml via GitHub Contents API.
 */
app.post('/api/repos/coordinator-workflow', coordinatorWorkflowLimiter, async (req, res) => {
  const { repo, githubTokenId } = req.body || {};
  if (typeof repo !== 'string' || !repo.includes('/')) {
    return res.status(400).json({ error: 'repo required (owner/name)' });
  }
  if (typeof githubTokenId !== 'string' || !GH_TOKEN_ID_RE.test(githubTokenId)) {
    return res.status(400).json({ error: 'githubTokenId required' });
  }
  if (!listGithubTokens().some(t => t.id === githubTokenId)) {
    return res.status(400).json({ error: `GitHub token '${githubTokenId}' not found` });
  }
  const safeTokenId = path.basename(githubTokenId);
  let token;
  try {
    token = fs.readFileSync(path.join(GH_TOKENS_DIR, safeTokenId), 'utf8').trim();
  } catch (err) {
    return res.status(500).json({ error: `Cannot read token: ${err.message}` });
  }
  const [owner, repoName] = repo.split('/');
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'agent-studio-wizard',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const contentsUrl = `${githubApiBase()}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}/contents/.github/workflows/coordinator.yml`;

  // AC 5: Workflow content — functionally equivalent to #147 AC 2.
  const workflowYaml = `name: Multi-agent Coordinator

on:
  schedule:
    - cron: '*/5 * * * *'
  workflow_dispatch:

concurrency:
  group: coordinator
  cancel-in-progress: false

permissions:
  issues: write

env:
  ASSIGN_TIMEOUT_MINUTES: '10'

jobs:
  coordinate:
    runs-on: ubuntu-latest
    steps:
      - name: Assign bidders and recover timed-out assignments
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          REPO: \${{ github.repository }}
        run: |
          set -euo pipefail

          # ── Phase 1: Assign bidders ──────────────────────────────────────────
          bid_issues=$(gh issue list \\
            --repo "$REPO" \\
            --state open \\
            --json number,labels \\
            --limit 200 \\
            | jq -r '
                .[]
                | .number as $n
                | .labels[].name
                | select(test("^bid:"))
                | "\\($n)"
              ' | sort -u)

          for issue_num in $bid_issues; do
            current_labels=$(gh issue view "$issue_num" \\
              --repo "$REPO" \\
              --json labels \\
              | jq -r '.labels[].name')

            bid_labels=$(echo "$current_labels" | grep -E '^bid:' || true)
            if [[ -z "$bid_labels" ]]; then
              continue
            fi

            if echo "$current_labels" | grep -qE '^assigned:'; then
              continue
            fi

            chosen=$(echo "$bid_labels" | shuf -n 1)
            agent_id="\${chosen#bid:}"
            assigned_label="assigned:\${agent_id}"

            if ! gh label list \\
                --repo "$REPO" \\
                --json name \\
                --limit 500 \\
                | jq -r '.[].name' | grep -qxF "$assigned_label"; then
              gh label create "$assigned_label" \\
                --repo "$REPO" \\
                --color "0075ca" \\
                --description "Assigned to agent \${agent_id}" \\
                2>/dev/null || true
            fi

            gh issue edit "$issue_num" \\
              --repo "$REPO" \\
              --add-label "$assigned_label"

            while IFS= read -r bid; do
              gh issue edit "$issue_num" \\
                --repo "$REPO" \\
                --remove-label "$bid" \\
                2>/dev/null || true
            done <<< "$bid_labels"

            echo "Assigned issue #\${issue_num} to \${agent_id}"
          done

          # ── Phase 2: Timeout recovery ────────────────────────────────────────
          cutoff_ts=$(date -d "\${ASSIGN_TIMEOUT_MINUTES} minutes ago" --iso-8601=seconds)

          gh issue list \\
            --repo "$REPO" \\
            --state open \\
            --json number,labels,updatedAt \\
            --limit 200 \\
            | jq -r --arg cutoff "$cutoff_ts" '
                .[]
                | select(
                    (.labels | map(.name) | any(test("^assigned:")))
                    and (.labels | map(.name) | any(test("^started:")) | not)
                    and (.updatedAt <= $cutoff)
                  )
                | .number
              ' \\
            | while read -r issue_num; do
              assigned_label=$(gh issue view "$issue_num" \\
                --repo "$REPO" \\
                --json labels \\
                | jq -r '.labels[].name | select(test("^assigned:"))' \\
                | head -1)

              if [[ -z "$assigned_label" ]]; then
                continue
              fi

              agent_id="\${assigned_label#assigned:}"

              gh issue edit "$issue_num" \\
                --repo "$REPO" \\
                --remove-label "$assigned_label" \\
                2>/dev/null || true

              has_ready=$(gh issue view "$issue_num" \\
                --repo "$REPO" \\
                --json labels \\
                | jq -r '[.labels[].name] | any(. == "ready")' )
              if [[ "$has_ready" != "true" ]]; then
                gh issue edit "$issue_num" \\
                  --repo "$REPO" \\
                  --add-label "ready"
              fi

              gh issue comment "$issue_num" \\
                --repo "$REPO" \\
                --body "Assignment to \${agent_id} timed out — returned to ready pool."

              echo "Timeout recovery: issue #\${issue_num} (was assigned to \${agent_id})"
            done
`;

  const contentBase64 = Buffer.from(workflowYaml).toString('base64');

  // AC 6: Check for existing file sha (required for updates).
  let existingSha;
  try {
    const checkResp = await fetch(contentsUrl, { headers });
    if (checkResp.ok) {
      const existing = await checkResp.json();
      existingSha = existing.sha;
    } else if (checkResp.status !== 404) {
      return res.status(checkResp.status).json({ error: `GitHub API HTTP ${checkResp.status}` });
    }
  } catch (err) {
    return res.status(500).json({ error: `Network: ${err.message}` });
  }

  const commitMessage = existingSha ? 'Update agent coordinator workflow' : 'Add agent coordinator workflow';
  const putBody = {
    message: commitMessage,
    content: contentBase64,
    ...(existingSha ? { sha: existingSha } : {}),
  };

  try {
    const putResp = await fetch(contentsUrl, {
      method: 'PUT',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(putBody),
    });
    if (putResp.status === 403) {
      const shaFlag = existingSha ? ` -f sha=${existingSha}` : '';
      return res.status(403).json({
        error: 'The GitHub PAT does not have the `workflow` scope. Add this scope in GitHub → Settings → Developer settings → Personal access tokens, then retry.',
        manualCommand: `gh api --method PUT /repos/${repo}/contents/.github/workflows/coordinator.yml -f message="${commitMessage}" -f content="${contentBase64}"${shaFlag}`,
      });
    }
    if (putResp.status === 409) {
      return res.status(409).json({ error: 'File was updated concurrently — refresh and retry.' });
    }
    if (!putResp.ok) {
      const data = await putResp.json().catch(() => ({}));
      return res.status(putResp.status).json({ error: data.message || `GitHub API HTTP ${putResp.status}` });
    }
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: `Network: ${err.message}` });
  }
});

/* ─── Matrix Proxy ──────────────────────────────────────────────────── */

/*
 * REST + SSE proxy for the Conduwuit Matrix homeserver.
 *
 * Browser clients never see Matrix tokens. The admin user's token is read
 * from MATRIX_ACCESS_TOKEN; per-agent tokens come from /workspace/agents/<id>/config.json.
 *
 * Routes:
 *   GET    /api/matrix/agents[?includeDisabled=1][?includeStubs=1]  List agents with Matrix identities (enabled-only by default)
 *   POST   /api/matrix/agents/:agentId/dm              Idempotent create/get DM room
 *   GET    /api/matrix/rooms/:roomId/messages          Paginated history (proxy)
 *   POST   /api/matrix/rooms/:roomId/messages          Send m.text as admin
 *   DELETE /api/matrix/rooms/:roomId/messages          Redact all m.room.message events
 *   GET    /api/matrix/rooms/:roomId/stream            SSE long-poll on /sync filtered to room
 */

// 1. List agents that have Matrix identities.
//
// Enabled-only by default — that is what the chat has always shown. `?includeDisabled=1`
// additionally lists disabled (paused) agents so the chat's opt-in "show disabled
// agents" filter can offer Enable on them without a trip to the Agents page
// (#1928, epic #1925 decision D2). `?includeStubs=1` additionally lists **stub
// team members** — configuration only, never provisioned — so the rail can show
// a deferred-materialization team's members and materialize them from there
// (#1957); before that they were dropped unconditionally, which is why a team
// created with `materializeMembers: false` looked empty in the chat. Neither
// opt-in changes the default response (AC8), and the admission rule itself is
// the pure `matrix-agent-list.js`. Visibility scoping (#302) is unchanged, so an
// opt-in can only ever widen the list within what this caller may already see.
app.get('/api/matrix/agents', (req, res) => {
  const scope = getScope(req);
  const includeDisabled = req.query.includeDisabled === '1' || req.query.includeDisabled === 'true';
  const includeStubs = req.query.includeStubs === '1' || req.query.includeStubs === 'true';
  const ids = listAgentDirs();
  const out = [];
  for (const id of ids) {
    const cfg = readJsonFile(path.join(AGENTS_DIR, id, 'config.json'), null);
    if (!cfg) continue;
    if (!admitsToChatList(cfg, { includeDisabled, includeStubs })) continue;
    if (!visibleAgent(scope, agentMetaForScope(cfg))) continue; // team + visibility scoping (#302)
    const dm = matrix.getAgentDmRoom(id);
    const env = cfg.environmentId ? loadEnvironment(cfg.environmentId) : null;
    out.push({
      id,
      displayName: cfg.displayName || id,
      role: cfg.role || 'agent',
      userId: cfg.userId || `@${id}:local`,
      enabled: cfg.enabled !== false,
      // Whether the agent has ever been provisioned — never the token itself.
      // Shipped so the shared `agentState()` can tell "paused" from "stub" on
      // this payload too; since #1957 it is the field that *identifies* the stub
      // rows `?includeStubs=1` admits (it was always true before that).
      hasToken: !!cfg.token,
      // Whether THIS caller may run management actions on the agent — the same
      // boundary the mutating routes enforce (#989), so the chat's lifecycle
      // menu can disable what the server would reject (mirrors `canSwitch` on
      // GET /api/agents/:id/model).
      canManage: canManageAgent(scope, agentMetaForScope(cfg)),
      // Whether THIS caller may change the team's MEMBER LIST — the predicate
      // `POST`/`DELETE /api/admin/memberships` enforce, shipped so the Share
      // panel (#2082) can offer a read-only list instead of buttons that 403.
      // For a `role: 'team'` row `canManage` above happens to resolve to the
      // same thing (`agentMetaForScope().teamId === cfg.id`, so `canManageAgent`
      // falls through to `canManageTeam`), and that coincidence is exactly why
      // this is a separate field: a later change to the agent predicate must
      // not silently open the member list (#2041 §7.1). Only on team rows —
      // absent elsewhere, so a caller cannot read it as "not permitted".
      ...(cfg.role === 'team' ? { canManageTeam: canManageTeam(scope, id) } : {}),
      dmRoomId: dm?.roomId || null,
      environmentId: cfg.environmentId || null,
      environmentName: env?.name || cfg.environmentId || null,
      parentTeamId: cfg.parentTeamId || null,
      parentOrchestratorId: cfg.parentOrchestratorId || null,
    });
  }
  res.json(out);
});

// 2. Idempotent create-or-get DM room with an agent.
//
// Per-agent in-flight cache: concurrent POSTs for the same agent share one
// upstream `createRoom` call. Without this, two near-simultaneous requests
// (e.g. component re-mount, double-click, second tab) each see no
// dm-room.json, both create rooms, and one room ends up orphaned with the
// session log but no dm-room.json pointer.
const dmCreateInFlight = new Map();

async function ensureAgentDmRoom(agentId) {
  const cfgPath = path.join(AGENTS_DIR, agentId, 'config.json');
  const cfg = readJsonFile(cfgPath, null);
  if (!cfg) { const e = new Error('Agent not found'); e.status = 404; throw e; }
  if (cfg.enabled === false) { const e = new Error('Agent disabled'); e.status = 409; throw e; }
  if (!cfg.token) { const e = new Error('Agent has no Matrix token'); e.status = 409; throw e; }
  if (!matrix.ADMIN_TOKEN) { const e = new Error('MATRIX_ACCESS_TOKEN not configured'); e.status = 500; throw e; }

  // Reuse existing DM room if admin is still joined
  const existing = matrix.getAgentDmRoom(agentId);
  if (existing?.roomId) {
    const joined = await matrix.matrixFetch(matrix.ADMIN_TOKEN, '/_matrix/client/v3/joined_rooms');
    if (joined.status === 200 && Array.isArray(joined.data?.joined_rooms) &&
        joined.data.joined_rooms.includes(existing.roomId)) {
      return { roomId: existing.roomId, reused: true, created: false };
    }
    // Admin no longer joined — fall through and create a fresh room.
  }

  const adminUserId = await matrix.resolveAdminUserId();
  const createResp = await matrix.matrixFetch(cfg.token, '/_matrix/client/v3/createRoom', {
    method: 'POST',
    body: {
      preset: 'trusted_private_chat',
      invite: [adminUserId],
      is_direct: true,
      name: `DM with ${cfg.displayName || agentId}`,
    },
  });
  if (createResp.status >= 400) {
    console.error('[Matrix] createRoom failed:', createResp.status, createResp.data);
    const e = new Error('createRoom failed'); e.status = 502; e.upstream = createResp.data;
    throw e;
  }
  const roomId = createResp.data?.room_id;
  if (!roomId) {
    const e = new Error('createRoom returned no room_id'); e.status = 502; e.upstream = createResp.data;
    throw e;
  }

  // Admin (human) accepts the invite. We use a token, not a syncing client,
  // so auto-join doesn't happen — we explicitly POST /join.
  const joinResp = await matrix.matrixFetch(matrix.ADMIN_TOKEN,
    `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/join`,
    { method: 'POST', body: {} });
  if (joinResp.status >= 400) {
    console.error('[Matrix] admin join failed:', joinResp.status, joinResp.data);
    const e = new Error('admin join failed'); e.status = 502; e.upstream = joinResp.data;
    throw e;
  }

  matrix.setAgentDmRoom(agentId, {
    roomId,
    createdAt: new Date().toISOString(),
    createdBy: adminUserId,
  });
  // Nudge a running agent to re-pull dm-room.json now, so an isolated agent
  // learns its DM room for trigger/claim posts without waiting for the next
  // 60s sync (#185 Phase 2). No-op if the agent isn't running yet.
  notifyAgentReload(agentId);
  return { roomId, reused: false, created: true };
}

// Best-effort DM-room pre-creation. Called right after an agent is created or
// enabled so the 1:1 room — and the agent's own membership in it (the room is
// created with the agent's token, so the agent is its creator/member) — exists
// BEFORE the first user message. The agent's Matrix sync loop then already has
// the room in context and won't drop a message that races chat-open. Never
// fatal: a Matrix hiccup here must not fail the create/enable, and the lazy
// POST /api/matrix/agents/:id/dm path still creates the room on demand as a
// fallback when the user first opens the chat.
async function preCreateAgentDmRoom(agentId, context) {
  try {
    const r = await ensureAgentDmRoom(agentId);
    console.log(
      `[Matrix] Pre-created DM room for ${agentId} (${context}): ${r.roomId}` +
      `${r.reused ? ' (reused)' : ''}`,
    );
  } catch (err) {
    console.warn(`[Matrix] DM-room pre-create skipped for ${agentId} (${context}): ${err.message}`);
  }
}

app.post('/api/matrix/agents/:agentId/dm', heavyLimiter, async (req, res) => {
  const { agentId } = req.params;
  if (!AGENT_ID_RE.test(agentId)) return res.status(400).json({ error: 'Invalid agent id' });

  let promise = dmCreateInFlight.get(agentId);
  let leader = false;
  if (!promise) {
    leader = true;
    promise = ensureAgentDmRoom(agentId).finally(() => {
      dmCreateInFlight.delete(agentId);
    });
    dmCreateInFlight.set(agentId, promise);
  }

  try {
    const r = await promise;
    // Followers always report `reused: true` — they didn't drive the creation,
    // they just observed the leader's result.
    const status = leader && r.created ? 201 : 200;
    res.status(status).json({
      roomId: r.roomId,
      reused: leader ? r.reused : true,
    });
  } catch (err) {
    if (err.status) {
      const body = err.upstream ? { error: err.message, upstream: err.upstream } : { error: err.message };
      return res.status(err.status).json(body);
    }
    res.status(502).json({ error: `Chat service unreachable: ${err.message}` });
  }
});

// 3. Paginated message history (proxy)
app.get('/api/matrix/rooms/:roomId/messages', apiLimiter, async (req, res) => {
  if (!matrix.ADMIN_TOKEN) return res.status(500).json({ error: 'MATRIX_ACCESS_TOKEN not configured' });
  const { roomId } = req.params;
  const dir = req.query.dir === 'f' ? 'f' : 'b';
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  const query = { dir, limit };
  if (req.query.from) query.from = req.query.from;
  if (req.query.to) query.to = req.query.to;
  if (req.query.filter) query.filter = req.query.filter;

  try {
    const resp = await matrix.matrixFetch(matrix.ADMIN_TOKEN,
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages`,
      { query });
    res.status(resp.status).json(resp.data);
  } catch (err) {
    res.status(502).json({ error: `Chat service unreachable: ${err.message}` });
  }
});

// 4. Send a text message to a room — as the acting human's own Matrix
// identity when one is provisioned (#2173), else the shared admin account
// (env single-admin, or a human whose identity hasn't finished provisioning).
app.post('/api/matrix/rooms/:roomId/messages', apiLimiter, async (req, res) => {
  if (!matrix.ADMIN_TOKEN) return res.status(500).json({ error: 'MATRIX_ACCESS_TOKEN not configured' });
  const { roomId } = req.params;
  const { body, extraContent } = req.body || {};
  if (typeof body !== 'string' || !body.trim()) {
    return res.status(400).json({ error: 'body (non-empty string) is required' });
  }

  // Optional structured payload merged onto the outgoing message content. Only
  // `io.aee.*` keys are copied through (e.g. the quick-reply answer identifier
  // `io.aee.ask-answer`, #1663) — this endpoint never lets a caller override
  // msgtype/body/format or set arbitrary Matrix content fields.
  const content = { msgtype: 'm.text', body };
  if (extraContent && typeof extraContent === 'object' && !Array.isArray(extraContent)) {
    for (const [k, v] of Object.entries(extraContent)) {
      // The author stamp is established server-side below and is deliberately
      // NOT part of the pass-through: a browser must not be able to attribute
      // its message to a different person (#2065 AC2).
      if (k.startsWith('io.aee.') && k !== CHAT_AUTHOR_FIELD) content[k] = v;
    }
  }
  // Who wrote this (#2065). Kept alongside the real Matrix sender below —
  // it is what resolves the display name/initials in the transcript, and it
  // still fires for the shared-admin fallback (an unprovisioned identity, or
  // the env single-admin, has no Matrix account of its own to be "true"
  // about).
  const authorStamp = chatAuthorFor(req);
  if (authorStamp) content[CHAT_AUTHOR_FIELD] = authorStamp;

  // #2173: send as the acting human's own Matrix account when one exists, so
  // `event.sender` in every downstream consumer (the agent runtime's DM
  // gate included) is the real person rather than the one shared admin
  // identity every console user used to share.
  const humanIdentity = humanMatrixIdentityFor(req);
  const sendToken = humanIdentity ? humanIdentity.accessToken : matrix.ADMIN_TOKEN;
  if (humanIdentity) await ensureHumanJoinedToRoom(humanIdentity, roomId);

  const txnId = crypto.randomUUID();
  try {
    const resp = await matrix.matrixFetch(sendToken,
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${encodeURIComponent(txnId)}`,
      {
        method: 'PUT',
        body: content,
      });
    if (resp.status >= 400) {
      return res.status(resp.status).json(resp.data);
    }
    res.json({ event_id: resp.data?.event_id });
  } catch (err) {
    res.status(502).json({ error: `Chat service unreachable: ${err.message}` });
  }
});

// 5. Redact (delete) all m.room.message events in a room
//
// Paginates backward through the full timeline, collecting every m.room.message
// event, then issues a Matrix redaction (PUT .../redact/...) for each one.
//
// Already-redacted events (empty content) are skipped so the call stays
// idempotent.

// Reverse lookup: which agent owns this Matrix room? The `dm-room.json` pointer
// is the only record of it, so this scans the agent directories.
//
// Split out of findAgentTokenByDmRoom below for the #1459 work-plane gate,
// which has to answer "whose room is this?" for a room the caller may not be
// allowed to touch — a question the token router deliberately does not answer:
// it returns null for a tokenless agent, which a gate would read as "no agent
// owns this room" and wave through. Returning the config lets each caller apply
// its own rule to the same single scan.
function findAgentByDmRoom(roomId) {
  try {
    for (const agentId of fs.readdirSync(AGENTS_DIR)) {
      const dm = readJsonFile(path.join(AGENTS_DIR, agentId, 'dm-room.json'), null);
      if (dm?.roomId !== roomId) continue;
      const cfg = readJsonFile(path.join(AGENTS_DIR, agentId, 'config.json'), null);
      return { agentId, cfg };
    }
  } catch { /* fall through */ }
  return null;
}

// Token routing per sender: the DM room is CREATED BY THE AGENT (see
// ensureAgentDmRoom), and on current homeserver room versions the creator
// holds implicit top power while the PL content is empty — so the admin token
// can only redact the admin's own messages (m.room.power_levels `redact`
// defaults to 50, users_default to 0). Redacting the agent's messages with the
// admin token silently 403'd, and "Clear History" came back after the next
// backfill. Events sent by the agent are therefore redacted with the agent's
// own token (from its config.json, same source ensureAgentDmRoom uses).
function findAgentTokenByDmRoom(roomId) {
  const owner = findAgentByDmRoom(roomId);
  const cfg = owner && owner.cfg;
  return cfg?.token ? { token: cfg.token, userId: cfg.userId || `@${owner.agentId}:local` } : null;
}

app.delete('/api/matrix/rooms/:roomId/messages', apiLimiter, async (req, res) => {
  if (!matrix.ADMIN_TOKEN) return res.status(500).json({ error: 'MATRIX_ACCESS_TOKEN not configured' });
  const { roomId } = req.params;
  const agent = findAgentTokenByDmRoom(roomId);

  // Collect all unredacted m.room.message events (id + sender) by paginating
  // dir=b until exhausted.
  const events = [];
  let from = undefined;
  try {
    while (true) {
      const query = { dir: 'b', limit: 100 };
      if (from) query.from = from;
      const resp = await matrix.matrixFetch(matrix.ADMIN_TOKEN,
        `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages`,
        { query });
      if (resp.status >= 400) {
        return res.status(resp.status).json(resp.data ?? { error: `Chat service returned ${resp.status}` });
      }
      const chunk = Array.isArray(resp.data?.chunk) ? resp.data.chunk : [];
      for (const ev of chunk) {
        if (ev.type !== 'm.room.message' || !ev.event_id) continue;
        if (!ev.content || Object.keys(ev.content).length === 0) continue; // already redacted
        events.push({ eventId: ev.event_id, sender: ev.sender });
      }
      const next = resp.data?.end;
      if (!next || chunk.length === 0) break;
      from = next;
    }
  } catch (err) {
    return res.status(502).json({ error: `Chat service unreachable: ${err.message}` });
  }

  // Redact each event with the token that has the right to do so: the sender's
  // own token where we hold it (the agent's), the admin token otherwise.
  let redacted = 0;
  let failed = 0;
  for (const { eventId, sender } of events) {
    const token = agent && sender === agent.userId ? agent.token : matrix.ADMIN_TOKEN;
    const txnId = crypto.randomUUID();
    try {
      const r = await matrix.matrixFetch(token,
        `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/redact/${encodeURIComponent(eventId)}/${encodeURIComponent(txnId)}`,
        { method: 'PUT', body: { reason: 'Chat history cleared by admin' } });
      if (r.status < 400) redacted++;
      else failed++;
    } catch {
      failed++;
    }
  }

  // Surface partial failure instead of a silent 200 — the UI clears its view
  // optimistically, so a quiet failure looks like success until the next
  // backfill resurrects the history.
  if (failed > 0) {
    return res.status(502).json({ error: `Failed to redact ${failed} of ${events.length} message(s)`, redacted, failed, total: events.length });
  }
  res.json({ redacted, skipped: 0, failed: 0, total: events.length });
});

// 6. SSE stream — long-poll /sync filtered to this room
app.get('/api/matrix/rooms/:roomId/stream', async (req, res) => {
  if (!matrix.ADMIN_TOKEN) {
    return res.status(500).json({ error: 'MATRIX_ACCESS_TOKEN not configured' });
  }
  const { roomId } = req.params;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const filter = JSON.stringify({
    room: {
      rooms: [roomId],
      timeline: { limit: 50, types: ['m.room.message'] },
      state: { types: [], lazy_load_members: true },
    },
    presence: { types: [] },
    account_data: { types: [] },
  });

  let closed = false;
  let abort = null;

  const heartbeat = setInterval(() => {
    if (!closed) res.write(': ping\n\n');
  }, 15000);

  req.on('close', () => {
    closed = true;
    clearInterval(heartbeat);
    if (abort) {
      try { abort.abort(); } catch { /* noop */ }
    }
  });

  // Bootstrap: pick up where we left off, or do a quick initial sync to get next_batch
  let since = matrix.loadSyncToken();
  try {
    if (!since) {
      const initResp = await matrix.matrixFetch(matrix.ADMIN_TOKEN, '/_matrix/client/v3/sync', {
        query: { timeout: 0, full_state: false, filter },
      });
      if (initResp.status >= 400) {
        res.write(`event: error\ndata: ${JSON.stringify({ status: initResp.status, body: initResp.data })}\n\n`);
        return res.end();
      }
      since = initResp.data?.next_batch || null;
      if (since) matrix.saveSyncToken(since);
    }
  } catch (err) {
    res.write(`event: error\ndata: ${JSON.stringify({ message: `initial sync failed: ${err.message}` })}\n\n`);
    return res.end();
  }

  // Long-poll loop
  while (!closed) {
    abort = new AbortController();
    let resp;
    try {
      resp = await matrix.matrixFetch(matrix.ADMIN_TOKEN, '/_matrix/client/v3/sync', {
        query: { since, timeout: 25000, filter },
        signal: abort.signal,
      });
    } catch (err) {
      if (closed) break;
      // Network blip — wait a moment and retry
      res.write(`event: warn\ndata: ${JSON.stringify({ message: `sync failed: ${err.message}` })}\n\n`);
      await new Promise(r => setTimeout(r, 1500));
      continue;
    }
    if (closed) break;

    if (resp.status >= 400) {
      res.write(`event: error\ndata: ${JSON.stringify({ status: resp.status, body: resp.data })}\n\n`);
      // Reset since token if invalid, then back off
      if (resp.status === 400 || resp.status === 401) {
        since = null;
      }
      await new Promise(r => setTimeout(r, 2000));
      continue;
    }

    const data = resp.data || {};
    const next = data.next_batch || since;
    const room = data.rooms?.join?.[roomId];
    const events = room?.timeline?.events || [];
    for (const ev of events) {
      if (ev.type !== 'm.room.message') continue;
      const payload = {
        event_id: ev.event_id,
        sender: ev.sender,
        origin_server_ts: ev.origin_server_ts,
        content: ev.content,
        room_id: roomId,
      };
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    }

    if (next && next !== since) {
      since = next;
      try { matrix.saveSyncToken(since); } catch (err) {
        console.error('[Matrix] saveSyncToken failed:', err.message);
      }
    }
  }

  clearInterval(heartbeat);
  try { res.end(); } catch { /* noop */ }
});

/* ─── Session Log ───────────────────────────────────────────────────── */

// Matrix room IDs come in two forms: the legacy `!opaque:server_name` shape
// used through room version 11, and the v12+ shape (per MSC4291) which is a
// hash with no `:server_name` suffix. Continuwuity:latest creates new rooms
// at v12 by default, so the suffix must be optional here.
const ROOM_ID_RE = /^![a-zA-Z0-9_-]+(?::[a-zA-Z0-9.-]+)?$/;

// Session-file paths derive from two route params (agentId, roomId). Both pass
// an anchored regex at the route entry (AGENT_ID_RE / ROOM_ID_RE — neither admits
// a path separator or `..`), but CodeQL's js/path-injection rule does not model a
// regex test as a traversal barrier, so every downstream fs sink stayed flagged.
// Resolve every session path through this one helper: its path.relative
// containment check IS the CodeQL-legible barrier, and its return value is safe to
// hand to any fs call. Returns null on an escaping / malformed pair (the guard
// never trips for a regex-valid agentId + roomId — behaviour is unchanged).
function safeSessionPath(agentId, roomId, suffix) {
  const base = path.resolve(AGENTS_DIR);
  const full = path.resolve(base, agentId, 'sessions', roomId + suffix);
  const rel = path.relative(base, full);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return full;
}

// Append one JSONL event to a room's session log (#1383, AC5). Best-effort:
// a failure here never blocks the caller's response. The log is otherwise
// agent-written, but appends are O_APPEND-atomic and readers already tolerate a
// malformed line, so an out-of-band admin event is safe. On the default shared
// volume this is exactly the file the history reader reads; the write is routed
// through safeSessionPath so the fs sink stays behind the CodeQL barrier.
function appendSessionEvent(agentId, roomId, event) {
  const fp = safeSessionPath(agentId, roomId, '.jsonl');
  if (!fp) return;
  try {
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    const ev = { ts: new Date().toISOString(), ...event };
    fs.appendFileSync(fp, JSON.stringify(ev) + '\n');
  } catch (err) {
    console.warn(`[API] session-event append failed for ${agentId}/${roomId}: ${err.message}`);
  }
}

/* ─── Session pointer (Claude --resume id) ─────────────────────────── */

// Returns the active Claude session id for a given (agent, room), if any.
// The runner writes this file after every successful Claude invocation;
// an empty / missing file means the next message starts a fresh session.
// Also returns `resetAt` (ISO string) when the session was manually reset and
// no new session has started yet; the UI uses this to show a persistent notice.
app.get('/api/agents/:agentId/session/:roomId/current', (req, res) => {
  const { agentId, roomId } = req.params;
  if (!AGENT_ID_RE.test(agentId) || !ROOM_ID_RE.test(roomId)) {
    return res.status(400).json({ error: 'invalid id' });
  }
  const ptr = controlOrAgentPath(agentId, 'sessions', roomId + '.current.json'); // pushed copy preferred (#185)
  const flagPath = safeSessionPath(agentId, roomId, '.reset.json');
  if (!flagPath) return res.status(400).json({ error: 'invalid id' });

  let sessionId = null, updatedAt = null;
  if (fs.existsSync(ptr)) {
    try {
      const j = JSON.parse(fs.readFileSync(ptr, 'utf8'));
      sessionId = typeof j?.sessionId === 'string' ? j.sessionId : null;
      updatedAt = typeof j?.updatedAt === 'string' ? j.updatedAt : null;
    } catch { /* corrupt pointer → treat as no session */ }
  }

  let resetAt = null;
  if (fs.existsSync(flagPath)) {
    try {
      const f = JSON.parse(fs.readFileSync(flagPath, 'utf8'));
      const ra = typeof f?.resetAt === 'string' ? f.resetAt : null;
      if (ra) {
        // Auto-clear flag once a new session has started after the reset.
        if (updatedAt && new Date(updatedAt) > new Date(ra)) {
          fs.rmSync(flagPath, { force: true });
        } else {
          resetAt = ra;
        }
      }
    } catch { /* corrupt flag → ignore */ }
  }

  res.json({ sessionId, updatedAt, resetAt });
});

// Drop the session pointer so the next message starts a fresh Claude
// session (memory files are still re-read; only the in-conversation
// context is discarded). Also writes a reset flag (persists across navigation)
// and triggers a best-effort git reset of all repositories in the agent's
// working environment back to their configured default branch.
app.delete('/api/agents/:agentId/session/:roomId/current', apiLimiter, async (req, res) => {
  const { agentId, roomId } = req.params;
  if (!AGENT_ID_RE.test(agentId) || !ROOM_ID_RE.test(roomId)) {
    return res.status(400).json({ error: 'invalid id' });
  }
  const currentPath = safeSessionPath(agentId, roomId, '.current.json');
  const flagPath = safeSessionPath(agentId, roomId, '.reset.json');
  if (!currentPath || !flagPath) return res.status(400).json({ error: 'invalid id' });
  try {
    // Local pool copy (works on the shared volume; a no-op on an isolated one).
    fs.rmSync(currentPath, { force: true });
    fs.mkdirSync(path.dirname(flagPath), { recursive: true });
    writeJsonAtomic(flagPath, { resetAt: new Date().toISOString() });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  const orchestratorUrl = process.env.ORCHESTRATOR_URL || 'http://orchestrator:4002';

  // Drop the pushed pointer mirror (clears the badge) and, when the agent's
  // volume is isolated, ask the agent to drop its own --resume pointer (#185).
  try {
    await fetch(
      `${orchestratorUrl}/internal/agents/${encodeURIComponent(agentId)}/session-reset`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomId }),
      },
    );
  } catch (err) {
    console.warn(`[API] session-reset call failed for ${agentId}: ${err.message}`);
  }

  // Best-effort repository reset — failures are logged but never block the response.
  let repoResults = [];
  try {
    const r = await fetch(
      `${orchestratorUrl}/internal/agents/${encodeURIComponent(agentId)}/reset-repos`,
      { method: 'POST' },
    );
    const data = await r.json();
    repoResults = data?.results ?? [];
  } catch (err) {
    console.warn(`[API] reset-repos call failed for ${agentId}: ${err.message}`);
  }

  res.json({ ok: true, repoResults });
});

// Re-point the room's current-session pointer at a *finished* session so the
// next message resumes it via `--resume` (#574). Body: `{ sessionId }`. Unlike
// the runner (which writes the pointer at the natural end of a run), this is an
// explicit user action from the Sessions tab, so we validate the target against
// the room's finished-session history: it must be a DM session that exists and
// is not currently active (findResumableSession). The pointer carries a one-shot
// `resumeRequested` flag so the runtime treats a failed `--resume` as an error
// (surfacing a notice) instead of silently starting a fresh empty session (AC6);
// the flag is cleared by the runner's next pointer write once the resume lands.
app.post('/api/agents/:agentId/session/:roomId/current', apiLimiter, async (req, res) => {
  const { agentId, roomId } = req.params;
  if (!AGENT_ID_RE.test(agentId) || !ROOM_ID_RE.test(roomId)) {
    return res.status(400).json({ error: 'invalid id' });
  }
  const sessionId = typeof req.body?.sessionId === 'string' ? req.body.sessionId : '';
  if (!SESSION_ID_RE.test(sessionId)) {
    return res.status(400).json({ error: 'invalid sessionId' });
  }

  // Load the room's finished-session history and confirm the target is a
  // resumable DM session (exists, not active). Mirrors the history endpoint.
  let activeCorrelationIds = [];
  try {
    const rf = controlOrAgentPath(agentId, 'running-sessions.json');
    if (fs.existsSync(rf)) {
      const arr = JSON.parse(fs.readFileSync(rf, 'utf8'));
      if (Array.isArray(arr)) {
        activeCorrelationIds = arr.map(s => s && s.correlationId).filter(Boolean);
      }
    }
  } catch { /* best-effort: missing/corrupt registry ⇒ nothing active */ }

  const filepath = controlOrAgentPath(agentId, 'sessions', roomId + '.jsonl');
  if (!fs.existsSync(filepath)) {
    return res.status(404).json({ error: 'session not resumable' });
  }
  let events;
  try {
    const raw = fs.readFileSync(filepath, 'utf8');
    events = [];
    for (const line of raw.split('\n')) {
      if (line.trim()) events.push(parseJsonlLine(line));
    }
  } catch (err) {
    return res.status(500).json({ error: 'read failed: ' + err.message });
  }

  const match = findResumableSession(events, activeCorrelationIds, sessionId);
  if (!match) {
    // Unknown / non-DM / currently-active session — never silently start fresh.
    return res.status(404).json({ error: 'session not resumable' });
  }

  // Write the local pool pointer with a one-shot resumeRequested flag, and clear
  // any pending reset flag (a resume supersedes a prior reset). On the shared
  // volume this write is directly visible to the agent; on an isolated volume
  // the orchestrator call below queues the same work for the agent to apply.
  const updatedAt = new Date().toISOString();
  const currentPath = safeSessionPath(agentId, roomId, '.current.json');
  const resetPath = safeSessionPath(agentId, roomId, '.reset.json');
  if (!currentPath || !resetPath) return res.status(400).json({ error: 'invalid id' });
  try {
    fs.mkdirSync(path.dirname(currentPath), { recursive: true });
    writeJsonAtomic(
      currentPath,
      { sessionId, updatedAt, resumeRequested: true },
    );
    fs.rmSync(resetPath, { force: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  const orchestratorUrl = process.env.ORCHESTRATOR_URL || 'http://orchestrator:4002';
  try {
    await fetch(
      `${orchestratorUrl}/internal/agents/${encodeURIComponent(agentId)}/session-set`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomId, sessionId, resumeRequested: true }),
      },
    );
  } catch (err) {
    console.warn(`[API] session-set call failed for ${agentId}: ${err.message}`);
  }

  res.json({ ok: true, sessionId, updatedAt });
});

/* ─── Parent-ticket binding (#1383) ────────────────────────────────────── */

// Read the parent GitHub issue bound to this agent+room, or null when unbound.
// Room-scoped (AC4: persists across Reset Session — a separate file from
// `.current.json`/`.reset.json`). Prefers a pushed control-plane copy (#185).
app.get('/api/agents/:agentId/session/:roomId/ticket', (req, res) => {
  const { agentId, roomId } = req.params;
  if (!AGENT_ID_RE.test(agentId) || !ROOM_ID_RE.test(roomId)) {
    return res.status(400).json({ error: 'invalid id' });
  }
  const fp = controlOrAgentPath(agentId, 'sessions', roomId + '.ticket.json');
  let ticket = null;
  if (fs.existsSync(fp)) {
    try {
      const j = JSON.parse(fs.readFileSync(fp, 'utf8'));
      if (j && typeof j === 'object' && Number.isInteger(j.number) && j.number >= 1) ticket = j;
    } catch { /* corrupt binding → treat as unbound */ }
  }
  res.json({ ticket });
});

// Bind a parent issue to this agent+room. Body: `{ mode: 'create', title,
// repo?, issueBody? }` (AC2) or `{ mode: 'attach', ref, repo? }` where `ref`
// is an issue number or GitHub issue URL (AC3). The orchestrator does the
// GitHub round-trip with the env PAT and materialises `ticket.json` at the
// workspace root (AC8); we then persist the room-scoped copy and append a
// `ticket.bound` session-log event (AC5).
app.put('/api/agents/:agentId/session/:roomId/ticket', apiLimiter, async (req, res) => {
  const { agentId, roomId } = req.params;
  if (!AGENT_ID_RE.test(agentId) || !ROOM_ID_RE.test(roomId)) {
    return res.status(400).json({ error: 'invalid id' });
  }
  const ticketPath = safeSessionPath(agentId, roomId, '.ticket.json');
  if (!ticketPath) return res.status(400).json({ error: 'invalid id' });

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const mode = body.mode === 'create' ? 'create' : 'attach';
  if (mode === 'create') {
    if (typeof body.title !== 'string' || !body.title.trim()) {
      return res.status(400).json({ error: 'title is required to create an issue' });
    }
  } else if (typeof body.ref !== 'string' || !body.ref.trim()) {
    return res.status(400).json({ error: 'an issue number or GitHub issue URL is required' });
  }

  const orchestratorUrl = process.env.ORCHESTRATOR_URL || 'http://orchestrator:4002';
  let ticket;
  try {
    const r = await fetch(
      `${orchestratorUrl}/internal/agents/${encodeURIComponent(agentId)}/ticket`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data || data.ok === false || !data.ticket) {
      return res.status(r.status && r.status >= 400 ? r.status : 502)
        .json({ error: (data && data.error) || 'could not bind the ticket' });
    }
    ticket = data.ticket;
  } catch (err) {
    return res.status(502).json({ error: 'orchestrator unreachable: ' + err.message });
  }

  try {
    fs.mkdirSync(path.dirname(ticketPath), { recursive: true });
    writeJsonAtomic(ticketPath, ticket);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
  appendSessionEvent(agentId, roomId, {
    type: 'ticket.bound',
    repo: ticket.repo,
    number: ticket.number,
    url: ticket.url || '',
    title: ticket.title || '',
  });
  res.json({ ok: true, ticket });
});

// Remove the parent-ticket binding (AC7): delete the room-scoped copy, ask the
// orchestrator to drop the workspace `ticket.json`, and append a `ticket.unbound`
// session-log event.
app.delete('/api/agents/:agentId/session/:roomId/ticket', apiLimiter, async (req, res) => {
  const { agentId, roomId } = req.params;
  if (!AGENT_ID_RE.test(agentId) || !ROOM_ID_RE.test(roomId)) {
    return res.status(400).json({ error: 'invalid id' });
  }
  const ticketPath = safeSessionPath(agentId, roomId, '.ticket.json');
  if (!ticketPath) return res.status(400).json({ error: 'invalid id' });

  let hadBinding = false;
  try {
    hadBinding = fs.existsSync(ticketPath);
    fs.rmSync(ticketPath, { force: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  const orchestratorUrl = process.env.ORCHESTRATOR_URL || 'http://orchestrator:4002';
  try {
    await fetch(
      `${orchestratorUrl}/internal/agents/${encodeURIComponent(agentId)}/ticket`,
      { method: 'DELETE' },
    );
  } catch (err) {
    console.warn(`[API] ticket delete call failed for ${agentId}: ${err.message}`);
  }

  if (hadBinding) appendSessionEvent(agentId, roomId, { type: 'ticket.unbound' });
  res.json({ ok: true });
});

// Send a stop-session signal to the orchestrator, which forwards it via IPC
// to the agent-runner. The runner kills any in-flight Claude invocation.
app.post('/api/agents/:agentId/session/:roomId/stop', apiLimiter, async (req, res) => {
  const { agentId, roomId } = req.params;
  if (!AGENT_ID_RE.test(agentId) || !ROOM_ID_RE.test(roomId)) {
    return res.status(400).json({ error: 'invalid id' });
  }
  const orchestratorUrl = process.env.ORCHESTRATOR_URL || 'http://orchestrator:4002';
  try {
    const resp = await fetch(
      `${orchestratorUrl}/internal/agents/${encodeURIComponent(agentId)}/stop-session`,
      { method: 'POST' },
    );
    const data = await resp.json();
    res.status(resp.status).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List running Claude sessions for an agent. Reads the per-agent
// running-sessions.json the runner maintains. Returns `{ sessions: [] }`
// when no file exists (agent never started or never ran a session).
const SESSION_ID_RE = /^[a-zA-Z0-9_-]+$/;
app.get('/api/agents/:agentId/sessions/active', apiLimiter, (req, res) => {
  const { agentId } = req.params;
  if (!AGENT_ID_RE.test(agentId)) return res.status(400).json({ error: 'invalid agent id' });
  // Pushed control-plane copy preferred (#185): under per-agent volume
  // isolation the agent's own running-sessions.json lives on a volume the
  // admin-console can't see, so it must be read from the control plane.
  const filePath = controlOrAgentPath(agentId, 'running-sessions.json');
  if (!fs.existsSync(filePath)) return res.json({ sessions: [] });
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    res.json({ sessions: Array.isArray(parsed) ? parsed : [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Stop one specific running session.
app.post('/api/agents/:agentId/sessions/:sessionId/stop', apiLimiter, async (req, res) => {
  const { agentId, sessionId } = req.params;
  if (!AGENT_ID_RE.test(agentId)) return res.status(400).json({ error: 'invalid agent id' });
  if (!SESSION_ID_RE.test(sessionId)) return res.status(400).json({ error: 'invalid session id' });
  const orchestratorUrl = process.env.ORCHESTRATOR_URL || 'http://orchestrator:4002';
  try {
    const resp = await fetch(
      `${orchestratorUrl}/internal/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(sessionId)}/stop`,
      { method: 'POST' },
    );
    const data = await resp.json();
    res.status(resp.status).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List *finished* sessions for an agent within one room (#544). Sessions are
// already durable in the per-room JSONL — every event carries the run's
// correlationId — so a finished session is one correlationId group that is no
// longer in running-sessions.json. Returns descriptors shaped like the active
// ones (type/triggerType/label/correlationId + started/endedAt) so the UI can
// render the same source labels and open each in the per-session log view.
// Query: roomId (required), limit (default 50, max 500), offset (default 0).
const SESSION_HISTORY_MAX_LIMIT = 500;
app.get('/api/agents/:agentId/sessions/history', apiLimiter, (req, res) => {
  const { agentId } = req.params;
  if (!AGENT_ID_RE.test(agentId)) return res.status(400).json({ error: 'invalid agent id' });
  const roomId = typeof req.query.roomId === 'string' ? req.query.roomId : '';
  if (!ROOM_ID_RE.test(roomId)) return res.status(400).json({ error: 'invalid roomId' });

  const limit = Math.min(
    SESSION_HISTORY_MAX_LIMIT,
    Math.max(1, parseInt(req.query.limit, 10) || 50),
  );
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);

  // correlationIds of currently-running sessions — excluded so active runs
  // stay as sub-tabs and never also appear in the history dropdown (#544 AC2).
  let activeCorrelationIds = [];
  try {
    const rf = controlOrAgentPath(agentId, 'running-sessions.json');
    if (fs.existsSync(rf)) {
      const arr = JSON.parse(fs.readFileSync(rf, 'utf8'));
      if (Array.isArray(arr)) {
        activeCorrelationIds = arr.map(s => s && s.correlationId).filter(Boolean);
      }
    }
  } catch { /* best-effort: a missing/corrupt registry just means nothing active */ }

  const filepath = controlOrAgentPath(agentId, 'sessions', roomId + '.jsonl'); // pushed copy preferred (#185)

  // Span rotated archives (#673): finished sessions may have rotated out of the
  // live file, so read archives (oldest→newest) then the live file. Either may
  // be absent (a freshly-rotated room has no live file until its next append).
  const events = readSessionArchiveEvents(agentId, roomId, parseJsonlLine);
  if (fs.existsSync(filepath)) {
    let raw;
    try {
      raw = fs.readFileSync(filepath, 'utf8');
    } catch (err) {
      return res.status(500).json({ error: 'read failed: ' + err.message });
    }
    for (const line of raw.split('\n')) {
      if (line.trim()) events.push(parseJsonlLine(line));
    }
  }
  if (!events.length) return res.json({ sessions: [], total: 0, truncated: false });
  res.json(buildSessionHistory(events, activeCorrelationIds, { limit, offset }));
});

/* ─── Workspace browser (read-only) ────────────────────────────────── */

const WORKSPACE_FILE_MAX_BYTES = 512 * 1024; // 512 KB read cap per file

// Resolve a user-supplied relative path against the agent root, refusing
// anything that escapes the root (path traversal, symlinks aimed outside,
// absolute paths). Returns the absolute path on success, null otherwise.
function safeAgentPath(agentId, relPath) {
  if (!AGENT_ID_RE.test(agentId)) return null;
  const agentRoot = path.join(AGENTS_DIR, agentId);
  // realpath the root first so symlinks at /workspace level still resolve
  // consistently. If the agent dir doesn't exist yet, bail out.
  let realRoot;
  try {
    realRoot = fs.realpathSync(agentRoot);
  } catch {
    return null;
  }
  const normalized = path.normalize(String(relPath || '').replace(/^\/+/, ''));
  if (normalized.split(path.sep).some(seg => seg === '..')) return null;
  const target = path.resolve(realRoot, normalized);
  // Final containment check (covers symlinks pointing outward).
  let realTarget;
  try {
    realTarget = fs.realpathSync(target);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    return null;
  }
  // Final containment guard, expressed as the canonical path.relative idiom so
  // it is recognised as a CodeQL js/path-injection barrier on the returned
  // value (an outward-pointing symlink yields a rel that escapes the root).
  // Behaviour-equivalent to the previous `startsWith(realRoot + sep)` check.
  const rel = path.relative(realRoot, realTarget);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return realTarget;
}

// Directory listing. Hidden dotfiles are returned but flagged with `hidden`
// so the UI can collapse them by default. Symlinks are reported with their
// link target (best-effort) so the user understands what they're looking at.
app.get('/api/agents/:agentId/workspace/tree', apiLimiter, (req, res) => {
  const { agentId } = req.params;
  if (!AGENT_ID_RE.test(agentId)) return res.status(400).json({ error: 'Invalid agent id' });
  const relPath = typeof req.query.path === 'string' ? req.query.path : '';
  const target = safeAgentPath(agentId, relPath);
  if (!target) return res.status(400).json({ error: 'invalid path' });

  let entries;
  try {
    entries = fs.readdirSync(target, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOTDIR') return res.status(400).json({ error: 'not a directory' });
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'not found' });
    if (err.code === 'EACCES') return res.status(403).json({ error: 'permission denied' });
    return res.status(500).json({ error: err.message });
  }

  const items = entries.map(d => {
    const full = path.join(target, d.name);
    let size = 0;
    let mtime = 0;
    let kind = 'file';
    if (d.isDirectory()) kind = 'dir';
    else if (d.isSymbolicLink()) kind = 'link';
    else if (!d.isFile()) kind = 'other';
    let gitBranch = null;
    try {
      const st = fs.statSync(full);
      size = st.size;
      mtime = st.mtimeMs;
      // For symlinks, prefer the target's type so the UI can navigate into
      // resolved directories. We've already constrained safeAgentPath to
      // refuse outward-pointing links, but defense-in-depth: catch ENOENT.
      if (kind === 'link') {
        if (st.isDirectory()) kind = 'dir';
        else if (st.isFile()) kind = 'file';
      }
    } catch { /* dangling link or transient — surface minimal info */ }
    if (kind === 'dir') {
      try {
        const headContent = fs.readFileSync(path.join(full, '.git', 'HEAD'), 'utf8').trim();
        if (headContent.startsWith('ref: refs/heads/')) {
          gitBranch = headContent.slice('ref: refs/heads/'.length);
        } else if (/^[0-9a-f]{7,40}$/i.test(headContent)) {
          gitBranch = headContent.slice(0, 7); // detached HEAD — show short hash
        }
      } catch { /* not a git repo or unreadable */ }
    }
    return {
      name: d.name,
      type: kind,
      size,
      mtime,
      hidden: d.name.startsWith('.'),
      ...(gitBranch !== null && { gitBranch }),
    };
  });

  // Stable ordering: dirs first, then alphabetical (case-insensitive).
  items.sort((a, b) => {
    if (a.type === 'dir' && b.type !== 'dir') return -1;
    if (a.type !== 'dir' && b.type === 'dir') return 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });

  // Normalize the path we echo back — trailing slashes etc. shouldn't leak.
  const echoPath = path.relative(path.join(AGENTS_DIR, agentId), target);
  res.json({ path: echoPath, items });
});

// Read the checked-out branch from a repo's .git/HEAD — a plain file read, no
// git process. Returns the branch name, a short SHA for a detached HEAD, or
// null when HEAD is unreadable / not a recognisable ref.
function readRepoBranch(repoPath) {
  try {
    const headContent = fs.readFileSync(path.join(repoPath, '.git', 'HEAD'), 'utf8').trim();
    if (headContent.startsWith('ref: refs/heads/')) {
      return headContent.slice('ref: refs/heads/'.length);
    }
    if (/^[0-9a-f]{7,40}$/i.test(headContent)) {
      return headContent.slice(0, 7); // detached HEAD
    }
  } catch { /* unreadable HEAD → unknown branch */ }
  return null;
}

// Discover the git repos in an agent workspace using filesystem reads only
// (readdir + .git/HEAD) — deliberately no `git` spawn, so this stays cheap on
// the request path (#1683). Returns [{ repoPath, abs, branch }]. Dirty state
// (which needs an actual `git status`) is computed separately and async by the
// git-info endpoint, so the repo-resolution and git-status paths never shell
// out just to enumerate repos.
function discoverGitRepos(agentRoot) {
  const repos = [];
  // The workspace root itself may be a repo.
  if (fs.existsSync(path.join(agentRoot, '.git', 'HEAD'))) {
    repos.push({ repoPath: '.', abs: agentRoot, branch: readRepoBranch(agentRoot) });
  }
  // Scan first-level subdirectories.
  let entries = [];
  try { entries = fs.readdirSync(agentRoot, { withFileTypes: true }); } catch { return repos; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const fullPath = path.join(agentRoot, entry.name);
    if (fs.existsSync(path.join(fullPath, '.git', 'HEAD'))) {
      repos.push({ repoPath: entry.name, abs: fullPath, branch: readRepoBranch(fullPath) });
    }
  }
  return repos;
}

// Dirty state (isDirty / changesCount) for one repo. Async so the git-info poll
// (every 30s per open chat) never blocks the single event loop the console
// proxies through. `abs` must be a sanitised repo dir (runGitAsync re-validates
// the cwd). Failures degrade to "clean" rather than throwing.
async function readGitDirty(abs) {
  const res = await runGitAsync(['status', '--porcelain'], abs, { maxBuffer: 1024 * 1024 });
  if (res.error || res.status !== 0) return { isDirty: false, changesCount: 0 };
  const lines = res.stdout.toString('utf8').trim().split('\n').filter(Boolean);
  return { isDirty: lines.length > 0, changesCount: lines.length };
}

// Short-lived cache for git-info dirty results: collapses concurrent pollers
// (multiple browser tabs on the same agent) onto one `git status` and serves a
// recently-computed result without re-spawning (#1683). Branch is read fresh
// from .git/HEAD on every request (cheap) and never cached.
const gitInfoCache = createTtlCache({
  ttlMs: Number.parseInt(process.env.AEE_GIT_INFO_TTL_MS, 10) || 5000,
});

app.get('/api/agents/:agentId/git-info', async (req, res) => {
  const { agentId } = req.params;
  if (!AGENT_ID_RE.test(agentId)) return res.status(400).json({ error: 'Invalid agent id' });
  // safeAgentPath returns the realpath-validated agent root (post-#116), so a
  // bare agentId can't escape the agents tree.
  const agentRoot = safeAgentPath(agentId, '');
  if (!agentRoot) {
    return res.status(404).json({ error: 'Agent not found' });
  }
  try {
    const repos = discoverGitRepos(agentRoot);
    const out = await Promise.all(repos.map(async (r) => {
      const dirty = await gitInfoCache.getOrCompute(
        `${agentId}::${r.repoPath}`,
        () => readGitDirty(r.abs),
      );
      return {
        repoPath: r.repoPath,
        branch: r.branch,
        isDirty: dirty.isDirty,
        changesCount: dirty.changesCount,
      };
    }));
    res.json({ repos: out });
  } catch {
    res.status(500).json({ error: 'git-info-failed' });
  }
});

// A directory-only listing used to sit here (`GET .../workspace/dirs`), the one
// non-BriefingPack consumer of bp-explorer: it proxied the service's
// `/api/workspace/tree`. It went with the service in #1963 (epic #1961 Phase 2)
// as dead code — its only caller was `src/components/DirectoryPicker.jsx`, the
// orchestrator-role directory picker, which nothing imported. Should a live
// consumer ever want it back, re-implement it locally rather than reviving a
// proxy: the sibling `workspace/tree` handler above already walks the agent
// workspace directly through `safeAgentPath`, so directories are one filter away.

// File content. Caps reads at WORKSPACE_FILE_MAX_BYTES; flags binary files
// (NUL byte detection in the prefix) so the UI can show a "binary file"
// stub instead of garbled UTF-8.
app.get('/api/agents/:agentId/workspace/file', apiLimiter, (req, res) => {
  const { agentId } = req.params;
  if (!AGENT_ID_RE.test(agentId)) return res.status(400).json({ error: 'Invalid agent id' });
  const relPath = typeof req.query.path === 'string' ? req.query.path : '';
  const target = safeAgentPath(agentId, relPath);
  if (!target) return res.status(400).json({ error: 'invalid path' });

  let st;
  try {
    st = fs.statSync(target);
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'not found' });
    return res.status(500).json({ error: err.message });
  }
  if (!st.isFile()) return res.status(400).json({ error: 'not a file' });

  const truncated = st.size > WORKSPACE_FILE_MAX_BYTES;
  const readSize  = Math.min(st.size, WORKSPACE_FILE_MAX_BYTES);

  let buf;
  try {
    const fd = fs.openSync(target, 'r');
    try {
      buf = Buffer.alloc(readSize);
      if (readSize > 0) fs.readSync(fd, buf, 0, readSize, 0);
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  // Cheap binary heuristic: NUL byte in the first 8 KB. Good enough for
  // distinguishing source files from images / native binaries.
  const probe = buf.slice(0, Math.min(buf.length, 8192));
  const isBinary = probe.includes(0);

  // Flag supported raster images (by magic bytes, not extension) so the viewer
  // can render an inline preview via the /image endpoint instead of the generic
  // "binary file" placeholder. SVG carries no raster magic → stays a text/binary
  // file (D2/E3). Detection reads only the header, so a truncated read is fine.
  const imageType = isBinary ? detectRasterImageType(buf) : null;

  const echoPath = path.relative(path.join(AGENTS_DIR, agentId), target);
  res.json({
    path: echoPath,
    size: st.size,
    truncated,
    binary: isBinary,
    imageType,
    content: isBinary ? null : buf.toString('utf8'),
    mtime: st.mtimeMs,
  });
});

// Inline image bytes for the workspace previewer. Streams the FULL file (no
// 512 KB cap, unlike /file — AC8) with the correct image Content-Type so the
// browser renders it as an <img> source. Only the supported raster formats
// (PNG/JPEG/GIF/WebP) are served, detected by magic bytes (E2); anything else
// (SVG, other binaries, a corrupt/empty file) returns an error the viewer turns
// into a friendly message (AC9). Same safeAgentPath traversal guard as the
// other workspace endpoints (AC7).
app.get('/api/agents/:agentId/workspace/image', apiLimiter, (req, res) => {
  const { agentId } = req.params;
  if (!AGENT_ID_RE.test(agentId)) return res.status(400).json({ error: 'Invalid agent id' });
  const relPath = typeof req.query.path === 'string' ? req.query.path : '';
  const target = safeAgentPath(agentId, relPath);
  if (!target) return res.status(400).json({ error: 'invalid path' });

  let st;
  try {
    st = fs.statSync(target);
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'not found' });
    return res.status(500).json({ error: err.message });
  }
  if (!st.isFile()) return res.status(400).json({ error: 'not a file' });

  // Sniff the header to confirm it is a supported raster image before serving.
  let header;
  try {
    const fd = fs.openSync(target, 'r');
    try {
      const n = Math.min(st.size, 16);
      header = Buffer.alloc(n);
      if (n > 0) fs.readSync(fd, header, 0, n, 0);
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  const imageType = detectRasterImageType(header);
  const contentType = imageContentType(imageType);
  if (!contentType) return res.status(415).json({ error: 'unsupported image type' });

  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Length', st.size);
  res.setHeader('Content-Disposition', 'inline');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  const stream = fs.createReadStream(target);
  stream.on('error', () => res.end());
  stream.pipe(res);
});

// Raw file download — streams the full file with Content-Disposition: attachment
// so the browser saves it with its original filename. No size cap (unlike /file).
app.get('/api/agents/:agentId/workspace/download', apiLimiter, (req, res) => {
  const { agentId } = req.params;
  if (!AGENT_ID_RE.test(agentId)) return res.status(400).json({ error: 'Invalid agent id' });
  const relPath = typeof req.query.path === 'string' ? req.query.path : '';
  const target = safeAgentPath(agentId, relPath);
  if (!target) return res.status(400).json({ error: 'invalid path' });

  let st;
  try {
    st = fs.statSync(target);
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'not found' });
    return res.status(500).json({ error: err.message });
  }
  if (!st.isFile()) return res.status(400).json({ error: 'not a file' });

  const filename = path.basename(target);
  const encoded = encodeURIComponent(filename).replace(/'/g, '%27');
  res.setHeader('Content-Disposition', `attachment; filename="${encoded}"; filename*=UTF-8''${encoded}`);
  res.setHeader('Content-Length', st.size);
  res.setHeader('Content-Type', 'application/octet-stream');

  const stream = fs.createReadStream(target);
  stream.on('error', () => res.end());
  stream.pipe(res);
});

// Delete a file or directory in the agent workspace. Directories are removed
// recursively. Refuses to delete the workspace root itself.
//
// Containment is enforced the same way as the upload handler: the *parent*
// directory is resolved through safeAgentPath (the canonical traversal /
// outward-symlink sanitizer), then the basename is appended. Operating on the
// entry via its parent means a symlink is unlinked rather than followed, and a
// final startsWith check against the realpath'd agent root rules out any escape.
app.delete('/api/agents/:agentId/workspace/file', apiLimiter, requireAgentManage, (req, res) => {
  const { agentId } = req.params;
  if (!AGENT_ID_RE.test(agentId)) return res.status(400).json({ error: 'Invalid agent id' });
  const relPath = typeof req.query.path === 'string' ? req.query.path : '';
  const normalized = path.normalize(relPath.replace(/^\/+/, ''));
  if (!normalized || normalized === '.' || normalized === path.sep) {
    return res.status(400).json({ error: 'Refusing to delete workspace root' });
  }
  if (normalized.split(path.sep).some(seg => seg === '..')) {
    return res.status(400).json({ error: 'invalid path' });
  }

  const parentRel = path.dirname(normalized);
  const baseName  = path.basename(normalized);
  const parentDir = safeAgentPath(agentId, parentRel === '.' ? '' : parentRel);
  if (!parentDir) return res.status(400).json({ error: 'invalid path' });
  const target = path.join(parentDir, baseName);

  // Defence-in-depth: the resolved target must stay strictly inside the root.
  let agentRoot;
  try {
    agentRoot = fs.realpathSync(path.join(AGENTS_DIR, agentId));
  } catch {
    return res.status(404).json({ error: 'Agent workspace not found' });
  }
  if (!target.startsWith(agentRoot + path.sep)) {
    return res.status(400).json({ error: 'invalid path' });
  }

  let st;
  try {
    st = fs.lstatSync(target);
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'not found' });
    return res.status(500).json({ error: err.message });
  }
  const type = st.isDirectory() ? 'dir' : (st.isSymbolicLink() ? 'link' : 'file');

  try {
    // target = safeAgentPath(parent) + sanitised basename, verified inside the
    // agent root above; recursive removal is intended for directories.
    fs.rmSync(target, { recursive: true, force: false }); // codeql[js/path-injection]
  } catch (err) {
    if (err.code === 'EACCES') return res.status(403).json({ error: 'permission denied' });
    return res.status(500).json({ error: err.message });
  }

  res.json({ deleted: path.relative(agentRoot, target), type });
});

// Move (rename) a file or directory within the agent workspace. Body:
//   { from: "<rel path of source>", toDir: "<rel path of destination dir>" }
// The entry keeps its basename; it is relocated under toDir. Both the source's
// parent and the destination dir are resolved through safeAgentPath (parent +
// basename, like the delete handler) so traversal / outward symlinks are
// rejected, and both endpoints are re-checked against the realpath'd agent root.
// Refuses to move a directory into itself or one of its own descendants, and
// refuses to clobber an existing entry at the destination.
app.post('/api/agents/:agentId/workspace/move', apiLimiter, requireAgentManage, (req, res) => {
  const { agentId } = req.params;
  if (!AGENT_ID_RE.test(agentId)) return res.status(400).json({ error: 'Invalid agent id' });

  const fromRaw = typeof req.body?.from === 'string' ? req.body.from : '';
  const toDirRaw = typeof req.body?.toDir === 'string' ? req.body.toDir : '';

  const fromNorm = path.normalize(fromRaw.replace(/^\/+/, ''));
  if (!fromNorm || fromNorm === '.' || fromNorm === path.sep) {
    return res.status(400).json({ error: 'Refusing to move workspace root' });
  }
  if (fromNorm.split(path.sep).some(seg => seg === '..')) {
    return res.status(400).json({ error: 'invalid source path' });
  }
  const toDirNorm = path.normalize(toDirRaw.replace(/^\/+/, ''));
  if (toDirNorm.split(path.sep).some(seg => seg === '..')) {
    return res.status(400).json({ error: 'invalid target path' });
  }

  // Resolve the source via its parent + basename (so a symlink entry is moved,
  // not its target) and the destination directory directly.
  const srcParentRel = path.dirname(fromNorm);
  const srcBase = path.basename(fromNorm);
  const srcParent = safeAgentPath(agentId, srcParentRel === '.' ? '' : srcParentRel);
  const destDir   = safeAgentPath(agentId, toDirNorm === '.' ? '' : toDirNorm);
  if (!srcParent) return res.status(400).json({ error: 'invalid source path' });
  if (!destDir)   return res.status(404).json({ error: 'Target directory not found' });

  const src = path.join(srcParent, srcBase);
  const dest = path.join(destDir, srcBase);

  let agentRoot;
  try {
    agentRoot = fs.realpathSync(path.join(AGENTS_DIR, agentId));
  } catch {
    return res.status(404).json({ error: 'Agent workspace not found' });
  }
  // Containment barriers in the plain `value.startsWith(root + sep)` form that
  // CodeQL's path-injection analysis recognises as a sanitizer — applied to the
  // exact values passed to fs calls below. Both src and dest carry a non-empty
  // basename, so they are always *strictly* inside the root (no root-equality
  // edge case to special-case, which would force a compound guard CodeQL can't
  // read). destDir is only used in string comparisons below, never as an fs sink.
  if (!src.startsWith(agentRoot + path.sep)) {
    return res.status(400).json({ error: 'invalid source path' });
  }
  if (!dest.startsWith(agentRoot + path.sep)) {
    return res.status(400).json({ error: 'invalid target path' });
  }

  // Source must exist (and tells us whether it is a directory).
  let srcStat;
  try {
    srcStat = fs.lstatSync(src);
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'Source not found' });
    return res.status(500).json({ error: err.message });
  }

  // No-op: already in the destination directory. (String comparison only.)
  if (path.dirname(src) === destDir) {
    return res.status(400).json({ error: 'Item is already in that directory' });
  }
  // A directory cannot be moved into itself or one of its descendants.
  if (srcStat.isDirectory() && (destDir === src || destDir.startsWith(src + path.sep))) {
    return res.status(400).json({ error: 'Cannot move a directory into itself' });
  }
  // Refuse to clobber an existing entry — renameSync would otherwise silently
  // overwrite a destination file.
  if (fs.existsSync(dest)) {
    return res.status(409).json({ error: `"${srcBase}" already exists in the target directory` });
  }

  try {
    fs.renameSync(src, dest);
  } catch (err) {
    // The destination directory's existence / type is validated here via
    // renameSync's own errors rather than a separate stat on destDir.
    if (err.code === 'ENOENT')  return res.status(404).json({ error: 'Target directory not found' });
    if (err.code === 'ENOTDIR') return res.status(400).json({ error: 'Target is not a directory' });
    if (err.code === 'EACCES')  return res.status(403).json({ error: 'permission denied' });
    if (err.code === 'EXDEV')   return res.status(500).json({ error: 'cross-device move not supported' });
    return res.status(500).json({ error: err.message });
  }

  res.json({
    from: path.relative(agentRoot, src),
    to: path.relative(agentRoot, dest),
    type: srcStat.isDirectory() ? 'dir' : (srcStat.isSymbolicLink() ? 'link' : 'file'),
  });
});

/* ─── Workspace git-diff (read-only) ───────────────────────────────────
 *
 * Two endpoints for the Diff tab in the Workspace browser:
 *   GET .../workspace/git-status   — list of changed files per repo
 *   GET .../workspace/git-diff     — unified diff for one file
 *
 * Comparison base for MVP-1 is fixed to working-tree-vs-HEAD; the optional
 * `mode` query parameter is wired through but only the default is honoured.
 */

const GIT_SPAWN_TIMEOUT_MS = 5000;
const GIT_DIFF_MAX_BUFFER  = 2 * 1024 * 1024; // 2 MB cap per `git diff` invocation
const GIT_UNTRACKED_PROBE  = 1024 * 1024;     // bytes scanned for line/binary count

// Resolve repoPath (relative to agent root) to an absolute path that contains
// a .git/HEAD. Returns null on any failure — this lets callers reply 400/404
// without distinguishing between traversal, missing, and non-repo cases.
//
// The user-supplied repoPath is never passed to a path operation directly:
// it must match one of the repos discovered by discoverGitRepos(), which
// scans the agent root with stat-only filesystem reads. Once allowlisted,
// the path is reconstructed through safeAgentPath, the canonical path
// sanitizer in this module.
function resolveAgentRepo(agentId, repoPath) {
  const wanted = typeof repoPath === 'string' && repoPath ? repoPath : '.';
  // discoverGitRepos expects the sanitised absolute agent root, not the bare
  // id. Without this, the discovery scan operates on a relative path and
  // silently returns []  → every repo lookup misses → diff view is empty.
  const agentRoot = safeAgentPath(agentId, '');
  if (!agentRoot) return null;
  const repos = discoverGitRepos(agentRoot);
  const found = repos.find(r => r.repoPath === wanted);
  if (!found) return null;
  return safeAgentPath(agentId, found.repoPath === '.' ? '' : found.repoPath);
}

// Validate that a repo-relative path is safe to pass to git as a literal
// pathspec. Rejects traversal (`..`), absolute paths, NUL bytes, leading
// `-` (would be interpreted as a CLI option even after the `--` separator
// in some git versions) and leading `:` (pathspec magic like `:(top)`,
// `:!`, `:(literal)`).
function isSafeRepoRelPath(rel) {
  if (typeof rel !== 'string' || rel === '') return false;
  if (rel.includes('\0')) return false;
  if (rel.startsWith('-') || rel.startsWith(':')) return false;
  if (path.isAbsolute(rel)) return false;
  const norm = path.normalize(rel.replace(/^\/+/, ''));
  if (norm === '..' || norm.startsWith('..' + path.sep)) return false;
  if (norm.split(path.sep).some(seg => seg === '..')) return false;
  return true;
}

function assertSafeGitCwd(cwd) {
  if (typeof cwd !== 'string' || !cwd) throw new Error('Invalid git cwd');

  let realCwd;
  try {
    realCwd = fs.realpathSync(cwd);
  } catch {
    throw new Error('Invalid git cwd');
  }

  const allowedRoots = [WORKSPACE, POOL_DIR]
    .map(root => {
      try {
        return fs.realpathSync(root);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  const inAllowedRoot = allowedRoots.some(root => realCwd === root || realCwd.startsWith(root + path.sep));
  if (!inAllowedRoot) throw new Error('Invalid git cwd');

  let st;
  try {
    st = fs.statSync(realCwd);
  } catch {
    throw new Error('Invalid git cwd');
  }
  if (!st.isDirectory()) throw new Error('Invalid git cwd');

  return realCwd;
}

// Async git runner (#1683). Mirrors spawnSync's return shape
// ({ status, stdout, stderr, error }) but uses execFile so a slow git call
// never blocks the event loop the admin console proxies through. `.status` is
// the numeric exit code (or null on a spawn/timeout/buffer failure); `.error`
// is set only for such a non-exit failure — exactly how spawnSync populated
// `.error`. It never rejects for a non-zero exit (e.g. `diff --no-index` → 1),
// so callers branch on `.status` just as they did with spawnSync.
// assertSafeGitCwd() throws synchronously for an invalid cwd (unchanged from
// runGit); call sites run inside a try/catch that answers 500.
function runGitAsync(args, cwd, { maxBuffer = GIT_DIFF_MAX_BUFFER } = {}) {
  const safeCwd = assertSafeGitCwd(cwd);
  return new Promise((resolve) => {
    execFile('git', args, {
      cwd: safeCwd,
      timeout: GIT_SPAWN_TIMEOUT_MS,
      maxBuffer,
      encoding: 'buffer',
      // LC_ALL=C keeps porcelain output stable across host locales.
      env: { ...process.env, LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0' },
    }, (error, stdout, stderr) => {
      const outBuf = stdout || Buffer.alloc(0);
      const errBuf = stderr || Buffer.alloc(0);
      if (!error) {
        resolve({ status: 0, stdout: outBuf, stderr: errBuf, error: null });
      } else if (typeof error.code === 'number') {
        // git exited non-zero. Not an error to us — surface it via `.status`.
        resolve({ status: error.code, stdout: outBuf, stderr: errBuf, error: null });
      } else {
        // Spawn failure / timeout / maxBuffer exceeded (ENOBUFS surrogate).
        resolve({ status: null, stdout: outBuf, stderr: errBuf, error });
      }
    });
  });
}

// Parse `git status --porcelain=v1 -z` output. With -z the entries are
// NUL-separated and rename/copy entries carry an extra NUL-separated origin
// path right after the new path. Returns one entry per file with split
// X/Y status bytes.
function parsePorcelainZ(buf) {
  const out = buf.toString('utf8');
  if (!out) return [];
  const parts = out.split('\0');
  if (parts[parts.length - 1] === '') parts.pop();
  const files = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (entry.length < 3) continue;
    const X = entry[0];
    const Y = entry[1];
    // entry[2] is the space delimiter.
    const filePath = entry.slice(3);
    let renameFrom = null;
    if (X === 'R' || X === 'C' || Y === 'R' || Y === 'C') {
      // Origin path is the next NUL-separated field.
      renameFrom = parts[i + 1] || null;
      i++;
    }
    files.push({ X, Y, path: filePath, renameFrom });
  }
  return files;
}

// Parse `git diff --numstat -z` output: <add>\t<del>\t<path>\0 records.
// Binary files report '-' instead of numbers; we surface that via `binary`.
function parseNumstatZ(buf) {
  const out = buf.toString('utf8');
  if (!out) return new Map();
  const records = out.split('\0').filter(Boolean);
  const result = new Map();
  for (const rec of records) {
    const tab1 = rec.indexOf('\t');
    if (tab1 < 0) continue;
    const tab2 = rec.indexOf('\t', tab1 + 1);
    if (tab2 < 0) continue;
    const addStr = rec.slice(0, tab1);
    const delStr = rec.slice(tab1 + 1, tab2);
    const filePath = rec.slice(tab2 + 1);
    if (addStr === '-' || delStr === '-') {
      result.set(filePath, { additions: 0, deletions: 0, binary: true });
    } else {
      result.set(filePath, {
        additions: Number.parseInt(addStr, 10) || 0,
        deletions: Number.parseInt(delStr, 10) || 0,
        binary: false,
      });
    }
  }
  return result;
}

// Cheap line + binary probe for an untracked file. Reads at most
// GIT_UNTRACKED_PROBE bytes — far cheaper than diffing megabytes against
// /dev/null just to populate the +/- counter in the file list.
//
// Path safety: the file path comes from `git status -z` and is therefore
// repo-relative, but we still funnel it through safeAgentPath so the
// realpath/containment guarantees in this module apply uniformly. Any
// path that doesn't normalise inside the agent root yields zeros.
function probeUntracked(agentId, fullRel) {
  if (!isSafeRepoRelPath(fullRel)) return { additions: 0, deletions: 0, binary: false };
  const absPath = safeAgentPath(agentId, fullRel);
  if (!absPath) return { additions: 0, deletions: 0, binary: false };
  try {
    const st = fs.statSync(absPath);
    if (!st.isFile()) return { additions: 0, deletions: 0, binary: false };
    const fd = fs.openSync(absPath, 'r');
    try {
      const len = Math.min(st.size, GIT_UNTRACKED_PROBE);
      const buf = Buffer.alloc(len);
      if (len > 0) fs.readSync(fd, buf, 0, len, 0);
      const head = buf.slice(0, Math.min(buf.length, 8192));
      if (head.includes(0)) return { additions: 0, deletions: 0, binary: true };
      let nl = 0;
      for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) nl++;
      // Treat last partial line as a line too — matches `wc -l` only for files
      // that end in \n, but we just want a rough indicator for the UI.
      const additions = nl > 0 ? nl : (st.size > 0 ? 1 : 0);
      return { additions, deletions: 0, binary: false };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { additions: 0, deletions: 0, binary: false };
  }
}

// Map raw X/Y status bytes to a single display status. Worktree status wins
// over index status when both are set, since that's the most recent change
// the user would care about. Untracked / ignored stay distinct.
function summarizeStatus(X, Y) {
  if (X === '?' && Y === '?') return '??';
  if (X === '!' && Y === '!') return '!!';
  if (Y !== ' ' && Y !== '') return Y;
  return X;
}

// Read branch metadata for the Git panel (#648): the local branch list, plus
// flags the UI uses to hide/disable controls. All commands are local (no
// network) and read-only. `abs` is the sanitised repo dir from
// resolveAgentRepo(); runGitAsync() re-validates the cwd.
async function readRepoBranchMeta(abs) {
  const meta = { currentBranch: null, branches: [], detached: false, hasRemote: false, hasUpstream: false };
  const cur = await runGitAsync(['rev-parse', '--abbrev-ref', 'HEAD'], abs, { maxBuffer: 64 * 1024 });
  const curBranch = cur.status === 0 ? cur.stdout.toString('utf8').trim() : '';
  meta.detached = curBranch === '' || curBranch === 'HEAD';
  meta.currentBranch = meta.detached ? null : curBranch;
  const br = await runGitAsync(['for-each-ref', '--format=%(refname:short)', 'refs/heads'], abs, { maxBuffer: 256 * 1024 });
  if (br.status === 0) {
    meta.branches = br.stdout.toString('utf8').split('\n').map(s => s.trim()).filter(Boolean);
  }
  const rem = await runGitAsync(['remote'], abs, { maxBuffer: 64 * 1024 });
  meta.hasRemote = rem.status === 0 && rem.stdout.toString('utf8').trim().length > 0;
  const up = await runGitAsync(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], abs, { maxBuffer: 64 * 1024 });
  meta.hasUpstream = up.status === 0;
  return meta;
}

// GET /api/agents/:agentId/workspace/git-status
// Lists changed files for every git repo in the agent workspace. Multi-repo
// support comes for free via discoverGitRepos().
app.get('/api/agents/:agentId/workspace/git-status', heavyLimiter, async (req, res) => {
  const { agentId } = req.params;
  if (!AGENT_ID_RE.test(agentId)) return res.status(400).json({ error: 'Invalid agent id' });
  // safeAgentPath returns null for an invalid id or a missing agent dir, and
  // produces the realpath-validated agent root in the success case. Using it
  // here avoids a direct path.join on user input.
  const agentRoot = safeAgentPath(agentId, '');
  if (!agentRoot) {
    return res.status(404).json({ error: 'Agent not found' });
  }

  const repoFilter = typeof req.query.repo === 'string' && req.query.repo
    ? req.query.repo
    : null;

  const repos = discoverGitRepos(agentRoot);
  const repoEntries = repoFilter
    ? repos.filter(r => r.repoPath === repoFilter)
    : repos;

  try {
  const result = [];
  for (const repoMeta of repoEntries) {
    const abs = resolveAgentRepo(agentId, repoMeta.repoPath);
    if (!abs) continue;

    // 1. Status — file list with X/Y status bytes.
    const status = await runGitAsync(['status', '--porcelain=v1', '-z'], abs);
    if (status.error || status.status !== 0) {
      result.push({ repoPath: repoMeta.repoPath, branch: repoMeta.branch, error: 'git-status-failed', files: [] });
      continue;
    }
    const entries = parsePorcelainZ(status.stdout);

    // 2. numstat HEAD..worktree — additions/deletions for tracked changes.
    // Combines staged + unstaged because `HEAD` (no --cached) compares the
    // working tree against HEAD directly.
    let numstat = new Map();
    const numstatRun = await runGitAsync(['diff', '--numstat', '-z', 'HEAD', '--'], abs);
    if (numstatRun.status === 0) {
      numstat = parseNumstatZ(numstatRun.stdout);
    }

    // 3. Build per-file response. Untracked entries get a cheap line probe.
    const files = [];
    for (const e of entries) {
      const display = summarizeStatus(e.X, e.Y);
      if (display === '!!') continue; // ignored — never list these
      let stats = numstat.get(e.path);
      if (!stats && display === '??') {
        // probeUntracked re-validates fullRel through safeAgentPath; we only
        // need to give it a repo-relative join key here.
        const fullRel = repoMeta.repoPath === '.' ? e.path : `${repoMeta.repoPath}/${e.path}`;
        stats = probeUntracked(agentId, fullRel);
      }
      if (!stats) stats = { additions: 0, deletions: 0, binary: false };
      files.push({
        path: e.path,
        status: display,
        indexStatus: e.X,
        worktreeStatus: e.Y,
        renameFrom: e.renameFrom,
        additions: stats.additions,
        deletions: stats.deletions,
        binary: stats.binary,
      });
    }

    // Sort: modified → added → deleted → untracked → other; alphabetic within.
    const order = { 'M': 0, 'A': 1, 'D': 2, 'R': 3, 'C': 4, 'U': 5, '??': 6 };
    files.sort((a, b) => {
      const oa = order[a.status] ?? 9;
      const ob = order[b.status] ?? 9;
      if (oa !== ob) return oa - ob;
      return a.path.localeCompare(b.path, undefined, { sensitivity: 'base' });
    });

    result.push({
      repoPath: repoMeta.repoPath,
      branch: repoMeta.branch,
      changesCount: files.length,
      dirty: files.length > 0,
      files,
      ...(await readRepoBranchMeta(abs)),
    });
  }

  res.json({ repos: result });
  } catch {
    res.status(500).json({ error: 'git-status-failed' });
  }
});

// POST /api/agents/:agentId/workspace/git-action — deterministic Workspace Git
// panel action (switch / update / discard), executed server-side by the
// orchestrator with no LLM (#648 AC9). This proxy re-checks the agent's running
// state at execution time (AC7) so a stale browser snapshot can never bypass
// the guard, then forwards to the orchestrator, which owns the git credentials.
app.post('/api/agents/:agentId/workspace/git-action', heavyLimiter, requireAgentManage, async (req, res) => {
  const { agentId } = req.params;
  if (!AGENT_ID_RE.test(agentId)) return res.status(400).json({ error: 'Invalid agent id' });

  // AC7: re-check running state here, reading the same running-sessions.json
  // that GET /api/agents/:id/sessions/active reads (pushed control-plane copy).
  try {
    const filePath = controlOrAgentPath(agentId, 'running-sessions.json');
    if (fs.existsSync(filePath)) {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (Array.isArray(parsed) && parsed.length > 0) {
        return res.status(409).json({
          error: 'The agent has a running session. Git actions are disabled until it finishes.',
        });
      }
    }
  } catch { /* unreadable/corrupt registry → treat as not running, best-effort */ }

  const orchestratorUrl = process.env.ORCHESTRATOR_URL || 'http://orchestrator:4002';
  try {
    const resp = await fetch(
      `${orchestratorUrl}/internal/agents/${encodeURIComponent(agentId)}/workspace/git-action`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req.body || {}),
      },
    );
    const data = await resp.json().catch(() => ({ error: 'Invalid response from orchestrator' }));
    res.status(resp.status).json(data);
  } catch (err) {
    res.status(502).json({ error: `Orchestrator unreachable: ${err.message}` });
  }
});

// GET /api/agents/:agentId/workspace/git-diff?repo=...&path=...&context=3
// Returns the unified diff for a single file. Untracked files are diffed
// against /dev/null so the UI sees a uniform `diff --git` envelope.
app.get('/api/agents/:agentId/workspace/git-diff', heavyLimiter, async (req, res) => {
  const { agentId } = req.params;
  if (!AGENT_ID_RE.test(agentId)) return res.status(400).json({ error: 'Invalid agent id' });

  const repoQ = typeof req.query.repo === 'string' ? req.query.repo : '.';
  const pathQ = typeof req.query.path === 'string' ? req.query.path : '';
  if (!pathQ) return res.status(400).json({ error: 'path query required' });
  // Reject traversal, NUL, leading dash (CLI option), and leading colon
  // (git pathspec magic — `:!`, `:(top)`, `:(literal)` etc.). Even with `--`
  // before pathQ, some git versions interpret pathspec magic, so we filter.
  if (!isSafeRepoRelPath(pathQ)) return res.status(400).json({ error: 'invalid path' });

  const repoAbs = resolveAgentRepo(agentId, repoQ);
  if (!repoAbs) return res.status(400).json({ error: 'invalid repo' });

  let context = Number.parseInt(req.query.context, 10);
  if (!Number.isFinite(context) || context < 0) context = 3;
  if (context > 20) context = 20;

  try {
  // Decide which form of `git diff` to invoke. For MVP-1 we always compare
  // working tree against HEAD; staged/branch modes are out of scope.
  const lsFiles = await runGitAsync(
    ['ls-files', '--error-unmatch', '--', pathQ],
    repoAbs,
    { maxBuffer: 64 * 1024 },
  );
  const isUntracked = lsFiles.status !== 0;

  let diffRun;
  if (isUntracked) {
    // --no-index between /dev/null and the file produces a uniform envelope.
    // Exit code 1 is the success-with-differences case; status 0 (identical
    // file vs /dev/null can't really happen for an untracked file) is also
    // accepted. Anything else is an error.
    diffRun = await runGitAsync(
      ['diff', '--no-color', `-U${context}`, '--no-index', '--', '/dev/null', pathQ],
      repoAbs,
    );
    if (diffRun.error || (diffRun.status !== 0 && diffRun.status !== 1)) {
      return res.status(500).json({ error: 'git-diff-failed' });
    }
  } else {
    diffRun = await runGitAsync(
      ['diff', '--no-color', `-U${context}`, 'HEAD', '--', pathQ],
      repoAbs,
    );
    if (diffRun.error || diffRun.status !== 0) {
      return res.status(500).json({ error: 'git-diff-failed' });
    }
  }

  // Detect truncation by the ENOBUFS surrogate (maxBuffer exceeded sets
  // `.error`, handled above), so if we got here the buffer was large enough —
  // but we still cap the payload size we send back to the client.
  const raw = (diffRun.stdout || Buffer.alloc(0)).toString('utf8');
  const truncated = raw.length >= GIT_DIFF_MAX_BUFFER - 1024; // close to the cap
  const diff = truncated ? raw.slice(0, GIT_DIFF_MAX_BUFFER) : raw;

  // Binary files → git emits "Binary files a/foo and b/foo differ" with no
  // hunks. Surface that to the client so it can show a placeholder instead
  // of trying to render it.
  const binary = /^Binary files .* differ$/m.test(diff) && !/^@@ /m.test(diff);

  res.json({
    repo: repoQ,
    path: pathQ,
    context,
    truncated,
    binary,
    diff,
  });
  } catch {
    res.status(500).json({ error: 'git-diff-failed' });
  }
});

// File upload. Accepts multipart/form-data with:
//   files[]         — one or more files (max 500, 50 MB each)
//   path            — target directory relative to agent workspace root (optional, defaults to root)
//   relativePaths[] — optional parallel array; when provided for a file the value is the
//                     path relative to the target dir (e.g. "mydir/sub/file.txt") used to
//                     recreate the directory tree from a folder upload. Empty string means
//                     place the file directly in the target dir (plain file upload).
// The base target directory must already exist within the agent workspace.
// Filenames are sanitised; leading dots are preserved so agents can receive
// dotfiles (.env, .claude/settings.json, etc.) — overwriting those is an
// intentional capability for admins and not considered a vulnerability.
const _upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

// Wraps multer so its own errors (file too large, too many files, etc.) turn
// into clean JSON responses instead of falling through to Express's default
// HTML error page.
const uploadFiles = (req, res, next) => {
  _upload.array('files', 500)(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: 'File too large', message: 'Each file must be under 50 MB', code: err.code });
      }
      if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
        return res.status(400).json({ error: 'Too many files', code: err.code });
      }
      return res.status(400).json({ error: err.message, code: err.code });
    }
    return res.status(500).json({ error: err.message });
  });
};

// Reject malformed agent ids before multer buffers the multipart body —
// otherwise a bad agentId still costs us up to 500×50 MB of memory before
// the handler responds 400. Has to run before `uploadFiles`.
const requireAgentIdParam = (req, res, next) => {
  if (!AGENT_ID_RE.test(req.params.agentId)) {
    return res.status(400).json({ error: 'Invalid agent id' });
  }
  next();
};

// `requireAgentManage` sits ahead of `uploadFiles` for the same reason
// `requireAgentIdParam` does: otherwise a caller who will be refused still
// costs us up to 500×50 MB of buffered multipart body before the 403.
app.post('/api/agents/:agentId/workspace/upload', heavyLimiter, requireAgentIdParam, requireAgentManage, uploadFiles, (req, res) => {
  const { agentId } = req.params;
  if (!AGENT_ID_RE.test(agentId)) return res.status(400).json({ error: 'Invalid agent id' });
  const relDir = typeof req.body.path === 'string' ? req.body.path : '';

  // relativePaths may arrive as a single string (one file) or an array (multiple files).
  const rawRelPaths = req.body.relativePaths;
  const relPaths = Array.isArray(rawRelPaths) ? rawRelPaths : (rawRelPaths != null ? [rawRelPaths] : []);

  // safeAgentPath validates agentId format, resolves realpath, and checks
  // path-traversal / outward-symlink containment — user-controlled input is
  // never passed raw to fs calls.
  const targetDir = safeAgentPath(agentId, relDir);
  if (!targetDir) return res.status(400).json({ error: 'Invalid target path' });

  let st;
  try {
    st = fs.statSync(targetDir);
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'Target directory not found' });
    return res.status(500).json({ error: err.message });
  }
  if (!st.isDirectory()) return res.status(400).json({ error: 'Target path is not a directory' });

  // Array.isArray narrows the type for the loop below: multer's
  // upload.array() always returns an Array, but the explicit guard rules out
  // tampering scenarios where a non-array value could reach this code path
  // (CodeQL js/type-confusion-through-parameter-tampering).
  if (!Array.isArray(req.files) || req.files.length === 0) {
    return res.status(400).json({ error: 'No files provided' });
  }

  // Resolve agent root for the final containment check. Wrap in try/catch to
  // handle the TOCTOU edge case where the workspace is removed between the
  // safeAgentPath call above and here.
  let agentRoot;
  try {
    agentRoot = fs.realpathSync(path.join(AGENTS_DIR, agentId));
  } catch (err) {
    return res.status(404).json({ error: 'Agent workspace not found' });
  }

  const uploaded = [];
  const errors = [];

  for (let i = 0; i < req.files.length; i++) {
    const file = req.files[i];
    const relFilePath = typeof relPaths[i] === 'string' ? relPaths[i] : '';

    // destName  — sanitised filename only (no directory component)
    // destParentDir — the directory in which the file will be placed, built
    //                 exclusively from safeAgentPath-resolved targetDir plus
    //                 individually sanitised path segments (no path.dirname on
    //                 tainted input, which would trigger CodeQL js/path-injection).
    let destName;
    let destParentDir;

    if (relFilePath) {
      // Folder upload: sanitise each segment individually, then split into
      // file name (last) and parent directory chain (all but last).
      const segments = relFilePath.split('/').map(seg =>
        path.basename(seg).replace(/[^\w\-. ()[\]]/g, '_').trim()
      ).filter(Boolean);
      if (segments.length === 0) {
        errors.push({ name: file.originalname, error: 'Invalid relative path' });
        continue;
      }
      destName = segments[segments.length - 1];
      destParentDir = segments.length > 1
        ? path.join(targetDir, ...segments.slice(0, -1))
        : targetDir;
    } else {
      // Plain file upload: just sanitise the filename.
      const safeName = path.basename(file.originalname).replace(/[^\w\-. ()[\]]/g, '_').trim();
      if (!safeName) {
        errors.push({ name: file.originalname, error: 'Invalid filename' });
        continue;
      }
      destName = safeName;
      destParentDir = targetDir;
    }

    const destPath = path.join(destParentDir, destName);

    // Defence-in-depth: the dest must still be strictly inside the agent root.
    if (destPath !== agentRoot && !destPath.startsWith(agentRoot + path.sep)) {
      errors.push({ name: file.originalname, error: 'Path escapes workspace' });
      continue;
    }

    try {
      // destParentDir is safeAgentPath(targetDir) + sanitised segments only —
      // it cannot contain '..' or path separators. Containment is verified above.
      fs.mkdirSync(destParentDir, { recursive: true }); // codeql[js/path-injection]
      fs.writeFileSync(destPath, file.buffer);
      uploaded.push({
        name: relFilePath || destName,
        path: path.relative(agentRoot, destPath),
        size: file.size,
      });
    } catch (err) {
      errors.push({ name: file.originalname, error: err.message });
    }
  }

  if (uploaded.length === 0 && errors.length > 0) {
    return res.status(500).json({ error: 'All uploads failed', details: errors });
  }
  res.json({ uploaded, ...(errors.length ? { errors } : {}) });
});

/* ─── Read-write context mount: write proxies ───────────────────────────
 * The host-folder mount lives only inside the agent container, so — exactly
 * like the read-only browse proxies above — these forward to the orchestrator,
 * which performs the mutation there. `path` here is the path RELATIVE to the
 * mount root (the browser strips the leading `/context` before calling). The
 * orchestrator enforces the per-mount readWrite gate and containment; a
 * read-only mount is refused (403) both there and by the kernel.               */
const CONTEXT_ORCH_URL = () => process.env.ORCHESTRATOR_URL || 'http://orchestrator:4002';

// Delete a file or directory inside a read-write context folder.
app.delete('/api/agents/:agentId/context/file', apiLimiter, requireAgentManage, async (req, res) => {
  const { agentId } = req.params;
  if (!AGENT_ID_RE.test(agentId)) return res.status(400).json({ error: 'Invalid agent id' });
  const relPath = typeof req.query.path === 'string' ? req.query.path : '';
  try {
    const url = `${CONTEXT_ORCH_URL()}/internal/agents/${encodeURIComponent(agentId)}/context/file`
              + `?path=${encodeURIComponent(relPath)}`;
    const r = await fetch(url, { method: 'DELETE' });
    const body = await r.json().catch(() => ({}));
    res.status(r.status).json(body);
  } catch (err) {
    console.error(`[api] context delete ${agentId} failed: ${err.message}`);
    res.status(502).json({ error: 'Modifying the context folder failed' });
  }
});

// Move (rename/relocate) an entry within ONE read-write context folder. Body:
//   { from: "<rel path>", toDir: "<rel dir path>" } — both relative to the mount.
app.post('/api/agents/:agentId/context/move', apiLimiter, requireAgentManage, async (req, res) => {
  const { agentId } = req.params;
  if (!AGENT_ID_RE.test(agentId)) return res.status(400).json({ error: 'Invalid agent id' });
  const from = typeof req.body?.from === 'string' ? req.body.from : '';
  const toDir = typeof req.body?.toDir === 'string' ? req.body.toDir : '';
  try {
    const url = `${CONTEXT_ORCH_URL()}/internal/agents/${encodeURIComponent(agentId)}/context/move`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, toDir }),
    });
    const body = await r.json().catch(() => ({}));
    res.status(r.status).json(body);
  } catch (err) {
    console.error(`[api] context move ${agentId} failed: ${err.message}`);
    res.status(502).json({ error: 'Modifying the context folder failed' });
  }
});

// Upload one or more files into a read-write context folder. The multipart body
// is parsed here (same multer config + 50 MB cap as the workspace upload); each
// file is then streamed to the orchestrator as a raw octet-stream (no base64
// inflation) which packages it into the container via the archive endpoint.
// Gate ahead of `uploadFiles`, like the workspace upload above.
app.post('/api/agents/:agentId/context/upload', heavyLimiter, requireAgentIdParam, requireAgentManage, uploadFiles, async (req, res) => {
  const { agentId } = req.params;
  if (!AGENT_ID_RE.test(agentId)) return res.status(400).json({ error: 'Invalid agent id' });
  const relDir = typeof req.body.path === 'string' ? req.body.path : '';
  const rawRelPaths = req.body.relativePaths;
  const relPaths = Array.isArray(rawRelPaths) ? rawRelPaths : (rawRelPaths != null ? [rawRelPaths] : []);
  if (!Array.isArray(req.files) || req.files.length === 0) {
    return res.status(400).json({ error: 'No files provided' });
  }
  const uploaded = [];
  const errors = [];
  for (let i = 0; i < req.files.length; i++) {
    const file = req.files[i];
    const name = (typeof relPaths[i] === 'string' && relPaths[i]) ? relPaths[i] : file.originalname;
    try {
      const url = `${CONTEXT_ORCH_URL()}/internal/agents/${encodeURIComponent(agentId)}/context/upload`
                + `?path=${encodeURIComponent(relDir)}&name=${encodeURIComponent(name)}`;
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': file.buffer.length },
        body: file.buffer,
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) {
        errors.push({ name, error: body?.error || `HTTP ${r.status}` });
        continue;
      }
      for (const u of (body.uploaded || [])) uploaded.push(u);
    } catch (err) {
      errors.push({ name, error: err.message });
    }
  }
  if (uploaded.length === 0 && errors.length > 0) {
    return res.status(502).json({ error: 'All uploads failed', details: errors });
  }
  res.json({ uploaded, ...(errors.length ? { errors } : {}) });
});

// Return a filename that doesn't yet exist in `dir`, appending " (n)" before
// the extension on collision so a second upload of `report.pdf` becomes
// `report (2).pdf` rather than clobbering the first. The " ()" chars are within
// the upload filename allowlist, so the result is still a legal workspace name.
function uniqueFileName(dir, name) {
  if (!fs.existsSync(path.join(dir, name))) return name;
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  for (let n = 2; n < 10000; n++) {
    const candidate = `${base} (${n})${ext}`;
    if (!fs.existsSync(path.join(dir, candidate))) return candidate;
  }
  return `${base} (${Date.now()})${ext}`;
}

// Chat attachments: files dropped or picked directly in the chat composer land
// in a dedicated, server-controlled `chat-uploads/` directory (the client can't
// choose the path) and are referenced in the message body as
// `@chat-uploads/<name>`. The agent's cwd is its workspace root, so that token
// resolves to a file it can open. Mirrors the workspace/upload handler's multer
// config + filename sanitisation, but auto-creates the target dir and de-dupes
// colliding names.
const CHAT_UPLOADS_DIR = 'chat-uploads';
app.post('/api/agents/:agentId/chat-upload', heavyLimiter, requireAgentIdParam, uploadFiles, (req, res) => {
  const { agentId } = req.params;
  if (!AGENT_ID_RE.test(agentId)) return res.status(400).json({ error: 'Invalid agent id' });

  // #418/#419/#420 (js/path-injection): a bare AGENT_ID_RE match is not a
  // CodeQL-recognised traversal barrier, so agentId still taints everything
  // derived from the workspace root — targetDir (mkdirSync), the uniqueFileName
  // existsSync probes, and destPath (writeFileSync). Contain it under AGENTS_DIR
  // with the path.relative idiom so the resolved root is clean at every fs sink.
  // The guard never trips for a regex-valid id (AGENT_ID_RE forbids '/' and '..').
  const agentsBaseDir = path.resolve(AGENTS_DIR);
  const agentDir = path.resolve(agentsBaseDir, agentId);
  const relAgentDir = path.relative(agentsBaseDir, agentDir);
  if (relAgentDir.startsWith('..') || path.isAbsolute(relAgentDir)) {
    return res.status(400).json({ error: 'Invalid agent id' });
  }

  let agentRoot;
  try {
    agentRoot = fs.realpathSync(agentDir);
  } catch {
    return res.status(404).json({ error: 'Agent workspace not found' });
  }

  if (!Array.isArray(req.files) || req.files.length === 0) {
    return res.status(400).json({ error: 'No files provided' });
  }

  const targetDir = path.join(agentRoot, CHAT_UPLOADS_DIR);
  try {
    fs.mkdirSync(targetDir, { recursive: true });
  } catch (err) {
    return res.status(500).json({ error: `Could not create upload directory: ${err.message}` });
  }

  const uploaded = [];
  const errors = [];
  for (const file of req.files) {
    const safeName = path.basename(file.originalname).replace(/[^\w\-. ()[\]]/g, '_').trim();
    if (!safeName) {
      errors.push({ name: file.originalname, error: 'Invalid filename' });
      continue;
    }
    const finalName = uniqueFileName(targetDir, safeName);
    const destPath = path.join(targetDir, finalName);
    // Defence-in-depth: the dest must stay strictly inside the agent root.
    if (!destPath.startsWith(agentRoot + path.sep)) {
      errors.push({ name: file.originalname, error: 'Path escapes workspace' });
      continue;
    }
    try {
      fs.writeFileSync(destPath, file.buffer);
      uploaded.push({
        name: finalName,
        ref: `${CHAT_UPLOADS_DIR}/${finalName}`,
        path: path.relative(agentRoot, destPath),
        size: file.size,
      });
    } catch (err) {
      errors.push({ name: file.originalname, error: err.message });
    }
  }

  if (uploaded.length === 0 && errors.length > 0) {
    return res.status(500).json({ error: 'All uploads failed', details: errors });
  }
  res.json({ uploaded, ...(errors.length ? { errors } : {}) });
});

function parseJsonlLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return { type: 'parse_error', raw: line.slice(0, 200) };
  }
}

// Static backfill: read JSONL from `since` (default 0) up to current EOF.
app.get('/api/agents/:agentId/session/:roomId', (req, res) => {
  const { agentId, roomId } = req.params;
  if (!AGENT_ID_RE.test(agentId) || !ROOM_ID_RE.test(roomId)) {
    return res.status(400).json({ error: 'invalid id' });
  }
  const filepath = controlOrAgentPath(agentId, 'sessions', roomId + '.jsonl'); // pushed copy preferred (#185)

  const since = Math.max(0, parseInt(req.query.since, 10) || 0);
  const limit = Math.max(1, parseInt(req.query.limit, 10) || 1000);
  // Optional server-side scope to one session (#544, #555). A session's rows
  // may lie anywhere in a busy room's log — before `since` or past the last-
  // `limit` tail — so when scoping we scan the whole file and filter by
  // correlationId, keeping the whole session regardless of its position. Used
  // for historical-session viewing and for reliably backfilling a long-running
  // session in a chatty room. A finished session groups several runs (#555),
  // so the param may repeat (`?correlationId=a&correlationId=b`) to scope to
  // the combined log of every run in that Claude session; a single value stays
  // backward-compatible. Ids are only ever string-compared, never used in a
  // path/query, so opaque values are safe; cap each length defensively.
  const rawCid = req.query.correlationId;
  const cidList = (Array.isArray(rawCid) ? rawCid : (rawCid == null ? [] : [rawCid]))
    .filter(c => typeof c === 'string' && c && c.length <= 512);
  const correlationIds = cidList.length ? new Set(cidList) : null;

  // When scoping to a session, span rotated archives (#673): the session's
  // rows may have rotated out of the live file. Archives are immutable and
  // read wholesale, so they carry no byte cursor — the returned cursor stays
  // the LIVE file size (the SSE tail's offset). Byte-cursor mode (no scope)
  // stays live-only, so plain tailing is untouched by rotation.
  const archiveEvents = correlationIds
    ? readSessionArchiveEvents(agentId, roomId, parseJsonlLine)
        .filter(ev => ev && correlationIds.has(ev.correlationId))
    : [];

  // Trim a merged event list to the last `limit`, flagging truncation.
  const respond = (evts, cursor) => {
    let out = evts;
    let truncated = false;
    if (out.length > limit) { out = out.slice(out.length - limit); truncated = true; }
    const body = { events: out, cursor };
    if (truncated) body.truncated = true;
    return res.json(body);
  };

  if (!fs.existsSync(filepath)) {
    return respond(archiveEvents, 0);
  }

  let size;
  try {
    size = fs.statSync(filepath).size;
  } catch (err) {
    return res.status(500).json({ error: 'stat failed: ' + err.message });
  }

  // If `since` is past EOF (e.g. file was truncated), read from start. When
  // scoping to a correlationId we always read the whole file (start 0).
  const start = correlationIds ? 0 : (since > size ? 0 : since);
  if (start >= size) {
    return respond(archiveEvents, size);
  }

  const stream = fs.createReadStream(filepath, { start, end: size - 1, encoding: 'utf8' });
  let buf = '';
  let events = [];

  stream.on('data', (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (line.trim()) events.push(parseJsonlLine(line));
    }
  });

  stream.on('error', (err) => {
    res.status(500).json({ error: 'read failed: ' + err.message });
  });

  stream.on('end', () => {
    if (buf.trim()) events.push(parseJsonlLine(buf));
    if (correlationIds) {
      events = events.filter(ev => ev && correlationIds.has(ev.correlationId));
      // Prepend the scoped session's rows that had rotated into archives, so a
      // finished session reads oldest→newest across the rotation boundary.
      events = archiveEvents.concat(events);
    }
    respond(events, size);
  });
});

// Live tail via SSE.
app.get('/api/agents/:agentId/session/:roomId/stream', (req, res) => {
  const { agentId, roomId } = req.params;
  if (!AGENT_ID_RE.test(agentId) || !ROOM_ID_RE.test(roomId)) {
    return res.status(400).json({ error: 'invalid id' });
  }
  const filepath = controlOrAgentPath(agentId, 'sessions', roomId + '.jsonl'); // pushed copy preferred (#185)
  const dirpath = path.dirname(filepath);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  // Initial cursor: explicit `since`, else end-of-file.
  let cursor;
  if (req.query.since !== undefined) {
    cursor = Math.max(0, parseInt(req.query.since, 10) || 0);
  } else {
    try {
      cursor = fs.existsSync(filepath) ? fs.statSync(filepath).size : 0;
    } catch {
      cursor = 0;
    }
  }

  let lineBuf = '';
  let fileWatcher = null;
  let dirWatcher = null;
  let draining = false;
  let pending = false;
  let closed = false;

  const writeEvent = (obj) => {
    try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch { /* noop */ }
  };
  const writeCursor = () => {
    writeEvent({ type: '_cursor', cursor });
  };

  // Initial ready signal + cursor so the client knows where it's positioned.
  try { res.write(': ready\n\n'); } catch { /* noop */ }
  writeCursor();

  // Heartbeat — keep proxies / load balancers from closing the connection.
  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { /* noop */ }
  }, 15000);

  const drain = () => {
    if (closed) return;
    if (draining) { pending = true; return; }
    draining = true;

    let size;
    try {
      if (!fs.existsSync(filepath)) {
        draining = false;
        if (pending) { pending = false; setImmediate(drain); }
        return;
      }
      size = fs.statSync(filepath).size;
    } catch (err) {
      draining = false;
      return;
    }

    // File truncated / rotated externally — start over from the top.
    if (size < cursor) {
      cursor = 0;
      lineBuf = '';
      writeEvent({ type: '_truncated' });
    }
    if (size === cursor) {
      draining = false;
      if (pending) { pending = false; setImmediate(drain); }
      return;
    }

    const stream = fs.createReadStream(filepath, { start: cursor, end: size - 1, encoding: 'utf8' });

    stream.on('data', (chunk) => {
      lineBuf += chunk;
      let idx;
      while ((idx = lineBuf.indexOf('\n')) >= 0) {
        const line = lineBuf.slice(0, idx);
        lineBuf = lineBuf.slice(idx + 1);
        if (line.trim()) writeEvent(parseJsonlLine(line));
      }
    });

    stream.on('error', () => {
      draining = false;
      if (pending) { pending = false; setImmediate(drain); }
    });

    stream.on('end', () => {
      cursor = size;
      writeCursor();
      draining = false;
      if (pending) { pending = false; setImmediate(drain); }
    });
  };

  const startFileWatcher = () => {
    if (fileWatcher || closed) return;
    try {
      fileWatcher = fs.watch(filepath, { persistent: false }, () => drain());
      fileWatcher.on('error', () => {
        try { fileWatcher.close(); } catch { /* noop */ }
        fileWatcher = null;
        // Fall back to dir-watch so we re-pick the file up if it reappears.
        startDirWatcher();
      });
    } catch {
      fileWatcher = null;
      startDirWatcher();
    }
  };

  const startDirWatcher = () => {
    if (dirWatcher || closed) return;
    try {
      fs.mkdirSync(dirpath, { recursive: true });
    } catch { /* noop */ }
    try {
      dirWatcher = fs.watch(dirpath, { persistent: false }, (_evt, fname) => {
        if (closed) return;
        if (fname && fname !== path.basename(filepath)) return;
        if (fs.existsSync(filepath)) {
          try { dirWatcher.close(); } catch { /* noop */ }
          dirWatcher = null;
          startFileWatcher();
          drain();
        }
      });
      dirWatcher.on('error', () => {
        try { dirWatcher.close(); } catch { /* noop */ }
        dirWatcher = null;
      });
    } catch {
      dirWatcher = null;
    }
  };

  if (fs.existsSync(filepath)) {
    startFileWatcher();
    // Read anything that's already past cursor (matters when `since` < EOF).
    drain();
  } else {
    startDirWatcher();
  }

  req.on('close', () => {
    closed = true;
    clearInterval(heartbeat);
    if (fileWatcher) { try { fileWatcher.close(); } catch { /* noop */ } fileWatcher = null; }
    if (dirWatcher) { try { dirWatcher.close(); } catch { /* noop */ } dirWatcher = null; }
    try { res.end(); } catch { /* noop */ }
  });
});

/* ─── SPA fallback ──────────────────────────────────────────────────── */

app.get('*', spaLimiter, (req, res) => {
  if (req.path.startsWith('/api')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(STATIC_DIR, 'index.html'));
});

// One-time idempotent backfill (concept §2, AC5): stamp every existing global
// and team skill that has no skill.json yet with version:1, action:"created".
// Agent-tier skills are stamped lazily on first API read. Re-runs are no-ops —
// a skill that already carries a manifest is skipped. Best-effort per skill so
// it can never block or break startup. This MUST live in the admin-console: it
// is the only side with RW access to the global pool (the orchestrator mounts
// /template-workspace read-only).
function backfillSkillManifests() {
  let stamped = 0;
  const stampDir = (dir) => {
    try {
      if (skillManifest.readManifest(dir)) return; // already stamped
      if (!fs.existsSync(path.join(dir, 'SKILL.md'))) return;
      skillManifest.stampSkillDir(dir, { by: 'operator', action: 'created' });
      stamped++;
    } catch { /* best effort per skill */ }
  };
  try {
    const globalRoot = path.join(POOL_DIR, 'skills');
    for (const name of fs.readdirSync(globalRoot)) {
      if (SKILL_NAME_RE.test(name)) stampDir(path.join(globalRoot, name));
    }
  } catch { /* no global pool */ }
  try {
    const teamsRoot = path.join(WORKSPACE, 'teams');
    for (const teamId of fs.readdirSync(teamsRoot)) {
      if (!POOL_TEAM_ID_RE.test(teamId)) continue;
      let names;
      try { names = fs.readdirSync(path.join(teamsRoot, teamId, 'skills')); } catch { continue; }
      for (const name of names) {
        if (SKILL_NAME_RE.test(name)) stampDir(path.join(teamsRoot, teamId, 'skills', name));
      }
    }
  } catch { /* no team pools */ }
  if (stamped > 0) console.log(`[Admin] Skill manifest backfill stamped ${stamped} skill(s)`);
}

// A crash mid-export leaves its link farm behind, and hard links keep the
// linked file contents alive even after the agent rewrites or deletes them —
// a leaked farm pins real disk, not just inodes. Nothing reads the staging
// root between requests, so anything found at startup is a leftover.
function sweepExportStaging() {
  const stagingRoot = path.join(WORKSPACE, '.export-staging');
  let swept = 0;
  let entries = [];
  try { entries = fs.readdirSync(stagingRoot); } catch { return; }
  for (const entry of entries) {
    try {
      fs.rmSync(path.join(stagingRoot, entry), { recursive: true, force: true });
      swept++;
    } catch { /* noop */ }
  }
  if (swept > 0) console.log(`[Admin] Swept ${swept} leftover export staging dir(s)`);
}

app.listen(4000, '0.0.0.0', () => {
  console.log('[Admin] Listening on :4000');
  // State the authorization mode explicitly (#1457) — and, in single-user mode,
  // warn when named user records exist, since each of them signs in with full
  // visibility while the flag is off.
  console.log(`[Admin] ${authModeLogLine(process.env)}`);
  try {
    const warning = singleUserElevationWarning(readJsonFile(USERS_INDEX, []), process.env);
    if (warning) console.warn(`[Admin] ${warning}`);
  } catch (err) { console.error(`[Admin] Authorization mode check failed: ${err.message}`); }
  try { backfillSkillManifests(); } catch (err) { console.error(`[Admin] Skill manifest backfill failed: ${err.message}`); }
  try { sweepExportStaging(); } catch (err) { console.error(`[Admin] Export staging sweep failed: ${err.message}`); }
  try { backfillDraftAccess(); } catch (err) { console.error(`[Admin] Draft access backfill failed: ${err.message}`); }
  try { startLlmHealthPoller(); } catch (err) { console.error(`[Admin] Model Provider health poller failed to start: ${err.message}`); }
});
