# Internal channels — direct agent-to-agent wiring with GitHub label mirroring

> Status: concept — epic #1172, phases #1173 (core transport), #1174 (editor
> & templates), #1175 (defaults & polish).
> Decision 2026-08-02: label hand-offs between agents may be
> delivered **internally** (orchestrator queue) instead of via the GitHub
> Events API round trip — but the label is **always stamped on GitHub anyway**,
> so the repo remains the human-visible process state and the flow-anomaly
> detector keeps a single source of truth.

## 1. Problem

Label-driven flows (producer sets label `L` on a PR/issue → the GitHub poller
sees an `*.labeled` event → fan-out to the consumer's `pending-triggers.json`)
are the least reliable link in the orchestration graph. The unreliability is
structural, not a configuration problem:

- The Events API is a narrow at-least-once-*not-guaranteed* window; some
  actions are never emitted at all (e.g. `pull_request.synchronize`).
- Orchestrator restarts can lose in-flight events (#446); the per-subscriber
  freshness horizon and seen-id cursor can let events slip past a trigger
  rewrite (#320).
- The conversation throttle (5 events/h per `(agent, conversationKey)`) and
  the burst digest (`BURST_CAP` = 3 per poll) are protection layers that can
  swallow or fold *legitimate* hand-offs.
- 30 s poll latency + 5 s pending-drain add up on every hop of a chain.

Meanwhile the #933 loop-verify path proved the alternative: an agent delivers
a work item to a *different* agent entirely inside the stack —
`POST /internal/agents/:id/enqueue-pending` → the consumer's durable
`pending-triggers.json` → WorkspaceGate-serialized execution — with none of
the failure modes above. Loops with cross-agent verification are observably
more stable than label-routed flows for exactly this reason.

## 2. Prior art this design reuses

| Building block | Where | Reused for |
|---|---|---|
| Generic internal delivery endpoint | `POST /internal/agents/:id/enqueue-pending` (`orchestrator.js`) | consumer wake-up |
| Durable per-agent FIFO + 5 s drain | `pending-triggers.json`, kind-tagged entries (`loop-verify`, `bp-event-batch`, …) | transport |
| Derived-trigger machinery | `expandGithubChannels` / `reconcileTeamGithubChannels` | canvas → trigger derivation |
| Claim-label swap | trigger runner in `agent-entrypoint.py` (#957/#958) | WIP visibility, unchanged |
| Event-transparency log | `orchestrator/github-event-log.js` + `/api/github-events` UI | internal-delivery visibility |

## 3. Core decision: internal transport, mirrored label

A label hand-off edge gets an optional **`transport`** attribute:

- `github` (default, today's behavior) — the wake is delivered by the poller.
- `internal` — the wake is delivered by the orchestrator queue; the label is
  stamped on GitHub **as decoration only** (status for humans, claim-label
  anchoring, anomaly-detector input). The poller never fans out for this
  listener.

The stamped label keeps the workspace-transparency principle intact: there is
no hidden channel — the process state stays readable on GitHub, and
`flow-anomaly-detector.js` keeps deriving its label state machine from one
place. Because the listener is excluded from the poller's subscriber plan,
the mirror stamp can never cause a double delivery.

## 4. Design

### 4.1 Producer side — `aee-emit`

New CLI in `agent-image/scripts/` (agent tooling must live in the agent
image, like `gh-as-agent` / `aee-artifact`):

```
aee-emit <label> --issue <n> | --pr <n> [--repo <clone-dir>]
```

It POSTs one call to the orchestrator (below) and reports the outcome. The
derived trigger's prompt tells internal-transport producers to use `aee-emit`
instead of `gh issue edit --add-label`; hand-authored emitters can keep using
`gh` (their listeners then simply stay on `transport: github`).

### 4.2 Orchestrator — `POST /internal/flow-emit`

```json
{ "agentId": "<producer>", "repo": "owner/name", "label": "ready",
  "target": { "kind": "issue|pr", "number": 42 } }
```

Processing order is the critical contract — **enqueue first, stamp second**:

1. **Resolve listeners**: all triggers across agents that match
   (`repo`, event type derived from `target.kind`, `labelFilter === label`)
   *and* carry `transport: 'internal'`. Same fan-out semantics as the poller
   (every matching listener gets an entry); arbitration between competing
   consumers stays with the claim-label mechanism, unchanged.
2. **Enqueue** a pending entry per listener via `enqueuePending`. The payload
   is a **synthesized event** in the poller's shape (`issues.labeled` /
   `pull_request.labeled` with `payload.label.name`, issue/PR number, sender =
   producer agent), so consumer prompts and the claim-swap runner work
   byte-compatibly. Entry carries `source: 'internal'` + the producer id.
3. **Stamp the label** on the PR/issue with the env's PAT — *best-effort*.
   The wake already happened; a failed stamp is logged and returned to the
   CLI as a warning, never a delivery failure.
4. **Log** one entry to the github-event-log (`source: 'internal'`,
   synthetic `eventId: int:<ulid>`), with the usual per-subscriber
   `outcomes[]` — the GitHub Event Log page then shows internal and polled
   deliveries in one timeline.

No listener matched → 200 with `matched: 0` and the label is still stamped
(the emit degrades to a plain status marker); the CLI surfaces this so a
mis-wired flow is visible immediately, mirroring `noMatchingTrigger`.

### 4.3 Consumer side — derived triggers

The channel/edge port gains `transport?: 'internal' | 'github'`.
`expandGithubChannels` / `reconcileTeamGithubChannels` (and the plain
label-listener derivation) copy it onto the derived trigger. A trigger with
`transport: 'internal'`:

- is **excluded from the poller's subscriber plan** (`_buildPlan` skips it) —
  the single dedup mechanism, no seen-id coordination needed;
- keeps `labelFilter`, `claim`, prompt, horizon fields untouched — the runner
  and the anomaly detector don't branch on transport;
- is drained from `pending-triggers.json` exactly like an `http`/poller entry:
  same WorkspaceGate serialization, same maintenance-mode behavior (queued,
  undrained until the window ends), same durable in-flight markers.

### 4.4 What stays on `transport: github`

- **PR-anchored triggers** (`pull_request.opened/reopened/closed` reviewers,
  merge guards) — the event genuinely originates on GitHub.
- **Human gates** (`humanGate` labels, `gate: 'human'` channels) — a person
  sets the label in the GitHub UI; only the poller can see that.
- **External/off-platform emitters.**

Internal transport is for **agent→agent label hand-offs** where the label is
a routing token (`ready`, `req:refine`, stage `:approved` chains between
agents, rework labels like `revisions-required` when set by an agent).

### 4.5 Anomaly detector

Unchanged in Phase 1: wake labels are still stamped, claim swaps still
happen, so `wake-not-claimed` / `claim-stalled` keep working. One new edge
case: an internal delivery whose *mirror stamp* failed shows a claim label
without its wake label — the sweep should treat "claim present, wake absent,
listener is internal-transport" as delivered-and-claimed, not anomalous.

### 4.6 Flow Editor / templates

- `CreateEdgeDialog` / `ConnectionsSection`: a delivery toggle on label edges
  between two agents — **"Direct (internal) — label mirrored to GitHub"** vs
  **"Via GitHub events"**. Hidden for human nodes.
- **Labelled PR/issue channels (#1194):** the same Delivery toggle appears on
  the channel edit dialog (`EditChannelDialog`) and the Routing → Inputs channel
  row. Applying a routing label to an **already-open** PR/issue is itself a
  label-setting act on an existing object — the exact shape internal transport
  handles for label hand-offs — so a labelled channel's derived `<artifact>.labeled`
  listener may carry `transport: 'internal'`. The toggle is gated to labelled
  channels and hidden for `gate: 'human'` ones (a person sets the label on
  GitHub, poller-only). Because several channels over one `(artifact, label)`
  consolidate into ONE listener, the listener goes internal only when **every**
  contributing channel opted in (a lone poller producer would be dropped by the
  plan exclusion). The **unlabelled** channel case (react to `*.opened`) stays
  GitHub-delivered — that is artifact creation, not a label signal (§7).
- Canvas: internal edges get a distinct stroke (e.g. solid vs the current
  style) + a badge in the edge dialog.
- Template round-trip: `transport` is part of the `processTemplateVersion: 1`
  bundle (export → materialise → Edit-as-draft), suffix-stamping applies to
  the label name as today.
- Flow-Weaver (later phase): default intra-stage agent→agent hand-offs to
  `internal`; stage-gate `:approved` channels stay `github` (human-gated).

## 5. Failure modes

| Failure | Behavior |
|---|---|
| Orchestrator unreachable at emit | `aee-emit` fails loudly; the agent surfaces it (fail-closed — no silent fallback to a label-only emit, which could not wake an internal listener). |
| Enqueue ok, label stamp fails | Delivery succeeded; warning logged + returned. §4.5 keeps the anomaly sweep quiet. |
| Consumer container down/disabled | Entry persists in `pending-triggers.json`; drained on next start — *better* than the poller path (#446). |
| Maintenance mode | Entries queue, drain after the window (same as `http`/`github-event`). |
| Producer emits but no internal listener | `matched: 0` surfaced to the producer; label still stamped. |

Throttle/burst layers do **not** apply to internal deliveries — they guard
against Events-API feedback loops; an internal emit is an explicit, attributed
act by one agent. The #611-family runaway backstops on the consumer side
remain the safety net.

## 6. Phasing

1. **Core transport** — `/internal/flow-emit`, `aee-emit`, `transport` on
   derived triggers, poller-plan exclusion, mirror stamp, event-log entries.
   Hand-editable on `triggers.json` before any UI exists.
2. **Editor & templates** — transport toggle, canvas styling, bundle
   round-trip, prompt-block wording ("emit with `aee-emit`").
3. **Defaults & polish** — Flow-Weaver defaults, anomaly-sweep edge case,
   an advisory lint suggesting `internal` for pure agent→agent label edges.

## 7. Out of scope

- Replacing PR/issue artifacts themselves — git stays the durable work
  bridge; this concept only replaces the *wake-up transport*.
- A general pub/sub bus or cross-team delivery.
- Removing the poller path — `github` transport remains the default and the
  only option for human gates and external events.
