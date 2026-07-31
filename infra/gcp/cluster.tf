# Stage-1 GKE cluster: zonal, single node pool, RWO storage (no Filestore).
# Matches the cluster created imperatively on 2026-07-29 — imported, not
# recreated (see imports.tf). Scaling beyond one node requires an RWX
# StorageClass for the shared /workspace PVC first (Filestore CSI).

resource "google_container_cluster" "agent_studio" {
  name     = var.cluster_name
  location = var.zone

  network    = var.network
  subnetwork = var.subnetwork

  # VPC-native; secondary ranges were auto-created at cluster creation.
  ip_allocation_policy {}

  release_channel {
    channel = "REGULAR"
  }

  # Agent required by Backup for GKE (see backup.tf) — in-place addon update.
  addons_config {
    gke_backup_agent_config {
      enabled = true
    }
  }

  # The node pool is managed as its own resource below; these cluster-level
  # node attributes only describe the imported state and must not drive diffs.
  initial_node_count = 1

  deletion_protection = true

  lifecycle {
    # Node configuration lives on google_container_node_pool.default_pool.
    ignore_changes = [initial_node_count, node_config]
  }
}

resource "google_container_node_pool" "default_pool" {
  name     = "default-pool"
  cluster  = google_container_cluster.agent_studio.name
  location = var.zone

  node_count = var.node_count

  node_config {
    machine_type = var.node_machine_type
    disk_type    = "pd-balanced"
    disk_size_gb = 50

    metadata = {
      disable-legacy-endpoints = "true"
    }
  }
}
