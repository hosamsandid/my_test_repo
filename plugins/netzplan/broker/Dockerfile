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
CMD ["node", "server.js"]
