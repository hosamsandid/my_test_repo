FROM node:22-bookworm-slim

# Least privilege: this broker reaches only the external test-management system
# (egress capability) and holds the one vendor credential. No podman socket, no
# workspace mount, no other credential store.

WORKDIR /opt/plugins/test-mgmt/broker
COPY plugins/test-mgmt/broker/package.json ./package.json
RUN npm install --omit=dev
COPY plugins/test-mgmt/broker/ ./
# Broker SDK (plugin system Phase 4, #1520): the shared broker-obligations
# module. This build's context is the repo root, so broker-sdk/ is available;
# copy it to /opt/broker-sdk so server.js resolves it as ../../../broker-sdk
# both here and in the source tree (WORKDIR /opt/plugins/test-mgmt/broker
# → ../../../broker-sdk = /opt/broker-sdk).
COPY broker-sdk/ /opt/broker-sdk/

ENV TESTMGMT_BROKER_PORT=4005
EXPOSE 4005
CMD ["node", "server.js"]
