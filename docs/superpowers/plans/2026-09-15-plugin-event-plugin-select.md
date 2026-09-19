# Plugin-event trigger: plugin picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In the shared `TriggerForm`, the `plugin-event` type's **Plugin id** free-text field becomes a `<select>` of installed plugins, granted-first, so a listener can no longer be authored against a plugin that can never fire it.

**Architecture:** One new pure, dependency-free view module (`plugin-event-options.js`, beside `trigger-summary.js`) decides the option list from `GET /api/plugins` + the agent's effective plugin grant; `TriggersPanel.jsx` lazily fetches those two inputs when `plugin-event` is the active type (the exact pattern the `github-event` repo select already uses with `availableRepos`) and renders the select. A source-reading wiring test (#651 convention) pins that the JSX actually calls the module. `eventFilter` stays free text — the manifest declares no event names (out of scope by decision).

**Tech Stack:** React 18 JSX (untested per #651), pure ESM modules under `node --test`, existing `apiCall` hook, existing `effectiveGrantFor` from `src/pages/plugin-grant-view.js`.

**Spec:** No separate spec file. The design was settled in the conversation of 2026-09-15 and is restated in *Design decisions* below; this plan is the record.

## Global Constraints

- **Branch:** the free-text field was introduced by this feature branch (`feat/jira-events-plugin`, commit `99c116a9d`), so the work lands **on that branch**, not on `main`. Work in a worktree on a short-lived branch off it and fast-forward it back (see *Branch & worktree* below).
- **Tests:** `cd admin-console && node --test "src/**/*.test.js"` is the `admin-console-src` CI job. Pure modules only — JSX is never loaded by tests; JSX wiring is guarded by source-reading tests that strip comments first (`rail-lifecycle-wiring.test.js` is the model).
- **No `eventFilter` picker, no manifest change.** `plugin-event.js:98` calls the filter "opaque to the platform"; keep it so.
- **Nothing server-side changes.** `POST/PUT /api/agents/:id/triggers` keeps accepting `pluginId` as a string; the select only narrows what the client offers.
- **Copy:** UI strings in English, matching the surrounding form; the retained-but-uninstalled option must say so in the option text itself (a `<select>` cannot show a hint on a single option).
- **Commit messages:** conventional style used on this branch, e.g. `feat(jira-plugin): …`, `test(jira-plugin): …`, `docs(jira-plugin): …`.

## Design decisions (from the conversation)

1. `pluginId` is a **foreign key** onto an installed plugin: the orchestrator matches `trigger.pluginId === pluginId` exactly (`orchestrator/plugin-event.js:104`) and wakes only agents the plugin is **granted** to (`resolvePluginEventTargets`, line 119). A typo or an ungranted plugin yields a listener that silently never fires. A select prevents both by construction.
2. **Granted-first, ungranted visible-but-disabled** with the reason in the option text — the user sees *why* a plugin is missing (the Plugins page's team-assign control uses the same visible-but-disabled idea).
3. **Retain an unknown stored value**: editing a trigger whose plugin was uninstalled (or is not in the list for any reason) must not silently drop the id — it is offered as a selectable option labelled *"— not installed"* so a save round-trips it.
4. **Draft mode** (`ops.mode === 'draft'`, Flow-editor drafts): no agent exists yet, so no grant can be read — offer **all installed plugins** and say the grant is checked at materialise time (the repo field's draft note is the precedent).
5. **Grant unknown at runtime** (e.g. the parent team's config is unreadable / 404s through the work-plane gate): fall back to all installed, un-marked — never mark every plugin "not granted" on a read failure.
6. **Auto-pick** when exactly one plugin is grantable and the field is empty — mirrors the repo auto-pick.

## Branch & worktree

The feature branch is checked out in the main working copy, and git refuses to check one branch out in two worktrees, so:

```bash
cd /workspace/workspace/314092_agent-execution-environment
git worktree add .claude/worktrees/plugin-event-select -b feat/jira-plugin-event-select feat/jira-events-plugin
```

Then `EnterWorktree` with `path: .claude/worktrees/plugin-event-select`. All commits below happen on `feat/jira-plugin-event-select`. When the plan is done (Task 5), fast-forward the feature branch:

```bash
cd /workspace/workspace/314092_agent-execution-environment
git merge --ff-only feat/jira-plugin-event-select
git push origin feat/jira-events-plugin
```

(`--ff-only` — if it refuses, the feature branch moved meanwhile; rebase the short branch onto it first, never merge the other way.)

## File structure

| File | Responsibility |
|---|---|
| **Create** `admin-console/src/pages/agent-chat/plugin-event-options.js` | Pure decisions: option list + notice for the plugin select, and the auto-pick default. No React, no fetch. |
| **Create** `admin-console/src/pages/agent-chat/plugin-event-options.test.js` | Unit tests for the above. |
| **Modify** `admin-console/src/pages/agent-chat/TriggersPanel.jsx` (`TriggerForm`: state ~line 634, validation line 779, body line 830, JSX lines 912–930) | Lazy fetch of `/api/plugins` + agent (+ parent team) grant; render the select; auto-pick; validation copy. |
| **Create** `admin-console/src/pages/agent-chat/plugin-event-select-wiring.test.js` | Source-reading drift guard: the JSX imports and calls the pure module, renders a `<select>` for `pluginId`, and no free-text `FormInput` for it survives. |
| **Modify** `docs/jira-plugin.md:109` | The operator guide's trigger table row. |

---

### Task 1: Pure option-list module

**Files:**
- Create: `admin-console/src/pages/agent-chat/plugin-event-options.js`
- Test: `admin-console/src/pages/agent-chat/plugin-event-options.test.js`

**Interfaces:**
- Consumes: nothing from other tasks. Input shapes come from existing endpoints: `installed` is `GET /api/plugins` → `body.installed` (`[{ id, ok, manifest: { name, … } | null, installed: true, sidecarRunning }]`); `grant` is the return of the existing `effectiveGrantFor(agent, parentTeam)` (`[{ id, scopeGranularity }]`) or `null` when unknown.
- Produces (Task 2 and Task 3 rely on these exact names):
  - `pluginEventOptions({ installed, grant, currentId, draft })` → `{ options: [{ value, label, disabled }], notice: string | null }`. `options[0]` is always the placeholder `{ value: '', label: PLACEHOLDER_LABEL, disabled: false }`.
  - `defaultPluginId(options)` → the single selectable non-placeholder, non-retained option's `value`, else `''`.
  - Exported constants: `PLACEHOLDER_LABEL`, `NOT_GRANTED_SUFFIX`, `NOT_INSTALLED_SUFFIX`, `NO_PLUGINS_NOTICE`, `DRAFT_NOTICE`, `GRANT_UNKNOWN_NOTICE`.

- [ ] **Step 1: Write the failing tests**

```js
// admin-console/src/pages/agent-chat/plugin-event-options.test.js
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  pluginEventOptions,
  defaultPluginId,
  PLACEHOLDER_LABEL,
  NOT_GRANTED_SUFFIX,
  NOT_INSTALLED_SUFFIX,
  NO_PLUGINS_NOTICE,
  DRAFT_NOTICE,
  GRANT_UNKNOWN_NOTICE,
} from './plugin-event-options.js';

const plugin = (id, name, extra = {}) => ({ id, ok: true, installed: true, sidecarRunning: true, manifest: { id, name }, ...extra });
const INSTALLED = [plugin('jira', 'Jira'), plugin('dummy-echo', 'Dummy echo'), plugin('netzplan', 'Network plan')];

test('placeholder is always the first option and is selectable', () => {
  const { options } = pluginEventOptions({ installed: INSTALLED, grant: [], currentId: '' });
  assert.deepEqual(options[0], { value: '', label: PLACEHOLDER_LABEL, disabled: false });
});

test('granted plugins come first and are enabled; ungranted are disabled with the reason in the label', () => {
  const { options, notice } = pluginEventOptions({
    installed: INSTALLED, grant: [{ id: 'netzplan', scopeGranularity: 'team' }], currentId: '',
  });
  const [, first, ...rest] = options;
  assert.equal(first.value, 'netzplan');
  assert.equal(first.disabled, false);
  assert.equal(first.label, 'Network plan (netzplan)');
  for (const o of rest) {
    assert.equal(o.disabled, true, `${o.value} must be disabled`);
    assert.ok(o.label.endsWith(NOT_GRANTED_SUFFIX), `${o.value} must say why`);
  }
  assert.equal(notice, null);
});

test('label is the manifest name with the id in parentheses; id alone when they coincide or the name is missing', () => {
  const installed = [plugin('jira', 'jira'), { id: 'bare', ok: true, installed: true, manifest: {} }];
  const { options } = pluginEventOptions({ installed, grant: null, currentId: '' });
  assert.equal(options.find(o => o.value === 'jira').label, 'jira');
  assert.equal(options.find(o => o.value === 'bare').label, 'bare');
});

test('grant null (unknown) offers every installed plugin un-marked and says so', () => {
  const { options, notice } = pluginEventOptions({ installed: INSTALLED, grant: null, currentId: '' });
  assert.equal(options.length, 1 + INSTALLED.length);
  assert.ok(options.slice(1).every(o => o.disabled === false));
  assert.ok(options.slice(1).every(o => !o.label.endsWith(NOT_GRANTED_SUFFIX)));
  assert.equal(notice, GRANT_UNKNOWN_NOTICE);
});

test('draft mode offers every installed plugin and carries the draft notice, whatever the grant', () => {
  const { options, notice } = pluginEventOptions({ installed: INSTALLED, grant: [], currentId: '', draft: true });
  assert.equal(options.length, 1 + INSTALLED.length);
  assert.ok(options.slice(1).every(o => o.disabled === false));
  assert.equal(notice, DRAFT_NOTICE);
});

test('a plugin whose manifest is broken is not offered', () => {
  const installed = [plugin('jira', 'Jira'), { id: 'broken', ok: false, installed: true, manifest: null, errors: ['x'] }];
  const { options } = pluginEventOptions({ installed, grant: null, currentId: '' });
  assert.ok(!options.some(o => o.value === 'broken'));
});

test('a stored id that is not installed is retained as a selectable option that says so', () => {
  const { options } = pluginEventOptions({ installed: INSTALLED, grant: [{ id: 'jira' }], currentId: 'gone' });
  const retained = options.find(o => o.value === 'gone');
  assert.ok(retained, 'the stored value must still be offered');
  assert.equal(retained.disabled, false);
  assert.equal(retained.label, `gone${NOT_INSTALLED_SUFFIX}`);
  assert.equal(options[1].value, 'gone', 'retained value sits right after the placeholder so the select shows it');
});

test('a stored id that IS installed is not duplicated', () => {
  const { options } = pluginEventOptions({ installed: INSTALLED, grant: [], currentId: 'jira' });
  assert.equal(options.filter(o => o.value === 'jira').length, 1);
});

test('a stored id that is installed but ungranted stays selectable (editing must round-trip), still labelled ungranted', () => {
  const { options } = pluginEventOptions({ installed: INSTALLED, grant: [{ id: 'netzplan' }], currentId: 'jira' });
  const jira = options.find(o => o.value === 'jira');
  assert.equal(jira.disabled, false);
  assert.ok(jira.label.endsWith(NOT_GRANTED_SUFFIX));
});

test('no installed plugins → placeholder only and the no-plugins notice', () => {
  const { options, notice } = pluginEventOptions({ installed: [], grant: [], currentId: '' });
  assert.equal(options.length, 1);
  assert.equal(notice, NO_PLUGINS_NOTICE);
});

test('tolerates non-array inputs', () => {
  const { options } = pluginEventOptions({ installed: undefined, grant: 'nope', currentId: undefined });
  assert.equal(options.length, 1);
});

test('defaultPluginId: exactly one selectable non-retained plugin → its id; otherwise empty', () => {
  const one = pluginEventOptions({ installed: INSTALLED, grant: [{ id: 'jira' }], currentId: '' }).options;
  assert.equal(defaultPluginId(one), 'jira');
  const two = pluginEventOptions({ installed: INSTALLED, grant: [{ id: 'jira' }, { id: 'netzplan' }], currentId: '' }).options;
  assert.equal(defaultPluginId(two), '');
  const none = pluginEventOptions({ installed: INSTALLED, grant: [], currentId: '' }).options;
  assert.equal(defaultPluginId(none), '');
  // A retained (uninstalled) value never counts as the "one" — it is a leftover, not a choice.
  const retainedOnly = pluginEventOptions({ installed: [], grant: [], currentId: 'gone' }).options;
  assert.equal(defaultPluginId(retainedOnly), '');
  // Unknown grant: every installed plugin is selectable, so only a single install auto-picks.
  const single = pluginEventOptions({ installed: [plugin('jira', 'Jira')], grant: null, currentId: '' }).options;
  assert.equal(defaultPluginId(single), 'jira');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd admin-console && node --test src/pages/agent-chat/plugin-event-options.test.js`
Expected: FAIL — `Cannot find module './plugin-event-options.js'`.

- [ ] **Step 3: Write the implementation**

```js
// admin-console/src/pages/agent-chat/plugin-event-options.js
// Pure decisions for the `plugin-event` trigger's plugin picker.
//
// `pluginId` on a plugin-event trigger is a foreign key: the orchestrator
// matches it exactly (`plugin-event.js` matchesPluginEventTrigger) and wakes
// only agents the plugin is *granted* to (resolvePluginEventTargets). A typo
// or an ungranted plugin is therefore a listener that silently never fires —
// which is why this is a select over the installed registry, granted-first,
// and not a free-text field. No React, no fetch: the JSX feeds it the
// `installed` list from GET /api/plugins and the agent's effective grant.

export const PLACEHOLDER_LABEL = '— Select a plugin —';
export const NOT_GRANTED_SUFFIX = ' — not granted to this agent';
export const NOT_INSTALLED_SUFFIX = ' — not installed';
export const NO_PLUGINS_NOTICE = 'No plugins are installed. A System Admin installs one on the Plugins page; a Team Admin then grants it to the team.';
export const DRAFT_NOTICE = 'Any installed plugin can be named here; whether it is granted to the agent is checked when the draft is materialised.';
export const GRANT_UNKNOWN_NOTICE = 'Could not read which plugins are granted to this agent — every installed plugin is offered.';

function labelFor(entry) {
  const name = entry && entry.manifest && typeof entry.manifest.name === 'string' ? entry.manifest.name.trim() : '';
  if (!name || name === entry.id) return entry.id;
  return `${name} (${entry.id})`;
}

// { installed, grant, currentId, draft } → { options, notice }
//   installed: GET /api/plugins → body.installed
//   grant:     effectiveGrantFor(agent, parentTeam) ([{id, scopeGranularity}]),
//              or null when it cannot be known (draft mode, unreadable parent)
//   currentId: the form's current pluginId (retained if it is not installed)
//   draft:     Flow-editor draft mode — there is no agent, so no grant
export function pluginEventOptions({ installed, grant, currentId, draft = false } = {}) {
  const list = Array.isArray(installed) ? installed.filter(p => p && p.ok !== false && typeof p.id === 'string' && p.id) : [];
  const grantKnown = !draft && Array.isArray(grant);
  const grantedIds = new Set(grantKnown ? grant.map(g => (typeof g === 'string' ? g : g && g.id)).filter(Boolean) : []);
  const current = typeof currentId === 'string' ? currentId.trim() : '';

  const rows = list.map(p => {
    const granted = !grantKnown || grantedIds.has(p.id);
    return {
      value: p.id,
      // The stored value must stay selectable so an edit round-trips it, even
      // when the grant was revoked meanwhile — but it still says so.
      disabled: !granted && p.id !== current,
      label: granted ? labelFor(p) : `${labelFor(p)}${NOT_GRANTED_SUFFIX}`,
      granted,
    };
  });
  // Granted first, stable within each group (registry order).
  rows.sort((a, b) => Number(b.granted) - Number(a.granted));

  const options = [{ value: '', label: PLACEHOLDER_LABEL, disabled: false }];
  if (current && !list.some(p => p.id === current)) {
    options.push({ value: current, label: `${current}${NOT_INSTALLED_SUFFIX}`, disabled: false, retained: true });
  }
  for (const r of rows) options.push({ value: r.value, label: r.label, disabled: r.disabled });

  let notice = null;
  if (list.length === 0) notice = NO_PLUGINS_NOTICE;
  else if (draft) notice = DRAFT_NOTICE;
  else if (!grantKnown) notice = GRANT_UNKNOWN_NOTICE;

  return { options, notice };
}

// The auto-pick: exactly one real, selectable choice → its id, else ''. A
// retained (uninstalled) value is a leftover, never the one choice.
export function defaultPluginId(options) {
  const candidates = (Array.isArray(options) ? options : [])
    .filter(o => o && o.value && !o.disabled && !o.retained);
  return candidates.length === 1 ? candidates[0].value : '';
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd admin-console && node --test src/pages/agent-chat/plugin-event-options.test.js`
Expected: all 12 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add admin-console/src/pages/agent-chat/plugin-event-options.js admin-console/src/pages/agent-chat/plugin-event-options.test.js
git commit -m "feat(jira-plugin): pure option list for the plugin-event plugin picker"
```

---

### Task 2: Wire the select into `TriggerForm`

**Files:**
- Modify: `admin-console/src/pages/agent-chat/TriggersPanel.jsx`
  - imports (lines 1–25)
  - the lazy-fetch block after the `availableRepos` effects (insert after line ~700, before the `loopRoster` comment)
  - validation, line 779
  - the `plugin-event` JSX, lines 912–930

**Interfaces:**
- Consumes: `pluginEventOptions`, `defaultPluginId` from Task 1; the existing `effectiveGrantFor(agent, parentTeam)` from `../plugin-grant-view.js`; the existing `apiCall`, `isDraftMode`, `agentId`, `form`, `set`, `FIELD_STYLE`, `Loader2`.
- Produces: the select's `value` is still `form.pluginId`; the submit body (line 830) is unchanged — `body.pluginId = form.pluginId.trim()`.

- [ ] **Step 1: Add the imports**

At line 9 (after the `AGENT_CHAT_HELP_SECTIONS` import) add:

```js
import { effectiveGrantFor } from '../plugin-grant-view.js';
import { pluginEventOptions, defaultPluginId } from './plugin-event-options.js';
```

- [ ] **Step 2: Add the lazy fetch + derived options**

Insert directly **before** the comment `// Loop verifier roster — for a team agent, …` (≈ line 704) — i.e. after the repo auto-pick effect:

```js
  // Plugin-event picker inputs — the installed registry plus this agent's
  // effective plugin grant, fetched once, only while plugin-event is the
  // active type (the `availableRepos` pattern). `grant: null` means "cannot
  // know" — draft mode, or the parent team's config was unreadable — and the
  // pure module then offers everything un-marked rather than marking every
  // plugin "not granted" on a read failure. `null` state = not loaded.
  const [pluginInputs, setPluginInputs] = useState(null);
  useEffect(() => {
    if (form.type !== 'plugin-event' || pluginInputs !== null) return undefined;
    let cancelled = false;
    (async () => {
      let installed = [];
      let grant = null;
      try {
        const reg = await apiCall('GET', '/api/plugins');
        installed = Array.isArray(reg?.installed) ? reg.installed : [];
      } catch { /* registry unreadable → empty list → NO_PLUGINS_NOTICE */ }
      if (!isDraftMode) {
        try {
          const agent = await apiCall('GET', `/api/agents/${encodeURIComponent(agentId)}`);
          let parentTeam = null;
          if (agent?.role === 'team-member' && agent.parentTeamId && !Array.isArray(agent.pluginsOverride)) {
            // Only the inherit case needs the parent; an override is self-contained.
            parentTeam = await apiCall('GET', `/api/agents/${encodeURIComponent(agent.parentTeamId)}`);
          }
          grant = effectiveGrantFor(agent, parentTeam);
        } catch { grant = null; }
      }
      if (!cancelled) setPluginInputs({ installed, grant });
    })();
    return () => { cancelled = true; };
  }, [form.type, agentId, pluginInputs, isDraftMode]);

  const pluginPick = pluginInputs === null
    ? null
    : pluginEventOptions({ ...pluginInputs, currentId: form.pluginId, draft: isDraftMode });

  // Auto-pick when there is exactly one plugin that could fire this listener
  // and nothing is chosen yet — mirrors the single-repo auto-pick above.
  useEffect(() => {
    if (!pluginPick || form.pluginId) return;
    const only = defaultPluginId(pluginPick.options);
    if (only) setForm(f => (f.pluginId ? f : { ...f, pluginId: only }));
  }, [pluginPick, form.pluginId]);
```

- [ ] **Step 3: Update the validation copy (line 779)**

Replace:

```js
    if (form.type === 'plugin-event' && !form.pluginId.trim()) { setFormError('Plugin id is required (the plugin that may fire this listener).'); return; }
```

with:

```js
    if (form.type === 'plugin-event' && !form.pluginId.trim()) { setFormError('Select the plugin that may fire this listener.'); return; }
```

- [ ] **Step 4: Replace the free-text field with the select (lines 912–930)**

Replace the whole `{form.type === 'plugin-event' && ( … )}` block with:

```jsx
      {form.type === 'plugin-event' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-2)' }}>
          <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>
            Fires when a granted plugin&rsquo;s broker sends an event for this team.
            The plugin is granted on the Plugins page; the event name is the broker&rsquo;s
            own (e.g. <code style={{ fontFamily: 'var(--eb-font-mono)' }}>status_changed</code>).
          </div>
          <div>
            <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', fontWeight: 'var(--eb-font-medium)', marginBottom: 'var(--eb-space-1)' }}>
              Plugin
            </div>
            {pluginPick === null ? (
              <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-muted)', padding: 'var(--eb-space-2)' }}>
                <Loader2 size={12} style={{ animation: 'spin 1s linear infinite', marginRight: 6, verticalAlign: 'middle' }} />
                Loading plugins…
              </div>
            ) : (
              <>
                {/* A select, not free text: pluginId is a foreign key the orchestrator
                    matches exactly and only fires for a granted plugin — see
                    plugin-event-options.js for the option rules. */}
                <select
                  value={form.pluginId}
                  onChange={e => set('pluginId', e.target.value)}
                  style={{ ...FIELD_STYLE, width: '100%' }}
                >
                  {pluginPick.options.map(o => (
                    <option key={o.value || '__placeholder'} value={o.value} disabled={o.disabled}>{o.label}</option>
                  ))}
                </select>
                {pluginPick.notice && (
                  <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', marginTop: 'var(--eb-space-1)', lineHeight: 1.5 }}>
                    {pluginPick.notice}
                  </div>
                )}
              </>
            )}
          </div>
          <FormInput
            label="Event filter (optional)"
            value={form.eventFilter}
            onChange={v => set('eventFilter', v)}
            placeholder="blank = any event from this plugin"
          />
        </div>
      )}
```

- [ ] **Step 5: Build to prove the JSX compiles and the existing suite is green**

Run: `cd admin-console && npm run build 2>&1 | tail -5 && node --test "src/**/*.test.js" 2>&1 | tail -8`
Expected: Vite build succeeds (`✓ built in …`); the test summary shows `fail 0`.

- [ ] **Step 6: Commit**

```bash
git add admin-console/src/pages/agent-chat/TriggersPanel.jsx
git commit -m "feat(jira-plugin): plugin-event trigger picks the plugin from the installed registry"
```

---

### Task 3: Source-reading wiring guard

**Files:**
- Create: `admin-console/src/pages/agent-chat/plugin-event-select-wiring.test.js`

**Interfaces:**
- Consumes: the source of `TriggersPanel.jsx` as text; the exact identifiers `pluginEventOptions`, `defaultPluginId`, `effectiveGrantFor`, `pluginPick`, `pluginInputs` from Task 2.
- Produces: nothing — this is the #651 guard that keeps Task 1 from becoming dead code.

- [ ] **Step 1: Write the guard**

```js
// admin-console/src/pages/agent-chat/plugin-event-select-wiring.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Drift guard for the plugin-event plugin picker.
 *
 * The option rules live in `plugin-event-options.js` (unit-tested). What that
 * test cannot see is whether `TriggerForm` still *calls* them: TriggersPanel.jsx
 * is JSX, which `node --test` never loads (#651), so a revert to a free-text
 * `FormInput` for `pluginId` would leave every pure test green while the form
 * silently went back to accepting typos. Same spirit as
 * `rail-lifecycle-wiring.test.js`: wiring, never copy.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = rel => fs.readFileSync(path.join(HERE, rel), 'utf8');

// Comments are stripped first so a comment *naming* a symbol can't stand in
// for the call that should be there.
function code(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

const triggers = code(read('TriggersPanel.jsx'));

test('TriggerForm imports the pure picker module and the shared grant resolver', () => {
  assert.match(triggers, /import \{ pluginEventOptions, defaultPluginId \} from '\.\/plugin-event-options\.js'/);
  assert.match(triggers, /import \{ effectiveGrantFor \} from '\.\.\/plugin-grant-view\.js'/);
});

test('the option list is derived by the pure module from the fetched registry + grant', () => {
  assert.match(triggers, /pluginEventOptions\(\{ \.\.\.pluginInputs, currentId: form\.pluginId, draft: isDraftMode \}\)/);
  assert.match(triggers, /apiCall\('GET', '\/api\/plugins'\)/);
  assert.match(triggers, /effectiveGrantFor\(agent, parentTeam\)/);
});

test('pluginId is a <select> bound to the form, not a free-text FormInput', () => {
  // The select: value + onChange on the same control.
  assert.match(triggers, /<select\s+value=\{form\.pluginId\}\s+onChange=\{e => set\('pluginId', e\.target\.value\)\}/);
  // The old field must be gone — a `label="Plugin id"` FormInput was the free-text door.
  assert.doesNotMatch(triggers, /label="Plugin id"/);
  // And the options must render the module's `disabled` flag, or an ungranted
  // plugin would be selectable again.
  assert.match(triggers, /disabled=\{o\.disabled\}/);
});

test('the single-choice auto-pick is wired', () => {
  assert.match(triggers, /defaultPluginId\(pluginPick\.options\)/);
});

test('eventFilter stays free text (the manifest declares no event names)', () => {
  assert.match(triggers, /label="Event filter \(optional\)"/);
});
```

- [ ] **Step 2: Run it against the Task 2 state — it must pass**

Run: `cd admin-console && node --test src/pages/agent-chat/plugin-event-select-wiring.test.js`
Expected: 5 PASS.

- [ ] **Step 3: Prove the guard bites (mutation check, not committed)**

```bash
cd admin-console
sed -i 's/disabled={o.disabled}/disabled={false}/' src/pages/agent-chat/TriggersPanel.jsx
node --test src/pages/agent-chat/plugin-event-select-wiring.test.js; echo "exit=$?"
git checkout -- src/pages/agent-chat/TriggersPanel.jsx
```

Expected: the middle command reports 1 failing test (`pluginId is a <select> …`) and `exit=1`; the checkout restores the file (`git status` clean apart from the new test).

- [ ] **Step 4: Commit**

```bash
git add admin-console/src/pages/agent-chat/plugin-event-select-wiring.test.js
git commit -m "test(jira-plugin): guard the plugin-event picker wiring in TriggerForm"
```

---

### Task 4: Operator guide

**Files:**
- Modify: `docs/jira-plugin.md:107-111` (the trigger field table in *"5. Give the agents a `plugin-event` trigger"*)

**Interfaces:** none.

- [ ] **Step 1: Update the table row and add the grant sentence**

Replace:

```markdown
| Field | |
|---|---|
| Plugin id | `jira` |
| Event filter | blank = any event from jira; or `status_changed` |
```

with:

```markdown
| Field | |
|---|---|
| Plugin | pick **Jira** from the list. Only installed plugins are offered; one that is not granted to this agent is shown greyed-out with the reason, because a listener on an ungranted plugin never fires (§*How it works*) |
| Event filter | blank = any event from jira; or `status_changed` |
```

- [ ] **Step 2: Check nothing else still documents the field as free text**

Run: `grep -rn "Plugin id" docs admin-console/src admin-console/api/helper-chat --include=*.md --include=*.jsx --include=*.js | grep -v "\.test\.js"`
Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add docs/jira-plugin.md
git commit -m "docs(jira-plugin): the plugin-event trigger picks its plugin from a list"
```

---

### Task 5: Verify and land on the feature branch

**Files:** none new.

- [ ] **Step 1: Full console suite + build, once more, from a clean tree**

Run: `cd admin-console && git status --short && node --test "src/**/*.test.js" 2>&1 | tail -8 && npm run build 2>&1 | tail -3`
Expected: `git status` prints nothing; `fail 0`; build succeeds.

- [ ] **Step 2: Fast-forward the feature branch and push**

```bash
cd /workspace/workspace/314092_agent-execution-environment
git merge --ff-only feat/jira-plugin-event-select
git log --oneline -5
git push origin feat/jira-events-plugin
```

Expected: `git log` shows the four commits from Tasks 1–4 on top of `3d6975d0b fixes + ui changes`. If `--ff-only` refuses, `git rebase feat/jira-events-plugin` inside the worktree first, re-run Step 1, then retry.

- [ ] **Step 3: Remove the worktree**

```bash
git worktree remove .claude/worktrees/plugin-event-select
git branch -d feat/jira-plugin-event-select
```

---

## Self-review

- **Coverage of the design decisions:** D1 (select, not text) → Tasks 2+3; D2 (granted-first, disabled with reason) → Task 1 tests 2, Task 2 renders `disabled`; D3 (retain unknown value) → Task 1 tests 7–9; D4 (draft mode) → Task 1 test 5 + `draft: isDraftMode` in Task 2; D5 (unknown grant on read failure) → Task 1 test 4 + the `catch { grant = null }` in Task 2; D6 (auto-pick) → Task 1 test 12 + the effect in Task 2. Out-of-scope decisions (no `eventFilter` picker, no server change) → Task 3 test 5 and the untouched line 830.
- **Names used consistently:** `pluginEventOptions`, `defaultPluginId`, `pluginInputs`, `pluginPick`, `effectiveGrantFor`, `NOT_GRANTED_SUFFIX`, `NOT_INSTALLED_SUFFIX` — identical in Tasks 1, 2 and 3.
- **Known limitation, stated on purpose:** the `TriggerRow` summary (`TriggersPanel.jsx:328`) still prints the raw `pluginId` (`jira · status_changed`) rather than the manifest name. Resolving the name there would mean fetching the registry for the list view; left as-is (YAGNI — the id is short and is what the orchestrator matches on).
