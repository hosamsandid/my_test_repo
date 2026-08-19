# podman-sandbox — plugin #1

Governed container sandbox (epic #1516, Phase 3, #1519). A granted agent spawns
and manages its own compose stacks through a privilege-holding **broker
sidecar** instead of touching the host Podman socket directly. This is PR
#1287's `podman-mcp` broker reworked onto the plugin machinery (Phases 1–2):

- **Manifest** (`plugin.json`) — validated by `admin-console/api/plugin-manifest.js`:
  - `sidecar.capabilities: ["podman-socket"]` — the broker mounts the libpod
    socket; the agent container never does.
  - `scopes: ["team", "agent"]` with `defaultScopeGranularity: "agent"` — the
    §10 default-granularity decision. A sandbox reads most naturally as
    per-agent (an adversarial tester and a developer of one squad each drive
    their own stack, no shared teardown), so the grant defaults to `agent`.
  - `quota: { maxObjects, ttlSeconds }` — the per-scope resource cap (§4.6),
    replacing #1287's single platform-wide container cap.
  - `platforms: ["podman"]` — no libpod socket on GKE.

- **CLI facade** (`bin/aee-podman.py`) — dependency-free single file (contract
  §4.5). It replaces #1287's raw `podman-mcp-cli.py <tool> '<json>'` RPC and
  the stdio proxy with domain verbs:

  ```
  aee-podman run docker.io/library/hello-world  # one container, no compose file
  aee-podman compose up -f compose.yml     # bring up a stack, scoped to you
  aee-podman ps                            # containers you own
  aee-podman logs my-service --tail 50
  aee-podman compose down
  aee-podman whoami                        # resolved scope identity
  ```

  `run <image> [--name n] [--env K=V]… [--project p] [-- command…]` is pure CLI
  sugar: it synthesises a one-service compose document and sends it through the
  same `compose up` path, so it inherits validation, network isolation, resource
  ceilings, owner labels, project scoping, quota and teardown for free (no new
  broker tool). Because every sandbox network is forced `internal: true`, a
  `run` container has no outbound network (image pulls still happen host-side).
  For more than one service, ports or volumes, write a `compose.yml` instead.

  Exit codes: `0` ok / `1` broker/domain error / `2` usage / `3` broker
  unreachable (incl. not-granted). It reads its endpoint + per-scope token
  from `.agent-studio/plugins/podman-sandbox.json` (0600, written by `plugin-sync.js`)
  and speaks to the broker over the same Streamable-HTTP transport #1287 used.

- **Broker sidecar** (`./broker/`, historically `podman-mcp/`) — kept nearly
  unchanged from #1287: every container it creates is stamped with the caller's
  `aee.plugin.owner=<scopeId>` label, so two scopes sharing one broker never see
  or operate on each other's containers. Built into the sidecar image the
  manifest names (`localhost/aee-plugin-podman-sandbox:latest`) from
  `broker/Dockerfile` (build context = repo root).

## What lands in this PR vs. the live stack

Following the Phase 1/2 discipline, this PR ships the pure, decidable,
unit-tested surface: the manifest, the `aee-podman` CLI facade, the manifest
`quota` + `defaultScopeGranularity` fields, and the granularity decision. The
remaining live-stack wiring — the broker verifying the plugin scope-token and
enforcing the per-scope manifest quota, the orchestrator sidecar lifecycle +
socket mount + token mint, and retiring the #1287 global-cap Settings toggle —
is the completion step, exercised on a real Podman stack (the same split as
Phases 1 and 2).
