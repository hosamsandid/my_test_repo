# Prompt Version History + Undo/Rollback — Concept

> Concretizes issue **#990** ("Version history + undo/rollback for agent prompt
> changes"). Source: collaboration-mode open-points review, Point 5
> (`docs/collaboration-mode-faq.md` §5, "Config Changes Are Instant and Global").

## 1. Problem

Editing an authored system prompt overwrites `AGENT-PROMPT.md` / `config.json`
immediately and globally, with **no history, no undo, no rollback**, and there is
no way back to a known-good previous version.

Blast radius is already contained by the one-team-per-human model, so this is an
ergonomics/safety improvement, not a multi-tenant emergency.

## 2. Scope — what is versioned

Only **authored** prompts (human-written), never derived copies:

| Construct | Field / file | Edit choke-point (server-side) |
|---|---|---|
| Standalone `agent` | `AGENT-PROMPT.md` | `PUT /api/agents/:id/prompt` (`api.js:2913`) |
| `team-member` (override) | `config.systemPrompt` + `AGENT-PROMPT.md` | `PUT /api/agents/:id` body `systemPrompt` (+ `promptMode`, #1511) (`api.js:1879-1967`) |
| `team` (template) | `config.systemPromptTemplate` | `PUT /api/agents/:id` body `systemPromptTemplate` → proxy to `updateTeamPrompt` (`orchestrator.js:6108`) |

**Verified:** every human edit surface funnels into exactly these three
endpoints —
- `AgentManager.jsx` `PromptEditor` → choke-point 1,
- `Agents.jsx` edit form → choke-points 2/3,
- Flow-editor `NodeInspector.jsx:304-306` → choke-points 1/2.

There is **no fourth write path**. Propagated inheriting-member copies
(`updateTeamPrompt` fan-out), seeding, materialisation and blueprint instances
are *derived* → **no** history.

Because all three choke-points live in the **admin-console** process — where
`req.user` (the acting human) is available — capture is done **console-side
only**. No orchestrator duplication, no actor-forwarding into internal
endpoints.

## 3. Data model — sidecar `/workspace/agents/<id>/.agent-studio/prompt-history.json`

A per-agent sidecar (not a `config.json` field), consistent with
`.agent-studio/seeded-skills.json` and the `skill.json` manifest. Avoids contention
between the two `config.json` writers (orchestrator non-atomic `saveAgentConfig`
vs. console atomic `writeJsonAtomic`).

```jsonc
{
  "v": 1,
  "field": "systemPrompt" | "systemPromptTemplate",   // what this agent authors
  "history": [                                          // newest-first, bounded N=20
    { "version": 3, "at": "2026-07-31T…Z", "by": "operator:alice",
      "action": "reverted", "note": "from v2 to v1",
      "hash": "9f2c…", "content": "<full prompt text>" },
    { "version": 2, "at": "…", "by": "operator:bob",  "action": "edited",   "hash": "…", "content": "…" },
    { "version": 1, "at": "…", "by": "unknown",       "action": "baseline", "hash": "…", "content": "…" }
  ]
}
```

**Decisions (confirmed):**
- **Full content snapshots**, not hash-only. Unlike `skill-manifest.js` (which
  stores only hashes because the content *is* the skill directory), rollback
  needs the actual text. Prompts are small (KB); N=20 snapshots ≈ tens of KB per
  agent.
- **`history[0]` == the currently-active prompt.** Version bumps only on a hash
  change — re-saving an identical prompt is a no-op (same hash-gating as
  `stampManifest`).

## 4. Pure module `admin-console/api/prompt-history.js`

Console-only (all edits are console-mediated), mirroring the shape/semantics of
`orchestrator/skill-manifest.js` but with content snapshots. Node builtins only,
unit-testable without install.

```js
const HISTORY_LIMIT = 20;
const ACTIONS = ['baseline', 'edited', 'inherited', 'reverted'];

// stampPromptHistory(existing, { oldContent, newContent, at, by, action, note, limit })
//   -> next history object
//   - hash(x) = sha256(x).slice(0,12)
//   - existing empty  → seed v1 { action:'baseline', by:'unknown', content:oldContent },
//                        then append v2 with newContent
//                        (so even the very first edit leaves something to revert to)
//   - hash(newContent) === history[0].hash → no-op (idempotent re-save)
//   - else unshift { version:+1, at, by, action, note?, hash, content:newContent };
//     cap to `limit`
//
// readPromptHistory(dir, io?)  / writePromptHistory(dir, obj, io?)   // fs/path injectable
```

Best-effort at every call site (wrapped in try/catch) — stamping never breaks
the primary prompt write.

## 5. Capture integration (server-side, admin-console)

One helper in `api.js`, called **before** the existing write in each
choke-point:

```js
// captureAuthoredPromptEdit(id, { field, oldContent, newContent, req, action })
//   by = (req.user && (req.user.sub || req.user.username)) || 'operator';  // like skillActor()
```

- **Choke-point 1** (`api.js:2913`, `AGENT-PROMPT.md`): `oldContent` = current
  file; stamp, then write. `action:'edited'`.
- **Choke-point 2** (`api.js:1879-1967`, member override): `oldContent` =
  `cfg.systemPrompt` (or resolved inherited template); stamp, then
  `writeJsonAtomic` + `AGENT-PROMPT.md`. Switching to **inherit**
  (`systemPrompt: null`) is captured as `action:'inherited'` with empty new
  content — the prior override stays revertable. **System-prompt mode (#1511):**
  the versioned field is the authored text — the addition in *Additional input*,
  the full override in *Exclusive overriding input*. A capture fires on an
  authored-text change **or** a mode switch (`prevMode !== nextMode`, noted as
  `prompt mode <a> → <b>`), so switching between the three modes is recorded
  consistently with inherit/edit (AC12); revert preserves the member's current
  mode when restoring its text.
- **Choke-point 3** (`api.js:1661`, team template): `oldContent` =
  `cfg.systemPromptTemplate` (already read into `cfg`). **Stamp console-side,
  then** proxy to `updateTeamPrompt`. No `by` forwarding into the orchestrator.

## 6. Rollback = a new version through the existing write path

```
POST /api/agents/:id/prompt-history/:version/revert
```

1. Resolve the target version's `content` from the sidecar.
2. Apply it through the **normal** edit path for the role (team → the
   `updateTeamPrompt` proxy; member/standalone → `writeJsonAtomic` +
   `AGENT-PROMPT.md` + `notifyAgentReseed`).
3. Capture runs as usual → new head `action:'reverted', note:'from vN to vK'`.

Never destructive (undo-of-undo works). **AC "rollback goes through the same
assembly/seed path, preview stays byte-identical"** is satisfied for free, since
no new seed path is introduced. "Undo" = revert to `currentVersion - 1`.

## 7. Read API

- `GET /api/agents/:id/prompt-history`
  → `{ field, currentVersion, history: [{ version, at, by, action, note, hash, contentPreview }] }`
  (truncated snippets in the list; full content fetched on demand for
  diff/preview).

## 8. Frontend

A reusable `PromptHistory` component — version list (`at` / `by` / `action`),
diff against the active prompt, **Revert** button with confirm — mounted in:
- the **NodeInspector** Prompt tab (Flow editor) — live teams & members
  (team templates have no chat room).

## 9. Acceptance criteria mapping

| AC | Implementation |
|---|---|
| Editing a prompt records the previous content as a retained version | `captureAuthoredPromptEdit` at all 3 choke-points |
| Prompt tab shows history + supports rollback | `GET …/prompt-history` + `PromptHistory` component |
| Rollback goes through the same assembly/seed path (preview byte-identical) | Revert re-uses the existing write paths |
| History bounded + attributed to the acting user | `HISTORY_LIMIT=20`, `by` from `req.user` |

## 10. Testing

- Unit (`prompt-history.js`): baseline seed on first edit, hash-gate no-op,
  bound to N, newest-first ordering, inherit-clear capture. Golden fixture à la
  `skill-manifest.fixture.json`.
- Integration: edit → history grows → revert per role (standalone / member /
  team); attribution asserts `by`; team-template revert propagates to inheriting
  members via the existing `updateTeamPrompt` fan-out.

## 11. Out of scope (later phases)

- Staging ("edit → preview → promote") — explicitly a later phase in #990.
- Rich diff highlighting; git-persisted history.
- Mid-term removal of the team-wide template (tracked separately) — the `field`
  discriminator already accommodates it.

## Touched files (implementation map)

| File | Change |
|---|---|
| `admin-console/api/prompt-history.js` (new) | Pure stamp/read/write module |
| `admin-console/api/prompt-history.fixture.json` (new) | Golden fixture |
| `admin-console/api/api.js` | `captureAuthoredPromptEdit` helper; wire into the 3 choke-points; `GET /prompt-history`; `POST /prompt-history/:version/revert` |
| `admin-console/src/pages/process/NodeInspector.jsx` | Mount `PromptHistory` in the Prompt tab |
| `admin-console/src/pages/.../PromptHistory.jsx` (new) | Version list + diff + Revert |
| tests | Unit + integration per §10 |
