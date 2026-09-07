# Loop Triggers — Concept

> Status: **concept / pre-implementation**. Grounds the "loop engineering" idea in
> what the scheduler already does today and proposes a minimal `loop` trigger type.
> No code changes yet — this is the design basis and a marketing pre-think.

## 1. Why (the "loop engineering" shift)

The industry meme of 2026: **stop writing one good prompt, start writing a loop that
re-invokes the agent until a goal is reached.** Boris Cherny (Claude Code lead,
Anthropic): *"I have loops running that prompt Claude … My job is to write loops."*
The canonical reference is Geoffrey Huntley's **Ralph loop** — deliberately trivial:

```bash
while :; do cat PROMPT.md | claude-code ; done
```

The intelligence is not the `while`; it is four principles the loop enforces:

1. **Fresh context per iteration** — each run starts with an empty context window
   (fights "context rot"); the agent re-reads its state from disk every time.
2. **Durable state outside the context** — a priority worklist (`fix_plan.md`),
   specs, and build/run knowledge (`AGENT.md`) persist across resets.
3. **Objective backpressure, not self-praise** — tests/lint gate each iteration.
   An agent must **not** grade its own work: "task complete" only means the agent
   *believes* the stop condition is met, not that the work is correct. Use hard
   criteria (0 test failures) or a **separate verifier**.
4. **Self-improvement** — durable learnings are written back so they survive the reset.

Stop condition: worklist empty **and** tests green. Guardrails: an iteration/token
**budget** (costs compound fast) and asymmetric parallelism.

## 2. What we already have (grounded in code)

We hold ~70% of the ingredients. The hard parts (fresh context + durable state) are
done. References are `agent-image/scripts/agent-entrypoint.py` unless noted.

| Loop ingredient | Status | Where |
|---|---|---|
| Fresh context per run | ✅ | `sessionPolicy: per-invocation` → `--resume` omitted for triggered runs (`_execute_inner`, `is_per_invocation` at ~3946; runner at ~2547) |
| Durable state between runs | ✅ | `memory/`, git clone, knowledge-digest, `.agent-studio/artifacts.jsonl` |
| Objective gate (pre-run, exit-code) | ⚠️ partial | `preCheckScript` gates the LLM call by exit code (`_execute_inner` ~3902) — but it runs **before** and only *skips*, it is not a post-run stop condition |
| Anti-runaway budget (global) | ⚠️ partial | Backstop `try_acquire` — concurrency ceiling + spawn-rate window, "so a self-triggering loop can't grow unbounded" (#611, `_execute` ~3805). Plus conversation throttle + burst digest (github-poller). Not a *purposeful* per-loop budget with a clean done/exhausted outcome |
| Overlap protection | ✅ agent-wide serialization (#1157) | `WorkspaceGate` — every run (loop iteration, any trigger, chat/DM) passes one gate; a loop holds it across all iterations. Per-trigger-id `if tid in self._running: … skipping` remains a backstop. |
| Self-managed, file-synced triggers | ✅ | `triggers.json`, `_load_triggers`/`_save_triggers` (~2650), SIGUSR2 re-sync |
| ACE LoopScript | ✅ but ≠ loop | Phase protocol *within one invocation*: `agent-image/CLAUDE.md` used to instruct "Follow the LoopScript phases strictly and sequentially", but the resolver (`sase_lib.resolve_loopscript`) went with the BriefingPack dispatch mode in #1967 and that instruction was removed from the baked file in #1969 — nothing in the image reads or mentions a LoopScript any more |

## 3. The gap (what a real continuation loop needs and we lack)

1. **Chaining.** No "fire again as soon as the previous run finished." `cron` is
   wall-clock (`_cron_runner` sleeps to `croniter` next-fire, ~3273); overlap
   protection only *skips* a tick, it never re-arms on completion. *(Resolved by
   the `loop` type; separately, cross-run serialization is now handled by the
   agent-wide `WorkspaceGate`, #1157 — §4.2.)*
2. **Post-run stop / `until` condition.** `preCheckScript` gates *before* a run.
   Nothing evaluates *after* a run to decide "goal met → stop the loop." Note
   CLAUDE.md states agents have no `completed` state — a loop needs one, scoped
   to the loop.
3. **Purposeful iteration/token budget.** The backstop is a safety net against
   runaways, not a first-class "run at most N iterations / M tokens, then stop
   and report" contract.
4. **Separate verifier gate.** Today's only gate (`preCheckScript`) is same-agent,
   pre-run, boolean-skip. Principle #3 wants a *distinct* checker (a command or a
   different agent/role) that must pass for an iteration to count as progress.
5. **Worklist-drain semantics.** No first-class `fix_plan.md` convention ("pick the
   top item; the loop is done when the list is empty").

## 4. Proposal — a `loop` trigger type

A new trigger `type: "loop"` alongside `cron` / `once` / `http` / `github-event`.
It reuses the existing scheduler chokepoint (`_execute` → `_execute_inner`) and the
per-invocation runner; it only adds **re-arm-on-completion + a stop contract**.

### 4.1 Schema (in `triggers.json`)

```jsonc
{
  "id": "drain-fix-plan",
  "type": "loop",
  "enabled": true,
  "prompt": "Read fix_plan.md. Pick the single highest-priority open item, implement it fully, run the tests, then update fix_plan.md and commit.",
  "roomId": "!room:local",            // optional; else DM room

  // --- stop contract (at least one required) ---
  "until": {
    "command": "npm test && test ! -s fix_plan.md",  // exit 0 => loop is DONE
    "env": {}
  },
  "maxIterations": 25,                  // hard cap; required
  "maxTokens": 2000000,                 // optional token budget for the whole loop

  // --- separate verifier (optional but recommended) ---
  "verify": {
    "command": "npm run lint && npm test",   // must exit 0 for the iteration to COUNT
    // OR delegate to a different agent/role instead of a command:
    "agentId": "team-x-code-reviewer"
    // OR hand off to the flow — no inline gate, the wired downstream QS chain
    // verifies each iteration's hand-off (PR / label) asynchronously:
    // "flow": true
  },

  // --- pacing ---
  "minGapSeconds": 0,                   // 0 = chain immediately on completion
  "sessionPolicy": "per-invocation"     // documented default for loops (fresh context)
}
```

### 4.2 Semantics

- **Chaining.** A `_loop_runner` (sibling of `_cron_runner`) runs one iteration via
  the existing `_execute`, and when it returns, immediately arms the next — no
  wall-clock. `minGapSeconds` optionally throttles. Overlap can't occur by
  construction (strictly sequential), so `_running` still applies as a backstop.
- **Workspace serialization (#1157).** An agent has one workspace, so the loop
  reserves it for its **whole** run via the agent-wide `WorkspaceGate` — acquired
  once in `_loop_runner` and released only when the loop ends (completion, stop,
  or cancellation). Iterations run *inside* that hold (`_execute(..., _gate_held=True)`)
  and never release it between them, so no cron/once/http/github-event run and no
  chat/DM turn can touch the workspace mid-loop; they queue and drain in arrival
  order once the loop finishes. The pending-queue drain pauses while a loop is
  active, so deferred http/github-event work stays durably queued (not dropped,
  not double-counted). See the AC-mapped detail in the #1157 issue.
- **Fresh context by default.** Loops default to `per-invocation` so each iteration
  starts clean and re-reads `memory/` + the worklist — principle #1, already ours.
- **Stop conditions (any of):**
  - `until.command` exits `0` → **done** (goal met).
  - `maxIterations` reached → **exhausted** (report, don't silently stop).
  - `maxTokens` exceeded (via the usage store we already track) → **exhausted**.
  - the backstop trips → **paused** (existing #611 behaviour, now surfaced as a loop state).
- **Verifier before progress counts.** If `verify` is set, the iteration's work only
  "counts" when `verify` passes; otherwise the failure is fed back into the next
  iteration's prompt (principle #3). Reuse `_run_pre_check` for the command form;
  the agent form posts the artifact to a second agent and waits — this is exactly
  our existing reviewer-role / `ace:quality-gate` pattern, just wired as loop backpressure.
- **Flow hand-off (`verify: {flow: true}`).** When the loop is the *start of a wired
  QS chain* (the iteration ends by opening a PR / setting a label that the team's
  reviewer triggers already listen to), an inline verifier would make the same
  reviewer check the work twice — once as loop backpressure, once via its own flow
  trigger. `{"flow": true}` skips the inline gate: the iteration counts on
  completion, and verification happens downstream through the flow (failures come
  back on the flow's own rework path, e.g. `revisions-required` → reworker, not as
  loop feedback). Honoured for team agents too — the separation principle still
  holds (a *different*, explicitly wired consumer checks the work), and the
  delegation is authored, never silent. Rendered as `→ flow` on the stop-contract
  badge and in trigger summaries.
- **Separate-verifier default is enforced for team agents (decided).** When a loop
  agent belongs to a team and the author leaves `verify` empty, the system
  **pre-fills a *different* sibling role** as the verifier (never the worker itself) —
  the "an agent must not grade its own work" principle is enforced by the product,
  not left to discipline. The author may override the pick, but not silently remove
  the separation. Standalone (non-team) agents fall back to a command verifier or an
  explicit "no verifier — self-graded" acknowledgement. *Sub-detail to settle at
  build time:* the sibling-selection heuristic (prefer a `*-reviewer`/`quality-gate`
  role in the same team; if several, ask; if none, fall back to command/ack).
- **Outcome report.** On any terminal state the loop posts a single summary to the
  room: outcome (`done` / `exhausted` / `paused`, plus `stopped` when the user
  presses Stop — #1231), iterations used, tokens spent, last verifier output. This
  gives agents the "completed" signal they lack today. The same message also carries
  a structured, persistent record of the finished loop's configuration (#1231, §4.6).

### 4.3 Reuse map (minimise new surface)

| Need | Reuse |
|---|---|
| Run one iteration | `_execute` / `_execute_inner` (unchanged chokepoint) |
| Fresh context | `sessionPolicy: per-invocation` (existing) |
| `until` / `verify` command | `_run_pre_check` (existing exit-code runner) |
| Anti-runaway | Backstop `try_acquire` (existing #611) — loop budget sits *on top* |
| Token accounting | usage store / `usage` CLI (existing) |
| Agent-form verifier | reviewer roles + `ace:quality-gate` (existing) |
| Worklist | **convention-only** — the prompt + `until` drive it (no shipped template/CLI); agents may keep their own list in `memory/` if they want |

### 4.4 Guardrails (non-negotiable)

- `maxIterations` **required** — no unbounded loop may be authored.
- Loop respects **Maintenance Mode** exactly like cron (pause, one catch-up).
- The backstop remains the last line of defence; the loop budget is the *first*.
- Default `sessionPolicy: per-invocation` documented so authors don't accumulate
  context (and cost) by accident.

### 4.5 UI (decided)

> **Revised by #1020 (manual loops are launched runs, not list triggers).**
> A *chat-launched* loop is no longer authored/left in the chat Triggers list.
> It is started from a loop control in the chat composer (left of the mic) via
> the shared loop configuration form (`TriggerForm` in a locked "loop-launch"
> mode) and posted as a `loop` trigger tagged **`launched: true`**. Such a loop:
> self-removes from `triggers.json` on any terminal outcome (no lingering
> `enabled` entry — AC6); is pruned, never resumed, if still present at
> container startup (no auto-resume — AC7); is limited to one active per agent
> (AC8); and is stopped by deleting its trigger + stopping the in-flight
> session. The chat Triggers list now holds only standing subscriptions
> (`cron`/`once`/`http`/`github-event`/`data-flow`); loop stays a selectable
> type only in the Flows canvas edge editor (declarative flow loops are
> unchanged). The engine (`_loop_runner`, verifier, budget, outcome DM) is
> untouched. The self-edge visualisation below still applies to declarative
> canvas loops.


The trigger model already unifies the two surfaces, so this is **not** an either/or:

- **Editing — reuse the shared `TriggerForm`.** `TriggersPanel.jsx:503` is the
  single source of truth for editing every trigger type and is reused by the canvas
  `EdgeDialogs.jsx`. Adding `type: "loop"` (with `until` / `verify` / `maxIterations`
  / `maxTokens` fields) there makes it available **for free** in both the chat
  right-rail Triggers panel and the Flows canvas edge dialog.
- **Visualising — a self-edge, following the cron precedent.** `cron`/`once` already
  render as a self-edge today (`process-graph.js:219` → `{from: n.id, to: n.id,
  kind: 'timer'}`). A loop is the same shape (an agent re-arming itself), so emit a
  self-edge with a **new `kind: 'loop'`** and draw it in `flow-graph-render.js`.

**Chosen canvas treatment — self-edge + stop-contract badge** (over "timer-style,
relabelled only" and "loop-node ring + separate verifier edge"). The stop contract
is the thing cron doesn't have, so it must be legible *on the graph*, not hidden in
a dialog:

```
     ╭─↻ until: tests green ·╮
     │   ≤25 iter · ✓ reviewer│
  ╭──▼───────────────────────┴╮
  │        developer           │
  ╰────────────────────────────╯
```

The badge surfaces the three loop-defining facts at a glance: **stop** (`until`),
**budget** (`≤N` iterations / token cap), **verifier** (`✓ <role/command>`). Full
detail on click via the existing edge dialog. Concrete work:
`process-graph.js` (emit `kind: 'loop'` self-edge + carry `until`/`maxIterations`/
`verify` summary onto the edge), `flow-graph-render.js` (render the badge), and the
shared `TriggerForm` (the `loop` type + fields).

*Deferred (not chosen now):* drawing an agent-form verifier as its own edge to the
reviewer node. Revisit if `verify.agentId` becomes common — for the command-form
verifier the badge is enough.

#### Finished-loop record (#1231) — the counterpart of the running card

The running-loop summary (#1155, `LoopSummaryCard`) is client-side state: it reads
`ChatPanel.activeLoop` from the triggers poll, so it **unmounts the moment the
launched loop self-removes** (§4.5). A finished loop then left no lasting trace —
its full launch prompt was gone, so the user could neither review it nor re-run it.

`_post_loop_outcome` therefore attaches a structured **`io.aee.loop-record`** payload
to the terminal-outcome message it already posts (extended `send_formatted` — one
message, not a second entry). The payload carries the loop's config (exactly the
fields the running card's `buildLoopSummaryModel` and the launcher form read —
`prompt`, `maxIterations`, `until`, `maxTokens`, `minGapSeconds`, `verify`) plus the
terminal `outcome` and iterations-ran. Because it rides on a normal Matrix message it
survives reload and appears in ordinary scrollback (mirrors the `io.aee.trigger`
notice pattern). The Admin Console (`Message.jsx` → `LoopRecordCard`) renders it as the
finished-loop card: same config fields as the running card, the outcome + "N of M"
chip, the full prompt (expandable), and a **Start again** button that opens the loop
launcher pre-filled with that loop's settings (`loopRecordToInitialValues`) — it does
**not** start the loop; a fresh trigger id is minted on submit so the original record
is unchanged. A user **Stop** now terminates the loop as `stopped` (surfaced from the
in-flight iteration's abort via the loop sink, or the cancellation fallback) so a
stopped loop leaves the same record. Pure helpers live in `loop-run-view.js`
(`buildLoopRecordModel` / `loopRecordToInitialValues` / `loopOutcomeMeta`).

### 4.6 Decisions (resolved)

1. **Verifier default → enforce a separate role for team agents.** Empty `verify` on
   a team agent auto-pre-fills a *different* sibling role (never self); overridable
   but the separation can't be silently removed. See §4.2 for details and the
   sibling-selection sub-detail left for build time. *(Alternatives rejected:
   nudge-only; objective-command default.)*
2. **fix_plan convention → convention-only.** Ship **no** template and **no**
   `aee-worklist` CLI. Loops rely on the prompt + `until`; an author who wants a
   worklist keeps it in the prompt / `memory/`. Keeps the surface minimal; a CLI can
   follow later if the pattern proves common. *(Alternatives rejected: template-only;
   template + CLI.)*
3. **ACE LoopScript → keep separate.** LoopScript stays an intra-run phase protocol;
   the `loop` trigger is a generic inter-run scheduler feature. No coupling now —
   clearest mental model, minimal risk. *(Alternatives rejected: bridge a bp-instance
   under a loop trigger; decide later.)*

## 5. Marketing pre-think (positioning only — not final copy)

The story writes itself because we don't just *do* loops — we do them **governed**:

- **"Loop engineering, governed."** The raw Ralph loop is a naked `while` in a
  terminal: no visibility, no verifier, no budget, single-agent. Agent Studio makes
  the loop a **first-class, observable, multi-agent** primitive:
  - **Visible** — loops are nodes in the Flows graph, not a shell script no one sees.
  - **Verified** — a *separate* reviewer role gates each iteration (the "don't let
    the agent grade itself" principle, enforced by the product, not by discipline).
  - **Budgeted** — `maxIterations` / token budget + the runaway backstop, so cost
    can't silently compound (the #1 warning in every loop-engineering article).
  - **Observable** — session log, GitHub event log, usage per loop.
  - **Governed** — human-approval gates, Maintenance Mode, team scoping.
- **One-liner candidates:** *"Ralph loop — but observable, verified, and multi-agent."*
  / *"From prompts to loops — with a verifier and a budget built in."*
- **Deck angle (later):** a slide contrasting `while :; do … done` (fragile, blind,
  single-agent, unbounded cost) vs. the Studio loop node (verifier gate, budget,
  graph, audit). We already have the governance features shipped — the `loop`
  trigger is the small piece that lets us *say the word "loop"* natively.

> Reminder (per project memory): user-facing name is **Agent Studio**; keep internal
> codenames (AEE / e-vgh-claw) and any customer name out of marketing copy.
