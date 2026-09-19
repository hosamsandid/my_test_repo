# Jira: status-routed wakes, `aee-jira update`, CLI refresh — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Jira status change wakes only the agent whose `plugin-event` trigger names that target status; a woken agent can rewrite the ticket description and transition it (which wakes the next agent); and a stale `aee-jira` copy in an agent workspace is refreshed on every plugin reconcile instead of only at grant time.

**Architecture:** Three independent slices along existing seams. (A) The generic `plugin-event` trigger gains an optional `payloadFilter` object matched against the delivered payload's top-level string fields — in the orchestrator's pure `plugin-event.js`, mirrored in the agent runtime's re-resolve (`agent-entrypoint.py`), authored in `TriggerForm` through a new pure `plugin-event-filter.js`. The platform still learns nothing about Jira (§D5 of `docs/jira-plugin-plan.md`); the Jira docs say which keys exist. (B) `aee-jira update KAN-10 --description "…"` follows the `comment` pattern exactly: CLI subcommand → broker `writeOps['/update']` → `jira-client.updateDescription` (`PUT /rest/api/3/issue/{key}`, whole description replaced as ADF, attribution paragraph appended) → `broker-policy` + manifest `policy`. (C) A pure `planCliRefresh` in `plugin-sync.js` decides which granted CLI copies differ from the registry; `reconcilePluginsAndAttachments` applies it.

**Tech Stack:** Node 22 (`node --test`, dependency-free modules), Python 3.12 (`pytest` for the agent runtime, stdlib-only CLI), React 18 JSX (untested per #651 — guarded by source-reading tests).

**Spec:** No separate spec file. The design was settled in the conversation of 2026-09-15 and is restated in *Design decisions* below; this plan is the record.

## Global Constraints

- **Branch:** all work lands on `feat/jira-events-plugin`, which is checked out in the main working copy. Commit directly on it (no worktree needed for inline execution). Leave the pre-existing uncommitted `docs/jira-plugin-plan.md` change alone — it is the user's.
- **Test commands** (each is one CI job):
  - orchestrator: `cd orchestrator && npm test` (= `node --test`), single file: `node --test plugin-event.test.js`
  - jira broker: `cd plugins/jira/broker && node --test`
  - admin-console src: `cd admin-console && node --test "src/**/*.test.js"`
  - agent runtime: `cd agent-image/scripts && python -m pytest test_agent_entrypoint.py -q` (add `-k PluginEvent` while iterating)
- **Pure-module discipline:** every decision in a `node --test`-able module; JSX and `orchestrator.js` I/O are wired, and the wiring is pinned by a source-reading test that strips comments first (`plugin-event-select-wiring.test.js` is the model for JSX, `internal-auth-wiring.test.js` for `orchestrator.js`).
- **§D5 — the platform stays Jira-agnostic.** No `toStatus`, `Jira`, or status vocabulary in `orchestrator/plugin-event.js`, `agent-entrypoint.py` or the shared `TriggerForm` copy beyond an *example*. The filter is a generic `{ key: value }` on the payload.
- **Exact-match, case-sensitive**, the `labelFilter` precedent. Only top-level **string** payload fields are comparable (booleans/numbers stringify differently in JS vs Python and would drift).
- **Existing guard to keep green:** `admin-console/src/pages/agent-chat/plugin-event-select-wiring.test.js` asserts `label="Event filter (optional)"` survives and that `pluginId` stays a `<select>`. Add the new field *next to* the event filter; do not restructure the block.
- **Copy:** UI strings in English. Commit messages in this branch's style: `feat(jira-plugin): …`, `test(jira-plugin): …`, `docs(jira-plugin): …`, `feat(plugins): …` for the generic pieces.
- **Manifest policy mirror:** `plugins/jira/broker/broker-policy.js` `POLICY` must stay `deepEqual` to `plugins/jira/plugin.json` `policy` (there is a test for it). Change both in the same commit.

## Design decisions (from the conversation)

1. **Routing lives on the trigger, not in the watch.** The Jira admin UI's `wake.agentIds` has been dead since Phase 2 (`server.js:368` says so); the per-agent `plugin-event` trigger is the one place "who wakes" is decided. A `payloadFilter` extends that trigger rather than reviving the watch field. The `app.js` remnants that still *display* `wake.agentIds` are removed (Task 8).
2. **`payloadFilter` is generic.** `{ "<payloadKey>": "<exact string>" }`, all keys must match, empty/absent = today's behaviour (any event). A digest payload (`{kind:'digest', events:[…]}`) matches when **any** contained event matches — a digest of five transitions that includes one into "Ready for Dev" must still wake the Developer.
3. **Both sides match with the same rule.** The orchestrator picks targets; the agent runtime re-resolves the trigger on drain (an edit between enqueue and drain must not strand or mis-fire a wake — `_execute_plugin_event`'s existing rule). Same rule, two languages, each unit-tested.
4. **`update` replaces the whole description**, as ADF paragraphs, with an italic attribution paragraph appended (the comment puts it first; on a description that a human wrote, last reads better). The previous text survives in Jira's own history. Role-gated like `comment`/`transition` (D3 — no approval pen; not destructive, reversible via history).
5. **CLI refresh compares bytes, not versions** — a sha256 of the registry entrypoint vs the workspace copy. Missing or different → copy + `0755`; otherwise untouched. Applied on every `reconcilePluginsAndAttachments` (boot, install/uninstall, `POST /internal/plugins/reconcile`), best-effort per agent, then `reseedAgent(id, ['.agent-studio'])` so an isolated volume gets the copy too. Never a respawn.
6. **The Jira docs own the key vocabulary.** `docs/jira-plugin.md` §5 states the payload keys (`toStatus`, `fromStatus`, `projectKey`, `issueKey`, `issueType`) and the manifest `promptLine` names `update`.

## File structure

| File | Responsibility |
|---|---|
| **Modify** `orchestrator/plugin-event.js` | + `normalizePayloadFilter`, `matchesPayloadFilter`; `matchesPluginEventTrigger`/`resolvePluginEventTargets` take `payload`. |
| **Modify** `orchestrator/plugin-event.test.js` | Tests for the above. |
| **Modify** `orchestrator/orchestrator.js` (`/internal/plugin-event` route ~line 13200; `reconcilePluginsAndAttachments` ~line 2876) | Pass `payload` to the resolver; call `refreshGrantedPluginClis()`. |
| **Modify** `agent-image/scripts/agent-entrypoint.py` (`_execute_plugin_event` ~line 5557) | + `_matches_payload_filter` mirror, used by `_base_match`. |
| **Modify** `agent-image/scripts/test_agent_entrypoint.py` (`PluginEventDelivery` ~line 4687) | Drain tests for the filter. |
| **Create** `admin-console/src/pages/agent-chat/plugin-event-filter.js` | Pure: `parsePayloadFilter` (text → object / error), `formatPayloadFilter` (object → text), `payloadFilterSummary` (row copy). |
| **Create** `admin-console/src/pages/agent-chat/plugin-event-filter.test.js` | Unit tests. |
| **Modify** `admin-console/src/pages/agent-chat/TriggersPanel.jsx` (state ~638, row summary ~330, validation ~826, body ~877, JSX ~997) | The *Payload filter* field, validation, wire shape, row summary. |
| **Modify** `admin-console/src/pages/agent-chat/plugin-event-select-wiring.test.js` | + guard that the filter field is wired through the pure module. |
| **Modify** `plugins/jira/broker/jira-client.js` | + `descriptionAdf`, `updateDescription`. |
| **Modify** `plugins/jira/broker/jira-client.test.js` | Tests. |
| **Modify** `plugins/jira/broker/broker-policy.js`, `plugins/jira/plugin.json` | + `update` policy rule; manifest `promptLine`/`description` name `update`. |
| **Modify** `plugins/jira/broker/broker-policy.test.js` | `update` allowed. |
| **Modify** `plugins/jira/broker/server.js` (`writeOps` ~line 272) | `/update` write op. |
| **Modify** `plugins/jira/broker/server.test.js` | Route test. |
| **Modify** `plugins/jira/bin/aee-jira.py` | `update` subcommand + docstring. |
| **Modify** `orchestrator/plugin-cli-contract.test.js` (~line 543/587) | `update` in `--help`; usage exit 2 without `--description`. |
| **Modify** `orchestrator/plugin-sync.js` | + `planCliRefresh`. |
| **Modify** `orchestrator/plugin-sync.test.js` | Tests. |
| **Create** `orchestrator/plugin-cli-refresh-wiring.test.js` | Source guard: `refreshGrantedPluginClis` exists, hashes both files, is called from `reconcilePluginsAndAttachments`. |
| **Modify** `plugins/jira/broker/ui/app.js` (`wakeText` ~238, `healthyDetail` ~289) | Drop the dead `wake.agentIds` display. |
| **Modify** `docs/jira-plugin.md` (§5 ~line 102, CLI table ~118, troubleshooting ~195) | Payload filter, `update`, stale-CLI row. |

---

### Task 1: Payload filter in the orchestrator's pure core

**Files:**
- Modify: `orchestrator/plugin-event.js`
- Test: `orchestrator/plugin-event.test.js`

**Interfaces:**
- Produces: `normalizePayloadFilter(filter) → {key: string}|null`; `matchesPayloadFilter(filter, payload) → boolean`; `matchesPluginEventTrigger(trigger, { pluginId, event, payload })`; `resolvePluginEventTargets({ pluginId, event, payload }, agents)`. Task 2 (orchestrator.js) passes `payload`; Task 3 mirrors the rule in Python.

- [ ] **Step 1: Write the failing tests**

Append to `orchestrator/plugin-event.test.js` (after the existing `resolve:` test), and add `normalizePayloadFilter, matchesPayloadFilter` to the destructured `require` at the top:

```js
// ── payloadFilter ──────────────────────────────────────────────────────────

test('normalizePayloadFilter: trims keys/values, drops blanks and non-strings, null when empty', () => {
  assert.equal(normalizePayloadFilter(undefined), null);
  assert.equal(normalizePayloadFilter(null), null);
  assert.equal(normalizePayloadFilter('x'), null);
  assert.equal(normalizePayloadFilter([]), null);
  assert.equal(normalizePayloadFilter({}), null);
  assert.equal(normalizePayloadFilter({ toStatus: '  ' }), null);
  assert.equal(normalizePayloadFilter({ toStatus: 5 }), null);            // non-string value is not a filter
  assert.deepEqual(normalizePayloadFilter({ ' toStatus ': ' Ready for Dev ', x: '' }), { toStatus: 'Ready for Dev' });
});

test('matchesPayloadFilter: no filter matches anything; every key must equal a top-level STRING field exactly', () => {
  assert.equal(matchesPayloadFilter(null, null), true);
  assert.equal(matchesPayloadFilter({}, { toStatus: 'x' }), true);
  const f = { toStatus: 'Ready for Dev' };
  assert.equal(matchesPayloadFilter(f, { toStatus: 'Ready for Dev' }), true);
  assert.equal(matchesPayloadFilter(f, { toStatus: 'ready for dev' }), false);   // case-sensitive, the labelFilter rule
  assert.equal(matchesPayloadFilter(f, { toStatus: 'In Progress' }), false);
  assert.equal(matchesPayloadFilter(f, {}), false);
  assert.equal(matchesPayloadFilter(f, null), false);                          // a filter with no payload cannot match
  assert.equal(matchesPayloadFilter(f, { toStatus: { name: 'Ready for Dev' } }), false); // only string fields compare
  assert.equal(matchesPayloadFilter({ toStatus: 'Ready for Dev', projectKey: 'KAN' }, { toStatus: 'Ready for Dev', projectKey: 'OPS' }), false);
  assert.equal(matchesPayloadFilter({ toStatus: 'Ready for Dev', projectKey: 'KAN' }, { toStatus: 'Ready for Dev', projectKey: 'KAN' }), true);
});

test('matchesPayloadFilter: a digest payload matches when ANY contained event matches', () => {
  const f = { toStatus: 'Ready for Dev' };
  const digest = { kind: 'digest', count: 2, events: [{ toStatus: 'In Progress' }, { toStatus: 'Ready for Dev' }] };
  assert.equal(matchesPayloadFilter(f, digest), true);
  assert.equal(matchesPayloadFilter(f, { kind: 'digest', count: 1, events: [{ toStatus: 'Done' }] }), false);
  assert.equal(matchesPayloadFilter(f, { kind: 'digest', count: 0, events: [] }), false);
});

test('match: payloadFilter gates the trigger; absent filter is byte-identical to today', () => {
  const ev = { pluginId: 'jira', event: 'status_changed', payload: { toStatus: 'Ready for Dev' } };
  assert.equal(matchesPluginEventTrigger(T(), ev), true);
  assert.equal(matchesPluginEventTrigger(T({ payloadFilter: { toStatus: 'Ready for Dev' } }), ev), true);
  assert.equal(matchesPluginEventTrigger(T({ payloadFilter: { toStatus: 'Done' } }), ev), false);
  // A filter on a trigger whose event does not match is still a miss.
  assert.equal(matchesPluginEventTrigger(T({ eventFilter: 'commented', payloadFilter: { toStatus: 'Ready for Dev' } }), ev), false);
  // A malformed filter (not an object) is treated as no filter, never as "match nothing".
  assert.equal(matchesPluginEventTrigger(T({ payloadFilter: 'Ready for Dev' }), ev), true);
});

test('resolve: two agents on the same plugin are routed apart by their payloadFilter', () => {
  const agents = [
    { agentId: 'ba', inScope: true, granted: true, triggers: [T({ id: 'ba-t', payloadFilter: { toStatus: 'Ready for Refinement' } })] },
    { agentId: 'dev', inScope: true, granted: true, triggers: [T({ id: 'dev-t', payloadFilter: { toStatus: 'Ready for Dev' } })] },
    { agentId: 'any', inScope: true, granted: true, triggers: [T({ id: 'any-t' })] },
  ];
  const targets = resolvePluginEventTargets(
    { pluginId: 'jira', event: 'status_changed', payload: { toStatus: 'Ready for Dev' } }, agents);
  assert.deepEqual(targets, [{ agentId: 'dev', triggerId: 'dev-t' }, { agentId: 'any', triggerId: 'any-t' }]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd orchestrator && node --test plugin-event.test.js`
Expected: FAIL — `normalizePayloadFilter is not a function` (the require destructures `undefined`).

- [ ] **Step 3: Implement**

In `orchestrator/plugin-event.js`, replace the `matchesPluginEventTrigger` block (from its comment through the closing brace) with:

```js
// ── payloadFilter ──────────────────────────────────────────────────────────
// An optional `{ key: value }` on the trigger, matched against the delivered
// payload's TOP-LEVEL STRING fields — all keys must match, exactly and
// case-sensitively (the `labelFilter` rule). Absent / empty / malformed = no
// filter. Deliberately generic: the platform does not know that a Jira payload
// carries `toStatus`; the plugin's docs say which keys exist (§D5). Only string
// fields compare, because JS and Python stringify booleans and numbers
// differently and the agent runtime mirrors this rule.
function normalizePayloadFilter(filter) {
  if (!filter || typeof filter !== 'object' || Array.isArray(filter)) return null;
  const out = {};
  for (const [k, v] of Object.entries(filter)) {
    const key = String(k).trim();
    if (!key || typeof v !== 'string' || !v.trim()) continue;
    out[key] = v.trim();
  }
  return Object.keys(out).length ? out : null;
}

function payloadFieldsMatch(filter, payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  return Object.entries(filter).every(([k, v]) => typeof payload[k] === 'string' && payload[k] === v);
}

// A burst digest (`{kind:'digest', events:[…]}`, the Jira broker's shape)
// matches when ANY of its events would have matched on its own — a digest that
// folds one wanted transition in with four others must still wake the agent.
function matchesPayloadFilter(filter, payload) {
  const f = normalizePayloadFilter(filter);
  if (!f) return true;
  if (payload && typeof payload === 'object' && payload.kind === 'digest' && Array.isArray(payload.events)) {
    return payload.events.some((e) => payloadFieldsMatch(f, e));
  }
  return payloadFieldsMatch(f, payload);
}

// Does one trigger listen for this plugin event? `plugin-event` type, matching
// `pluginId`, enabled, either no `eventFilter` (any event) or an exact match on
// the event name, and — when the trigger carries a `payloadFilter` — a payload
// that satisfies it. `eventFilter` and the filter keys are opaque to the
// platform — they are the broker's vocabulary (§4B).
function matchesPluginEventTrigger(trigger, { pluginId, event, payload } = {}) {
  if (!trigger || typeof trigger !== 'object') return false;
  if (trigger.type !== PLUGIN_EVENT_TRIGGER_TYPE) return false;
  if (trigger.enabled === false) return false;
  if (trigger.pluginId !== pluginId) return false;
  const filter = typeof trigger.eventFilter === 'string' ? trigger.eventFilter.trim() : '';
  if (filter && filter !== event) return false;
  return matchesPayloadFilter(trigger.payloadFilter, payload);
}
```

Then change `resolvePluginEventTargets`'s signature and the inner `find` call:

```js
function resolvePluginEventTargets({ pluginId, event, payload = null }, agents) {
  const out = [];
  for (const a of Array.isArray(agents) ? agents : []) {
    if (!a || typeof a.agentId !== 'string' || !a.agentId) continue;
    if (!a.inScope || !a.granted) continue;
    const match = (Array.isArray(a.triggers) ? a.triggers : [])
      .find((t) => matchesPluginEventTrigger(t, { pluginId, event, payload }));
    if (match) out.push({ agentId: a.agentId, triggerId: match.id || null });
  }
  return out;
}
```

Add `normalizePayloadFilter,` and `matchesPayloadFilter,` to `module.exports`. In the file's header comment, after the `eventFilter` line in the `POST /internal/plugin-event` shape, add one line: `//   The consumer's trigger may also carry `payloadFilter: { key: value }` — see below.`

- [ ] **Step 4: Run the tests**

Run: `cd orchestrator && node --test plugin-event.test.js`
Expected: PASS (all, including the pre-existing ones — an absent filter is unchanged behaviour).

- [ ] **Step 5: Commit**

```bash
git add orchestrator/plugin-event.js orchestrator/plugin-event.test.js
git commit -m "feat(plugins): plugin-event triggers may filter on the delivered payload"
```

---

### Task 2: Pass the payload through the `/internal/plugin-event` route

**Files:**
- Modify: `orchestrator/orchestrator.js` (~line 13209, `const targets = pluginEvent.resolvePluginEventTargets({ pluginId, event }, agents);`)
- Test: `orchestrator/plugin-cli-refresh-wiring.test.js` (created here with its first guard; Task 7 adds the CLI-refresh guards to the same file)

**Interfaces:**
- Consumes: `resolvePluginEventTargets({ pluginId, event, payload }, agents)` from Task 1.

- [ ] **Step 1: Write the failing source guard**

Create `orchestrator/plugin-cli-refresh-wiring.test.js`:

```js
"use strict";

// Source-reading drift guard for two `orchestrator.js`-only properties of the
// plugin-event / plugin-CLI wiring. Both fail SILENTLY — the platform keeps
// working, only the property is gone:
//
//   AC1  `POST /internal/plugin-event` must hand the PAYLOAD to
//        `resolvePluginEventTargets`. Without it every `payloadFilter` reads as
//        "no payload" and a filtered trigger never fires — the exact symptom
//        this filter exists to remove ("everything runs, nothing wakes").
//
//   AC2/AC3 (Task 7): granted plugin CLIs are refreshed from the registry on
//        every reconcile, by comparing a digest of both files.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SRC = fs.readFileSync(path.join(__dirname, "orchestrator.js"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

function between(start, end) {
  const i = SRC.indexOf(start);
  assert.notEqual(i, -1, `marker not found: ${start}`);
  const j = SRC.indexOf(end, i);
  return SRC.slice(i, j === -1 ? undefined : j);
}

test("AC1: the plugin-event route resolves targets WITH the payload", () => {
  const route = between("req.url === '/internal/plugin-event'", "Internal label fast-path");
  assert.match(route, /resolvePluginEventTargets\(\{ pluginId, event, payload \}, agents\)/);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd orchestrator && node --test plugin-cli-refresh-wiring.test.js`
Expected: FAIL on AC1 (the current call is `{ pluginId, event }`).

- [ ] **Step 3: Implement**

In `orchestrator/orchestrator.js`, in the `/internal/plugin-event` handler, change

```js
          const targets = pluginEvent.resolvePluginEventTargets({ pluginId, event }, agents);
```
to
```js
          // The payload takes part in target resolution: a trigger's
          // `payloadFilter` (plugin-event.js) is matched against it, which is
          // how two agents on one plugin are routed apart by, e.g., a status.
          const targets = pluginEvent.resolvePluginEventTargets({ pluginId, event, payload }, agents);
```

- [ ] **Step 4: Run the guard + the orchestrator suite**

Run: `cd orchestrator && node --test plugin-cli-refresh-wiring.test.js && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add orchestrator/orchestrator.js orchestrator/plugin-cli-refresh-wiring.test.js
git commit -m "feat(plugins): the plugin-event route routes on the payload"
```

---

### Task 3: Mirror the rule in the agent runtime's drain

**Files:**
- Modify: `agent-image/scripts/agent-entrypoint.py` (`_execute_plugin_event`, ~line 5557; module-level helpers near `_PLUGIN_EVENT_TRIGGER_TYPE`, ~line 3171)
- Test: `agent-image/scripts/test_agent_entrypoint.py` (class `PluginEventDelivery`, ~line 4687)

**Interfaces:**
- Produces: `_normalize_payload_filter(raw) → dict`, `_matches_payload_filter(raw, payload) → bool` (module-level, importable by the test as `entrypoint._matches_payload_filter`).

- [ ] **Step 1: Write the failing tests**

Add to class `PluginEventDelivery` (after `test_wrong_plugin_id_skips`):

```python
    def test_payload_filter_rule_mirrors_plugin_event_js(self):
        m = entrypoint._matches_payload_filter
        # no filter → anything
        self.assertTrue(m(None, None))
        self.assertTrue(m({}, {"toStatus": "x"}))
        self.assertTrue(m("not-a-dict", {"toStatus": "x"}))
        self.assertTrue(m({"toStatus": "  "}, {}))          # blank value = no filter
        self.assertTrue(m({"toStatus": 5}, {}))             # non-string value = no filter
        f = {" toStatus ": " Ready for Dev "}
        self.assertTrue(m(f, {"toStatus": "Ready for Dev"}))
        self.assertFalse(m(f, {"toStatus": "ready for dev"}))   # case-sensitive
        self.assertFalse(m(f, {}))
        self.assertFalse(m(f, None))
        self.assertFalse(m(f, {"toStatus": {"name": "Ready for Dev"}}))  # only string fields compare
        self.assertFalse(m({"toStatus": "Ready for Dev", "projectKey": "KAN"},
                           {"toStatus": "Ready for Dev", "projectKey": "OPS"}))
        # digest: any contained event
        digest = {"kind": "digest", "count": 2, "events": [{"toStatus": "Done"}, {"toStatus": "Ready for Dev"}]}
        self.assertTrue(m(f, digest))
        self.assertFalse(m(f, {"kind": "digest", "count": 0, "events": []}))

    async def test_payload_filter_mismatch_skips(self):
        scheduler = self._scheduler()
        entrypoint._save_triggers([{
            "id": "on-dev", "type": "plugin-event", "enabled": True,
            "pluginId": "jira", "payloadFilter": {"toStatus": "Ready for Dev"}, "prompt": "p",
        }])
        self._queue({
            "kind": "plugin-event", "pluginId": "jira", "event": "status_changed",
            "payload": {"toStatus": "In Progress"}, "triggerId": "on-dev",
        })
        scheduler._execute = AsyncMock()
        await scheduler._process_pending()
        scheduler._execute.assert_not_awaited()

    async def test_payload_filter_picks_the_right_trigger_over_the_stamped_id(self):
        # The orchestrator stamped the first match; the consumer re-resolves
        # with the same rule and must land on the trigger whose filter matches.
        scheduler = self._scheduler()
        entrypoint._save_triggers([
            {"id": "on-ba", "type": "plugin-event", "enabled": True, "pluginId": "jira",
             "payloadFilter": {"toStatus": "Ready for Refinement"}, "prompt": "ba"},
            {"id": "on-dev", "type": "plugin-event", "enabled": True, "pluginId": "jira",
             "payloadFilter": {"toStatus": "Ready for Dev"}, "prompt": "dev"},
        ])
        self._queue({
            "kind": "plugin-event", "pluginId": "jira", "event": "status_changed",
            "payload": {"toStatus": "Ready for Dev"}, "triggerId": "on-ba",
        })
        scheduler._execute = AsyncMock()
        await scheduler._process_pending()
        scheduler._execute.assert_awaited_once()
        trigger, = scheduler._execute.await_args.args
        self.assertEqual(trigger["id"], "on-dev")
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd agent-image/scripts && python -m pytest test_agent_entrypoint.py -k PluginEventDelivery -q`
Expected: FAIL — `AttributeError: module has no attribute '_matches_payload_filter'` and the two drain tests (the mismatch case currently *runs* the trigger).

- [ ] **Step 3: Implement**

Directly below `_PLUGIN_EVENT_TRIGGER_TYPE = "plugin-event"` (~line 3171) add:

```python


def _normalize_payload_filter(raw):
    """Mirror of `normalizePayloadFilter` in orchestrator/plugin-event.js:
    a `{key: value}` on a plugin-event trigger, keys/values trimmed, blank or
    non-string values dropped. `{}` means "no filter"."""
    if not isinstance(raw, dict):
        return {}
    out = {}
    for k, v in raw.items():
        key = str(k).strip()
        if key and isinstance(v, str) and v.strip():
            out[key] = v.strip()
    return out


def _payload_fields_match(flt, payload):
    if not isinstance(payload, dict):
        return False
    for k, v in flt.items():
        val = payload.get(k)
        if not isinstance(val, str) or val != v:
            return False
    return True


def _matches_payload_filter(raw, payload):
    """Mirror of `matchesPayloadFilter` in orchestrator/plugin-event.js — the
    consumer re-resolves its trigger on drain with the SAME rule the
    orchestrator used to pick it. All keys must equal a top-level STRING field
    exactly (case-sensitive, the labelFilter rule); a burst digest matches when
    any contained event does. Keep the two in sync."""
    flt = _normalize_payload_filter(raw)
    if not flt:
        return True
    if isinstance(payload, dict) and payload.get("kind") == "digest" and isinstance(payload.get("events"), list):
        return any(_payload_fields_match(flt, e) for e in payload["events"])
    return _payload_fields_match(flt, payload)
```

In `_execute_plugin_event`, after the `wanted = …` line add:

```python
        payload = entry.get("payload") if isinstance(entry.get("payload"), dict) else None
```

and change the end of `_base_match`:

```python
            flt = t.get("eventFilter")
            flt = flt.strip() if isinstance(flt, str) else ""
            if flt and flt != event:
                return False
            return _matches_payload_filter(t.get("payloadFilter"), payload)
```

Update the docstring sentence *"it falls back to the first trigger that still matches this plugin + event"* to *"… this plugin + event + payloadFilter"*.

- [ ] **Step 4: Run the tests**

Run: `cd agent-image/scripts && python -m pytest test_agent_entrypoint.py -q`
Expected: PASS (whole file).

- [ ] **Step 5: Commit**

```bash
git add agent-image/scripts/agent-entrypoint.py agent-image/scripts/test_agent_entrypoint.py
git commit -m "feat(plugins): agent drain re-resolves plugin-event triggers with the payload filter"
```

---

### Task 4: Author the filter in `TriggerForm`

**Files:**
- Create: `admin-console/src/pages/agent-chat/plugin-event-filter.js`
- Create: `admin-console/src/pages/agent-chat/plugin-event-filter.test.js`
- Modify: `admin-console/src/pages/agent-chat/TriggersPanel.jsx`
- Modify: `admin-console/src/pages/agent-chat/plugin-event-select-wiring.test.js`

**Interfaces:**
- Produces: `parsePayloadFilter(text) → { ok: true, value: object|null } | { ok: false, error: string }`; `formatPayloadFilter(filter) → string`; `payloadFilterSummary(filter) → string`. Wire shape on the trigger: `payloadFilter: object | null` (`null` clears on PUT, the `eventFilter` precedent).

- [ ] **Step 1: Write the failing unit tests**

Create `admin-console/src/pages/agent-chat/plugin-event-filter.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePayloadFilter, formatPayloadFilter, payloadFilterSummary } from './plugin-event-filter.js';

test('parsePayloadFilter: one key=value per line; blank text → null (no filter)', () => {
  assert.deepEqual(parsePayloadFilter(''), { ok: true, value: null });
  assert.deepEqual(parsePayloadFilter('  \n\n'), { ok: true, value: null });
  assert.deepEqual(parsePayloadFilter(undefined), { ok: true, value: null });
  assert.deepEqual(parsePayloadFilter('toStatus=Ready for Dev'), { ok: true, value: { toStatus: 'Ready for Dev' } });
  assert.deepEqual(
    parsePayloadFilter(' toStatus = Ready for Dev \r\nprojectKey=KAN\n'),
    { ok: true, value: { toStatus: 'Ready for Dev', projectKey: 'KAN' } },
  );
});

test('parsePayloadFilter: the value keeps an inner "=" (only the first splits)', () => {
  assert.deepEqual(parsePayloadFilter('summary=a=b'), { ok: true, value: { summary: 'a=b' } });
});

test('parsePayloadFilter: a line without "=", an empty key or an empty value is an error naming the line', () => {
  assert.deepEqual(parsePayloadFilter('Ready for Dev'), { ok: false, error: 'Line 1 must be key=value: "Ready for Dev"' });
  assert.deepEqual(parsePayloadFilter('toStatus=Ready for Dev\n=x'), { ok: false, error: 'Line 2 must be key=value: "=x"' });
  assert.deepEqual(parsePayloadFilter('toStatus='), { ok: false, error: 'Line 1 must be key=value: "toStatus="' });
});

test('parsePayloadFilter: a repeated key keeps the last value', () => {
  assert.deepEqual(parsePayloadFilter('a=1\na=2'), { ok: true, value: { a: '2' } });
});

test('formatPayloadFilter round-trips an object into the editor text; nothing → ""', () => {
  assert.equal(formatPayloadFilter({ toStatus: 'Ready for Dev', projectKey: 'KAN' }), 'toStatus=Ready for Dev\nprojectKey=KAN');
  assert.equal(formatPayloadFilter(null), '');
  assert.equal(formatPayloadFilter(undefined), '');
  assert.equal(formatPayloadFilter('junk'), '');
  assert.equal(formatPayloadFilter({ a: 5, b: '' }), '');          // non-string / blank values are not a filter
  const text = formatPayloadFilter(parsePayloadFilter('x=1\ny=2').value);
  assert.deepEqual(parsePayloadFilter(text).value, { x: '1', y: '2' });
});

test('payloadFilterSummary: the trigger row copy — "key=value" pairs joined by " · ", or ""', () => {
  assert.equal(payloadFilterSummary({ toStatus: 'Ready for Dev' }), 'toStatus=Ready for Dev');
  assert.equal(payloadFilterSummary({ toStatus: 'Ready for Dev', projectKey: 'KAN' }), 'toStatus=Ready for Dev · projectKey=KAN');
  assert.equal(payloadFilterSummary(null), '');
  assert.equal(payloadFilterSummary({}), '');
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd admin-console && node --test src/pages/agent-chat/plugin-event-filter.test.js`
Expected: FAIL — cannot find module `./plugin-event-filter.js`.

- [ ] **Step 3: Implement the pure module**

Create `admin-console/src/pages/agent-chat/plugin-event-filter.js`:

```js
// Pure decisions for the plugin-event trigger's optional `payloadFilter`
// (orchestrator/plugin-event.js `matchesPayloadFilter`): the editor holds it as
// `key=value` lines, the wire holds it as a flat `{ key: value }` object of
// strings. Nothing here knows what the keys mean — that is the plugin's
// vocabulary (the Jira docs say `toStatus`, `fromStatus`, …); the platform only
// carries and matches them.
//
// No React, no fetch — unit-tested under the admin-console-src job.

// Editor text → wire object. `{ ok: true, value: null }` for "no filter"; an
// error names the offending line so the form can show it verbatim.
export function parsePayloadFilter(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const out = {};
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    const eq = line.indexOf('=');
    const key = eq > 0 ? line.slice(0, eq).trim() : '';
    const value = eq > 0 ? line.slice(eq + 1).trim() : '';
    if (!key || !value) return { ok: false, error: `Line ${i + 1} must be key=value: "${line}"` };
    out[key] = value;
  }
  return { ok: true, value: Object.keys(out).length ? out : null };
}

function entries(filter) {
  if (!filter || typeof filter !== 'object' || Array.isArray(filter)) return [];
  return Object.entries(filter)
    .filter(([k, v]) => String(k).trim() && typeof v === 'string' && v.trim())
    .map(([k, v]) => [String(k).trim(), v.trim()]);
}

// Wire object → editor text (the initial value of the field on edit).
export function formatPayloadFilter(filter) {
  return entries(filter).map(([k, v]) => `${k}=${v}`).join('\n');
}

// The trigger row's one-line copy for a filtered listener.
export function payloadFilterSummary(filter) {
  return entries(filter).map(([k, v]) => `${k}=${v}`).join(' · ');
}
```

- [ ] **Step 4: Run the unit tests**

Run: `cd admin-console && node --test src/pages/agent-chat/plugin-event-filter.test.js`
Expected: PASS.

- [ ] **Step 5: Extend the wiring guard (fails until Step 6)**

Append to `admin-console/src/pages/agent-chat/plugin-event-select-wiring.test.js`:

```js
test('the payload filter is authored through the pure plugin-event-filter module', () => {
  assert.match(triggers, /import \{ parsePayloadFilter, formatPayloadFilter, payloadFilterSummary \} from '\.\/plugin-event-filter\.js'/);
  // Initial value comes from the stored object, the wire value from the parser…
  assert.match(triggers, /payloadFilter:\s*formatPayloadFilter\(initialValues\?\.payloadFilter\)/);
  assert.match(triggers, /body\.payloadFilter = parsedPayloadFilter\.value/);
  // …and a parse error blocks the save with its own message, before the prompt check.
  const err = triggers.indexOf("setFormError(parsedPayloadFilter.error)");
  const prompt = triggers.indexOf("setFormError('Prompt is required.')");
  assert.ok(err !== -1 && prompt !== -1 && err < prompt, 'payload-filter validation must precede the prompt check');
  // The field itself, and the row summary.
  assert.match(triggers, /label="Payload filter \(optional\)"/);
  assert.match(triggers, /payloadFilterSummary\(trigger\.payloadFilter\)/);
});
```

Run: `cd admin-console && node --test src/pages/agent-chat/plugin-event-select-wiring.test.js`
Expected: FAIL on the new test only.

- [ ] **Step 6: Wire `TriggersPanel.jsx`**

(a) Import, after line 11:
```js
import { parsePayloadFilter, formatPayloadFilter, payloadFilterSummary } from './plugin-event-filter.js';
```

(b) Row summary (~line 330) — replace the `plugin-event` branch:
```js
  } else if (trigger.type === 'plugin-event') {
    const filterCopy = payloadFilterSummary(trigger.payloadFilter);
    schedule = `${trigger.pluginId || 'plugin'}${trigger.eventFilter ? ` · ${trigger.eventFilter}` : ' · any event'}${filterCopy ? ` · ${filterCopy}` : ''}`;
```

(c) Form state (~line 638) — after `eventFilter: initialValues?.eventFilter ?? '',` add:
```js
    // Optional `{ key: value }` matched against the delivered payload's
    // top-level string fields (plugin-event.js `matchesPayloadFilter`); edited
    // as key=value lines, parsed back on save. Blank = no filter.
    payloadFilter: formatPayloadFilter(initialValues?.payloadFilter),
```

(d) Validation (~line 826) — directly after the `Select the plugin that may fire this listener.` line add:
```js
    const parsedPayloadFilter = form.type === 'plugin-event' ? parsePayloadFilter(form.payloadFilter) : { ok: true, value: null };
    if (!parsedPayloadFilter.ok) { setFormError(parsedPayloadFilter.error); return; }
```
(Keep this above `if (!form.prompt.trim())`.)

(e) Body (~line 879) — inside the `plugin-event` branch, after `body.eventFilter = …`:
```js
      // `null` (not omitted) clears a stored filter when the field is blanked.
      body.payloadFilter = parsedPayloadFilter.value;
```

(f) JSX — directly after the `Event filter (optional)` `<FormInput …/>` (before the closing `</div>` of the plugin-event block):
```jsx
          <FormInput
            label="Payload filter (optional)"
            value={form.payloadFilter}
            onChange={v => set('payloadFilter', v)}
            multiline
            rows={2}
            placeholder={'one key=value per line, e.g.\ntoStatus=Ready for Dev'}
          />
          <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', lineHeight: 1.5 }}>
            Wake only when every listed field of the event&rsquo;s payload equals the value
            exactly (case-sensitive). The field names are the plugin&rsquo;s own &mdash; its help
            topic lists them. Blank = wake on every matching event.
          </div>
```

- [ ] **Step 7: Run the admin-console src suite**

Run: `cd admin-console && node --test "src/**/*.test.js"`
Expected: PASS (both the new unit tests and the extended wiring guard; the existing `eventFilter stays free text` / `<select>` guards still pass because nothing above them moved).

- [ ] **Step 8: Commit**

```bash
git add admin-console/src/pages/agent-chat/plugin-event-filter.js admin-console/src/pages/agent-chat/plugin-event-filter.test.js admin-console/src/pages/agent-chat/TriggersPanel.jsx admin-console/src/pages/agent-chat/plugin-event-select-wiring.test.js
git commit -m "feat(plugins): author a payload filter on plugin-event triggers"
```

---

### Task 5: `updateDescription` in the Jira client, policy and broker route

**Files:**
- Modify: `plugins/jira/broker/jira-client.js` (next to `commentAdf`/`addComment`, ~line 332)
- Modify: `plugins/jira/broker/jira-client.test.js`
- Modify: `plugins/jira/broker/broker-policy.js`, `plugins/jira/plugin.json` (`policy`)
- Modify: `plugins/jira/broker/broker-policy.test.js`
- Modify: `plugins/jira/broker/server.js` (`writeOps`, ~line 272)
- Modify: `plugins/jira/broker/server.test.js`

**Interfaces:**
- Produces: `descriptionAdf(text, attribution) → ADF doc`; `updateDescription(cred, issueKey, { description, attribution, env }) → { issueKey, updated: 'description' }`; broker `POST /cli/update { issue, description }` → that result; policy key `update`.

- [ ] **Step 1: Write the failing client tests**

Append to `plugins/jira/broker/jira-client.test.js` after the `transitionIssue: no transition…` test:

```js
test('descriptionAdf: text paragraphs, attribution LAST in italics (a rewritten human description reads its provenance at the end)', () => {
  const doc = jc.descriptionAdf('Human section\n\nAgent section', 'by an agent');
  assert.equal(doc.type, 'doc');
  assert.equal(doc.version, 1);
  assert.equal(doc.content[0].content[0].text, 'Human section');
  assert.deepEqual(doc.content[1].content, []);
  assert.equal(doc.content[2].content[0].text, 'Agent section');
  const last = doc.content[doc.content.length - 1].content[0];
  assert.equal(last.text, 'by an agent');
  assert.equal(last.marks[0].type, 'em');
  // No attribution → no trailing paragraph.
  assert.equal(jc.descriptionAdf('x').content.length, 1);
});

test('updateDescription: PUTs {fields:{description}} to /issue/:key and reports what changed', async () => {
  await withFetch((url, opts) => {
    assert.match(url, /\/rest\/api\/3\/issue\/KAN-10$/);
    assert.equal(opts.method, 'PUT');
    const body = JSON.parse(opts.body);
    assert.equal(body.fields.description.type, 'doc');
    assert.equal(body.fields.description.content[0].content[0].text, 'new text');
    return { ok: true, status: 204, text: async () => '' };
  }, async () => {
    const r = await jc.updateDescription(CRED, 'KAN-10', { description: 'new text', attribution: 'x', env: CRED.env });
    assert.deepEqual(r, { issueKey: 'KAN-10', updated: 'description' });
  });
});

test('updateDescription: a blank description is a 400 before any request', async () => {
  await withFetch(() => { throw new Error('must not be called'); }, async () => {
    await assert.rejects(
      () => jc.updateDescription(CRED, 'KAN-10', { description: '   ', env: CRED.env }),
      (e) => e.status === 400 && /description is required/.test(e.message),
    );
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd plugins/jira/broker && node --test jira-client.test.js`
Expected: FAIL — `jc.descriptionAdf is not a function`.

- [ ] **Step 3: Implement in `jira-client.js`**

After `addComment` add:

```js
// The whole description as ADF paragraphs, the attribution LAST (in italics):
// this replaces text a human may have written, so the provenance line belongs
// under it, not above it — the reverse of a comment.
function descriptionAdf(text, attribution) {
  const paras = [];
  for (const line of String(text || '').split('\n')) {
    paras.push({ type: 'paragraph', content: line ? [{ type: 'text', text: line }] : [] });
  }
  if (attribution) {
    paras.push({ type: 'paragraph', content: [{ type: 'text', text: attribution, marks: [{ type: 'em' }] }] });
  }
  return { type: 'doc', version: 1, content: paras };
}

// Replace an issue's description. Jira keeps the previous value in the issue
// history, which is why this is a routine, role-gated write (D3) and not an
// approval-pen one. Jira answers 204 with no body.
async function updateDescription(cred, issueKey, { description, attribution, env } = {}) {
  const text = String(description || '').trim();
  if (!text) { const e = new Error('a description is required'); e.status = 400; throw e; }
  const base = apiBaseFor(cred.siteUrl, env);
  const auth = basicAuthHeader(cred.email, cred.apiToken);
  await requestJson({
    base,
    path: `/rest/api/3/issue/${encodeURIComponent(issueKey)}`,
    method: 'PUT',
    authHeader: auth,
    body: { fields: { description: descriptionAdf(text, attribution) } },
  });
  return { issueKey, updated: 'description' };
}
```

Add `descriptionAdf,` and `updateDescription,` to `module.exports`.

Run: `cd plugins/jira/broker && node --test jira-client.test.js` → PASS.

- [ ] **Step 4: Policy — failing test, then both mirrors**

In `plugins/jira/broker/broker-policy.test.js`, change the two existing tests:

```js
test('POLICY mirrors the manifest: comment + transition + update, team scope', () => {
  const manifest = require('../plugin.json');
  assert.deepEqual(POLICY, manifest.policy);
  assert.deepEqual(Object.keys(POLICY).sort(), ['comment', 'transition', 'update']);
});
…
test('authorizeWrite: a team-scoped caller may run all three writes (D3 — routine + reversible)', () => {
  assert.deepEqual(authorizeWrite('comment'), { allow: true });
  assert.deepEqual(authorizeWrite('transition'), { allow: true });
  assert.deepEqual(authorizeWrite('update'), { allow: true });
});
```

Run: `node --test broker-policy.test.js` → FAIL (`update` missing from `POLICY` keys).

Then in `broker-policy.js`:
```js
const POLICY = Object.freeze({
  comment: { scopes: ['team'] },
  transition: { scopes: ['team'] },
  update: { scopes: ['team'] },
});
```
and update the header comment's *"The two writes (`comment` / `transition`)"* to *"The three writes (`comment` / `transition` / `update`)"*.

In `plugins/jira/plugin.json`, `policy` becomes:
```json
  "policy": {
    "comment": { "scopes": ["team"] },
    "transition": { "scopes": ["team"] },
    "update": { "scopes": ["team"] }
  },
```
(keep the file's existing indentation style).

Run: `node --test broker-policy.test.js` → PASS.

- [ ] **Step 5: Broker route — failing test**

Append to `plugins/jira/broker/server.test.js` after the `cli writes:` test:

```js
test('cli writes: /update replaces the description through the client, role- and cred-gated', async () => {
  broker.scopeCredentials.set('team-1', { 'site-url': 'acme', email: 'a@b.c', 'api-token': 'tok' });
  const origFetch = global.fetch;
  const seen = [];
  global.fetch = async (url, opts) => {
    if (String(url).includes('127.0.0.1')) return origFetch(url, opts);
    seen.push({ url: String(url), method: opts && opts.method, body: opts && opts.body });
    return { ok: true, status: 204, text: async () => '' };
  };
  const srv = await listen();
  try {
    const u = await call(srv, 'POST', '/cli/update', { token: TOKEN, body: { issue: 'KAN-10', description: 'Refined text' } });
    assert.equal(u.status, 200);
    assert.deepEqual(u.body, { issueKey: 'KAN-10', updated: 'description' });
    assert.equal(seen.length, 1);
    assert.match(seen[0].url, /\/rest\/api\/3\/issue\/KAN-10$/);
    assert.equal(seen[0].method, 'PUT');
    const adf = JSON.parse(seen[0].body).fields.description;
    assert.equal(adf.content[0].content[0].text, 'Refined text');
    assert.match(adf.content[adf.content.length - 1].content[0].text, /team "team-1"/);

    const blank = await call(srv, 'POST', '/cli/update', { token: TOKEN, body: { issue: 'KAN-10', description: ' ' } });
    assert.equal(blank.status, 400);
    assert.equal(seen.length, 1); // no Jira call for a blank body

    const nocred = await call(srv, 'POST', '/cli/update', { token: OTHER, body: { issue: 'X-1', description: 'y' } });
    assert.equal(nocred.status, 400);
    assert.equal(nocred.body.code, 'no-credential');
  } finally {
    global.fetch = origFetch;
    broker.scopeCredentials.delete('team-1');
    srv.close();
  }
});
```

Run: `node --test server.test.js` → FAIL (`/cli/update` is 404).

- [ ] **Step 6: Implement the route in `server.js`**

Change `writeOps` and the dispatch:

```js
  const writeOps = { '/comment': 'comment', '/transition': 'transition', '/update': 'update' };
```
and in the `try` block replace the `if (op === 'comment') { … } else { … }` with:

```js
      let result;
      if (op === 'comment') {
        const text = String(body.body || '').trim();
        if (!text) return sendJson(res, 400, { error: 'a comment body is required' });
        result = await jira.addComment(cred, issue, { body: text, attribution });
      } else if (op === 'update') {
        const text = String(body.description || '').trim();
        if (!text) return sendJson(res, 400, { error: 'a description is required' });
        result = await jira.updateDescription(cred, issue, {
          description: text,
          attribution: `Description rewritten by an agent on team "${scopeId}" via Agent Studio.`,
        });
      } else {
        result = await jira.transitionIssue(cred, issue, { toStatus: body.to });
      }
```
(The `writeAudit(... 'ok' ...)` line after it already logs `op` + issue and needs no change.)

Run: `cd plugins/jira/broker && node --test` → PASS (whole broker suite).

- [ ] **Step 7: Commit**

```bash
git add plugins/jira/broker/jira-client.js plugins/jira/broker/jira-client.test.js plugins/jira/broker/broker-policy.js plugins/jira/broker/broker-policy.test.js plugins/jira/plugin.json plugins/jira/broker/server.js plugins/jira/broker/server.test.js
git commit -m "feat(jira-plugin): broker write that replaces an issue description"
```

---

### Task 6: `aee-jira update` + manifest prompt line

**Files:**
- Modify: `plugins/jira/bin/aee-jira.py`
- Modify: `orchestrator/plugin-cli-contract.test.js` (~lines 543–556 and 587–591)
- Modify: `plugins/jira/plugin.json` (`promptLine`, `description`)

**Interfaces:**
- Consumes: broker `POST /cli/update { issue, description }` (Task 5).
- Produces: `aee-jira update <issue> --description "<text>"`, exit codes per §4.5.

- [ ] **Step 1: Extend the contract tests (fail first)**

In `orchestrator/plugin-cli-contract.test.js`, in the `--help → 0 with domain verbs` test add after `assert.match(help.stdout, /transition/);`:
```js
  assert.match(help.stdout, /update/);
```
and in the `list without --project …` test add:
```js
  assert.equal(runJira(['update', 'KAN-1', '--json'], grantedJiraWorkspace()).status, 2);
```
Also add a new test after it:
```js
test('aee-jira: update against an unreachable broker → exit 3 (the verb is wired to a broker call)', () => {
  const r = runJira(['update', 'KAN-1', '--description', 'x', '--json'], grantedJiraWorkspace());
  assert.equal(r.status, 3);
  assert.equal(JSON.parse(r.stdout).error, 'broker-unreachable');
});
```

Run: `cd orchestrator && node --test plugin-cli-contract.test.js`
Expected: FAIL — `--help` lacks `update`; `update KAN-1` exits 2 today (unknown subcommand), but the third test fails (argparse rejects the unknown verb with exit 2, not 3).

- [ ] **Step 2: Implement the subcommand**

In `plugins/jira/bin/aee-jira.py`:

(a) Docstring — in the *Writes* block add a line after the `transition` example:
```
    aee-jira update KAN-6 --description "…"   # replace the issue description (the old one stays in Jira's history)
```

(b) `build_parser()` — after the `p_trans` block:
```python
    p_update = sub.add_parser("update", parents=[common], help="replace an issue's description (previous text stays in Jira's history)")
    p_update.add_argument("issue", help="issue key, e.g. KAN-6")
    p_update.add_argument("--description", required=True, help="the complete new description text (plain text; blank lines become paragraphs)")
```

(c) `main()` — after the `transition` branch:
```python
    elif args.cmd == "update":
        path, method, body = "/update", "POST", {"issue": args.issue, "description": args.description}
```

- [ ] **Step 3: Run the contract tests**

Run: `cd orchestrator && node --test plugin-cli-contract.test.js`
Expected: PASS.

- [ ] **Step 4: Manifest copy**

In `plugins/jira/plugin.json`:
- `promptLine`: replace `` `aee-jira transition KAN-6 --to \"In Progress\"`. All Jira access…`` with `` `aee-jira transition KAN-6 --to \"In Progress\"`, `aee-jira update KAN-6 --description \"…\"` (replaces the whole description — keep what the human wrote and add your section; the previous text stays in Jira's history). A transition you make is itself a status change and wakes whichever teammate's trigger names that target status. All Jira access…``
- `description`: replace *"and lets it read what happened."* with *"and lets it read what happened, comment, rewrite the description and move the ticket on."* and *"the agent drains the queue with the `aee-jira inbox` command-line tool."* with *"the agent drains the queue with the `aee-jira inbox` command-line tool and acts with `aee-jira comment` / `update` / `transition`."*

Run: `cd plugins/jira/broker && node --test broker-policy.test.js` (the manifest is required by it — proves the JSON still parses).

- [ ] **Step 5: Commit**

```bash
git add plugins/jira/bin/aee-jira.py orchestrator/plugin-cli-contract.test.js plugins/jira/plugin.json
git commit -m "feat(jira-plugin): aee-jira update rewrites an issue description"
```

---

### Task 7: Refresh stale plugin CLI copies on reconcile

**Files:**
- Modify: `orchestrator/plugin-sync.js`
- Modify: `orchestrator/plugin-sync.test.js`
- Modify: `orchestrator/orchestrator.js` (`reconcilePluginsAndAttachments`, ~line 2876; new `refreshGrantedPluginClis` next to `pushGithubIssueScopeCredentials`)
- Modify: `orchestrator/plugin-cli-refresh-wiring.test.js` (from Task 2)

**Interfaces:**
- Produces: `planCliRefresh({ grant, manifests, workspaceDigest, registryDigest }) → [{ path, mode, copyFrom, reason: 'missing'|'stale' }]` — same `write` item shape `_syncPluginIntoWorkspace` already applies.
- Consumes: `pluginRegistry.cliEntrypointPath(manifest)`, `agentPluginPaths`, `BIN_MODE`, `effectivePlugins`, `reseedAgent`.

- [ ] **Step 1: Failing unit tests**

Append to `orchestrator/plugin-sync.test.js` (add `planCliRefresh` to the destructured require):

```js
// ── planCliRefresh ──────────────────────────────────────────────────────────

test('planCliRefresh: a missing or byte-different CLI copy is re-seeded; an identical one is untouched', () => {
  const grant = [{ id: 'dummy-echo', scopeGranularity: 'team' }];
  const registryDigest = () => 'sha-new';
  const missing = planCliRefresh({ grant, manifests: MANIFESTS, workspaceDigest: () => null, registryDigest });
  assert.deepEqual(missing, [{ path: '.agent-studio/bin/aee-echo', mode: BIN_MODE, copyFrom: 'bin/aee-echo.py', reason: 'missing' }]);

  const stale = planCliRefresh({ grant, manifests: MANIFESTS, workspaceDigest: () => 'sha-old', registryDigest });
  assert.equal(stale[0].reason, 'stale');

  const same = planCliRefresh({ grant, manifests: MANIFESTS, workspaceDigest: () => 'sha-new', registryDigest });
  assert.deepEqual(same, []);
});

test('planCliRefresh: skips uninstalled, command-only and registry-unreadable plugins; never removes anything', () => {
  const manifests = {
    ...MANIFESTS,
    'cmd-only': { id: 'cmd-only', commands: { namespace: 'x' } },
  };
  const grant = [
    { id: 'dummy-echo', scopeGranularity: 'team' },
    { id: 'cmd-only', scopeGranularity: 'team' },
    { id: 'gone', scopeGranularity: 'team' },
  ];
  const plan = planCliRefresh({ grant, manifests, workspaceDigest: () => 'old', registryDigest: (m) => (m.id === 'dummy-echo' ? null : 'x') });
  // dummy-echo's registry file is unreadable (null) → not planned; the other two have no CLI at all.
  assert.deepEqual(plan, []);
  assert.deepEqual(planCliRefresh({ grant: [], manifests, workspaceDigest: () => null, registryDigest: () => 'x' }), []);
});
```

Run: `cd orchestrator && node --test plugin-sync.test.js` → FAIL (`planCliRefresh is not a function`).

- [ ] **Step 2: Implement `planCliRefresh`**

In `orchestrator/plugin-sync.js`, before `module.exports`:

```js
// Which of ONE agent's granted CLI copies differ from the registry. The grant
// sync above seeds the CLI only when the grant CHANGES, so a plugin re-installed
// with a newer CLI leaves every existing workspace on the old file — the agent
// then reports verbs "missing" that the broker has served for weeks. This plan
// is applied on every plugin reconcile: a copy that is absent or byte-different
// (by digest) is re-written, an identical one is left alone, and nothing is
// ever removed (a revoke is planWorkspaceSync's job).
//
//   grant           : normalised [{ id, scopeGranularity }] (effectivePlugins)
//   manifests       : { <pluginId>: normalised manifest }
//   workspaceDigest : (binPath) => digest string | null when the copy is absent
//   registryDigest  : (manifest) => digest string | null when unreadable
//
// Returns write items in planWorkspaceSync's `write` shape, plus a `reason`.
function planCliRefresh({ grant = [], manifests = {}, workspaceDigest, registryDigest } = {}) {
  const write = [];
  for (const g of grant || []) {
    const manifest = manifests[g.id];
    if (!manifest || !manifest.cli) continue; // uninstalled / command-only — nothing to refresh
    const wanted = registryDigest(manifest);
    if (!wanted) continue; // registry copy unreadable — leave the workspace as it is
    const { binPath } = agentPluginPaths(g.id, manifest.cli.name);
    const have = workspaceDigest(binPath);
    if (have === wanted) continue;
    write.push({ path: binPath, mode: BIN_MODE, copyFrom: manifest.cli.entrypoint, reason: have ? 'stale' : 'missing' });
  }
  return write;
}
```
Add `planCliRefresh,` to `module.exports`.

Run: `cd orchestrator && node --test plugin-sync.test.js` → PASS.

- [ ] **Step 3: Extend the source guard (fails first)**

Append to `orchestrator/plugin-cli-refresh-wiring.test.js`:

```js
test("AC2: reconcilePluginsAndAttachments refreshes granted CLI copies after the credential pushes", () => {
  const fn = between("async function reconcilePluginsAndAttachments()", "return { sidecars, networks }");
  assert.match(fn, /await refreshGrantedPluginClis\(\)/);
  // Order: sidecars first, then credentials, then the CLI refresh — a fresh CLI
  // against a broker that is not yet up would only fail its first call anyway,
  // but the refresh must not run before the registry has been re-validated.
  assert.ok(fn.indexOf("pushDeclaredScopeCredentials()") < fn.indexOf("refreshGrantedPluginClis()"));
});

test("AC3: the refresh decides by digest on BOTH files and reseeds .agent-studio for isolated volumes", () => {
  const fn = between("async function refreshGrantedPluginClis()", "\n}\n");
  assert.match(fn, /planCliRefresh\(\{/);
  assert.match(fn, /workspaceDigest:/);
  assert.match(fn, /registryDigest:/);
  assert.match(fn, /createHash\("sha256"\)/);
  assert.match(fn, /fs\.chmodSync\(dest, item\.mode\)/);
  assert.match(fn, /reseedAgent\(id, \["\.agent-studio"\]\)/);
  assert.match(SRC, /planCliRefresh \} = require\("\.\/plugin-sync"\)/);
});
```

Run: `cd orchestrator && node --test plugin-cli-refresh-wiring.test.js` → FAIL on AC2/AC3.

- [ ] **Step 4: Wire it in `orchestrator.js`**

(a) Line 143: change `const { planWorkspaceSync } = require("./plugin-sync");` to
```js
const { planWorkspaceSync, planCliRefresh } = require("./plugin-sync");
```
(`crypto` is already required at `orchestrator.js:508`.)

(b) Directly above `async function reconcilePluginsAndAttachments()` add:

```js
// Re-seed any granted plugin CLI whose workspace copy no longer matches the
// registry (plugin-sync.js `planCliRefresh`). The grant sync copies the CLI
// only on a grant change, so a re-installed plugin with a newer CLI would leave
// every existing agent on the old file. Runs on every reconcile; best-effort
// per agent; an additive file sync like the grant itself — never a respawn.
async function refreshGrantedPluginClis() {
  const manifests = pluginRegistry.installedManifests();
  const digestOf = (file) => {
    try { return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"); } catch { return null; }
  };
  const registryDigest = (manifest) => {
    try { return digestOf(pluginRegistry.cliEntrypointPath(manifest)); } catch { return null; }
  };
  let ids = [];
  try { ids = listAgentIds(); } catch { ids = []; }
  for (const id of ids) {
    let cfg = null;
    try { cfg = loadAgentConfig(id); } catch { cfg = null; }
    if (!cfg || !cfg.token) continue; // a stub has no workspace to refresh
    let grant = [];
    try { grant = effectivePlugins(cfg, loadAgentConfig); } catch { grant = []; }
    if (!grant.length) continue;
    const dir = agentDir(id);
    const plan = planCliRefresh({
      grant, manifests, registryDigest,
      workspaceDigest: (binPath) => digestOf(path.join(dir, binPath)),
    });
    if (!plan.length) continue;
    let written = 0;
    for (const item of plan) {
      // Same entrypoint+name lookup `_syncPluginIntoWorkspace` uses, so the
      // containment check stays in pluginRegistry.cliEntrypointPath alone.
      const cliName = path.basename(item.path);
      const manifest = Object.values(manifests).find(
        (m) => m.cli && m.cli.entrypoint === item.copyFrom && m.cli.name === cliName,
      );
      const src = manifest ? pluginRegistry.cliEntrypointPath(manifest) : null;
      if (!src) continue;
      const dest = path.join(dir, item.path);
      try {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(src, dest);
        fs.chmodSync(dest, item.mode);
        written += 1;
        console.log(`[Orchestrator] plugin CLI refreshed for ${id}: ${item.path} (${item.reason})`);
      } catch (err) {
        console.warn(`[Orchestrator] plugin CLI refresh ${id} ${item.path}: ${err.message}`);
      }
    }
    if (written) {
      try { await reseedAgent(id, [".agent-studio"]); } catch (err) {
        console.warn(`[Orchestrator] plugin CLI refresh ${id}: reseed failed: ${err.message}`);
      }
    }
  }
}
```


(c) In `reconcilePluginsAndAttachments`, after the `pushDeclaredScopeCredentials` try/catch and before `return { sidecars, networks };`:
```js
  // Bring every granted agent's CLI copy up to the registry (a re-install with
  // a newer CLI would otherwise never reach an existing workspace).
  try { await refreshGrantedPluginClis(); } catch (err) {
    console.warn(`[Orchestrator] plugin CLI refresh failed: ${err.message}`);
  }
```

- [ ] **Step 5: Run the guard + full orchestrator suite**

Run: `cd orchestrator && node --test plugin-cli-refresh-wiring.test.js && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add orchestrator/plugin-sync.js orchestrator/plugin-sync.test.js orchestrator/orchestrator.js orchestrator/plugin-cli-refresh-wiring.test.js
git commit -m "feat(plugins): refresh stale plugin CLI copies on every reconcile"
```

---

### Task 8: Remove the dead `wake.agentIds` display in the Jira UI

**Files:**
- Modify: `plugins/jira/broker/ui/app.js` (`wakeText` ~line 238, `healthyDetail` ~line 289)

No unit test covers `app.js` (browser UMD, no build step); verify by reading and by `node --check`.

- [ ] **Step 1: Edit**

Replace `wakeText`:
```js
  // Which agents a transition wakes is decided per agent by its `plugin-event`
  // trigger (and its payload filter, e.g. `toStatus=…`) — not here. The
  // pre-Phase-2 `wake.agentIds` is no longer read by the broker.
  function wakeText() {
    return 'wakes agents by their plugin-event triggers';
  }
```
and the `wakesCell` computation in `healthyDetail` with:
```js
    var wakesCell = '<div><span class="dt-label">Wakes</span><span>agents whose plugin-event trigger matches</span></div>';
```
(delete the `var ids = …` line and the `if (Array.isArray(ids) …) { … } else { … }` block). Leave the `wakeText(w)` call site as is (the argument is ignored).

- [ ] **Step 2: Verify**

Run: `node --check plugins/jira/broker/ui/app.js && grep -n "agentIds" plugins/jira/broker/ui/app.js`
Expected: no syntax error; no remaining `agentIds` reference in `app.js`.

- [ ] **Step 3: Commit**

```bash
git add plugins/jira/broker/ui/app.js
git commit -m "fix(jira-plugin): stop showing the retired per-watch agent list"
```

---

### Task 9: Operator guide

**Files:**
- Modify: `docs/jira-plugin.md` (§5 table ~line 102; CLI table ~line 118; troubleshooting ~line 195)

- [ ] **Step 1: §5 — the trigger table and the routing rule**

Replace the §5 table with:

```markdown
| Field | |
|---|---|
| Plugin | `jira` (picked from the installed plugins) |
| Event filter | blank = any event from jira; or `status_changed` |
| Payload filter | **which status wakes this agent** — one `key=value` per line, e.g. `toStatus=Ready for Dev`. Blank = every watched transition wakes this agent. |
| Wake instruction | what the agent should do — e.g. *"Run `aee-jira inbox --consume`, read the issue with `aee-jira show`, refine the description and write it back with `aee-jira update`, then move it on with `aee-jira transition`."* |

The payload filter is what routes a flow: give the Business Analyst
`toStatus=Ready for Refinement`, the Developer `toStatus=Ready for Dev`, the
Reviewer `toStatus=In Review`. Every key must equal the event's field **exactly**
(case-sensitive — copy the status name verbatim from Jira). Without a filter
*every* granted agent with a `plugin-event` trigger wakes on *every* watched
transition — including the one an agent just made itself.

The fields a `status_changed` payload carries, all plain strings:

| Key | |
|---|---|
| `toStatus` / `fromStatus` | the status names of the transition |
| `projectKey` | e.g. `KAN` |
| `issueKey` | e.g. `KAN-10` |
| `issueType` | Story / Bug / Task / … |
| `author` | who moved it (display name) |

A burst digest (more than three transitions on one issue in a single poll)
matches when **any** of its folded events matches.
```

- [ ] **Step 2: CLI table — add `update`, and the chaining note**

After the `transition` row add:
```markdown
| `aee-jira update KAN-6 --description "…"` | **replace** the issue description (plain text; blank lines become paragraphs; an italic *rewritten by an agent…* line is appended). The previous text stays in Jira's issue history |
```
After the `--json on every subcommand…` paragraph add:
```markdown
A transition an agent makes is an ordinary status change: the poller sees it on
its next tick and wakes whichever teammate's trigger names that target status —
that is how a BA → Developer → Reviewer chain runs with no other wiring. The
per-issue throttle (5 transitions per hour per issue) still applies to the whole
chain.
```

- [ ] **Step 3: Troubleshooting — two rows**

Append to the table:
```markdown
| the agent says `aee-jira` is read-only / only knows `whoami` and `inbox` | its workspace holds a CLI copy from an older plugin version (the grant sync copies the file only when the grant changes) | since this version the copy is refreshed on every plugin reconcile — restart the orchestrator or `POST /internal/plugins/reconcile`; re-run `make seed-plugins` + reinstall first if `/workspace/plugins/jira/bin/aee-jira.py` is itself old |
| the wrong agent wakes, or an agent wakes on its own transition | the agents' `plugin-event` triggers carry no payload filter, so every watched transition wakes all of them | set `toStatus=<status>` on each agent's trigger (§5) |
```
Also amend the existing *"a fresh transition doesn't wake the agent"* row's *Cause* with: *", or the trigger's payload filter names a status that is not the one the issue moved into"*.

- [ ] **Step 4: Commit**

```bash
git add docs/jira-plugin.md
git commit -m "docs(jira-plugin): status-routed wakes, aee-jira update, stale-CLI recovery"
```

---

### Task 10: Verify end to end and hand over

- [ ] **Step 1: Run every affected CI job locally**

```bash
cd orchestrator && npm test && cd ..
cd plugins/jira/broker && node --test && cd ../../..
cd admin-console && node --test "src/**/*.test.js" && cd ..
cd agent-image/scripts && python -m pytest test_agent_entrypoint.py test_cli_contract.py -q && cd ../..
```
Expected: all PASS. If `admin-console` has a `help-topics-content.test.js` or a docs guard that reads `docs/jira-plugin.md`, it runs in the src job above — a failure there means a `concepts` anchor was reworded; restore the phrase rather than the test.

- [ ] **Step 2: Check the diff for §D5 leaks**

Run: `git diff main...HEAD -- orchestrator/plugin-event.js agent-image/scripts/agent-entrypoint.py admin-console/src/pages/agent-chat/plugin-event-filter.js | grep -in "jira\|toStatus"`
Expected: only occurrences inside comments that give an *example* (`e.g.`) — no code path keyed on them.

- [ ] **Step 3: Push and tell the operator what to do on the live stack**

```bash
git push origin feat/jira-events-plugin
```

Then, on the host (the changes touch three images and the plugin registry):
```bash
make build              # orchestrator + admin-console images
make plugin-images      # the jira broker image (server.js + ui)
make seed-plugins       # pool copy of plugins/jira (new aee-jira.py + manifest)
make up
# Plugins page → uninstall + reinstall jira (registry copy of the CLI + policy)
# → the reconcile after install refreshes every granted agent's aee-jira copy
```
Then in Agent Chat: on `jira-test-business-analyst`'s `plugin-event` trigger set *Payload filter* `toStatus=<the BA's intake status>`, on `jira-test-developer` add a `plugin-event` trigger with `toStatus=Ready for Dev`, and extend the BA's wake instruction with `aee-jira update` + `aee-jira transition … --to "Ready for Dev"`. Test with a **fresh** issue (KAN-9/KAN-10 may be near the 5/h throttle).

---

## Self-review

- **Spec coverage:** Design decision 1 → Tasks 4, 8; 2 → Tasks 1, 4; 3 → Tasks 1, 3; 4 → Tasks 5, 6; 5 → Task 7; 6 → Tasks 6, 9. The stale-copy root cause found in the conversation (grant-time-only copy) → Task 7. The orchestrator route → Task 2.
- **Placeholders:** none — every step carries its code.
- **Type consistency:** `payloadFilter` is `object|null` on the wire in Tasks 1/2/3/4; `planCliRefresh` write items match `_syncPluginIntoWorkspace`'s `{ path, mode, copyFrom }` shape; `updateDescription`'s `{ issueKey, updated: 'description' }` is asserted identically in Task 5's client and server tests; the AC3 guard pins the `planCliRefresh` require exactly as Task 7 writes it.
