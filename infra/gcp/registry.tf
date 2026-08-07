# Artifact Registry docker repo for the four Agent Studio images.
# Images MUST be linux/amd64 (GKE nodes are x86_64) — built/pushed by the
# deploy-gke GitHub-Actions workflow.

resource "google_artifact_registry_repository" "agent_studio" {
  repository_id = "agent-studio"
  location      = var.region
  format        = "DOCKER"
  description   = "Agent Studio images (K8s hosting)"
}
