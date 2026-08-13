// Build-time contributors list for the About page (#1742). The contributor
// set is derived from the repository git history at build time (see
// admin-console/vite.config.js + the GIT_CONTRIBUTORS build arg wired through
// the Makefile / docker-compose.yml / Dockerfile for the no-git Docker build
// context) and embedded into the bundle as import.meta.env.VITE_CONTRIBUTORS
// (base64 of a JSON string[]); there is no runtime lookup.
//
// This module is React-free and unit-tested (admin-console-src CI job). It owns:
//   - extractContributors(rawGitLog): git `%aN\t%aE` lines -> deduped, ordered
//     display names. De-duplication (AC4) unions identities that share an email
//     OR a name, so the same person committing under several email addresses or
//     name spellings collapses to one entry.
//   - encodeContributors / decodeContributors: the base64<->string[] interchange
//     used to move the list through the build-arg / import.meta.env boundary
//     without worrying about names containing commas, angle brackets, "[bot]",
//     or non-ASCII characters.

// --- de-duplication + extraction ---------------------------------------------

// Score a candidate display name so the most human-readable spelling wins as the
// canonical name for a merged identity. A full name with a space beats a bare
// slug like "agent-studio-2-0-developer" or "k-zyskowski_accent"; among spaced
// names a comma-free "Firstname Lastname" reads more naturally than
// "Lastname, First". Ties break lexicographically for determinism.
function nameScore(name) {
  const hasSpace = /\s/.test(name);
  const hasComma = name.includes(',');
  return (hasSpace ? 2 : 0) + (!hasComma ? 1 : 0);
}

function pickCanonical(names) {
  return names.slice().sort((a, b) => {
    const d = nameScore(b) - nameScore(a);
    if (d !== 0) return d;
    return a.localeCompare(b);
  })[0];
}

// Minimal union-find keyed by an arbitrary string.
function makeUnionFind() {
  const parent = new Map();
  function find(x) {
    if (!parent.has(x)) parent.set(x, x);
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root);
    // path-compression
    let cur = x;
    while (parent.get(cur) !== root) {
      const next = parent.get(cur);
      parent.set(cur, root);
      cur = next;
    }
    return root;
  }
  function union(a, b) {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }
  return { find, union };
}

/**
 * Turn raw `git log --format='%aN\t%aE'` output into the deduped, alphabetically
 * ordered list of contributor display names.
 *
 * @param {string} rawGitLog one identity per line, name and email tab-separated.
 * @returns {string[]} canonical display names, de-duplicated, sorted case-insensitively.
 */
export function extractContributors(rawGitLog) {
  if (!rawGitLog || typeof rawGitLog !== 'string') return [];

  const identities = [];
  for (const line of rawGitLog.split('\n')) {
    if (!line.trim()) continue;
    const tab = line.indexOf('\t');
    const name = (tab === -1 ? line : line.slice(0, tab)).trim();
    const email = (tab === -1 ? '' : line.slice(tab + 1)).trim();
    if (!name) continue;
    identities.push({ name, email });
  }
  if (identities.length === 0) return [];

  // Union identities that share a name OR a (non-empty) email. Prefix the keys so
  // a name can never accidentally collide with an email in the union-find map.
  const uf = makeUnionFind();
  const nodeKey = (i) => `i:${i}`;
  const byName = new Map();
  const byEmail = new Map();
  identities.forEach((id, i) => {
    const nameK = id.name.toLowerCase();
    const emailK = id.email.toLowerCase();
    if (byName.has(nameK)) uf.union(nodeKey(byName.get(nameK)), nodeKey(i));
    else byName.set(nameK, i);
    if (emailK) {
      if (byEmail.has(emailK)) uf.union(nodeKey(byEmail.get(emailK)), nodeKey(i));
      else byEmail.set(emailK, i);
    }
  });

  // Collect each person's candidate names, then pick a canonical spelling.
  const groups = new Map();
  identities.forEach((id, i) => {
    const root = uf.find(nodeKey(i));
    if (!groups.has(root)) groups.set(root, new Set());
    groups.get(root).add(id.name);
  });

  const names = [];
  for (const set of groups.values()) names.push(pickCanonical([...set]));

  return names
    .filter((n, i) => names.indexOf(n) === i)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

// --- base64 <-> string[] interchange -----------------------------------------

/** Encode a name list to a base64 JSON string (build side, runs under Node). */
export function encodeContributors(names) {
  const json = JSON.stringify(Array.isArray(names) ? names : []);
  if (typeof Buffer !== 'undefined') return Buffer.from(json, 'utf8').toString('base64');
  // Browser fallback (not used at build time, kept for completeness).
  const bytes = new TextEncoder().encode(json);
  let bin = '';
  bytes.forEach((b) => { bin += String.fromCharCode(b); });
  return btoa(bin);
}

/**
 * Decode the embedded base64 JSON back to a name list (browser side). Fails soft
 * to [] on missing / malformed input so the About page degrades gracefully (AC6).
 */
export function decodeContributors(encoded) {
  if (!encoded || typeof encoded !== 'string') return [];
  try {
    let json;
    if (typeof Buffer !== 'undefined') {
      json = Buffer.from(encoded, 'base64').toString('utf8');
    } else {
      const bin = atob(encoded);
      const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
      json = new TextDecoder().decode(bytes);
    }
    const arr = JSON.parse(json);
    if (!Array.isArray(arr)) return [];
    return arr.filter((x) => typeof x === 'string' && x.trim());
  } catch {
    return [];
  }
}
