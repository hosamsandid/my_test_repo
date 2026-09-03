'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const {
  DEFAULT_AGENT_IMAGE,
  normalizeRuntime,
  validateImageRef,
  validateToolchain,
  normalizeRegistry,
  findToolchain,
  supportsRuntime,
  resolveAgentImage,
  missingImageMessage,
  isMissingImageFailure,
} = require('./toolchain-registry');

// The pure module is duplicated into the admin-console image (which copies only
// api/*.js), so the two copies must never drift — same guard as
// plugin-manifest.js / skill-manifest.js.
test('two-sided guard: orchestrator copy is byte-identical to admin-console copy', () => {
  const here = fs.readFileSync(path.join(__dirname, 'toolchain-registry.js'));
  const there = fs.readFileSync(path.join(__dirname, '..', 'admin-console', 'api', 'toolchain-registry.js'));
  assert.ok(here.equals(there), 'toolchain-registry.js copies differ — change both in one commit');
});

// ── runtime normalisation ────────────────────────────────────────────────────

test('normalizeRuntime folds the k8s alias and defaults to podman', () => {
  assert.strictEqual(normalizeRuntime('kubernetes'), 'kubernetes');
  assert.strictEqual(normalizeRuntime('K8S'), 'kubernetes');
  assert.strictEqual(normalizeRuntime('podman'), 'podman');
  assert.strictEqual(normalizeRuntime(undefined), 'podman');
  assert.strictEqual(normalizeRuntime('docker'), 'podman');
});

// ── image references ─────────────────────────────────────────────────────────

test('validateImageRef accepts the reference shapes the deploy tooling produces', () => {
  for (const image of [
    'as-agent:latest',
    'localhost/as-agent-jvm-21:latest',
    'europe-west4-docker.pkg.dev/proj/aee/as-agent:v3',
    'europe-west4-docker.pkg.dev/proj/aee/as-agent@sha256:' + 'a'.repeat(64),
    'registry.example.com:5000/team/as-agent:2026.09',
  ]) {
    assert.deepStrictEqual(validateImageRef(image), { ok: true, image }, image);
  }
});

test('validateImageRef rejects blanks, junk charsets and empty segments', () => {
  for (const bad of ['', '   ', 'as agent:latest', 'as-agent:latest;rm -rf /', '/as-agent', 'as-agent/', 'a//b', ':latest', 'as-agent:', 'as-agent@']) {
    assert.strictEqual(validateImageRef(bad).ok, false, JSON.stringify(bad));
  }
  assert.strictEqual(validateImageRef('x'.repeat(600)).ok, false);
});

test('validateImageRef trims surrounding whitespace rather than rejecting it', () => {
  assert.deepStrictEqual(validateImageRef('  as-agent:latest \n'), { ok: true, image: 'as-agent:latest' });
});

// ── registry entries ─────────────────────────────────────────────────────────

const JVM = { id: 'jvm-21', name: 'JVM 21', image: 'localhost/as-agent-jvm:latest', platforms: ['podman'] };

test('validateToolchain whitelists the persisted shape and defaults platforms to both runtimes', () => {
  const v = validateToolchain({ id: 'jvm-21', name: 'JVM 21', image: 'as-agent-jvm:latest', secretly: 'dropped' });
  assert.ok(v.ok, JSON.stringify(v.errors));
  assert.deepStrictEqual(v.toolchain, {
    id: 'jvm-21',
    name: 'JVM 21',
    description: '',
    stack: '',
    image: 'as-agent-jvm:latest',
    platforms: ['podman', 'kubernetes'],
    // #1941: both optional and empty unless declared, so a pre-#1941 entry
    // round-trips unchanged in meaning.
    versionSource: '',
    baseline: '',
  });
  assert.ok(!('secretly' in v.toolchain), 'extra keys must not reach the registry file');
});

test('validateToolchain requires id, name and image', () => {
  assert.deepStrictEqual(validateToolchain({}).errors.sort(), ['id is required', 'image is required', 'name is required']);
  assert.strictEqual(validateToolchain({ id: 'Bad Id', name: 'x', image: 'y:1' }).ok, false);
  assert.strictEqual(validateToolchain({ id: '-lead', name: 'x', image: 'y:1' }).ok, false, 'leading dash');
  assert.strictEqual(validateToolchain({ id: 'trail-', name: 'x', image: 'y:1' }).ok, false, 'trailing dash');
  assert.strictEqual(validateToolchain({ id: 'x'.repeat(41), name: 'x', image: 'y:1' }).ok, false, 'over length');
  // A 1-char id is legal, same as a plugin id (PLUGIN_ID_RE).
  assert.strictEqual(validateToolchain({ id: 'a', name: 'x', image: 'y:1' }).ok, true);
  assert.strictEqual(validateToolchain(null).ok, false);
});

test('validateToolchain rejects an unknown platform instead of widening it to podman', () => {
  const v = validateToolchain({ ...JVM, platforms: ['podman', 'nomad'] });
  assert.strictEqual(v.ok, false);
  assert.match(v.errors.join(' '), /unknown platform 'nomad'/);
});

test('validateToolchain folds the k8s alias and dedupes platforms', () => {
  const v = validateToolchain({ ...JVM, platforms: ['k8s', 'kubernetes'] });
  assert.ok(v.ok);
  assert.deepStrictEqual(v.toolchain.platforms, ['kubernetes']);
});

test('normalizeRegistry skips an invalid or duplicate entry with a reason, keeping the rest', () => {
  const { toolchains, errors } = normalizeRegistry([
    JVM,
    { id: 'broken', name: 'No image' },
    { ...JVM, name: 'JVM 21 again' },
    { id: 'go-1-23', name: 'Go 1.23', image: 'as-agent-go:latest' },
  ]);
  assert.deepStrictEqual(toolchains.map((t) => t.id), ['jvm-21', 'go-1-23']);
  assert.strictEqual(errors.length, 2);
  assert.match(errors[0], /'broken'.*image is required/);
  assert.match(errors[1], /'jvm-21'.*duplicate id/);
});

test('normalizeRegistry accepts a bare array or a { toolchains } wrapper and tolerates junk', () => {
  assert.deepStrictEqual(normalizeRegistry({ toolchains: [JVM] }).toolchains.map((t) => t.id), ['jvm-21']);
  assert.deepStrictEqual(normalizeRegistry(null).toolchains, []);
  assert.deepStrictEqual(normalizeRegistry('nope').toolchains, []);
});

test('findToolchain / supportsRuntime', () => {
  assert.strictEqual(findToolchain([JVM], 'jvm-21').name, 'JVM 21');
  assert.strictEqual(findToolchain([JVM], 'nope'), null);
  assert.strictEqual(findToolchain([JVM], ''), null);
  assert.strictEqual(findToolchain(null, 'jvm-21'), null);
  assert.strictEqual(supportsRuntime(JVM, 'podman'), true);
  assert.strictEqual(supportsRuntime(JVM, 'k8s'), false);
  assert.strictEqual(supportsRuntime(null, 'podman'), false);
  // A hand-written entry with no platforms is treated as "every runtime".
  assert.strictEqual(supportsRuntime({ id: 'x', image: 'y:1' }, 'kubernetes'), true);
});

// ── the resolution (AC1 / AC7 / AC10) ────────────────────────────────────────

test('AC1: no toolchain resolves to the installation-wide default, unchanged', () => {
  const r = resolveAgentImage({ environmentId: 'plain', toolchains: [JVM] });
  assert.deepStrictEqual(r, { image: DEFAULT_AGENT_IMAGE, toolchainId: null, toolchain: null, source: 'default' });
  assert.strictEqual(DEFAULT_AGENT_IMAGE, 'as-agent:latest');
});

test('AC1: AGENT_IMAGE keeps working as the default when no toolchain is selected', () => {
  const r = resolveAgentImage({ defaultImage: 'ar.example.com/proj/as-agent:v9', toolchains: [] });
  assert.strictEqual(r.image, 'ar.example.com/proj/as-agent:v9');
  assert.strictEqual(r.source, 'default');
  // An empty/blank override must not blank the image out.
  assert.strictEqual(resolveAgentImage({ defaultImage: '   ' }).image, DEFAULT_AGENT_IMAGE);
});

test('a registered, supported toolchain resolves to its image', () => {
  const r = resolveAgentImage({ environmentId: 'build', toolchainId: 'jvm-21', toolchains: [JVM], runtime: 'podman' });
  assert.strictEqual(r.image, 'localhost/as-agent-jvm:latest');
  assert.strictEqual(r.toolchainId, 'jvm-21');
  assert.strictEqual(r.source, 'toolchain');
  assert.strictEqual(r.error, undefined);
});

test('AC7: an unregistered toolchain refuses by name, never silently falling back', () => {
  const r = resolveAgentImage({ environmentId: 'build', environmentName: 'Build env', toolchainId: 'jvm-21', toolchains: [] });
  assert.strictEqual(r.error, 'toolchain-not-registered');
  assert.strictEqual(r.image, undefined, 'no image means the caller cannot spawn the default by accident');
  assert.match(r.message, /'build' \(Build env\)/);
  assert.match(r.message, /'jvm-21'/);
});

test('AC7/AC8: a toolchain not built for this runtime refuses by name', () => {
  const r = resolveAgentImage({ environmentId: 'build', toolchainId: 'jvm-21', toolchains: [JVM], runtime: 'kubernetes' });
  assert.strictEqual(r.error, 'toolchain-platform-mismatch');
  assert.strictEqual(r.image, undefined);
  assert.match(r.message, /'jvm-21'/);
  assert.match(r.message, /kubernetes/);
});

test('the environment label degrades gracefully without a name', () => {
  const r = resolveAgentImage({ environmentId: 'build', toolchainId: 'nope', toolchains: [] });
  assert.match(r.message, /Working Environment 'build' selects/);
  const anon = resolveAgentImage({ toolchainId: 'nope', toolchains: [] });
  assert.match(anon.message, /'<unknown>'/);
});

test('isMissingImageFailure recognises libpod\'s missing-image create reply', () => {
  assert.equal(isMissingImageFailure(404, { cause: 'image not known', message: 'no such image "localhost/x:1"' }), true);
  assert.equal(isMissingImageFailure(404, 'no such image'), true);
  assert.equal(isMissingImageFailure('404', { message: 'manifest unknown' }), true, 'status may arrive as a string');
});

test('isMissingImageFailure does not claim unrelated failures, so a real error keeps its own message', () => {
  // A 404 that is not about the image, and non-404 failures, must fall through
  // to the generic create error — mislabelling them would send an operator
  // hunting a toolchain problem that does not exist.
  assert.equal(isMissingImageFailure(404, { message: 'no such volume "pool"' }), false);
  assert.equal(isMissingImageFailure(500, { message: 'no such image' }), false);
  assert.equal(isMissingImageFailure(409, 'conflict'), false);
  assert.equal(isMissingImageFailure(404, null), false);
  assert.equal(isMissingImageFailure(undefined, undefined), false);
});

test('AC7: the missing-image refusal names the environment, the toolchain and the runtime remedy', () => {
  const podman = missingImageMessage({ environmentId: 'build', toolchainId: 'jvm-21', image: 'localhost/x:1' });
  assert.match(podman, /'build'/);
  assert.match(podman, /'jvm-21'/);
  assert.match(podman, /localhost\/x:1/);
  assert.match(podman, /local image store/);
  const k8s = missingImageMessage({ environmentId: 'build', toolchainId: 'jvm-21', image: 'ar/x:1', runtime: 'kubernetes' });
  assert.match(k8s, /Artifact Registry/);
  assert.match(k8s, /AEE_IMAGE_PULL_SECRET/);
});

// ── source manifests (#1941) ─────────────────────────────────────────────────

const {
  VERSION_SOURCES,
  TOOLCHAIN_MANIFEST_VERSION,
  validateToolchainManifest,
  toolchainFromManifest,
  resolveToolchainImage,
} = require('./toolchain-registry');

const JVM_MANIFEST = {
  toolchainVersion: 1,
  id: 'jvm',
  name: 'JVM (Java + Maven)',
  stack: 'jvm',
  description: 'Adds a version manager so the project repository pins the JDK.',
  image: 'as-agent-jvm:latest',
  platforms: ['podman', 'kubernetes'],
  versionSource: 'bootstrap',
  versionManager: 'mise',
  baseline: 'java 21, maven 3.9',
};

test('a valid source manifest normalises to the registry shape plus its own fields', () => {
  const v = validateToolchainManifest(JVM_MANIFEST, { dirId: 'jvm' });
  assert.ok(v.ok, JSON.stringify(v.errors));
  assert.equal(v.manifest.id, 'jvm');
  assert.equal(v.manifest.versionSource, 'bootstrap');
  assert.equal(v.manifest.versionManager, 'mise');
  assert.equal(v.manifest.baseline, 'java 21, maven 3.9');
  assert.equal(v.manifest.toolchainVersion, TOOLCHAIN_MANIFEST_VERSION);
});

test('the manifest version is enforced, so a future shape change fails at build time', () => {
  const v = validateToolchainManifest({ ...JVM_MANIFEST, toolchainVersion: 2 });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /toolchainVersion must be 1/.test(e)));
  assert.equal(validateToolchainManifest({ ...JVM_MANIFEST, toolchainVersion: undefined }).ok, false);
});

test('a source manifest REQUIRES the description an operator reads before installing', () => {
  const v = validateToolchainManifest({ ...JVM_MANIFEST, description: '   ' });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /description is required/.test(e)));
});

test('versionSource is required and closed — "is a JDK baked in?" may not be implied', () => {
  const missing = validateToolchainManifest({ ...JVM_MANIFEST, versionSource: undefined, versionManager: undefined });
  assert.equal(missing.ok, false);
  assert.ok(missing.errors.some((e) => /versionSource is required/.test(e)));
  const bogus = validateToolchainManifest({ ...JVM_MANIFEST, versionSource: 'whatever' });
  assert.equal(bogus.ok, false);
  assert.ok(bogus.errors.some((e) => /versionSource must be/.test(e)));
  assert.deepEqual(VERSION_SOURCES, ['bootstrap', 'baked']);
});

test('bootstrap must name a version manager; baked must not', () => {
  const noManager = validateToolchainManifest({ ...JVM_MANIFEST, versionManager: undefined });
  assert.equal(noManager.ok, false);
  assert.ok(noManager.errors.some((e) => /must name its versionManager/.test(e)));

  const baked = validateToolchainManifest({
    ...JVM_MANIFEST, id: 'jvm-21-offline', versionSource: 'baked', versionManager: undefined, baseline: 'java 21.0.5',
  });
  assert.ok(baked.ok, JSON.stringify(baked.errors));
  assert.equal(baked.manifest.versionSource, 'baked');

  const bakedWithManager = validateToolchainManifest({ ...JVM_MANIFEST, versionSource: 'baked' });
  assert.equal(bakedWithManager.ok, false);
  assert.ok(bakedWithManager.errors.some((e) => /resolves no version/.test(e)));
});

test('a copied toolchain directory cannot register under the id it was copied from', () => {
  const v = validateToolchainManifest(JVM_MANIFEST, { dirId: 'dotnet' });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /does not match directory 'dotnet'/.test(e)));
  // Without a dirId (a hand-posted body) the check is simply not applicable.
  assert.equal(validateToolchainManifest(JVM_MANIFEST).ok, true);
});

test('the manifest inherits every registry-entry rule, so one schema governs both doors', () => {
  const v = validateToolchainManifest({ ...JVM_MANIFEST, image: 'as-agent-jvm:', platforms: ['openshift'] });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /empty tag or digest/.test(e)));
  assert.ok(v.errors.some((e) => /unknown platform 'openshift'/.test(e)));
});

test('AC11: the deployment decides where the image is pulled from, not the manifest', () => {
  const AR = 'europe-west3-docker.pkg.dev/p/agent-studio';
  // Local Podman / kind: neither half set, the bare tag the build produced.
  assert.equal(resolveToolchainImage('as-agent-jvm:latest', { prefix: '', tag: '' }), 'as-agent-jvm:latest');
  assert.equal(resolveToolchainImage('as-agent-jvm:latest', {}), 'as-agent-jvm:latest');
  // Cluster: the Artifact Registry path the release pushed to (trailing slash
  // tolerated — it comes from a hand-edited overlay patch) AND the release tag,
  // so a manifest's placeholder `:latest` never reaches a pod.
  assert.equal(resolveToolchainImage('as-agent-jvm:latest', { prefix: AR }), `${AR}/as-agent-jvm:latest`);
  assert.equal(resolveToolchainImage('as-agent-jvm:latest', { prefix: `${AR}/` }), `${AR}/as-agent-jvm:latest`);
  assert.equal(
    resolveToolchainImage('as-agent-jvm:latest', { prefix: AR, tag: 'v1.4.0' }),
    `${AR}/as-agent-jvm:v1.4.0`,
  );
  // The two halves are independent: a tag with no prefix re-tags in place (what
  // a kind node side-loading a release-tagged image would want).
  assert.equal(resolveToolchainImage('as-agent-jvm:latest', { tag: 'v1.4.0' }), 'as-agent-jvm:v1.4.0');
  // A manifest that declares no tag at all gains the release tag, not a stray colon.
  assert.equal(resolveToolchainImage('as-agent-jvm', { prefix: AR }), `${AR}/as-agent-jvm`);
  assert.equal(resolveToolchainImage('as-agent-jvm', { tag: 'v1.4.0' }), 'as-agent-jvm:v1.4.0');
});

test('an image that already carries a registry or a digest is never rewritten', () => {
  // The #1940 hand-registration path: a System Admin who typed a full reference
  // for their own image must not have it re-pointed at OUR registry/release.
  const full = 'europe-west3-docker.pkg.dev/p/r/as-agent-jvm:v1';
  const opts = { prefix: 'other.registry/x', tag: 'v9' };
  assert.equal(resolveToolchainImage(full, opts), full);
  assert.equal(resolveToolchainImage('as-agent-jvm@sha256:abc', opts), 'as-agent-jvm@sha256:abc');
  assert.equal(resolveToolchainImage('', opts), '');
});

test('AC11: resolveAgentImage applies the deployment reference at SPAWN time', () => {
  // The load-bearing property: the PERSISTED entry keeps the bare tag, so a
  // release that re-pins the tag reaches a toolchain installed long before it —
  // no operator re-install, and no stale reference in the registry file.
  const toolchains = normalizeRegistry([{ id: 'jvm', name: 'JVM', image: 'as-agent-jvm:latest' }]).toolchains;
  const AR = 'europe-west3-docker.pkg.dev/p/agent-studio';
  assert.equal(resolveAgentImage({ toolchainId: 'jvm', toolchains }).image, 'as-agent-jvm:latest');
  assert.equal(
    resolveAgentImage({ toolchainId: 'jvm', toolchains, imagePrefix: AR, imageTag: 'v1.4.0' }).image,
    `${AR}/as-agent-jvm:v1.4.0`,
  );
  // The registry entry itself is untouched by the resolution.
  assert.equal(toolchains[0].image, 'as-agent-jvm:latest');
  // The default image is NOT a toolchain image and never gets the treatment —
  // AGENT_IMAGE already arrives fully qualified from the same overlay patch.
  assert.equal(
    resolveAgentImage({ toolchains, defaultImage: 'as-agent:latest', imagePrefix: AR, imageTag: 'v1.4.0' }).image,
    'as-agent:latest',
  );
});

test('toolchainFromManifest yields an entry validateToolchain accepts (one gatekeeper)', () => {
  const m = validateToolchainManifest(JVM_MANIFEST, { dirId: 'jvm' }).manifest;
  const entry = toolchainFromManifest(m);
  // Verbatim — the deployment reference is applied at spawn time, not persisted.
  assert.equal(entry.image, 'as-agent-jvm:latest');
  assert.equal(entry.versionSource, 'bootstrap');
  // The manifest-only field must NOT reach the registry entry: the persisted
  // file stays exactly what the resolver + the panel read.
  assert.ok(!('versionManager' in entry));
  assert.ok(!('toolchainVersion' in entry));
  const re = validateToolchain(entry);
  assert.ok(re.ok, JSON.stringify(re.errors));
  assert.deepEqual(re.toolchain, entry);
});

test('a pre-#1941 registry entry (no versionSource/baseline) still validates and still resolves', () => {
  // Back-compat is load-bearing: dropping a live environment's toolchain over a
  // missing informational string would refuse every spawn bound to it.
  const legacy = { id: 'jvm', name: 'JVM', image: 'as-agent-jvm:latest' };
  const v = validateToolchain(legacy);
  assert.ok(v.ok, JSON.stringify(v.errors));
  assert.equal(v.toolchain.versionSource, '');
  assert.equal(v.toolchain.baseline, '');
  const { toolchains, errors } = normalizeRegistry([legacy]);
  assert.deepEqual(errors, []);
  assert.equal(resolveAgentImage({ toolchainId: 'jvm', toolchains }).image, 'as-agent-jvm:latest');
});
