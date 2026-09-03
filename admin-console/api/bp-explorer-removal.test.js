'use strict';

// Removal guard for the `bp-explorer` service and its build/deployment wiring
// (#1963, epic #1961 Phase 2).
//
// WHY IT LIVES HERE. The surface under test is the repository's deployment
// machinery — compose, the kustomize bases and overlays, the bring-up scripts,
// the deploy workflow — and none of that has a CI-run test root of its own.
// `admin-console/api` is the nearest one (ci.yml `admin-api` runs a bare
// `node --test` in this directory) and it is also where the service's address
// lived, as `BP_EXPLORER_URL` in `api.js`. Reading repo-root files from here is
// already precedent (`skill-import.test.js` reads `../../orchestrator/…`).
//
// WHY IT IS A SEPARATE FILE from `bp-removal-guard.test.js`. That guard's claim
// is about console-API *routes*; this one's is about whether the service is
// deployed at all. Splitting by claim rather than by file is what keeps each
// one readable — and this phase deliberately KEEPS three mentions of the name
// (the in-place-upgrade reaping in the two up scripts and the deploy workflow),
// so a blanket `doesNotMatch(/bp-explorer/)` over the deployment tree would be
// wrong in both directions: it would fail on the reaping we require, and it
// would say nothing about a service block coming back under another name.
// Every assertion below is therefore anchored on a specific wiring point, and
// each file also carries a POSITIVE assertion about what must still be there —
// otherwise a mistyped path would make the absence checks pass for a file that
// was never read.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..', '..');
const repoPath = (...p) => path.join(REPO, ...p);
const read = (...p) => fs.readFileSync(repoPath(...p), 'utf8');
const exists = (...p) => fs.existsSync(repoPath(...p));

// ---- AC1: the service source and its Kubernetes workload are gone ---------

test('AC1: the bp-explorer source tree no longer exists', () => {
  assert.equal(exists('bp-explorer'), false, 'bp-explorer/ is back');
  for (const f of ['server.py', 'aee_bridge.py', 'qg_prompt_template.md', 'Dockerfile', 'requirements.txt']) {
    assert.equal(exists('bp-explorer', f), false, `bp-explorer/${f} is back`);
  }
  // The repo root still looks like the repo root — a wrong REPO path would
  // otherwise satisfy every assertion in this file.
  assert.equal(exists('docker-compose.yml'), true, 'REPO does not point at the repository root');
  assert.equal(exists('deploy', 'k8s', 'base', 'app'), true, 'REPO does not point at the repository root');
});

test('AC1: the Kubernetes Deployment + Service manifest is gone', () => {
  assert.equal(exists('deploy', 'k8s', 'base', 'app', '60-bp-explorer.yaml'), false);
  // …and its siblings, which must not have gone with it.
  assert.equal(exists('deploy', 'k8s', 'base', 'app', '40-orchestrator.yaml'), true);
  assert.equal(exists('deploy', 'k8s', 'base', 'app', '50-admin-console.yaml'), true);
});

// ---- AC1/AC2: compose ------------------------------------------------------

test('AC1: docker-compose.yml declares no bp-explorer service', () => {
  const compose = read('docker-compose.yml');
  // Anchored on the service KEY (two-space indent at line start), which is what
  // `podman compose up` acts on — not on the bare word, so a future comment
  // explaining the removal would not fail this.
  assert.doesNotMatch(compose, /^ {2}bp-explorer:/m, 'the bp-explorer service block is back');
  assert.doesNotMatch(compose, /BP_EXPLORER_URL/, 'BP_EXPLORER_URL is back in compose');
  assert.doesNotMatch(compose, /AEE_ENABLED/, 'the AEE_ENABLED companion is back');
  assert.doesNotMatch(compose, /8765/, 'the bp-explorer port is back');
  // Its `~/.gitconfig` bind-mount was the last one in the file, and several
  // docs told operators to create that file *because of it* — so the mount
  // going away is part of this claim, not an incidental detail.
  assert.doesNotMatch(compose, /\.gitconfig/, 'the ~/.gitconfig bind-mount is back');
  // The services that remain, and the shared volume the removed one mounted —
  // AC2's "no missing-service errors" and the edge case's "must not disturb
  // the others" are both about these still being intact.
  for (const svc of ['conduwuit', 'orchestrator', 'admin-console', 'stt']) {
    assert.match(compose, new RegExp(`^ {2}${svc}:`, 'm'), `the ${svc} service is missing`);
  }
  assert.match(compose, /agent-pool-workspace:\/workspace/, 'the shared workspace mount is gone');
});

// ---- AC1: kustomize base + every overlay ----------------------------------

test('AC1: no kustomization references the manifest or the image', () => {
  const kustomizations = [
    ['deploy', 'k8s', 'base', 'app', 'kustomization.yaml'],
    ['deploy', 'k8s', 'overlays', 'test', 'app', 'kustomization.yaml'],
    ['deploy', 'k8s', 'overlays', 'preprod', 'app', 'kustomization.yaml'],
  ];
  for (const k of kustomizations) {
    const src = read(...k);
    const where = k.join('/');
    assert.doesNotMatch(src, /60-bp-explorer\.yaml/, `${where} still lists the manifest`);
    assert.doesNotMatch(src, /bp-explorer/, `${where} still names bp-explorer`);
    // Non-vacuity: each file must still carry the two that remain.
    assert.match(src, /orchestrator/, `${where} lost its orchestrator entry`);
    assert.match(src, /admin-console/, `${where} lost its admin-console entry`);
  }
  // Every other kustomization in the tree, so a re-introduction in an overlay
  // this list forgot still fails. Swept, not enumerated.
  const overlaysDir = repoPath('deploy', 'k8s');
  const files = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === 'kustomization.yaml') files.push(p);
    }
  })(overlaysDir);
  assert.ok(files.length >= 8, `expected the overlay set, found ${files.length} kustomizations`);
  for (const f of files) {
    assert.doesNotMatch(fs.readFileSync(f, 'utf8'), /bp-explorer/,
      `${path.relative(REPO, f)} references bp-explorer`);
  }
});

test('AC1: the storage note no longer counts bp-explorer as a workspace mounter', () => {
  const storage = read('deploy', 'k8s', 'base', 'core', '20-storage.yaml');
  assert.doesNotMatch(storage, /bp-explorer/);
  // The PVC itself is shared with the components that DO mount it (edge case 2).
  assert.match(storage, /name: agent-studio-workspace/);
});

// ---- AC1/AC2/AC3: bring-up scripts and the deploy workflow ---------------
//
// These three files legitimately still contain the name, in the reaping step
// below. So each is asserted on what it must no longer DO (build, side-load,
// roll out, wait) rather than on the word.

test('AC1: kind-up.sh neither builds nor rolls out the service', () => {
  const src = read('deploy', 'k8s', 'kind-up.sh');
  assert.doesNotMatch(src, /build_and_load\s+agent-studio-bp-explorer/, 'kind-up still side-loads the image');
  assert.doesNotMatch(src, /rollout restart[^\n]*deploy\/bp-explorer/, 'kind-up still restarts the Deployment');
  assert.doesNotMatch(src, /for d in[^\n]*bp-explorer/, 'kind-up still waits for its rollout');
  // The two images it must still build, and the two rollouts it must still wait
  // for — a dangling rollout wait is exactly what AC2 forbids.
  assert.match(src, /build_and_load agent-studio-orchestrator/);
  assert.match(src, /build_and_load agent-studio-admin-console/);
  assert.match(src, /for d in orchestrator admin-console; do/);
});

test('AC1: gke-up.sh neither pins nor rolls out the service', () => {
  const src = read('deploy', 'k8s', 'gke-up.sh');
  assert.doesNotMatch(src, /rollout restart[^\n]*deploy\/bp-explorer/, 'gke-up still restarts the Deployment');
  assert.doesNotMatch(src, /for d in[^\n]*bp-explorer/, 'gke-up still waits for its rollout');
  assert.match(src, /for d in orchestrator admin-console; do/);
});

test('AC3: the deploy workflow no longer builds or pushes the image', () => {
  const wf = read('.github', 'workflows', 'deploy-gke.yml');
  assert.doesNotMatch(wf, /docker build[^\n]*bp-explorer/, 'the workflow still builds the image');
  assert.doesNotMatch(wf, /for img in[^\n]*bp-explorer/, 'the workflow still pushes the image');
  assert.doesNotMatch(wf, /for d in[^\n]*bp-explorer/, 'the workflow still waits for its rollout');
  // The images it must still build + push, and the rollouts it must still wait
  // for (AC3's "a GKE deploy succeeds with the workload removed").
  assert.match(wf, /docker build[^\n]*agent-studio-orchestrator/);
  assert.match(wf, /docker build[^\n]*agent-studio-admin-console/);
  assert.match(wf, /for img in agent-studio-orchestrator agent-studio-admin-console as-agent; do/);
  assert.match(wf, /for d in orchestrator admin-console; do/);
});

test('edge case: an in-place upgrade reaps the orphaned Deployment and Service', () => {
  // `kubectl apply -k` does not prune, so a cluster first brought up before
  // this removal keeps the old Deployment and Service running against the
  // workspace PVC forever. All three apply paths must delete them; asserted
  // POSITIVELY, because absence of the reaping is indistinguishable from a
  // clean removal until an operator upgrades a real cluster.
  const paths = [
    ['deploy', 'k8s', 'kind-up.sh'],
    ['deploy', 'k8s', 'gke-up.sh'],
    ['.github', 'workflows', 'deploy-gke.yml'],
  ];
  for (const p of paths) {
    const src = read(...p);
    assert.match(src, /delete deploy\/bp-explorer svc\/bp-explorer --ignore-not-found/,
      `${p.join('/')} does not reap the orphaned bp-explorer workload`);
  }
});

test('AC1: the VM bring-up script no longer provisions bp-explorer host files', () => {
  const src = read('deploy', 'gcp', 'vm-stack-setup.sh');
  // The `~/.gitconfig` block existed only because the service bind-mounted it.
  assert.doesNotMatch(src, /git config --global/, 'the gitconfig provisioning block is back');
  // The SSH keypair in the same step is NOT ours to remove — it is a live
  // compose mount (`ORCHESTRATOR_SSH_KEY`).
  assert.match(src, /ssh-keygen -t ed25519/, 'the orchestrator SSH keypair generation was removed');
});

test('AC1: render-check.sh keeps asserting the absence in every rendered overlay', () => {
  const src = read('deploy', 'k8s', 'render-check.sh');
  assert.doesNotMatch(src, /for img in[^\n]*bp-explorer/, 'render-check still expects the AR image');
  // Positive: the k8s half of AC1 is a rendered-output property (a kustomize
  // build can reintroduce an object no source file names outright), so the
  // sweep in render-check is load-bearing and must not be dropped.
  assert.match(src, /expect_absent "\$f" 'bp-explorer'/, 'the rendered-overlay sweep is gone');
});

// ---- AC4/AC5: nothing calls the service; the endpoint question is settled --

test('AC5: the dead workspace-tree endpoint and its only caller are gone', () => {
  assert.equal(exists('admin-console', 'src', 'components', 'DirectoryPicker.jsx'), false,
    'DirectoryPicker.jsx is back');
  // A sibling that must survive, so a wrong path cannot pass the check above.
  assert.equal(exists('admin-console', 'src', 'components', 'Tooltip.jsx'), true,
    'the components directory path is wrong');
});

/**
 * Strip whole-line comments before sweeping for an address.
 *
 * Load-bearing, and this file proves why: the removal's own explanatory
 * comments are the thing most likely to name what went away. `Agents.jsx` now
 * carries a note reading "the `/api/bp-explorer/*` console proxy", whose
 * backtick + path matches the URL-literal pattern below exactly.
 *
 * Line-oriented, never `/\/\*[\s\S]*?\*\//`: that sweep reads the `/*` inside a
 * route string such as `'/plugins/:id/ui/*'` as a block-comment opener and eats
 * hundreds of lines of real code, after which the absence sweep would pass for
 * entirely the wrong reason (the hazard `bp-removal-guard.test.js` documents).
 * Trailing comments are deliberately NOT stripped — a false negative in a
 * removal guard is worse than a false positive, and a real reference is never
 * on a line that opens with a comment marker.
 */
function stripLineComments(src) {
  return src
    .replace(/^[ \t]*\/\/[^\n]*$/gm, '')  // whole-line // comments
    .replace(/^[ \t]*#[^\n]*$/gm, '')     // whole-line # comments (py, yaml)
    .replace(/^[ \t]*\*[^\n]*$/gm, '')    // continuation lines of /* … */
    .replace(/^[ \t]*\/\*[^\n]*$/gm, ''); // opening line of a /* … */ block
}

test('AC4: no source file holds an address for the removed service', () => {
  // Swept over the shipped source trees rather than a fixed file list: the
  // service was reachable from anywhere that could construct its URL. Docs and
  // tests are excluded — historical prose and these very assertions name it on
  // purpose — as are the three reaping call sites asserted above.
  const roots = ['orchestrator', 'admin-console/api', 'admin-console/src', 'agent-image', 'plugins'];
  const offenders = [];
  const skipDir = new Set(['node_modules', 'dist', '.git']);
  for (const root of roots) {
    const base = repoPath(...root.split('/'));
    if (!fs.existsSync(base)) continue;
    (function walk(dir) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (skipDir.has(e.name)) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        if (!/\.(js|jsx|mjs|cjs|py|json|yml|yaml)$/.test(e.name)) continue;
        if (e.name.endsWith('.test.js')) continue;
        const src = stripLineComments(fs.readFileSync(p, 'utf8'));
        // The address, the env var, and any URL/route that would reach it.
        for (const re of [/bp-explorer:8765/, /BP_EXPLORER_URL/, /['"`][^'"`\n]*\/api\/bp-explorer/]) {
          if (re.test(src)) offenders.push(`${path.relative(REPO, p)}: ${re}`);
        }
      }
    })(base);
  }
  assert.deepEqual(offenders, [], `source still addresses bp-explorer:\n${offenders.join('\n')}`);
});
