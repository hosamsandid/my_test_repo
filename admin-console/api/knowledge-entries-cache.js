'use strict';

/*
 * Non-blocking, fingerprint-validated reads of a team's KB store (#2920).
 *
 * `GET /api/knowledge/summary` (the Agent Chat learning badge) and
 * `/api/knowledge/review-queue` used to re-read every shard of the team's store
 * with sync `fs` on every call. The store lives on the shared (NFS) volume and
 * has hundreds of small shard files, so one read took ~0.5 s of blocked event
 * loop — every other request of every user waited for it.
 *
 *   - `listStoreFiles` / `readStoreFiles` / `fileSignature` do the IO with
 *     `fs.promises`, so the latency is spent off the event loop.
 *   - `createFingerprintCache` keeps one value per key for as long as its
 *     fingerprint (file sizes + mtimes, plus whatever else the caller folds in)
 *     is unchanged. A write changes the fingerprint, so the next read rebuilds:
 *     no TTL, no stale counts after a write. Concurrent callers with the same
 *     fingerprint share one build.
 *
 * Kept free of api.js state (fs is injectable) per the #651 convention; api.js
 * wires it into gatherTeamEntries.
 */

const nodePath = require('node:path');

const KB_KINDS = ['fact', 'entity', 'convention'];
const KB_DEFAULT_DIRS = { fact: 'facts', entity: 'entities', convention: 'conventions' };

// Kind → { dir, file }, honouring a store's manifest if present, else defaults.
function kbKindDirsFromManifest(m) {
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

async function readJsonOrNull(fsp, file) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); } catch { return null; }
}

// Every file of one store, in read order: per kind its shards, then the
// canonical file. `manifest` is the manifest path (part of the fingerprint —
// it decides which files are read).
async function listStoreFiles(storeRoot, { fsp }) {
  const manifest = nodePath.join(storeRoot, 'knowledge.manifest.json');
  const kinds = kbKindDirsFromManifest(await readJsonOrNull(fsp, manifest));
  const perKind = await Promise.all(kinds.map(async ({ dir, file }) => {
    const kindDir = nodePath.join(storeRoot, dir);
    const shardsDir = nodePath.join(kindDir, 'shards');
    let names = [];
    try { names = (await fsp.readdir(shardsDir)).filter(n => n.endsWith('.jsonl')); } catch { /* none */ }
    const files = names.map(n => nodePath.join(shardsDir, n));
    const canonical = nodePath.join(kindDir, file);
    try { await fsp.access(canonical); files.push(canonical); } catch { /* none */ }
    return files;
  }));
  return { manifest, files: perKind.flat() };
}

// Run `fn` over `items` with at most `limit` in flight, keeping input order.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// `path:size:mtimeMs` per file (`path:-` when missing), in the given order.
// Any append, rewrite, new or removed file changes it.
async function fileSignature(files, { fsp, concurrency = 64 }) {
  const parts = await mapLimit(files, concurrency, async (f) => {
    try {
      const st = await fsp.stat(f);
      return `${f}:${st.size}:${st.mtimeMs}`;
    } catch { return `${f}:-`; }
  });
  return parts.join('\n');
}

// Parse every line of `files` into `entries` (in file order). Unreadable files
// and unparsable lines are skipped, like the sync reader did.
async function readStoreFiles(files, { fsp, parseLine, concurrency = 32 }) {
  const raws = await mapLimit(files, concurrency, async (f) => {
    try { return await fsp.readFile(f, 'utf8'); } catch { return null; }
  });
  const entries = [];
  for (const raw of raws) {
    if (raw == null) continue;
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      const e = parseLine(line);
      if (e) entries.push(e);
    }
  }
  return entries;
}

// One value per key, valid while its fingerprint is unchanged. Concurrent
// callers with the same (key, fingerprint) share one compute; a failed compute
// is not cached. A compute that settles after a newer fingerprint was stored
// does not overwrite it. Oldest keys are evicted past `maxEntries`.
function createFingerprintCache({ maxEntries = 64 } = {}) {
  const store = new Map(); // key -> { fingerprint, value }
  const inflight = new Map(); // key -> { fingerprint, promise }

  function remember(key, fingerprint, value) {
    store.delete(key);
    store.set(key, { fingerprint, value });
    while (store.size > maxEntries) store.delete(store.keys().next().value);
  }

  function get(key, fingerprint, compute) {
    const hit = store.get(key);
    if (hit && hit.fingerprint === fingerprint) return Promise.resolve(hit.value);
    const running = inflight.get(key);
    if (running && running.fingerprint === fingerprint) return running.promise;
    const promise = Promise.resolve().then(compute).then(
      (value) => {
        if (inflight.get(key) === entry) {
          inflight.delete(key);
          remember(key, fingerprint, value);
        }
        return value;
      },
      (err) => {
        if (inflight.get(key) === entry) inflight.delete(key);
        throw err;
      },
    );
    const entry = { fingerprint, promise };
    inflight.set(key, entry);
    return promise;
  }

  return {
    get,
    clear() { store.clear(); inflight.clear(); },
    get size() { return store.size; },
  };
}

module.exports = {
  kbKindDirsFromManifest,
  listStoreFiles,
  fileSignature,
  readStoreFiles,
  createFingerprintCache,
};
