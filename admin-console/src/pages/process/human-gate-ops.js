// human-gate-ops.js — the submit path for the human → agent gate drag (#1000,
// Phase 0 of the flow-wiring UX unification, concept §1 D1–D3).
//
// The #987 creation path (`HumanGateForm`) was the last place still writing a
// multi-event trigger and the only gate path that skipped the claim stamp. The
// payload is built here, in a pure module both dialog modes share, so the
// conventions (exactly one event, derived claim) live in one place and are
// unit-testable against both ops adapters.

// Client-side counterpart of `deriveClaim`/`claimLabelFor` in
// admin-console/api/process-template.js — the single claim convention: a label
// listener claims its wake label by swapping `<label>` for `<label>:wip`. The
// bundle validator enforces `claim.add === '<labelFilter>:wip'`, so the two
// sides must stay in sync.
export const CLAIM_SUFFIX = ':wip';

export function claimLabelFor(wake) {
  return `${wake}${CLAIM_SUFFIX}`;
}

// Not claimable: a blank label (nothing to take over) or a label that already
// is a claim label (claiming it would derive `x:wip:wip`).
export function deriveClaim(labelFilter) {
  const wake = typeof labelFilter === 'string' ? labelFilter.trim() : '';
  if (!wake) return null;
  if (wake.endsWith(CLAIM_SUFFIX)) return null;
  return { remove: wake, add: claimLabelFor(wake) };
}

// Default artifact kind for the gate's event: what the person already reviews.
// A human bound to a PR delivery gates that PR (`pull_request.labeled`); an
// issue reviewer gates the issue. First artifact consume wins; label-only and
// file consumes carry no GitHub artifact kind. No consume → issues.
export function defaultGateKind(human) {
  const consumes = human && Array.isArray(human.consumes) ? human.consumes : [];
  for (const c of consumes) {
    if (!c) continue;
    if (c.artifact === 'pr') return 'pull_request';
    if (c.artifact === 'issue') return 'issues';
  }
  return 'issues';
}

// The gate listener payload: exactly ONE event (the single-event migration of
// 2026-07-05 — no creation path may write `events` with two entries) and the
// derived claim, consistent with the channel gate path (`expandGithubChannels`
// auto-stamps gated channels too).
export function buildGateListener({ label, kind }) {
  const l = String(label || '').trim();
  const claim = deriveClaim(l);
  return {
    type: 'github-event',
    events: [`${kind === 'pull_request' ? 'pull_request' : 'issues'}.labeled`],
    labelFilter: l,
    enabled: true,
    ...(claim ? { claim } : {}),
    prompt: `A human applied \`${l}\` — proceed.`,
  };
}

// The submit sequence moved into the wiring engine (`wireHumanGate` in
// wiring-engine.js, #1002) — this module keeps only the pure payload builders
// the engine composes, so the multi-write hand-off has exactly one home.
