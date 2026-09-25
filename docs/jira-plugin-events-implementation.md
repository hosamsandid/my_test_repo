# Jira plugin — event kinds: implementation plan

> Status: **implemented** (written 2026-09-21; revised 2026-09-25 after main
> gained issue creation, custom-field writes and attachment upload — §1.11,
> §2.4; delivered as **one PR in ordered commits**, §3). This is the *how* for
> `docs/jira-plugin-events-plan.md` (the *what/why* — read it first; its §5
> first batch is what this plan builds). Shipped baseline:
> `docs/jira-plugin-plan.md` / `docs/jira-plugin.md`. Every path below is
> relative to `plugins/jira/` unless it starts with `orchestrator/`,
> `admin-console/` or `docs/`.

## 0. Scope

**In:** `issue_created`, `comment_added` (with `origin`), `field_changed`
(generic) — the concept's §5 batch — plus the one-time kind-aware refactor of
the broker they all need. **Out (parked, unchanged from the concept §5):**
`resolved`, `description_changed`/`summary_changed` as named kinds,
`attachment_added`/`link_added` as named kinds (they surface through
`field_changed` anyway), the time-based kinds.

**No orchestrator or console code changes.** The platform stays generic
(`plugin-event` wake, `eventFilter`, `payloadFilter`, digest projection); the
manifest `events[]` drives the trigger form. §1 lists the two places where this
was *almost* not true and how the broker absorbs them instead.

## 1. What the code says that the concept doc did not

Read before designing anything — each of these shaped a decision below.

1. **Event ids may carry exactly one colon.** `server.js` `EVENT_ID_RE` =
   `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}:[A-Za-z0-9._-]{1,64}$` gates
   `aee-jira inbox --consume <id>`. The concept's `<key>:<historyId>:<field>`
   would be **un-consumable**. → id shapes use `.`/letters after the single
   colon (§2.2). The regex stays as is.
2. **A wake carries ONE top-level `event`, and that is all `eventFilter` sees.**
   `orchestrator/plugin-event.js` `matchesPluginEventTrigger` compares
   `trigger.eventFilter` to `body.event`; `agent-entrypoint.py`
   `_execute_plugin_event` re-matches the same way. `payloadFilter` looks
   *inside* a digest's `events[]`; `eventFilter` does **not**. `deliver()` sets
   `event: first.event || 'status_changed'`. A digest mixing a comment and four
   status changes would be delivered as `status_changed` and a
   `comment_added` listener would never wake. → **every wake is single-kind**:
   the poller fans out **per kind** (§3, PR 1). No platform change.
3. **The token's account is the author of everything the broker writes.** A
   comment posted via `aee-jira comment` shows the Team Admin's Atlassian
   account as `author` — the same account that admin uses when commenting by
   hand. `author` therefore cannot distinguish agent from human. → `origin` is
   decided from a broker-side **own-writes registry** keyed by the comment id
   `addComment` gets back, with the attribution paragraph
   (`Posted by an agent on team …`) as a restart-safe fallback marker (§2.4).
4. **The search response is narrowed twice.** `jira-client.js`
   `buildJqlSearchBody` requests only `summary,status,issuetype`; `shapeIssue`
   then keeps `key,summary,status,issueType,changelog`. Both need widening
   (`created, reporter, priority, comment`) and the shaped issue must carry
   them through; `getIssue` (CLI `show`) is separate and unaffected.
5. **Comments are ADF, not text.** `fields.comment.comments[].body` is an
   Atlassian Document Format tree (the broker only *writes* ADF today,
   `commentAdf`). A plain-text flattener is needed for the clamped `body`.
6. **The activity store drops unknown fields.** `activity-store.js`
   `shapeEventForRow` whitelists status-shaped keys; a comment row would lose
   `body`/`origin`, a field row `field`/`from`/`to`. The UI (`ui/app.js`
   inbox + Activity) and the CLI (`bin/aee-jira.py` inbox) render
   `fromStatus → toStatus` unconditionally.
7. **The horizon gate is the upgrade safety net.** Fresh = unseen id **and**
   `ev.created` after `cursor.lastPolledAt` (minus `GRACE_MS`). Every new kind
   must set `created` from the right Jira stamp (comment `created`, issue
   `fields.created`, history `created`) so the first poll after enabling a
   kind does not replay the whole window. A missing stamp fails open
   (delivered) — keep that rule, test it per kind.
8. **`Rank` is noise.** Every board drag writes a `Rank` changelog item; an
   unfiltered generic `field_changed` would fire on it. → denylist (§2.3).
9. **There is no in-place plugin upgrade.** `POST /api/plugins/:id/install`
   409s when installed; `DELETE` reaps every team's Jira credential. → the
   rollout is a documented in-place file refresh, not reinstall (§6).
10. **Throttle and burst keys are per issue, not per kind.** `_fanOut` keys
    conversations `issue:<key>` / `project:<key>`; the 5/h throttle bucket is
    `${scopeId}:${convKey}`. Decision: keep them shared across kinds (§7).
11. **The broker writes more than comments now.** Since #2417/#2424/#2449 and
    the attachment upload, `aee-jira` can create issues (`/create-epic` →
    `createEpicWithStories`), set custom fields (`/set-field` →
    `setCustomField`) and add attachments (`/attachment/add`). The poller
    observes those as `issue_created` / `field_changed` — the same self-wake
    loop as a comment. → `origin` is stamped on **all three** new kinds, from
    one own-writes registry (§2.4).

## 2. Contracts

### 2.1 The event object

Common to every kind (superset of today's status event; the platform sees only
the top-level strings):

```
{ id, event, issueKey, projectKey, issueType, summary, created, author, issueUrl }
```

| kind | extra top-level string fields |
|---|---|
| `status_changed` | `fromStatus`, `toStatus` (unchanged) |
| `issue_created` | `status`, `reporter`, `priority`, `origin` (`human` \| `agent`) |
| `comment_added` | `commentId`, `body` (plain text, clamped to `COMMENT_BODY_MAX = 2000` chars, `bodyTruncated: "true"` when cut — a string so the filter rule holds), `origin` (`human` \| `agent`) |
| `field_changed` | `field` (display name as Jira reports it, e.g. `assignee`, `Fix Version`, `Sprint`), `fieldId` (stable id, e.g. `assignee`, `fixVersions`, `customfield_10020`), `from`, `to`, `fieldType` (`jira` \| `custom`), `origin` (`human` \| `agent`) |

`event` is **always set explicitly** by the extractor (the `|| 'status_changed'`
default in `deliver()` is removed in PR 1). Non-string values (`null`) are
allowed but never filterable — same as today.

### 2.2 Dedup ids (all satisfy `EVENT_ID_RE`)

| kind | id | note |
|---|---|---|
| `status_changed` | `<key>:<historyId>` | unchanged |
| `field_changed` | `<key>:<historyId>.<fieldId>` | one history can carry several items; `fieldId` is `[A-Za-z0-9_]`; if absent, a slug of `field` (`[^A-Za-z0-9]+` → `_`) |
| `comment_added` | `<key>:c<commentId>` | |
| `issue_created` | `<key>:created` | |

`SEEN_MAX` (broker-sdk, 500 per project) — bump to **2000** in the SDK only if
the poller tests show eviction within one 24 h catch-up window on a busy
project; not pre-emptively (the horizon gate already covers evicted stale ids).

### 2.3 Watch config

```
{ projectKey, statusFilters?: string[], events?: string[], jql?, wake }
```

`events` is the per-watch **opt-in set** of kinds. `normalizeWatch` (watch-store.js)
migrates on read: absent/empty → `["status_changed"]`; unknown names dropped;
order canonicalised. So an existing watch is byte-for-byte as noisy as before
after the upgrade. `statusFilters` keep gating `status_changed` only. Exposed
as `KNOWN_EVENTS` from `event-extract.js` (the one list the manifest, the store
and the UI agree on — a test asserts manifest `events[].name` ⊆ `KNOWN_EVENTS`).

`field_changed` denylist (`FIELD_CHANGED_DENY`, event-extract.js): `status`
(own kind), `description` (parked kind, loop risk), `Rank` (noise). Matched
on `field` **or** `fieldId`, case-insensitive. Everything else flows; routing
is the trigger's `field = assignee` / `fieldId = customfield_10020`.

### 2.4 Own-writes registry (`origin`)

New `own-writes-store.js`, per scope, `<stateDir>/own-writes/<scopeId>.json`,
atomic write like the other stores:

```
{ comments:     { "<issueKey>:c<commentId>": "<iso>" },
  issues:       { "<issueKey>": "<iso>" },
  fields:       { "<issueKey>|<fieldId or lower-cased field name>": ["<iso>", …] },
  descriptions: { "<issueKey>": "<iso>" } }
```

- `server.js` records **before** responding to the CLI (the poll that observes
  the write is ≥ 1 tick away, so the write never races the read):
  `/comment` → the comment id; `/create-epic` → the epic key and every created
  story key; `/set-field` → issue + field id when `changed` (`setCustomField`
  returns the resolved `fieldId` for this); `/attachment/add` → issue +
  `attachment`; `/update` → issue (unused by this batch; `description_changed`
  will need it). `/transition` is **not** recorded — `status_changed` keeps
  its current behaviour and gets no `origin` in this batch.
- `field_changed` origin: a changelog item on `<issueKey>` whose `fieldId`
  (or lower-cased `field`) has a registered stamp within ±2 min
  (`OWN_FIELD_WRITE_SKEW_MS`) of the history's `created` → `agent`. A field
  keeps its last 20 stamps so repeated writes all match. A human editing the
  same field in that window is misattributed (a suppressed wake, never a
  spurious one).
- `issue_created` origin: registry only. The *"Created by an agent"* marker
  lives in the description, which the poll does not fetch — not worth widening
  the search for a fallback.
- TTL 7 days, pruned in `reap` alongside the inbox; `teardown` deletes the file.
- Comment `origin` resolution (pure, `event-extract.js` `resolveCommentOrigin`):
  `agent` if the id is registered, **else** `agent` if the comment's first
  paragraph is the attribution marker (`Posted by an agent on team` — the
  string `server.js` emits; export it as a constant and import it in the
  extractor so they cannot drift), else `human`. The marker fallback covers a
  registry lost with the state volume; a human typing the marker only ever
  *suppresses* a wake, never causes one.
- The concept's "never forward own comments" switch is **not** built; the
  documented pattern is the trigger filter `origin = human`.

### 2.5 The wake body per kind

`summariseEvents(kind, events, …)` in server.js becomes kind-aware:

| kind | single | digest |
|---|---|---|
| `status_changed` | `KAN-6: In Progress → Ready for Dev` (unchanged) | `N status changes in KAN` |
| `issue_created` | `KAN-12 created: <summary>` | `N new issues in KAN` |
| `comment_added` | `KAN-6: comment by <author> (<origin>)` | `N comments in KAN` |
| `field_changed` | `KAN-6: <field> <from> → <to>` | `N field changes in KAN` |

Digests stay `{kind:'digest', projectKey?, count, events[], truncated?}` — the
shape `orchestrator/plugin-event.js` projects; they are just single-kind now.

## 3. Work breakdown

**One PR, four ordered commits** (the "PR n" headings below are those
commits). Each commit is green on its own and carries its own tests, manifest
entry, help row and doc paragraph (the convention in
`docs/jira-plugin-plan.md` §8). Sizes are relative (S < M < L). The
own-writes registry is needed from commit 2 on (`issue_created` origin), so
it is introduced there; commits 3 and 4 extend it.

### PR 1 — kind-aware core, no new kinds (M) — *behaviour-preserving refactor*

Goal: after this PR `status_changed` behaves identically and every later PR is
"add an extractor + a manifest entry".

- `event-extract.js`: `extractStatusChangeEvents` sets `event: 'status_changed'`;
  add `KNOWN_EVENTS`, `FIELD_CHANGED_DENY`, `describeEvent(ev)` (the one-line
  human summary used by the log, the UI and `summariseEvents`).
- `watch-store.js`: `events[]` normalisation + migration (§2.3). Tests:
  absent → `["status_changed"]`, unknown dropped, round-trip preserved.
- `poller.js`:
  - `_pollProject` gates per kind: an event whose kind is not in *any* watch's
    `events` → activity `filtered` (`detail: "<kind> is not watched"`);
    `status_changed` additionally through `statusFilters` (unchanged).
  - `_fanOut` partitions `gated` **by `event.event`** and runs the existing
    burst/digest/throttle plan per partition (§1.2). Project burst cap is per
    kind per poll. The log line `queued status_changed (…)` becomes
    `queued <kind> (<describeEvent>)`.
- `server.js`: `deliver()` uses `first.event` (no default); `summariseEvents`
  per §2.5; `promptLine`/manifest untouched here.
- `activity-store.js` `shapeEventForRow`: keep `event` + the kind's extra
  fields (a whitelist per kind from `event-extract.js`, so rows stay small).
- `inbox-store.js`: no change (kind-agnostic already) — assert it in a test.
- `ui/app.js` (inbox + Activity rows) and `bin/aee-jira.py` (`inbox` rendering):
  render via kind (`describeEvent` port in JS; a small `_describe()` in
  Python); Activity gains a **kind** filter next to the issue-type filter.
- `ui/admin.js` + `admin.html`: per row, four checkboxes *Status changes ·
  New issues · Comments · Other field changes* (`events[]`); *Status changes*
  checked by default on a new row; the chip box stays and is labelled as
  applying to status changes.
- `spike.js watch`: accept `--events`.
- Tests: poller — a two-kind gated set yields two `deliver` calls with the
  right `event`; a watch without `comment_added` filters a synthetic comment
  event; existing 20 poller tests unchanged. server — wake body `event`
  equals the event's kind. Manifest test — `events[].name ⊆ KNOWN_EVENTS`.

### PR 2 — `issue_created` (S)

- `jira-client.js`: `buildJqlSearchBody` fields += `created, reporter,
  priority`; `shapeIssue` carries `created, reporter (displayName), priority
  (name)`.
- `event-extract.js` `extractIssueCreatedEvents(issue, {projectKey, siteBase,
  windowStartIso})`: one event when `issue.created` ≥ window start (the JQL
  window is on `updated`, so an old issue touched today must not re-create).
  `created` = `fields.created`.
- `poller.js`: call it beside the status extractor; the horizon gate covers
  the rest (baseline poll records `<key>:created` ids like any other).
- `plugin.json` `events[]` entry with `status, reporter, priority, projectKey,
  issueType, issueKey`; `help/jira.md` fields table row; `docs/jira-plugin.md`
  §5 table.
- Tests: fires once; not on the baseline poll; not for an issue created before
  the window but updated inside it; payload keys are strings.

### PR 3 — `field_changed` (S)

- `event-extract.js` `extractFieldChangeEvents`: every changelog item whose
  `field`/`fieldId` is not in `FIELD_CHANGED_DENY`; id per §2.2; `from`/`to`
  from `fromString`/`toString` (`null` when absent — e.g. an unassign has
  `toString: null`).
- Tests: one history with `status` + `assignee` items yields one status event
  and one field event with distinct ids; `Rank` dropped; `description`
  dropped; `Sprint` custom field carries `fieldId`; id passes `EVENT_ID_RE`
  (import it — export from server.js or move to a tiny `ids.js` both import).
- Manifest entry (`field`, `fieldId`, `from`, `to`, `fieldType`, `author`, …),
  help row with the *"Only when… `field = assignee`"* example, doc paragraph
  naming the denylist.

### PR 4 — `comment_added` with `origin` (L)

- `jira-client.js`: search fields += `comment`; new `adfToText(node)` (pure —
  paragraphs joined by `\n`, `text` nodes concatenated, `hardBreak` → `\n`,
  mentions → `@displayName`, everything else recursed; tested on a fixture
  with a code block and a mention). New `fetchRecentComments(cred, key,
  {sinceIso})` over `GET /rest/api/3/issue/{key}/comment?orderBy=-created&
  maxResults=50` used **only** when `fields.comment.total >
  fields.comment.comments.length` (the changelog-truncation pattern —
  `isCommentListTruncated`). Stop paginating at the first comment older than
  the window.
- `own-writes-store.js` (§2.4) + `server.js` wiring in `/comment` and
  `/update`; `reap`/`teardown` hooks in `pollScope` and the teardown endpoint.
- `event-extract.js` `extractCommentEvents(issue, {…, isOwnComment})`: one
  event per comment with `created` in the window; `body` = clamped
  `adfToText`; `origin` per §2.4; skip the attribution paragraph itself from
  `body` when `origin = agent` (the agent should read its own text, not the
  provenance line).
- `poller.js`: call it; `resolveCredential` unchanged.
- `promptLine` + manifest `description`: a wake may be a new issue, a comment
  or a field change — read `event` (and `origin` on a comment) from the wake
  payload before acting; `aee-jira show` for the full text when
  `bodyTruncated`.
- Help: a dedicated *"Avoid the comment loop"* section — `origin = human` on
  every `comment_added` trigger unless the agent is deliberately waiting for a
  teammate's comment; then filter on `origin = agent` **and** something else,
  and never have two agents both listening on `origin = agent` for the same
  project without a `payloadFilter` that separates them.
- Tests: own comment → `origin: agent`; marker-only (registry empty) →
  `agent`; a plain comment by the same account → `human`; body clamp +
  `bodyTruncated: "true"`; truncated comment list triggers the backfill call
  exactly once per issue; registry TTL prune; teardown deletes it; a comment
  created before `lastPolledAt` on a re-touched issue is `stale`.

### After PR 4 — verification pass (S)

- `corpus.test.js` budget: the grown `help/jira.md` must still fit; if not,
  move the per-kind fields tables into `docs/jira-plugin.md` and keep only the
  routing keys in the help topic.
- Manual walkthrough against a real site (the `jira-test` team): create an
  issue → BA wakes (`issue_created`); human comments → wake with
  `origin=human`; agent replies with `aee-jira comment` → **no** second wake
  on a trigger filtered `origin = human`; reassign → `field_changed` with
  `field=assignee`; sprint-plan 10 tickets → one status digest, and the
  accompanying `Sprint` field changes → one field digest (two wakes, not 20).

## 4. Files touched (checklist)

| file | PR |
|---|---|
| `broker/event-extract.js` (+ test) | 1 2 3 4 |
| `broker/watch-store.js` (+ test) | 1 |
| `broker/poller.js` (+ test) | 1 2 3 4 |
| `broker/server.js` (+ test) | 1 2 3 4 |
| `broker/activity-store.js` (+ test) | 1 |
| `broker/jira-client.js` (+ test) | 2 4 |
| `broker/own-writes-store.js` (new, + test) | 2 3 4 |
| `broker/ui/app.js`, `ui/admin.js`, `ui/admin.html`, `ui/styles.css` | 1 |
| `broker/spike.js` | 1 |
| `bin/aee-jira.py` | 1 4 (usage text) |
| `plugin.json` (`events[]`, `description`, `promptLine`) | 2 3 4 |
| `help/jira.md` | 1 2 3 4 |
| `docs/jira-plugin.md` §5 + Limits + Troubleshooting | 2 3 4 |
| `docs/jira-plugin-events-plan.md` status line | 4 |
| `CLAUDE.md` Jira paragraph (one clause: "status changes, new issues, comments, field changes") | 4 |

No file under `orchestrator/`, `admin-console/` or `broker-sdk/` (the
`SEEN_MAX` bump is conditional, §2.2).

## 5. Test strategy

- Unit, `node --test plugins/jira/broker/` — the existing fake-fetch harness in
  `poller.test.js` (`issue(key, histories)`, `statusHistory(...)`) grows
  `commentField(...)`, `fieldHistory(id, field, fieldId, from, to, created)`
  and `createdAt(iso)` helpers; the fake Jira gains a `/comment` route.
- Golden payloads: one fixture per kind under `broker/fixtures/` asserted
  against the manifest's `events[].payload[].key` (every declared key present
  and a string on a representative event — the contract the trigger form
  shows users).
- Parity: `manifest events[].name ⊆ KNOWN_EVENTS`; `EVENT_ID_RE.test(id)` for
  every extractor's ids.
- No console/orchestrator test changes; `plugin-event.test.js` already covers
  `eventFilter`/`payloadFilter` against arbitrary event names.

## 6. Rollout / upgrade

1. Build: `podman build -t localhost/aee-plugin-jira:latest plugins/jira/broker`
   (+ `make seed-plugins` to refresh `/template-workspace/plugins/`).
2. **Refresh the installed copy in place** — do *not* uninstall (it reaps
   every team's credential, §1.9): copy `plugin.json`, `bin/`, `help/` from
   `plugins/jira/` over `/workspace/plugins/jira/`. The registry re-validates
   the manifest on read; granted CLI copies refresh on the next plugin
   reconcile (`planCliRefresh`); the help topic loads on the next console
   request. Write this recipe into `docs/jira-plugin.md` *Setup* as
   "Upgrading". (A `POST /api/plugins/:id/install?force=1` that overwrites
   files but keeps credentials would be the proper fix — out of scope,
   note it in the plugin-system concept's deferred list.)
3. Restart the sidecar (`make restart` or the orchestrator's plugin reconcile
   after the image tag changes). The watch store and cursors live on the
   state volume and survive; `events[]` migrates on read, so **no watch gets
   noisier until a Team Admin ticks a box**.
4. First poll after upgrade: unseen `:created`/`:c<id>`/`.<fieldId>` ids inside
   the window are gated by the horizon — only what happened since the last
   successful poll fires. Verified by the "stale" tests per kind.
5. Existing triggers: a trigger with blank *Which event* and **no**
   `payloadFilter` would wake on every newly enabled kind. The admin-page
   checkbox help text says so, and the how-to's §5 gets a sentence: set
   *Which event* on every trigger once more than one kind is enabled.

## 7. Decisions on the concept's open questions (§7)

- **Generic vs named field events** — generic only for now; `field`/`fieldId`
  routing covers assignee/priority/labels/sprint/fixVersion. Named kinds can
  be added later as sugar over `extractFieldChangeEvents` without changing ids
  (they would be *new* ids, so they must never coexist with the generic one on
  the same watch — decide then).
- **Comment body clamp** — 2000 chars inline + `bodyTruncated`; the full text
  is one `aee-jira show`/`inbox` away (the inbox entry holds the clamped body
  too — the inbox is not a comment store).
- **Traffic on a busy project** — the per-issue throttle (5/h, shared across
  kinds) and the per-kind digests bound it; opt-in per watch is the real
  brake. Revisit `checkAndIncThrottle`'s threshold only with evidence from the
  Activity log's `throttled` rows.
- **Throttle/burst keys shared across kinds** (§1.10) — kept shared: the
  throttle is loop protection for *an issue's conversation*, and a comment
  loop is exactly the case it must catch. Cost: a status change and four
  comments on one issue in one hour drop the fifth wake. Acceptable; noted in
  the help.
- **Own-comment suppression switch** — not built (§2.4).
- **`SEEN_MAX`** — unchanged unless tests prove eviction (§2.2).
