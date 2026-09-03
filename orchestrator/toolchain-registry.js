'use strict';

// toolchain-registry.js — pure decision core for the per-Working-Environment
// agent toolchain (#1940; concept docs/agent-toolchains-concept.md §3).
//
// WHAT THIS DECIDES. Which container image one agent is spawned from. Until
// #1940 that was a single process-wide value (`AGENT_IMAGE`, default
// `as-agent:latest`) read inside both spawn implementations, so giving one team
// a JVM toolchain meant moving EVERY agent of the installation onto that image.
// A Working Environment may now name a **toolchain**; agents bound to it are
// spawned from that toolchain's image and everything else keeps using
// `AGENT_IMAGE` byte-identically.
//
// WHY AN ID, NOT AN IMAGE STRING. `startAgentProcess` injects the environment's
// SSH identity, the GitHub PAT and the model credential into every agent
// container, so whoever picks the image picks what executes with those secrets.
// The authorisation split therefore copies the plugin registry rather than
// inventing a second model: a **System Admin** registers a toolchain (the only
// place an image reference is ever accepted), a **Team Admin** selects an
// already-registered one by id, and the server resolves the id to an image.
// `resolveAgentImage` is the whole of that resolution, which is why it lives
// here as a pure function rather than inline in a spawn adapter: the fallback
// chain and every refusal are testable without libpod or a cluster.
//
// WHAT THIS DOES NOT DO. It never touches an image store or a registry — image
// PRESENCE is a runtime fact, so the impure adapters probe for it and render the
// refusal with `missingImageMessage()`.
//
// #1941 ADDS THE SOURCE SIDE. A toolchain image is now built from a source tree
// in this repository (`toolchains/<id>/toolchain.json` + `Dockerfile`,
// `make toolchain-images`), seeded into the pool like a reference plugin, and
// installed into the registry above by id — so the System Admin no longer types
// an image reference for a shipped variant. `validateToolchainManifest` is the
// validator for that SOURCE manifest and `toolchainFromManifest` projects it
// onto the registry entry `validateToolchain` already governs: ONE schema, two
// entry points, so a hand-registered entry and a seeded one cannot diverge.
// `resolveToolchainImage` applies the deployment's image prefix and release tag
// (both empty on a local Podman stack, the Artifact Registry path + the pinned
// release tag on a cluster) to the bare `repo:tag` a manifest declares — the
// manifest can know neither where a given installation pushed its images nor
// which release it is running. It runs at SPAWN time, inside `resolveAgentImage`,
// so a release re-pin reaches toolchains that were installed long before it.
//
// DUPLICATED, byte-identical, at admin-console/api/toolchain-registry.js — the
// two container images copy disjoint file sets, so this pure module lives in
// both (like plugin-manifest.js / context-mount.js / skill-manifest.js). Change
// both in one commit; a test on each side guards the copies.

// Installation-wide default. Kept as the last link of the fallback chain (the
// concept's §7.1 "rejected as an operating model, kept as the default"), so an
// installation that registers no toolchain behaves exactly as before.
const DEFAULT_AGENT_IMAGE = 'as-agent:latest';

// Toolchain ids name a directory in #1941's `toolchains/<id>/` and appear in
// container labels and log lines — same conservative shape as a plugin id.
const TOOLCHAIN_ID_RE = /^[a-z0-9](?:[a-z0-9._-]{0,38}[a-z0-9])?$/;

// The runtimes a toolchain's `platforms` field may name. Same field, same
// purpose as in a plugin manifest: a `localhost/…` tag that exists only in a
// developer's image store must not be offerable on a hosted cluster.
const KNOWN_PLATFORMS = ['podman', 'kubernetes'];

const MAX_NAME_LEN = 120;
const MAX_DESCRIPTION_LEN = 600;
const MAX_STACK_LEN = 60;
const MAX_IMAGE_LEN = 512;
const MAX_BASELINE_LEN = 200;

// How a toolchain's RUNTIME VERSION is decided (#1941 AC1, concept §5). This is
// the field that keeps the version axis out of the image set:
//
//   'bootstrap' — the image ships a version MANAGER; the project repository
//                 pins the version (a committed `.mise.toml`), so a version
//                 update is a commit in that repository, not a platform
//                 release. The default shape of every variant.
//   'baked'     — the runtime is fixed in the image. Deliberately supported as
//                 the AIRGAP EXCEPTION (nothing may be fetched at runtime), in
//                 which case the version axis collapses back into the image ON
//                 PURPOSE and every version change is a platform release.
//
// An operator reads this before installing, which is why it reaches the
// registry entry rather than staying in the source manifest: "where does the
// Java version come from" is answerable from the Toolchains panel.
const VERSION_SOURCES = ['bootstrap', 'baked'];

// Source-manifest schema version — the `pluginVersion: 1` discipline. Bumped
// only for a breaking shape change, so an older manifest fails loudly at build
// time instead of being half-read.
const TOOLCHAIN_MANIFEST_VERSION = 1;

// Charset gate for an image reference. Deliberately a single character class
// with one quantifier (linear, no backtracking) rather than a full
// `[host[:port]/]path[:tag][@digest]` grammar: the structural checks below are
// plain string tests, which is cheaper to read and cannot degrade on a
// pathological input. The reference is only ever placed in a JSON body (libpod
// create / k8s pod spec) — never in a shell — so this validates operator typos
// at registration time, it is not a shell-injection barrier.
const IMAGE_CHARSET_RE = /^[A-Za-z0-9._:/@-]+$/;

function normalizeRuntime(raw) {
  const r = String(raw || 'podman').trim().toLowerCase();
  if (r === 'k8s' || r === 'kubernetes') return 'kubernetes';
  return 'podman';
}

function validateImageRef(raw) {
  const image = String(raw == null ? '' : raw).trim();
  if (!image) return { ok: false, error: 'image is required' };
  if (image.length > MAX_IMAGE_LEN) {
    return { ok: false, error: `image reference must be at most ${MAX_IMAGE_LEN} characters` };
  }
  if (!IMAGE_CHARSET_RE.test(image)) {
    return { ok: false, error: 'image reference contains unsupported characters' };
  }
  if (image.startsWith('/') || image.endsWith('/') || image.includes('//')) {
    return { ok: false, error: 'image reference has an empty path segment' };
  }
  if (image.startsWith(':') || image.startsWith('@') || image.endsWith(':') || image.endsWith('@')) {
    return { ok: false, error: 'image reference has an empty tag or digest' };
  }
  // The final path segment carries the repository name — an image reference that
  // is only a registry host (`example.com/`) or only a tag is a typo, not a
  // pullable reference.
  const nameSegment = image.split('/').pop().split('@')[0].split(':')[0];
  if (!nameSegment) return { ok: false, error: 'image reference has no repository name' };
  return { ok: true, image };
}

function normalizePlatforms(raw) {
  if (raw === undefined || raw === null) return { ok: true, platforms: [...KNOWN_PLATFORMS] };
  if (!Array.isArray(raw)) return { ok: false, error: 'platforms must be an array' };
  const platforms = [];
  for (const entry of raw) {
    // Checked against the literal set BEFORE normalizeRuntime, which falls back
    // to 'podman' — an unknown platform must be an error, never silently widened
    // into the podman default.
    const given = String(entry == null ? '' : entry).trim().toLowerCase();
    if (given !== 'podman' && given !== 'kubernetes' && given !== 'k8s') {
      return { ok: false, error: `unknown platform '${given}' (expected ${KNOWN_PLATFORMS.join(' or ')})` };
    }
    const p = normalizeRuntime(given);
    if (!platforms.includes(p)) platforms.push(p);
  }
  if (platforms.length === 0) return { ok: false, error: 'platforms must name at least one runtime' };
  return { ok: true, platforms };
}

function optionalText(raw, field, max, errors) {
  if (raw === undefined || raw === null) return '';
  if (typeof raw !== 'string') { errors.push(`${field} must be a string`); return ''; }
  const v = raw.trim();
  if (v.length > max) { errors.push(`${field} must be at most ${max} characters`); return ''; }
  return v;
}

// Validate + normalize one registry entry. Returns the whitelisted shape — a
// caller cannot smuggle extra keys onto a persisted toolchain, so the registry
// file stays a small, reviewable list of exactly what the resolver reads.
function validateToolchain(raw) {
  const errors = [];
  const src = raw && typeof raw === 'object' ? raw : {};

  const id = String(src.id == null ? '' : src.id).trim();
  if (!id) errors.push('id is required');
  else if (!TOOLCHAIN_ID_RE.test(id)) {
    errors.push("id must be lowercase alphanumeric, may contain '.', '_' or '-' inside, max 40 chars");
  }

  const name = String(src.name == null ? '' : src.name).trim();
  if (!name) errors.push('name is required');
  else if (name.length > MAX_NAME_LEN) errors.push(`name must be at most ${MAX_NAME_LEN} characters`);

  const img = validateImageRef(src.image);
  if (!img.ok) errors.push(img.error);

  const plat = normalizePlatforms(src.platforms);
  if (!plat.ok) errors.push(plat.error);

  const description = optionalText(src.description, 'description', MAX_DESCRIPTION_LEN, errors);
  const stack = optionalText(src.stack, 'stack', MAX_STACK_LEN, errors);
  // OPTIONAL here, REQUIRED in a source manifest (below). An entry registered
  // before #1941 has neither field, and normalizeRegistry must keep reading it —
  // dropping a live environment's toolchain over a missing informational string
  // would refuse its spawns.
  const versionSource = optionalText(src.versionSource, 'versionSource', 20, errors);
  if (versionSource && !VERSION_SOURCES.includes(versionSource)) {
    errors.push(`versionSource must be ${VERSION_SOURCES.join(' or ')}`);
  }
  const baseline = optionalText(src.baseline, 'baseline', MAX_BASELINE_LEN, errors);

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    toolchain: {
      id,
      name,
      description,
      stack,
      image: img.image,
      platforms: plat.platforms,
      versionSource,
      baseline,
    },
  };
}

// Validate one SOURCE manifest — `toolchains/<id>/toolchain.json` in this
// repository (#1941 AC1). Stricter than the registry entry above on exactly the
// fields a shipped variant must not leave to chance:
//
//   * `toolchainVersion` must match, so a future shape change fails at build
//     time rather than being partially honoured;
//   * `description` is REQUIRED — it is what the System Admin reads before
//     installing, and an unexplained image is not installable in good faith;
//   * `versionSource` is REQUIRED — "does this ship a pinned runtime?" is the
//     one question that decides whether a JDK update is a commit or a release,
//     so it may not be implied;
//   * a `bootstrap` variant must name its `versionManager` (the thing that
//     resolves the project's pin) and a `baked` one must not, since there is
//     nothing to resolve.
//
// `dirId` (the directory the manifest was read from) is compared to `id` when
// given — the same guard `readPluginDir` applies, so a copied directory cannot
// silently register under the id it was copied from.
function validateToolchainManifest(raw, opts) {
  const { dirId = null } = opts || {};
  const src = raw && typeof raw === 'object' ? raw : {};
  const errors = [];

  if (Number(src.toolchainVersion) !== TOOLCHAIN_MANIFEST_VERSION) {
    errors.push(`toolchainVersion must be ${TOOLCHAIN_MANIFEST_VERSION}`);
  }
  if (!String(src.description == null ? '' : src.description).trim()) {
    errors.push('description is required (it is what an operator reads before installing)');
  }
  const versionSource = String(src.versionSource == null ? '' : src.versionSource).trim();
  if (!versionSource) errors.push(`versionSource is required (${VERSION_SOURCES.join(' or ')})`);

  const versionManager = optionalText(src.versionManager, 'versionManager', MAX_STACK_LEN, errors);
  if (versionSource === 'bootstrap' && !versionManager) {
    errors.push("a 'bootstrap' toolchain must name its versionManager");
  }
  if (versionSource === 'baked' && versionManager) {
    errors.push("a 'baked' toolchain resolves no version and must not name a versionManager");
  }

  const base = validateToolchain(src);
  if (!base.ok) errors.push(...base.errors);

  if (base.ok && dirId && base.toolchain.id !== dirId) {
    errors.push(`manifest id '${base.toolchain.id}' does not match directory '${dirId}'`);
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, manifest: { ...base.toolchain, toolchainVersion: TOOLCHAIN_MANIFEST_VERSION, versionManager } };
}

// Project a validated source manifest onto a registry entry. Deliberately NOT a
// second validator: the install route runs the result back through
// `validateToolchain`, so the registry file keeps exactly one gatekeeper no
// matter which door an entry came through.
//
// The image is carried through VERBATIM — the bare `repo:tag` the manifest
// declares. Where that image lives in a given deployment is decided at SPAWN
// time by `resolveToolchainImage` (below), not here: a registry entry persisted
// with a release-pinned Artifact Registry reference would go stale on the next
// release and force the operator to re-install a toolchain they never changed.
function toolchainFromManifest(manifest) {
  const m = manifest && typeof manifest === 'object' ? manifest : {};
  return {
    id: m.id,
    name: m.name,
    description: m.description,
    stack: m.stack,
    image: m.image,
    platforms: Array.isArray(m.platforms) ? [...m.platforms] : [...KNOWN_PLATFORMS],
    versionSource: m.versionSource || '',
    baseline: m.baseline || '',
  };
}

// Where the variant's image actually lives, per deployment (#1941 AC11).
//
// A manifest declares the bare `repo:tag` the build produces (`as-agent-jvm:latest`
// — what `make toolchain-images` leaves in a developer's local image store, and
// what a kind node has side-loaded). A cluster pulls the same image from an
// Artifact Registry under the release's immutable tag, so the deployment
// supplies both halves as env vars set by the same overlay patch that carries
// `AGENT_IMAGE` and pinned per release by `set-images.sh`:
//
//   AEE_TOOLCHAIN_IMAGE_PREFIX  the registry path      (empty locally)
//   AEE_TOOLCHAIN_IMAGE_TAG     the release tag        (empty locally)
//
// Keeping BOTH out of the manifest is what lets one checked-in manifest serve
// every deployment — the repo cannot know where an installation pushed its
// images, nor which release it is running. And keeping the resolution at SPAWN
// time (rather than baking it into the persisted registry entry at install
// time) is what makes an upgrade invisible to the operator: the next release
// pins a new tag and the same registry entry resolves to the new image.
//
// An image that already carries a registry host (`/`) or a digest (`@`) is
// returned UNCHANGED — a System Admin who deliberately typed a full reference
// for their own image (the #1940 hand-registration path) is not second-guessed,
// and a digest is pinned by definition.
function resolveToolchainImage(image, opts) {
  const { prefix = '', tag = '' } = opts || {};
  const ref = String(image == null ? '' : image).trim();
  if (!ref) return ref;
  if (ref.includes('/') || ref.includes('@')) return ref;

  const pre = String(prefix == null ? '' : prefix).trim().replace(/\/+$/, '');
  const wantTag = String(tag == null ? '' : tag).trim();
  // `repo:tag` → split on the LAST colon; a reference with no tag keeps none.
  const colon = ref.lastIndexOf(':');
  const repo = colon === -1 ? ref : ref.slice(0, colon);
  const ownTag = colon === -1 ? '' : ref.slice(colon + 1);
  const finalTag = wantTag || ownTag;
  const named = finalTag ? `${repo}:${finalTag}` : repo;
  return pre ? `${pre}/${named}` : named;
}

// Fold a persisted registry file into the list the resolver reads. An entry that
// no longer validates (hand-edited file, a field dropped by a future version) is
// SKIPPED with a reason rather than crashing the read — one bad line must not
// make every environment unresolvable — and the reasons are surfaced so the
// operator sees it instead of a silently shorter list.
function normalizeRegistry(raw) {
  const list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.toolchains) ? raw.toolchains : []);
  const toolchains = [];
  const errors = [];
  const seen = new Set();
  for (const entry of list) {
    const v = validateToolchain(entry);
    if (!v.ok) {
      const label = (entry && entry.id) || '<no id>';
      errors.push(`toolchain '${label}': ${v.errors.join('; ')}`);
      continue;
    }
    if (seen.has(v.toolchain.id)) {
      errors.push(`toolchain '${v.toolchain.id}': duplicate id`);
      continue;
    }
    seen.add(v.toolchain.id);
    toolchains.push(v.toolchain);
  }
  return { toolchains, errors };
}

function findToolchain(toolchains, id) {
  if (!id) return null;
  const wanted = String(id).trim();
  if (!wanted) return null;
  return (Array.isArray(toolchains) ? toolchains : []).find((t) => t && t.id === wanted) || null;
}

function supportsRuntime(toolchain, runtime) {
  if (!toolchain) return false;
  const want = normalizeRuntime(runtime);
  const platforms = Array.isArray(toolchain.platforms) && toolchain.platforms.length
    ? toolchain.platforms
    : KNOWN_PLATFORMS;
  return platforms.includes(want);
}

function envLabel(environmentId, environmentName) {
  const name = String(environmentName || '').trim();
  const id = String(environmentId || '').trim() || '<unknown>';
  return name && name !== id ? `'${id}' (${name})` : `'${id}'`;
}

// THE resolution (AC1/AC7/AC10). Every caller of the container-runtime seam goes
// through this, so the fallback chain exists in exactly one place:
//
//   no toolchain on the environment  -> the installation-wide default image
//   toolchain registered + supported -> the toolchain's image
//   toolchain id not in the registry -> a NAMED refusal (never the default)
//   toolchain not built for this runtime -> a NAMED refusal
//
// The two refusals return `{ error }` rather than throwing so a caller can log
// and skip the spawn. Falling back to the default image here would be worse than
// failing: a build agent would come up WITHOUT its toolchain and fail
// confusingly at `mvn` instead of at the thing that is actually wrong.
function resolveAgentImage(opts) {
  const {
    environmentId = null,
    environmentName = null,
    toolchainId = null,
    toolchains = [],
    defaultImage = DEFAULT_AGENT_IMAGE,
    runtime = 'podman',
    // Where THIS deployment keeps its toolchain variant images (#1941 AC11).
    // Empty on a local Podman stack / a kind node, where the image sits in the
    // local store under exactly the bare tag the manifest names. Applied here
    // rather than at install time so a release re-pin reaches an already
    // registered toolchain — see `resolveToolchainImage`.
    imagePrefix = '',
    imageTag = '',
  } = opts || {};

  const fallback = String(defaultImage || '').trim() || DEFAULT_AGENT_IMAGE;
  const wanted = String(toolchainId == null ? '' : toolchainId).trim();
  if (!wanted) {
    return { image: fallback, toolchainId: null, toolchain: null, source: 'default' };
  }

  const toolchain = findToolchain(toolchains, wanted);
  if (!toolchain) {
    return {
      error: 'toolchain-not-registered',
      message:
        `Working Environment ${envLabel(environmentId, environmentName)} selects toolchain '${wanted}', ` +
        'which is not in the operator toolchain registry. A System Admin must register it ' +
        '(Working Environments → Toolchains), or clear the toolchain on the environment to ' +
        `fall back to the default image '${fallback}'.`,
    };
  }
  if (!supportsRuntime(toolchain, runtime)) {
    const rt = normalizeRuntime(runtime);
    return {
      error: 'toolchain-platform-mismatch',
      message:
        `Working Environment ${envLabel(environmentId, environmentName)} selects toolchain '${toolchain.id}' ` +
        `(${toolchain.name}), which declares platforms [${toolchain.platforms.join(', ')}] and so is not ` +
        `available on the '${rt}' runtime this installation uses.`,
    };
  }
  return {
    image: resolveToolchainImage(toolchain.image, { prefix: imagePrefix, tag: imageTag }),
    toolchainId: toolchain.id,
    toolchain,
    source: 'toolchain',
  };
}

// AC7's third case, rendered by the impure adapter that probed the image store /
// registry. Kept here so the podman and Kubernetes paths word it identically and
// both name the environment AND the toolchain — a bare libpod "no such image" or
// a k8s `ImagePullBackOff` says neither.
function missingImageMessage(opts) {
  const { environmentId = null, environmentName = null, toolchainId = null, image = '', runtime = 'podman' } = opts || {};
  const where = normalizeRuntime(runtime) === 'kubernetes'
    ? 'is not pullable by the cluster (check the Artifact Registry the nodes pull from and AEE_IMAGE_PULL_SECRET)'
    : 'is not present in the local image store (build it with `make toolchain-images`, or pull it)';
  const tc = String(toolchainId || '').trim();
  return (
    `Working Environment ${envLabel(environmentId, environmentName)} selects toolchain ` +
    `'${tc || '<unknown>'}', whose image '${image}' ${where}. ` +
    'Refusing to spawn the agent — falling back to the default image would start it without ' +
    'its toolchain and fail later at the first build command.'
  );
}

// Was a failed container create caused by the IMAGE not being there?
//
// Derived from the real create rather than from a preflight
// `/images/<name>/exists` probe on purpose: an image reference contains `/` and
// `:`, so the probe's own URL shape is a false-404 risk, and a false "absent"
// would refuse a spawn whose image is perfectly fine. The create either works
// or says why.
//
// Runtime asymmetry, stated rather than hidden: on Podman the create is
// synchronous and answers 404 + "no such image", which is what this reads. On
// Kubernetes the pod is accepted and the kubelet only later reports
// `ImagePullBackOff`, so that path keys on the waiting reason instead — same
// conclusion, different signal, and only the WORDING (missingImageMessage) is
// shared.
function isMissingImageFailure(status, body) {
  if (Number(status) !== 404) return false;
  const blob = typeof body === 'string' ? body : JSON.stringify(body || '');
  return /no such image|image not known|manifest unknown|unable to pull/i.test(blob);
}

module.exports = {
  DEFAULT_AGENT_IMAGE,
  TOOLCHAIN_ID_RE,
  KNOWN_PLATFORMS,
  VERSION_SOURCES,
  TOOLCHAIN_MANIFEST_VERSION,
  normalizeRuntime,
  validateImageRef,
  validateToolchain,
  validateToolchainManifest,
  toolchainFromManifest,
  resolveToolchainImage,
  normalizeRegistry,
  findToolchain,
  supportsRuntime,
  resolveAgentImage,
  missingImageMessage,
  isMissingImageFailure,
};
