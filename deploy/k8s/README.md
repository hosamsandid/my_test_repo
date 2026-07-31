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

## Access the hosted version (GKE)

The pilot runs on GKE cluster `agent-studio` (project `acn-projectroots`,
`europe-west3-b`). There is deliberately **no public URL** — access is an
authenticated tunnel:

```bash
# one-time
gcloud auth login
gcloud components install gke-gcloud-auth-plugin
gcloud container clusters get-credentials agent-studio \
  --zone europe-west3-b --project acn-projectroots

# each session
kubectl --context gke_acn-projectroots_europe-west3-b_agent-studio \
  -n agent-studio port-forward svc/admin-console 4200:4000
# -> http://localhost:4200
```

Requires GKE access on `acn-projectroots` (`roles/container.developer` or
similar). Deploys to GKE: Actions → **deploy-gke** → Run workflow (manual;
builds amd64 images, pushes to Artifact Registry, rolls out). First-time
infrastructure setup is `deploy/k8s/gke-up.sh` — see its header.

## Port map (all three stacks side by side)

| Stack | Console |
|---|---|
| compose/Podman (`make up`) | `:4000` (or `ADMIN_PORT` from `.env`) |
| kind (local) | `:4100` via port-forward |
| GKE (hosted) | `:4200` via port-forward |
