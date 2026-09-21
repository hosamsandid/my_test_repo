# Jira plugin — more event kinds than `status_changed`

> Status: **future plan, not started** (assessed 2026-09-17). Companion to
> `docs/jira-plugin-plan.md` (the shipped plugin; §11 links here) and
> `docs/jira-plugin.md` (the how-to). The step-by-step implementation plan
> (PR breakdown, contracts, upgrade path) is
> `docs/jira-plugin-events-implementation.md`. Nothing here changes the platform: the
> wake stays generic (`plugin-event`, D5) and every addition is broker-side plus
> a manifest `events[]` entry — the trigger form, the key picker and the help
> follow from the manifest automatically (`docs/plugin-system-concept.md` §4.1).

## 1. Why this is cheap now

The broker polls each watched project every ~60 s with one JQL search
(`project = KAN AND updated >= -Nm`, fields `summary, status, issuetype`,
`expand=changelog`). That single response already carries more than status
transitions: the **changelog** lists every field change an issue went through
(`items[].field` = `status`, `assignee`, `priority`, `labels`, `Sprint`,
`Fix Version`, `resolution`, `description`, `summary`, `Attachment`, `Link`, …),
and `updated` is bumped by comments too. So most new event kinds are a new
extractor over data the broker already holds — no extra Jira calls.

Jira Cloud **webhooks are not an option** on a local stack (no inbound URL);
everything below stays in the poll model, mirroring the GitHub poller decision.

Since the trigger form renders the plugin's manifest vocabulary (`events[]`,
#jira-test), adding an event to the manifest gives users a *Which event* option
and an *Only when…* key picker for its fields with zero console work.

## 2. Candidate events

| Event | Detection | Extra API cost | Payload (top-level strings) | Gotchas |
|---|---|---|---|---|
| **`issue_created`** | issue in the window whose `created` ≥ last poll and whose id `<key>:created` is unseen | none | `issueKey, projectKey, issueType, summary, reporter, status, priority` | trivial; the first-poll baseline rule applies |
| **`comment_added`** | add `comment` to `fields`; every `comment.comments[]` with `created` in the window and unseen id `<key>:c<commentId>` | none (same call, larger response; page cap on `comment.comments`) | `issueKey, projectKey, issueType, author, body` (clamped), `commentId`, **`origin`** (`human` \| `agent`) | **loop risk** — see §4 |
| **`field_changed`** (generic) | any changelog item whose `field` ≠ `status` | none | `issueKey, projectKey, field, from, to, author` | one event covers assignee / priority / labels / sprint / fixVersion; routing via `Only when… field = assignee`. Less discoverable than named events — named ones can be added later as sugar over the same extractor |
| `assignee_changed`, `priority_changed`, `labels_changed`, `sprint_changed`, `fix_version_changed` | changelog item of that field | none | `issueKey, from<Field>, to<Field>, author` | same extraction as status (~20 lines each). Label values arrive space-separated; `Sprint` is a custom field whose display name varies per site |
| `resolved` | changelog item `resolution` gaining a value | none | `issueKey, resolution, author` | usually coincides with a status change — two wakes for one action unless triggers pick one |
| `description_changed`, `summary_changed` | changelog `description` / `summary` | `getIssue` if the new text is wanted | `issueKey, author, origin` | same self-loop risk as comments (`aee-jira update` edits the description) → needs `origin` |
| `attachment_added`, `link_added` | changelog `Attachment` / `Link` | none | `issueKey, name` / `target` | low demand; cheap |
| `due_date_approaching`, `sla_breached` | **not** change-based: a JQL like `due <= 1d` per tick | +1 search per project per tick | `issueKey, dueDate` | needs its own dedup (fire once per issue per day) — a different mechanism; **parked** |

## 3. The shared broker work (once, for all kinds)

1. **Extractors** — `event-extract.js` gains one function per kind; the status
   extractor is the template (`extractStatusChangeEvents`). Every event carries
   `event: '<kind>'` explicitly (today the broker defaults a missing `event` to
   `status_changed` in `deliver()`).
2. **Dedup ids** — the per-project seen-id cursor already dedups by id; new
   kinds only need distinct id shapes: `<key>:<historyId>` (status, unchanged),
   `<key>:<historyId>:<field>` (field changes — one history entry can carry
   several items), `<key>:c<commentId>`, `<key>:created`. `SEEN_MAX` may need a
   nudge once comments count.
3. **Watch-config gate** — today a watch's status chips gate *status only*. New
   kinds are **opt-in per watch row**: `events: ["status_changed",
   "comment_added", …]`, default `["status_changed"]` so an existing watch does
   not get noisier on upgrade (the same read-time migration pattern as the
   singular `statusFilter` → set). The Watch config page gets a checkbox per
   kind; the status chips keep applying to `status_changed` only.
4. **Stores and copy** — the inbox and activity stores, `summariseEvents`, the
   burst digest and the per-scope throttle are already kind-agnostic; they need
   the kind shown (`aee-jira inbox` rows, Activity tab, the wake summary).
5. **Manifest + docs** — `plugins/jira/plugin.json` `events[]` (one entry per
   kind, fields with descriptions and examples), `plugins/jira/help/jira.md`
   (a row per kind in the fields table), `docs/jira-plugin.md` §5.
6. **`promptLine`** — mention that a wake may be a comment or a new issue, not
   only a status change, so the agent reads the event kind from its inbox.

## 4. The comment loop, and `origin`

An agent's own `aee-jira comment` is a comment. A trigger on `comment_added`
without a discriminator wakes the commenting agent again (and any teammate
listening), which comments again — the platform's loop protection is
**frequency-only** (a per-conversation throttle and a burst digest), so it
would slow the loop, not stop it.

The broker is the one party that knows which comments it posted (it makes the
`addComment` call and gets the new comment id back). So it stamps every comment
event with **`origin`**: `agent` for ids it created, `human` otherwise, and the
docs tell users to route on `Only when… origin = human`. The same stamp applies
to `description_changed` (`aee-jira update`).

Stricter alternative considered: the broker never forwards its own comments at
all. Rejected as the default — a Reviewer agent legitimately waits for the
Developer agent's comment — but it may become a per-watch switch
(`forwardAgentComments: false`) if a team wants it. Decide when the first
consumer exists.

## 5. Recommended first batch

- **`issue_created`** — cheapest; the natural "new ticket → BA triages it"
  opener for the refinement flow.
- **`comment_added` with `origin`** — the most useful (a human answers the BA's
  open questions → the BA resumes). Ship only with the `origin` stamp.
- **`field_changed`** (generic) rather than five named events; name the popular
  ones later if the picker feels vague.

Parked: `resolved` (overlaps status), `attachment_added`/`link_added` (no ask),
the time-based kinds (different mechanism).

## 6. Effort

Broker extraction + tests is the bulk (`event-extract.js`, `poller.js`, the
stores, `server.js`); watch-config toggles + admin UI; manifest/help/docs. No
orchestrator or console change beyond what the manifest already drives. The
budget guard (`corpus.test.js`) will size the grown help topic.

## 7. Open questions

- Should `field_changed` and the named field events coexist (sugar over one
  extractor) or is the generic one enough?
- `comment_added` body clamp: how much of the comment rides in the payload vs.
  "read it with `aee-jira show`"?
- Does a watch with an empty status set and `comment_added` enabled produce too
  much traffic on a busy project? The per-scope throttle (5/h per conversation)
  and the digest bound it, but the numbers were tuned for status changes.
