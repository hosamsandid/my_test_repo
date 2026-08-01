'use strict';

// Embedding backend behind the convergence `similarity()` seam (#918, Gap 3 of
// the KM future-proofing epic #914).
//
// Convergence was lexical-only (token-set Jaccard): two agents who learned the
// SAME lesson in different words — or different languages (DE ↔ EN) — never
// converged, and the failure was silent. This module supplies meaning-based
// matching as a strictly ADDITIVE layer: linking becomes
// `lexical OR (cosine >= cosineThreshold)`, so with the backend absent or the
// cache empty, behaviour is bit-for-bit today's.
//
// Design (all decided in the ticket):
// - LOCAL model only (multilingual MiniLM-class), operator-provisioned via
//   `AEE_EMBEDDING_MODEL_PATH`; loaded lazily through `@xenova/transformers`
//   (pure JS/WASM feature-extraction pipeline — offline/air-gap-friendly, no
//   hosted API, no Python sidecar). The library + model are NOT part of the
//   default image; until both are present the backend reports
//   `available: false` and everything no-ops.
// - Vectors are DERIVED artifacts: cached per team OUTSIDE the git KB
//   (/workspace/knowledge-vectors/<teamId>.jsonl, one { id, contentHash,
//   vector } per line), recomputable at will, keyed by contentHash so a text
//   edit self-heals. Computed ONLY in the nightly curator backstop — never on
//   the push path (a push must never wait on a model); a fresh entry matches
//   lexically immediately and semantically after the next backstop pass, which
//   re-runs the collector idempotently (stableSuggestionId).
//
// Everything except the model loader is deliberately PURE and unit-tested
// without any model present (repo convention).

const crypto = require('crypto');

// Same clamp posture as the sibling thresholds in knowledge-store.js.
const DEFAULT_COSINE_THRESHOLD = 0.8;

// 12-hex staleness key for one entry text (raw text — normalization is the
// embedder's job, and a whitespace-only edit re-embedding is harmless).
function contentHash(text) {
  return crypto.createHash('sha1').update(String(text == null ? '' : text)).digest('hex').slice(0, 12);
}

function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = Number(a[i]) || 0;
    const y = Number(b[i]) || 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// Map cosine to the [0,1] similarity scale the seam uses. Sentence-embedding
// cosines of unrelated texts hover around 0, not -1 — clamping negatives to 0
// keeps the scale honest (the (c+1)/2 alternative would inflate everything).
function cosineUnit(a, b) {
  return Math.max(0, cosine(a, b));
}

// Tolerant parse of the per-team vector-cache JSONL. A mangled line is skipped,
// never fatal — the cache is derived state, the next backstop pass heals it.
function parseVectorCache(content) {
  const out = [];
  for (const line of String(content == null ? '' : content).split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const obj = JSON.parse(t);
      if (obj && typeof obj === 'object' && typeof obj.id === 'string'
        && typeof obj.contentHash === 'string' && Array.isArray(obj.vector)) {
        out.push(obj);
      }
    } catch { /* skip */ }
  }
  return out;
}

function serializeVectorCache(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map((r) => JSON.stringify({ id: r.id, contentHash: r.contentHash, vector: r.vector }))
    .join('\n') + ((rows && rows.length) ? '\n' : '');
}

/**
 * Plan one backstop embedding pass: which entries need (re-)embedding, which
 * cached rows stay, which vanished ids get pruned. Pure.
 *
 * @param {object[]} args.entries  visible clusterable entries ({ id, text })
 * @param {object[]} args.cache    parsed cache rows ({ id, contentHash, vector })
 * @returns {{ toEmbed: {id, text, contentHash}[], keep: object[], pruned: number }}
 */
function planEmbeddingPass({ entries, cache } = {}) {
  const byId = new Map();
  for (const r of Array.isArray(cache) ? cache : []) byId.set(r.id, r);
  const toEmbed = [];
  const keep = [];
  const liveIds = new Set();
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!e || typeof e.id !== 'string' || typeof e.text !== 'string' || !e.text.trim()) continue;
    if (liveIds.has(e.id)) continue;
    liveIds.add(e.id);
    const hash = contentHash(e.text);
    const cached = byId.get(e.id);
    if (cached && cached.contentHash === hash) keep.push(cached);
    else toEmbed.push({ id: e.id, text: e.text, contentHash: hash });
  }
  const pruned = [...byId.keys()].filter((id) => !liveIds.has(id)).length;
  return { toEmbed, keep, pruned };
}

// Resolve the cache into the { vectors } lookup the convergence seam consumes:
// only rows whose contentHash still matches the entry's CURRENT text count (a
// stale vector must never link on outdated meaning). Returns null when nothing
// usable — the seam treats null as "lexical only", zero overhead.
function buildVectorLookup(cache, entries) {
  const hashById = new Map();
  for (const e of Array.isArray(entries) ? entries : []) {
    if (e && typeof e.id === 'string' && typeof e.text === 'string') {
      hashById.set(e.id, contentHash(e.text));
    }
  }
  const vectors = new Map();
  for (const r of Array.isArray(cache) ? cache : []) {
    if (hashById.get(r.id) === r.contentHash) vectors.set(r.id, r.vector);
  }
  return vectors.size > 0 ? vectors : null;
}

/**
 * Create the (lazy) embedding backend. `available` is decided cheaply up
 * front from the env/model path; the heavy pipeline loads on first embed().
 *
 * @param {object} opts
 * @param {string} [opts.modelPath]  defaults to AEE_EMBEDDING_MODEL_PATH
 * @param {Function} [opts.loadPipeline]  injectable loader (tests) — must
 *   resolve to an async (texts) => number[][] embed function.
 * @returns {{ available: boolean, reason: string|null, embed: (texts: string[]) => Promise<number[][]> }}
 */
function createEmbeddingBackend({ modelPath = process.env.AEE_EMBEDDING_MODEL_PATH, loadPipeline } = {}) {
  const mp = typeof modelPath === 'string' ? modelPath.trim() : '';
  if (!mp) {
    return {
      available: false,
      reason: 'AEE_EMBEDDING_MODEL_PATH not set',
      embed: async () => { throw new Error('embedding backend unavailable'); },
    };
  }
  let pipelinePromise = null;
  const load = loadPipeline || (async () => {
    // Lazy, optional dependency: '@xenova/transformers' is installed by the
    // operator alongside the model, never a package.json dependency (the
    // default image ships without it — ticket decision). A missing library
    // surfaces as a load failure, downgrading this backend to a no-op.
    // eslint-disable-next-line global-require, import/no-unresolved
    const { pipeline, env } = require('@xenova/transformers');
    env.allowRemoteModels = false; // offline only — never phone home
    const extractor = await pipeline('feature-extraction', mp, { local_files_only: true });
    return async (texts) => {
      const out = [];
      for (const t of texts) {
        const res = await extractor(String(t == null ? '' : t), { pooling: 'mean', normalize: true });
        out.push(Array.from(res.data));
      }
      return out;
    };
  });
  return {
    available: true,
    reason: null,
    embed: async (texts) => {
      if (!pipelinePromise) pipelinePromise = load();
      const fn = await pipelinePromise;
      return fn(Array.isArray(texts) ? texts : []);
    },
  };
}

module.exports = {
  DEFAULT_COSINE_THRESHOLD,
  contentHash,
  cosine,
  cosineUnit,
  parseVectorCache,
  serializeVectorCache,
  planEmbeddingPass,
  buildVectorLookup,
  createEmbeddingBackend,
};
