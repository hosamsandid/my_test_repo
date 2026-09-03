'use strict';

/**
 * briefings-fs.js — read a BriefingPack hierarchy straight off the workspace
 * volume (#1965, epic #1961 Phase 4).
 *
 * The BP → flow-draft import is the one BriefingPack feature the epic keeps
 * (decision R3): it is the migration path off the old model, so it has to
 * outlive the model. Until now it got its data from `bp-explorer`'s
 * `GET /api/briefings`, which is exactly the service Phase 2 (#1963) deletes —
 * hence this module, a dependency-free Node re-implementation of the parts of
 * that endpoint the importer actually consumes.
 *
 * "The parts it consumes" is the whole design constraint. The only consumer is
 * `briefingsToUnified()` (unified-graph.js), and it reads nine fields:
 * `id`, `slug`, `title`, `body`, `stage`, `artifacts`, `depends_on`, `parent`,
 * `children` / `is_parent`. `_derive_status_from_children`, rigor, claim and
 * revision bookkeeping all fed `status`, and `briefingsToUnified` drops
 * `status` on purpose (its own decision 2), so dropping them changes nothing.
 * What IS ported is ported faithfully, including bp-explorer's quirks (see
 * `parseFrontmatter`), because AC2 asks for the same draft the service made.
 *
 * ONE deliberate behavioural difference, and it is not a `status`-only one.
 * bp-explorer's **agent-branch overlay** (`load_all_briefings`, server.py) also
 * scanned `refs/heads/agent/*` + `refs/remotes/origin/agent/*` and, when a
 * branch's status outranked main's, took that branch's `brief.md` wholesale —
 * `bp["body"] = branch_body`, not just the status field. `body` is load-bearing:
 * `briefingsToUnified` maps it to `content`, and `unifiedToProcessTemplate`
 * resolves a role's prompt as `systemPrompt || content`. So for a pack claimed
 * on an unmerged agent branch, the old importer drafted the role prompt from
 * that branch and this one drafts it from the checked-out tree.
 *
 * That is scoped out rather than ported, on purpose: #1962 removed
 * `POST /internal/agents/:id/claim`, so the platform no longer creates agent
 * branches, and porting `discover_agent_branches` + `git show` would mean
 * spawning git inside a request to chase refs nothing writes any more. The
 * consequence is stated plainly here, in the route comment and in
 * RELEASE_NOTES instead of being claimed away — if you are migrating a
 * repository whose packs still carry unmerged agent-branch edits, merge those
 * branches before importing and the drafts match.
 *
 * Layout convention, inherited from bp-explorer's `resolve_workspace`: packs
 * live at `<missionDir>/artifacts/briefings/**\/brief.md`, and directory
 * nesting — not frontmatter — is the authority on the parent/child hierarchy.
 *
 * Pure and I/O-thin: `parseFrontmatter` and `deriveParentFromPath` take
 * strings, so the parser unit-tests without a filesystem (#651 convention).
 * Path containment is NOT this module's job — the caller resolves the mission
 * directory through `safeAgentPath` first and hands us an already-contained
 * absolute path.
 */

const fs = require('node:fs');
const path = require('node:path');

/** Where packs live under a mission directory (bp-explorer's convention). */
const BRIEFINGS_SUBDIR = path.join('artifacts', 'briefings');

/**
 * Walk limits. bp-explorer streamed this out of a long-lived Python service;
 * we do it inside a request, so the traversal is bounded rather than trusting
 * the tree. Each cap fails loudly with a message naming the limit — the edge
 * case the ticket calls out is "very large pack hierarchies", and a truncated
 * import that silently loses half a flow is worse than a refusal.
 */
const MAX_PACKS = 2000;
const MAX_DEPTH = 12;
const MAX_BRIEF_BYTES = 1024 * 1024; // 1 MB per brief.md

/** BP directory naming convention: `<12-hex-hash>-<slug>`. */
const BP_DIR_RE = /^([0-9a-f]{12})-/;

/** Raised for every condition the route turns into a clear HTTP error. */
class BriefingsError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'BriefingsError';
    this.status = status || 422;
  }
}

const asList = (v) => (Array.isArray(v) ? v : []);

/**
 * Parse the YAML frontmatter of a `brief.md`.
 *
 * A faithful port of bp-explorer's `parse_frontmatter`, NOT a general YAML
 * parser — and that is deliberate. Swapping in a real YAML library here would
 * change which briefs parse and how, which is precisely what AC2 forbids: the
 * import has to keep producing the draft it produces today. So the same subset
 * is supported, with the same edge behaviour:
 *
 *   - `key: value` scalars, with one layer of surrounding double quotes stripped
 *   - `key: []` and inline JSON arrays `key: ["a", "b"]` (a malformed inline
 *     array degrades to the raw string rather than throwing, as upstream)
 *   - `key:` with nothing after it opens a list, filled by the indented
 *     `- item` lines that follow — scalars, or `- k: v` object groups with
 *     deeper-indented continuation keys
 *   - a document with fewer than two `---` delimiter lines has no frontmatter:
 *     `{}` plus the untouched text as the body
 *
 * @param {string} text  the file contents
 * @returns {{meta: Object, body: string}}
 */
function parseFrontmatter(text) {
  const lines = String(text == null ? '' : text).split('\n');
  const delimiters = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '---') delimiters.push(i);
    if (delimiters.length === 2) break;
  }
  if (delimiters.length < 2) return { meta: {}, body: String(text == null ? '' : text) };

  const fmLines = lines.slice(delimiters[0] + 1, delimiters[1]);
  const body = lines.slice(delimiters[1] + 1).join('\n').trim();

  const meta = {};
  let currentKey = null;
  let currentList = null;
  let currentObj = null;

  const flushList = () => {
    if (currentKey !== null && currentList !== null) {
      if (currentObj) { currentList.push(currentObj); currentObj = null; }
      meta[currentKey] = currentList;
      currentList = null;
      currentKey = null;
    }
  };
  // Strip ONE layer of surrounding double quotes — deliberately not the same as
  // upstream. Python's `.strip('"')`, which bp-explorer applies to list items
  // and object values, removes EVERY leading and trailing quote, so an
  // unbalanced `"a` / `b"` pair reduces differently there (measured: upstream
  // yields `a` / `b`, this yields `"a` / `b"`). Only malformed frontmatter can
  // tell the difference, and a balanced value — every well-formed pack — is
  // identical, so the single layer stays: it is the conservative reading, and
  // `depends_on` list items do reach `dependsOn` in the draft.
  const unquote = (s) => (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"' ? s.slice(1, -1) : s);

  for (const raw of fmLines) {
    const line = raw.replace(/\s+$/, '');
    if (!line) continue;

    if (!/^\s/.test(line)) {
      // Top-level `key: value`.
      flushList();
      const colon = line.indexOf(':');
      if (colon === -1) continue;
      const key = line.slice(0, colon).trim();
      const val = line.slice(colon + 1).trim();

      if (val === '[]') {
        meta[key] = [];
      } else if (val.startsWith('[') && val.endsWith(']')) {
        try { meta[key] = JSON.parse(val); } catch { meta[key] = val; }
      } else if (val === '') {
        currentKey = key;
        currentList = [];
      } else {
        meta[key] = unquote(val);
      }
    } else if (line.trimStart().startsWith('- ')) {
      const item = line.trimStart().slice(2).trim();
      if (item.includes(': ') && currentList !== null) {
        // Object item, e.g. `- direction: output`.
        if (currentObj) currentList.push(currentObj);
        currentObj = {};
        const idx = item.indexOf(':');
        currentObj[item.slice(0, idx).trim()] = unquote(item.slice(idx + 1).trim());
      } else {
        if (currentObj) { currentList.push(currentObj); currentObj = null; }
        if (currentList !== null) currentList.push(unquote(item));
      }
    } else if (currentObj !== null) {
      // Continuation key of the object item currently being built.
      const kv = line.trim();
      const idx = kv.indexOf(':');
      if (idx !== -1) currentObj[kv.slice(0, idx).trim()] = unquote(kv.slice(idx + 1).trim());
    }
  }
  flushList();
  return { meta, body };
}

/**
 * The parent BP's 12-char hash, inferred from on-disk nesting.
 *
 * Directory structure is the authority (bp-explorer's `derive_parent_from_path`);
 * frontmatter `parent:` is only a fallback for a top-level pack. Walks the
 * ancestors outward from the pack's own directory and returns the closest one
 * that is itself a BP directory, so non-BP intermediates such as `.archive`
 * are skipped without breaking the chain.
 *
 * @param {string} relPath  `brief.md` path relative to the briefings root,
 *   POSIX- or platform-separated (e.g. `abc123def456-root/0011aabbccdd-leaf/brief.md`)
 * @returns {string|null} the ancestor's hash, or null at the top level
 */
function deriveParentFromPath(relPath) {
  const parts = String(relPath || '').split(/[\\/]/).filter(Boolean);
  // parts ends with ("<bp-dir>", "brief.md") — strip both to get the ancestors.
  const ancestors = parts.slice(0, -2);
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const m = BP_DIR_RE.exec(ancestors[i]);
    if (m) return m[1];
  }
  return null;
}

/**
 * Every `brief.md` under `root`, sorted by path.
 *
 * Sorted because bp-explorer sorted (`sorted(base_dir.rglob(...))`) and node
 * order reaches the draft: `unifiedToProcessTemplate` maps nodes to roles in
 * array order. Symlinked directories are not followed — the caller's
 * `safeAgentPath` contained the mission directory itself, and descending
 * through a symlink would step straight back out of it.
 *
 * @param {string} root  absolute path of the briefings directory
 * @returns {string[]} absolute paths
 */
function findBriefFiles(root) {
  const found = [];
  const walk = (dir, depth) => {
    if (depth > MAX_DEPTH) {
      throw new BriefingsError(
        `BriefingPack hierarchy is nested deeper than ${MAX_DEPTH} levels — refusing to import.`,
        422,
      );
    }
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable subtree — skip it rather than fail the whole import
    }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full, depth + 1);
      } else if (e.isFile() && e.name === 'brief.md') {
        if (found.length >= MAX_PACKS) {
          throw new BriefingsError(
            `BriefingPack hierarchy has more than ${MAX_PACKS} packs — refusing to import.`,
            422,
          );
        }
        found.push(full);
      }
    }
  };
  walk(root, 0);
  return found.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Read a mission directory's BriefingPack hierarchy.
 *
 * The shape returned per pack is the subset of bp-explorer's
 * `GET /api/briefings` rows that `briefingsToUnified()` reads (see the module
 * header for why the rest is not ported).
 *
 * Failure is always a `BriefingsError` with a sentence a user can act on —
 * "missing, empty, or malformed" must not surface as a stack trace. A pack
 * whose id can be resolved neither from frontmatter nor from its directory
 * name is skipped and named in `skipped`: `briefingsToUnified` would drop it
 * silently, and a draft quietly missing a role is the failure mode a user
 * cannot tell from a bug.
 *
 * @param {string} missionDir  absolute, already contained by `safeAgentPath`
 * @returns {{packs: Object[], skipped: string[], briefingsDir: string}}
 * @throws {BriefingsError}
 */
function readBriefingPacks(missionDir) {
  const briefingsDir = path.join(missionDir, BRIEFINGS_SUBDIR);
  let stat;
  try {
    stat = fs.statSync(briefingsDir);
  } catch {
    throw new BriefingsError(
      `No BriefingPacks found: '${BRIEFINGS_SUBDIR}' does not exist in that mission directory.`,
      404,
    );
  }
  if (!stat.isDirectory()) {
    throw new BriefingsError(`No BriefingPacks found: '${BRIEFINGS_SUBDIR}' is not a directory.`, 404);
  }

  const files = findBriefFiles(briefingsDir);
  if (files.length === 0) {
    throw new BriefingsError(`No BriefingPacks found: '${BRIEFINGS_SUBDIR}' contains no brief.md files.`, 422);
  }

  const packs = [];
  const skipped = [];
  for (const file of files) {
    const rel = path.relative(briefingsDir, file);
    let text;
    try {
      const size = fs.statSync(file).size;
      if (size > MAX_BRIEF_BYTES) {
        throw new BriefingsError(
          `${rel} is larger than ${Math.round(MAX_BRIEF_BYTES / 1024)} KB — refusing to import.`,
          422,
        );
      }
      text = fs.readFileSync(file, 'utf8');
    } catch (err) {
      if (err instanceof BriefingsError) throw err;
      throw new BriefingsError(`Could not read ${rel}: ${err.message}`, 422);
    }

    const { meta, body } = parseFrontmatter(text);
    const dirName = path.basename(path.dirname(file));
    const dirMatch = BP_DIR_RE.exec(dirName);
    const dirId = dirMatch ? dirMatch[1] : '';
    const dirSlug = dirMatch ? dirName.slice(13) : '';

    const id = typeof meta.id === 'string' && meta.id ? meta.id : dirId;
    if (!id) {
      // Neither `id:` in the frontmatter nor a `<12-hex>-<slug>` directory.
      skipped.push(rel);
      continue;
    }

    const parentFromDir = deriveParentFromPath(rel);
    const parentFromMeta = typeof meta.parent === 'string' && meta.parent ? meta.parent : null;
    const children = asList(meta.children);

    packs.push({
      id,
      slug: typeof meta.slug === 'string' && meta.slug ? meta.slug : dirSlug,
      // Upstream reads `mission` first and only then `title`, and so do we.
      // The `typeof === 'string'` guard is a deliberate DIVERGENCE for one
      // malformed shape: a bare `mission:` with no value parses to `[]`, which
      // upstream's `meta.get("mission", …)` returns as-is and which is truthy
      // in its `title || slug || id` chain — so upstream ends up with a `[]`
      // title, while the guard here falls through to `title:`. Measured, and
      // this side is the better behaviour; it is the only place the two differ
      // on `title`. A well-formed pack is identical either way, and
      // briefingsToUnified's own `title || slug || id` chain still handles the
      // fallback from there. (`stage:` diverges the same way, `[]` vs `''`,
      // and briefingsToUnified's own typeof guard absorbs it — no draft
      // difference at all.)
      title: typeof meta.mission === 'string' ? meta.mission : (typeof meta.title === 'string' ? meta.title : ''),
      stage: typeof meta.stage === 'string' ? meta.stage : '',
      depends_on: asList(meta['depends-on']),
      artifacts: asList(meta.artifacts),
      parent: parentFromDir !== null ? parentFromDir : parentFromMeta,
      children,
      is_parent: children.length > 0,
      body,
      // Archived packs stay in the list: bp-explorer returned them too, and
      // briefingsToUnified never filtered on the flag. Carried so the draft is
      // the same one the service produced.
      archived: rel.split(/[\\/]/).includes('.archive'),
    });
  }

  if (packs.length === 0) {
    throw new BriefingsError(
      `Found ${skipped.length} brief.md file(s), but none carries a pack id — `
      + `each needs an 'id:' in its frontmatter or a '<12-hex>-<slug>' directory name. `
      + `Checked: ${skipped.slice(0, 5).join(', ')}${skipped.length > 5 ? ', …' : ''}`,
      422,
    );
  }
  return { packs, skipped, briefingsDir };
}

module.exports = {
  BriefingsError,
  BRIEFINGS_SUBDIR,
  MAX_PACKS,
  MAX_DEPTH,
  MAX_BRIEF_BYTES,
  parseFrontmatter,
  deriveParentFromPath,
  findBriefFiles,
  readBriefingPacks,
};
