# Knowledge store — schema, config & layout (Phase 0)

Reference spec for the team **Knowledge Base (KB)**, tier **T1** of the Shared
Agent Learning & Knowledge Flow (`docs/knowledge-sharing-concept.md`). Phase 0 is
**plumbing only**: this document + the pure core `orchestrator/knowledge-store.js`
define the data model, config and default layout that later phases build on. No
behaviour changes yet — nothing writes a KB or acts on the autonomy dial until
Phase 1.

## 1. KB entry schema

One entry = one line in a JSONL file. Fields (`orchestrator/knowledge-store.js`):

| Field | Type | Req | Notes |
|---|---|---|---|
| `v` | int | ✓ | Schema version (`1`). Per-entry, so mixed-version files migrate cleanly. |
| `id` | string | ✓ | 12-char hex (`openssl rand -hex 6` convention). |
| `kind` | enum | ✓ | `fact` \| `entity` \| `convention`. |
| `text` | string | ✓ | The durable statement (single-line canonical fact). |
| `originAgent` | string | ✓ | Agent id that first recorded it. **provenance** |
| `teamId` | string | ✓ | Owning team (the KB is team-scoped). **provenance** |
| `createdAt` | string | ✓ | ISO-8601 `…Z`. **provenance** |
| `correlationId` | string | ◐ | Originating Matrix `event_id` / `trigger:<id>:<ts>` — ties to the session log. **provenance** |
| `sessionId` | string | ○ | Claude session id when available. **provenance** |
| `sourceRefs` | array | ○ | `[{ kind: pr\|issue\|commit\|branch\|url, ref }]`. **provenance** |
| `convergence` | string[] | ✓ | Agent ids that independently recorded this fact. Seeded `[originAgent]`; grown in Phase 3. |
| `tags` | string[] | ○ | Optional topic filters. |
| `status` | enum | ✓ | `active` (default). Overlay statuses (stamped by the orchestrator on the canonical view, never on a shard): `merged` \| `promoted` \| `archived` \| `pending` \| `rejected` (the last two = supervised-review holds, see `docs/knowledge-governance.md`). |
| `updatedAt` | string | ○ | Set when convergence/merge touches it (Phase 3). |

**Mandatory provenance (validated, locked decision):** `originAgent`, `teamId`,
`createdAt` are required **and** at least one of `correlationId`, `sessionId`, or a
non-empty `sourceRefs`. This makes "trace any promoted skill back to the
agent/session/PR that learned it" enforceable from day one. `makeKnowledgeEntry`
throws rather than emit an unprovenanced entry.

## 2. Physical layout (open question #1 → resolved)

**One canonical JSONL file per kind.** Each line is a full entry including
provenance and convergence:

```
<store>/
  knowledge.manifest.json      maps each kind to its dir/file (team-overridable)
  README.md
  facts/facts.jsonl
  entities/entities.jsonl
  conventions/conventions.jsonl
```

Chosen over front-matter-per-entry markdown because JSONL makes (a) concurrent
appends from N agents line-atomic and merge-clean, and (b) Phase 3's mechanical
`convergence[]` updates trivial — while staying diffable/reviewable in git and
greppable by `knowledge search` (the `text` field is on every line). A
human-readable markdown **digest** is a derived read view produced by the CLI
later, **not** a second source of truth.

The default template ships at `orchestrator/knowledge-template/` (baked into the
image). `buildDefaultManifest()` returns exactly the shipped
`knowledge.manifest.json`; a unit test byte-matches the two (CI guard). Phase 1's
sync copies this template into `<store>/` on first use.

## 3. `knowledgeStore` config

Rides on `environment.json` (co-located with `repositories`; every agent resolves
an env, and a team shares one env, so this is effectively team-scoped).
Normalized by `normalizeKnowledgeStore` inside `loadEnvironment`:

```jsonc
"knowledgeStore": {
  "mode": "in-repo" | "own-repo",   // default "in-repo"
  "path": "docs/agent-knowledge/",   // default; KB root within the chosen repo
  "repoRef": {                        // own-repo: the KB repo. in-repo + multi-repo: selects one by url
    "url": "…", "branch": "main", "sshKeyId": "…", "githubTokenId": "…"
  },
  "sources": []                       // Phase 5 MCP providers; [] ⇒ default path is MCP-free
}
```

Defaults for a legacy env (no `knowledgeStore`): `{ mode: "in-repo", path:
"docs/agent-knowledge/", repoRef: null, sources: [] }`. In `in-repo` mode:
`repoRef.url` selects which repo; absent + single repo ⇒ that repo; absent +
multi-repo ⇒ first repo + a warning. `own-repo` without a `repoRef` ⇒ a warning.

## 4. Autonomy dial

`knowledgeAutonomy: 0|1|2|3` on `environment.json`, read via
`knowledgeAutonomyLevel(env)` (clamped, **default 1**):

| Level | Behaviour |
|---|---|
| 0 — Off | today: private memory, nothing shared |
| 1 — Share *(default)* | harvest → Team-KB + real-time query (Phase 1) |
| 2 — Suggest | drafts promotions; operator confirms (Phase 3) |
| 3 — Auto-curate | curator merges/promotes autonomously (Phase 4) |

Phase 0 reads nothing behaviorally, so the default causes no change until Phase 1
wires harvest at level ≥ 1. Level 0 reproduces today's behaviour exactly.

The dial is now settable from the Knowledge Flow UI (no hand-editing
`environment.json`), and an orthogonal per-team `knowledgeReview` flag (default
false) adds a human approve-before-share checkpoint. Both are documented in
`docs/knowledge-governance.md`.

## 5. Three-tier skill pool (open question #4 → resolved)

`makeSkillSourceResolver` (`orchestrator/skill-source.js`) resolves a skill name
**agent → team → global**, most specific wins:

| Tier | Path | Scope |
|---|---|---|
| Agent | `/workspace/agents/<id>/skills/` | that agent only |
| Team | `/workspace/teams/<teamId>/skills/` | the team |
| Global | `/template-workspace/skills/` | all teams |

`resolveSkillSourceDir(name, teamId, { agentId })` — `agentId` is optional; omitted
⇒ identical two-tier behaviour as before. **Phase 0 does not materialise the
on-disk agent pool** (deferred to Phase 3 promotion): no agent has that directory
yet, so resolution falls through to team/global exactly as today.

> The agent-tier path is the same directory `seedAgentWorkspace` copies skills
> *into*. So "agent tier wins" means *don't clobber an agent's private skill with
> the team/global one of the same name* — and the resolved source can equal the
> copy destination. `seedAgentWorkspace` guards this with a `src === dst`
> skip-copy (copying a dir onto itself throws).

## 6. Pure-core API (`orchestrator/knowledge-store.js`)

`makeKnowledgeEntry`, `validateKnowledgeEntry`, `serializeEntry`, `parseEntry`,
`buildDefaultManifest`, `validateManifest`, `kindFilePath`,
`normalizeKnowledgeStore`, `knowledgeAutonomyLevel`. No fs/network (an injected
`idGen`/`now` keep it deterministic). Unit-tested in `knowledge-store.test.js`;
the 3-tier resolver in `skill-source.test.js`.
