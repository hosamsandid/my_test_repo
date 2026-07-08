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
const STATUSES = ['active', 'merged', 'promoted', 'archived'];

const SCHEMA_VERSION = 1;
const MANIFEST_VERSION = 1;
const DEFAULT_KB_PATH = 'docs/agent-knowledge/';
const DEFAULT_AUTONOMY = 1;

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
  return { ok: errors.length === 0, errors };
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
  'status', 'updatedAt',
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
      repoRef = normalizeRepoRef(repositories[0]);
      warnings.push('knowledgeStore has no repoRef but the environment has multiple repositories — defaulting to the first');
    } else if (repositories.length === 1) {
      repoRef = normalizeRepoRef(repositories[0]);
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
  buildHarvestHint,
};
