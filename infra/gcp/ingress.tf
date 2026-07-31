# Public HTTPS ingress for the admin console via IAP.
#
# GKE Ingress (deploy/k8s/manifests/70-ingress.yaml) references the static IP
# by name and provisions the GCP LB, managed cert, and backend service
# automatically. Terraform owns the IP, DNS record, and IAP access grant.

resource "google_compute_global_address" "admin_console" {
  name = "agent-studio-ip"
}

resource "google_dns_record_set" "admin_console" {
  name         = "agent-studio.projectroots-acn.com."
  managed_zone = "projectroots-acn-com"
  type         = "A"
  ttl          = 300
  rrdatas      = [google_compute_global_address.admin_console.address]
}

# IAP access — Accenture org only (brand is orgInternalOnly: true).
# Add every user or group that should reach the console.
resource "google_project_iam_member" "iap_accessor" {
  project = var.project
  role    = "roles/iap.httpsResourceAccessor"
  member  = "domain:accenture.com"
}
