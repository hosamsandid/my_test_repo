FROM node:22-bookworm-slim

# The Jira broker holds a credential ({siteUrl, email, apiToken} — pushed
# per-scope by the orchestrator at runtime, never baked in) and reaches Jira
# Cloud (capabilities: ["egress"]). It needs no
# host socket and no workspace mount — only its own state volume
# (AEE_PLUGIN_STATE_DIR: watch configs, poll cursors, the per-scope event inbox),
# the audit volume, and Jira's REST API. No third-party dependencies (Node's
# built-in http + global fetch), so there is nothing to `npm install`.

WORKDIR /opt/plugins/jira/broker
COPY plugins/jira/broker/package.json ./package.json
# The whole broker dir. A gitignored broker/.env.local (the credential the
# in-sidecar `spike.js` debug helper reads) is EXCLUDED by the root
# .dockerignore — server.js never reads it, and it must not land in a layer.
COPY plugins/jira/broker/ ./
# Broker SDK: the shared broker-obligations module. This build's context is the
# repo root, so the sibling broker-sdk/ is available; copy it to /opt/broker-sdk
# so server.js resolves it as ../../../broker-sdk both here and in the source
# tree (WORKDIR /opt/plugins/jira/broker → ../../../broker-sdk = /opt/broker-sdk).
COPY broker-sdk/ /opt/broker-sdk/

ENV AEE_PLUGIN_PORT=4009
EXPOSE 4009

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
