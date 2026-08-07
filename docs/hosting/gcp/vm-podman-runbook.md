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

Full walkthrough for a fresh **macOS** workstation — steps 1-4 are one-time, then
"Access the console" below is the everyday path. Skip any step whose check already
passes.

```bash
# 1. Homebrew (skip if `brew --version` already works)
xcode-select --install || true         # Command Line Tools, needed by Homebrew
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
# Apple Silicon: put brew on PATH for this and future shells
echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> ~/.zprofile
eval "$(/opt/homebrew/bin/brew shellenv)"

# 2. Install the gcloud CLI
brew install --cask gcloud-cli        # older Homebrew: brew install --cask google-cloud-sdk
exec zsh                              # reload PATH
gcloud version                        # sanity check
# no Homebrew? https://cloud.google.com/sdk/docs/install (download + ./google-cloud-sdk/install.sh)

# 3. Log in via SSO (opens a browser -> Accenture sign-in) and pin the project
gcloud auth login
gcloud config set project acn-projectroots
gcloud config set compute/zone europe-west3-b
gcloud config list                    # verify account + project

# 4. Optional: NumPy in gcloud's bundled Python — speeds up the tunnel and silences
#    the "consider installing NumPy" warning on every start-iap-tunnel
"$(gcloud info --format='value(basic.python_location)')" -m pip install numpy

# 5. Confirm IAM access + that the VM is up (a permission error here = IAM not granted yet)
gcloud compute instances describe agent-studio-pilot \
  --zone=europe-west3-b --project=acn-projectroots --format='value(status)'
gcloud compute instances start agent-studio-pilot \
  --zone=europe-west3-b --project=acn-projectroots   # only if not RUNNING

# 6. First SSH — generates ~/.ssh/google_compute_engine (empty passphrase is fine) and
#    registers your OS Login entry; also prints the console password you need below
gcloud compute ssh agent-studio-pilot --zone=europe-west3-b --project=acn-projectroots \
  --tunnel-through-iap --command='sudo grep ^ADMIN_PASSWORD /home/aee/agent-studio/.env'
```

Full walkthrough for a fresh **Windows 10/11** workstation — run everything in
**PowerShell** (not Command Prompt). Steps 1-4 are one-time; step 5 onward is the
everyday path. Skip any step whose check already passes.

```powershell
# 1. Enable the OpenSSH client (built into Windows 10 1809+ / Windows 11; skip if
#    `ssh -V` already returns a version)
#    Run this once in an elevated (Admin) PowerShell:
Add-WindowsCapability -Online -Name OpenSSH.Client~~~~0.0.1.0
# Verify:
ssh -V

# 2. Install the gcloud CLI — two options; pick one:

# Option A — winget (recommended; comes pre-installed on Windows 11 and recent Win10)
winget install --id Google.CloudSDK --exact --silent
# Option B — direct installer (works everywhere, GUI wizard)
Invoke-WebRequest -Uri "https://dl.google.com/dl/cloudsdk/channels/rapid/GoogleCloudSDKInstaller.exe" `
  -OutFile "$env:TEMP\GoogleCloudSDKInstaller.exe"
Start-Process -FilePath "$env:TEMP\GoogleCloudSDKInstaller.exe" -Wait

# After either option: open a NEW PowerShell window so the updated PATH takes effect
gcloud version    # sanity check

# 3. Log in via SSO (opens a browser -> Accenture sign-in) and pin the project
gcloud auth login
gcloud config set project acn-projectroots
gcloud config set compute/zone europe-west3-b
gcloud config list    # verify account + project

# 4. Confirm IAM access + that the VM is up (a permission error here = IAM not granted yet)
gcloud compute instances describe agent-studio-pilot `
  --zone=europe-west3-b --project=acn-projectroots --format="value(status)"
# Only if not RUNNING:
gcloud compute instances start agent-studio-pilot `
  --zone=europe-west3-b --project=acn-projectroots

# 5. First SSH — generates %USERPROFILE%\.ssh\google_compute_engine and registers
#    your OS Login entry; also prints the console password you need below.
#    Accept the "do you want to continue?" prompt; leave the passphrase empty.
gcloud compute ssh agent-studio-pilot --zone=europe-west3-b --project=acn-projectroots `
  --tunnel-through-iap --command="sudo grep ^ADMIN_PASSWORD /home/aee/agent-studio/.env"

# 6. Open the IAP tunnel (keep this PowerShell window open)
gcloud compute start-iap-tunnel agent-studio-pilot 14000 `
  --local-host-port=localhost:14000 --zone=europe-west3-b --project=acn-projectroots
# Windows Firewall may prompt for network access — allow it.
# Then open http://localhost:14000 in a browser; user = admin, password from step 5.
# Ctrl-C closes the tunnel.

# Troubleshoot: check whether the tunnel is listening
netstat -ano | findstr ":14000"
# PowerShell alternative:
Get-NetTCPConnection -LocalPort 14000 -State Listen -ErrorAction SilentlyContinue
# No output = no tunnel running; re-run step 6.
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

Leave the tunnel running in its own terminal tab (`Ctrl-C` closes it) — the browser talks
to it for the whole session.

Anyone who should reach the console needs `iap.tunnelInstances.accessViaIAP` on the
project (or instance) — access is governed by IAM, not by network exposure.

`http://localhost:14000` refusing the connection is almost always a **missing tunnel**,
not a broken stack — check with `lsof -nP -iTCP:14000 -sTCP:LISTEN` (no output = no
tunnel) and re-run the `start-iap-tunnel` command above. Only if the tunnel *is* up and
the page still fails is it worth checking the stack itself (`Operations` below).

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
