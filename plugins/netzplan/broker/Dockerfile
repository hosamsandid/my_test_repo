FROM node:22-bookworm-slim

# Least privilege: this broker holds NO credential and needs no host socket, no
# workspace mount. It reaches only its own state volume (AEE_PLUGIN_STATE_DIR,
# where the board documents live) and the audit volume. capabilities: [].

WORKDIR /opt/plugins/netzplan/broker
COPY plugins/netzplan/broker/package.json ./package.json
RUN npm install --omit=dev
COPY plugins/netzplan/broker/ ./
# Broker SDK (plugin system Phase 4, #1520): the shared broker-obligations
# module. This build's context is the repo root, so broker-sdk/ is available;
# copy it to /opt/broker-sdk so server.js resolves it as ../../../broker-sdk
# both here and in the source tree (WORKDIR /opt/plugins/netzplan/broker
# → ../../../broker-sdk = /opt/broker-sdk).
COPY broker-sdk/ /opt/broker-sdk/

ENV AEE_PLUGIN_PORT=4006
EXPOSE 4006

# Build identity (#2646): the git commit this image was built from, passed in
# by `make plugin-images`. Baked into the ENVIRONMENT so the running broker
# reports it on /healthz (broker-sdk/build-info.js) — the only way to tell what
# a live sidecar really runs while every image is tagged `:latest` — and into
# OCI labels so `podman image inspect` shows it without starting anything.
# Declared last so a new commit only rebuilds these metadata layers.
ARG AEE_BUILD_COMMIT=unknown
ARG AEE_BUILD_DIRTY=
ARG AEE_BUILD_COMMIT_TIME=
ENV AEE_BUILD_COMMIT="${AEE_BUILD_COMMIT}" \
    AEE_BUILD_DIRTY="${AEE_BUILD_DIRTY}" \
    AEE_BUILD_COMMIT_TIME="${AEE_BUILD_COMMIT_TIME}"
LABEL org.opencontainers.image.revision="${AEE_BUILD_COMMIT}" \
      aee.build.dirty="${AEE_BUILD_DIRTY}" \
      aee.build.commit-time="${AEE_BUILD_COMMIT_TIME}"

CMD ["node", "server.js"]
