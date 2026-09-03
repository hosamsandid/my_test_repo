'use strict';

// Kubernetes implementation of the container-runtime seam (see
// container-runtime.js). The orchestrator itself runs as a pod and creates one
// agent Pod per agent THROUGH THE KUBERNETES API, authenticated with its
// projected service-account token — no host container socket is mounted
// anywhere. Selected via AEE_CONTAINER_RUNTIME=kubernetes|k8s.
//
// Exports the same five functions as spawn-container.js (the Podman path):
//   spawnContainer({id, env, contextMounts})
//                              -> EventEmitter handle (stdout/stderr/kill/exit)
//   libpodRequest(method,path) -> compat shim: answers the orchestrator's
//                                 "list/delete labelled containers" queries
//                                 from labelled agent Pods instead
//   removePerAgentVolume / removePerAgentNetwork / reseedPerAgentVolume
//                              -> no-ops (see the differences block below)
//
// Deliberate differences vs spawn-container.js — parity-checked in #1319;
// anything NOT listed here that lands on one runtime only is drift, not
// design (see the seam discipline note in container-runtime.js):
//   - pids limit: Podman applies AEE_AGENT_PIDS_LIMIT per container; the k8s
//     pod spec has no per-pod equivalent — the operator-level knob is the
//     kubelet's podPidsLimit (node config). Accepted, intentionally absent.
//   - per-agent volume (#185): no-op — filesystem isolation is the shared
//     workspace PVC's per-agent subPath in buildPodManifest; dedicated
//     per-agent PVCs belong to the k8s-at-scale concept, not this file.
//   - per-agent network (Podman Seam #2): no-op — agent pods share the
//     cluster network; segmentation is an operator-applied NetworkPolicy
//     (none ships in deploy/k8s/base/ today — deliberate stance, agents
//     need orchestrator + conduwuit and the manifests target single-node
//     local clusters).
//   - context mounts (#1283/#1289/#1290): rendered as hostPath volumes, so
//     "host" means THE NODE (on kind: the node container — a Mac folder needs
//     an extraMounts entry at cluster creation, see deploy/k8s/README.md).
//     Only meaningful on single-node local clusters; opt-in via
//     AEE_K8S_CONTEXT_HOSTPATH=1, never on hosted GKE.
//   - SIGUSR1/SIGUSR2: k8s cannot forward per-process signals through the pod
//     API — see the kill() handler for the mapping.
//   - plugin broker sidecars (#1547/#1565): now IMPLEMENTED for UI-bearing
//     plugins — PLUGIN_SIDECARS_SUPPORTED is true and plugin-runtime.js delegates
//     the runtime-divergent entry points to spawn-kubernetes-plugin.js, which
//     creates a Deployment + Service + state PVC per installed plugin through the
//     k8s API (same raw-HTTPS style as this file). On Podman a broker is a sibling
//     container plus per-agent network attachments; the k8s equivalent replaces
//     the sibling container with the Deployment+Service and the state named-volume
//     with a PVC (an emptyDir would silently lose the board on pod restart).
//     STILL DIFFERENT — the grant-driven per-agent-network reachability that a
//     BROKER plugin needs becomes per-grant NetworkPolicy objects, which is a
//     larger, separable mechanism: a UI-only plugin (netzplan) needs NO
//     NetworkPolicy because the console reaches its Service in-namespace and no
//     agent talks to it, so reconcilePluginAttachments is a no-op here and a
//     broker plugin's CLI stays at exit 3 on a hosted stack until that split-out
//     work lands (the Plugins page states this via `platforms`).
//   - podman-socket capability: no k8s equivalent — a host container socket
//     cannot be mounted into a pod. plugins/podman-sandbox stays
//     platforms: ["podman"] permanently and is gated out of a k8s stack.
//
// RBAC needed by the orchestrator's ServiceAccount (namespaced Role):
//   pods [get, list, create, delete] + pods/log [get] + pods/exec [create]
//   (pods/exec backs the context browse/write transport in pod-exec.js)
// Agent pods run under a separate ServiceAccount with
// automountServiceAccountToken: false — agents get NO API access.

const fs = require('fs');
const https = require('https');
const { EventEmitter, PassThrough } = require('stream');
const { validateHostMountPath, CONTEXT_MOUNT_TARGET } = require('./context-mount');
const {
  DEFAULT_AGENT_IMAGE: BUILTIN_AGENT_IMAGE,
  missingImageMessage,
} = require('./toolchain-registry');

const NAMESPACE = process.env.AEE_K8S_NAMESPACE || readFile('/var/run/secrets/kubernetes.io/serviceaccount/namespace', 'default').trim();
const API_HOST = process.env.KUBERNETES_SERVICE_HOST;
const API_PORT = process.env.KUBERNETES_SERVICE_PORT || '443';
const CA = readFileBuffer('/var/run/secrets/kubernetes.io/serviceaccount/ca.crt');

// Installation-wide default agent image (#1940 AC9). Since #1940 this is only
// the DEFAULT: the image a pod is actually created from arrives through the
// seam as `spawnContainer({ image })`, resolved per Working Environment by
// orchestrator/toolchain-registry.js. Exported so the resolver reads the
// default from the active runtime rather than re-deriving it.
const DEFAULT_AGENT_IMAGE = process.env.AGENT_IMAGE || BUILTIN_AGENT_IMAGE;
// IfNotPresent suits local clusters (kind: images are side-loaded, never
// pullable). On a real registry with a mutable :latest tag set Always, or a
// node's stale cache keeps winning after every image push.
// #1940 AC8: the pull policy and the pull secret apply to a toolchain variant
// exactly as to the default image — they are pod-spec fields, independent of
// WHICH image is named. A variant must therefore be pushed to the Artifact
// Registry the cluster's nodes pull from; the compose path's `localhost/…`
// tags do not exist there, which is what a toolchain's `platforms` field is for.
const AGENT_IMAGE_PULL_POLICY = process.env.AEE_AGENT_IMAGE_PULL_POLICY || 'IfNotPresent';
const AGENT_SERVICE_ACCOUNT = process.env.AEE_AGENT_SERVICE_ACCOUNT || 'agent-studio-agent';
const IMAGE_PULL_SECRET = process.env.AEE_IMAGE_PULL_SECRET || '';
const WORKSPACE_PVC = process.env.AEE_WORKSPACE_PVC || 'agent-studio-workspace';
const WORKSPACE_ISOLATION = process.env.AEE_WORKSPACE_ISOLATION !== '0';
const AGENT_MEM_LIMIT = process.env.AEE_AGENT_MEM_LIMIT || '2Gi';
const AGENT_LABEL_KEY = 'aee.agent.id';
// Same instance scoping as the Podman path (orchestrator.js reads these labels
// when evicting stale agents / listing processes): two stacks sharing one
// namespace must not touch each other's agent pods.
const INSTANCE_LABEL_KEY = 'aee.instance';
const INSTANCE_ID = process.env.AEE_INSTANCE_ID || process.env.COMPOSE_PROJECT_NAME || 'agent-studio-314092';
const APP_LABEL = process.env.AEE_K8S_APP_LABEL || 'agent-studio';
const POLL_MS = Number(process.env.AEE_K8S_POLL_MS || 5000);
const LOG_RETRY_MS = Number(process.env.AEE_K8S_LOG_RETRY_MS || 2000);
// 60s default: a busy/large-repo materialization can briefly starve the
// control plane, and a momentarily slow API server shouldn't spam identical
// "timeout after …ms" lines or trip the pod-create POST. Tune via
// AEE_K8S_REQUEST_TIMEOUT_MS.
const REQUEST_TIMEOUT_MS = Number(process.env.AEE_K8S_REQUEST_TIMEOUT_MS || 60000);
// Socket-level failures that are worth one retry (vs. a definitive 4xx/5xx from
// the API server, which we surface immediately).
const TRANSIENT_ERR_RE = /socket hang up|ECONNRESET|ETIMEDOUT|EPIPE|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|timeout after/i;

// Container-level waiting reasons that mean the pod will NEVER start on its
// own (a plain `restartPolicy: Never` pod still sits in Pending while the
// kubelet retries the pull). Without this check a missing/unpullable image
// left the agent in a silent "created" limbo forever. `ErrImagePull` is
// deliberately absent: it is the transient first attempt and either resolves
// or degrades into ImagePullBackOff, which is listed.
const FATAL_WAITING_REASONS = new Set([
  'ImagePullBackOff',
  'ErrImageNeverPull',
  'InvalidImageName',
  'CreateContainerConfigError',
  'CreateContainerError',
  'RunContainerError',
]);

// The subset of the above that means "the named image could not be obtained" —
// the Kubernetes equivalent of a missing image in the local podman store, and
// therefore the only reasons that earn the #1940 AC7 toolchain sentence.
const IMAGE_PULL_REASONS = new Set([
  'ImagePullBackOff',
  'ErrImageNeverPull',
  'InvalidImageName',
]);

function readFile(path, fallback) {
  try { return fs.readFileSync(path, 'utf8'); } catch { return fallback; }
}

function readFileBuffer(path) {
  try { return fs.readFileSync(path); } catch { return undefined; }
}

// Read the service-account token fresh on each use. Projected SA tokens rotate
// (~hourly); caching it at module load meant every k8s API call started
// returning 401 after the first rotation, so the orchestrator could no longer
// list/spawn/respawn agent pods. Reading the small file per request is cheap.
function serviceAccountToken() {
  return readFile('/var/run/secrets/kubernetes.io/serviceaccount/token', '').trim();
}

function safeName(value) {
  return String(value || 'agent')
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 45) || 'agent';
}

function parseMemoryQuantity(value) {
  const v = String(value || '').trim();
  if (!v) return undefined;
  if (/^\d+(Ei|Pi|Ti|Gi|Mi|Ki|E|P|T|G|M|K)?$/.test(v)) return v;
  const m = v.match(/^(\d+)\s*([kKmMgG])(?:i|b|ib)?$/);
  if (!m) return undefined;
  return `${m[1]}${m[2].toUpperCase()}i`;
}

// Write to a handle stream only while it is still writable. The log stream,
// the status poll and the finalizer race each other around pod exit; a late
// diagnostic write to an already-ended PassThrough would raise
// ERR_STREAM_WRITE_AFTER_END on a stream nobody listens to for 'error' —
// crashing the whole orchestrator over a log line.
function safeWrite(stream, data) {
  if (stream.writableEnded || stream.destroyed) return;
  stream.write(Buffer.isBuffer(data) ? data : Buffer.from(data));
}

// Single terminal state for a spawn handle. Everything that can conclude a
// pod's life (natural exit, kill, create failure, fatal image-pull state,
// external delete) funnels through here exactly once: stops the log stream
// and its retry timer, ends both streams, then emits 'exit'.
function finalizeHandle(handle, code) {
  if (handle._done) return;
  handle._done = true;
  if (handle._logRetryTimer) clearTimeout(handle._logRetryTimer);
  if (handle._logReq) handle._logReq.destroy();
  if (!handle.stdout.writableEnded) handle.stdout.end();
  if (!handle.stderr.writableEnded) handle.stderr.end();
  handle.exitCode = code;
  handle.emit('exit', code, null);
}

function k8sRequest(method, apiPath, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const token = serviceAccountToken();
    if (!API_HOST || !token) return reject(new Error('Kubernetes service-account environment/token not available'));
    const payload = body === undefined || body === null ? null : JSON.stringify(body);
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...extraHeaders,
    };
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = https.request({
      host: API_HOST,
      port: API_PORT,
      path: apiPath,
      method,
      ca: CA,
      headers,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = raw; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    // Don't let a stalled connection hang the request forever (a hung API
    // connection would otherwise block indefinitely). destroy() re-emits as an
    // 'error' below, so the message still carries the method/path context.
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error(`timeout after ${REQUEST_TIMEOUT_MS}ms`));
    });
    // Enrich the bare socket error with the operation + error code so callers
    // log e.g. `k8s POST /api/v1/.../pods failed: ECONNRESET socket hang up`
    // instead of a context-free `socket hang up`.
    req.on('error', (err) => {
      const code = err.code ? `${err.code} ` : '';
      reject(new Error(`k8s ${method} ${apiPath} failed: ${code}${err.message}`));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

// One retry for the pod-create POST on transient socket failures. A definitive
// API response (4xx/5xx) is returned as-is by k8sRequest (no reject), so it is
// not retried here — only connection-level errors are.
async function k8sRequestRetrying(method, apiPath, body, { attempts = 2, backoffMs = 500 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await k8sRequest(method, apiPath, body);
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1 && TRANSIENT_ERR_RE.test(err.message)) {
        await new Promise((r) => setTimeout(r, backoffMs));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

function podApiPath(podName = '') {
  const suffix = podName ? `/${podName}` : '';
  return `/api/v1/namespaces/${encodeURIComponent(NAMESPACE)}/pods${suffix}`;
}

async function listAgentPods(agentId = null) {
  const selectors = [
    `app.kubernetes.io/name=${APP_LABEL}`,
    'app.kubernetes.io/component=as-agent',
    // Scope every list to THIS instance — the eviction/process endpoints in
    // orchestrator.js re-check the label client-side, but filtering here keeps
    // a parallel stack's pods out of the response entirely.
    `${INSTANCE_LABEL_KEY}=${INSTANCE_ID}`,
  ];
  if (agentId) selectors.push(`${AGENT_LABEL_KEY}=${agentId}`);
  const path = `${podApiPath()}?labelSelector=${encodeURIComponent(selectors.join(','))}`;
  const r = await k8sRequest('GET', path);
  if (r.status >= 300) throw new Error(`list pods failed: status=${r.status} body=${JSON.stringify(r.body)}`);
  return Array.isArray(r.body?.items) ? r.body.items : [];
}

async function deletePod(name) {
  return k8sRequest('DELETE', podApiPath(name), {
    gracePeriodSeconds: 10,
    propagationPolicy: 'Background',
  });
}

async function deleteAgentPods(agentId) {
  const pods = await listAgentPods(agentId);
  await Promise.all(pods.map((p) => deletePod(p.metadata.name).catch(() => null)));
}

function podPhaseToState(pod) {
  const phase = String(pod?.status?.phase || '').toLowerCase();
  if (phase === 'running') return 'running';
  if (phase === 'succeeded') return 'exited';
  if (phase === 'failed') return 'exited';
  if (phase === 'pending') return 'created';
  return phase || 'unknown';
}

function exitCodeFromPod(pod) {
  const statuses = pod?.status?.containerStatuses || [];
  const terminated = statuses.find((s) => s.name === 'as-agent')?.state?.terminated;
  if (terminated && Number.isFinite(Number(terminated.exitCode))) return Number(terminated.exitCode);
  if (pod?.status?.phase === 'Succeeded') return 0;
  if (pod?.status?.phase === 'Failed') return 1;
  return null;
}

// Returns the fatal waiting reason (e.g. ImagePullBackOff) when the pod's
// agent container can never reach Running, else null.
function fatalWaitingReason(pod) {
  const statuses = pod?.status?.containerStatuses || [];
  const waiting = statuses.find((s) => s.name === 'as-agent')?.state?.waiting;
  const reason = waiting?.reason || '';
  return FATAL_WAITING_REASONS.has(reason) ? reason : null;
}

function streamPodLogs(podName, handle) {
  if (handle.killed || handle._done || handle._logsClosed) return;
  const token = serviceAccountToken();
  // First attach fetches the FULL log so nothing the agent printed between
  // pod start and stream attach is lost (the startup banner and early errors
  // are exactly what operators need in the session log). Re-attaches after a
  // dropped stream resume with tailLines=0 so already-forwarded lines are not
  // duplicated (the small window of lines logged during the gap is an accepted
  // trade-off vs duplicating whole histories).
  const tail = handle._logStarted ? '&tailLines=0' : '';
  const logPath = `${podApiPath(podName)}/log?container=as-agent&follow=true${tail}`;
  const scheduleRetry = () => {
    if (handle.killed || handle._done) return;
    handle._logRetryTimer = setTimeout(() => streamPodLogs(podName, handle), LOG_RETRY_MS);
  };
  const req = https.request({
    host: API_HOST,
    port: API_PORT,
    path: logPath,
    method: 'GET',
    ca: CA,
    headers: { Authorization: `Bearer ${token}` },
  }, (res) => {
    if (res.statusCode >= 300) {
      res.resume();
      scheduleRetry();
      return;
    }
    res.on('data', (chunk) => {
      handle._logStarted = true;
      safeWrite(handle.stdout, chunk);
    });
    // The stream ending only means the CONTAINER stopped logging; pod exit —
    // and stream shutdown — is owned by pollPodExit's finalize, which also
    // prevents any further re-attach against the gone pod.
    res.on('end', () => { handle._logsClosed = true; });
  });
  req.on('error', (err) => {
    if (!handle.killed && !handle._done) {
      safeWrite(handle.stderr, `[spawn-kubernetes-pod] log stream retry: ${err.message}\n`);
      scheduleRetry();
    }
  });
  req.end();
  handle._logReq = req;
}

async function pollPodExit(podName, handle) {
  let fatalSightings = 0;
  while (!handle.killed && !handle._done) {
    try {
      const r = await k8sRequest('GET', podApiPath(podName));
      if (r.status === 404) {
        // Pod gone without us deleting it (external kubectl delete, node
        // eviction): treat like a SIGTERM'd process.
        finalizeHandle(handle, handle.killed ? 0 : 143);
        return;
      }
      if (r.status >= 300) throw new Error(`status=${r.status} body=${JSON.stringify(r.body)}`);
      const code = exitCodeFromPod(r.body);
      if (code !== null) {
        finalizeHandle(handle, code);
        return;
      }
      // A pod stuck in a fatal waiting state (unpullable image, bad config)
      // never terminates on its own — surface it instead of idling forever.
      // Two consecutive sightings (one poll interval apart) filter out the
      // transient flap right after scheduling.
      const fatal = fatalWaitingReason(r.body);
      if (fatal) {
        fatalSightings += 1;
        if (fatalSightings >= 2) {
          safeWrite(handle.stderr, `[spawn-kubernetes-pod] pod ${podName} cannot start: ${fatal} — deleting\n`);
          // #1940 AC7: on a toolchain image, an image-pull failure is the
          // Kubernetes form of "the selected toolchain's image is missing".
          // `ImagePullBackOff` alone names neither the environment nor the
          // toolchain, so add the sentence that does — the podman path gets the
          // same wording from its pre-create probe.
          if (handle._toolchain && IMAGE_PULL_REASONS.has(fatal)) {
            safeWrite(handle.stderr,
              `[spawn-kubernetes-pod] ${missingImageMessage({ ...handle._toolchain, image: handle._image, runtime: 'kubernetes' })}\n`);
          }
          await deletePod(podName).catch(() => null);
          finalizeHandle(handle, 1);
          return;
        }
      } else {
        fatalSightings = 0;
      }
    } catch (err) {
      safeWrite(handle.stderr, `[spawn-kubernetes-pod] status poll: ${err.message}\n`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  finalizeHandle(handle, handle.killed ? 0 : 1);
}

function envToK8s(env) {
  return Object.entries(env || {})
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([name, value]) => ({ name, value: String(value) }));
}

// Host-folder context mounts (#1283/#1290) as k8s hostPath volumes — the
// counterpart of buildContextMountSpecs on the Podman path (whose libpod OCI
// bind shape doesn't fit k8s volumes, so entries are mapped directly). Same
// discipline: the host path is re-validated fail-closed at the point of use
// and a bad entry drops that mount only, never the spawn. `type: Directory`
// means the folder must already exist ON THE NODE — a missing path leaves the
// pod Pending on FailedMount, symmetric to Podman's no-existence-precheck.
// The AEE_K8S_CONTEXT_HOSTPATH gate is read at call time (not module load) so
// the hosted stack can never render a hostPath and tests can toggle it.
function buildContextHostPathVolumes(contextMounts) {
  const volumes = [];
  const volumeMounts = [];
  if (process.env.AEE_K8S_CONTEXT_HOSTPATH !== '1') return { volumes, volumeMounts };
  let i = 0;
  for (const m of (Array.isArray(contextMounts) ? contextMounts : [])) {
    if (!m) continue;
    const v = validateHostMountPath(m.path);
    if (!v.ok) continue;
    // Index-based volume names: mount slugs may contain characters that are
    // not DNS-1123-label-safe, and the name only has to be unique in the pod.
    const name = `ctx-${i++}`;
    volumes.push({ name, hostPath: { path: v.path, type: 'Directory' } });
    volumeMounts.push({
      name,
      mountPath: m.target || CONTEXT_MOUNT_TARGET,
      readOnly: m.readWrite !== true,
    });
  }
  return { volumes, volumeMounts };
}

function buildPodManifest(id, env, podName, contextMounts, image) {
  const memory = parseMemoryQuantity(AGENT_MEM_LIMIT);
  // Seam #3 equivalent: the agent sees ONLY its own slice of the shared
  // workspace PVC via subPath, mounted at the same /workspace/agents/<id>
  // destination as the Podman path (cwd + absolute paths in seeded memory are
  // unaffected). The Claude CLI home lives on the same PVC under claude-home/.
  const volumeMounts = WORKSPACE_ISOLATION
    ? [
        { name: 'workspace', mountPath: `/workspace/agents/${id}`, subPath: `agents/${id}` },
        { name: 'workspace', mountPath: '/root/.claude', subPath: `claude-home/homes/${id}` },
      ]
    : [
        { name: 'workspace', mountPath: '/workspace' },
        { name: 'workspace', mountPath: '/root/.claude', subPath: 'claude-home' },
      ];

  const ctx = buildContextHostPathVolumes(contextMounts);

  const pod = {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name: podName,
      labels: {
        'app.kubernetes.io/name': APP_LABEL,
        'app.kubernetes.io/component': 'as-agent',
        [AGENT_LABEL_KEY]: String(id),
        [INSTANCE_LABEL_KEY]: INSTANCE_ID,
      },
    },
    spec: {
      restartPolicy: 'Never',
      serviceAccountName: AGENT_SERVICE_ACCOUNT,
      automountServiceAccountToken: false,
      terminationGracePeriodSeconds: 20,
      containers: [{
        name: 'as-agent',
        // #1940 AC2/AC8: the RESOLVED image, never the module-level default —
        // the caller decided which toolchain (if any) this agent runs on.
        image,
        imagePullPolicy: AGENT_IMAGE_PULL_POLICY,
        env: envToK8s(env),
        volumeMounts: [...volumeMounts, ...ctx.volumeMounts],
        securityContext: {
          allowPrivilegeEscalation: false,
          capabilities: { drop: ['ALL'] },
        },
        resources: memory ? { limits: { memory }, requests: { memory: '256Mi', cpu: '100m' } } : undefined,
      }],
      volumes: [{ name: 'workspace', persistentVolumeClaim: { claimName: WORKSPACE_PVC } }, ...ctx.volumes],
    },
  };
  if (IMAGE_PULL_SECRET) pod.spec.imagePullSecrets = [{ name: IMAGE_PULL_SECRET }];
  return pod;
}

// `image` (#1940) is the container image for THIS agent, resolved per Working
// Environment by the caller (orchestrator.js → resolveAgentImage) — the same
// seam contract as spawn-container.js. `toolchain` is the
// {toolchainId, environmentId, environmentName} context of a NON-default image,
// carried only so an image-pull failure can be worded as AC7 requires.
function spawnContainer({ id, env, contextMounts, image, toolchain = null }) {
  const handle = new EventEmitter();
  handle._toolchain = toolchain;
  handle._image = image;
  handle.stdout = new PassThrough();
  handle.stderr = new PassThrough();
  handle.killed = false;
  handle.exitCode = null;
  handle.pid = null;
  handle._done = false;
  handle.send = (msg) => {
    safeWrite(handle.stderr, `[spawn-kubernetes-pod] IPC send dropped: ${JSON.stringify(msg)}\n`);
    return false;
  };

  const podName = `aee-agent-${safeName(id)}-${Date.now().toString(36)}`;
  handle.kill = (signal = 'SIGTERM') => {
    // SIGUSR2 = "reload triggers" (the orchestrator writes triggers.json then
    // signals for an eager re-read — sent to every team member right after the
    // wizard materializes it). It is NOT a termination request. On Podman it is
    // delivered to the agent process; on k8s a per-process signal can't be
    // forwarded through the pod API, but the agent already re-reads triggers.json
    // on its own 60s sync loop, so eager reload is only a latency optimization.
    // Treat SIGUSR2 as a NO-OP here: deleting the pod instead used to kill every
    // freshly-created team member the instant reload-triggers fired, leaving the
    // whole team offline (agents "exited (code 0)") and chat unresponsive.
    if (signal === 'SIGUSR2') {
      safeWrite(handle.stderr,
        '[spawn-kubernetes-pod] SIGUSR2 (reload-triggers) ignored; the agent re-reads triggers.json on its 60s sync loop\n');
      return;
    }
    handle.killed = true;
    if (handle._logReq) handle._logReq.destroy();
    const note = signal === 'SIGUSR1'
      ? 'SIGUSR1 (stop-session) requested; Kubernetes cannot forward a per-process signal through the pod API, so the agent pod is deleted'
      : `delete requested with ${signal}`;
    safeWrite(handle.stderr, `[spawn-kubernetes-pod] ${note}\n`);
    deletePod(podName).catch(() => null);
  };

  (async () => {
    try {
      await deleteAgentPods(id);
      if (handle.killed) {
        // Killed while we were still clearing old pods — nothing was created.
        finalizeHandle(handle, 0);
        return;
      }
      // #1940 AC2: the image is the caller's decision, and a missing one is a
      // seam contract violation rather than a k8s error — refuse here so it
      // cannot degrade into a pod with an `undefined` image.
      if (!image) {
        throw new Error(
          `refusing to spawn ${id}: no container image was resolved. The container-runtime ` +
          'seam requires spawnContainer({ image }) (#1940) — see resolveAgentImage.',
        );
      }
      const manifest = buildPodManifest(id, env, podName, contextMounts, image);
      for (const vm of manifest.spec.containers[0].volumeMounts) {
        if (!vm.name.startsWith('ctx-')) continue;
        const vol = manifest.spec.volumes.find((v) => v.name === vm.name);
        const mode = vm.readOnly ? 'read-only' : 'read-write';
        console.log(`[spawn-kubernetes-pod] ${id} -> ${mode} context hostPath ${vol.hostPath.path} at ${vm.mountPath}`);
      }
      const created = await k8sRequestRetrying('POST', podApiPath(), manifest);
      if (created.status >= 300) {
        throw new Error(`create pod failed: status=${created.status} body=${JSON.stringify(created.body)}`);
      }
      if (handle.killed) {
        // kill() raced the create POST: its deletePod hit a pod that did not
        // exist yet, so the freshly-created pod would live on as an orphan no
        // handle tracks. Delete it now that it exists.
        await deletePod(podName).catch(() => null);
        finalizeHandle(handle, 0);
        return;
      }
      handle.pid = podName;
      handle.emit('spawned', podName);
      streamPodLogs(podName, handle);
      await pollPodExit(podName, handle);
    } catch (err) {
      safeWrite(handle.stderr, `[spawn-kubernetes-pod] ${err.message}\n`);
      finalizeHandle(handle, 1);
    }
  })();

  return handle;
}

async function libpodRequest(method, urlPath) {
  // Compatibility surface for existing orchestrator endpoints that ask Podman
  // for labelled containers. In Kubernetes mode, labelled agent Pods are the
  // source of truth. The callers (evictStaleAgentContainers, the
  // /internal/agents/processes endpoint) re-check aee.instance/aee.agent.id
  // client-side, so returning this instance's agent pods with their labels
  // satisfies both.
  if (method === 'GET' && urlPath.startsWith('/containers/json')) {
    const pods = await listAgentPods();
    return {
      status: 200,
      body: pods.map((pod) => ({
        Id: pod.metadata.name,
        ID: pod.metadata.name,
        Labels: pod.metadata.labels || {},
        State: podPhaseToState(pod),
      })),
    };
  }
  if (method === 'DELETE' && urlPath.startsWith('/containers/')) {
    const podName = decodeURIComponent(urlPath.split('/')[2].split('?')[0]);
    const r = await deletePod(podName);
    return { status: r.status, body: r.body };
  }
  return { status: 200, body: null };
}

// Per-agent volumes/networks are Podman concepts. On Kubernetes, filesystem
// isolation is the PVC subPath in buildPodManifest and network segmentation is
// a NetworkPolicy applied by the operator — nothing to provision per spawn.
async function removePerAgentVolume() { return { skipped: 'kubernetes-shared-pvc' }; }
// The `{ graceful }` option (#1791) is Podman-only — an agent Pod has no
// per-agent network to reap and is deleted through the k8s API path — so it is
// accepted for signature parity with spawn-container.js and ignored here.
async function removePerAgentNetwork() { return { skipped: 'kubernetes-service-network' }; }
async function reseedPerAgentVolume() { return { skipped: 'kubernetes-subpath' }; }

module.exports = {
  spawnContainer,
  libpodRequest,
  removePerAgentVolume,
  removePerAgentNetwork,
  reseedPerAgentVolume,
  // k8s-runtime-internal extra (NOT part of the five-function seam): pod-exec.js
  // resolves an agent's running pod through the same instance-scoped selector.
  listAgentPods,
  // Plugin sidecars (#1547/#1565) — see the Deliberate differences block above.
  // UI-bearing plugins now run as a Deployment + Service + PVC via
  // spawn-kubernetes-plugin.js (plugin-runtime.js delegates to it on this
  // runtime). perAgentNetworkName still has no k8s counterpart (agent pods share
  // the cluster network), so it returns null: per-agent-network reachability for
  // broker plugins is the separable NetworkPolicy follow-up, not implemented here.
  PLUGIN_SIDECARS_SUPPORTED: true,
  perAgentNetworkName: () => null,
  AGENT_NETWORK: null,
  // Installation-wide default image (#1940 AC9) — the orchestrator reads the
  // fallback link of the resolution chain from whichever runtime is selected.
  DEFAULT_AGENT_IMAGE,
  // Pure helpers exposed for unit tests only — not part of the runtime seam.
  _internal: {
    safeName,
    parseMemoryQuantity,
    podPhaseToState,
    exitCodeFromPod,
    fatalWaitingReason,
    envToK8s,
    buildPodManifest,
    buildContextHostPathVolumes,
    safeWrite,
    finalizeHandle,
  },
};
