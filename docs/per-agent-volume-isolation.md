# Per-agent workspace volume isolation (#185)

## Problem & goal

Today every agent shares one Podman volume (`<project>_agent-pool-workspace`).
Seam #3 already mounts each agent at its own SubPath (`agents/<id>`) so agents
can't read each other's files or the secret stores — the **read-isolation**
security goal is met. The remaining scope of #185 is **TRUE separate volumes per
agent**.

The blocker is that the orchestrator and admin-console **read per-agent state
files directly off the shared filesystem** (status, triggers, dm-room, the live
`sessions/*.jsonl` SSE stream, pending-triggers). With separate volumes those
reads break. The fix is to move monitoring to **push over HTTP** to the
orchestrator — *not* to widen the orchestrator's mounts. Push also de-risks a
future Kubernetes port, where the orchestrator cannot read a pod's local volume
across nodes.

This is delivered in **phases**. Phase 1 (this change) lands the push
infrastructure for the two agent-authored surfaces plus the volume-provisioning
mechanism (gated off). Phase 2 migrates the remaining control-plane-authored
surfaces and then flips per-agent volumes on by default.

## Data-flow direction is the cut line

| Direction | Surfaces | Phase |
|---|---|---|
| **agent → control-plane** (agent writes, orchestrator/admin read) | `status.json`, session-log `sessions/<roomId>.jsonl` | **Phase 1 — push** |
| **control-plane → agent** (orchestrator/admin write, agent reads) | `config.json`, `triggers.json`, `pending-triggers.json`, `dm-room.json`, CLAUDE.md / AGENT-PROMPT.md / `.claude/settings.json`, seeded memory/skills/repo | **Phase 2 — seed/command channel** |
| agent-authored, admin-read | session pointer `<roomId>.current.json` | Phase 2 (fold into session push) |

Status + session-log are the *only* agent-authored surfaces, which is exactly
why they are the clean Phase-1 cut.

## Phase 1 — what's implemented

### Control-plane volume

`agent-control-plane` (`docker-compose.yml`), mounted at `/control` on the
**orchestrator and admin-console only** (never on agents). Holds the pushed
copy: `/control/agents/<id>/status.json` and
`/control/agents/<id>/sessions/<roomId>.jsonl`.

### Push (agent → orchestrator)

`agent-image/scripts/agent-entrypoint.py` runs a best-effort background push
client (`_StatePushClient`, gated by `AEE_PUSH_STATE`, default **on**) hooked at
the single chokepoints:
- `_append_event` → `mark_session_dirty(roomId)`
- `_write_status` / `_write_last_response_at` → `push_status(data)`

Two orchestrator internal endpoints persist them:
- `POST /internal/agents/:id/status` — whole-file, last-writer-wins.
- `POST /internal/agents/:id/session-events` — `{roomId, baseOffset, dataB64}`.

### The byte-cursor contract (the one sharp edge)

The admin session-log SSE stream resumes by **byte offset into the file**
(`?since=<byte>`, `fs.createReadStream({start: cursor})` in
`admin-console/api/api.js`). So the control-plane copy must be **byte-identical
and same-order** to the agent's local file. Therefore:
- The agent pushes **raw file bytes** (base64 of the local file's tail from the
  last-acked offset), never re-serialized events — `JSON.stringify` whitespace
  would diverge and silently corrupt cursors.
- `/internal/agents/:id/session-events` reconciles on `baseOffset`:
  `base == cur` → append all; `base < cur` (lost-ACK retry) → append only the
  part beyond `cur`; `base > cur` (gap) → reply `{expected: cur}` and the agent
  rewinds and re-reads from its local file (the source of truth). Per-room files
  mean cross-room interleaving is a non-issue.

### Repointed reads (control-plane preferred, agent-dir fallback)

A resolver prefers the pushed copy and falls back to the agent's workspace when
absent (so it's non-breaking on the shared volume / when push is off):
`agentStatePath()` (orchestrator) and `controlOrAgentPath()` (admin-console).
- orchestrator: `/internal/agents/:id/poll`, `/session-tail`, disable +
  deactivate busy preflights.
- admin-console: `GET /api/agents/statuses`, the session snapshot
  (`GET /api/agents/:agentId/session/:roomId`) and the live SSE stream.

### Per-agent volume provisioning (gated OFF)

`orchestrator/spawn-container.js`, gated by `AEE_PER_AGENT_VOLUME` (default
**off**, explicit opt-in):
- `ensurePerAgentVolume(id)` creates `<project>_agent-<id>`.
- `seedPerAgentVolume(id)` runs a short-lived helper (the agent image, already
  present) that mounts the pool subpath `agents/<id>` (`/src`) and the dedicated
  volume (`/dst`) and `cp -a /src/. /dst/` **once** (only when `/dst` is empty,
  so respawns never clobber). `security_opt: label=disable` matches the compose
  services (no-op on macOS). Fatal on failure — never spawn against an empty
  volume.
- When on, the agent mounts the dedicated volume (no SubPath) at the unchanged
  path `/workspace/agents/<id>`.

The orchestrator still seeds the pool subpath as today; that subpath is the seed
source (effectively the staging area), so **no change to the seeding flow was
needed** in Phase 1.

## Flags

| Env | Default | Effect |
|---|---|---|
| `AEE_PUSH_STATE` | on (`!= "0"`) | agent pushes status + session-log to the orchestrator |
| `AEE_PER_AGENT_VOLUME` | off (`== "1"` to enable) | dedicated volume per agent instead of a pool subpath |

Keep `AEE_PER_AGENT_VOLUME` **off** until Phase 2 fully lands. Triggers,
pending-triggers, the session pointer/reset, and config/dm-room propagation
already work behind the flag (see *Phase 2 — implemented behind the flag*), but
re-seed on config change and volume teardown do not yet — turning the flag on now
would leave those surfaces broken for an isolated agent.

## Phase 2 — implemented behind the flag

The control→agent channel is **agent-pull**: the orchestrator owns the canonical
copy (on `/control` when `AEE_PER_AGENT_VOLUME` is on, on the pool subpath
otherwise) and the agent dials out for it — same topology as the Phase-1 push.
With the flag **off** every path resolves to the pool subpath, byte-identical to
before. Resolvers: `controlOrPoolPath()` (orchestrator, flag-gated read+write) and
`controlOrAgentPath()` (admin, existence-based, prefers `/control`).

- **session pointer `<roomId>.current.json`** — agent mirrors it to `/control`
  via `POST /internal/agents/:id/session-pointer` (reuses `_StatePushClient`,
  gated by `AEE_PUSH_STATE`). Admin reads (`hasSession`, `GET …/session/:roomId/
  current`) repointed to `controlOrAgentPath`. Reset (`DELETE …/current`) calls
  `POST /internal/agents/:id/session-reset`, which drops the mirror and — when
  isolated — enqueues a `session-reset` command so the agent clears its own
  `--resume` pointer.
- **`pending-triggers.json`** — the orchestrator now owns the queue. All writers
  funnel through `enqueuePending()`: hook server, bp-event router, github-poller
  (injected callback), and admin handover (routed through
  `POST /internal/agents/:id/enqueue-pending` so the queue stays single-writer).
  The agent drains via `GET /internal/agents/:id/pending-drain` (atomic
  read-and-clear) when isolated, local read+clear otherwise.
- **`triggers.json`** — canonical copy via `controlOrPoolPath`
  (`loadTriggers`/`saveTriggers`, both disable/deactivate preflights, hook-server
  read, github-poller subscriber scan all repointed). Agent pulls via
  `GET /internal/agents/:id/triggers` into a local cache each sync tick / on
  `SIGUSR2`; admin CRUD routes writes through `PUT /internal/agents/:id/triggers`
  (persist + `SIGUSR2`); one-shot `once` removal reports back via
  `POST …/triggers/:tid/consumed`, with an in-memory `_fired_once` guard against
  double-fire on a lagging report.
- **`config.json` / `dm-room.json`** — control-plane authored, agent-read, and
  **canonical on the pool subpath** (admin/orchestrator own them there; they're
  not moved to `/control`). The orchestrator serves its pool copies via
  `GET /internal/agents/:id/config` and `…/dm-room`; the agent refreshes its
  local cache in the same `_sync` loop (`_pull_config_dm`, every 60s / on
  `SIGUSR2`) so the existing readers (`_load_dm_agent_config`,
  `_load_dm_room_id`) work unchanged. Admin config edits and DM-room creation
  fire `notifyAgentReload` (→ `SIGUSR2`) for prompt refresh. At first
  provisioning the seed-helper's `cp -a` already copies the current
  `config.json`/`dm-room.json` into the dedicated volume, so startup reads are
  correct; the pull only covers later edits.

## Phase 2 backlog (still deferred)

- **CLAUDE.md / AGENT-PROMPT.md / `.claude/settings.json` / memory / skills / git
  clones** — with the volume flag on these are handled by the seed helper at
  provisioning time; the only Phase-2 work is **re-seed on config change**.
- **Volume teardown** — delete/deactivate currently wipes the pool subpath; with
  per-agent volumes the dedicated volume must also be removed.
- **Fail-closed guard** — `startAgentProcess` refuses to spawn unless the pool
  subpath exists; with full isolation + no pool seeding this must instead confirm
  the dedicated volume is provisioned + seeded.

When these land, flip `AEE_PER_AGENT_VOLUME` on by default and drop the agent-dir
read fallbacks.

## Known limitations (flag ON)

- Trigger edits, pending-triggers delivery, session reset, and config/dm-room
  edits now reach an isolated agent (Phase 2, above).
- The dedicated volume is not torn down on delete/deactivate yet (deferred).
- Re-seed on config change (CLAUDE.md / skills / MCP) does not yet reach an
  isolated agent — only the first provisioning seed does (deferred).
- The SSE stream resolves its file path once at connect; with the flag on, a
  brand-new room connected to before the agent's first push has no readable
  source until the first event arrives.

## Test plan

**Phase 1 non-breaking (flag OFF, push ON — the default):**
1. `make up`; activate an agent. It still mounts the shared-volume SubPath.
2. Send a DM; the admin session viewer streams live and `_cursor` advances;
   reconnect with the last `since=` → no gap/dup.
3. **Key assertion** — inside the orchestrator container:
   `cmp /control/agents/<id>/sessions/<roomId>.jsonl /workspace/agents/<id>/sessions/<roomId>.jsonl`
   → byte-identical.
4. Long task toggles `busy`→`idle` in `/api/agents/statuses`; disable-without-mode
   returns the busy warning (proves the status read repoint).
5. `AEE_PUSH_STATE=0` → fallback reads from the agent volume still work.

**Single-agent smoke (flag ON):**
1. `AEE_PER_AGENT_VOLUME=1`, activate one agent → `podman volume ls` shows
   `<project>_agent-<id>`; the seed helper exited 0; the volume contains the
   seeded `.claude/`, `memory/`, `config.json`, cloned repo; the agent mounts the
   dedicated volume (no SubPath, via `podman inspect`).
2. Send a DM → status + session-log arrive via push (the orchestrator can't read
   the isolated volume), the viewer still streams, `/api/agents/statuses` is
   correct.
3. Confirm the documented limitations (trigger/config edits don't propagate;
   volume lingers after delete).
