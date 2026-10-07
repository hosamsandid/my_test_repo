# Built-in CLI contract

Agents reach the platform through a small set of **built-in CLIs** baked into
the agent image (`agent-image/scripts/`) and always on `PATH`:

| CLI | What it does |
|---|---|
| `knowledge` | Record and query the shared team Knowledge Base |
| `aee-artifact` | Register / resolve mission artifacts by logical name |
| `aee-emit` | *Deprecated shim (#2578), removed next release* — applies a label on an issue / PR; use `gh … --add-label` instead |
| `gh-as-agent` | Do git / GitHub actions stamped with this agent's identity |
| `aee-ask` | Put a structured decision to the human and pause the turn (quick-reply card) |
| `aee-wait-ci` | Wait in the foreground, bounded, for a pull request's CI and merge status (#2796) |

These stay **baked into the image** — they are flow primitives, never
toggleable plugins (see `plugin-system-concept.md` §7). What they *do* share
with plugin CLIs is **one contract**: the same shape an agent (or a test)
can rely on regardless of which CLI it is calling. This is the "one contract,
two provenances" rule of `plugin-system-concept.md` §4.5, applied to the
built-ins.

A machine-checkable conformance test lives at
`agent-image/scripts/test_cli_contract.py`.

## The uniform pattern

### 1. Naming

Lower-case, hyphenated, single word or `aee-<verb>` for the AEE flow
primitives. Each CLI is a single dependency-free file runnable against the
runtimes already in the agent image (`python3`, `bash` + `curl`) — no compiled
binaries, no `pip`/`npm` installs.

### 2. Discovery — `--help`

Every CLI responds to `--help`, `-h`, `help`, **and a bare invocation** by
printing its complete, agent-readable documentation to **stdout** and exiting
`0`. The help text names every subcommand and its options — an agent never has
to read the source to learn how to call it.

```bash
knowledge --help
aee-artifact            # bare invocation prints the same help
gh-as-agent -h
```

### 3. Output — `--json`

Every data-returning subcommand accepts `--json` and then prints a single
machine-readable JSON object (or, for inherently list-shaped output like
`aee-artifact list` / `knowledge search`, one JSON object per line) to
**stdout**. Human-oriented status and progress go to **stderr**, so `--json`
stdout is always clean to parse.

```bash
aee-artifact path "Functional Design" --json   # {"artifact": "...", "path": "..."}
knowledge add fact "…" --json                   # the recorded entry
gh-as-agent pr --title "…" --json               # the orchestrator's result object
```

Pure side-effecting git primitives that return nothing meaningful
(`gh-as-agent commit`, `gh-as-agent stamp`) are exempt — they pass their output
through unchanged.

### 4. Exit codes

One vocabulary across all of them:

| Code | Meaning |
|---|---|
| `0` | Success |
| `1` | **Domain error** — the command was well-formed but the operation could not complete (no such artifact, no search match, a local write/commit failed, not inside a git repo, the backend was reachable but rejected the request) |
| `2` | **Usage error** — bad or missing arguments, an unknown subcommand, or a missing required precondition such as `AGENT_ID` |
| `3` | **Backend unreachable** — the orchestrator could not be reached, so the effect did **not** happen (the hand-off was not delivered, nothing was pushed). Distinct from `1` so a caller can tell "rejected" from "never arrived" |

`aee-wait-ci` extends this vocabulary with one code per verdict, because its
result *is* the verdict: `0` passed / no CI · `4` failed · `5` conflict ·
`6` timeout (`1` = error such as no token or a closed PR, `3` = GitHub
unreachable, `2` = usage, as above). It always prints its JSON result, `--json`
or not. Its verdict rules are read from `pr-readiness-rules.json` next to the
script — shared data, not a dependency. When a wait really starts it appends
one `{"kind":"ci-wait",…}` line to `$AEE_STATUS_FILE` (if set), from which the
runtime posts a single chat status note (#2841); a write failure is ignored.

When `--json` is set, errors are reported as `{"ok": false, "error": "…"}` on
stdout with the matching exit code, so a JSON caller never has to scrape
stderr.

> `knowledge add` treats a **failed push** as a soft warning: the entry is
> recorded and committed locally and shared on the next successful push, so it
> still exits `0` and prints the warning to stderr. This is deliberate — a
> transient orchestrator blip must never lose a recorded lesson.

## Relationship to plugin CLIs

Plugin CLIs (seeded into `.agent-studio/bin/`, see `plugin-system-concept.md` §4.5)
follow the **same** four rules, plus two that only apply to them: submit→poll
for long-running operations, and a `0600` config/identity file at
`.agent-studio/plugins/<id>.json`. An agent therefore learns the calling convention
once and it holds for every CLI on its `PATH`, built-in or plugin-provided.
