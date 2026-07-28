# Agent Studio on GCP — VM + Podman pilot runbook

**Scope:** the "fast temporary" hosting option for the Accessio Deutsche Bank Migration
project — a single Compute Engine VM running the unchanged `docker-compose.yml` stack
under rootless Podman. The Kubernetes/GKE migration is a separate, later iteration.

**Feasibility basis:** `docs/hosting/gcp/gcp-hosting-feasibility.md` in the GitLab repo
(live `gcloud` checks against `acn-projectroots`, 2026-07-23): all required IAM
permissions held, all APIs enabled, no blocking org policies.

## Shape

| What | Choice | Why |
|---|---|---|
| Project | `acn-projectroots` | Verified access + enabled APIs |
| Region/zone | `europe-west3-b` (Frankfurt) | EU data residency (client data is Confidential) |
| VM | `agent-studio-pilot`, `e2-standard-4` (4 vCPU / 16 GB), 64 GB `pd-balanced` | Pilot spec from the Hyperscale intake; ≈5 concurrent agents |
| OS | Fedora Cloud 43 | Ships Podman 5.x — required for the libpod `SubPath` volume mounts (`AEE_WORKSPACE_ISOLATION`); the compose file already carries the SELinux annotations |
| Ingress | **None public.** SSH (22) + console (14000) only via IAP TCP forwarding (`35.235.240.0/20`) | Confidential data; no LB needed = cheap |
| Egress | Ephemeral external IP | Reaches the LiteLLM proxy, ghcr.io, GitHub; avoids Cloud NAT setup |
| Auth to VM | OS Login (org-enforced) + IAP tunnel | No metadata SSH keys, no public SSH |
| Console login | `ADMIN_PASSWORD` generated on the VM (never the `admin/admin` default) | Cloud-hosted console |
| Service account | None (`--no-service-account --no-scopes`) | Stack needs no GCP APIs; least privilege |

## Deploy (from the workstation)

```bash
# 0. Auth (SSO, interactive)
gcloud auth login

# 1. Provision subnet + firewall + VM (idempotent)
./deploy/gcp/provision.sh

# 2. Package the repo (tracked + untracked non-ignored files; no .git — pilot
#    updates are pushed as a fresh tarball, not via git pull on the VM)
git ls-files -co --exclude-standard | tar -czf /tmp/agent-studio.tar.gz -T -
# .env: copy your local one; setup.sh regenerates MATRIX_ACCESS_TOKEN +
# CONDUWUIT_ADMIN_ROOM on the VM, vm-stack-setup.sh pins the VM-specific values.

# 3. Copy to the VM over IAP
gcloud compute scp /tmp/agent-studio.tar.gz /tmp/agent-studio.env deploy/gcp/vm-stack-setup.sh \
  agent-studio-pilot:~ --zone=europe-west3-b --project=acn-projectroots --tunnel-through-iap

# 4. On the VM: stage to the aee service user and bring the stack up.
#    The stack runs under the local user `aee` (created by vm-bootstrap.sh) —
#    systemd cannot resolve OS Login users, so linger/user-services only work
#    for a real local account. Operators reach it via `sudo -H -u aee`.
gcloud compute ssh agent-studio-pilot --zone=europe-west3-b --project=acn-projectroots --tunnel-through-iap
sudo install -o aee -g aee -m 600 ~/agent-studio.tar.gz ~/agent-studio.env /home/aee/
sudo install -o aee -g aee -m 755 ~/vm-stack-setup.sh /home/aee/
sudo -H -u aee bash -c 'cd; ADMIN_PASS=<matrix-admin-password> bash ~/vm-stack-setup.sh'
```

## Prerequisites (one-time per workstation)

Everything below — the tunnel, SSH, and the GCP web console — requires **Google Cloud
SSO with your Accenture account** (`<you>@accenture.com`) *and* access to the
`acn-projectroots` project. There is deliberately no public URL and no shared
credential: identity is the perimeter.

```bash
# 1. Install the gcloud CLI (macOS)
brew install --cask gcloud-cli        # older Homebrew: brew install --cask google-cloud-sdk
# no Homebrew? https://cloud.google.com/sdk/docs/install (download + ./google-cloud-sdk/install.sh)

# 2. Log in via SSO (opens a browser -> Accenture sign-in) and pin the project
gcloud auth login
gcloud config set project acn-projectroots
```

Notes:
- The SSO session **expires** (typically daily). When gcloud commands start failing
  with "Reauthentication failed / cannot prompt", simply run `gcloud auth login` again.
- To use the tunnel you additionally need the `iap.tunnelInstances.accessViaIAP`
  IAM permission on the project — ask the project owner to grant
  `roles/iap.tunnelResourceAccessor` (plus `roles/compute.viewer`) to new users.

## The VM in the GCP web console

[**agent-studio-pilot — instance details**](https://console.cloud.google.com/compute/instancesDetail/zones/europe-west3-b/instances/agent-studio-pilot?project=acn-projectroots)
(start/stop buttons, CPU/RAM/network graphs under *Observability*, boot log under
*Serial port 1*). The link only works when you are signed into the Google Cloud
console with the same SSO identity — anyone without access to `acn-projectroots`
gets a permission error.

## Access the console

```bash
gcloud compute start-iap-tunnel agent-studio-pilot 14000 \
  --local-host-port=localhost:14000 --zone=europe-west3-b --project=acn-projectroots
# then open http://localhost:14000 — username `admin`, password:
#   gcloud compute ssh agent-studio-pilot --zone=europe-west3-b --project=acn-projectroots \
#     --tunnel-through-iap --command='sudo grep ^ADMIN_PASSWORD /home/aee/agent-studio/.env'
```

Anyone who should reach the console needs `iap.tunnelInstances.accessViaIAP` on the
project (or instance) — access is governed by IAM, not by network exposure.

> **Port convention:** the hosted console lives on **14000** everywhere (VM publish,
> firewall, tunnel) — port 4000 stays reserved for local development (`make up`), so
> the local stack and the GCP tunnel can run side by side.

## Update / redeploy (after the initial setup)

Two paths, one shared implementation — both run `deploy/gcp/vm-update.sh` on the VM
(sync tree, keep `.env`, `make up`, seed, health-check), so they cannot drift:

1. **GitHub Actions** (`.github/workflows/deploy-gcp.yml`): manual trigger via the
   Actions tab → *deploy-gcp* → *Run workflow* (auto-deploy on merge is a commented-out
   `push` trigger — off because a deploy restarts changed services mid-agent-session).
   Runs on a **self-hosted runner on the VM itself** (name `agent-studio-pilot`, label
   `gcp-pilot`, systemd service, runs as `aee`). This keeps ALL GCP credentials out of
   GitHub: the runner polls GitHub outbound; the deploy is a local operation.
   *Security note:* anyone with write access to the repo's workflows can execute code
   on the VM — the runner is repo-scoped on purpose; keep it that way.
2. **Manual from a workstation:** `./deploy/gcp/deploy.sh` (needs gcloud auth + IAP IAM).

## Operations

```bash
# Stop when unused (biggest cost lever: VM ≈ $107/mo running, ~$10/mo stopped disk-only)
gcloud compute instances stop  agent-studio-pilot --zone=europe-west3-b --project=acn-projectroots
gcloud compute instances start agent-studio-pilot --zone=europe-west3-b --project=acn-projectroots
# Containers come back automatically after start: the aee user's systemd unit
# `agent-studio.service` (enabled + lingered) runs `compose up -d` at boot —
# verified via a full stop/start cycle. (Rootless `restart: unless-stopped`
# alone does NOT survive reboots.)

# Logs / status on the VM (always as the aee service user)
sudo -H -u aee bash -c 'cd ~/agent-studio && set -a && . ./.env && set +a && make ps'
sudo -H -u aee bash -c 'cd ~/agent-studio && set -a && . ./.env && set +a && make logs'

# Teardown (everything this pilot created)
gcloud compute instances delete agent-studio-pilot --zone=europe-west3-b --project=acn-projectroots
gcloud compute firewall-rules delete allow-iap-agent-studio --project=acn-projectroots
gcloud compute networks subnets delete agent-studio-ew3 --region=europe-west3 --project=acn-projectroots
```

## Known limitations (pilot posture, deliberate)

- **Single VM, no HA/backup** — the one stateful asset is the `conduwuit-db` volume;
  snapshot the disk or export the volume before anything irreversible.
- **Secrets live in `.env` on the VM disk** (like the local dev setup). Secret Manager
  wiring is a hardening follow-up.
- **Placeholder SSH key** — `vm-stack-setup.sh` generates an unused keypair for the
  compose bind-mount; register a real deploy key when agents should clone/push GitHub repos.
- **LLM proxy reachability** (`litellm.sandbox.starplatform.cloud`) must be confirmed
  from the VM on first deploy — if that endpoint ever gets IP-allowlisted, the VM's
  egress IP needs to be added.
- **No public ingress** also means GitHub webhooks can't reach the stack — exactly the
  scenario the polling-based `github-event` triggers were built for; nothing to do.
