# Public HTTPS ingress for the admin console via IAP — one static IP + DNS A
# record per hosted environment (#1348).
#
# test and preprod share the GKE cluster (separate namespaces) and this single
# Terraform root/state (prefix env/agent-studio): with all heavy resources
# (cluster, AR, WIF, deployer SA) shared, one state is the honest shape. A
# separate tfstate prefix per environment becomes relevant only if preprod
# ever moves to its own cluster.
#
# The per-namespace GKE Ingress (deploy/k8s/overlays/<env>/app/ingress.yaml)
# references the environment's static IP by name and provisions the GCP LB,
# managed cert, and backend service automatically. Terraform owns the IPs,
# DNS records, and the IAP access grant. Ordering: apply here FIRST — the
# ManagedCertificate only provisions once the DNS record resolves to the IP.

locals {
  console_environments = {
    test    = { hostname = "agent-studio.projectroots-acn.com", ip_name = "agent-studio-ip" }
    preprod = { hostname = "agent-studio-preprod.projectroots-acn.com", ip_name = "agent-studio-preprod-ip" }
  }
}

resource "google_compute_global_address" "admin_console" {
  for_each = local.console_environments
  name     = each.value.ip_name
}

resource "google_dns_record_set" "admin_console" {
  for_each     = local.console_environments
  name         = "${each.value.hostname}."
  managed_zone = "projectroots-acn-com"
  type         = "A"
  ttl          = 300
  rrdatas      = [google_compute_global_address.admin_console[each.key].address]
}

# The original single-environment resources become the "test" map entries —
# moved blocks keep the state addresses in sync (no destroy/recreate; a plan
# that wants to replace agent-studio-ip or its DNS record means these failed).
moved {
  from = google_compute_global_address.admin_console
  to   = google_compute_global_address.admin_console["test"]
}

moved {
  from = google_dns_record_set.admin_console
  to   = google_dns_record_set.admin_console["test"]
}

# IAP access — Accenture org only (brand is orgInternalOnly: true). Project-
# level, so it covers every IAP-enabled backend: test and preprod alike.
# Add every user or group that should reach the consoles.
resource "google_project_iam_member" "iap_accessor" {
  project = var.project
  role    = "roles/iap.httpsResourceAccessor"
  member  = "domain:accenture.com"
}
