# Custom slash commands

> Status: **shipped** (foundation, #1796). Enables the UI autocomplete follow-up
> (#1797) and command toolkits such as GitHub's spec-kit as a bundle (#1798).
> Design of record for shipped behaviour.

Agent Studio agents run on **Claude Code**, which loads reusable **slash
commands** from `.claude/commands/*.md` — a saved prompt a human invokes by
typing `/name`. This document describes how such commands are provisioned into
an agent's workspace, how they are invoked from chat, and the headless
verification behind the mechanism.

## Where command files live

Command definition files land in the agent workspace under:

```
/workspace/agents/<agentId>/.claude/commands/<namespace>/<name>.md
```

Claude Code exposes a file at `.claude/commands/<ns>/<cmd>.md` as the slash
command `/<ns>:<cmd>`. This is exactly the directory Claude Code reads at
invocation time — the chat runtime invokes `claude` with the agent workspace as
both the working directory and `HOME`, so a projected command is loaded with no
further wiring.

## How the grant places them (single provisioning path)

There is **no new grant type and no per-agent ad-hoc authoring**. A command
reaches an agent only by granting a **skill that carries it** — the existing,
team-scoped skill grant machinery (`orchestrator/skill-grants.js`,
`docs/knowledge-skill-activation-concept.md`). A skill directory may ship a
`commands/` subdirectory of `*.md` definitions:

```
<skill>/
  SKILL.md
  commands/
    plan.md          # front-matter `description` optional
    review.md
```

Wherever the skill is seeded or (de)activated, its command files are **projected
into / out of** the agent's `.claude/commands/<skill>/` tree by the pure core
`orchestrator/skill-commands.js` (`readSkillCommands` / `manifestEntriesFor` /
`commandsListFromManifest`), driven from:

- **Agent creation** — `seedAgentWorkspace` / `seedAgentWorkspaceForInstance`
  project every granted skill's commands and write the manifest.
- **Grant change (no respawn)** — `_syncSkillIntoWorkspace` projects (activate)
  or removes (deactivate) a skill's command namespace as an **additive file
  sync**, exactly like the skill files themselves: the workspace volume is
  shared with the running container, so a granted command is runnable
  immediately and a revoked one disappears without restarting the agent. The
  projected `.claude/commands/<namespace>` dir and the manifest are mirrored into
  a per-agent isolated volume alongside `CLAUDE.md`.

**Namespacing per skill** (each skill's commands under
`.claude/commands/<skill-slug>/`) means two skills — or a built-in Claude Code
command — can never collide: a `plan` command from skill `spec-kit` is invoked
as `/spec-kit:plan`, never a bare `/plan`.

## Provisioning output (for the #1797 autocomplete)

Each command's optional `description` front-matter is parsed (same YAML-front-
matter parser as `SKILL.md`, `parseSkillDescription`) and carried through to a
per-agent manifest:

```
/workspace/agents/<agentId>/.agent-studio/seeded-commands.json
```

keyed by `<namespace>:<name>` → `{ skill, name, namespace, invocation,
description, file, seededAt }` (`description` is `null` when the command file has
none — a name-only command is valid). A downstream reader obtains the list via:

```
GET /api/agents/:agentId/commands
  → { agentId, commands: [ { command, name, namespace, skill, invocation, description } ] }
```

(the console proxy over the orchestrator's `GET /internal/agents/:id/commands`).

**The workspace is the source of truth (#1797).** The read endpoint enumerates
the agent's actual `.claude/commands/` tree (`scanProvisionedCommands` in
`skill-commands.js`) rather than reading the manifest alone, so a command **added
by hand** — never recorded in `seeded-commands.json` — surfaces too (with
`skill: null`). The manifest is consulted only to attribute each *seeded* command
to its originating `skill`. Layout mirrors the projector: top-level `*.md` are
un-namespaced (`/<name>`); each first-level subdirectory is a namespace
(`/<namespace>:<name>`); each command's `description` is re-parsed from the file.

## Invoking from chat

Invocation is **human chat messages only** for now. Trigger-invoked commands
(cron / GitHub / http prompts beginning with `/`) are deliberately out of scope
but not precluded — only the chat path (`on_message`) applies the handling
below; synthesized trigger prompts are untouched.

The runtime (`agent-image/scripts/agent-entrypoint.py`) recognises a provisioned
command on the chat path and records a `slash.command` session-log event
(`{ command, recognized }`) so a run is observable in the session log:

- **Known command** → the message is fed to `claude` verbatim; Claude Code
  expands the command's prompt (arguments substituted for `$ARGUMENTS`) and runs
  it.
- **Unknown `/token`** → see AC2 below.

## Headless verification (AC5/AC6)

The chat runtime invokes `claude --print --output-format stream-json …` with the
user prompt on **stdin**. Two things were verified against the real CLI in that
exact headless mode:

1. **Slash-command expansion works headlessly — no gap for AC1.** Unlike the
   built-in `AskUserQuestion` tool (which the CLI strips in `-p` mode and had to
   be re-supplied via a bundled MCP server, #1712), **file-based slash commands
   are expanded in `--print` mode**: a message `/<ns>:<cmd> [args]` on stdin runs
   the command's prompt with `$ARGUMENTS` substituted. Multi-line messages whose
   first line is a command, and arguments containing option-like characters
   (`--help`, `-x`, en-dashes), all expand correctly and never crash.

2. **The one headless gap is an unknown command — remedied for AC2.** A message
   that begins with `/` but matches **no** command makes the CLI short-circuit
   with `Unknown command: /foo` (exit 0, no crash) **without passing the text to
   the model** — so the user's message is neither run nor answered. The remedy,
   verified deterministic: the runtime prepends a single space, which turns the
   unknown-command short-circuit into ordinary plain-text processing while
   leaving a genuine command's expansion untouched. It is applied only on the
   chat path and only when the leading token is not a provisioned command, so a
   real command is byte-identical to feeding it verbatim. `/` typed mid-sentence
   is never treated as a command (only a message whose first non-whitespace
   character is `/`).

Pure decision logic is unit-tested both sides: `orchestrator/skill-commands.js`
(node:test) and the runtime helpers `_list_slash_command_tokens` /
`_leading_slash_token` / `_prepare_chat_prompt` (Python `unittest`).

## Out of scope (follow-ups)

- Trigger-invoked slash commands (deferred; the design does not preclude them).
- Composer autocomplete / discoverability UI → **#1797** (consumes the
  provisioning output above).
- Packaging a specific command set such as spec-kit → **#1798** (ships as a
  bundle carrying `commands/`, riding this same seam).
- A console authoring UI for creating/editing command files.
