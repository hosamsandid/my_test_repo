FROM node:22-bookworm-slim

# The GKE broker holds the GCP credential (acquired via its own UI) and needs
# two CLIs the reference brokers don't: `kubectl` (the read-only cluster client)
# and `gcloud` (the OAuth sign-in + ~1h access-token refresh). Everything
# security-shaped still comes from the Broker SDK. capabilities: ["egress"].

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates gnupg apt-transport-https \
 && rm -rf /var/lib/apt/lists/*

# kubectl — read-only cluster client. Stable pinned binary, arch-aware.
RUN curl -fsSLo /usr/local/bin/kubectl \
      "https://dl.k8s.io/release/v1.31.4/bin/linux/$(dpkg --print-architecture)/kubectl" \
 && chmod +x /usr/local/bin/kubectl \
 && kubectl version --client=true 2>/dev/null | head -1 || true

# Google Cloud CLI — the broker signs in to GCP and refreshes access tokens.
RUN echo "deb [signed-by=/usr/share/keyrings/cloud.google.gpg] https://packages.cloud.google.com/apt cloud-sdk main" \
      > /etc/apt/sources.list.d/google-cloud-sdk.list \
 && curl -fsSL https://packages.cloud.google.com/apt/doc/apt-key.gpg \
      | gpg --dearmor -o /usr/share/keyrings/cloud.google.gpg \
 && apt-get update \
 && apt-get install -y --no-install-recommends google-cloud-cli \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/plugins/gke/broker
COPY plugins/gke/broker/package.json ./package.json
RUN npm install --omit=dev
COPY plugins/gke/broker/ ./
# Broker SDK: build context is the repo root, so ../../../broker-sdk resolves to
# /opt/broker-sdk both here and in the source tree (WORKDIR /opt/plugins/gke/broker).
COPY broker-sdk/ /opt/broker-sdk/

ENV AEE_PLUGIN_PORT=4007
EXPOSE 4007
CMD ["node", "server.js"]
