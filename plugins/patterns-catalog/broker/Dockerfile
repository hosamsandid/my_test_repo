FROM node:22-bookworm-slim

# Least privilege: this broker holds NO credential and needs no host socket, no
# workspace mount, no state volume. It serves static catalog pages only.
# capabilities: [].

WORKDIR /opt/plugins/patterns-catalog/broker
COPY plugins/patterns-catalog/broker/package.json ./package.json
RUN npm install --omit=dev
COPY plugins/patterns-catalog/broker/ ./
# Broker SDK (plugin system Phase 4, #1520): the shared broker-obligations
# module. This build's context is the repo root, so broker-sdk/ is available;
# copy it to /opt/broker-sdk so server.js resolves it as ../../../broker-sdk
# both here and in the source tree (WORKDIR
# /opt/plugins/patterns-catalog/broker → ../../../broker-sdk = /opt/broker-sdk).
COPY broker-sdk/ /opt/broker-sdk/

ENV AEE_PLUGIN_PORT=4007
EXPOSE 4007
CMD ["node", "server.js"]
