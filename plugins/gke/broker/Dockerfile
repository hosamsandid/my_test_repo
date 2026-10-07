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

# Build identity (#2646): the git commit this image was built from — plus the
# nearest release tag and distance (#2893) — passed in by `make plugin-images`.
# Baked into the ENVIRONMENT so the running broker reports it on /healthz
# (broker-sdk/build-info.js) — the only way to tell what a live sidecar really
# runs while every image is tagged `:latest` — and into OCI labels so
# `podman image inspect` shows it without starting anything.
# Declared last so a new commit only rebuilds these metadata layers.
ARG AEE_BUILD_COMMIT=unknown
ARG AEE_BUILD_DIRTY=
ARG AEE_BUILD_COMMIT_TIME=
ARG AEE_BUILD_TAG=
ARG AEE_BUILD_TAG_DISTANCE=
ENV AEE_BUILD_COMMIT="${AEE_BUILD_COMMIT}" \
    AEE_BUILD_DIRTY="${AEE_BUILD_DIRTY}" \
    AEE_BUILD_COMMIT_TIME="${AEE_BUILD_COMMIT_TIME}" \
    AEE_BUILD_TAG="${AEE_BUILD_TAG}" \
    AEE_BUILD_TAG_DISTANCE="${AEE_BUILD_TAG_DISTANCE}"
LABEL org.opencontainers.image.revision="${AEE_BUILD_COMMIT}" \
      aee.build.dirty="${AEE_BUILD_DIRTY}" \
      aee.build.commit-time="${AEE_BUILD_COMMIT_TIME}" \
      aee.build.tag="${AEE_BUILD_TAG}" \
      aee.build.tag-distance="${AEE_BUILD_TAG_DISTANCE}"

CMD ["node", "server.js"]
