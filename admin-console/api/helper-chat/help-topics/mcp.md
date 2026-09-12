---
id: mcp
routes: ["/mcp"]
title: MCP Servers
summary: A catalog of Model Context Protocol backends, a separate store for their secrets, and an environment that pairs the two — substituted into each agent's own config at seed time.
seeAlso:
  - { label: "Environment Templates", to: "/environment-templates" }
  - { label: "Agent Chat", to: "/chats" }
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

## The three-part model

**Model Context Protocol (MCP)** servers are runtime knowledge sources and tools
— a wiki, a vector store, a graph or SQL database, an internal REST API, any CLI
wrapped as a server — that agents can query during a session, in addition to the
files in their workspace.

Reaching one takes three separate pieces, and this page owns the first two:

| Part | Where | What it holds |
|---|---|---|
| **Server** | this page, *Servers* | *How* to reach a backend: transport, command or URL, and a template for its environment variables / HTTP headers. The template marks where a secret goes with the `${credential}` placeholder — it never contains the secret itself. |
| **Credential** | this page, *Credentials* | The raw secret (API token, bearer token, …), stored separately under its own id. |
| **The pairing** | an **environment** | Which credential is bound to which server for the agents created from that environment. |

Splitting the catalog from the secrets is the point of the **three-part model**:
the same server entry can be paired with a different credential per environment,
and a token can be **rotated without touching the catalog**. It is also why
nothing on this page alone makes a server reachable — a server and a credential
sitting side by side here are still unpaired until an environment names them
together.

The two tables show what each part looks like once saved. A server row lists its
id, name, transport, the command or URL it resolves to, and whether it needs a
credential; a credential row lists its id, name, its *Default server* hint, its
**fingerprint** and when it was added. Neither table has an edit action: an entry
is created and deleted, and a change of secret is a new credential (see below).

## The server registry and its transports

**New server** opens the create form. *Name* is the label operators read; the
*ID* is auto-derived from it and is the key the seeded config uses, so it is
worth keeping recognisable. *Description* is free text for whoever comes next.

**Ownership is not chosen on this form.** A server's visibility — team-owned,
or reachable by every team once published **global** below — is derived from
the owning team rather than picked at creation. Registering a server still
needs **Team Admin** rights over the team it is created in; publishing one as
global is System-Admin-only. Unlike environments, this page has **no**
surface at all yet for moving an existing server between teams or into a
shared tier after creation — an ownership-less create resolves to an
unassigned system tier (invisible until published global) rather than any
particular team; that is a stated, tracked limitation, not an accident.

**Global is set on this form at creation only.** Once a server is created
global, retracting or re-publishing it is still possible — a System Admin does
it through the API (`PUT /api/mcp-servers/:id`), not on this page — so an
operator who creates one global by mistake is never stuck deleting and
re-creating it, which would break every environment's pairing and every
already-seeded agent's config.

*Transport* is the decision the rest of the form follows, and the three options
need different fields:

| Transport | Reaches the backend by | Required | Template |
|---|---|---|---|
| `stdio` | spawning a local subprocess | `command` (plus optional `args`, one per line) | **environment variables** (`KEY=value`, one per line) |
| `http` | a remote streamable-HTTP endpoint | `url` | **HTTP headers** (`Header: value`, one per line) |
| `sse` | a remote Server-Sent-Events endpoint | `url` | **HTTP headers** |

The two shapes are **mutually exclusive** on the wire: sending `url`/`headers`
for a `stdio` server, or `command`/`args`/`env` for an `http`/`sse` one, is
rejected rather than silently stored — keys the seed step would never propagate
should not look saved. The form switches fields with the transport for exactly
that reason, so you cannot fill in both halves by hand.

The template is the last field, and it is where the secret slot is marked. Write
`${credential}` into any value:

```
WIKI_BASE_URL=https://wiki.example/api
WIKI_TOKEN=${credential}
```

Values without the placeholder are passed through unchanged, so a template can
mix plain configuration and one secret. Nothing here is validated against the
backend — a saved server is a claim about how to reach it, and the first real
test is an agent calling it.

## The credential store and `${credential}` substitution

**New credential** stores one secret. *Name* is a descriptive label, the *ID* is
auto-derived and becomes the filename the secret is written to, and *Secret* is
the value itself — pasted once. It is written to its own file under
`/workspace/mcp-credentials/_keys/<id>` with owner-only permissions (mode 0600)
and the API **never returns it**: the list shows only a **fingerprint** (a short
hash) so you can tell two credentials apart and confirm which one you uploaded.
There is no reveal, no preview and no in-place edit — to rotate a secret, add
the new credential and re-point the environment at it, then delete the old one.

The optional *Default server* field is a **hint only** — a note about what the
secret belongs to. It creates no pairing and nothing at seed time reads it; an
environment may pair the credential with any compatible server.

The *Credential* column on the Servers table is where the two halves meet. A
server shows **required** there when its template references `${credential}` —
that status is **derived from the template on every read, never set by hand**
(the API computes `requiresCredential` for any server whose template mentions
the placeholder), so it flips the moment you save a template that uses it, and
there is no checkbox to get out of sync with. *required* is a reminder that
agents cannot authenticate to this server until an environment binds a
credential to it; it does not block saving the server.

Two consequences worth knowing before you store production tokens here: the
substituted secret ends up **in plaintext inside each agent's workspace** (that
is what the agent's CLI reads at startup), and the credential store is
**global** — any operator who can manage environments can bind any credential to
any server.

## Environment pairing and the seed-time merge

The pairing lives on the **environment** record as a list of
*server + optional credential* references, and that list is what the seed step
reads. When an agent's workspace is created, the orchestrator walks the pairs
and, for each one, reads the server entry and the bound secret, replaces every
`${credential}` occurrence in the template with that secret, and writes the
resulting stanza into **that agent's own `.claude/settings.json`** under
`mcpServers.<server id>`.

The file is **merged, not replaced** — other settings the agent already has
survive, and each server is keyed by its id. Every agent gets its own
substituted copy, so two agents sharing one server entry can hold different
secrets.

Three cases are worth knowing:

- If the template uses `${credential}` but **no credential is bound**, that
  single key is **dropped** — the literal placeholder is never written into a
  workspace — a warning is recorded in the seed log, and the agent is still
  created. The server is present but unauthenticated, so calls to it fail at
  runtime with no hint inside the container.
- The reverse (a credential bound to a template that never mentions the
  placeholder) is also just a warning: the credential is ignored.
- If the named server is missing from the registry, or its bound secret cannot
  be read, that pair is skipped entirely with a warning and the server does not
  appear in the agent's config at all.

Substitution happens **once, at seed time**. Editing a server template, adding a
credential or changing an environment's pairs does **not** reach into the
workspaces of agents that already exist — those keep the config they were seeded
with. Only agents seeded afterwards pick the change up, and an existing agent
picks it up when its workspace is re-seeded. Even for an agent that has the
config, a newly registered server becomes available on its **next invocation**,
not inside a session that is already running.

Note where the pairing is visible today:

- The environment **form pairs them directly**: an *MCP servers*
  section on the create/edit form adds, edits and removes `{server, credential}`
  rows, and warns about a missing-credential or unused-credential pair as you
  choose it. Because the pair is substituted at seed time, that form also states
  that a change reaches only agents created afterwards.
- The **Agent Team wizard** shows the inherited pairs read-only in its Knowledge
  step ("Knowledge sources") and again on the review step.
- A single `team-member` agent can **override** the inherited list on its own
  agent form (*MCP Servers* → Custom, one `serverId[:credentialId]` per line).

## Deleting a server or a credential

Neither a server nor a credential can be deleted while an environment
still references it. The delete is refused by the server — not merely
discouraged in the dialog — and the message names the environment that is
holding it. **Detach it there first**, then delete.

The refusal names one environment even when several hold the same entry, so a
second attempt can surface a different name; repeat until it succeeds. Deleting
a credential also needs rights over the team that owns it — and so does deleting
a **server**: registering, editing and deleting a server now require **Team
Admin** rights over the server's owning team, where previously any signed-in user
could do so.

Deleting either one changes nothing in the workspaces of agents that were
already seeded — they keep the stanza they were given, secret included, until
they are re-seeded.
