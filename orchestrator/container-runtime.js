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
// requires this module. The in-container exec surface (context browse/write)
// has its own selector, container-exec-runtime.js, with the same rule.
//
// SEAM DISCIPLINE (#1319): Kubernetes is the target architecture; Podman is
// the local dev runtime. A new spawn-path feature must land on BOTH
// implementations in the same change — or be explicitly recorded as
// runtime-specific in the "Deliberate differences" block of
// spawn-kubernetes-pod.js. A feature that exists on one side and is neither
// implemented nor listed there is drift (that is how context mounts stayed
// Podman-only for three tickets). Never require('./spawn-container') or
// require('./spawn-kubernetes-pod') directly from orchestrator.js.
const runtime = String(process.env.AEE_CONTAINER_RUNTIME || 'podman').toLowerCase();

if (runtime === 'kubernetes' || runtime === 'k8s') {
  module.exports = require('./spawn-kubernetes-pod');
} else {
  module.exports = require('./spawn-container');
}
