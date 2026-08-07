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

This was delivered in **phases**, both now implemented behind `AEE_PER_AGENT_VOLUME`
(default **off**). Phase 1 landed the push infrastructure for the two
agent-authored surfaces plus the volume-provisioning mechanism. Phase 2 migrated
the remaining control-plane-authored surfaces (triggers, pending-triggers, session
pointer/reset, config/dm-room) and added re-seed on edit, volume teardown, and the
fail-closed seed guard. The remaining step is to flip the flag on by default and
drop the agent-dir read fallbacks.

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

`AEE_PER_AGENT_VOLUME` defaults **off**: every path resolves to the pool subpath,
byte-identical to before. Phase 2 is now **complete** behind the flag — triggers,
pending-triggers, session pointer/reset, config/dm-room propagation, **re-seed on
config change, volume teardown, and the fail-closed seed guard** all work when the
flag is on (see the sections below). The flag is a safe opt-in; flip it to activate
isolation.

**One caveat — the flag is effectively one-way.** The orchestrator's
`controlOrPoolPath` is flag-gated, but the admin's `controlOrAgentPath` is
*existence-based* (prefers `/control` whenever the file exists). Run with the flag
**on** (triggers + session pointer persisted to `/control`) and later turn it
**off**, and the orchestrator writes to the pool subpath while the admin keeps
reading the stale `/control` copy. There is no migration that scrubs `/control`
back to the pool, so treat enabling the flag as a forward-only decision per stack.

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
  The agent drains **one entry at a time** via `GET /internal/agents/:id/pending-drain-one` (head-pop, tail stays durably queued on disk) when isolated, local head-pop otherwise — so a crash mid-run loses at most the single in-flight entry, never the still-queued tail. The old `/pending-drain` (read-and-clear all) is retained for compatibility but no longer used by the agent.
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

## Phase 2 — re-seed, teardown, fail-closed guard (implemented)

These were the last deferred items; they now ship behind the flag.

- **Re-seed on config change** — `reseedPerAgentVolume(id, paths)`
  (`spawn-container.js`) mirrors named paths from the pool subpath (`/src`) into
  the already-populated dedicated volume (`/dst`) without clobbering agent-written
  state (memory/, the git tree, sessions/). It's an allowlist of literal paths
  passed as `sh -c` positionals (injection-safe). Wired through `reseedAgent` (a
  no-op unless the flag is on **and** the agent is running) at every edit site:
  prompt edits (`saveAgentPrompt` → `['AGENT-PROMPT.md','CLAUDE.md']`), skill
  install (`notifyAgentReseed`), team-prompt propagation (`updateTeamPrompt`), and
  the re-enable fast-path (`enableAgent` →
  `['CLAUDE.md','AGENT-PROMPT.md','.claude/settings.json','skills']`, so an edit
  made while the agent was disabled lands on the next enable).
- **Volume teardown** — `removePerAgentVolume(id)` (idempotent; 404 = already gone)
  is wired into `deactivateAgent`, the delete route, and create-failure rollback.
  `deleteAgentFiles` additionally removes the per-agent Claude home
  (`/root/.claude/homes/<id>`, flag-gated) and — **unconditionally**, since push
  defaults on — the control-plane dir `/control/agents/<id>` so status/session
  state can't leak to a reused agent id.
- **Fail-closed seed guard** — `seedPerAgentVolume` exits non-zero (`exit 3`,
  `FATAL: /dst missing config.json after seed`) if `config.json` is absent after
  the copy, so `seedPerAgentVolume` throws and the spawn aborts **before** the
  agent container starts. An isolated agent never boots against an un-seeded or
  half-seeded volume.

Remaining before flipping the default on: align the admin resolver with the
orchestrator's flag-gating (see the one-way caveat under *Flags*) and drop the
agent-dir read fallbacks.

## Known limitations (flag ON)

- Trigger edits, pending-triggers delivery, session reset, config/dm-room edits,
  re-seed on config change, and volume teardown all reach an isolated agent now
  (Phase 2, above) — these are no longer limitations.
- The flag is effectively **one-way** within a stack: the admin resolver is
  existence-based while the orchestrator's is flag-gated, so turning the flag off
  again leaves the admin reading stale `/control` copies (see *Flags*).
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
3. Edit the agent's prompt / install a skill → the change re-seeds into the
   dedicated volume (`reseeded N path(s)` in the orchestrator log) without wiping
   memory/ or the git tree.
4. Delete the agent → its `<project>_agent-<id>` volume, `/root/.claude/homes/<id>`,
   and `/control/agents/<id>` are all gone; deactivate removes the volume and resets
   to a stub.
5. Induce a seed with no `config.json` in `/src` → the seed helper logs
   `FATAL: /dst missing config.json after seed`, exits 3, and no agent container
   starts.
