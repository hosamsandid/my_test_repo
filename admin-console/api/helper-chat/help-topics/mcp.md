---
id: mcp
routes: ["/mcp"]
title: MCP Servers
summary: A catalog of Model Context Protocol backends, a separate store for their secrets, and a Working Environment that pairs the two — substituted into each agent's own config at seed time.
seeAlso:
  - { label: "Working Environments", to: "/environments" }
  - { label: "Agents", to: "/agents" }
  - { label: "Knowledge", to: "/knowledge" }
  - { label: "Plugins", to: "/plugins" }
askPrompts:
  - "What is the ${credential} placeholder and when is it substituted?"
  - "Why does a server show required in the Credential column?"
  - "Where do I bind a credential to an MCP server?"
  - "I rotated a secret — do existing agents pick up the new one?"
  - "stdio, http or sse — which fields does each transport need?"
  - "Why can't I delete this server?"
---

## What this page configures

**Model Context Protocol (MCP)** servers are runtime knowledge sources and tools
— a wiki, a vector store, a graph or SQL database, an internal REST API, any CLI
wrapped as a server — that agents can query during a session, in addition to the
files in their workspace.

It is a **three-part model**, and this page owns the first two parts:

| Part | Where | What it holds |
|---|---|---|
| **Server** | this page, *Servers* | *How* to reach a backend: transport, command or URL, and a template for its environment variables / HTTP headers. The template marks where a secret goes with the `${credential}` placeholder — it never contains the secret itself. |
| **Credential** | this page, *Credentials* | The raw secret (API token, bearer token, …), stored separately under its own id. |
| **The pairing** | a **Working Environment** | Which credential is bound to which server for the agents created from that environment. |

Splitting the catalog from the secrets is the point: the same server entry can be
paired with a different credential per environment, and a token can be **rotated
without touching the catalog**.

## The `${credential}` placeholder and the *required* status

Write `${credential}` into any value of a server's template — the environment
template for `stdio`, the headers template for `http`/`sse`:

```
WIKI_BASE_URL=https://wiki.example/api
WIKI_TOKEN=${credential}
```

The **Credential** column then shows **required** for that server. That status is
**derived from the template on every read, never set by hand**: the API reports
`requiresCredential` for any server whose template references the placeholder, so
it flips the moment you save a template that uses it, and there is no checkbox to
get out of sync with.

*required* is a reminder that agents cannot use this server until an environment
binds a credential to it — it does not block saving the server.

## What happens at workspace seed time

When an agent's workspace is created, the orchestrator walks the environment's
server/credential pairs and, for each one:

1. reads the server entry and the bound secret,
2. replaces every `${credential}` occurrence in the template with that secret,
3. writes the resulting stanza into **that agent's own `.claude/settings.json`**,
   under `mcpServers.<server id>`.

The file is **merged, not replaced** — other settings the agent already has
survive, and each server is keyed by its id. Every agent gets its own
substituted copy, so two agents sharing one server entry can hold different
secrets.

If the template uses `${credential}` but **no credential is bound**, that single
key is **dropped** — the literal placeholder is never written into a workspace —
a warning is recorded in the seed log, and the agent is still created. The server
is present but unauthenticated, so calls to it fail at runtime with no hint
inside the container. The reverse case (a credential bound to a template that
never mentions the placeholder) is also just a warning: the credential is
ignored.

## Transports

| Transport | Reaches the backend by | Required | Template |
|---|---|---|---|
| `stdio` | spawning a local subprocess | `command` (plus optional `args`) | **environment variables** (`KEY=value`, one per line) |
| `http` | a remote streamable-HTTP endpoint | `url` | **HTTP headers** (`Header: value`, one per line) |
| `sse` | a remote Server-Sent-Events endpoint | `url` | **HTTP headers** |

The two shapes are **mutually exclusive**: sending `url`/`headers` for a `stdio`
server, or `command`/`args`/`env` for an `http`/`sse` one, is rejected rather
than silently stored — keys the seed step would never propagate should not look
saved.

## Where the pairing is made

The pairing lives on the **Working Environment** record as a list of
*server + optional credential* references, and it is what the seed step reads.
Note where it is visible today:

- The **Agent Team wizard** shows the inherited pairs read-only in its Knowledge
  step ("Knowledge sources") and again on the review step.
- A single `team-member` agent can **override** the inherited list on the Agents
  page (*MCP Servers* → Custom, one `serverId[:credentialId]` per line).
- The Working Environments **form does not currently expose a picker**, so an
  environment's pairs are set through the API or when a team is created.

The **Default server** field on a credential is a *hint only* — a note about
what the secret belongs to. It does not create a pairing; an environment may
pair the credential with any compatible server.

## Secrets: what is stored and what is readable

A credential's secret is written to its own file under
`/workspace/mcp-credentials/_keys/<id>` with owner-only permissions. The API
**never returns it** — the list shows only a **fingerprint** (a short hash) so
you can tell two credentials apart and confirm which one you uploaded, and there
is no reveal or preview.

There is no in-place edit: to rotate a secret, add the new credential and
re-point the environment at it.

Two consequences worth knowing: the substituted secret ends up **in plaintext
inside each agent's workspace** (that is what the agent's CLI reads at startup),
and the credential store is **global** — any operator who can manage
environments can bind any credential to any server. Treat MCP credentials as
production secrets accordingly.

## Changes reach agents at their next start

Substitution happens **once, at seed time**. Editing a server template, adding a
credential or changing an environment's pairs does **not** reach into the
workspaces of agents that already exist — those keep the config they were seeded
with. New agents pick the change up; an existing agent picks it up when its
workspace is re-seeded.

Registered servers become available to an agent **on its next invocation**, not
inside a session that is already running.

## Deleting

Neither a server nor a credential can be deleted while a Working Environment
still references it — the delete is refused and names the environment that is
holding it. **Detach it there first**, then delete.
