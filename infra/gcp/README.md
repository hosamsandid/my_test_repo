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
terraform plan    # first run: 4 to import, 5 to add, 0 to change, 0 to destroy
terraform apply
```

**Safety rule for the first apply:** the plan must show only imports (plus at
most in-place metadata updates). Any destroy/replace means the config drifted
from reality — stop and reconcile, never apply through it.

## State

Local state for the initial import. Before anyone else runs this module,
switch `versions.tf` to the team's GCS backend (align conventions with the
accessio Terraform setup, which manages sibling resources in this project).

## Out of scope / next

- **IAP/SSO ingress** for the admin console (planned next; follows the
  accessio pattern — OAuth consent, external HTTPS LB, IdP wiring)
- **Filestore (RWX)** — required before `node_count > 1`; deliberately
  deferred (1 TiB minimum ≈ $150–200/month)
- The pre-existing VPC (`agent-studio-net`) — owned by the Podman-pilot
  provisioning (`deploy/gcp/provision.sh`), not imported here yet
