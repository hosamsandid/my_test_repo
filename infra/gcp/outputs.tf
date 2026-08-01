output "cluster_context" {
  description = "kubectl context name for this cluster"
  value       = "gke_${var.project}_${var.zone}_${var.cluster_name}"
}

output "artifact_registry" {
  description = "Docker registry path for image pushes"
  value       = "${var.region}-docker.pkg.dev/${var.project}/${google_artifact_registry_repository.agent_studio.repository_id}"
}

output "deployer_service_account" {
  description = "Service account impersonated by the deploy-gke workflow"
  value       = google_service_account.deployer.email
}

output "wif_provider" {
  description = "Workload Identity provider resource name (used in deploy-gke.yml)"
  value       = "projects/${var.project_number}/locations/global/workloadIdentityPools/${google_iam_workload_identity_pool.github.workload_identity_pool_id}/providers/${google_iam_workload_identity_pool_provider.github_oidc.workload_identity_pool_provider_id}"
}
