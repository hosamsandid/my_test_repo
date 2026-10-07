'use strict';

// ─── Flow Copilot × hand-off readiness gate (#2915) ──────────────────────────
//
// The readiness gate (#2795) is authored on a PR channel port as `readiness`
// or on a hand-authored PR label listener as `readinessGate`. The format doc
// already tells the model the shape; this module adds the deterministic parts
// the model must not be trusted with:
//
//   describeHandoffGates(bundle)        the "which hand-off waits for what"
//                                        section of the system prompt (AC1)
//   readinessRefusal(base, candidate)   a changed gate the API would refuse, or
//                                        one on an issue hand-off → the reason
//                                        the turn is refused with (AC3/AC4)
//   normalizeHandoffGates(bundle)       canonical gate values, so an applied
//                                        proposal stores exactly what the edge
//                                        dialog stores (AC2)
//   conflictSolverHint(base, candidate) suggest the conflict solver's wake label
//                                        as failure label (AC5, aligns #2879)
//
// Pure; validation is delegated to process-template.js so the Copilot refuses
// with the API's own reason, never a paraphrase of it.

const {
  readinessError,
  cleanReadiness,
  READINESS_EVENTS,
  READINESS_DEFAULT_FAILURE_LABEL,
  READINESS_DEFAULT_TIMEOUT_MINUTES,
} = require('./process-template');

const arr = (v) => (Array.isArray(v) ? v : []);
const str = (v) => (typeof v === 'string' ? v.trim() : '');
const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);

function stableStringify(x) {
  if (Array.isArray(x)) return `[${x.map(stableStringify).join(',')}]`;
  if (isObj(x)) {
    return `{${Object.keys(x).sort().filter(k => x[k] !== undefined)
      .map(k => `${JSON.stringify(k)}:${stableStringify(x[k])}`).join(',')}}`;
  }
  return JSON.stringify(x === undefined ? null : x);
}

// Who sets a label: roles whose outcomes `setLabel` it (or legacy `emits`), and
// named humans who emit it. Used to name a label listener's producer.
function labelProducers(bundle, label) {
  const out = [];
  for (const r of arr(bundle && bundle.roles)) {
    if (!isObj(r) || !r.id) continue;
    const viaOutcome = arr(isObj(r.outcomes) && r.outcomes.options)
      .some(o => arr(o && o.actions).some(a => a && a.type === 'setLabel' && a.label === label));
    if (viaOutcome || arr(r.emits).includes(label)) out.push(r.id);
  }
  for (const h of arr(bundle && bundle.humans)) {
    if (isObj(h) && h.id && arr(h.emits).includes(label)) out.push(h.id);
  }
  return out;
}

/**
 * Every hand-off of the bundle that the gate question applies to: PR / issue
 * channels, and hand-authored label listeners on a PR or issue event.
 * `get`/`set` read and write the gate value in place on the given bundle.
 */
function listHandoffs(bundle) {
  const out = [];
  for (const r of arr(bundle && bundle.roles)) {
    if (!isObj(r) || !r.id) continue;
    arr(r.channels).forEach((c) => {
      if (!isObj(c) || (c.artifact !== 'pr' && c.artifact !== 'issue')) return;
      out.push({
        key: `channel:${r.id}:${c.artifact}:${str(c.from)}:${str(c.label)}`,
        kind: 'channel', consumer: r.id, from: [str(c.from)].filter(Boolean),
        artifact: c.artifact, label: str(c.label), gateable: c.artifact === 'pr',
        field: 'readiness', holder: c,
      });
    });
    arr(r.triggers).forEach((t) => {
      if (!isObj(t) || t.type !== 'github-event' || t.channel || t.dataFlow) return;
      const event = arr(t.events)[0];
      const pr = READINESS_EVENTS.includes(event);
      if (!pr && !/^issues\.(labeled|opened|reopened)$/.test(event || '')) return;
      const label = str(t.labelFilter);
      out.push({
        key: `trigger:${r.id}:${str(t.id)}`,
        kind: 'trigger', consumer: r.id, triggerId: str(t.id),
        from: label ? labelProducers(bundle, label) : [],
        artifact: pr ? 'pr' : 'issue', label, gateable: pr,
        field: 'readinessGate', holder: t,
      });
    });
  }
  return out;
}

function handoffName(h) {
  const from = h.from.length ? h.from.join(' / ') : '?';
  const via = h.kind === 'channel' ? `${h.artifact === 'pr' ? 'PR' : 'issue'} channel` : `trigger \`${h.triggerId}\``;
  return `${from} → ${h.consumer} (${via}${h.label ? `, label \`${h.label}\`` : ''})`;
}

/**
 * The conflict-solver role (#2879): one that listens for
 * `pull_request.merge_conflict`, else one whose id / name / role says
 * "conflict". Its wake label is the label it is woken on. null when the team
 * has none, or when it has no label to be woken on.
 */
function findConflictSolver(bundle) {
  const roles = arr(bundle && bundle.roles).filter(r => isObj(r) && r.id);
  const byEvent = roles.find(r => arr(r.triggers).some(t => isObj(t) && arr(t.events).includes('pull_request.merge_conflict')));
  const byName = roles.find(r => /conflict/i.test([r.id, r.displayName, r.role].map(str).join(' ')));
  const role = byEvent || byName;
  if (!role) return null;
  const listener = arr(role.triggers).find(t => isObj(t) && t.type === 'github-event' && str(t.labelFilter));
  const channel = arr(role.channels).find(c => isObj(c) && c.artifact === 'pr' && str(c.label));
  const wakeLabel = listener ? str(listener.labelFilter) : (channel ? str(channel.label) : '');
  return wakeLabel ? { id: role.id, wakeLabel } : null;
}

function gateLine(h) {
  if (!h.gateable) return `- ${handoffName(h)}: issue hand-off — cannot be gated (only PR hand-offs can)`;
  const raw = h.holder[h.field];
  const g = readinessError(raw, { wakeLabel: h.label }) ? null : cleanReadiness(raw);
  if (!g) return `- ${handoffName(h)}: not gated — wakes immediately`;
  return `- ${handoffName(h)}: waits for CI: ${g.ci ? 'yes' : 'no'}; blocks on merge conflict: ${g.conflict ? 'yes' : 'no'}; `
    + `failure label \`${g.failureLabel || READINESS_DEFAULT_FAILURE_LABEL}\`; `
    + `timeout ${g.timeoutMinutes || READINESS_DEFAULT_TIMEOUT_MINUTES} min`;
}

/**
 * The system-prompt section listing every hand-off's gate state, or '' when
 * the bundle has no PR / issue hand-off. Computed, not left to the model to
 * read off the JSON: a channel's gate and a listener's gate live in different
 * places, and an answer to "does the review wait for CI?" must be exact.
 */
function describeHandoffGates(bundle) {
  const handoffs = listHandoffs(bundle);
  if (!handoffs.length) return '';
  const solver = findConflictSolver(bundle);
  return [
    '## Hand-off readiness gates',
    '',
    'Computed from the current bundle — answer questions about which hand-off waits for CI or',
    'a conflict-free PR from this list.',
    '',
    ...handoffs.map(gateLine),
    ...(solver ? ['', `Conflict-solver role: \`${solver.id}\`, woken by label \`${solver.wakeLabel}\`.`] : []),
  ].join('\n');
}

const gateKeyMap = (bundle) => new Map(listHandoffs(bundle).map(h => [h.key, h]));
const changedGates = (base, candidate) => {
  const before = gateKeyMap(base);
  return listHandoffs(candidate).filter((h) => {
    const prev = before.get(h.key);
    return stableStringify(h.holder[h.field] ?? null) !== stableStringify(prev ? (prev.holder[prev.field] ?? null) : null);
  });
};

/**
 * Why the candidate's gate changes must be refused, or null. Only gates the
 * candidate CHANGES are checked — a pre-existing bad value is not this turn's
 * doing. The reason is the API's own (`readinessError`), prefixed with the
 * hand-off it concerns.
 */
function readinessRefusal(base, candidate) {
  for (const h of changedGates(base, candidate)) {
    const raw = h.holder[h.field];
    if (raw === undefined || raw === null) continue;
    const err = readinessError(raw, { wakeLabel: h.label });
    if (err) return `I can't apply that gate to ${handoffName(h)}: ${err}.`;
    if (!h.gateable && cleanReadiness(raw)) {
      return `Only PR hand-offs can wait for CI or a conflict-free merge — ${handoffName(h)} hands over an issue, which has no CI checks or merge state.`;
    }
  }
  return null;
}

/**
 * A copy of the bundle with every well-formed gate in its canonical form
 * (defaults not written, both toggles off = key removed) — the value the edge
 * dialog's `readinessFromForm` stores. Malformed gates are left for the
 * validator to report.
 */
function normalizeHandoffGates(bundle) {
  if (!isObj(bundle)) return bundle;
  const copy = JSON.parse(JSON.stringify(bundle));
  for (const h of listHandoffs(copy)) {
    if (!(h.field in h.holder)) continue;
    const raw = h.holder[h.field];
    if (raw !== null && readinessError(raw, { wakeLabel: h.label })) continue;
    const g = h.gateable ? cleanReadiness(raw) : null;
    if (g) h.holder[h.field] = g;
    else if (!h.gateable && cleanReadiness(raw)) continue; // the validator refuses it
    else delete h.holder[h.field];
  }
  return copy;
}

/**
 * When the candidate switches "Block on merge conflict" on for a hand-off whose
 * failure label is not the conflict solver's wake label, `{ text, wakeLabel }`
 * — one sentence suggesting it; otherwise null. Advisory only — the Copilot
 * never sets it unasked.
 */
function conflictSolverHint(base, candidate) {
  const solver = findConflictSolver(candidate);
  if (!solver) return null;
  const before = gateKeyMap(base);
  for (const h of changedGates(base, candidate)) {
    if (!h.gateable || h.consumer === solver.id || h.label === solver.wakeLabel) continue;
    const g = cleanReadiness(h.holder[h.field]);
    if (!g || !g.conflict) continue;
    const prev = before.get(h.key);
    const was = prev ? cleanReadiness(prev.holder[prev.field]) : null;
    if (was && was.conflict) continue;
    if ((g.failureLabel || READINESS_DEFAULT_FAILURE_LABEL) === solver.wakeLabel) continue;
    return {
      wakeLabel: solver.wakeLabel,
      text: `Tip: this team has a conflict solver (\`${solver.id}\`) — use its wake label \`${solver.wakeLabel}\` as the failure label of ${handoffName(h)}, so a conflicting PR goes straight to it.`,
    };
  }
  return null;
}

module.exports = {
  listHandoffs,
  findConflictSolver,
  describeHandoffGates,
  readinessRefusal,
  normalizeHandoffGates,
  conflictSolverHint,
};
