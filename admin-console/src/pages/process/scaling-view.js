// Pure view helpers for the "Scaling" section (#2271, Amendment 2 A2.2 of
// `docs/parallel-workers-concept.md`) — the role-axis config surface for
// agent pools: `pool.enabled`, `maxInstances`, workspace binding, teardown
// timeouts. Shared by the Flow editor's NodeInspector (live team-member node)
// and the agent's own Settings tab (AgentEditForm) via one
// `<ScalingSection>`, following #2272's "one model, several surfaces"
// precedent so the two hosts never drift. Dependency-free so it unit-tests
// under `node --test` (#651); the JSX is uncovered and only wires these into
// inputs/PUT bodies.
//
// Mirrors, on the client, the exact prerequisite `PUT /api/agents/:memberId`
// runs server-side (admin-console/api/api.js, #2270): a member carries no
// `wipLimit` of its own, so `pool.enabled` piggybacks on the PARENT TEAM's —
// the section can explain a refusal inline instead of a raw 400 (#2271 AC5).

// The three workspace bindings `process-template.js`'s `normalizePool`
// accepts (`POOL_WORKSPACES`), in the mockup's own order.
export const POOL_WORKSPACE_OPTIONS = Object.freeze([
  Object.freeze({ value: 'git-clean-base', label: 'Clean git checkout per instance' }),
  Object.freeze({ value: 'input-copy', label: 'Copy of input directory per instance' }),
  Object.freeze({ value: 'none', label: 'No workspace isolation' }),
]);

const KNOWN_WORKSPACES = POOL_WORKSPACE_OPTIONS.map((o) => o.value);

// The persisted `pool.workspace` value, defaulted the same way
// `normalizePool` treats it server-side: unset/unknown reads as
// `git-clean-base`.
export function workspaceValue(pool) {
  const w = pool && typeof pool === 'object' ? pool.workspace : undefined;
  return KNOWN_WORKSPACES.includes(w) ? w : 'git-clean-base';
}

// Whether the backend would accept `pool.enabled: true` for this member right
// now — mirrors the one check `PUT /api/agents/:memberId` runs (api.js): the
// PARENT TEAM's `wipLimit` must be set (it governs and reaps pooled
// instances) — a member itself carries no `wipLimit` (A2.4). Returns a
// plain-language reason instead of a status code so the section can disable
// the toggle with an inline explanation pointing at the team Parallelism
// panel (#2271 AC5).
export function scalingPrerequisite({ parentWipLimit }) {
  if (!(Number.isInteger(parentWipLimit) && parentWipLimit >= 1)) {
    return {
      ok: false,
      reason: 'The parent team has no ticket limit set — set "Up to N tickets at once" in the team\'s Parallelism panel first.',
    };
  }
  return { ok: true, reason: null };
}

// Parse the maxInstances text input the same way `normalizePool`
// (process-template.js) would accept it server-side: a positive integer, or
// blank for "no per-role cap" (the team's wipLimit governs instead).
export function parseMaxInstancesInput(raw) {
  if (raw === '' || raw === null || raw === undefined) return { value: null, error: null };
  const trimmed = String(raw).trim();
  if (trimmed === '') return { value: null, error: null };
  const n = Number(trimmed);
  if (!Number.isInteger(n) || n < 1) {
    return { value: null, error: 'Must be a positive whole number, or blank for no per-role cap.' };
  }
  return { value: n, error: null };
}

// Teardown timeouts are authored in whole minutes in the UI (the design
// doc's mockup shorthand "30m"/"2h") but persisted as milliseconds
// (`pool.teardown.*Ms`, `normalizePool`) — this pair is the one place either
// direction of that conversion happens.
export function parseMinutesInput(raw) {
  if (raw === '' || raw === null || raw === undefined) return { value: null, error: null };
  const trimmed = String(raw).trim();
  if (trimmed === '') return { value: null, error: null };
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n <= 0) {
    return { value: null, error: 'Must be a positive number of minutes, or blank for the default.' };
  }
  return { value: Math.round(n * 60000), error: null };
}

export function msToMinutesText(ms) {
  return Number.isFinite(ms) && ms > 0 ? String(Math.round(ms / 60000)) : '';
}

// The role-axis read-only badge (#2271 AC4, A2.2 — "a read-only 'pooled
// role · up to N' badge on the single-agent view so an operator looking at
// one agent sees its scaling at a glance"). `null` when the role isn't
// pooled, so callers render nothing rather than an empty badge.
export function poolBadgeText(pool) {
  if (!pool || typeof pool !== 'object' || pool.enabled !== true) return null;
  return Number.isInteger(pool.maxInstances) && pool.maxInstances >= 1
    ? `pooled role · up to ${pool.maxInstances}`
    : 'pooled role · up to team limit';
}

// The `pool` body for `PUT /api/agents/:memberId` from the section's form
// state — `null` when pooling is toggled off, clearing the field (A2.4:
// "clearing it (null) reverts the role to a persistent singleton"), never a
// half-formed object with `enabled: false` left dangling.
export function buildPoolPayload({ enabled, maxInstances, workspace, idleTimeoutMs, maxRuntimeMs, retainLogsMs }) {
  if (!enabled) return null;
  const teardown = {};
  if (Number.isFinite(idleTimeoutMs) && idleTimeoutMs > 0) teardown.idleTimeoutMs = idleTimeoutMs;
  if (Number.isFinite(maxRuntimeMs) && maxRuntimeMs > 0) teardown.maxRuntimeMs = maxRuntimeMs;
  if (Number.isFinite(retainLogsMs) && retainLogsMs > 0) teardown.retainLogsMs = retainLogsMs;
  return {
    enabled: true,
    ...(Number.isInteger(maxInstances) && maxInstances >= 1 ? { maxInstances } : {}),
    workspace: workspaceValue({ workspace }),
    ...(Object.keys(teardown).length ? { teardown } : {}),
  };
}

/* ── #2295: a controlled draft, so ScalingSection can be embedded without its
   own Save button — the host (NodeInspector's Details Save / AgentEditForm's
   Save) owns the moment the PUT actually happens, this module owns the
   decisions (initial values, validation, dirtiness). One component, two
   hosts, per #2272 — this is the half of that precedent that used to live
   inline in ScalingSection's own useState/save(). */

/** The section's editable draft, derived from the persisted `pool` field. */
export function scalingDraftFromPool(pool) {
  return {
    enabled: !!(pool && pool.enabled === true),
    maxInstancesText: pool && Number.isInteger(pool.maxInstances) ? String(pool.maxInstances) : '',
    workspace: workspaceValue(pool),
    idleText: msToMinutesText(pool?.teardown?.idleTimeoutMs),
    hardText: msToMinutesText(pool?.teardown?.maxRuntimeMs),
    retainText: msToMinutesText(pool?.teardown?.retainLogsMs),
  };
}

/**
 * Whether a Save may proceed, and with what `pool` body — the exact
 * validation `ScalingSection`'s own `save()` used to run, extracted so a host
 * can pre-flight it (block the WHOLE batched save with a stated reason
 * rather than half-applying, per #2295's edge case) instead of only being
 * able to disable its own button.
 *
 * @returns {{payload: (object|null|undefined), error: (string|null)}}
 *   `error` set → nothing should be written. Otherwise `payload` is the
 *   `pool` PUT body (`buildPoolPayload`'s shape, possibly `null` to clear it).
 */
export function scalingSaveDecision(draft, parentWipLimit) {
  const maxInstances = parseMaxInstancesInput(draft.maxInstancesText);
  const idle = parseMinutesInput(draft.idleText);
  const hard = parseMinutesInput(draft.hardText);
  const retain = parseMinutesInput(draft.retainText);
  const parseError = maxInstances.error || idle.error || hard.error || retain.error;
  if (parseError) return { payload: undefined, error: parseError };
  if (draft.enabled) {
    const prereq = scalingPrerequisite({ parentWipLimit });
    if (!prereq.ok) return { payload: undefined, error: prereq.reason };
  }
  // #2294: never thread a variable `workspace` into the save — the Workspace
  // dropdown is gone from both hosts (`input-copy`/`none` have no UI to
  // configure the `pool.workSource` they'd need), so a rehydrated
  // `draft.workspace` must not sneak back into a PUT. `buildPoolPayload`
  // defaults an omitted workspace to `git-clean-base` (`normalizePool` parity).
  return {
    payload: buildPoolPayload({
      enabled: draft.enabled,
      maxInstances: maxInstances.value,
      idleTimeoutMs: idle.value,
      maxRuntimeMs: hard.value,
      retainLogsMs: retain.value,
    }),
    error: null,
  };
}

/** Has the draft changed from what the persisted `pool` field would produce? */
export function scalingDraftDirty(draft, pool) {
  const initial = scalingDraftFromPool(pool);
  return Object.keys(initial).some((k) => initial[k] !== draft[k]);
}
