// Pure view helpers for the "Parallelism" panel (#2272, Amendment 2 A2.2/A2.3
// of `docs/parallel-workers-concept.md`) — the team-axis config surface for
// agent pools: `wipLimit`, `autoDispatch.enabled` and the contention-strategy
// selector. Dependency-free so it unit-tests under `node --test` (#651); the
// JSX panel is uncovered and only wires these into inputs/PUT bodies.
//
// Mirrors, on the client, the exact prerequisite checks
// `PUT /api/agents/:teamId` runs server-side (`admin-console/api/api.js`) —
// so the panel can explain a refusal inline instead of the user hitting a raw
// 400 (#2272 AC5).

// The three contention strategies named in the design doc's mockup (A2.3),
// in the mockup's own order. Only `epic-serial` is a real, selectable value
// today:
//
//  - `none` ("Full parallelism") is named in the design's forward-looking
//    enum (§9, Amendment 1 A1.4) but was never implemented: epic-serialization
//    in `orchestrator/flow-supervisor.js`'s `selectAutoDispatch` runs
//    UNCONDITIONALLY (A1.4 — "epic-serial is not actually optional"),
//    regardless of `contentionPolicy`. There is no backend value that turns
//    it off, so a live "Full parallelism" radio would either be refused by
//    the bundle validator's closed enum, or — worse — silently dropped by
//    the live route's `normalizeAutoDispatch` with no error at all, which is
//    exactly the "half-applies with no error" failure this codebase's own
//    validators exist to avoid. Rendered disabled with that explanation
//    rather than wired to write a value nothing honours.
//  - `epic-serial` — today's default and the only rule actually enforced;
//    unset is byte-identical (Amendment 4 A4.1).
//  - `predicted-paths` (Phase 4, #2249) IS implemented backend-side, but
//    issue #2272 asks for it to still render disabled/"coming" in this first
//    cut of the picker, deferred alongside the live lane visualization
//    (Phase 5) rather than exposed the moment this panel ships.
export const CONTENTION_OPTIONS = Object.freeze([
  Object.freeze({
    value: 'none',
    label: 'Full parallelism',
    blurb: 'Items are independent; run up to the count limit.',
    disabled: true,
    disabledReason: 'Not implemented yet — "Serialize same epic" below is always enforced, regardless of this setting.',
  }),
  Object.freeze({
    value: 'epic-serial',
    label: 'Serialize same epic',
    blurb: "Never two in-flight tickets sharing an epic. Today's default, and the only rule actually enforced.",
    disabled: false,
    disabledReason: null,
  }),
  Object.freeze({
    value: 'predicted-paths',
    label: 'Smart: LLM predicts conflicts',
    blurb: 'An LLM guesses which files a ticket will touch and holds one back if its guess overlaps another in-flight ticket.',
    disabled: true,
    disabledReason: 'Coming to this panel in a later pass.',
  }),
]);

const KNOWN_CONTENTION_VALUES = CONTENTION_OPTIONS.map((o) => o.value);

// The persisted `autoDispatch.contentionPolicy` value, defaulted the same way
// the backend treats it: unset/unknown reads as `epic-serial` (Amendment 4
// A4.1 — byte-identical to it).
export function contentionPolicyValue(autoDispatch) {
  const p = autoDispatch && typeof autoDispatch === 'object' ? autoDispatch.contentionPolicy : undefined;
  return KNOWN_CONTENTION_VALUES.includes(p) ? p : 'epic-serial';
}

export function contentionOptionLabel(value) {
  const opt = CONTENTION_OPTIONS.find((o) => o.value === value);
  return opt ? opt.label : String(value);
}

// Whether the backend would accept `autoDispatch.enabled: true` right now —
// mirrors the two checks `PUT /api/agents/:teamId` runs (api.js): a positive
// `wipLimit` must be set, and at least one team member must carry
// `pool.enabled: true`. Returns a plain-language reason instead of a status
// code so the panel can disable the toggle with an inline explanation.
export function autoDispatchPrerequisite({ wipLimit, hasPooledRole }) {
  if (!(Number.isInteger(wipLimit) && wipLimit >= 1)) {
    return { ok: false, reason: 'Set "Up to N tickets at once" first — auto-dispatch piggybacks on the flow\'s own ticket limit.' };
  }
  if (!hasPooledRole) {
    return { ok: false, reason: 'Add at least one pooled role (a team member with pooling enabled) — auto-dispatch only times pooled roles.' };
  }
  return { ok: true, reason: null };
}

// Parse the wipLimit text input the same way `normalizeWipLimit`
// (process-template.js) would accept it server-side: a positive integer, or
// blank for "no limit". Anything else is a client-side error so the user sees
// it before the round-trip rather than after a 400.
export function parseWipLimitInput(raw) {
  if (raw === '' || raw === null || raw === undefined) return { value: null, error: null };
  const trimmed = String(raw).trim();
  if (trimmed === '') return { value: null, error: null };
  const n = Number(trimmed);
  if (!Number.isInteger(n) || n < 1) {
    return { value: null, error: 'Must be a positive whole number, or blank for no limit.' };
  }
  return { value: n, error: null };
}

// The role-axis half of the auto-dispatch prerequisite, derived from the
// already-fetched `/api/agents` list (no separate fetch — every field this
// needs, `parentTeamId` and `pool`, already rides on that response's spread
// config, see GET /api/agents in api.js).
export function hasPooledMember(agents, teamId) {
  return (Array.isArray(agents) ? agents : []).some(
    (a) => a && a.parentTeamId === teamId && a.pool && typeof a.pool === 'object' && a.pool.enabled === true,
  );
}

// Compact read-only summary (team view — AgentEditForm's General tab, #2272
// AC3). Two short lines; the second is dropped when auto-dispatch is off
// (the contention strategy has no live effect until the supervisor is
// actually timing dispatches), so an unconfigured team reads as one plain
// "no limit" line rather than three rows most of which say nothing yet.
export function parallelismSummary({ wipLimit, autoDispatch }) {
  const limit = Number.isInteger(wipLimit) && wipLimit >= 1 ? wipLimit : null;
  const enabled = !!(autoDispatch && typeof autoDispatch === 'object' && autoDispatch.enabled === true);
  const lines = [
    limit ? `Up to ${limit} ticket${limit === 1 ? '' : 's'} at once` : 'No ticket limit set — dispatch is unbounded',
  ];
  lines.push(enabled
    ? `Auto-dispatch: on · ${contentionOptionLabel(contentionPolicyValue(autoDispatch))}`
    : 'Auto-dispatch: off');
  return lines;
}
