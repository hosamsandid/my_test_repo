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
// THE SPAWN SIGNATURE CARRIES THE IMAGE (#1940). Until #1940 it did not, so
// neither implementation could be told which image to use and both read a
// process-wide `AGENT_IMAGE` constant — meaning a toolchain for one team could
// only be given to EVERY agent of the installation. The seam is now
//
//   spawnContainer({ id, env, contextMounts, image, toolchain, memoryLimit })
//
// where `image` is REQUIRED and resolved by the caller (orchestrator.js, via
// the pure orchestrator/toolchain-registry.js `resolveAgentImage` — Working
// Environment → toolchain id → image, falling back to the runtime's
// DEFAULT_AGENT_IMAGE), and `toolchain` is the non-default image's
// {toolchainId, environmentId, environmentName} context, used only to word the
// "that toolchain's image is missing" refusal. Neither implementation may
// re-derive the image: a silent fallback to the default would boot a build agent
// without its toolchain and fail confusingly at the first build command. Both
// therefore also export DEFAULT_AGENT_IMAGE so the resolver reads the default
// from the active runtime rather than duplicating the env-var lookup.
//
// `memoryLimit` (#2813) is the role's own memory requirement, already
// clamped to the operator ceiling; both runtimes let it win over the
// toolchain's `resources.memoryLimit` and the fleet default.
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
