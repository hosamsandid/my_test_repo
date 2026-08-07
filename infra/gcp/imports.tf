# Declarative imports (Terraform >= 1.5) for the resources that ALREADY EXIST
# in acn-projectroots (created imperatively 2026-07-29 while standing up the
# stage-1 hosting): cluster, node pool, Artifact Registry repo, deployer SA.
# On the first `terraform apply` these blocks adopt the live resources into
# state — nothing is recreated. After that first apply this file can be deleted.
#
# The WIF pool/provider and the three deployer IAM bindings are NOT imported —
# the manual setup for those was never executed, so Terraform creates them
# (first plan: 4 to import, 5 to add, 0 to destroy).
#
# Safety rule: any planned destroy/replace means a config/live mismatch — stop
# and reconcile before applying.

import {
  to = google_container_cluster.agent_studio
  id = "projects/acn-projectroots/locations/europe-west3-b/clusters/agent-studio"
}

import {
  to = google_container_node_pool.default_pool
  id = "projects/acn-projectroots/locations/europe-west3-b/clusters/agent-studio/nodePools/default-pool"
}

import {
  to = google_artifact_registry_repository.agent_studio
  id = "projects/acn-projectroots/locations/europe-west3/repositories/agent-studio"
}

import {
  to = google_service_account.deployer
  id = "projects/acn-projectroots/serviceAccounts/agent-studio-deployer@acn-projectroots.iam.gserviceaccount.com"
}

