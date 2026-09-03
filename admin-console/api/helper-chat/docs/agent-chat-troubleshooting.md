# Agent Chat troubleshooting — "no reply" runbook

When a message sent in the Admin Console **Agent Chat** (or any Matrix client) gets
**no reply** from an agent, work through this runbook. The most common cause is a
**half-migrated local install**: an environment that was running the older
in-orchestrator child-process agents and was not cleanly restarted onto the
current **one-container-per-agent** model. A clean bring-up fixes that class of
problem outright.

The receive → reply path is: user message → Conduwuit → the agent's 1:1 DM room →
the agent container (`agent-image/scripts/agent-entrypoint.py` sync loop) →
`claude` CLI → reply posted back to the room. Each step below maps to that path.

---

## 0. Clean bring-up (do this first)

A fresh, consistent stack removes the most common cause (mixed old/new runtime):

```bash
make down
# Evict any leftover agent containers from a previous (possibly older) run:
podman ps -a --filter ancestor=as-agent:latest --format '{{.Names}}\t{{.Status}}'
podman rm -f $(podman ps -aq --filter ancestor=as-agent:latest) 2>/dev/null || true
make up      # builds as-agent:latest (see #182) and starts the stack
make ps
```

After `make up`:
- `podman ps` shows fresh `conduwuit`, `orchestrator`, `admin-console`.
- Enabling an agent starts its container **without** sending a message (containers
  start eagerly — see #184). Confirm: `podman ps` lists a container labelled
  `aee.agent.id=<id>` shortly after enable.
- There should be **no** leftover agent processes from the old in-orchestrator model.

The orchestrator also evicts stale `as-agent` containers on startup
(`evictStaleAgentContainers`), so a restart self-heals most drift.

---

## 1. Is the agent container running?

```bash
podman ps --filter ancestor=as-agent:latest
podman logs <container> | tail -100
```

Look for a crash on startup. The entrypoint **fails fast** if required env is
missing:

```
ERROR: missing required env vars: AGENT_ID, MATRIX_ACCESS_TOKEN, MATRIX_BOT_USER_ID, MATRIX_HOMESERVER
```

If you see that, the agent's `config.json` token wasn't injected — re-enable the
agent (which re-materializes it) or check the orchestrator logs for the spawn.

## 2. Can the agent reach Conduwuit?

A persistent sync failure means the agent can't reach the homeserver. The log
now **names the homeserver URL** on the first failure and periodically after:

```
[Runner:<id>] sync error (x1) against http://<project>-conduwuit:6167: <err> — check Conduwuit reachability/DNS from this container
```

This is usually a **per-agent-network (Seam #2)** issue: agents run on an
isolated network where the bare service name `conduwuit` is rewritten to the full
container name `<project>-conduwuit` (`orchestrator/spawn-container.js`). Check:

```bash
podman exec <container> getent hosts <project>-conduwuit   # DNS resolves?
podman exec <container> sh -c 'echo > /dev/tcp/<project>-conduwuit/6167 && echo reachable'
```

If DNS fails, the per-agent network didn't get Conduwuit connected — restart the
orchestrator (it re-runs the connect-with-retry), or set `AEE_PER_AGENT_NETWORK=0`
to fall back to the shared compose network while diagnosing.

## 3. Is the model id configured?

A blank/invalid model id is a prime suspect. The agent now logs the resolved
model on every invocation:

```
[Runner] claude invoke: model=<id> | (CLI default — AGENT_DEFAULT_MODEL unset), resume=...
```

Resolution order: `config.json.modelOverride` → `AGENT_DEFAULT_MODEL` (set from the
environment's LLM endpoint binding, else `.env`'s `ANTHROPIC_DEFAULT_SONNET_MODEL`).
If it logs `(CLI default — AGENT_DEFAULT_MODEL unset)` and you get no reply, set a
model on the agent's working-environment LLM endpoint, or `ANTHROPIC_DEFAULT_SONNET_MODEL`
in `.env`. Verify the endpoint is reachable and the model exists:

```bash
podman exec <container> sh -c 'curl -s -H "Authorization: Bearer $ANTHROPIC_AUTH_TOKEN" $ANTHROPIC_BASE_URL/models | head'
```

Auth/model/connection errors from `claude` are **posted to the room** and logged
as `[Runner:<id>] Error: ...` — they are no longer silent.

## 4. Empty reply (looks like silence)

If `claude` exits cleanly but produces no text, the agent now posts a visible
fallback instead of a blank bubble, and logs:

```
[Runner:<id>] Claude returned no text — posting fallback notice (check model id / container logs)
```

Seeing that notice in chat (rather than nothing) confirms the receive→invoke path
works and points you at the model/run config.

## 5. DM-room / readiness

The 1:1 DM room is created with the **agent's** token, so the agent is the room's
creator/member (it never depends on an invite for its own DM room). The room is
**pre-created at create/enable time** (#184), so the agent's sync loop already has
it in context before your first message. If a message is still ignored, check:

- The room has **exactly 2 members** (agent + you). The DM heuristic requires this;
  a third member makes the agent ignore the room.
  ```bash
  curl -s -H "Authorization: Bearer $MATRIX_ACCESS_TOKEN" \
    http://localhost:${CONDUWUIT_PORT:-8448}/_matrix/client/v3/rooms/<roomId>/joined_members
  ```
- The message timestamp is **after** the container start (older history is skipped
  by design). Resend after the agent is up.
- The agent isn't mid-turn: `[Runner:<id>] Busy — dropping direct message` means it's
  still processing a previous message — wait for `Posted direct response`.

## 6. Key log lines to grep

```bash
podman logs <container> 2>&1 | grep -E \
  "Direct message|Posted direct response|claude invoke: model|sync error|Busy — dropping|no text|Error:"
```

| Line | Meaning |
|---|---|
| `Direct message (N chars)...` | message reached `on_message` |
| `claude invoke: model=...` | invocation started; shows resolved model |
| `Posted direct response (N chars)` | reply sent ✅ |
| `Claude returned no text — posting fallback` | empty output guarded |
| `sync error (xN) against <url>` | can't reach Conduwuit — see §2 |
| `Busy — dropping direct message` | still processing a prior turn |
| `Error: ...` | claude/matrix error (also posted to the room) |

If `Direct message` never appears for your message, the agent never received it —
focus on §1 (container up), §2 (Conduwuit reachable), and §5 (room membership /
timestamp). If `Direct message` appears but `Posted direct response` does not,
focus on §3 (model) and §4 (empty output) — the error is in the log and chat.
