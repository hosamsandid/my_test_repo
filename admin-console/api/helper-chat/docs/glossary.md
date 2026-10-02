# Glossary

Agent Studio uses a compact vocabulary, and a few words are unavoidably overloaded
(there are two different things called a "team", and two different things called an
"orchestrator"). This page is the disambiguation layer: every term in one sentence,
where you meet it in the UI, and where to read more.

**If you read only one section, read [The four collisions](#the-four-collisions).**

---

## The four collisions

These are the four places where the same word means two different things. Nearly every
newcomer misreads at least one of them.

| Word | Meaning A | Meaning B |
|---|---|---|
| **Team** | **Access scope** — the older, coarser tenant every resource is *stamped* with. No new one can be minted, and **Administration → Resources** no longer offers it as an owner (#2695) — only Agent Teams. | **Agent Team** — a squad of *agents* working one repository (agent `role: team` + its members), created by the **Team-Setup wizard**. This is what a person is given access to, and what **Share…** shares. |
| **Orchestrator** | **Orchestrator** (service) — the control-plane container that spawns and supervises every agent container. There is exactly one. | **Orchestrator** (agent role) — an agent bound to a Briefing-Pack directory that spawns one `bp-instance` per pack. |
| **Memory** | **Memory** (per agent) — the private files an agent reads and writes about *its own* work and *its* user. Never shared. | **Knowledge** (per team) — the curated, shared, searchable knowledge base a whole team draws on. |
| **Skill** | **Skill** (the files) — a folder of domain know-how in the skill pool. | **Skill grant** (the assignment) — which agent construct is actually allowed to use it. The grant lives on the *team agent*, never on an environment. |

And three names for one product — see [What is this thing called?](#what-is-this-thing-called) at the end.

---

## Core objects

### Agent
A persistent AI worker with its own chat identity, its own container, and its own
workspace. You talk to it in a private 1:1 chat; between messages it keeps a memory, so
it does not start cold every session. Under the hood each agent drives a full Claude Code
instance — it can read code, edit files, run commands, commit, and open pull requests.

*Where you meet it:* the **Agents** page, and the **Chats** page.
*Read more:* [agent-roles.md](agent-roles.md)

### Agent role
What kind of agent this is. Five values:

| Role | What it is |
|---|---|
| `agent` | A standalone agent. Answers your direct messages; with triggers it can also act on its own. |
| `team` | Not an agent you chat with — a **template + shared settings** for a squad. It holds the shared system prompt and the team's skill grant. |
| `team-member` | One actual agent spawned from a `team`. Inherits the team's prompt and skills unless it overrides them. The system prompt has three modes: **Inherit from team**, **Additional input** (team prompt + an agent-specific addition), and **Exclusive overriding input** (a full replacement, formerly "Custom"). |
| `orchestrator` | Watches a Briefing-Pack directory and creates one `bp-instance` stub per pack. |
| `bp-instance` | One agent per Briefing Pack. Exists as an inert stub until it is claimed or activated. |

*Read more:* [agent-roles.md](agent-roles.md)

### Environment
A reusable **workspace recipe**: which git repository to clone, which SSH key and GitHub
token to use for it, which MCP knowledge sources to connect, and what extra context to
append to the agent's prompt. Point several agents at one environment and they all start
from the same footing.

> **Common misconception:** an environment does **not** carry skills. Skills are
> granted on the agent construct (the team agent, or a standalone agent), not on the
> environment. This moved deliberately; if you find an older doc that says otherwise, the
> doc is stale.

*Where you meet it:* a team's own **Settings** tab in Agent Chat; the System-Admin
**Environment Templates** catalog (`/environment-templates`, #2170); step 2 of the Team-Setup
wizard.
*Read more:* [working-environments.md](working-environments.md)

### Workspace
The private directory an agent works in — its cloned repository, its seeded skills, its
memory files, its knowledge digest. One per agent, isolated from every other agent.
You can browse it read-only from the **Workspace** tab in the agent chat's right rail.

---

## Knowledge, skills, memory

These three are the most-confused trio in the product. The distinction is *who owns it*
and *how it gets into the model's context*.

| | Owned by | Scope | How it reaches the agent |
|---|---|---|---|
| **Memory** | one agent | private, never shared | files in its workspace, read as it works |
| **Skill** | the skill pool (global or per team) | granted to agent constructs | copied into the agent's workspace at seed time |
| **Knowledge** | a team | shared across the team's agents | a generated digest injected at session start, plus on-demand search |

### Skill
A portable folder of domain knowledge and procedure (`skills/<name>/SKILL.md`) — COBOL
analysis, a review checklist, a migration pattern. Adding one to an agent gives it an
expertise with no code change. Skills live in a two-tier pool:

- **Global tier** — visible to all teams, managed by a System Admin.
- **Team tier** — visible only to that team's agents, managed by a Team Admin.

Resolution is team-first, then global. A team skill can be *promoted* to global.

*Where you meet it:* the **Skills Registry** page; the **Knowledge** page.
*Read more:* [skills-system.md](skills-system.md)

### Skill grant / activation
The *grant* is which skills an agent construct is entitled to (a list on the team agent,
or on a standalone agent; a member may override it). **Activation** is the one-click
action that actually syncs those skill files into every member's workspace — because a
member spawned before a skill was added would otherwise not have the files.

*Read more:* [knowledge-skill-activation-concept.md](knowledge-skill-activation-concept.md)

### Memory
The per-agent files an agent keeps about its own work — what it learned, the running
context, and what it knows about *you*. Private to that agent and never shared or
migrated. Agents on the unified model keep three files: `context.md`, `log.md`, `users.md`.

*Read more:* [persistent-memory.md](persistent-memory.md)

### Knowledge base / knowledge digest
The team-scoped, curated, searchable store of conventions, facts and entities. The
**digest** is the guaranteed-in-context slice: a generated, human-readable file in the
agent's workspace that is imported at session start, so the team's conventions are
present without the agent having to search for them. Everything else stays searchable
on demand.

*Where you meet it:* the **Knowledge** page; the **Knowledge** tab in agent chat, where a
green `digest` badge marks entries that are guaranteed in context.
*Read more:* [knowledge-store.md](knowledge-store.md) · [knowledge-flow.md](knowledge-flow.md) · [knowledge-cli.md](knowledge-cli.md)

---

## Autonomy

### Trigger
The wiring that lets an agent act without being asked. Four kinds:

| Type | Fires when |
|---|---|
| `cron` | a recurring schedule matches (e.g. every weekday at 08:00) |
| `once` | a single future timestamp is reached |
| `http` | an external system POSTs to the agent's webhook URL with its secret |
| `github-event` | GitHub reports a matching event on the repo (PR opened, issue labeled, push) |

Triggers fire on **any** matching event, regardless of who caused it — there is no
source/origin filtering. A per-conversation rate throttle and burst digests keep a busy
repository from launching a flood of sessions.

*Where you meet it:* the **Triggers** section of an agent; the Flow editor.
*Read more:* [triggers.md](triggers.md)

### Session policy
Whether a triggered run continues the previous conversation or starts fresh.
`persistent` (default) resumes; `per-invocation` starts a clean session each time and
asks the agent to write down what it learned first. Chats always keep continuity;
a pool instance keeps one session for its triggers and chat (#2595).

### Label
A GitHub label used as a coordination signal. An agent **emits** a label to announce it
finished a stage; another agent's trigger **listens** on that label (`labelFilter`) and
wakes up. This is the primary hand-off mechanism between agents in a flow.

### Human approval gate
An edge in a flow that waits for a *person* to apply an approving label before work
flows on. No agent can emit such a label, which is exactly what makes it a gate rather
than a suggestion. Which labels are gates is **configuration, not a naming
convention** (#928): the flow's `labels[]` registry flags them `humanGate: true` (or a
GitHub channel gates its routing label with `gate: 'human'`), so a gate can carry an
ordinary action-style name like `approved-for-dispatch`.

### Brake
A label that **pauses** the automated loop pending a human decision — flagged
`brake: true` in the flow's `labels[]` registry. Unlike a gate, a brake *is*
agent-applied (e.g. a reworker setting `human-decision-required` when review
feedback is contradictory), so declaring it as an outcome is legitimate.

---

## Flows (designing a multi-agent process)

### Flow / process
A multi-agent process drawn on a canvas: who does what, in which order, and how work is
handed over. Lives in the **Flows** view.

*Read more:* [flow-connection-model.md](flow-connection-model.md)

### Connection types
The five ways two agents can be wired together:

| Connection | Meaning |
|---|---|
| **Label hand-off** | producer emits a label → consumer's trigger listens on it |
| **GitHub PR / Issue channel** | producer opens a PR or issue → consumer reacts to it (optionally gated by a human label) |
| **Data flow** | producer registers an artifact by *logical name* → consumer is woken to fetch it from git |
| **Hierarchy** | parent/child grouping, purely structural — no work flows along it |
| **Human approval gate** | an edge that waits for a person (see above) |

### Artifact
A named work product handed from one agent to another. Matched on its **logical name**,
not its path — the producer records where it actually landed in a git-committed manifest
(`.agent-studio/artifacts.jsonl`) and the consumer looks it up by name. This is why a re-runnable
agent can write to a different path each run without breaking the hand-off.

### Stage
An optional ordered grouping of nodes in a flow ("Analyse", "Build", "Review"). Stages
partition the canvas into bands and give the layout a readable left-to-right order.

### Draft
An editable process that exists **before** any agents are created. Draw it, iterate on
it, then use **Create team…** to turn it into a live team. You can also go the other
way: **Edit as draft** on a live team exports it back into an editable draft. Creating a
team does not consume the draft — the design stays reusable, and editing it afterwards
does not change the team it produced.

### Process template / bundle
A portable, git-committable JSON export of a whole process — roles with their prompts,
their wiring, gates and labels, but no repositories or secrets. Curated templates ship
with the product (`core-sdlc`, `extended-sdlc`); you can export your own and share it.

*Read more:* [process-template-format.md](process-template-format.md)

### Create team (formerly *Materialize*)
Turn a draft or template into real agents: creates the team agent and one member per
role with its prompt and triggers — in one transaction that rolls back on failure.
**Create team…** is the accent-coloured button set apart at the end of the draft
toolbar, the item in the Flows rail context menu, and the title of the dialog both
open; the launch step's own submit button has always said *Create team*. It was called
**Materialize** until #2053, which is still the wording the tooltip carries so anyone
who learned the old word can find it.

A checkbox on the launch step, **Provision agents now**, decides how far each member is
taken: ticked, every member is provisioned immediately (Matrix identity, repository
clone, running container) and gets its DM room; unticked, the members are laid out as
**stubs** — config and triggers only, nothing cloned and nothing running — and each is
provisioned when you enable it. The Team-Setup wizard ticks it by default; the canvas'
Create-team dialog leaves it off, because a process can have dozens of members.

### Materialize (a member)
The word survives for the **per-member** act, which is a different one (#1957): a stub
is listed in Agent Chat under its team's **Not materialized yet** section, and its
**Materialize** entry runs exactly the provisioning the removed Agents page's
**Activate** used to do (#1930). #2053 renamed the design → team step and deliberately
left this one alone — different surface, different act.
The same choice is offered for a single member added to a live team (#1958): Agent Chat's
**Add member…** carries its own **Materialize now** checkbox — ticked by default here,
because one member is not dozens — so a stub can also be created long after its team was.
The Flow editor's live-team **Add agent** has it unticked (#2558).

---

## People, access, credentials

### Team (human)
The tenant. Every agent, environment and credential belongs to exactly one
tenant, and it is the tenant that scopes who can see and manage what. Roles:
**System Admin** (global), **Team Admin**, **Team Member** — the latter two being
memberships in an **Agent Team** since epic #2076, which is what makes sharing
self-service.

*Where you meet it:* **Share…** on a team in the **Agent Chat** (who may see it),
and **Administration** (`/users`) for the platform-wide view — the former
**Access** page was dissolved into it by #2085.
*Read more:* [teams-data-model.md](teams-data-model.md) · [multi-user-concept.md](multi-user-concept.md)

### Model Provider
The LLM endpoint agents talk to. Either an **API key** provider (any Anthropic-compatible
gateway — the Anthropic API, a LiteLLM proxy, Azure AI Foundry, an internal gateway) or a
**Claude subscription (OAuth)** provider.

> **Compliance note:** a consumer-subscription OAuth token is licensed for the
> subscription owner's own single-user use. The UI requires an explicit confirmation of
> that before such a provider can be created.

*Read more:* [model-providers.md](model-providers.md)

### SSH key / GitHub token
Two deliberately separate credentials. The **SSH key** clones the repository (it can be a
read-only, per-repo deploy key). The **GitHub token (PAT)** does everything API-shaped —
polling events, creating PRs, commenting. Splitting them means a leaked key cannot merge
PRs, and a leaked token was not what granted repository access in the first place.

*Read more:* [credentials.md](credentials.md)

### MCP server / MCP credential
Skills are static files; **MCP servers** are how an agent queries something live — a
wiki, a vector store, a graph database. The *catalog* (which servers exist) and the
*credentials* (the tokens to reach them) are stored separately, so a token can be rotated
without touching the catalog. An environment binds the two together per agent.

*Read more:* [mcp-servers.md](mcp-servers.md)

### Audit trail
Every configuration-changing API request is appended to a per-day JSONL file — who did
what, to which resource, with what outcome. Readable in the console. Chat history is
deliberately *not* the configuration audit log.

---

## Infrastructure

### Admin Console
The browser UI on port `4000`. Everything is done here: agents, credentials,
environments, flows, knowledge, chats, logs. Sits behind a login.

*Read more:* [admin-console.md](admin-console.md)

### Conduwuit / Matrix
The self-hosted chat backbone. Every agent is a chat user; every human↔agent conversation
is a private 1:1 room hosted on your own network — no external messaging service is
involved. You can use the console's built-in chat, or point any Matrix client (e.g.
Element) at it.

### DM room
The private 1:1 room between you and one agent. Created lazily the first time you open
that agent's chat. If an agent has no DM room yet, its trigger output has nowhere to go
and the run is skipped — so open the chat once before relying on autonomy.

### Podman
The container engine the whole stack runs on. The orchestrator talks to the Podman socket
to spawn one container per agent.

### Briefing Pack (BP)
A unit of work in the ACE methodology: a directory containing a `brief.md` with status,
dependencies and artifact declarations. Relevant only if you use the `orchestrator` /
`bp-instance` roles; ignore it otherwise.

---

## What is this thing called?

You will encounter three names in this repository. They are three different layers,
and knowing which is which saves confusion:

| Name | What it names | Where you see it |
|---|---|---|
| **Agent Studio** | the **product** | the UI, the browser tab, the login screen, the README |
| **agent-studio** | the **compose project** (default container and volume name prefix) | `podman ps`, volume names, `COMPOSE_PROJECT_NAME` in `.env` |
| **`.agent-studio/`** | the **per-agent workspace state directory** | every agent's file tree (`bin/`, `plugins/`, `seeded-skills.json`, `prompt-history.json`, `artifacts.jsonl`, …) |
| **AEE** / `AEE_*` | the **internal runtime/env-var namespace** ("Agent Execution Environment") | environment variables, container labels (`aee.*`), the `io.aee.*` wire protocol, operator docs |

**The naming rule (#1549).** The retired abbreviation **"aee"** (from the old
product name "Agent Execution Environment") is no longer used for anything a user
sees. The one prominent user-visible instance — the per-agent state directory,
formerly `.aee/` — is now **`.agent-studio/`** (an upgraded agent is migrated
automatically, keeping all state). What deliberately **remains** "AEE" is purely
*internal* and not surfaced in the file tree: the `AEE_*` operator environment
variables, the `aee.*` container labels, and the `io.aee.*` agent↔console wire
keys. The `aee-…` command-line tools (`aee-artifact`, `aee-podman`,
`aee-test`, …) keep their names for now; retiring the CLI prefix is tracked
separately (a plugin-ecosystem convention decision, out of scope for the
directory rename).

When in doubt: what you *use* is Agent Studio; the folder in an agent's workspace
is `.agent-studio/`; what you *operate* is the `agent-studio` compose project (the
default `COMPOSE_PROJECT_NAME`); what you *configure* uses `AEE_*` variables.

---

*Missing a term? Open an issue — a word that needed looking up and was not here is a
documentation bug.*

← Back to the [documentation index](README.md).
