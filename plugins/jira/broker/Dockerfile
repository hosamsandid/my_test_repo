FROM node:22-bookworm-slim

# The Jira broker holds a credential ({siteUrl, email, apiToken} — pushed
# per-scope by the orchestrator in Phase 1, read from env for the Phase-0 spike;
# never baked in) and reaches Jira Cloud (capabilities: ["egress"]). It needs no
# host socket and no workspace mount — only its own state volume
# (AEE_PLUGIN_STATE_DIR: watch configs, poll cursors, the per-scope event inbox),
# the audit volume, and Jira's REST API. No third-party dependencies (Node's
# built-in http + global fetch), so there is nothing to `npm install`.

WORKDIR /opt/plugins/jira/broker
COPY plugins/jira/broker/package.json ./package.json
# The whole broker dir, INCLUDING a gitignored broker/.env.local if the operator
# created one for a Phase-0 spike — server.js loads it at startup so the sandbox
# credential reaches the sidecar with no per-scope store yet (README "Phase 0").
COPY plugins/jira/broker/ ./
# Broker SDK: the shared broker-obligations module. This build's context is the
# repo root, so the sibling broker-sdk/ is available; copy it to /opt/broker-sdk
# so server.js resolves it as ../../../broker-sdk both here and in the source
# tree (WORKDIR /opt/plugins/jira/broker → ../../../broker-sdk = /opt/broker-sdk).
COPY broker-sdk/ /opt/broker-sdk/

ENV AEE_PLUGIN_PORT=4009
EXPOSE 4009
CMD ["node", "server.js"]
