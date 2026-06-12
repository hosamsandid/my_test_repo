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

Keep `AEE_PER_AGENT_VOLUME` **off** until Phase 2 lands — separating the volume
while the control→agent surfaces still read the shared filesystem would break
trigger CRUD, pending-triggers delivery, and config propagation.

## Phase 2 backlog (deferred)

Each still reads/writes the agent volume directly; isolating the volume requires
a control→agent channel first.

- **`triggers.json`** — admin CRUD (`api.js`: `POST/PUT/DELETE
  /api/agents/:id/triggers...`), admin read (`GET /api/agents/:id`), orchestrator
  disable/deactivate preflight reads, agent reads (`agent-entrypoint.py`
  `_load_triggers`). Needs a control→agent push/command + the orchestrator owning
  the canonical copy.
- **`pending-triggers.json`** — the multi-writer queue: github-poller
  (`github-poller.js` enqueue + throttle), admin handover
  (`api.js POST /api/teams/:teamId/handover`), hook server
  (`orchestrator.js POST /hooks/:agentId/:hookId`); drained by the agent. The
  hardest item — make the orchestrator own the queue and deliver to the agent.
- **`config.json` / `dm-room.json`** — control-plane authored, agent-read: needs
  a seed/command channel to the isolated agent.
- **session pointer `<roomId>.current.json`** — agent-authored, admin-read: fold
  into the session push channel.
- **CLAUDE.md / AGENT-PROMPT.md / `.claude/settings.json` / memory / skills / git
  clones** — with the volume flag on these are handled by the seed helper at
  provisioning time; the only Phase-2 work is **re-seed on config change**.
- **Volume teardown** — delete/deactivate currently wipes the pool subpath; with
  per-agent volumes the dedicated volume must also be removed.

When all of the above land, flip `AEE_PER_AGENT_VOLUME` on by default and drop
the agent-dir read fallbacks.

## Known Phase-1 limitations (flag ON)

- Admin-side trigger/config edits do not reach an isolated agent (Phase 2).
- The dedicated volume is not torn down on delete/deactivate yet (Phase 2).
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
