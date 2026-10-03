// The hand-off readiness gate in the Flow editor's dialogs (#2795): "Wait for
// CI" and "Block on merge conflict" on a PR hand-off, with the failure label and
// the timeout. Pure (React-free) so it can be unit-tested with `node --test`.
//
// Client mirror of the server rules in admin-console/api/process-template.js
// (`readinessError` / `cleanReadiness`) — src cannot import the CJS api module,
// so readiness-gate.test.js pins the two together.

import { labelNameError } from './handoff-validation.js';

export const DEFAULT_FAILURE_LABEL = 'revisions-required';
export const DEFAULT_TIMEOUT_MINUTES = 60;
export const MAX_TIMEOUT_MINUTES = 7 * 24 * 60;
export const TIMEOUT_LABEL = 'needs-human';

// What a hand-off wired in one click (no dialog) stores: both gates on, the
// default label and timeout (AC11). wireLabelHandoff only applies it to a
// `pull_request.labeled` listener.
export const NEW_HANDOFF_READINESS = Object.freeze({ ci: true, conflict: true });

// The gate a NEW hand-off on `wakeLabel` starts with: NEW_HANDOFF_READINESS,
// except on the default failure label itself — failing back onto the wake label
// would re-wake the held listener in a loop, so that hand-off starts ungated.
export function newHandoffReadiness(wakeLabel) {
  return String(wakeLabel || '').trim() === DEFAULT_FAILURE_LABEL ? null : { ...NEW_HANDOFF_READINESS };
}

// The PR hand-off events a gate can hold (mirrors READINESS_EVENTS).
export const READINESS_EVENTS = ['pull_request.labeled', 'pull_request.opened', 'pull_request.reopened'];

// Whether a hand-off can carry the gate: PR hand-offs only.
export function gateable({ artifact, event } = {}) {
  if (artifact !== undefined) return artifact === 'pr';
  return READINESS_EVENTS.includes(event);
}

// The dialog's form state for a stored gate. A NEW PR hand-off starts with both
// gates on (AC11) — unless its `wakeLabel` is the default failure label (see
// newHandoffReadiness); an existing one shows exactly what is stored — absent =
// off, so opening and saving an old hand-off never turns a gate on (AC12).
export function readinessForm(stored, { isNew = false, wakeLabel = '' } = {}) {
  const r = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : null;
  if (!r) {
    const on = isNew && !!newHandoffReadiness(wakeLabel);
    return {
      ci: on, conflict: on,
      failureLabel: DEFAULT_FAILURE_LABEL, timeoutMinutes: String(DEFAULT_TIMEOUT_MINUTES),
    };
  }
  return {
    ci: r.ci === true,
    conflict: r.conflict === true,
    failureLabel: typeof r.failureLabel === 'string' && r.failureLabel.trim() ? r.failureLabel.trim() : DEFAULT_FAILURE_LABEL,
    timeoutMinutes: Number.isInteger(r.timeoutMinutes) ? String(r.timeoutMinutes) : String(DEFAULT_TIMEOUT_MINUTES),
  };
}

function parseTimeout(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return DEFAULT_TIMEOUT_MINUTES;
  return /^\d+$/.test(s) ? Number(s) : NaN;
}

// Why the gate fields can't be saved, or null. Only checked while a gate is on —
// switched off, the label and timeout are not used.
export function readinessFormError(form, { wakeLabel = '' } = {}) {
  if (!form || (!form.ci && !form.conflict)) return null;
  const fl = typeof form.failureLabel === 'string' ? form.failureLabel.trim() : '';
  if (fl) {
    const le = labelNameError(fl);
    if (le) return `Failure label: ${le}`;
  }
  // The EFFECTIVE label: left empty, the default is what the gate sets.
  const effective = fl || DEFAULT_FAILURE_LABEL;
  if (wakeLabel && effective === String(wakeLabel).trim()) {
    return `The failure label must differ from the hand-off label "${effective}" — it would wake the same agent again. Pick another failure label or switch the gate off.`;
  }
  const t = parseTimeout(form.timeoutMinutes);
  if (!Number.isInteger(t) || t < 1 || t > MAX_TIMEOUT_MINUTES) {
    return `The timeout is a whole number of minutes from 1 to ${MAX_TIMEOUT_MINUTES}.`;
  }
  return null;
}

// The value to store (`readiness` on a channel port, `readinessGate` on a
// trigger), or null when no gate is on. Defaults are not written.
export function readinessFromForm(form) {
  if (!form || (!form.ci && !form.conflict)) return null;
  const fl = typeof form.failureLabel === 'string' ? form.failureLabel.trim() : '';
  const t = parseTimeout(form.timeoutMinutes);
  return {
    ci: !!form.ci,
    conflict: !!form.conflict,
    ...(fl && fl !== DEFAULT_FAILURE_LABEL ? { failureLabel: fl } : {}),
    ...(Number.isInteger(t) && t !== DEFAULT_TIMEOUT_MINUTES ? { timeoutMinutes: t } : {}),
  };
}

// One-line readout for an edge / dialog: "Waits for CI and a conflict-free PR
// (60 min, then needs-human); on failure → revisions-required". '' = no gate.
export function readinessSummary(stored) {
  const f = readinessForm(stored);
  if (!stored || (!f.ci && !f.conflict)) return '';
  const what = [f.ci ? 'CI' : null, f.conflict ? 'a conflict-free PR' : null].filter(Boolean).join(' and ');
  return `Waits for ${what} (${f.timeoutMinutes} min, then ${TIMEOUT_LABEL}); on failure → ${f.failureLabel}`;
}
