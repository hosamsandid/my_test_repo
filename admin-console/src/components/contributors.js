// Build-time contributors list for the About page (#1742, filtered + ranked in
// #1778). The contributor set is derived from the repository git history at
// build time (see admin-console/vite.config.js + the GIT_CONTRIBUTORS build arg
// wired through the Makefile / docker-compose.yml / Dockerfile for the no-git
// Docker build context) and embedded into the bundle as
// import.meta.env.VITE_CONTRIBUTORS (base64 of a JSON string[]); there is no
// runtime lookup.
//
// This module is React-free and unit-tested (admin-console-src CI job). It owns:
//   - extractContributors(rawGitLog): git identity lines -> human-only, deduped,
//     commit-count-ranked display names.
//       * Each input line is either a raw per-commit `%aN\t%aE` pair (host-direct
//         build; counted by occurrence) OR a pre-aggregated `<count>\t%aN\t%aE`
//         line (Docker build, where the Makefile collapses the log with
//         `sort | uniq -c` to keep the build arg small). One tolerant parser
//         handles both (see parseIdentityLine).
//       * Non-human committers are dropped (#1778, AC1/AC2): identities whose
//         author email is on an internal, non-routable agent domain (any
//         `.local` domain, its `.local.test` test variant, or a bare `@agent` /
//         `@local` host — #2698) or whose display name carries
//         `[bot]`. Everyone else (real domains such as `@accenture.com` and
//         GitHub `…@users.noreply.github.com`) is kept. A human who ever
//         committed under an internal-looking email, or a future agent under a
//         real domain, is knowingly mis-classified — acceptable for the current
//         history (see the issue's "Distinguishing signal").
//       * De-duplication (AC5) unions identities that share an email OR a name,
//         so the same person committing under several email addresses or name
//         spellings collapses to one entry, with their commit counts summed.
//       * Ordering (AC4/AC6): descending total commit count, ties broken
//         alphabetically by display name. The count drives the sort ONLY and is
//         never returned/rendered (AC7).
//   - encodeContributors / decodeContributors: the base64<->string[] interchange
//     used to move the list through the build-arg / import.meta.env boundary
//     without worrying about names containing commas, angle brackets, "[bot]",
//     or non-ASCII characters.

// --- human / non-human classification (#1778) --------------------------------

// Internal, non-routable domains the stack's agents (and test fixtures) commit
// under. Anchored to the end of the email so a real address is never caught by
// a substring. Matched by the whole `.local` family rather than a list of known
// hosts (#2698): `@agents.local`, `@agent.local`, `@agent-studio.local`,
// `@a.local` and bare `@local` all exclude, as do the `.local.test` variants
// (`@local.test`, `@x.local.test`) and the bare `@agent` host. `.local` is
// reserved for link-local names (RFC 6762) and never a real mail domain.
const AGENT_EMAIL_DOMAINS = [
  /@(?:[^@]+\.)?local(?:\.test)?$/i,
  /@agent$/i,
];

/**
 * Decide whether a git identity belongs to a human contributor (kept) or a
 * platform / technical identity (excluded). The rule is deliberately simple and
 * documented so the behaviour stays predictable (#1778):
 *   - a display name containing `[bot]` is a bot -> excluded;
 *   - an author email on an internal agent domain is an agent -> excluded:
 *     any `.local` domain (`…@agents.local`, `…@agent.local`,
 *     `…@agent-studio.local`, bare `…@local`), its `.local.test` variant
 *     (`…@local.test`), or a bare `…@agent` host (#2698);
 *   - everything else is treated as human -> kept.
 *
 * @param {{name?: string, email?: string}} identity
 * @returns {boolean}
 */
export function isHumanIdentity(identity) {
  const name = (identity && identity.name ? String(identity.name) : '').toLowerCase();
  if (name.includes('[bot]')) return false;
  const email = (identity && identity.email ? String(identity.email) : '').toLowerCase();
  if (AGENT_EMAIL_DOMAINS.some((re) => re.test(email))) return false;
  return true;
}

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

// Parse one raw line into { name, email, count }. A line is either
//   `<count>\t<name>\t<email>`  (pre-aggregated: numeric leading field, 3 cols)
// or
//   `<name>\t<email>`           (one commit: count 1, summed by occurrence).
// Names/emails never contain a tab, so a plain tab split is safe; the numeric
// leading-field test disambiguates the two shapes.
function parseIdentityLine(line) {
  const parts = line.split('\t');
  if (parts.length >= 3 && /^\d+$/.test(parts[0].trim())) {
    return {
      count: parseInt(parts[0].trim(), 10) || 0,
      name: parts[1].trim(),
      email: parts[2].trim(),
    };
  }
  return { count: 1, name: (parts[0] || '').trim(), email: (parts[1] || '').trim() };
}

/**
 * Turn raw git-log identity output into the human-only, de-duplicated list of
 * contributor display names, ordered by descending total commit count with
 * alphabetical tie-breaks (#1742, #1778).
 *
 * @param {string} rawGitLog one identity per line — either `%aN\t%aE` per commit
 *   or a pre-aggregated `<count>\t%aN\t%aE` line.
 * @returns {string[]} canonical display names, human-only, deduped, ranked.
 */
export function extractContributors(rawGitLog) {
  if (!rawGitLog || typeof rawGitLog !== 'string') return [];

  const identities = [];
  for (const line of rawGitLog.split('\n')) {
    if (!line.trim()) continue;
    const id = parseIdentityLine(line);
    if (!id.name) continue;
    // #1778 (AC1/AC2): drop agent / bot / service identities before dedup+rank.
    if (!isHumanIdentity(id)) continue;
    identities.push(id);
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

  // Collect each person's candidate names + summed commit count (AC5).
  const groups = new Map();
  identities.forEach((id, i) => {
    const root = uf.find(nodeKey(i));
    let g = groups.get(root);
    if (!g) {
      g = { names: new Set(), count: 0 };
      groups.set(root, g);
    }
    g.names.add(id.name);
    g.count += id.count;
  });

  const people = [];
  for (const g of groups.values()) {
    people.push({ name: pickCanonical([...g.names]), count: g.count });
  }

  // Order by descending commit count; break ties alphabetically, case-insensitive
  // (AC4/AC6). The count is used for ordering only — never returned (AC7).
  people.sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });

  const seen = new Set();
  const names = [];
  for (const p of people) {
    if (seen.has(p.name)) continue;
    seen.add(p.name);
    names.push(p.name);
  }
  return names;
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
 * to [] on missing / malformed input so the About page degrades gracefully (AC9).
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
