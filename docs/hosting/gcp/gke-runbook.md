# Agent Studio on GKE — deployment & troubleshooting runbook

Hosted GKE environments: **test** (namespace `agent-studio`,
`agent-studio.projectroots-acn.com`) and **preprod** (namespace
`agent-studio-preprod`, `agent-studio-preprod.projectroots-acn.com`), both on
the shared cluster `agent-studio` (`acn-projectroots`, `europe-west3-b`).

Sibling of `vm-podman-runbook.md` (the old single-VM Podman pilot). Related
docs: `deploy/k8s/README.md` (overlay model, release policy, kind, port map),
`infra/gcp/README.md` (the Terraform layer). Every incident in §3 was hit for
real during the first preprod bootstrap (2026-08-06) — grep this file for your
error message.

## 0. The moving parts

```
infra/gcp (terraform apply)          — cluster, AR repo, static IPs + DNS,
      │                                IAP backend, WIF deployer  (operator)
      ▼
deploy/k8s/gke-up.sh --env <env>     — ONE-TIME bootstrap + repairs:
      │                                Matrix admin user + token,
      │                                agent-studio-env Secret,
      │                                skill-pool seeding, rollout-restart
      ▼
deploy-gke workflow (Actions)        — ROUTINE deploys: build amd64 images,
      │                                push :vX.Y.Z, apply overlay, rollout
      ▼
ManagedCertificate + IAP ingress     — HTTPS + Google SSO
      ▼
Admin Console
```

What the CI workflow can **not** do — these live only in `gke-up.sh`:

- create or update the `agent-studio-env` Secret (it only *checks* it exists),
- run the Matrix admin bootstrap,
- seed the skill pool (`/pool/` in the admin-console pod),
- restart pods after a Secret-only change (CI's apply is tag-pinned — same
  tag ⇒ no rollout).

## 1. First-time bootstrap — the order matters

The canonical sequence (also listed in `deploy/k8s/README.md` → *Releases &
deploys*), and what breaks when a step is skipped:

1. **`cd infra/gcp && terraform apply`** — creates the environment's static IP
   + DNS record + IAP backend. The ManagedCertificate cannot provision without
   the IP/DNS existing first.
2. **Deploy the release tag to test** via the deploy-gke workflow — this
   pushes the tag's images to the shared Artifact Registry (preprod pulls the
   same images).
3. **`./deploy/k8s/gke-up.sh --env preprod --tag vX.Y.Z`** — creates the
   namespace stack, bootstraps the Matrix admin **against this environment's
   own homeserver DB**, writes the token into `.env.gke-preprod`, renders the
   `agent-studio-env` Secret, applies the app overlay, seeds the skill pool.
4. **Wait for the ManagedCertificate** — 15–30 min on first provisioning
   (§3.7). Watch it:

   ```bash
   kubectl -n agent-studio-preprod get managedcertificate agent-studio-cert -w
   ```

Running the CI workflow before step 3 fails at "Require the environment's
bootstrap Secret" — that error is by design and points back here.

> **Do NOT hand-create the Secret.** `kubectl create secret generic
> agent-studio-env --from-env-file=.env.gke-preprod` *looks* equivalent but is
> not: `gke-up.sh` appends `ADMIN_USER_ID` at render time and injects the
> freshly-validated `MATRIX_ACCESS_TOKEN` / `CONDUWUIT_ADMIN_ROOM` — a
> hand-made Secret silently drops the former and trusts whatever (possibly
> copied-from-another-env, §2) values the file happens to carry. Run
> `gke-up.sh`; it is idempotent.

## 2. Env files & credentials — what is copyable, what never is

One env file per stack, each backing a **separate Matrix homeserver DB**:

| File | Stack |
|---|---|
| `.env` | compose/Podman (local) |
| `.env.k8s` | kind (local) |
| `.env.gke` | GKE **test** |
| `.env.gke-preprod` | GKE **preprod** |

Per-variable rules:

| Variable | Copyable between envs? | Why |
|---|---|---|
| `MATRIX_ACCESS_TOKEN` | **never** | token lives in one homeserver's DB; any other homeserver answers `M_UNKNOWN_TOKEN` (§3.3) |
| `CONDUWUIT_ADMIN_ROOM` | **never** | room ids are per-DB; a foreign id fails with "room of unknown version" (§3.4) |
| `IAP_AUDIENCE` | **never** | embeds the environment's own IAP backend-service id (§4) |
| `ADMIN_USER_ID` | n/a | appended by `gke-up.sh` when rendering the Secret — not read from the file |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | yes | the **console web login** (not the Matrix admin) — env-independent |
| `ANTHROPIC_*` (LLM endpoint/models) | yes | shared proxy settings |

**The seeding trap.** When the target env file is missing, `gke-up.sh` seeds
it by copying `.env.k8s` or `.env` — including the *source* homeserver's
`MATRIX_ACCESS_TOKEN` and `CONDUWUIT_ADMIN_ROOM`. The script itself recovers
(it validates the token and re-bootstraps on failure), but a **hand-copied
file plus a hand-made Secret** ships the poisoned values straight into the
cluster. That single mistake caused §3.3, §3.4 and (indirectly) §3.5.

## 3. Troubleshooting — grep for your error

### 3.1 deploy-gke fails: `deployment "conduwuit" exceeded its progress deadline`

Check the pod:

```bash
kubectl -n <ns> get pods
kubectl -n <ns> logs deploy/conduwuit --previous | tail -20
```

If it is `CrashLoopBackOff` and the previous-container log ends with

```
Command failed with error:
Username is not available.
```

then the deployment still carries the **bootstrap `--execute users
create-user` patch** from an interrupted `gke-up.sh` run: the user already
exists, so every restart re-runs the command, fails, and exits. Confirm:

```bash
kubectl -n <ns> get deploy/conduwuit \
  -o jsonpath='{.spec.template.spec.containers[0].args}'
```

Fix — either re-run `gke-up.sh --env <env> --tag <tag>` (it now detects and
reverts a stale patch before waiting on the rollout), or revert by hand:

```bash
kubectl -n <ns> patch deployment conduwuit --type=json -p='[
  {"op":"remove","path":"/spec/template/spec/containers/0/command"},
  {"op":"remove","path":"/spec/template/spec/containers/0/args"}
]'
kubectl -n <ns> rollout status deploy/conduwuit --timeout=120s
```

### 3.2 deploy-gke fails: `Secret agent-studio-env missing in <ns>`

First-time bootstrap was never completed for this environment. Run the §1
sequence — specifically step 3 (`gke-up.sh`). Do not hand-create the Secret
(see the warning box in §1).

### 3.3 Team creation fails: `M_UNKNOWN_TOKEN: Invalid token`

The `MATRIX_ACCESS_TOKEN` in the Secret belongs to a *different* homeserver
(§2, the seeding trap). Recover a fresh token against **this** environment's
homeserver:

```bash
# 1. port-forward to THIS env's conduwuit
kubectl -n <ns> port-forward svc/conduwuit 28449:6167 &
sleep 3

# 2. if you know the Matrix admin password, log in; if not, reset it first
#    via a temporary --execute patch (revert it immediately after!):
kubectl -n <ns> patch deployment conduwuit --type=json -p='[
  {"op":"add","path":"/spec/template/spec/containers/0/command","value":["/sbin/conduwuit"]},
  {"op":"add","path":"/spec/template/spec/containers/0/args","value":["--execute","users reset-password <admin-user> <new-password>"]}
]'
sleep 10
kubectl -n <ns> patch deployment conduwuit --type=json -p='[
  {"op":"remove","path":"/spec/template/spec/containers/0/command"},
  {"op":"remove","path":"/spec/template/spec/containers/0/args"}
]'
kubectl -n <ns> rollout status deploy/conduwuit --timeout=120s

# 3. fresh token
curl -s -X POST "http://localhost:28449/_matrix/client/v3/login" \
  -H "Content-Type: application/json" \
  -d '{"type":"m.login.password","identifier":{"type":"m.id.user","user":"<admin-user>"},"password":"<new-password>"}' \
  | jq -r .access_token
```

Put the token into the env file's `MATRIX_ACCESS_TOKEN`, then **re-run
`gke-up.sh`** (preferred — it re-renders the Secret correctly and restarts
everything). If you must patch by hand, update the Secret and restart **both**
deployments (§3.6).

The cleanest recovery overall: fix the env file and re-run
`gke-up.sh --env <env> --tag <tag>`.

### 3.4 `M_UNKNOWN: non-create event for room of unknown version in !…`

Same root cause as §3.3, second variable: `CONDUWUIT_ADMIN_ROOM` was copied
from another homeserver. Resolve the room id on **this** homeserver:

```bash
kubectl -n <ns> port-forward svc/conduwuit 28449:6167 &
sleep 3
curl -s "http://localhost:28449/_matrix/client/v3/directory/room/%23admins%3Alocal" \
  -H "Authorization: Bearer <valid-token>" | jq -r .room_id
```

Update `CONDUWUIT_ADMIN_ROOM` in the env file, re-run `gke-up.sh` (or patch
the Secret + restart both deployments, §3.6).

### 3.5 Team-creation retry loop (historical — fixed)

> **Historical note.** Both halves of this bug pair are now fixed; a same-id
> `create` retry after a failed team creation recovers on its own — no
> `kubectl exec` / `rm -rf` and no new team id needed.
>
> - The leftover-directory deadlock (`Cannot extend: team … does not exist
>   yet`) is fixed in *#1525*: a config-less / provisioning-stub dir under
>   `/workspace/agents/` is now classified as an adoptable orphan (cleaned up
>   and recreated) instead of a collision, and the rollback hardens the
>   directory removal + reports any cleanup it could not complete.
> - The `M_USER_DEACTIVATED` half is fixed in *#1390* (#1413): same-id retries
>   recover from a deactivated Matrix localpart.

### 3.6 Chat error: `admin join failed`

The Secret was updated but only one consumer restarted. **Both** the
orchestrator *and* the admin-console read `MATRIX_ACCESS_TOKEN` (the console
performs the admin's DM-room join itself — `admin-console/api/api.js`,
`ensureAgentDmRoom`). Rule of thumb:

> After **any** change to the `agent-studio-env` Secret:
>
> ```bash
> kubectl -n <ns> rollout restart deploy/admin-console deploy/orchestrator
> ```

(`gke-up.sh` re-runs do this for you.)

### 3.7 Public URL dead right after bootstrap

The ManagedCertificate takes **15–30 minutes** to turn `Active` on first
provisioning (ACME challenge through the new ingress). Until then HTTPS
returns nothing. This is not an error — watch it:

```bash
kubectl -n <ns> get managedcertificate agent-studio-cert -w
```

Meanwhile, port-forward works: `kubectl -n <ns> port-forward
svc/admin-console 4200:4000`.

### 3.8 Skills page empty

The skill pool is seeded **only** by `gke-up.sh` (CI never does it). If the
environment was brought up another way, seed by hand:

```bash
POOL_POD=$(kubectl -n <ns> get pod -l app.kubernetes.io/component=admin-console \
  -o jsonpath='{.items[0].metadata.name}')
kubectl -n <ns> cp orchestrator/skill-pool/. "${POOL_POD}:/pool/"
kubectl -n <ns> cp mcp-servers/. "${POOL_POD}:/pool/mcp-servers/"
```

## 4. Operations

**kubectl access** (one-time per workstation):

```bash
gcloud auth login
gcloud components install gke-gcloud-auth-plugin
gcloud container clusters get-credentials agent-studio \
  --zone europe-west3-b --project acn-projectroots
# context name: gke_acn-projectroots_europe-west3-b_agent-studio
```

**Rotate / change a Secret value** (console password, LLM token, …): edit the
env file, then re-run `gke-up.sh --env <env> --tag <current-tag>` — it
re-renders the Secret *and* rollout-restarts. Manual alternative: patch the
Secret, then restart **both** deployments (§3.6).

**Re-running `gke-up.sh`** is always safe: idempotent, skips the Matrix
bootstrap when the existing token is valid, self-heals a stale conduwuit
bootstrap patch (§3.1), reseeds the skill pool, and rollout-restarts (which
CI's tag-pinned apply cannot do for Secret-only changes).

**Wire IAP single login (`IAP_AUDIENCE`)** — after the environment's ingress
exists. Silent login is issued only for IAP identities registered as Agent
Studio users (Access & Users page) or matching `ADMIN_USERNAME` (#1415); everyone else
gets the console login form. The audience embeds the environment's **own**
backend-service id, so test and preprod each need their own (never copy it):

```bash
CTX=gke_acn-projectroots_europe-west3-b_agent-studio
NS=agent-studio            # or agent-studio-preprod
ENV_FILE=.env.gke          # or .env.gke-preprod
BACKEND=$(gcloud compute backend-services list --global --project acn-projectroots \
  --format='value(name)' | grep "$NS-" | grep admin-console)
AUD="/projects/$(gcloud projects describe acn-projectroots --format='value(projectNumber)')/global/backendServices/$(gcloud compute backend-services describe "$BACKEND" --global --project acn-projectroots --format='value(id)')"
echo "IAP_AUDIENCE=$AUD" >> "$ENV_FILE"
kubectl --context "$CTX" -n "$NS" patch secret agent-studio-env \
  -p "{\"stringData\":{\"IAP_AUDIENCE\":\"$AUD\"}}"
kubectl --context "$CTX" -n "$NS" rollout restart deploy/admin-console
```

(If the `grep "$NS-"` filter matches nothing, list the backend services and
pick the one belonging to this namespace's admin-console — GKE names them
`k8s1-…-<namespace>-admin-console-…`.)

Behind IAP the console's Logout button is cosmetic — the proxy
re-authenticates on the next request. Real sign-out:
`https://<host>/?gcp-iap-mode=CLEAR_LOGIN_COOKIE`.

**What's running where:**

```bash
kubectl -n <ns> get deploy -o wide     # image tags = deployed version
```

The console footer (bottom-left, under *About*) shows the deployed commit's
creation timestamp (e.g. `2026-08-13 17:52 +0200`); clicking it opens the
About page, which still shows the commit's short SHA.
