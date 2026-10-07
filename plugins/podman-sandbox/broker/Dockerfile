FROM node:22-bookworm-slim

# Podman client (talks to the mounted rootless socket via --url).
RUN apt-get update \
 && apt-get install -y --no-install-recommends podman podman-compose ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Nested Podman-in-Podman: the base image ships no /etc/containers/storage.conf
# at all, so podman falls back to its compiled-in "overlay" driver, which
# cannot run on top of the host's own overlayfs-backed container filesystem
# ("'overlay' is not supported over overlayfs, a mount_program is required").
# Force the vfs driver instead — it needs no fuse-overlayfs/kernel support,
# at the cost of slower/more disk-hungry container creation, which is fine
# here since this service only manages a handful of lightweight per-scope
# stacks.
RUN mkdir -p /etc/containers \
 && printf '[storage]\ndriver = "vfs"\nrunroot = "/run/containers/storage"\ngraphroot = "/var/lib/containers/storage"\n' > /etc/containers/storage.conf

WORKDIR /opt/plugins/podman-sandbox/broker
COPY plugins/podman-sandbox/broker/package.json ./package.json
RUN npm install --omit=dev
COPY plugins/podman-sandbox/broker/ ./
# Broker SDK (plugin system Phase 4, #1520): the shared broker obligations
# module. This build's context is the repo root (see the broker COPYs above),
# so broker-sdk/ is available; copy it to /opt/broker-sdk so server.js resolves
# it as ../../../broker-sdk both here and in the source tree (WORKDIR
# /opt/plugins/podman-sandbox/broker → ../../../broker-sdk = /opt/broker-sdk).
COPY broker-sdk/ /opt/broker-sdk/

ENV PODMAN_MCP_PORT=4004
EXPOSE 4004

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
