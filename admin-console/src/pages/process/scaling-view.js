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
export function buildPoolPayload({ enabled, maxInstances, workspace, idleTimeoutMs, maxRuntimeMs, retainLogsMs, workSource, baseBranch }) {
  if (!enabled) return null;
  const teardown = {};
  if (Number.isFinite(idleTimeoutMs) && idleTimeoutMs > 0) teardown.idleTimeoutMs = idleTimeoutMs;
  if (Number.isFinite(maxRuntimeMs) && maxRuntimeMs > 0) teardown.maxRuntimeMs = maxRuntimeMs;
  if (Number.isFinite(retainLogsMs) && retainLogsMs > 0) teardown.retainLogsMs = retainLogsMs;
  return {
    enabled: true,
    ...(Number.isInteger(maxInstances) && maxInstances >= 1 ? { maxInstances } : {}),
    workspace: workspaceValue({ workspace }),
    // `baseBranch` has no UI (out of scope for #2813) but must survive a
    // Scaling save untouched; `workSource` only means something off
    // git-clean-base (`poolConfigError` refuses the combination).
    ...(typeof baseBranch === 'string' && baseBranch.trim() ? { baseBranch: baseBranch.trim() } : {}),
    ...(workSource && workspaceValue({ workspace }) !== 'git-clean-base' ? { workSource } : {}),
    ...(Object.keys(teardown).length ? { teardown } : {}),
  };
}

// The recurring-analysis work source (#2248) from the section's three text
// inputs (#2813 AC15): items one per line, the output directory (the
// completion signal) and an optional input directory. All blank → no work
// source (`value: null`). Mirrors `poolConfigError`'s shape rules so the
// section explains a refusal inline instead of a raw 400.
export function parseWorkSourceInput({ itemsText, outputDir, inputDir } = {}) {
  const items = String(itemsText || '').split('\n').map((v) => v.trim()).filter(Boolean);
  const out = String(outputDir || '').trim();
  const inp = String(inputDir || '').trim();
  if (!items.length && !out && !inp) return { value: null, error: null };
  if (!items.length) return { value: null, error: 'Work items: list at least one item (one per line).' };
  if (!out) return { value: null, error: 'Output directory is required — an item is done once its output appears there.' };
  return { value: { items, outputDir: out, ...(inp ? { inputDir: inp } : {}) }, error: null };
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
    // Work source (#2248), editable since #2813 for input-copy / none.
    itemsText: Array.isArray(pool?.workSource?.items) ? pool.workSource.items.join('\n') : '',
    outputDirText: typeof pool?.workSource?.outputDir === 'string' ? pool.workSource.outputDir : '',
    inputDirText: typeof pool?.workSource?.inputDir === 'string' ? pool.workSource.inputDir : '',
    // Not editable here — carried so a Scaling save never drops it.
    baseBranch: typeof pool?.baseBranch === 'string' ? pool.baseBranch : '',
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
  const workspace = workspaceValue({ workspace: draft.workspace });
  const workSource = workspace === 'git-clean-base'
    ? { value: null, error: null }
    : parseWorkSourceInput({ itemsText: draft.itemsText, outputDir: draft.outputDirText, inputDir: draft.inputDirText });
  const parseError = maxInstances.error || idle.error || hard.error || retain.error || workSource.error;
  if (parseError) return { payload: undefined, error: parseError };
  if (draft.enabled) {
    const prereq = scalingPrerequisite({ parentWipLimit });
    if (!prereq.ok) return { payload: undefined, error: prereq.reason };
  }
  // #2813 AC15 reverses #2294: the Workspace select is back, together with
  // the `pool.workSource` fields `input-copy`/`none` need, so the chosen
  // binding is threaded through (git-clean-base never carries a work source).
  return {
    payload: buildPoolPayload({
      enabled: draft.enabled,
      maxInstances: maxInstances.value,
      workspace,
      workSource: workSource.value,
      baseBranch: draft.baseBranch,
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
  // A draft built before a key existed (e.g. the #2813 work-source fields)
  // reads that key as blank rather than as an edit.
  return Object.keys(initial).some((k) => (initial[k] ?? '') !== (draft[k] ?? ''));
}

/** Whether the work-source fields apply to the chosen workspace binding. */
export function workSourceApplies(draft) {
  return workspaceValue({ workspace: draft && draft.workspace }) !== 'git-clean-base';
}
