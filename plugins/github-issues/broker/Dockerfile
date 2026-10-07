FROM node:22-bookworm-slim

# The github-issues broker holds a credential (a team's Working-Environment
# GitHub token, pushed per-scope at runtime — never baked in) and reaches GitHub
# (capabilities: ["egress"]). It needs no host socket and no workspace mount: it
# reaches only its own state volume (AEE_PLUGIN_STATE_DIR, last-used prefs), the
# audit volume, and GitHub's API. No third-party dependencies (Node's built-in
# http + global fetch), so there is nothing to `npm install`.

WORKDIR /opt/plugins/github-issues/broker
COPY plugins/github-issues/broker/package.json ./package.json
COPY plugins/github-issues/broker/ ./
# Broker SDK (plugin system Phase 4, #1520): the shared broker-obligations
# module. This build's context is the repo root, so the sibling broker-sdk/ is
# available; copy it to /opt/broker-sdk so server.js resolves it as
# ../../../broker-sdk both here and in the source tree
# (WORKDIR /opt/plugins/github-issues/broker → ../../../broker-sdk = /opt/broker-sdk).
COPY broker-sdk/ /opt/broker-sdk/

ENV AEE_PLUGIN_PORT=4008
EXPOSE 4008

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
