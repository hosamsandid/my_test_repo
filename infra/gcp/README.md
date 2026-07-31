# Agent Studio — GCP infrastructure (Terraform)

Codifies the stage-1 GKE hosting in `acn-projectroots`: the `agent-studio`
cluster (zonal, 1 node, RWO storage), the Artifact Registry repo, the keyless
GitHub-Actions deploy identity (Workload Identity Federation), and a daily
Backup-for-GKE plan for the `agent-studio` namespace (volumes + secrets,
14-day retention — see `backup.tf` for the restore procedure).

Cluster, node pool, registry and deployer SA **already exist** (created
imperatively while standing up the pilot) — `imports.tf` adopts them into
state; nothing is recreated. The WIF pool/provider and the deployer's IAM
bindings are **created** by the first apply (their manual setup was never
executed). In-cluster resources (namespace, RBAC, PVCs, deployments) are
deliberately **not** Terraform — they stay plain manifests in `deploy/k8s/`,
applied by `kind-up.sh`/`gke-up.sh` and the `deploy-gke` workflow.

## Usage

```bash
cd infra/gcp
export GOOGLE_OAUTH_ACCESS_TOKEN=$(gcloud auth print-access-token)

terraform init
terraform plan
terraform apply
```

**Safety rule:** a routine plan shows only the changes you authored. Any
destroy/replace of an imported resource means the config drifted from
reality — stop and reconcile, never apply through it.

## State

Remote state in the project-shared GCS bucket
`acn-projectroots-tfstate-5c615c28` under prefix `env/agent-studio`
(`versions.tf`). The bucket is owned by the accessio Terraform setup, which
manages sibling resources in this project: its `infra/bootstrap/` created it
(versioned, CMEK-encrypted) precisely to be shared, one prefix per stack —
accessio itself uses `auth`, `env/uat` and `env/uat-k8s`. Migrating an
existing local state into it is one command: `terraform init -migrate-state`
(the old `terraform.tfstate` stays on disk, gitignored, as a fallback).

## CI

`.github/workflows/terraform-plan.yml` runs `fmt`/`validate` and a full
`terraform plan` on every PR touching `infra/gcp/**`, using the same keyless
WIF identity as `deploy-gke.yml`. **Plan-only by design**: the deployer SA
holds just `roles/viewer` + read access to the state bucket (`deployer.tf`),
and applies stay on operator machines. Upgrading to accessio's
apply-on-merge pattern would mean granting the SA admin roles over
everything this module manages — deliberate, not an oversight.

## Out of scope / next

- **The accessio Terraform supermodule**
  (`313498_terraform-google-deployment`, spec-driven via
  `google.auto.tfvars.json`) — evaluated and deliberately not adopted:
  rewriting this small module onto it would force re-importing every
  resource into new module addresses and add a PAT for the private module
  repo, for no functional gain at this size. Revisit if the module grows.

- **IAP/SSO ingress** for the admin console (planned next; follows the
  accessio pattern — OAuth consent, external HTTPS LB, IdP wiring)
- **Filestore (RWX)** — required before `node_count > 1`; deliberately
  deferred (1 TiB minimum ≈ $150–200/month)
- The pre-existing VPC (`agent-studio-net`) — owned by the Podman-pilot
  provisioning (`deploy/gcp/provision.sh`), not imported here yet
