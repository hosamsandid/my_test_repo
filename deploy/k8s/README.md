# Agent Studio on Kubernetes

Two ways to run the Kubernetes version: **locally on kind** (free, on your
machine) and **hosted on GKE** (the shared pilot). The classic Podman/compose
setup (`make up`) is unaffected by all of this and remains the default local
dev path.

## Run locally (kind)

Prerequisites: `podman` (machine running, ≥8 GB), `kind`, `kubectl`, `jq`
(macOS: `brew install podman kind kubectl jq`).

> **Windows:** untested. Run everything inside **WSL2** (the script is bash and
> builds with podman). Feedback welcome — this path needs validation.

```bash
cp .env.example .env          # once; add your LLM endpoint + token
./deploy/k8s/kind-up.sh       # creates cluster, builds+loads images, deploys, seeds
```

The script is idempotent — re-run it after any failure or code change.

**Env files:** `.env` is only the **seed** (LLM endpoint/token, console login).
The kind stack keeps its own `.env.k8s` — created from `.env` on first run —
and every stack-specific value, including the Matrix token the bootstrap
obtains, is written **there**, never back to `.env` (each stack has its own
homeserver DB, so tokens are never shared with compose).

**Two different credentials, easy to confuse:**

| Credential | Asked/used where | What it is |
|---|---|---|
| Password prompted by the script (first run) | terminal | the **Matrix homeserver admin** user — token lands in `.env.k8s`, you rarely need it again |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` from `.env` (default `admin`/`admin`) | console login at `:4100` | the **Admin Console** web login |

Open the console:

```bash
kubectl -n agent-studio port-forward svc/admin-console 4100:4000
# -> http://localhost:4100  (login: ADMIN_USERNAME/ADMIN_PASSWORD from .env, default admin/admin)
```

Watch agent pods appear as you enable agents:

```bash
kubectl -n agent-studio get pods -l app.kubernetes.io/component=as-agent -w
```

Tear down: `kind delete cluster --name agent-studio`

Known quirks:

- **Podman VM clock drift** (Mac, after sleep): image builds fail with
  `Release file ... is not valid yet`. Fix:
  `podman machine ssh "sudo date -u -s \"$(date -u '+%Y-%m-%d %H:%M:%S')\""`
- A `docker` CLI pointing at a dead daemon (e.g. stopped colima) is handled —
  the script probes the daemon and falls back to the Podman provider.

## Context mounts on kind (#1319)

Host-folder context mounts (`docs/context-mount.md`) work on the k8s runtime
behind an **explicit opt-in**: add to `.env.k8s` and re-run `kind-up.sh`

```
AEE_K8S_CONTEXT_HOSTPATH=1
```

Without it the console reports the feature unsupported and the orchestrator
renders no mount — hosted GKE never sets it (a hostPath on a multi-node
cluster is the wrong tool; it also stays hard-off behind IAP regardless).

Two things differ from the Podman stack:

- **"Host" means the kind node**, i.e. the `agent-studio-control-plane`
  container — not your Mac. The mount renders as a `hostPath` volume
  (`type: Directory`) in the agent pod, so the folder must already exist *in
  the node* or the pod stays Pending on a `FailedMount` event (symmetric to
  the Podman path not pre-checking existence). Quick node-local folder:
  `podman exec agent-studio-control-plane mkdir -p /opt/my-context`.
- **To expose a real Mac folder** you need a kind `extraMounts` entry, which
  only applies at cluster creation (`kind delete cluster` first):

  ```yaml
  # kind-config.yaml — pass with: kind create cluster --name agent-studio --config kind-config.yaml
  kind: Cluster
  apiVersion: kind.x-k8s.io/v1alpha4
  nodes:
    - role: control-plane
      extraMounts:
        - hostPath: /Users/you/project-docs
          containerPath: /host-context/project-docs
  ```

  Then set the agent's context folder to the **containerPath**
  (`/host-context/project-docs`).

Console browsing and read-write uploads run through the agent's pod over the
Kubernetes `pods/exec` API (`orchestrator/pod-exec.js`; the Podman stack uses
the libpod socket instead — same endpoints, different transport).

## Run the e2e journey suite on kind (#1319)

The Playwright journey suite (`e2e/journeys/`) can target a **dedicated** e2e
kind cluster — agents spawn as real k8s pods, so this covers the k8s runtime
end to end (the compose e2e lane only covers Podman):

```bash
make e2e-kind        # kind-up --e2e → port-forwards → configure → run journeys
make e2e-kind-up     # just bring the stack up (authoring loop)
make e2e-kind-down   # kill port-forwards + delete cluster agent-studio-e2e
```

What `--e2e` changes vs the dev kind stack: own cluster (`agent-studio-e2e`)
and env file (`.env.k8s-e2e`), the LLM stubbed at the claude-binary seam
(`AEE_FAKE_CLAUDE=1` — canned replies, no real endpoint), in-cluster
`fake-github` + `git-remote` fixture services (`base/e2e/80-e2e-fakes.yaml`),
non-interactive Matrix bootstrap, and `AEE_K8S_CONTEXT_HOSTPATH=1` (the
`context-mount` journey exercises it). Your dev kind cluster and both compose
stacks are untouched.

Journeys are lane-filtered: `make e2e-kind` runs with `E2E_LANE=ci,kind`, so
all the regular `ci` journeys run **plus** the kind-only `context-mount`
journey (whose fixture shells into the kind node — meaningless on compose).

**Re-runs need a fresh cluster** (`make e2e-kind-down` first). Journeys that
materialise teams delete them in teardown, which deactivates the members'
Matrix users — permanent in conduwuit — so a second materialisation of the
same fixed ids on the same homeserver fails with `M_USER_DEACTIVATED`. The
compose lane has the same property; it is invisible there only because
`make e2e` always starts from fresh volumes.

## One manifest source, per-environment overlays (#1348)

Every stack deploys the same kustomize **base**, specialised by a thin
overlay — there is no script-side manifest rewriting anymore:

| Overlay (`deploy/k8s/overlays/…`) | Used by | Differences vs base |
|---|---|---|
| `kind` | `kind-up.sh` | none (local `:latest` images, `imagePullPolicy: Never`, no ingress) |
| `kind-e2e` | `kind-up.sh --e2e` | + in-cluster fakes (`base/e2e`) |
| `test` | deploy-gke workflow, `gke-up.sh` | Artifact Registry images, `Always`, ingress `agent-studio.projectroots-acn.com` |
| `preprod` | deploy-gke workflow, `gke-up.sh --env preprod` | as test + namespace `agent-studio-preprod`, own IP/hostname, own `AEE_INSTANCE_ID` |

Each overlay is split `core/` (namespace, RBAC, PVCs, conduwuit) and `app/`
(orchestrator, console, ingress) because the `agent-studio-env`
Secret is created between the two by the up scripts. Apply **only through an
overlay** (`kubectl apply -k deploy/k8s/overlays/<env>/…`), never `-f base/`.

`deploy/k8s/render-check.sh` (CI: the `k8s-render` job) asserts the overlay
invariants; `deploy/k8s/set-images.sh <env> <tag>` pins the image tag in the
working tree at deploy time — the checked-in placeholder stays `latest`, so
never commit a pinned tag (`git checkout -- deploy/k8s/overlays` to reset).

### Agent toolchain images (#1940)

`AGENT_IMAGE` (base `40-orchestrator.yaml`, overridden by
`overlays/{test,preprod}/app/patch-agent-image.yaml`) remains the
**installation-wide default** — the image every agent whose Working Environment
names no toolchain is spawned from. It is still the only agent image reference in
the manifests, so `set-images.sh` and `render-check.sh` need no change: a
**toolchain** image is registered at runtime by a System Admin
(`POST /api/toolchains` → `/workspace/toolchains/index.json`), never in a
manifest, and therefore never travels through the release tooling.

The consequence for a hosted stack is that **nothing pushes a toolchain image for
you**. A variant must exist in the Artifact Registry the cluster's nodes pull
from before an environment selects it; `AEE_AGENT_IMAGE_PULL_POLICY` and
`AEE_IMAGE_PULL_SECRET` then apply to it exactly as to the default image (they
are pod-spec fields, independent of which image is named). A `localhost/…` tag
built with `make toolchain-images` on a developer machine does not exist there —
register such a variant with `platforms: ["podman"]` and the console will not
offer it on a Kubernetes stack. If a selected toolchain's image cannot be pulled,
the agent pod is deleted after two `ImagePullBackOff` sightings and the
orchestrator log names the environment and the toolchain rather than only the
k8s reason.

## Releases & deploys (trunk-based, manual)

`main` is the trunk. A **release** is an annotated tag on a main commit:

```bash
git tag -a v0.1.0 -m "..." && git push origin v0.1.0
```

Deploys are manual: Actions → **deploy-gke** → Run workflow, choose
`environment` + `ref`. Images are built amd64 and pushed with an **immutable
tag** (the git tag, or `sha-<8>` for branch deploys — `:latest` is gone), the
overlay is pinned to it, and the workflow **applies the manifests** (core →
Secret check → app) — routine manifest changes no longer need an out-of-band
`kubectl apply`. The running version is always visible:
`kubectl -n <ns> get deploy -o wide`.

- **test** (`agent-studio` namespace) accepts any ref, default `main` HEAD.
- **preprod** (`agent-studio-preprod`) accepts release tags `vX.Y.Z` only,
  enforced by the workflow's guard job (tag must also sit on `main`).
- Re-running the same tag is a no-op (immutable-tag semantics). After a
  Secret-only change (rotated credentials), re-run `gke-up.sh` — it also
  rollout-restarts — or bounce the deployments manually.

**First-time preprod bootstrap** (operator machine, one-time):

1. `cd infra/gcp && terraform apply` — creates `agent-studio-preprod-ip` +
   the DNS record (the ManagedCertificate needs them first).
2. Deploy the release tag to **test** via the workflow — this pushes the
   tag's images to the shared Artifact Registry.
3. `./deploy/k8s/gke-up.sh --env preprod --tag vX.Y.Z` — creates the
   namespace stack, runs the Matrix bootstrap into `.env.gke-preprod`,
   creates the Secret, applies the app + ingress.
4. Wait for the ManagedCertificate to turn `Active` (15–30 min), then open
   `https://agent-studio-preprod.projectroots-acn.com` (IAP, same access
   grant as test).

Full bootstrap mechanics, the credential/env-file model, and every known
failure mode: **`docs/hosting/gcp/gke-runbook.md`**. In particular: never
hand-create the `agent-studio-env` Secret with `--from-env-file` — run
`gke-up.sh` (the runbook explains why).

Heads-up: preprod doubles the workload on the single `e2-standard-2` node —
if pods stay Pending on resources, bump `node_machine_type` in
`infra/gcp/variables.tf` (node recreation restarts test briefly). More nodes
is NOT the lever until RWX storage lands (#1316).

## Access the hosted version (GKE)

The **test** environment runs on GKE cluster `agent-studio` (project
`acn-projectroots`, `europe-west3-b`) behind a public HTTPS URL with Google
SSO (Cloud IAP — `overlays/test/app/ingress.yaml` + `infra/gcp/ingress.tf`):

**https://agent-studio.projectroots-acn.com** — sign in with your
`@accenture.com` Google account. Access is granted via
`roles/iap.httpsResourceAccessor` (currently `domain:accenture.com`).

**Single login (IAP → console session).** With `IAP_AUDIENCE` set in the
console's environment, the IAP-verified Google identity logs you into the
console directly — no second login form (`admin-console/api/iap-auth.js`).
Auto-login applies only to registered Agent Studio users (Teams page) and the
env admin (#1415); any other IAP-authenticated account sees the console login
form. The password login stays as break-glass and is the only path on
compose/kind (they never set `IAP_AUDIENCE`). Wiring it up (the audience is pinned per
environment — never copy it between test and preprod):
`docs/hosting/gcp/gke-runbook.md` §4.

Note: behind IAP the console's Logout button is cosmetic — the proxy
re-authenticates you on the next request. Real sign-out is the Google
account's, or `https://agent-studio.projectroots-acn.com/?gcp-iap-mode=CLEAR_LOGIN_COOKIE`.

For cluster operations (kubectl) or as an access fallback:

```bash
# one-time
gcloud auth login
gcloud components install gke-gcloud-auth-plugin
gcloud container clusters get-credentials agent-studio \
  --zone europe-west3-b --project acn-projectroots

# tunnel instead of the public URL
kubectl --context gke_acn-projectroots_europe-west3-b_agent-studio \
  -n agent-studio port-forward svc/admin-console 4200:4000
# -> http://localhost:4200
```

Requires GKE access on `acn-projectroots` (`roles/container.developer` or
similar). Deploys: see **Releases & deploys** above. First-time environment
setup is `deploy/k8s/gke-up.sh` — see its header. **Applying manifests by
hand:** always through the environment's overlay
(`kubectl apply -k deploy/k8s/overlays/test/app`), never `-f base/` — the
base carries kind-flavored image refs (`imagePullPolicy: Never`).

Something broken (crash-looping conduwuit, Matrix token errors, dead URL,
empty Skills page, …)? → **`docs/hosting/gcp/gke-runbook.md`** §3 —
symptom-keyed troubleshooting.

## Port map (all three stacks side by side)

| Stack | Console |
|---|---|
| compose/Podman (`make up`) | `:4000` (or `ADMIN_PORT` from `.env`) |
| compose e2e (`make e2e-up`) | `:4010` (+ fake-github `:4014`) |
| kind (local) | `:4100` via port-forward |
| kind e2e (`make e2e-kind-up`) | `:4110` via port-forward (+ fake-github `:4114`) |
| GKE test (hosted) | `https://agent-studio.projectroots-acn.com` (fallback: `:4200` via port-forward) |
| GKE preprod (hosted) | `https://agent-studio-preprod.projectroots-acn.com` (fallback: `:4200` via port-forward, namespace `agent-studio-preprod`) |
