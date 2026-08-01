#!/bin/bash
set -euo pipefail

# Provision the "fast temporary" Agent Studio pilot on GCP:
# one Compute Engine VM running the docker-compose stack under rootless Podman.
#
# Everything here matches the feasibility assessment in
# docs/hosting/gcp/ (verified 2026-07-23 against acn-projectroots):
#   - region europe-west3 (Frankfurt) for EU data residency
#   - no public ingress: SSH + admin console only via IAP (35.235.240.0/20)
#   - ephemeral external IP for egress only (LLM proxy, ghcr.io, GitHub)
#
# Read-only preconditions are checked first; each create step is skipped
# if the resource already exists, so the script is safe to re-run.

PROJECT="${PROJECT:-acn-projectroots}"
REGION="${REGION:-europe-west3}"
ZONE="${ZONE:-europe-west3-b}"
# Dedicated VPC: the existing networks (dev/dev0/ops) all carry a tag-less
# "deny all egress to internet" rule at priority 65000 — the stack however
# needs egress (ghcr.io, GitHub, the LiteLLM proxy). A fresh VPC keeps those
# policies untouched and gives us the implied allow-egress + our own
# IAP-only ingress. Free of charge, deleted whole at teardown.
NETWORK="${NETWORK:-agent-studio-net}"
SUBNET="${SUBNET:-agent-studio-ew3}"
SUBNET_RANGE="${SUBNET_RANGE:-10.30.0.0/24}"
INSTANCE="${INSTANCE:-agent-studio-pilot}"
MACHINE_TYPE="${MACHINE_TYPE:-e2-standard-4}"   # 4 vCPU / 16 GB ≈ 5 concurrent agents
BOOT_DISK_GB="${BOOT_DISK_GB:-64}"
TAG="agent-studio"
IAP_RANGE="35.235.240.0/20"                      # Google IAP TCP-forwarding source range
IMAGE_FAMILY="${IMAGE_FAMILY:-fedora-cloud-43-x86-64}"  # Podman 5.x (SubPath mounts)
IMAGE_PROJECT="${IMAGE_PROJECT:-fedora-cloud}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=== Agent Studio GCP pilot provisioning (project: ${PROJECT}) ==="

# --- 0. Dedicated VPC ---
if gcloud compute networks describe "${NETWORK}" --project="${PROJECT}" >/dev/null 2>&1; then
  echo "[skip] network ${NETWORK} already exists"
else
  echo "[create] network ${NETWORK} (custom mode)"
  gcloud compute networks create "${NETWORK}" \
    --project="${PROJECT}" --subnet-mode=custom
fi

# --- 1. Subnet ---
if gcloud compute networks subnets describe "${SUBNET}" \
    --project="${PROJECT}" --region="${REGION}" >/dev/null 2>&1; then
  echo "[skip] subnet ${SUBNET} already exists"
else
  echo "[create] subnet ${SUBNET} (${SUBNET_RANGE}) in ${REGION}"
  gcloud compute networks subnets create "${SUBNET}" \
    --project="${PROJECT}" --network="${NETWORK}" \
    --region="${REGION}" --range="${SUBNET_RANGE}"
fi

# --- 2. Firewall: IAP-only ingress for SSH (22) and admin console tunnel (14000) ---
if gcloud compute firewall-rules describe allow-iap-agent-studio \
    --project="${PROJECT}" >/dev/null 2>&1; then
  echo "[skip] firewall rule allow-iap-agent-studio already exists"
else
  echo "[create] firewall rule allow-iap-agent-studio (IAP range only)"
  # 14000, not 4000: the console's canonical port 4000 is reserved for local
  # development (make up) on operator machines — keeping the hosted stack on a
  # distinct port means tunnel commands can never collide with a local stack.
  gcloud compute firewall-rules create allow-iap-agent-studio \
    --project="${PROJECT}" --network="${NETWORK}" \
    --direction=INGRESS --action=ALLOW \
    --rules=tcp:22,tcp:14000 \
    --source-ranges="${IAP_RANGE}" \
    --target-tags="${TAG}"
fi

# --- 3. The VM ---
if gcloud compute instances describe "${INSTANCE}" \
    --project="${PROJECT}" --zone="${ZONE}" >/dev/null 2>&1; then
  echo "[skip] instance ${INSTANCE} already exists"
else
  echo "[create] instance ${INSTANCE} (${MACHINE_TYPE}, Fedora Cloud, ${BOOT_DISK_GB} GB)"
  gcloud compute instances create "${INSTANCE}" \
    --project="${PROJECT}" --zone="${ZONE}" \
    --machine-type="${MACHINE_TYPE}" \
    --image-family="${IMAGE_FAMILY}" --image-project="${IMAGE_PROJECT}" \
    --boot-disk-size="${BOOT_DISK_GB}GB" --boot-disk-type=pd-balanced \
    --subnet="projects/${PROJECT}/regions/${REGION}/subnetworks/${SUBNET}" \
    --tags="${TAG}" \
    --no-service-account --no-scopes \
    --metadata-from-file=startup-script="${SCRIPT_DIR}/vm-bootstrap.sh"
fi

echo ""
echo "Done. Next steps:"
echo "  1. Wait ~2 min for the startup script (podman/git/compose install), then:"
echo "     gcloud compute ssh ${INSTANCE} --project=${PROJECT} --zone=${ZONE} --tunnel-through-iap"
echo "  2. Transfer the repo tarball + .env and run deploy/gcp/vm-stack-setup.sh (see runbook)."
