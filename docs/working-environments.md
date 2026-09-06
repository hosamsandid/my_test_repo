# Working Environments

A **Working Environment** is a reusable workspace recipe applied when an agent is created. It bundles the infrastructure an agent needs to operate: credentials, repositories, MCP servers, and a model provider. Skills are **not** part of a Working Environment — they are granted to a team or an agent (see [Skills System](skills-system.md)).

## Fields

| Field | Purpose |
|---|---|
| **Repositories** | Zero or more Git repos to clone, each with an optional SSH key binding — see [Repository-less environments](#repository-less-environments) |
| **GitHub Token** | PAT used by the GitHub poller for event-driven triggers; also authenticates HTTPS GitHub repository cloning and the real-time repo-check probe |
| **MCP Servers** | Optional server/credential references (from the MCP registry) materialised into the agent's `.claude/settings.json` at creation |
| **Model Provider** | Optional override — the agent inherits `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` from this provider rather than the global default, but only for the values the provider carries: an `api-key` provider saved without a token repoints the Base URL and leaves the global `ANTHROPIC_AUTH_TOKEN` in place, while an `oauth-token` provider clears both (see [Model Providers](model-providers.md)) |
| **Agent Toolchain** | Optional — which container image the environment's agents are spawned from, chosen from the operator toolchain registry; absent means the default image (see [Agent toolchain](#agent-toolchain)) |
| **Additional Context** | Markdown appended to the agent's `CLAUDE.md` after the environment section |

## What happens at agent creation

When a new agent is created with a Working Environment, the orchestrator:

1. Seeds `.claude/` and `memory/` from the skill-pool volume
2. Copies the agent's granted skills into the workspace (resolved team-pool-first, then global — the grant lives on the team or agent, not on the environment)
3. Clones the configured repositories — SSH repos use the bound SSH key; HTTPS GitHub repos use the environment's GitHub token
4. Materialises the environment's MCP server references into the agent's `.claude/settings.json`
5. Assembles a merged `CLAUDE.md` from the base template, the environment section, and the agent's own prompt

This means all agents in the same Working Environment share the same repository and credential access — but each gets an independent workspace and memory that evolves separately from that point on.

## Repository-less environments

A Working Environment may have **no repository** at all. Materializing a team onto
a repo-less environment creates the team and its agents normally — nothing is
cloned, and the agents run with their own workspace as the working directory
rather than a `/repo` checkout. This suits teams whose work is not tied to a
codebase (research, drafting, analysis).

The one trade-off: GitHub hand-off channels (PR / issue triggers and outcomes)
have no repository to act on, so they are unavailable for a repo-less team. Add a
repository to the environment if the team needs them. The Materialize dialog
shows an inline note when the selected environment has no repository.

## Agent toolchain

Every agent container runs one image. The default — `as-agent:latest` — carries
Python, Node, git/ssh/`gh`, the Claude Code CLI and the platform CLIs, but **no
other language runtime**: no JDK, no Maven, no .NET, no Go. An agent bound to a
Java repository can read and edit the code but cannot compile or test it.

A Working Environment may therefore name a **toolchain**: a container image
derived from the default one, adding a language stack. Agents bound to that
environment are spawned from the toolchain's image; every other environment
keeps the default, unchanged.

Two properties are worth knowing before you use it:

- **You pick from a registry, not by typing an image name.** An agent container
  receives its environment's SSH identity, its GitHub token and the model
  credential, so whoever chooses the image chooses what executes with those
  secrets. Only a **System Admin** can register a toolchain (the **Toolchains**
  button on the Working Environments page); a **Team Admin** selects an
  already-registered one. Both halves are enforced server-side, so the split
  holds regardless of what any UI shows.
- **Changing it restarts the environment's running agents.** A container's image
  is fixed for its whole lifetime, so a new toolchain reaches a running agent
  only by recreating it — exactly like repointing the environment at a different
  GitHub token. Work in flight is interrupted, so change it at a quiet moment.
  The form warns you, naming how many agents are affected.

If a selected toolchain is not registered, is not built for the runtime this
stack uses, or its image is not present/pullable, the agent **refuses to start**
with a message naming the environment and the toolchain. That is deliberate: the
alternative — quietly falling back to the default image — would bring the agent
up without its toolchain and fail confusingly later, at the first `mvn`.

### The installation-wide default: `AGENT_IMAGE`

`AGENT_IMAGE` on the orchestrator sets the image used by every agent whose
environment names no toolchain. It defaults to `as-agent:latest`; the Kubernetes
manifests set it explicitly (`deploy/k8s/base/app/40-orchestrator.yaml`, with
the test/preprod overlays pointing it at the Artifact Registry), and
`docker-compose.yml` leaves it unset so the compose stack uses the default tag.

Use it to move the *whole installation* onto a different base image. It is the
wrong tool for giving one team a language stack: repointing it moves every agent
of the installation, and a toolchain on that team's Working Environment does
exactly that job without touching anyone else.

On Kubernetes a toolchain image must exist in the registry the cluster's nodes
pull from — `AEE_AGENT_IMAGE_PULL_POLICY` and `AEE_IMAGE_PULL_SECRET` apply to
it just as to the default image. A `localhost/…` tag built on a developer
machine does not exist there, which is what a toolchain's platform list is for:
mark such an image podman-only and it is not offerable on a hosted stack.

Concept and roadmap (why the *version* of a stack belongs in the project
repository rather than in the image): [Agent
toolchains](agent-toolchains-concept.md).

## Editing a Working Environment

Changes to a Working Environment affect newly created agents only. Existing agents retain the workspace state from when they were created. To update an existing agent's skills or repositories, use the Workspace Browser in the Agent Chat right rail.
