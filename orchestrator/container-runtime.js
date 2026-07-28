'use strict';

// Container-runtime seam. The orchestrator spawns one container per agent; HOW
// that container is created depends on where the stack runs:
//
//   - `podman`     (default) — local/VM stack, containers created over the
//                  libpod socket mounted into this container.
//   - `kubernetes` — the stack runs as pods; each agent becomes an agent Pod
//                  created through the Kubernetes API with the orchestrator's
//                  projected service-account token. No host socket is mounted.
//
// Both implementations export the SAME five functions with the same signatures
// (spawnContainer, libpodRequest, removePerAgentVolume, removePerAgentNetwork,
// reseedPerAgentVolume), so orchestrator.js is runtime-agnostic and only ever
// requires this module.
const runtime = String(process.env.AEE_CONTAINER_RUNTIME || 'podman').toLowerCase();

if (runtime === 'kubernetes' || runtime === 'k8s') {
  module.exports = require('./spawn-kubernetes-pod');
} else {
  module.exports = require('./spawn-container');
}
