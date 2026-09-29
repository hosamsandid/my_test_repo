'use strict';

// Knowledge-store pure core (Shared Agent Learning & Knowledge Flow, Phase 0).
//
// This module is the schema + config authority for the team Knowledge Base (KB),
// tier T1 of the maturity ladder (T0 memory -> T1 team KB -> T2 skill). It owns:
//   - the KB *entry* shape, with mandatory provenance from day one, and
//     serialize/parse to the on-disk JSONL representation;
//   - the default KB *manifest* (which kind maps to which file);
//   - normalization of the `knowledgeStore` config that rides on an environment;
//   - the 0..3 autonomy dial accessor.
//
// It is deliberately PURE — no fs, no network, no clock beyond an injected `now`
// and an injected id generator — so it is unit-testable without booting the
// orchestrator (repo convention: test pure helper cores only).
//
// Physical layout (open question #1, resolved): one canonical JSONL file per
// kind (facts/facts.jsonl, ...). Each line is a full entry INCLUDING provenance
// and convergence. JSONL wins over front-matter markdown because it makes
// concurrent appends line-atomic/merge-clean and lets Phase 3 update
// convergence[] mechanically; a human-readable markdown digest is a derived
// read view produced later, not a second source of truth.

const crypto = require('crypto');

const KINDS = ['fact', 'entity', 'convention'];
const SOURCE_REF_KINDS = ['pr', 'issue', 'commit', 'branch', 'url'];
// `pending` / `rejected` are overlay statuses stamped by the orchestrator onto
// the canonical <kind>.jsonl when a team runs in supervised-review mode
// (knowledgeReview): a newly-learned canonical entry the operator has not yet
// approved is `pending`; one they rejected is `rejected`. Like `archived`, they
// never originate on an agent shard (agents only ever write `active`) — they are
// a property of the single-writer curated view. Reserved-but-tolerant on read.
const STATUSES = ['active', 'merged', 'promoted', 'archived', 'pending', 'rejected'];

const SCHEMA_VERSION = 1;
const MANIFEST_VERSION = 1;
const DEFAULT_KB_PATH = 'docs/agent-knowledge/';
const DEFAULT_AUTONOMY = 1;

// Convergence detection defaults (Phase 3). simThreshold: lexical Jaccard cutoff
// for "these two facts are the same lesson"; convergenceThreshold: how many
// DISTINCT agents must independently record it before a promotion suggestion is
// raised. convergenceThreshold=2 is a product decision (concept open question #3
// resolved). Both are per-team-overridable via the env `knowledgeConvergence`.
const DEFAULT_SIM_THRESHOLD = 0.6;
const DEFAULT_CONVERGENCE_THRESHOLD = 2;
// Related-theme grouping (thematic aggregation) is deliberately looser than
// same-lesson convergence: distinct lessons about one topic share some
// vocabulary but are not near-duplicates.
const DEFAULT_RELATED_THRESHOLD = 0.3;
// #918: embedding-cosine threshold for the semantic convergence layer —
// mirrors knowledge-embeddings.DEFAULT_COSINE_THRESHOLD.
const DEFAULT_COSINE_THRESHOLD = 0.8;

// Curation / full-autonomy defaults (Phase 4). The promotion transitions the
// gate policy covers, the two gate modes, and their conservative defaults:
// team→team may auto-promote, but anything to the global pool (blast radius, and
// the orchestrator mounts /template-workspace read-only so it CANNOT write it)
// and lifting a private agent skill to the team both default to human review.
const PROMOTION_TRANSITIONS = ['team>team', 'team>global', 'agent>team'];
const GATE_MODES = ['auto', 'review'];
const DEFAULT_PROMOTION_GATES = { 'team>team': 'auto', 'team>global': 'review', 'agent>team': 'review' };
// Auto-resync gate (#629, concept §3.6): the per-team policy for what happens to
// a team's dependent skill copies when a pool skill they descend from is edited.
// `review` (default) = surface a drift badge and wait for an explicit resync;
// `auto` = fan the pool edit out to member workspaces immediately (best-effort,
// event-logged). Conservative default keeps existing teams unchanged — nothing
// enters an agent's context without a human unless the team opts into `auto`.
const DEFAULT_SKILL_RESYNC_MODE = 'review';
// #449 burst-cap parity: at most this many clusters auto-promote in one collector
// pass; the overflow is deferred to review cards (lossless), so flipping the dial
// to level 3 over a large backlog can't emit a flood of skills at once.
const DEFAULT_MAX_AUTO_PROMOTIONS = 3;
// #604: at level 3 the curator also auto-promotes a strong single-role THEME (>=
// this many topically-related durable lessons) to a team skill. Deliberately >
// the theme card floor (strongLessons=3) so a weaker theme still gets human
// review rather than an automatic skill.
const DEFAULT_AUTO_THEME_MIN_LESSONS = 4;
// #779 skill-aggregation Phase 1. Digest-only routing: a single converged
// convention/fact cluster is delivered by the knowledge digest already, so it
// raises NO skill candidate until it "graduates" — i.e. until at least this many
// DISTINCT agents have independently recorded it (convergenceCount). Deliberately
// above DEFAULT_CONVERGENCE_THRESHOLD (2), so ordinary two-agent convergence stays
// digest-only and only a lesson that keeps recurring across the team becomes a
// real candidate. The "more lessons" graduation dimension is served by the theme
// aggregation path (planRelatedSuggestions / theme auto-promotion).
const DEFAULT_DIGEST_GRADUATE_AGENTS = 4;
// #779 curator auto-extend: the minimum matchExistingSkill score for the level-3
// curator to auto-fold a converged cluster into an existing team skill (rather
// than raising a review card that pre-selects extend mode). matchExistingSkill
// weights an entry-id lineage overlap at 100/id and a name-token overlap at 1/token
// (admin-console knowledge-suggestions.matchExistingSkill), so a floor of 100
// means "auto-extend only on a direct provenance-lineage hit"; a mere name
// similarity (< 100) falls back to review. Blast-radius-conservative by design.
const DEFAULT_EXTEND_CONFIDENCE_FLOOR = 100;

// #780 skill-aggregation Phase 2. `domainRouting` (default ON) turns on the
// route-against-domains step (knowledge-routing.js) in the collector — a no-op for
// a team with no confirmed domains, so existing teams are unaffected until they
// seed/bootstrap a domain list. `skillBudget` is the soft per-team cap (~5–15)
// above which a new-domain proposal is pushed into the merge/override flow (§3.5).
const DEFAULT_SKILL_BUDGET = 12;

// #919 automated forgetting. `decayHorizonDays` is the per-team window after
// which an entry with zero retrievals (#915 aggregate, all sources) gets a
// RETIRE-SUGGESTION card — proposals only, the human confirms via the same
// archive path as the manual Retire button (even at autonomy 3). 0 = off.
const DEFAULT_DECAY_HORIZON_DAYS = 60;

// #781 skill-aggregation Phase 3. `distillAfterAmendments` is X: how many amendments
// a skill may accrue before the curator proposes (or, at autonomy 3 + auto gate,
// applies) a distillation pass that re-synthesises the whole document (§3.4). Clamped
// to an integer >= 1.
const DEFAULT_DISTILL_AFTER_AMENDMENTS = 5;

// #2592 domain → skill pipeline. A domain's FIRST skill is only written once its
// queued lessons reach this mass (≥ minLessons converged lessons from ≥ minAgents
// distinct agents); after that every routed lesson extends the one skill. A team
// sets it on its own knowledge config (`domainSkillThreshold`, a per-team key);
// `knowledgeCuration.domainSkillThreshold` on the environment is the fallback.
const DEFAULT_DOMAIN_SKILL_THRESHOLD = Object.freeze({ minLessons: 3, minAgents: 2 });

// Clamp a { minLessons, minAgents } threshold: integers, lessons 1..100, agents
// 1..50; a missing/invalid value falls back to its default.
function normalizeDomainSkillThreshold(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const lessons = Number(r.minLessons);
  const agents = Number(r.minAgents);
  return {
    minLessons: Number.isInteger(lessons) && lessons >= 1 && lessons <= 100 ? lessons : DEFAULT_DOMAIN_SKILL_THRESHOLD.minLessons,
    minAgents: Number.isInteger(agents) && agents >= 1 && agents <= 50 ? agents : DEFAULT_DOMAIN_SKILL_THRESHOLD.minAgents,
  };
}

// ---------------------------------------------------------------------------
// Ids / clock (injectable so tests are deterministic)
// ---------------------------------------------------------------------------

// 12-char hex id, matching the repo-wide `openssl rand -hex 6` convention.
function defaultIdGen() {
  return crypto.randomBytes(6).toString('hex');
}

function defaultNow() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// ---------------------------------------------------------------------------
// Entry construction + validation
// ---------------------------------------------------------------------------

function normalizeSourceRefs(sourceRefs) {
  if (!Array.isArray(sourceRefs)) return [];
  const out = [];
  for (const ref of sourceRefs) {
    if (!ref || typeof ref !== 'object') continue;
    const kind = ref.kind;
    const val = ref.ref;
    if (!SOURCE_REF_KINDS.includes(kind)) continue;
    if (typeof val !== 'string' || val.trim() === '') continue;
    out.push({ kind, ref: val.trim() });
  }
  return out;
}

function normalizeStringArray(arr) {
  if (!Array.isArray(arr)) return [];
  const seen = new Set();
  const out = [];
  for (const v of arr) {
    if (typeof v !== 'string') continue;
    const t = v.trim();
    if (t === '' || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

// Provenance is mandatory (design decision, locked): every entry must carry
// originAgent + teamId + createdAt AND at least one of correlationId /
// sessionId / a non-empty sourceRefs, so any downstream skill can be traced
// back to the agent/session/PR that learned it.
function hasProvenanceLink(entry) {
  return (
    (typeof entry.correlationId === 'string' && entry.correlationId.trim() !== '') ||
    (typeof entry.sessionId === 'string' && entry.sessionId.trim() !== '') ||
    (Array.isArray(entry.sourceRefs) && entry.sourceRefs.length > 0)
  );
}

// Validate a fully-formed entry object. Returns { ok, errors: [] }.
function validateKnowledgeEntry(entry) {
  const errors = [];
  if (!entry || typeof entry !== 'object') {
    return { ok: false, errors: ['entry is not an object'] };
  }
  if (entry.v !== SCHEMA_VERSION) errors.push(`v must be ${SCHEMA_VERSION}`);
  if (typeof entry.id !== 'string' || !/^[0-9a-f]{12}$/.test(entry.id)) {
    errors.push('id must be a 12-char hex string');
  }
  if (!KINDS.includes(entry.kind)) {
    errors.push(`kind must be one of ${KINDS.join('|')}`);
  }
  if (typeof entry.text !== 'string' || entry.text.trim() === '') {
    errors.push('text must be a non-empty string');
  }
  if (typeof entry.originAgent !== 'string' || entry.originAgent.trim() === '') {
    errors.push('originAgent is required (provenance)');
  }
  if (typeof entry.teamId !== 'string' || entry.teamId.trim() === '') {
    errors.push('teamId is required (provenance)');
  }
  if (typeof entry.createdAt !== 'string' || entry.createdAt.trim() === '') {
    errors.push('createdAt is required (provenance)');
  }
  if (!hasProvenanceLink(entry)) {
    errors.push('at least one of correlationId, sessionId or sourceRefs is required (provenance)');
  }
  if (!Array.isArray(entry.convergence) || entry.convergence.length === 0) {
    errors.push('convergence must be a non-empty array');
  }
  if (!STATUSES.includes(entry.status)) {
    errors.push(`status must be one of ${STATUSES.join('|')}`);
  }
  if (entry.summary !== undefined && typeof entry.summary !== 'string') {
    errors.push('summary must be a string when present');
  }
  // Bitemporal validity (#916). All three are optional — an entry without them
  // behaves exactly as before (validFrom semantically defaults to createdAt;
  // never backfilled onto materialized lines). Expiry is a FIELD, not a status:
  // readers derive "expired" from validTo, so STATUSES stays untouched.
  if (entry.validFrom !== undefined && (typeof entry.validFrom !== 'string' || entry.validFrom.trim() === '')) {
    errors.push('validFrom must be a non-empty string when present');
  }
  if (entry.validTo !== undefined && (typeof entry.validTo !== 'string' || entry.validTo.trim() === '')) {
    errors.push('validTo must be a non-empty string when present');
  }
  if (entry.supersededBy !== undefined && (typeof entry.supersededBy !== 'string' || !/^[0-9a-f]{12}$/.test(entry.supersededBy))) {
    errors.push('supersededBy must be a 12-char hex entry id when present');
  }
  // Scoped auto-load triggers (#917). Optional — an entry without them behaves
  // exactly as today; when present, each trigger is { type: keyword|path,
  // pattern }. Operator-authored (sidecar-overlaid, like validity), matched at
  // invocation time by the Python-side scoped-knowledge resolver.
  if (entry.loadTriggers !== undefined) {
    if (!Array.isArray(entry.loadTriggers)) {
      errors.push('loadTriggers must be an array when present');
    } else {
      for (const t of entry.loadTriggers) {
        if (!t || typeof t !== 'object' || !LOAD_TRIGGER_TYPES.includes(t.type)
          || typeof t.pattern !== 'string' || t.pattern.trim() === '') {
          errors.push(`loadTriggers entries must be { type: ${LOAD_TRIGGER_TYPES.join('|')}, pattern: <non-empty> }`);
          break;
        }
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

// #917: the closed trigger-type set + a normalizer shared by the sidecar writer.
// Returns a clean array (deduped, trimmed) or null when nothing valid remains.
const LOAD_TRIGGER_TYPES = ['keyword', 'path'];
function normalizeLoadTriggers(input) {
  if (!Array.isArray(input)) return null;
  const seen = new Set();
  const out = [];
  for (const t of input) {
    if (!t || typeof t !== 'object') continue;
    const type = LOAD_TRIGGER_TYPES.includes(t.type) ? t.type : null;
    const pattern = typeof t.pattern === 'string' ? t.pattern.trim() : '';
    if (!type || !pattern) continue;
    const key = `${type}:${pattern.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ type, pattern });
  }
  return out.length > 0 ? out : null;
}

// Build a validated KB entry with defaults filled in. Throws on invalid input
// so callers can't silently produce an unprovenanced entry.
function makeKnowledgeEntry(input = {}, { idGen = defaultIdGen, now = defaultNow } = {}) {
  const kind = input.kind;
  if (!KINDS.includes(kind)) {
    throw new Error(`makeKnowledgeEntry: kind must be one of ${KINDS.join('|')}`);
  }
  const text = typeof input.text === 'string' ? input.text.trim() : '';
  if (text === '') {
    throw new Error('makeKnowledgeEntry: text must be a non-empty string');
  }

  const originAgent = typeof input.originAgent === 'string' ? input.originAgent.trim() : '';
  const teamId = typeof input.teamId === 'string' ? input.teamId.trim() : '';
  const sourceRefs = normalizeSourceRefs(input.sourceRefs);

  const entry = {
    v: SCHEMA_VERSION,
    id: typeof input.id === 'string' && /^[0-9a-f]{12}$/.test(input.id) ? input.id : idGen(),
    kind,
    text,
    originAgent,
    teamId,
    createdAt: typeof input.createdAt === 'string' && input.createdAt.trim() !== ''
      ? input.createdAt.trim()
      : now(),
    convergence: normalizeStringArray(
      Array.isArray(input.convergence) && input.convergence.length > 0
        ? input.convergence
        : [originAgent],
    ),
    status: STATUSES.includes(input.status) ? input.status : 'active',
  };

  // Optional provenance links — only emitted when present.
  if (typeof input.correlationId === 'string' && input.correlationId.trim() !== '') {
    entry.correlationId = input.correlationId.trim();
  }
  if (typeof input.sessionId === 'string' && input.sessionId.trim() !== '') {
    entry.sessionId = input.sessionId.trim();
  }
  if (sourceRefs.length > 0) entry.sourceRefs = sourceRefs;

  // Optional descriptive fields.
  const tags = normalizeStringArray(input.tags);
  if (tags.length > 0) entry.tags = tags;
  if (typeof input.updatedAt === 'string' && input.updatedAt.trim() !== '') {
    entry.updatedAt = input.updatedAt.trim();
  }
  // Optional human-readable summary (distinct from the agent-facing `text`).
  // Written only by the orchestrator's summary-backfill path, never the agent CLI.
  if (typeof input.summary === 'string' && input.summary.trim() !== '') {
    entry.summary = input.summary.trim();
  }
  // Bitemporal validity (#916) — optional; absent ⇒ semantics identical to today
  // (validFrom defaults to createdAt at READ time; nothing is backfilled).
  if (typeof input.validFrom === 'string' && input.validFrom.trim() !== '') {
    entry.validFrom = input.validFrom.trim();
  }
  if (typeof input.validTo === 'string' && input.validTo.trim() !== '') {
    entry.validTo = input.validTo.trim();
  }
  if (typeof input.supersededBy === 'string' && /^[0-9a-f]{12}$/.test(input.supersededBy)) {
    entry.supersededBy = input.supersededBy;
  }
  // Scoped auto-load triggers (#917) — normalized, emitted only when non-empty.
  const triggers = normalizeLoadTriggers(input.loadTriggers);
  if (triggers) entry.loadTriggers = triggers;

  const { ok, errors } = validateKnowledgeEntry(entry);
  if (!ok) {
    throw new Error(`makeKnowledgeEntry: invalid entry — ${errors.join('; ')}`);
  }
  return entry;
}

// ---------------------------------------------------------------------------
// Serialize / parse (on-disk JSONL representation)
// ---------------------------------------------------------------------------

// Stable key order so git diffs are minimal and predictable line-to-line.
const KEY_ORDER = [
  'v', 'id', 'kind', 'text', 'originAgent', 'teamId', 'createdAt',
  'correlationId', 'sessionId', 'sourceRefs', 'convergence', 'tags',
  'status', 'updatedAt', 'summary', 'validFrom', 'validTo', 'supersededBy',
  'loadTriggers',
];

function serializeEntry(entry) {
  const ordered = {};
  for (const k of KEY_ORDER) {
    if (entry[k] !== undefined) ordered[k] = entry[k];
  }
  // Preserve any forward-compat fields we don't know about, after the known ones.
  for (const k of Object.keys(entry)) {
    if (!(k in ordered)) ordered[k] = entry[k];
  }
  return JSON.stringify(ordered);
}

// Tolerant parse of one JSONL line — mirrors aee-artifact's read_entries:
// a hand-mangled line returns null rather than crashing a whole harvest.
function parseEntry(line) {
  if (typeof line !== 'string') return null;
  const trimmed = line.trim();
  if (trimmed === '') return null;
  try {
    const obj = JSON.parse(trimmed);
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
    return obj;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

function buildDefaultManifest() {
  return {
    manifestVersion: MANIFEST_VERSION,
    schemaVersion: SCHEMA_VERSION,
    kinds: {
      fact: { dir: 'facts', file: 'facts.jsonl' },
      entity: { dir: 'entities', file: 'entities.jsonl' },
      convention: { dir: 'conventions', file: 'conventions.jsonl' },
    },
  };
}

function validateManifest(m) {
  const errors = [];
  if (!m || typeof m !== 'object') {
    return { ok: false, errors: ['manifest is not an object'] };
  }
  if (typeof m.manifestVersion !== 'number') errors.push('manifestVersion must be a number');
  if (typeof m.schemaVersion !== 'number') errors.push('schemaVersion must be a number');
  if (!m.kinds || typeof m.kinds !== 'object') {
    errors.push('kinds must be an object');
  } else {
    for (const kind of KINDS) {
      const k = m.kinds[kind];
      if (!k || typeof k !== 'object') {
        errors.push(`kinds.${kind} missing`);
        continue;
      }
      if (typeof k.dir !== 'string' || k.dir.trim() === '') errors.push(`kinds.${kind}.dir must be a string`);
      if (typeof k.file !== 'string' || k.file.trim() === '') errors.push(`kinds.${kind}.file must be a string`);
    }
  }
  return { ok: errors.length === 0, errors };
}

// Store-root-relative path to the JSONL file backing a kind, e.g.
// kindFilePath(manifest, 'fact') -> 'facts/facts.jsonl'.
function kindFilePath(manifest, kind) {
  const m = manifest && manifest.kinds ? manifest.kinds[kind] : null;
  if (!m || typeof m.dir !== 'string' || typeof m.file !== 'string') {
    throw new Error(`kindFilePath: manifest has no entry for kind '${kind}'`);
  }
  return `${m.dir.replace(/\/+$/, '')}/${m.file}`;
}

// ---------------------------------------------------------------------------
// knowledgeStore config (rides on environment.json) + autonomy dial
// ---------------------------------------------------------------------------

function normalizeRepoRef(repoRef) {
  if (!repoRef || typeof repoRef !== 'object') return null;
  const url = typeof repoRef.url === 'string' ? repoRef.url.trim() : '';
  if (url === '') return null;
  const out = { url };
  if (typeof repoRef.branch === 'string' && repoRef.branch.trim() !== '') out.branch = repoRef.branch.trim();
  if (typeof repoRef.sshKeyId === 'string' && repoRef.sshKeyId.trim() !== '') out.sshKeyId = repoRef.sshKeyId.trim();
  if (typeof repoRef.githubTokenId === 'string' && repoRef.githubTokenId.trim() !== '') {
    out.githubTokenId = repoRef.githubTokenId.trim();
  }
  return out;
}

// Adopt an environment *code* repository as the in-repo KB target when the team
// hasn't configured its own repoRef. We take only the url + credentials — never
// the repo's own `branch`, which is the CODE branch (e.g. main): the KB lives on
// a SEPARATE branch (the configurable default `agent-knowledge`), so leaving the
// branch unset lets resolveKnowledgeBranch fall back to that default. Copying the
// code branch here would silently push knowledge onto the code branch (#558 AC-6).
function adoptRepoForKnowledge(repo) {
  if (!repo || typeof repo !== 'object') return null;
  return normalizeRepoRef({ url: repo.url, sshKeyId: repo.sshKeyId, githubTokenId: repo.githubTokenId });
}

// Normalize the `knowledgeStore` block on an environment into a stable shape.
// Absent/legacy ⇒ safe defaults (in-repo, docs/agent-knowledge/, no repoRef,
// no MCP sources) so behaviour is unchanged for envs that never heard of it.
// Returns { store, warnings }.
function normalizeKnowledgeStore(env, { defaultPath = DEFAULT_KB_PATH } = {}) {
  const warnings = [];
  const raw = env && typeof env.knowledgeStore === 'object' && env.knowledgeStore
    ? env.knowledgeStore
    : {};

  const mode = raw.mode === 'own-repo' ? 'own-repo' : 'in-repo';
  let pathVal = typeof raw.path === 'string' && raw.path.trim() !== '' ? raw.path.trim() : defaultPath;
  if (!pathVal.endsWith('/')) pathVal += '/';

  let repoRef = normalizeRepoRef(raw.repoRef);

  const repositories = env && Array.isArray(env.repositories) ? env.repositories : [];

  if (mode === 'own-repo') {
    if (!repoRef) warnings.push('knowledgeStore mode "own-repo" requires a repoRef with a url');
  } else {
    // in-repo: repoRef (if given) selects WHICH repo the KB lives in.
    if (repoRef) {
      const match = repositories.find((r) => r && r.url === repoRef.url);
      if (!match) warnings.push(`knowledgeStore.repoRef.url "${repoRef.url}" is not among the environment's repositories`);
    } else if (repositories.length > 1) {
      repoRef = adoptRepoForKnowledge(repositories[0]);
      warnings.push('knowledgeStore has no repoRef but the environment has multiple repositories — defaulting to the first');
    } else if (repositories.length === 1) {
      repoRef = adoptRepoForKnowledge(repositories[0]);
    }
  }

  const sources = Array.isArray(raw.sources) ? raw.sources : [];

  return {
    store: { mode, path: pathVal, repoRef: repoRef || null, sources },
    warnings,
  };
}

// 0..3 autonomy dial, per team (rides on the environment the team shares).
// Default 1 ("Share"); level 0 reproduces today's behaviour. Clamped.
function knowledgeAutonomyLevel(env) {
  const raw = env ? env.knowledgeAutonomy : undefined;
  const n = Number(raw);
  if (!Number.isInteger(n)) return DEFAULT_AUTONOMY;
  if (n < 0) return 0;
  if (n > 3) return 3;
  return n;
}

// Supervised-review mode (opt-in, per team, rides on the shared environment).
// When true, a newly-learned canonical KB entry is held as `pending` and does
// NOT enter the curated team KB — nor become promotable — until a human approves
// it (a rejected one is hidden like an archive). Default false ⇒ today's
// behaviour byte-for-byte (harvests flow straight into the shared KB). Orthogonal
// to the 0..3 autonomy dial: it gates WHAT enters the KB, the dial gates HOW MUCH
// automation acts on it. Accepts a boolean, or the string "true"/"1" for tolerant
// hand-edited configs.
function knowledgeReviewEnabled(env) {
  const raw = env ? env.knowledgeReview : undefined;
  if (raw === true) return true;
  if (typeof raw === 'string') return raw === 'true' || raw === '1';
  return false;
}

// Convergence config (Phase 3), read off the environment the team shares.
// Clamped with safe defaults so any legacy env (no `knowledgeConvergence`)
// behaves as { simThreshold: 0.6, convergenceThreshold: 2 } — no behaviour
// change until the collector reads it. simThreshold clamps to [0,1];
// convergenceThreshold to an integer >= 2 ("independent" needs at least two).
function knowledgeConvergenceConfig(env) {
  const raw = env && typeof env.knowledgeConvergence === 'object' && env.knowledgeConvergence
    ? env.knowledgeConvergence
    : {};
  let sim = Number(raw.simThreshold);
  if (!Number.isFinite(sim)) sim = DEFAULT_SIM_THRESHOLD;
  if (sim < 0) sim = 0;
  if (sim > 1) sim = 1;
  let conv = Number(raw.convergenceThreshold);
  if (!Number.isInteger(conv) || conv < 2) conv = DEFAULT_CONVERGENCE_THRESHOLD;
  let rel = Number(raw.relatedThreshold);
  if (!Number.isFinite(rel)) rel = DEFAULT_RELATED_THRESHOLD;
  if (rel < 0) rel = 0;
  if (rel > 1) rel = 1;
  // #918: embedding-cosine link threshold (same clamp posture). Only consulted
  // when the semantic layer has vectors — irrelevant (but stable) otherwise.
  let cos = Number(raw.cosineThreshold);
  if (!Number.isFinite(cos)) cos = DEFAULT_COSINE_THRESHOLD;
  if (cos < 0) cos = 0;
  if (cos > 1) cos = 1;
  return { simThreshold: sim, convergenceThreshold: conv, relatedThreshold: rel, cosineThreshold: cos };
}

// Resolve the per-team decay horizon (#919), read off the (override-merged)
// environment. 0 disables the sweep; a missing/invalid value falls back to the
// default 60 so existing teams get forgetting-proposals without any config
// change (AC5). Clamped to a non-negative integer.
function resolveDecayHorizonDays(env) {
  const raw = env && env.decayHorizonDays;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) return DEFAULT_DECAY_HORIZON_DAYS;
  return n;
}

// Resolve the per-team, per-transition promotion gate policy (Phase 4), read off
// the environment the team shares. Absent transition ⇒ its conservative default;
// a present-but-invalid mode ⇒ "review" (fail-safe: an unrecognised policy never
// silently auto-promotes). team→global is ALWAYS forced to "review" regardless of
// the stored value — there is no code path that auto-writes the read-only global
// pool, so the highest-blast-radius transition stays human-gated by construction.
function resolvePromotionGates(env) {
  const raw = env && typeof env.knowledgePromotionGates === 'object' && env.knowledgePromotionGates
    ? env.knowledgePromotionGates
    : {};
  const out = {};
  for (const t of PROMOTION_TRANSITIONS) {
    if (!(t in raw)) { out[t] = DEFAULT_PROMOTION_GATES[t]; continue; }
    out[t] = GATE_MODES.includes(raw[t]) ? raw[t] : 'review';
  }
  out['team>global'] = 'review';
  return out;
}

// Resolve the per-team skill auto-resync gate (#629 AC5), read off the
// environment the team shares — a sibling of resolvePromotionGates and, like it,
// fail-safe: a present-but-invalid mode falls back to the conservative default
// (`review`). `review` (the default) means editing a source skill only FLIPS the
// dependent copies to `outdated` and waits for a human to resync; `auto` lets the
// edit fan out to `outdated` copies in the same pass. Only the `outdated` state
// is ever touched (see skill-manifest.isResyncable) — `diverged`/`conflict`
// copies are never auto-overwritten regardless of this mode.
function resolveSkillResyncMode(env) {
  const raw = env && typeof env.skillResyncMode === 'string' ? env.skillResyncMode : null;
  return GATE_MODES.includes(raw) ? raw : DEFAULT_SKILL_RESYNC_MODE;
}

// Curation config (Phase 4), read off the environment the team shares — so it is
// per-team (each team has its own shared env), exactly like maxAutoPromotionsPerPass.
// Clamped with safe defaults so any legacy env (no `knowledgeCuration`) behaves as
// { maxAutoPromotionsPerPass: 3, autoThemeMinLessons: 4 } — existing teams gain
// the #604 theme auto-promotion behaviour without any config change, nothing
// breaks. Each value clamps to an integer >= 1.
function knowledgeCurationConfig(env) {
  const raw = env && typeof env.knowledgeCuration === 'object' && env.knowledgeCuration
    ? env.knowledgeCuration
    : {};
  let cap = Number(raw.maxAutoPromotionsPerPass);
  if (!Number.isInteger(cap) || cap < 1) cap = DEFAULT_MAX_AUTO_PROMOTIONS;
  let autoThemeMinLessons = Number(raw.autoThemeMinLessons);
  if (!Number.isInteger(autoThemeMinLessons) || autoThemeMinLessons < 1) {
    autoThemeMinLessons = DEFAULT_AUTO_THEME_MIN_LESSONS;
  }
  // #779 digest-only routing (default ON — set knowledgeCuration.digestRouting to
  // false to opt out) + its per-team graduation threshold (clamped to an integer
  // strictly above the convergence threshold so a graduation is always possible).
  const dr = raw.digestRouting;
  const digestRouting = dr === false || dr === 'off' ? false
    : (dr && typeof dr === 'object' && dr.enabled === false ? false : true);
  let graduateAtAgents = Number(dr && typeof dr === 'object' ? dr.graduateAtAgents : raw.digestGraduateAtAgents);
  if (!Number.isInteger(graduateAtAgents) || graduateAtAgents <= DEFAULT_CONVERGENCE_THRESHOLD) {
    graduateAtAgents = DEFAULT_DIGEST_GRADUATE_AGENTS;
  }
  // #779 curator auto-extend. `autoExtend` defaults to null ("follow the autonomy
  // dial" — the collector enables it at level >= 3); an explicit boolean overrides.
  // The confidence floor clamps to a finite number >= 1 (see DEFAULT_EXTEND_CONFIDENCE_FLOOR).
  const ae = raw.autoExtend;
  let autoExtend = null;
  if (ae === false || ae === 'off') autoExtend = false;
  else if (ae === true || ae === 'on') autoExtend = true;
  else if (ae && typeof ae === 'object' && typeof ae.enabled === 'boolean') autoExtend = ae.enabled;
  let extendConfidenceFloor = Number(ae && typeof ae === 'object' ? ae.confidenceFloor : raw.extendConfidenceFloor);
  if (!Number.isFinite(extendConfidenceFloor) || extendConfidenceFloor < 1) {
    extendConfidenceFloor = DEFAULT_EXTEND_CONFIDENCE_FLOOR;
  }
  // #780 domain routing (default ON — set knowledgeCuration.domainRouting to false
  // to opt out) + the soft per-team skill budget (clamped to an integer >= 1).
  const drt = raw.domainRouting;
  const domainRouting = drt === false || drt === 'off' ? false
    : (drt && typeof drt === 'object' && drt.enabled === false ? false : true);
  let skillBudget = Number(raw.skillBudget);
  if (!Number.isInteger(skillBudget) || skillBudget < 1) skillBudget = DEFAULT_SKILL_BUDGET;
  // #780 default synthesis on SKILL.md writes (§3.3). Opt-in per team for now
  // (default OFF) because the collector's LLM transport is best-effort and unproven
  // in every deployment: OFF = the Phase-1 heuristic draft is written verbatim
  // (backward-compatible); ON = the write runs the LLM synthesis contract and, on
  // failure, falls back to the heuristic VISIBLY MARKED un-synthesised + re-queued.
  const ss = raw.synthesizeSkills;
  const synthesizeSkills = ss === true || ss === 'on'
    || (ss && typeof ss === 'object' && ss.enabled === true) || false;
  // #781 distillation cadence (X amendments before a distillation is due).
  let distillAfterAmendments = Number(raw.distillAfterAmendments);
  if (!Number.isInteger(distillAfterAmendments) || distillAfterAmendments < 1) {
    distillAfterAmendments = DEFAULT_DISTILL_AFTER_AMENDMENTS;
  }
  // #2592: the per-team value (a TEAM_KNOWLEDGE_KEYS override) wins over the env's.
  const domainSkillThreshold = normalizeDomainSkillThreshold(
    env && env.domainSkillThreshold && typeof env.domainSkillThreshold === 'object'
      ? env.domainSkillThreshold
      : raw.domainSkillThreshold,
  );
  return {
    maxAutoPromotionsPerPass: cap,
    autoThemeMinLessons,
    digestRouting,
    graduateAtAgents,
    autoExtend,
    extendConfidenceFloor,
    domainRouting,
    skillBudget,
    synthesizeSkills,
    distillAfterAmendments,
    domainSkillThreshold,
  };
}

// The per-session harvest instruction woven into the agent's memory hint
// (Shared Agent Learning, Phase 1). Pure + gated on the autonomy dial: level 0
// (or a non-int) returns '' so the surrounding hint is exactly today's text —
// this IS autonomy level 0 == today. Level >= 1 asks the agent to also record
// durable, team-useful lessons in the shared KB via the `knowledge` CLI.
//
// Kept byte-identical to agent-entrypoint.py `build_harvest_hint` (the live
// runtime); agent-runner.js is the legacy reference and consumes this so the
// two never drift.
function buildHarvestHint(autonomyLevel) {
  if (!Number.isInteger(autonomyLevel) || autonomyLevel < 1) return '';
  return (
    ' In addition to your memory files, share durable lessons with your ' +
    'teammates through the team knowledge base. For each insight that would ' +
    'help ANY teammate on this repo (a project convention, an environment ' +
    'fact, a key entity) run: knowledge add fact|entity|convention ' +
    '"<one-line statement>". Provenance is attached automatically — record ' +
    'only lessons that hold beyond this one run, no PR/issue-specific ' +
    'detail. First run knowledge search "<topic>" to avoid restating ' +
    'something already recorded. Nothing durable to add: skip it.'
  );
}

// ---------------------------------------------------------------------------
// Per-team knowledge configuration overlay (#570)
// ---------------------------------------------------------------------------

// The knowledge configuration groups that are keyed PER TEAM, not per
// environment: the 0..3 autonomy dial, supervised-review mode, the per-transition
// promotion gates, and the storage location. Historically all four rode on the
// environment record (`environment.json`), so two teams sharing one env collapsed
// onto one set of values. They now live in a per-team overrides document; this
// list is the single authority for which keys are team-owned (used by both the
// orchestrator writers and the admin-console read path).
const TEAM_KNOWLEDGE_KEYS = ['knowledgeAutonomy', 'knowledgeReview', 'knowledgePromotionGates', 'knowledgeStore', 'skillResyncMode', 'decayHorizonDays', 'domainSkillThreshold'];

// Overlay a team's knowledge-config overrides onto its environment, producing an
// env-shaped object the existing pure readers (knowledgeAutonomyLevel,
// knowledgeReviewEnabled, resolvePromotionGates, normalizeKnowledgeStore, …)
// consume unchanged. Only the TEAM_KNOWLEDGE_KEYS are overlaid; every other env
// field (repositories, knowledgeConvergence, …) passes through untouched.
//
// Migration (#570 AC-2) is lazy copy-on-write: a team whose overrides document
// is absent (or omits a key) falls back to the env's value, so a read
// immediately after the upgrade is byte-identical to before. A write records the
// key on the team's own overrides, and from then on that team resolves
// independently of the env and of sibling teams (AC-1/AC-4).
function mergeTeamKnowledgeConfig(baseEnv, overrides) {
  const ov = overrides && typeof overrides === 'object' ? overrides : {};
  const hasOverride = TEAM_KNOWLEDGE_KEYS.some((k) => Object.prototype.hasOwnProperty.call(ov, k));
  if (!hasOverride) return baseEnv;
  const merged = baseEnv && typeof baseEnv === 'object' ? { ...baseEnv } : {};
  for (const k of TEAM_KNOWLEDGE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(ov, k)) merged[k] = ov[k];
  }
  return merged;
}

module.exports = {
  KINDS,
  SOURCE_REF_KINDS,
  STATUSES,
  SCHEMA_VERSION,
  MANIFEST_VERSION,
  DEFAULT_KB_PATH,
  DEFAULT_AUTONOMY,
  makeKnowledgeEntry,
  validateKnowledgeEntry,
  serializeEntry,
  parseEntry,
  buildDefaultManifest,
  validateManifest,
  kindFilePath,
  normalizeKnowledgeStore,
  knowledgeAutonomyLevel,
  knowledgeReviewEnabled,
  knowledgeConvergenceConfig,
  resolvePromotionGates,
  resolveSkillResyncMode,
  resolveDecayHorizonDays,
  DEFAULT_DECAY_HORIZON_DAYS,
  LOAD_TRIGGER_TYPES,
  normalizeLoadTriggers,
  knowledgeCurationConfig,
  buildHarvestHint,
  TEAM_KNOWLEDGE_KEYS,
  mergeTeamKnowledgeConfig,
  DEFAULT_SIM_THRESHOLD,
  DEFAULT_CONVERGENCE_THRESHOLD,
  DEFAULT_MAX_AUTO_PROMOTIONS,
  DEFAULT_AUTO_THEME_MIN_LESSONS,
  DEFAULT_DIGEST_GRADUATE_AGENTS,
  DEFAULT_EXTEND_CONFIDENCE_FLOOR,
  DEFAULT_SKILL_BUDGET,
  DEFAULT_DISTILL_AFTER_AMENDMENTS,
  DEFAULT_DOMAIN_SKILL_THRESHOLD,
  normalizeDomainSkillThreshold,
  PROMOTION_TRANSITIONS,
  GATE_MODES,
  DEFAULT_PROMOTION_GATES,
  DEFAULT_SKILL_RESYNC_MODE,
};
