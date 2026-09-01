'use strict';

// ─── Kubernetes plugin sidecar runtime (Network Plan epic Phase 5, #1565) ────
//
// The k8s counterpart of the Podman plugin-sidecar lifecycle in
// plugin-runtime.js. On Podman a broker is a sibling container plus per-agent
// network attachments; on Kubernetes it is a **Deployment + Service + PVC** per
// installed plugin, created THROUGH the Kubernetes API in the same raw-HTTPS
// `k8sRequest` style as spawn-kubernetes-pod.js — no client library. This module
// is a sibling of spawn-kubernetes-pod.js behind the container-runtime.js seam;
// plugin-runtime.js delegates to it when AEE_CONTAINER_RUNTIME=kubernetes.
//
// It re-declares the small service-account / CA plumbing itself (the same ~15
// lines pod-exec.js carries) rather than importing it — each k8s sibling stays
// independent, and only the higher-level pure planners are shared.
//
// What lives here: the three object manifests (Deployment / Service / state
// PVC), the reconcile that makes the live object set match the installed set,
// and the "which sidecars are up" lookup. The pure planners (reconcileSidecars,
// the AEE_PLUGIN_* env contract) are shared with the Podman path so the two
// runtimes cannot drift on the substance.
//
// ── State-PVC reinstall race (#1698) ─────────────────────────────────────────
// On GKE the per-plugin ReadWriteOnce state PVC deletes asynchronously (PD
// detach ~1–2 min). A quick uninstall→reinstall used to 409-skip the create
// against the still-Terminating PVC, which then finished deleting — leaving the
// new pod referencing a PVC that no longer exists (FailedScheduling → Pending
// forever). `ensureStatePvc` treats a Terminating PVC as *absent* and waits for
// it to vanish before creating a fresh one; `reconcilePluginSidecars` also
// self-heals an already-live broker whose state PVC went missing, so a wedge
// recovers on the next reconcile instead of needing a manual uninstall.
//
// ── Reachability splits by plugin kind (concept §9) ──────────────────────────
// A UI-only plugin (netzplan: capabilities: [], credentials: []) needs NO
// NetworkPolicy: no agent talks to its broker, and the console reaches its
// Service in-namespace. That is the half this epic needs, and the cheap one, so
// it is fully implemented here. A BROKER plugin — whose isolation story is
// "reachable only from granted agents' networks" — needs per-grant NetworkPolicy
// objects to reproduce what per-agent networks give for free on Podman. That is
// a different, larger mechanism; per the epic it is split out rather than allowed
// to block the board, so reconcilePluginAttachments is a no-op here and a broker
// plugin's CLI simply stays at exit 3 on a hosted stack (the `platforms` field
// on the Plugins page is the honest gate for this).
//
// ── Honest limit ─────────────────────────────────────────────────────────────
// `capabilities: ["podman-socket"]` has no Kubernetes equivalent — mounting a
// host container socket into a pod is not a thing one does. plugins/podman-sandbox
// stays platforms: ["podman"] permanently; this module never renders a socket
// mount, and such a plugin is gated out of a k8s stack by `platforms`.

const fs = require('fs');
const https = require('https');

const {
  reconcileSidecars,
  sidecarContainerName,
  brokerEnvContract,
  manifestHasSidecar,
} = require('./plugin-sidecar');
const { PLUGIN_ID_LABEL } = require('./plugin-scope');
const { installedManifests, readOrCreateSigningSecret, REGISTRY_DIR } = require('./plugin-registry');

// Shared scope-token signing secret, read once per process. Read directly from
// the registry (not via plugin-runtime) so there is no circular require between
// this module and the runtime that delegates to it.
let secretCache = null;
function signingSecret(dir = REGISTRY_DIR) {
  if (secretCache) return secretCache;
  secretCache = readOrCreateSigningSecret(dir);
  return secretCache;
}

// ── k8s API plumbing (mirrors spawn-kubernetes-pod.js / pod-exec.js) ─────────
function readFile(path, fallback) {
  try { return fs.readFileSync(path, 'utf8'); } catch { return fallback; }
}
function readFileBuffer(path) {
  try { return fs.readFileSync(path); } catch { return undefined; }
}

const NAMESPACE = process.env.AEE_K8S_NAMESPACE
  || readFile('/var/run/secrets/kubernetes.io/serviceaccount/namespace', 'default').trim();
const API_HOST = process.env.KUBERNETES_SERVICE_HOST;
const API_PORT = process.env.KUBERNETES_SERVICE_PORT || '443';
const CA = readFileBuffer('/var/run/secrets/kubernetes.io/serviceaccount/ca.crt');
const REQUEST_TIMEOUT_MS = Number(process.env.AEE_K8S_REQUEST_TIMEOUT_MS || 60000);

const APP_LABEL = process.env.AEE_K8S_APP_LABEL || 'agent-studio';
// Same instance scoping as the agent-pod path: two stacks sharing one namespace
// must not touch each other's plugin objects.
const INSTANCE_LABEL_KEY = 'aee.instance';
const INSTANCE_ID = process.env.AEE_INSTANCE_ID || process.env.COMPOSE_PROJECT_NAME || 'agent-studio-314092';
const COMPONENT = 'plugin-broker';

// A plugin broker sidecar does not need the broker image pulled Always on a
// local (kind) cluster where images are side-loaded; falls back to the agent
// image policy, then IfNotPresent, matching spawn-kubernetes-pod.js.
const BROKER_IMAGE_PULL_POLICY = process.env.AEE_PLUGIN_IMAGE_PULL_POLICY
  || process.env.AEE_AGENT_IMAGE_PULL_POLICY || 'IfNotPresent';
const IMAGE_PULL_SECRET = process.env.AEE_IMAGE_PULL_SECRET || '';
// State PVC size (§4.8 documents volume). Small — a board is a JSON document.
const STATE_PVC_SIZE = process.env.AEE_PLUGIN_STATE_PVC_SIZE || '1Gi';
// '' => the cluster default StorageClass (kind ships `standard`); set to pin one.
const STORAGE_CLASS = process.env.AEE_PLUGIN_STORAGE_CLASS || '';
// How long a (re)install waits for a still-Terminating state PVC from a recent
// uninstall to fully disappear before giving up (#1698). On GKE a ReadWriteOnce
// PVC's PD detach+delete is asynchronous (~1–2 min), so the default is generous.
const PVC_DELETE_WAIT_MS = Number(process.env.AEE_PLUGIN_PVC_DELETE_WAIT_MS || 150000);
const PVC_POLL_INTERVAL_MS = Number(process.env.AEE_PLUGIN_PVC_POLL_INTERVAL_MS || 2000);

// Mount paths — MUST match the Podman path (plugin-runtime.js STATE_MOUNT /
// AUDIT_MOUNT), because they become AEE_PLUGIN_STATE_DIR / AEE_PLUGIN_AUDIT_DIR
// and the broker reads those the same way on both runtimes.
const STATE_MOUNT = '/state';
const AUDIT_MOUNT = '/audit';

function serviceAccountToken() {
  return readFile('/var/run/secrets/kubernetes.io/serviceaccount/token', '').trim();
}

function k8sRequest(method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const token = serviceAccountToken();
    if (!API_HOST || !token) return reject(new Error('Kubernetes service-account environment/token not available'));
    const payload = body === undefined || body === null ? null : JSON.stringify(body);
    const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = https.request({ host: API_HOST, port: API_PORT, path: apiPath, method, ca: CA, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = raw; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error(`timeout after ${REQUEST_TIMEOUT_MS}ms`)));
    req.on('error', (err) => {
      const code = err.code ? `${err.code} ` : '';
      reject(new Error(`k8s ${method} ${apiPath} failed: ${code}${err.message}`));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

// ── object naming ────────────────────────────────────────────────────────────
// Deployment + Service share ONE name = the Podman sidecar container name
// (`aee-plugin-<id>`). Plugin ids are validated `a-z0-9-` and the prefix starts
// with a letter, so the name is a valid DNS-1035 label (Service requirement).
// Using the same name means brokerBaseUrl() — `http://aee-plugin-<id>:<port>` —
// resolves the container on Podman and the Service on Kubernetes with no branch.
function pluginResourceName(pluginId) {
  return sidecarContainerName(pluginId);
}
function statePvcName(pluginId) {
  return `${sidecarContainerName(pluginId)}-state`;
}

function commonLabels(pluginId) {
  return {
    'app.kubernetes.io/name': APP_LABEL,
    'app.kubernetes.io/component': COMPONENT,
    [PLUGIN_ID_LABEL]: String(pluginId),
    [INSTANCE_LABEL_KEY]: INSTANCE_ID,
  };
}

// The selector that ties a Service and Deployment to their pods — instance- and
// plugin-scoped so a parallel stack's brokers never answer for this one.
function selectorLabels(pluginId) {
  return { [PLUGIN_ID_LABEL]: String(pluginId), [INSTANCE_LABEL_KEY]: INSTANCE_ID };
}

// ── pure manifest builders (exported via _internal for unit tests) ───────────

function envToK8s(env) {
  return Object.entries(env || {})
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([name, value]) => ({ name, value: String(value) }));
}

// The state volume is a PVC, deliberately NOT an emptyDir: an emptyDir loses the
// board on every pod restart, and that failure looks like data corruption rather
// than a missing volume (concept §9 / AC "kubectl delete pod → content intact").
function buildStatePvcManifest(pluginId) {
  const spec = {
    accessModes: ['ReadWriteOnce'],
    resources: { requests: { storage: STATE_PVC_SIZE } },
  };
  if (STORAGE_CLASS) spec.storageClassName = STORAGE_CLASS;
  return {
    apiVersion: 'v1',
    kind: 'PersistentVolumeClaim',
    metadata: { name: statePvcName(pluginId), namespace: NAMESPACE, labels: commonLabels(pluginId) },
    spec,
  };
}

function buildServiceManifest(manifest) {
  const port = Number(manifest.sidecar.internalPort);
  return {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: { name: pluginResourceName(manifest.id), namespace: NAMESPACE, labels: commonLabels(manifest.id) },
    spec: {
      selector: selectorLabels(manifest.id),
      ports: [{ name: 'broker', port, targetPort: port }],
    },
  };
}

function buildDeploymentManifest(manifest, { signingSecret }) {
  const port = Number(manifest.sidecar.internalPort);
  const env = brokerEnvContract(manifest, {
    signingSecret,
    auditDir: AUDIT_MOUNT,
    stateDir: STATE_MOUNT,
  });
  const podSpec = {
    // The broker has no business calling the Kubernetes API — deny it a token,
    // exactly as agent pods are denied one (spawn-kubernetes-pod.js).
    automountServiceAccountToken: false,
    terminationGracePeriodSeconds: 20,
    containers: [{
      name: 'broker',
      image: manifest.sidecar.image,
      imagePullPolicy: BROKER_IMAGE_PULL_POLICY,
      ports: [{ containerPort: port }],
      env: envToK8s(env),
      volumeMounts: [
        { name: 'state', mountPath: STATE_MOUNT },
        { name: 'audit', mountPath: AUDIT_MOUNT },
      ],
      securityContext: {
        allowPrivilegeEscalation: false,
        capabilities: { drop: ['ALL'] },
      },
    }],
    volumes: [
      // State survives pod restarts (PVC). The audit trail is an emptyDir here:
      // it is best-effort append-only JSONL, not the board's source of truth, and
      // a per-plugin audit PVC on k8s is a separable follow-up (concept §9 lists
      // only the state PVC). Podman keeps a named volume for it; k8s audit
      // durability is a deliberate, documented difference.
      { name: 'state', persistentVolumeClaim: { claimName: statePvcName(manifest.id) } },
      { name: 'audit', emptyDir: {} },
    ],
  };
  if (IMAGE_PULL_SECRET) podSpec.imagePullSecrets = [{ name: IMAGE_PULL_SECRET }];

  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name: pluginResourceName(manifest.id), namespace: NAMESPACE, labels: commonLabels(manifest.id) },
    spec: {
      replicas: 1,
      selector: { matchLabels: selectorLabels(manifest.id) },
      template: {
        metadata: { labels: commonLabels(manifest.id) },
        spec: podSpec,
      },
    },
  };
}

// ── API paths ────────────────────────────────────────────────────────────────
const ns = () => encodeURIComponent(NAMESPACE);
function deploymentsPath(name = '') {
  return `/apis/apps/v1/namespaces/${ns()}/deployments${name ? `/${name}` : ''}`;
}
function servicesPath(name = '') {
  return `/api/v1/namespaces/${ns()}/services${name ? `/${name}` : ''}`;
}
function pvcsPath(name = '') {
  return `/api/v1/namespaces/${ns()}/persistentvolumeclaims${name ? `/${name}` : ''}`;
}

const labelSelector = () => encodeURIComponent(
  [`app.kubernetes.io/component=${COMPONENT}`, `${INSTANCE_LABEL_KEY}=${INSTANCE_ID}`].join(','),
);

// ── impure reconcile / lookup ────────────────────────────────────────────────

async function listPluginDeployments() {
  const r = await k8sRequest('GET', `${deploymentsPath()}?labelSelector=${labelSelector()}`);
  if (r.status >= 300 || !Array.isArray(r.body?.items)) return [];
  return r.body.items;
}

// The plugin id carried by a labelled Deployment.
function deploymentPluginId(dep) {
  return (dep && dep.metadata && dep.metadata.labels && dep.metadata.labels[PLUGIN_ID_LABEL]) || null;
}

// A plugin runs on Kubernetes iff its manifest `platforms` includes `kubernetes`
// or `any` (default `["any"]`). A podman-only plugin (e.g. podman-sandbox, whose
// `podman-socket` capability has no k8s equivalent) is excluded so reconcile
// never creates a broker that cannot work — and tears one down if it somehow
// exists. This is the runtime-side enforcement of the `platforms` gate.
function manifestSupportsK8s(manifest) {
  const platforms = Array.isArray(manifest && manifest.platforms) ? manifest.platforms : ['any'];
  return platforms.includes('kubernetes') || platforms.includes('any');
}

// A Deployment is "live" when at least one replica is available (Ready). Mirrors
// splitByRunning on the Podman path: a Deployment with 0 available replicas is a
// broker that is not answering yet, so its plugin is reported not-running.
function deploymentIsAvailable(dep) {
  return Number(dep?.status?.availableReplicas || 0) >= 1;
}

// One create call, tolerating 409 (already exists) so reconcile is idempotent.
// A definitive non-2xx that is not 409 is returned so the caller can record it.
async function createIfAbsent(apiPath, manifest) {
  const r = await k8sRequest('POST', apiPath, manifest);
  if (r.status < 300 || r.status === 409) return { ok: true, existed: r.status === 409 };
  return { ok: false, status: r.status, body: r.body };
}

async function deleteIgnoreMissing(apiPath) {
  const r = await k8sRequest('DELETE', apiPath, { propagationPolicy: 'Background' });
  return r.status < 300 || r.status === 404;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Pure: what a GET on the state PVC means for (re)install.
//   'absent'      — 404, safe to create.
//   'terminating' — exists but carries a deletionTimestamp: an uninstall's
//                   delete is still in flight; creating now 409-skips and the
//                   PVC then vanishes, leaving the pod referencing a PVC that no
//                   longer exists (#1698). Must wait for it to become 'absent'.
//   'present'     — a live PVC we can reuse.
//   'error'       — any other non-2xx (surfaced, not retried).
function classifyPvcState(getResult) {
  if (!getResult || getResult.status === 404) return 'absent';
  if (getResult.status >= 300) return 'error';
  const meta = getResult.body && getResult.body.metadata;
  return meta && meta.deletionTimestamp ? 'terminating' : 'present';
}

// Create the state PVC, robust to a still-Terminating PVC left by a recent
// uninstall (#1698). The bug this fixes: on GKE the per-plugin ReadWriteOnce
// state PVC deletes asynchronously (PD detach ~1–2 min), so a quick reinstall's
// naive create returns 409 → treated as "already exists" → skipped; the old PVC
// then finishes deleting and the new pod references a PVC that no longer exists
// → FailedScheduling ("persistentvolumeclaim … is being deleted / not found")
// → Pending forever. So a Terminating PVC is treated as *absent*: wait (poll to
// 404) for it to disappear, then create a fresh one. Injectable deps keep it
// unit-testable without a live cluster.
async function ensureStatePvc(manifest, opts = {}) {
  const request = opts.request || k8sRequest;
  const sleepFn = opts.sleepFn || sleep;
  const now = opts.now || Date.now;
  const deadlineMs = opts.deadlineMs != null ? opts.deadlineMs : PVC_DELETE_WAIT_MS;
  const intervalMs = opts.intervalMs != null ? opts.intervalMs : PVC_POLL_INTERVAL_MS;
  const name = statePvcName(manifest.id);
  const start = now();
  for (;;) {
    const state = classifyPvcState(await request('GET', pvcsPath(name)));
    if (state === 'present') return { ok: true, existed: true };
    if (state === 'error') return { ok: false, status: 0, body: { reason: 'state PVC lookup failed', name } };
    if (state === 'absent') {
      const created = await request('POST', pvcsPath(), buildStatePvcManifest(manifest.id));
      if (created.status < 300) return { ok: true, existed: false };
      // 409 here means a lingering Terminating PVC re-materialised between the
      // GET and the POST — loop back and wait it out rather than 409-skip.
      if (created.status !== 409) return { ok: false, status: created.status, body: created.body };
    }
    // 'terminating', or an absent→409 race: wait for the old PVC to vanish.
    if (now() - start >= deadlineMs) {
      return { ok: false, status: 409, body: { reason: 'state PVC still terminating after wait', name } };
    }
    await sleepFn(intervalMs);
  }
}

// Start a plugin's broker: PVC first (a Deployment referencing a missing PVC
// stays Pending on FailedMount), then the Deployment, then the Service.
async function startSidecar(manifest, dir = REGISTRY_DIR) {
  const secret = signingSecret(dir);
  const pvc = await ensureStatePvc(manifest);
  if (!pvc.ok) throw new Error(`state PVC for ${manifest.id}: status=${pvc.status} body=${JSON.stringify(pvc.body)}`);
  const dep = await createIfAbsent(deploymentsPath(), buildDeploymentManifest(manifest, { signingSecret: secret }));
  if (!dep.ok) throw new Error(`deployment for ${manifest.id}: status=${dep.status} body=${JSON.stringify(dep.body)}`);
  const svc = await createIfAbsent(servicesPath(), buildServiceManifest(manifest));
  if (!svc.ok) throw new Error(`service for ${manifest.id}: status=${svc.status} body=${JSON.stringify(svc.body)}`);
  console.log(`[spawn-kubernetes-plugin] started sidecar ${pluginResourceName(manifest.id)} (deployment+service, state PVC)`);
}

// Stop a plugin's broker on uninstall: remove Deployment, Service AND the state
// PVC (AC "Uninstall removes Deployment, Service and the PVC"). Uninstalling a
// plugin discards its board — reinstalling starts a fresh one, symmetric to the
// Podman path where the named volume is reaped.
async function stopSidecar(pluginId) {
  const name = pluginResourceName(pluginId);
  const okDep = await deleteIgnoreMissing(deploymentsPath(name));
  const okSvc = await deleteIgnoreMissing(servicesPath(name));
  const okPvc = await deleteIgnoreMissing(pvcsPath(statePvcName(pluginId)));
  console.log(`[spawn-kubernetes-plugin] stopped sidecar ${name} (deployment=${okDep} service=${okSvc} pvc=${okPvc})`);
  return okDep && okSvc && okPvc;
}

// Pure: which eligible plugins already have a live Deployment (so reconcile
// leaves them running) and therefore should have their state PVC checked for
// the #1698 wedge. A plugin missing its Deployment is (re)started by toStart and
// its PVC is (re)created there — it is not a self-heal candidate.
function healableStatePvcIds(eligibleIds, existingDeployments) {
  const liveIds = new Set((existingDeployments || []).map(deploymentPluginId).filter(Boolean));
  return (eligibleIds || []).filter((id) => liveIds.has(id));
}

// Self-heal the #1698 wedge: a broker whose Deployment exists but whose state
// PVC was reaped (the reinstall race left the pod stuck FailedScheduling on a
// PVC that "is being deleted / not found") never recovers on its own, because
// reconcileSidecars sees the Deployment and considers the sidecar live. So for
// each already-live eligible plugin we recreate the state PVC when it is absent.
// Only 'absent' is acted on: a 'present' PVC is healthy and a 'terminating' one
// belongs to an uninstall still in flight (that plugin would be a toStop orphan,
// not eligible) — neither is recreated here, and reconcile never blocks waiting.
// The stuck pod reschedules on the scheduler's own retry once the PVC exists.
async function selfHealStatePvcs(ids, manifests, opts = {}) {
  const request = opts.request || k8sRequest;
  const healed = [];
  const errors = [];
  for (const id of ids) {
    const manifest = manifests[id];
    if (!manifest) continue;
    try {
      const state = classifyPvcState(await request('GET', pvcsPath(statePvcName(id))));
      if (state !== 'absent') continue;
      const created = await request('POST', pvcsPath(), buildStatePvcManifest(id));
      if (created.status < 300 || created.status === 409) {
        healed.push(id);
        console.log(`[spawn-kubernetes-plugin] self-healed missing state PVC for ${id}`);
      } else {
        errors.push({ pluginId: id, phase: 'self-heal', error: `state PVC recreate status=${created.status}` });
      }
    } catch (err) {
      errors.push({ pluginId: id, phase: 'self-heal', error: err.message });
    }
  }
  return { healed, errors };
}

// Ensure a Deployment+Service+PVC for each installed plugin, remove orphans of
// uninstalled ones. Best-effort per plugin: one broken image must not stop the
// others (mirrors reconcilePluginSidecars on Podman).
async function reconcilePluginSidecars(dir = REGISTRY_DIR) {
  const manifests = installedManifests(dir);
  // Only k8s-eligible plugins count as "installed" here: a podman-only plugin
  // must not get a Deployment (and any stray one is torn down as an orphan). A
  // command-only plugin (#1798) declares no `sidecar`, so it is excluded too —
  // starting one would dereference `manifest.sidecar.image` on undefined (#1861).
  const eligibleIds = Object.keys(manifests)
    .filter((id) => manifestHasSidecar(manifests[id]) && manifestSupportsK8s(manifests[id]));
  const existing = await listPluginDeployments();
  // reconcileSidecars keys on Labels['aee.plugin.id'] — hand it the deployment
  // labels in the shape it expects.
  const live = existing.map((d) => ({ Labels: { [PLUGIN_ID_LABEL]: deploymentPluginId(d) } }));
  const { toStart, toStop } = reconcileSidecars(eligibleIds, live);

  const started = [];
  const stopped = [];
  const errors = [];
  for (const { pluginId } of toStop) {
    try { await stopSidecar(pluginId); stopped.push(pluginId); }
    catch (err) { errors.push({ pluginId, phase: 'stop', error: err.message }); }
  }
  for (const pluginId of toStart) {
    try { await startSidecar(manifests[pluginId], dir); started.push(pluginId); }
    catch (err) {
      console.warn(`[spawn-kubernetes-plugin] sidecar start failed for ${pluginId}: ${err.message}`);
      errors.push({ pluginId, phase: 'start', error: err.message });
    }
  }
  // Self-heal already-live brokers whose state PVC vanished (#1698).
  const heal = await selfHealStatePvcs(healableStatePvcIds(eligibleIds, existing), manifests);
  const healed = heal.healed;
  errors.push(...heal.errors);

  return { started, stopped, healed, errors };
}

// What is actually up, in the `{ Labels: { 'aee.plugin.id': id } }` shape the
// /internal/plugins and ui-endpoint routes consume from the Podman path.
async function listLiveSidecars() {
  const deps = await listPluginDeployments();
  return deps
    .filter(deploymentIsAvailable)
    .map((d) => ({ Labels: { [PLUGIN_ID_LABEL]: deploymentPluginId(d) } }))
    .filter((c) => c.Labels[PLUGIN_ID_LABEL]);
}

// Grant-driven reachability. A UI-only plugin needs no NetworkPolicy on k8s (the
// console reaches its Service in-namespace, no agent talks to it), so this is a
// no-op that keeps the orchestrator's reconcile loop happy. The per-grant
// NetworkPolicy objects that a BROKER plugin needs are the separable follow-up
// (concept §9) — split out rather than allowed to block the board.
async function reconcilePluginAttachments() {
  return { connected: [], disconnected: [], errors: [], skipped: 'kubernetes-ui-reachability-needs-no-networkpolicy' };
}

module.exports = {
  reconcilePluginSidecars,
  reconcilePluginAttachments,
  listLiveSidecars,
  startSidecar,
  stopSidecar,
  // Pure helpers exposed for unit tests only — not part of the delegated surface.
  _internal: {
    pluginResourceName,
    statePvcName,
    commonLabels,
    selectorLabels,
    envToK8s,
    buildStatePvcManifest,
    buildServiceManifest,
    buildDeploymentManifest,
    deploymentPluginId,
    deploymentIsAvailable,
    manifestSupportsK8s,
    classifyPvcState,
    ensureStatePvc,
    healableStatePvcIds,
    selfHealStatePvcs,
    STATE_MOUNT,
    AUDIT_MOUNT,
    NAMESPACE,
  },
};
