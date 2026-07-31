# Keyless deploy identity for GitHub Actions (workflow: .github/workflows/deploy-gke.yml).
#
# The workflow exchanges its GitHub OIDC token for this service account via
# Workload Identity Federation — no GCP keys are stored in GitHub. The provider
# only accepts tokens from var.github_repository (attribute condition).

resource "google_service_account" "deployer" {
  account_id   = "agent-studio-deployer"
  display_name = "Agent Studio deployer (GitHub Actions via WIF)"
}

resource "google_iam_workload_identity_pool" "github" {
  workload_identity_pool_id = "github"
  display_name              = "GitHub Actions"
}

resource "google_iam_workload_identity_pool_provider" "github_oidc" {
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "github-oidc"

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }

  attribute_mapping = {
    "google.subject"       = "assertion.sub"
    "attribute.repository" = "assertion.repository"
  }

  attribute_condition = "assertion.repository == '${var.github_repository}'"
}

# Push rights — scoped to the agent-studio repo, not the project.
resource "google_artifact_registry_repository_iam_member" "deployer_ar_writer" {
  repository = google_artifact_registry_repository.agent_studio.name
  location   = var.region
  role       = "roles/artifactregistry.writer"
  member     = "serviceAccount:${google_service_account.deployer.email}"
}

# kubectl rollout rights on the cluster (project-level; GKE has no
# narrower per-cluster predefined binding).
resource "google_project_iam_member" "deployer_container_developer" {
  project = var.project
  role    = "roles/container.developer"
  member  = "serviceAccount:${google_service_account.deployer.email}"
}

# Read-only plan rights for CI (workflow: .github/workflows/terraform-plan.yml).
# The PR plan needs to read the state and every managed resource; it runs with
# -lock=false, so no write access anywhere. Applies stay on operator machines.
resource "google_project_iam_member" "deployer_viewer" {
  project = var.project
  role    = "roles/viewer"
  member  = "serviceAccount:${google_service_account.deployer.email}"
}

resource "google_storage_bucket_iam_member" "deployer_state_reader" {
  bucket = "acn-projectroots-tfstate-5c615c28"
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${google_service_account.deployer.email}"
}

# Only workflows from var.github_repository may impersonate the deployer SA.
resource "google_service_account_iam_member" "deployer_wif_user" {
  service_account_id = google_service_account.deployer.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/projects/${var.project_number}/locations/global/workloadIdentityPools/${google_iam_workload_identity_pool.github.workload_identity_pool_id}/attribute.repository/${var.github_repository}"
}
