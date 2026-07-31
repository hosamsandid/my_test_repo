# Team-wide enable/disable Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an operator disable/enable an entire team (all `role: "team-member"` agents under one `role: "team"` agent) in one bulk action, without losing track of members that were already individually disabled before the team went down.

**Architecture:** A new pure planning module decides which members a bulk action should touch; three new `Orchestrator` methods (`listTeamMembersWithState`, `disableTeam`, `enableTeam`) apply that plan using the *existing* `enableAgent`/`disableAgent` per-member primitives (no duplicated spawn/stop logic); three new manual-regex HTTP routes expose them internally; three new Express routes proxy them from the admin console; the existing single-member enable/disable path gets a lockout guard so a member can't be toggled while its parent team is disabled; the `TeamCard` UI gets a toggle + confirm dialogs modeled on the existing `ModelRegistry.jsx` bound-agents/respawn-agents flow.

**Tech Stack:** Node.js (CommonJS) orchestrator with a hand-rolled `http` server (no Express, no router library — routes are `if (req.method === X && req.url.match(regex))` blocks); Express admin-console API; React 18 admin-console frontend; `node --test` + `node:assert/strict` for all new automated tests (both backend and frontend pure-logic modules use this runner — there is no Jest/Vitest in this repo).

## Global Constraints

- Isolation: implement this entire plan in a dedicated git worktree (per user instruction), not directly in the current working tree. Use the `superpowers:using-git-worktrees` skill to set it up before Task 1.
- Team-member "cascade disabled" marker field name is exactly `disabledByTeam` (boolean `true`; **absent**, not `false`, when not applicable — mirrors how `enabled` itself is only ever written as `true`/`false`, never omitted, per existing convention).
- Disable mode values are exactly the strings `'drain'` and `'abort'` (matches the existing single-agent `disableAgent` contract — do not introduce new mode names).
- Orchestrator routing style: every new internal route is a manual `req.method === 'X' && req.url.match(/regex/)` block ending in `return`, inserted next to the existing team/agent route blocks — do NOT introduce Express or a router table into `orchestrator.js`.
- Reuse `admin-console/src/components/ConfirmDialog.jsx` for any single-action confirms (already imported in `Agents.jsx`); the team-disable mode picker (drain vs abort) needs a bespoke two-button dialog like the existing `DisableWarningDialog` in `Agents.jsx:2603-2661` — do not try to force that into `ConfirmDialog`'s single-`onConfirm` shape.
- No new npm dependencies, front or back end.
- `orchestrator.js` has no unit-test harness for `Orchestrator` class methods today (confirmed: zero `orchestrator.test.js`, zero references to `enableAgent`/`disableAgent`/`respawnAgentsForEnvironment` in any test file). Tasks that touch `Orchestrator` methods are verified by manual `curl` against a running dev stack (`make up`), not automated tests — only the newly-extracted **pure** planning module (Task 1) and the newly-extracted **pure** frontend summary helper (Task 6) get `node --test` coverage, matching the existing project convention of testing pure logic modules (`orchestrator/teams-store.test.js`, `admin-console/src/pages/credential-scope-view.test.js`) while leaving the I/O-heavy glue around them manually verified.
- The team agent (`role: "team"`) itself never has a running process — `disableTeam`/`enableTeam` only ever call `startAgentProcess`/`stopAgentProcess` for its *members*, never for the team agent's own config.

---

### Task 0: Set up an isolated worktree

**Files:** none (environment setup only)

- [ ] **Step 1: Create the worktree**

Invoke the `superpowers:using-git-worktrees` skill to create an isolated worktree for this feature branch (e.g. branch name `feat/team-wide-disable`), off the current branch `feat/respawn-on-credential-rotation`. All subsequent tasks run inside that worktree.

- [ ] **Step 2: Confirm the dev stack still runs there**

Run: `make ps` inside the new worktree (or `make up` if nothing is running yet) to confirm the compose stack is reachable — later tasks verify against it with `curl`.

---

### Task 1: Pure planning module `orchestrator/team-disable.js`

**Files:**
- Create: `orchestrator/team-disable.js`
- Create: `orchestrator/team-disable.test.js`

**Interfaces:**
- Produces: `isTeamDisabled(teamCfg) -> boolean`, `planTeamDisable(memberConfigs) -> { toDisable: string[], skip: string[] }`, `planTeamEnable(memberConfigs) -> { toEnable: string[], skip: string[] }`. `memberConfigs` is an array of team-member `config.json` objects (each has at least `id`, `enabled`, `disabledByTeam`). These are consumed by Task 2's `Orchestrator.disableTeam`/`enableTeam`/lockout guard.

This module contains zero I/O — it only classifies already-loaded config objects — so it can be fully covered by `node --test` the way `orchestrator/teams-store.js` is.

- [ ] **Step 1: Write the failing tests**

Create `orchestrator/team-disable.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { isTeamDisabled, planTeamDisable, planTeamEnable } = require('./team-disable');

test('isTeamDisabled: false/undefined enabled or missing config means enabled', () => {
  assert.equal(isTeamDisabled(null), false);
  assert.equal(isTeamDisabled(undefined), false);
  assert.equal(isTeamDisabled({}), false);
  assert.equal(isTeamDisabled({ enabled: true }), false);
});

test('isTeamDisabled: enabled === false means disabled', () => {
  assert.equal(isTeamDisabled({ enabled: false }), true);
});

test('planTeamDisable: enabled members go to toDisable, already-off members are skipped untouched', () => {
  const members = [
    { id: 'a', enabled: true },
    { id: 'b', enabled: false },          // independently disabled before team action
    { id: 'c' },                           // enabled defaults to true when absent
    { id: 'd', enabled: false, disabledByTeam: true }, // was already cascade-disabled
  ];
  const { toDisable, skip } = planTeamDisable(members);
  assert.deepEqual(toDisable.sort(), ['a', 'c']);
  assert.deepEqual(skip.sort(), ['b', 'd']);
});

test('planTeamDisable: ignores null/undefined entries defensively', () => {
  const { toDisable, skip } = planTeamDisable([null, { id: 'a', enabled: true }, undefined]);
  assert.deepEqual(toDisable, ['a']);
  assert.deepEqual(skip, []);
});

test('planTeamEnable: only disabledByTeam members come back, everyone else is skipped', () => {
  const members = [
    { id: 'a', enabled: false, disabledByTeam: true },  // cascade-disabled → re-enable
    { id: 'b', enabled: false },                          // independently disabled → stays off
    { id: 'c', enabled: true },                           // already on (shouldn't happen, but stays on)
    { id: 'd', enabled: false, disabledByTeam: false },  // explicit false is not true → stays off
  ];
  const { toEnable, skip } = planTeamEnable(members);
  assert.deepEqual(toEnable, ['a']);
  assert.deepEqual(skip.sort(), ['b', 'c', 'd']);
});

test('planTeamEnable: ignores null/undefined entries defensively', () => {
  const { toEnable, skip } = planTeamEnable([null, { id: 'a', enabled: false, disabledByTeam: true }]);
  assert.deepEqual(toEnable, ['a']);
  assert.deepEqual(skip, []);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd orchestrator && node --test team-disable.test.js`
Expected: FAIL — `Cannot find module './team-disable'`

- [ ] **Step 3: Write the implementation**

Create `orchestrator/team-disable.js`:

```js
'use strict';

// Pure planning helpers for the team-wide enable/disable feature
// (docs/superpowers/specs/2026-07-31-team-wide-disable-design.md). No I/O —
// callers pass in already-loaded config objects and apply the resulting
// id lists via the existing per-agent enableAgent/disableAgent primitives.

// A team (role: "team") config is disabled iff its own `enabled` field is
// exactly `false`. Absent or `true` means enabled, matching how every other
// role's `enabled` field defaults.
function isTeamDisabled(teamCfg) {
  return !!teamCfg && teamCfg.enabled === false;
}

// Partitions a team's member configs for a team-disable action.
// `toDisable` — members currently enabled (enabled !== false): the bulk
//   action must disableAgent() each one and tag it disabledByTeam.
// `skip` — members already enabled === false: left completely untouched
//   (no tag written) since they were off on their own before this action.
function planTeamDisable(memberConfigs) {
  const toDisable = [];
  const skip = [];
  for (const cfg of memberConfigs) {
    if (!cfg) continue;
    if (cfg.enabled !== false) toDisable.push(cfg.id);
    else skip.push(cfg.id);
  }
  return { toDisable, skip };
}

// Partitions a team's member configs for a team-enable action.
// `toEnable` — members tagged disabledByTeam === true: the bulk action must
//   enableAgent() each one and clear the tag.
// `skip` — everyone else (independently disabled, already enabled, or a
//   stub never activated): left exactly as they are.
function planTeamEnable(memberConfigs) {
  const toEnable = [];
  const skip = [];
  for (const cfg of memberConfigs) {
    if (!cfg) continue;
    if (cfg.disabledByTeam === true) toEnable.push(cfg.id);
    else skip.push(cfg.id);
  }
  return { toEnable, skip };
}

module.exports = { isTeamDisabled, planTeamDisable, planTeamEnable };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd orchestrator && node --test team-disable.test.js`
Expected: PASS (6 tests, 0 failures)

- [ ] **Step 5: Commit**

```bash
git add orchestrator/team-disable.js orchestrator/team-disable.test.js
git commit -m "feat: add pure planning module for team-wide enable/disable"
```

---

### Task 2: Orchestrator core — lockout guard, busy-state extraction, bulk methods

**Files:**
- Modify: `orchestrator/orchestrator.js`

**Interfaces:**
- Consumes: `isTeamDisabled`, `planTeamDisable`, `planTeamEnable` from Task 1's `./team-disable`.
- Produces: `Orchestrator.prototype._assertNotLockedByTeam(cfg)` (throws `Error` with `.code === 'team-disabled'` and `.teamId` set), `Orchestrator.prototype.listTeamMembersWithState(teamId) -> { teamId, teamEnabled: boolean, members: [{ id, displayName, enabled, disabledByTeam, running, busy, activeTriggers }] }`, `Orchestrator.prototype.disableTeam(teamId, { mode }) -> Promise<{ teamId, disabled: string[], skipped: string[], failed: [{id, error}] }>`, `Orchestrator.prototype.enableTeam(teamId) -> Promise<{ teamId, enabled: string[], skipped: string[], failed: [{id, error}] }>`. Task 3's HTTP routes call these four; Task 4's `addTeamMember` reads `isTeamDisabled`/`teamCfg.enabled` directly.

- [ ] **Step 1: Add the `team-disable` require**

At the top of `orchestrator/orchestrator.js`, find the existing local `require`s (e.g. near `const { effectiveSkills } = require('./skill-grants');` or similar — search for the block of `require('./...')` lines) and add:

```js
const { isTeamDisabled, planTeamDisable, planTeamEnable } = require('./team-disable');
```

- [ ] **Step 2: Extract `agentBusyState` and use it from `disableAgent`**

`disableAgent` currently computes busy/active-trigger state inline (`orchestrator.js:7204-7221`):

```js
      let isBusy = false;
      try {
        const status = JSON.parse(
          fs.readFileSync(agentStatePath(id, 'status.json'), 'utf8'), // control-plane copy preferred (#185)
        );
        isBusy = status?.state === 'busy';
      } catch { /* no status file = idle */ }

      let activeTriggers = [];
      try {
        const triggers = loadTriggers(id); // canonical copy (#185 Phase 2)
        if (Array.isArray(triggers)) {
          activeTriggers = triggers
            .filter(t => t.enabled !== false && t.id)
            .map(t => ({ id: t.id, type: t.type, description: t.description || null }));
        }
      } catch { /* no triggers file */ }

      if (isBusy || activeTriggers.length > 0) {
```

Extract this into a module-level function placed just above `disableAgent`'s definition (near the other module-level helpers like `loadAgentConfig`/`saveAgentConfig`), and have `disableAgent` call it:

```js
// Busy/active-trigger snapshot for an agent — shared by disableAgent's own
// busy-warning path and the team-members preview listing, so both report
// identical state for the same agent.
function agentBusyState(id) {
  let busy = false;
  try {
    const status = JSON.parse(
      fs.readFileSync(agentStatePath(id, 'status.json'), 'utf8'), // control-plane copy preferred (#185)
    );
    busy = status?.state === 'busy';
  } catch { /* no status file = idle */ }

  let activeTriggers = [];
  try {
    const triggers = loadTriggers(id); // canonical copy (#185 Phase 2)
    if (Array.isArray(triggers)) {
      activeTriggers = triggers
        .filter(t => t.enabled !== false && t.id)
        .map(t => ({ id: t.id, type: t.type, description: t.description || null }));
    }
  } catch { /* no triggers file */ }

  return { busy, activeTriggers };
}
```

Then replace the inline block inside `disableAgent` (`orchestrator.js:7202-7223`) with:

```js
    if (!mode && isRunning) {
      const { busy: isBusy, activeTriggers } = agentBusyState(id);
      if (isBusy || activeTriggers.length > 0) {
        return {
          id,
          warning: true,
          busy: isBusy,
          activeTriggers,
        };
      }
    }
```

- [ ] **Step 3: Add the lockout guard and wire it into `enableAgent`/`disableAgent`**

Add this method to the `Orchestrator` class (place it right above `enableAgent`):

```js
  // Throws a team-disabled error if cfg is a team-member whose parent team
  // is currently disabled — the lockout for the team-wide disable feature
  // (docs/superpowers/specs/2026-07-31-team-wide-disable-design.md). A
  // member's own enable/disable toggle must not do anything while its team
  // is off; this guard makes that true no matter which route calls in
  // (PUT /api/agents/:id, the internal /enable|/disable routes, or any
  // future caller).
  _assertNotLockedByTeam(cfg) {
    if (cfg.role !== "team-member" || !cfg.parentTeamId) return;
    const teamCfg = loadAgentConfig(cfg.parentTeamId);
    if (isTeamDisabled(teamCfg)) {
      const err = new Error(`Team '${cfg.parentTeamId}' is disabled — enable the team first`);
      err.code = 'team-disabled';
      err.teamId = cfg.parentTeamId;
      throw err;
    }
  }
```

In `enableAgent(id)`, immediately after the existing `if (!cfg) throw new Error(...)` line at the top (`orchestrator.js:7092-7093`), add:

```js
    this._assertNotLockedByTeam(cfg);
```

In `disableAgent(id, { mode } = {})`, immediately after its own `if (!cfg) throw new Error(...)` line (`orchestrator.js:7198-7199`), add the same:

```js
    this._assertNotLockedByTeam(cfg);
```

- [ ] **Step 4: Add `listTeamMembersWithState`**

Add this method to the `Orchestrator` class, near `respawnAgentsForEnvironment` (e.g. right after `disableAgent`):

```js
  // Members + running/busy/trigger state for the team-wide disable/enable
  // preview dialog. Read-only — makes no config changes.
  listTeamMembersWithState(teamId) {
    const teamCfg = loadAgentConfig(teamId);
    if (!teamCfg) throw new Error(`Team '${teamId}' not found`);

    const members = listAgentIds()
      .map((id) => loadAgentConfig(id))
      .filter((c) => c && c.role === "team-member" && c.parentTeamId === teamId)
      .map((c) => {
        const { busy, activeTriggers } = agentBusyState(c.id);
        return {
          id: c.id,
          displayName: c.displayName || c.id,
          enabled: c.enabled !== false,
          disabledByTeam: c.disabledByTeam === true,
          running: agentProcesses.has(c.id),
          busy,
          activeTriggers,
        };
      });

    return { teamId, teamEnabled: !isTeamDisabled(teamCfg), members };
  }
```

- [ ] **Step 5: Add `disableTeam`**

Add this method right after `listTeamMembersWithState`:

```js
  // Disable every currently-enabled member of teamId in one bulk action,
  // tagging each one disabledByTeam so enableTeam later knows to bring back
  // only these — members already enabled===false are left completely
  // untouched (see docs/superpowers/specs/2026-07-31-team-wide-disable-design.md).
  // Members are disabled BEFORE the team's own config flips to disabled, so
  // the per-member disableAgent() calls below don't trip their own lockout
  // guard (which only fires once the team is actually off).
  async disableTeam(teamId, { mode } = {}) {
    if (mode !== 'drain' && mode !== 'abort') {
      throw new Error("mode must be 'drain' or 'abort'");
    }
    const teamCfg = loadAgentConfig(teamId);
    if (!teamCfg) throw new Error(`Team '${teamId}' not found`);
    if (teamCfg.role !== "team") throw new Error(`Agent '${teamId}' is not a team (role=${teamCfg.role})`);

    const memberConfigs = listAgentIds()
      .map((id) => loadAgentConfig(id))
      .filter((c) => c && c.role === "team-member" && c.parentTeamId === teamId);
    const { toDisable, skip } = planTeamDisable(memberConfigs);

    const disabled = [];
    const failed = [];
    for (const id of toDisable) {
      try {
        await this.disableAgent(id, { mode });
        const cfg = loadAgentConfig(id);
        const updated = { ...cfg, disabledByTeam: true };
        saveAgentConfig(id, updated);
        this.agentConfigs.set(id, { config: updated });
        disabled.push(id);
      } catch (err) {
        failed.push({ id, error: err.message });
      }
    }

    const teamUpdated = { ...teamCfg, enabled: false };
    saveAgentConfig(teamId, teamUpdated);
    this.agentConfigs.set(teamId, { config: teamUpdated });

    console.log(`[Orchestrator] team ${teamId} disabled → ${disabled.length} member(s) disabled, ${skip.length} already off, ${failed.length} failed`);
    return { teamId, disabled, skipped: skip, failed };
  }
```

- [ ] **Step 6: Add `enableTeam`**

Add this method right after `disableTeam`:

```js
  // Re-enable every member disableTeam previously tagged disabledByTeam.
  // Members disabled independently before the team went down, or never
  // activated, are left exactly as they are (see the design spec). The
  // team's own config flips to enabled FIRST, so the per-member
  // enableAgent() calls below don't trip their own lockout guard.
  async enableTeam(teamId) {
    const teamCfg = loadAgentConfig(teamId);
    if (!teamCfg) throw new Error(`Team '${teamId}' not found`);
    if (teamCfg.role !== "team") throw new Error(`Agent '${teamId}' is not a team (role=${teamCfg.role})`);

    const teamUpdated = { ...teamCfg, enabled: true };
    saveAgentConfig(teamId, teamUpdated);
    this.agentConfigs.set(teamId, { config: teamUpdated });

    const memberConfigs = listAgentIds()
      .map((id) => loadAgentConfig(id))
      .filter((c) => c && c.role === "team-member" && c.parentTeamId === teamId);
    const { toEnable, skip } = planTeamEnable(memberConfigs);

    const enabled = [];
    const failed = [];
    for (const id of toEnable) {
      try {
        await this.enableAgent(id);
        const cfg = loadAgentConfig(id);
        const { disabledByTeam, ...rest } = cfg;
        saveAgentConfig(id, rest);
        this.agentConfigs.set(id, { config: rest });
        enabled.push(id);
      } catch (err) {
        failed.push({ id, error: err.message });
      }
    }

    console.log(`[Orchestrator] team ${teamId} enabled → ${enabled.length} member(s) re-enabled, ${skip.length} left as-is, ${failed.length} failed`);
    return { teamId, enabled, skipped: skip, failed };
  }
```

- [ ] **Step 7: Sanity-check with Node's syntax checker**

Run: `node --check orchestrator/orchestrator.js`
Expected: no output (valid syntax). This file has no unit-test harness (see Global Constraints), so full behavioral verification happens once Task 3's routes exist and can be curled — but catching a typo now avoids debugging it through an HTTP round-trip later.

- [ ] **Step 8: Commit**

```bash
git add orchestrator/orchestrator.js
git commit -m "feat: add team-wide disable/enable core logic to Orchestrator"
```

---

### Task 3: Orchestrator HTTP routes

**Files:**
- Modify: `orchestrator/orchestrator.js`

**Interfaces:**
- Consumes: `orchestrator.listTeamMembersWithState`, `orchestrator.disableTeam`, `orchestrator.enableTeam` from Task 2.
- Produces: `GET /internal/teams/:id/members`, `POST /internal/teams/:id/disable`, `POST /internal/teams/:id/enable` — consumed by Task 5's admin-console proxy routes. Also updates the existing `/internal/agents/:id/enable` and `/internal/agents/:id/disable` routes to surface `409 team-disabled` from Task 2's lockout guard.

- [ ] **Step 1: Surface `team-disabled` as 409 on the existing enable route**

Find the enable route (`orchestrator.js:9463-9480`):

```js
    const enableMatch = req.method === 'POST' && req.url.match(/^\/internal\/agents\/([^/]+)\/enable$/);
    if (enableMatch) {
      const id = decodeURIComponent(enableMatch[1]);
      (async () => {
        try {
          const result = await orchestrator.enableAgent(id);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (err) {
          console.error(`[Orchestrator] enableAgent error for ${id}: ${err.message}`);
          const status = /not found/i.test(err.message) ? 404 : 500;
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      })();
      return;
    }
```

Replace the `catch` block's body with:

```js
        } catch (err) {
          console.error(`[Orchestrator] enableAgent error for ${id}: ${err.message}`);
          const status = err.code === 'team-disabled' ? 409 : /not found/i.test(err.message) ? 404 : 500;
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message, ...(err.code ? { code: err.code, teamId: err.teamId } : {}) }));
        }
```

- [ ] **Step 2: Surface `team-disabled` as 409 on the existing disable route**

Find the disable route (`orchestrator.js:9535-9561`) and apply the identical change to its `catch` block (the one inside the inner `(async () => { try { ... } catch (err) { ... } })()`, not the `result.warning` branch which stays as-is):

```js
          } catch (err) {
            console.error(`[Orchestrator] disableAgent error for ${id}: ${err.message}`);
            const status = err.code === 'team-disabled' ? 409 : /not found/i.test(err.message) ? 404 : 500;
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message, ...(err.code ? { code: err.code, teamId: err.teamId } : {}) }));
          }
```

- [ ] **Step 3: Add the three new team routes**

Find the existing `POST /internal/teams/:teamId/members` (add-member) route (`orchestrator.js:10510-10543`, starts with the comment `// POST /internal/teams/:teamId/members — add member to team`) and insert the following three new route blocks immediately before it:

```js
    // ── List a team's members with running/busy/trigger state ────────────
    // Feeds the team-wide disable/enable preview dialog in the admin console.
    const teamMembersMatch = req.method === 'GET' && req.url.match(/^\/internal\/teams\/([^/]+)\/members$/);
    if (teamMembersMatch) {
      const teamId = decodeURIComponent(teamMembersMatch[1]);
      try {
        const result = orchestrator.listTeamMembersWithState(teamId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        const status = /not found/i.test(err.message) ? 404 : 500;
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // ── Disable an entire team's members in one bulk action ───────────────
    // Body: { mode: 'drain' | 'abort' } — required, applied uniformly to
    // every currently-enabled member (the preview dialog already showed the
    // operator which members are busy before they picked one mode).
    const teamDisableMatch = req.method === 'POST' && req.url.match(/^\/internal\/teams\/([^/]+)\/disable$/);
    if (teamDisableMatch) {
      const teamId = decodeURIComponent(teamDisableMatch[1]);
      let body = '';
      req.on('data', d => body += d);
      req.on('end', () => {
        let parsed = {};
        try { parsed = JSON.parse(body || '{}'); } catch { /* ignore */ }
        (async () => {
          try {
            const result = await orchestrator.disableTeam(teamId, { mode: parsed.mode });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
          } catch (err) {
            console.error(`[Orchestrator] disableTeam error for ${teamId}: ${err.message}`);
            const status = /not found/i.test(err.message) ? 404
              : /not a team/i.test(err.message) ? 400
              : /mode must be/i.test(err.message) ? 400
              : 500;
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
          }
        })();
      });
      return;
    }

    // ── Re-enable an entire team's cascade-disabled members ───────────────
    const teamEnableMatch = req.method === 'POST' && req.url.match(/^\/internal\/teams\/([^/]+)\/enable$/);
    if (teamEnableMatch) {
      const teamId = decodeURIComponent(teamEnableMatch[1]);
      (async () => {
        try {
          const result = await orchestrator.enableTeam(teamId);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (err) {
          console.error(`[Orchestrator] enableTeam error for ${teamId}: ${err.message}`);
          const status = /not found/i.test(err.message) ? 404 : /not a team/i.test(err.message) ? 400 : 500;
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      })();
      return;
    }
```

- [ ] **Step 4: Rebuild and restart the orchestrator**

Run: `make build && make restart` (or `podman compose build orchestrator && podman compose up -d orchestrator` if `make restart` restarts more than needed)
Expected: container starts cleanly. Check: `podman logs --tail 50 orchestrator` shows no startup errors.

- [ ] **Step 5: Manually verify against a real team**

Pick (or create via the Team-Setup wizard / Add Member) a team id with at least two members, one of them individually disabled. Substitute `<teamId>` below.

```bash
curl -s http://localhost:4002/internal/teams/<teamId>/members | jq
```
Expected: `{ teamId, teamEnabled: true, members: [ { id, displayName, enabled, disabledByTeam: false, running, busy, activeTriggers } , ... ] }` — the independently-disabled member shows `enabled: false, disabledByTeam: false`.

```bash
curl -s -X POST http://localhost:4002/internal/teams/<teamId>/disable \
  -H 'Content-Type: application/json' -d '{"mode":"abort"}' | jq
```
Expected: `{ teamId, disabled: [...ids of previously-enabled members...], skipped: [...id of the already-disabled member...], failed: [] }`.

```bash
curl -s http://localhost:4002/internal/agents/<teamId>/enable  -X POST -o /dev/null -w '%{http_code}\n'
```
Wait — this is testing enable on the team agent itself, not a member; skip this line, it's not meaningful (the team agent isn't a stub/materialized-agent target for `enableAgent`). Instead verify the lockout:

```bash
curl -s -X POST http://localhost:4002/internal/agents/<one of the disabled member ids>/enable -o - -w '\n%{http_code}\n'
```
Expected: `409` with body `{"error":"Team '<teamId>' is disabled — enable the team first","code":"team-disabled","teamId":"<teamId>"}`.

```bash
curl -s -X POST http://localhost:4002/internal/teams/<teamId>/enable | jq
```
Expected: `{ teamId, enabled: [...same ids that were in "disabled" above...], skipped: [...the independently-disabled member's id...], failed: [] }`. Then re-run the `members` GET from above and confirm the independently-disabled member is *still* `enabled: false` while the others are back to `enabled: true, disabledByTeam: false`.

- [ ] **Step 6: Commit**

```bash
git add orchestrator/orchestrator.js
git commit -m "feat: add HTTP routes for team-wide disable/enable, surface 409 team-disabled"
```

---

### Task 4: Gate new-member creation on the team's disabled state

**Files:**
- Modify: `orchestrator/orchestrator.js`

**Interfaces:**
- Consumes: `teamCfg.enabled` (already loaded at the top of `addTeamMember`, `orchestrator.js:5935-5937`).
- Produces: no new interface — changes the `enabled`/`disabledByTeam` fields written by the existing `addTeamMember(teamId, opts)`.

- [ ] **Step 1: Gate the deferred-stub branch**

Find the stub-config object inside `addTeamMember`'s `if (opts.materialize === false) { ... }` branch (`orchestrator.js:5969-6009`). Its last field before the closing brace is:

```js
        enabled: false, // no token → isStub; UI shows it, enableAgent materializes it
      };
```

Change it to:

```js
        enabled: false, // no token → isStub; UI shows it, enableAgent materializes it
        // A member created while its team is disabled is tagged so
        // enableTeam brings it back automatically later — see
        // docs/superpowers/specs/2026-07-31-team-wide-disable-design.md.
        ...(teamCfg.enabled === false ? { disabledByTeam: true } : {}),
      };
```

- [ ] **Step 2: Gate the full-materialization branch**

Find the `memberConfig` object's last field in the non-deferred branch (`orchestrator.js:6044-6079`):

```js
      enabled: true,
    };
    saveAgentConfig(memberId, memberConfig);
    saveAgentPrompt(memberId, effectivePrompt, "team-member", env);

    if (Array.isArray(opts.triggers) && opts.triggers.length > 0) {
      saveTriggers(memberId, opts.triggers);
    }

    this.agentConfigs.set(memberId, { config: memberConfig });
    startAgentProcess(memberConfig);
```

Change to:

```js
      // A member created while its team is disabled comes up disabled too,
      // tagged so enableTeam brings it back automatically — see
      // docs/superpowers/specs/2026-07-31-team-wide-disable-design.md.
      enabled: teamCfg.enabled !== false,
      ...(teamCfg.enabled === false ? { disabledByTeam: true } : {}),
    };
    saveAgentConfig(memberId, memberConfig);
    saveAgentPrompt(memberId, effectivePrompt, "team-member", env);

    if (Array.isArray(opts.triggers) && opts.triggers.length > 0) {
      saveTriggers(memberId, opts.triggers);
    }

    this.agentConfigs.set(memberId, { config: memberConfig });
    if (memberConfig.enabled !== false) startAgentProcess(memberConfig);
```

- [ ] **Step 3: Rebuild, restart, and manually verify**

Run: `make build && make restart`

With a team already disabled (from Task 3's manual verification, or disable one now via `POST /internal/teams/<teamId>/disable`), add a new member:

```bash
curl -s -X POST http://localhost:4002/internal/teams/<teamId>/members \
  -H 'Content-Type: application/json' -d '{"displayName":"Test Member"}' | jq
```
Expected: `201` with the new member's config showing `enabled: false` (check via `GET /internal/teams/<teamId>/members` — the new member appears with `enabled: false, disabledByTeam: true`).

Then re-enable the team:

```bash
curl -s -X POST http://localhost:4002/internal/teams/<teamId>/enable | jq
```
Expected: the new member's id appears in `enabled: [...]`, and a follow-up `GET /internal/teams/<teamId>/members` shows it `enabled: true, disabledByTeam: false`.

- [ ] **Step 4: Commit**

```bash
git add orchestrator/orchestrator.js
git commit -m "feat: auto-disable new team members created while their team is disabled"
```

---

### Task 5: Admin-console API proxy routes

**Files:**
- Modify: `admin-console/api/api.js`

**Interfaces:**
- Consumes: `ORCH_URL()` (`admin-console/api/api.js:2097`), `AGENT_ID_RE` (`admin-console/api/api.js:146`), `getScope(req)`, `visibleTeam(scope, teamId)` (imported at `admin-console/api/api.js:24`) — all already defined in this file.
- Produces: `GET /api/teams/:teamId/members`, `POST /api/teams/:teamId/disable`, `POST /api/teams/:teamId/enable` — consumed by Task 7's frontend.

- [ ] **Step 1: Add the three routes**

Find the existing `GET /api/teams/:teamId/flow-anomalies` route (`admin-console/api/api.js:5645-5657`) and insert the following immediately after it:

```js
// GET /api/teams/:teamId/members — running/busy/trigger state for every
// member, feeding the team-wide disable/enable preview dialog.
app.get('/api/teams/:teamId/members', apiLimiter, async (req, res) => {
  const teamId = req.params.teamId;
  if (!AGENT_ID_RE.test(teamId)) return res.status(400).json({ error: 'Invalid team id' });
  const scope = getScope(req);
  if (!visibleTeam(scope, teamId)) return res.status(404).json({ error: 'Team not found' });
  try {
    const resp = await fetch(`${ORCH_URL()}/internal/teams/${encodeURIComponent(teamId)}/members`);
    const data = await resp.json().catch(() => ({}));
    return res.status(resp.status).json(data);
  } catch (err) {
    return res.status(502).json({ error: `Orchestrator unreachable: ${err.message}` });
  }
});

// POST /api/teams/:teamId/disable — bulk-disable every enabled member.
// Body: { mode: 'drain' | 'abort' }, required.
app.post('/api/teams/:teamId/disable', apiLimiter, async (req, res) => {
  const teamId = req.params.teamId;
  if (!AGENT_ID_RE.test(teamId)) return res.status(400).json({ error: 'Invalid team id' });
  const scope = getScope(req);
  if (!visibleTeam(scope, teamId)) return res.status(404).json({ error: 'Team not found' });
  const mode = req.body?.mode;
  if (mode !== 'drain' && mode !== 'abort') return res.status(400).json({ error: "mode must be 'drain' or 'abort'" });
  try {
    const resp = await fetch(`${ORCH_URL()}/internal/teams/${encodeURIComponent(teamId)}/disable`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode }),
    });
    const data = await resp.json().catch(() => ({}));
    return res.status(resp.status).json(data);
  } catch (err) {
    return res.status(502).json({ error: `Orchestrator unreachable: ${err.message}` });
  }
});

// POST /api/teams/:teamId/enable — bulk-enable every member the earlier
// disable tagged disabledByTeam.
app.post('/api/teams/:teamId/enable', apiLimiter, async (req, res) => {
  const teamId = req.params.teamId;
  if (!AGENT_ID_RE.test(teamId)) return res.status(400).json({ error: 'Invalid team id' });
  const scope = getScope(req);
  if (!visibleTeam(scope, teamId)) return res.status(404).json({ error: 'Team not found' });
  try {
    const resp = await fetch(`${ORCH_URL()}/internal/teams/${encodeURIComponent(teamId)}/enable`, { method: 'POST' });
    const data = await resp.json().catch(() => ({}));
    return res.status(resp.status).json(data);
  } catch (err) {
    return res.status(502).json({ error: `Orchestrator unreachable: ${err.message}` });
  }
});
```

- [ ] **Step 2: Rebuild and restart the admin console**

Run: `make build && make restart` (or `podman compose build admin-console && podman compose up -d admin-console` if narrower)

- [ ] **Step 3: Manually verify through the admin-console API (session cookie required)**

If you have a logged-in browser session, use its dev tools to copy the `aee_session` cookie value, then:

```bash
curl -s -H "Cookie: aee_session=<value>" http://localhost:4000/api/teams/<teamId>/members | jq
curl -s -H "Cookie: aee_session=<value>" -X POST http://localhost:4000/api/teams/<teamId>/disable \
  -H 'Content-Type: application/json' -d '{"mode":"abort"}' | jq
curl -s -H "Cookie: aee_session=<value>" -X POST http://localhost:4000/api/teams/<teamId>/enable | jq
```
Expected: same response shapes as Task 3's direct-orchestrator verification, now reachable through the public API.

- [ ] **Step 4: Commit**

```bash
git add admin-console/api/api.js
git commit -m "feat: proxy team-wide disable/enable through the admin-console API"
```

---

### Task 6: Frontend pure helper — `team-action-summary.js`

**Files:**
- Create: `admin-console/src/pages/team-action-summary.js`
- Create: `admin-console/src/pages/team-action-summary.test.js`

**Interfaces:**
- Produces: `summarizeTeamAction(result, members) -> { successIds: string[], failedMembers: [{ id, displayName, error }] }`. `result` is the `{ disabled|enabled, skipped, failed }` shape from Task 5's endpoints; `members` is the preview array from `GET /api/teams/:teamId/members` (used to resolve `displayName` for any failed id). Consumed by Task 7's `Agents.jsx`.

This mirrors the existing convention of extracting pure view-logic into a plain module with its own `node --test` file (see `admin-console/src/pages/credential-scope-view.js` / `.test.js`), so the "which members failed, and what do we show for their name" logic isn't buried untested inside a React event handler.

- [ ] **Step 1: Write the failing tests**

Create `admin-console/src/pages/team-action-summary.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';

import { summarizeTeamAction } from './team-action-summary.js';

const members = [
  { id: 'a', displayName: 'Alice' },
  { id: 'b', displayName: 'Bob' },
  { id: 'c', displayName: 'Carol' },
];

test('summarizeTeamAction: disable result with no failures', () => {
  const result = { teamId: 't', disabled: ['a', 'b'], skipped: ['c'], failed: [] };
  const summary = summarizeTeamAction(result, members);
  assert.deepEqual(summary.successIds, ['a', 'b']);
  assert.deepEqual(summary.failedMembers, []);
});

test('summarizeTeamAction: enable result with no failures uses the enabled key', () => {
  const result = { teamId: 't', enabled: ['a'], skipped: ['b', 'c'], failed: [] };
  const summary = summarizeTeamAction(result, members);
  assert.deepEqual(summary.successIds, ['a']);
  assert.deepEqual(summary.failedMembers, []);
});

test('summarizeTeamAction: failed ids are resolved to displayName via members list', () => {
  const result = { teamId: 't', disabled: ['a'], skipped: [], failed: [{ id: 'b', error: 'boom' }] };
  const summary = summarizeTeamAction(result, members);
  assert.deepEqual(summary.successIds, ['a']);
  assert.deepEqual(summary.failedMembers, [{ id: 'b', displayName: 'Bob', error: 'boom' }]);
});

test('summarizeTeamAction: a failed id absent from members falls back to the raw id as displayName', () => {
  const result = { teamId: 't', disabled: [], skipped: [], failed: [{ id: 'ghost', error: 'gone' }] };
  const summary = summarizeTeamAction(result, members);
  assert.deepEqual(summary.failedMembers, [{ id: 'ghost', displayName: 'ghost', error: 'gone' }]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test admin-console/src/pages/team-action-summary.test.js`
Expected: FAIL — `Cannot find module './team-action-summary.js'`

- [ ] **Step 3: Write the implementation**

Create `admin-console/src/pages/team-action-summary.js`:

```js
// Pure view-logic for the team-wide disable/enable result dialogs in
// Agents.jsx — turns the { disabled|enabled, skipped, failed } response
// from POST /api/teams/:id/{disable,enable} into what the UI renders,
// resolving failed member ids to their displayName from the preview list.

export function summarizeTeamAction(result, members) {
  const successIds = Array.isArray(result.disabled)
    ? result.disabled
    : Array.isArray(result.enabled)
    ? result.enabled
    : [];

  const byId = new Map((members || []).map((m) => [m.id, m]));
  const failedMembers = (Array.isArray(result.failed) ? result.failed : []).map((f) => ({
    id: f.id,
    displayName: byId.get(f.id)?.displayName || f.id,
    error: f.error,
  }));

  return { successIds, failedMembers };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test admin-console/src/pages/team-action-summary.test.js`
Expected: PASS (4 tests, 0 failures)

- [ ] **Step 5: Commit**

```bash
git add admin-console/src/pages/team-action-summary.js admin-console/src/pages/team-action-summary.test.js
git commit -m "feat: add pure summary helper for team-wide disable/enable results"
```

---

### Task 7: Frontend — `TeamCard` toggle, confirm dialogs, member lockout

**Files:**
- Modify: `admin-console/src/pages/Agents.jsx`

**Interfaces:**
- Consumes: `GET /api/teams/:teamId/members`, `POST /api/teams/:teamId/disable`, `POST /api/teams/:teamId/enable` (Task 5); `summarizeTeamAction` (Task 6); existing `ConfirmDialog` (already imported at `Agents.jsx:12`), `ToggleSwitch` (`Agents.jsx:616-644`), `apiCall`/`useApi` (`Agents.jsx:10`).
- Produces: no new exports — this is the terminal UI task.

- [ ] **Step 1: Add state for the team-action flow**

Near the existing state declarations in `Agents()` (`admin-console/src/pages/Agents.jsx:2006-2013`, right after `const [disableWarning, setDisableWarning] = useState(null);`), add:

```jsx
  // Team-wide disable/enable: preview + confirm + result, mirroring the
  // per-agent disableWarning flow but operating on every member at once.
  const [teamActionPrompt, setTeamActionPrompt] = useState(null); // { team, action: 'disable'|'enable', members }
  const [teamActionBusy, setTeamActionBusy] = useState(false);
  const [teamActionError, setTeamActionError] = useState(null);
  const [teamActionResult, setTeamActionResult] = useState(null); // { action, successIds, failedMembers }
```

- [ ] **Step 2: Add the handlers**

Near the existing `handleToggleEnabled`/`handleDisableConfirmed` functions (`admin-console/src/pages/Agents.jsx:2161-2205`), add:

```jsx
  async function handleToggleTeam(team) {
    const action = team.enabled === false ? 'enable' : 'disable';
    setTeamActionError(null);
    try {
      const { members } = await apiCall('GET', `/api/teams/${team.id}/members`);
      setTeamActionPrompt({ team, action, members });
    } catch (e) {
      setActionError(e.message);
    }
  }

  async function handleTeamDisableConfirmed(mode) {
    const { team, members } = teamActionPrompt;
    setTeamActionBusy(true);
    setTeamActionError(null);
    try {
      const result = await apiCall('POST', `/api/teams/${team.id}/disable`, { mode });
      const summary = summarizeTeamAction(result, members);
      setTeamActionPrompt(null);
      refetch();
      if (summary.failedMembers.length > 0) {
        setTeamActionResult({ action: 'disable', ...summary });
      }
    } catch (e) {
      setTeamActionError(e.message);
    } finally {
      setTeamActionBusy(false);
    }
  }

  async function handleTeamEnableConfirmed() {
    const { team, members } = teamActionPrompt;
    setTeamActionBusy(true);
    setTeamActionError(null);
    try {
      const result = await apiCall('POST', `/api/teams/${team.id}/enable`, {});
      const summary = summarizeTeamAction(result, members);
      setTeamActionPrompt(null);
      refetch();
      if (summary.failedMembers.length > 0) {
        setTeamActionResult({ action: 'enable', ...summary });
      }
    } catch (e) {
      setTeamActionError(e.message);
    } finally {
      setTeamActionBusy(false);
    }
  }
```

- [ ] **Step 3: Add the `import`**

Near the top of `Agents.jsx` alongside the other page-local pure-module imports (or with the component imports at `admin-console/src/pages/Agents.jsx:10-17`), add:

```jsx
import { summarizeTeamAction } from './team-action-summary.js';
```

- [ ] **Step 4: Add the `TeamCard` toggle**

In `TeamCard` (`admin-console/src/pages/Agents.jsx:1795`), add an `onToggleTeam` prop to the signature:

```jsx
function TeamCard({ agent, onEdit, onDelete, onAddMember, onActivate, onDeactivate, onToggleEnabled, onToggleTeam, onEditChild, onDeleteChild, onExport, onCloneChild, navigate, addingMember, busyIds }) {
```

Then, in the header JSX (`admin-console/src/pages/Agents.jsx:1831-1839`), add a `ToggleSwitch` right after the "Team" pill span:

```jsx
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 'var(--eb-font-semibold)', fontSize: 'var(--eb-text-md)', display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)' }}>
            {agent.displayName}
            <span style={{
              fontSize: 'var(--eb-text-xs)', color: 'var(--eb-accent-primary)',
              background: 'var(--eb-bg-app)', padding: '2px 8px',
              borderRadius: 'var(--eb-radius-full)', border: '1px solid var(--eb-accent-primary)',
            }}>Team</span>
            <ToggleSwitch
              checked={agent.enabled !== false}
              onChange={() => onToggleTeam(agent)}
              label={agent.enabled !== false ? 'Disable team' : 'Enable team'}
            />
          </div>
          <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', fontFamily: 'var(--eb-font-mono)' }}>
            {agent.id} · env: {agent.environmentId}
          </div>
        </div>
```

And pass `teamDisabled` down to each member `AgentRow` in the members-rendering block (`admin-console/src/pages/Agents.jsx:1893-1907`):

```jsx
          children.map((child, idx) => (
            <AgentRow
              key={child.id}
              agent={child}
              tree={{ depth: 1, ancestorMore: [], isLast: idx === children.length - 1, hasChildren: false, isCollapsed: false }}
              navigate={navigate}
              busy={busyIds.has(child.id)}
              locked={agent.enabled === false}
              onActivate={onActivate}
              onDeactivate={onDeactivate}
              onToggleEnabled={onToggleEnabled}
              onEdit={onEditChild}
              onDelete={onDeleteChild}
              onExport={onExport}
              onClone={onCloneChild}
            />
          ))
```

- [ ] **Step 5: Wire `locked` into `AgentRow`'s toggle**

In `AgentRow` (`admin-console/src/pages/Agents.jsx:1484`), add `locked` to the signature (default `false`):

```jsx
function AgentRow({ agent, onActivate, onDeactivate, onToggleEnabled, onEdit, onDelete, onOpenBrief, onExport, onClone, navigate, tree, busy, locked = false }) {
```

Then update its `ToggleSwitch` usage (`admin-console/src/pages/Agents.jsx:1540-1545`) — keep the "Deactivate" `IconButton` right after it completely unchanged (per design, "Deactivate" is never locked):

```jsx
            <ToggleSwitch
              checked={state === 'active'}
              onChange={() => onToggleEnabled(agent)}
              label={locked ? 'Team is disabled — enable the team first' : (state === 'active' ? 'Disable' : 'Enable')}
              disabled={busy || locked}
            />
```

(`ToggleSwitch` already supports `disabled` and uses `label` as its `aria-label`, so this both greys it out visually — via the existing `opacity: disabled ? 0.5 : 1` styling in `ToggleSwitch`, `admin-console/src/pages/Agents.jsx:616-644` — and gives assistive tech the right explanation, with no changes needed to `ToggleSwitch` itself.)

- [ ] **Step 6: Pass `onToggleTeam` from the main component**

Find where `<TeamCard` is rendered (`admin-console/src/pages/Agents.jsx:2430`) and add the new prop:

```jsx
            <TeamCard
              agent={agent}
              onEdit={handleEdit}
              onDelete={setDeleteTarget}
              onAddMember={handleAddMemberClick}
              onActivate={handleActivate}
              onDeactivate={setDeactivateTarget}
              onToggleEnabled={handleToggleEnabled}
              onToggleTeam={handleToggleTeam}
              onEditChild={handleEdit}
              onDeleteChild={setDeleteTarget}
              onExport={handleExport}
              onCloneChild={handleClone}
              navigate={navigate}
              addingMember={addingMemberId === agent.id}
              busyIds={busyIds}
            />
```

(Match this against the actual existing prop list at that call site — add `onToggleTeam={handleToggleTeam}` alongside whatever's already there; don't remove or rename any existing prop.)

- [ ] **Step 7: Add the two dialogs**

Near the existing `<DisableWarningDialog ... />` JSX (`admin-console/src/pages/Agents.jsx:2580-2588`), add:

```jsx
      <ConfirmDialog
        open={!!teamActionPrompt && teamActionPrompt.action === 'enable'}
        title={`Enable team "${teamActionPrompt?.team?.displayName ?? ''}"?`}
        message={teamActionPrompt && (
          <div>
            <p style={{ marginTop: 0 }}>
              This brings back every member this team disabled automatically. Members that were disabled on their own before the team was disabled stay off.
            </p>
            <ul style={{ margin: '0 0 var(--eb-space-2)', paddingLeft: 'var(--eb-space-5)', fontSize: 'var(--eb-text-sm)' }}>
              {teamActionPrompt.members.filter(m => m.disabledByTeam).map(m => (
                <li key={m.id}>{m.displayName}</li>
              ))}
            </ul>
            {teamActionError && (
              <p style={{ color: 'var(--eb-status-error)', fontSize: 'var(--eb-text-sm)' }}>{teamActionError}</p>
            )}
          </div>
        )}
        variant="info"
        confirmLabel="Enable team"
        busy={teamActionBusy}
        onConfirm={handleTeamEnableConfirmed}
        onCancel={() => { setTeamActionPrompt(null); setTeamActionError(null); }}
      />

      <TeamDisableDialog
        open={!!teamActionPrompt && teamActionPrompt.action === 'disable'}
        team={teamActionPrompt?.team}
        members={teamActionPrompt?.members || []}
        error={teamActionError}
        busy={teamActionBusy}
        onDrain={() => handleTeamDisableConfirmed('drain')}
        onAbort={() => handleTeamDisableConfirmed('abort')}
        onCancel={() => { setTeamActionPrompt(null); setTeamActionError(null); }}
      />

      <ConfirmDialog
        open={!!teamActionResult}
        variant="danger"
        alertOnly
        title={teamActionResult?.action === 'disable' ? 'Some members failed to disable' : 'Some members failed to enable'}
        message={teamActionResult && (
          <div>
            <p style={{ marginTop: 0 }}>
              {teamActionResult.failedMembers.length} member(s) could not be {teamActionResult.action === 'disable' ? 'disabled' : 'enabled'}:
            </p>
            <ul style={{ margin: 0, paddingLeft: 'var(--eb-space-5)', fontSize: 'var(--eb-text-sm)' }}>
              {teamActionResult.failedMembers.map(m => (
                <li key={m.id}><strong>{m.displayName}</strong> — {m.error}</li>
              ))}
            </ul>
          </div>
        )}
        onConfirm={() => setTeamActionResult(null)}
        onCancel={() => setTeamActionResult(null)}
      />
```

- [ ] **Step 8: Add the `TeamDisableDialog` component**

This mirrors the existing `DisableWarningDialog` (`admin-console/src/pages/Agents.jsx:2603-2661`) but lists every affected member instead of one agent, and applies the chosen mode to all of them. Add it right after `DisableWarningDialog`'s closing brace:

```jsx
function TeamDisableDialog({ open, team, members, error, busy, onDrain, onAbort, onCancel }) {
  if (!open) return null;
  const name = team?.displayName ?? team?.id ?? 'this team';
  const toDisable = members.filter(m => m.enabled);
  const busyCount = toDisable.filter(m => m.busy || (m.activeTriggers?.length ?? 0) > 0).length;

  return (
    <div role="dialog" aria-modal="true" aria-label="Disable team" style={{
      position: 'fixed', inset: 0, background: 'oklch(0 0 0 / 0.5)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999,
    }}>
      <div style={{
        background: 'var(--eb-bg-surface)', border: '1px solid var(--eb-border-default)',
        borderRadius: 'var(--eb-radius-lg)', padding: 'var(--eb-space-5)', maxWidth: 520,
        width: '90%', boxShadow: 'var(--eb-shadow-xl)',
      }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 'var(--eb-space-3)' }}>
          <span style={{ color: 'var(--eb-status-warning)', flexShrink: 0, marginTop: 2, fontSize: 20 }}>⚠</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h3 style={{ margin: 0, fontSize: 'var(--eb-text-md)', fontWeight: 'var(--eb-font-semibold)', color: 'var(--eb-text-primary)' }}>
              Disable team "{name}"
            </h3>
            <p style={{ margin: 'var(--eb-space-2) 0 0', fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)', lineHeight: 1.5 }}>
              {toDisable.length === 0
                ? 'Every member is already disabled — this only marks the team itself as disabled.'
                : `${toDisable.length} member${toDisable.length !== 1 ? 's' : ''} will be disabled${busyCount > 0 ? ` (${busyCount} currently busy or with active triggers)` : ''}. Choose how to proceed:`}
            </p>
            {toDisable.length > 0 && (
              <ul style={{ margin: 'var(--eb-space-2) 0 0', paddingLeft: 'var(--eb-space-5)', fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)', maxHeight: 200, overflowY: 'auto' }}>
                {toDisable.map(m => (
                  <li key={m.id}>
                    {m.displayName}
                    {(m.busy || (m.activeTriggers?.length ?? 0) > 0) && (
                      <span style={{ color: 'var(--eb-status-warning)' }}> — {m.busy ? 'busy' : `${m.activeTriggers.length} active trigger(s)`}</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {members.some(m => !m.enabled) && (
              <p style={{ margin: 'var(--eb-space-2) 0 0', fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>
                {members.filter(m => !m.enabled).length} member(s) already disabled are left untouched.
              </p>
            )}
            {error && (
              <p style={{ color: 'var(--eb-status-error)', fontSize: 'var(--eb-text-sm)', marginTop: 'var(--eb-space-2)' }}>{error}</p>
            )}
          </div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--eb-space-2)', marginTop: 'var(--eb-space-4)' }}>
          <button onClick={onCancel} disabled={busy}>Cancel</button>
          <button onClick={onDrain} disabled={busy}>Let running work finish</button>
          <button onClick={onAbort} disabled={busy}>Hard stop</button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 9: Manual browser verification**

Run `make up` (or ensure the stack is already up from earlier tasks) and open the admin console at `http://localhost:4000/agents`.

1. Find a team with at least two members, one of which is individually disabled (toggle one off manually first if needed).
2. Click the new toggle next to the team's "Team" pill. Confirm the `TeamDisableDialog` lists only the currently-enabled members, shows a note about the already-disabled one being left untouched, and both mode buttons are present.
3. Click "Hard stop". Confirm: the dialog closes, the team list refetches, the team toggle now shows disabled, and every member row's own toggle is greyed out (hover shows the "Team is disabled" tooltip) — including the one that was already off before.
4. Click the team toggle again (now "Enable team"). Confirm the `ConfirmDialog` lists the members that will come back (the ones tagged `disabledByTeam`), and does NOT list the independently-disabled one.
5. Confirm. Verify the previously-cascade-disabled members are now active again, their toggles are no longer greyed out, and the independently-disabled member is still off (not greyed out — its toggle is interactive again since the team is enabled).
6. With the team still enabled, manually toggle that independently-disabled member on, then repeat steps 2–3 to disable the team again — confirm this member now correctly shows up in the "will be disabled" list (since it's enabled at the moment the team disable fires) and gets tagged `disabledByTeam` this time.

- [ ] **Step 10: Commit**

```bash
git add admin-console/src/pages/Agents.jsx
git commit -m "feat: add team-wide disable/enable UI to the TeamCard header"
```

---

### Task 8: Update the design spec status and wrap up

**Files:**
- Modify: `docs/superpowers/specs/2026-07-31-team-wide-disable-design.md`

- [ ] **Step 1: Mark the spec as implemented**

Change the `**Status:**` line from `Approved for implementation` to `Implemented`.

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/specs/2026-07-31-team-wide-disable-design.md
git commit -m "docs: mark team-wide disable/enable spec as implemented"
```

- [ ] **Step 3: Hand off**

Report back to the user: which branch/worktree this landed on, a summary of the manual verification performed in Tasks 3/4/5/7, and that this is ready for the `superpowers:finishing-a-development-branch` skill (merge, PR, or further review) — do not merge or open a PR without being asked.
