#!/bin/bash
set -euo pipefail

# Manual deployment of the current working tree to the GCP pilot VM —
# the workstation-driven twin of the GitHub Actions pipeline
# (.github/workflows/deploy-gcp.yml). Both paths run the SAME on-VM update
# logic (deploy/gcp/vm-update.sh), so a manual deploy and a pipeline deploy
# behave identically. Requires: gcloud auth + IAP tunnel IAM.
#
# Usage:  ./deploy/gcp/deploy.sh          (from the repo root)

PROJECT="${PROJECT:-acn-projectroots}"
ZONE="${ZONE:-europe-west3-b}"
INSTANCE="${INSTANCE:-agent-studio-pilot}"
GC="--project=${PROJECT} --zone=${ZONE} --tunnel-through-iap --quiet"

echo "=== [1/3] package working tree (tracked + untracked non-ignored; .env excluded by gitignore) ==="
TARBALL="$(mktemp -t agent-studio-update).tar.gz"
trap 'rm -f "${TARBALL}"' EXIT
git ls-files -co --exclude-standard | tar -czf "${TARBALL}" -T -
ls -lh "${TARBALL}"

echo "=== [2/3] transfer over IAP ==="
# shellcheck disable=SC2086
gcloud compute scp "${TARBALL}" deploy/gcp/vm-update.sh "${INSTANCE}:/tmp/" ${GC}

echo "=== [3/3] update stack on the VM (as service user aee) ==="
# shellcheck disable=SC2086
gcloud compute ssh "${INSTANCE}" ${GC} --command="
  sudo install -o aee -g aee -m 600 /tmp/$(basename "${TARBALL}") /home/aee/update.tar.gz &&
  sudo install -o aee -g aee -m 755 /tmp/vm-update.sh /home/aee/vm-update.sh &&
  sudo -H -u aee bash -c 'cd && bash ~/vm-update.sh ~/update.tar.gz'"

echo ""
echo "Deployed. Console: gcloud compute start-iap-tunnel ${INSTANCE} 14000 \\"
echo "  --local-host-port=localhost:14000 --zone=${ZONE} --project=${PROJECT}"
