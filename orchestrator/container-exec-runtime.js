'use strict';

// In-container exec seam (#1319) — sibling of container-runtime.js, same
// selection rule and the same seam discipline (see the note there). The
// context-mount browse/write endpoints run short commands INSIDE the agent's
// container; HOW depends on the runtime:
//
//   - `podman`     (default) — exec sessions + archive PUT over the libpod
//                  socket (container-exec.js).
//   - `kubernetes` — the pods/exec subresource over the Kubernetes API with
//                  the orchestrator's projected service-account token
//                  (pod-exec.js; needs pods/exec [create] in 10-rbac.yaml).
//
// Both implementations export execInAgentContainer / putArchiveToAgentContainer
// with identical signatures and a ContainerExecError carrying the same `code`
// vocabulary (no-container | timeout | too-large | exec-failed | read-only |
// denied | bad-argv), so orchestrator.js only ever requires this module.
const runtime = String(process.env.AEE_CONTAINER_RUNTIME || 'podman').toLowerCase();

if (runtime === 'kubernetes' || runtime === 'k8s') {
  module.exports = require('./pod-exec');
} else {
  module.exports = require('./container-exec');
}
