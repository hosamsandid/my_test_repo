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
CMD ["node", "server.js"]
