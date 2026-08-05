# Backup for GKE: daily backup of the agent-studio namespace.
#
# Everything user-created lives in the namespace's four PVCs (agents, teams,
# credentials, chat history / Matrix DB) — one copy, on zonal disks, until this
# plan. The backup covers the namespace's Kubernetes resources, its Secrets,
# and the volume data, so a fat-fingered `kubectl delete`, a corrupted volume,
# or a lost zone is recoverable.
#
# Restore (manual, on purpose — a restore overwrites live state):
#   gcloud beta container backup-restore backups list \
#     --backup-plan=agent-studio-daily --location=europe-west3 --project=acn-projectroots
# then create a RestorePlan/Restore for the chosen backup (see
# https://cloud.google.com/kubernetes-engine/docs/add-on/backup-for-gke).

resource "google_gke_backup_backup_plan" "daily" {
  name     = "agent-studio-daily"
  location = var.region
  cluster  = google_container_cluster.agent_studio.id

  retention_policy {
    # 14 daily backups ≈ two weeks to notice + recover from silent data damage.
    backup_delete_lock_days = 0
    backup_retain_days      = 14
  }

  backup_schedule {
    # 03:41 — deliberately off the full hour (agents' self-curation crons run
    # in the 03:00 hour at staggered minutes; and :00 is everyone's favourite).
    cron_schedule = "41 3 * * *"
  }

  backup_config {
    include_volume_data = true
    include_secrets     = true

    selected_namespaces {
      # Both hosted environments — they share the cluster (#1348), and each
      # namespace carries its own PVCs/Secrets.
      namespaces = ["agent-studio", "agent-studio-preprod"]
    }
  }
}
