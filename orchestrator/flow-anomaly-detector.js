// Flow-anomaly detector (#959, concept `docs/flow-reconciliation-concept.md` §4.1/§4.3).
//
// A pure, fs-free module in the spirit of `admin-console/api/process-graph.js`:
// it derives, per team, the *expected* state machine of a label-driven flow from
// the same machine-readable ports the graph renders (`emits`, `labelFilter`,
// `channels`, `claim`, `github`), then compares that model against a snapshot of
// GitHub + run state to flag **anomalies with age**. No LLM, no I/O — the
// expensive sweep (GitHub + session logs) happens in the orchestrator endpoint
// that feeds this module; the classification itself is deterministic and
// golden-fixture testable.
//
// The four anomaly classes mirror the two production stalls of 2026-07-29
// (concept §1) plus the two failure modes Layer 2's claim labels make visible:
//   - `wake-not-claimed`  a wake label sits past T1 with no claim and no run —
//                         the run never started, or crashed before claiming
//                         (issue #902: `ready` consumed by a run that died).
//   - `claim-stalled`     a claim label (`<wake>:wip`) sits past T2 with no
//                         branch/PR/commit activity and no running session —
//                         a run claimed the work then silently died over hours.
//   - `output-missing`    a consumer verifiably ran (session log) but its
//                         declared outgoing label/PR never appeared and the
//                         object never advanced (PR #949: the Merger woke, hit a
//                         conflict, and dead-ended with no escalation edge).
//   - `gate-idle`         a human gate label sits past T3 — a nudge, never an
//                         auto-approval.
//
// Observe-only: this module never mutates anything. It returns a ranked list the
// Flows panel renders and (Phase 4) a responder agent may act on.

'use strict';

// The claim-label convention `<wake>:wip` (#958). A DOCUMENTED MIRROR of
// `admin-console/api/process-template.js` (`CLAIM_SUFFIX`/`claimLabelFor`) — the
// orchestrator cannot require an admin-console module, and the convention is
// enforced by that module's validator, so a stalled run can always be told apart
// from a missed wake by looking for exactly `<wake>:wip`. Keep the two in sync.
const CLAIM_SUFFIX = ':wip';
function claimLabelFor(wakeLabel) {
  return `${wakeLabel}${CLAIM_SUFFIX}`;
}

// The success mirror `<wake>:completed` (#1163): a claimed run that finishes
// swaps `<wake>:wip` for this terminal marker. It is NOT an active claim — a
// `:completed` ticket has done its work, so it must never register as a wake or
// claim label here, otherwise a finished-but-quiet run would be falsely flagged
// `claim-stalled` after T₂. A DOCUMENTED MIRROR of `CLAIM_COMPLETED_SUFFIX` in
// `agent-image/scripts/agent-entrypoint.py` and process-template.js.
const COMPLETED_SUFFIX = ':completed';

// Threshold defaults (concept §4.1). Overridable per team; the ratios matter
// more than the absolutes — a wake should claim within minutes, a claim should
// show branch/PR activity within hours, a human gate is measured in a day.
const DEFAULT_THRESHOLDS = Object.freeze({
  wakeNotClaimedMs: 15 * 60 * 1000, //   15 min — T1
  claimStalledMs: 2 * 60 * 60 * 1000, //  2 h   — T2
  gateIdleMs: 24 * 60 * 60 * 1000, //     24 h  — T3
});

// Severity per class — parallels the process-graph lint severities so the UI can
// reuse its dot colors. Gate-idle is advisory (a nudge); the rest are warnings.
const CLASS_SEVERITY = Object.freeze({
  'wake-not-claimed': 'warning',
  'claim-stalled': 'warning',
  'output-missing': 'warning',
  'gate-idle': 'info',
});

// Specificity ranking for the per-(object, agent) dedup pass: a completed run
// that produced nothing (`output-missing`) is a stronger statement than the same
// object merely sitting unclaimed, so it wins.
const CLASS_RANK = Object.freeze({
  'output-missing': 3,
  'claim-stalled': 2,
  'wake-not-claimed': 1,
  'gate-idle': 0,
});

// ---------------------------------------------------------------------------
// Model derivation — the "expected state machine" (concept §4.1).
// ---------------------------------------------------------------------------

function str(v) {
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * Derive the flow model for a team from its member ports. Pure — the same
 * declarative data `process-graph.js` reads, reduced to what the detector needs:
 * which label is a wake (and its claim label + consumers), which is a claim,
 * which is a human gate, and what each consumer is expected to produce.
 *
 * @param {Array} members  `[{ id, displayName?, emits?, github?, triggers? }]`
 *                         where each trigger may be a `github-event` with
 *                         `labelFilter` and optional `claim: {remove, add}`.
 * @param {{labels?: Array}} options  the team's `labels[]` registry
 *                         (`[{ name, humanGate?, brake? }]`) — gate-ness is a
 *                         config flag, never a name convention (#928).
 * @returns {{wakeEdges, claimEdges, gateLabels, consumers}} JSON-serializable.
 */
function buildFlowModel(members, options = {}) {
  const labels = Array.isArray(options.labels) ? options.labels : [];
  const gateLabels = new Set(
    labels.filter((l) => l && str(l.name) && l.humanGate).map((l) => str(l.name)),
  );

  // label -> { label, claimLabel, consumers:Set, triggerIds:Set }
  const wake = new Map();
  // claimLabel -> { claimLabel, wakeLabel, consumers:Set }
  const claim = new Map();
  // agentId -> consumer descriptor
  const consumers = new Map();

  const consumerOf = (m) => {
    let c = consumers.get(m.id);
    if (!c) {
      const gh = m.github && typeof m.github === 'object' ? m.github : {};
      // A declared open end (#1004, concept §4.7): an outcome marked
      // `terminal: true` or `external: {…}` makes a run that sets no forward
      // label and opens no PR legitimate — no output-missing expectation.
      const options = m.outcomes && Array.isArray(m.outcomes.options) ? m.outcomes.options : [];
      c = {
        id: m.id,
        displayName: str(m.displayName) || m.id,
        emits: new Set((Array.isArray(m.emits) ? m.emits : []).map(str).filter(Boolean)),
        producesPr: !!gh.producesPr,
        producesIssue: !!gh.producesIssue,
        openEnd: options.some((o) => o && (o.terminal === true || o.external)),
        consumesLabels: new Set(),
      };
      consumers.set(m.id, c);
    }
    return c;
  };

  for (const m of Array.isArray(members) ? members : []) {
    if (!m || !str(m.id)) continue;
    const triggers = Array.isArray(m.triggers) ? m.triggers : [];
    for (const t of triggers) {
      if (!t || t.type !== 'github-event') continue;
      if (t.enabled === false) continue;
      const label = str(t.labelFilter);
      if (!label) continue; // raw event listener — no wake label to reason about

      if (label.endsWith(COMPLETED_SUFFIX)) {
        // A `<wake>:completed` marker is a terminal done-state, never a wake or
        // claim to reason about (#1163) — a listener never waits on it, and
        // treating it as a wake would derive a bogus `<wake>:completed:wip`.
        continue;
      }

      if (label.endsWith(CLAIM_SUFFIX)) {
        // A listener that waits on a claim label itself — record the consumer so
        // claim-stalled can tell whether the claiming agent is running.
        const wakeLabel = label.slice(0, -CLAIM_SUFFIX.length);
        let ce = claim.get(label);
        if (!ce) ce = { claimLabel: label, wakeLabel, consumers: new Set() };
        ce.consumers.add(m.id);
        claim.set(label, ce);
        continue;
      }
      if (gateLabels.has(label)) continue; // a human gate is not an agent wake

      // A genuine wake-label listener. Its claim label comes from the enforced
      // `claim.add` when set, else the derived `<wake>:wip` convention.
      const claimAdd =
        t.claim && typeof t.claim === 'object' && str(t.claim.add)
          ? str(t.claim.add)
          : claimLabelFor(label);
      let we = wake.get(label);
      if (!we) we = { label, claimLabel: claimAdd, consumers: new Set(), triggerIds: new Set() };
      we.consumers.add(m.id);
      if (str(t.id)) we.triggerIds.add(str(t.id));
      wake.set(label, we);

      // The claim label this wake maps to also has these consumers (they take it
      // over on wake) — so claim-stalled knows who should be running.
      let ce = claim.get(claimAdd);
      if (!ce) ce = { claimLabel: claimAdd, wakeLabel: label, consumers: new Set() };
      ce.consumers.add(m.id);
      claim.set(claimAdd, ce);

      const c = consumerOf(m);
      c.consumesLabels.add(label);
    }
  }

  return {
    wakeEdges: [...wake.values()].map((w) => ({
      label: w.label,
      claimLabel: w.claimLabel,
      consumers: [...w.consumers],
      triggerIds: [...w.triggerIds],
    })),
    claimEdges: [...claim.values()].map((c) => ({
      claimLabel: c.claimLabel,
      wakeLabel: c.wakeLabel,
      consumers: [...c.consumers],
    })),
    gateLabels: [...gateLabels],
    consumers: Object.fromEntries(
      [...consumers.values()].map((c) => [
        c.id,
        {
          id: c.id,
          displayName: c.displayName,
          emits: [...c.emits],
          producesPr: c.producesPr,
          producesIssue: c.producesIssue,
          openEnd: !!c.openEnd,
          consumesLabels: [...c.consumesLabels],
        },
      ]),
    ),
  };
}

// ---------------------------------------------------------------------------
// Detection.
// ---------------------------------------------------------------------------

function toMs(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

// The best timestamp we have for when a label started "waiting": its own
// application time (from the timeline) if known, else the object's last update,
// else its creation. Never returns null for an object we swept.
function labelSince(labelEntry, object) {
  return (
    toMs(labelEntry && labelEntry.appliedAt) ??
    toMs(object.updatedAt) ??
    toMs(object.createdAt) ??
    null
  );
}

// Does the object show branch/PR/commit activity newer than `sinceMs`? Used to
// decide whether a claim is genuinely stalled or just slow.
function hasActivitySince(object, sinceMs) {
  if (Array.isArray(object.linkedPrNumbers) && object.linkedPrNumbers.length > 0) return true;
  const act = toMs(object.lastActivityAt);
  if (act != null && sinceMs != null && act > sinceMs) return true;
  return false;
}

// A completed run of `agentId` against this object (kind+number), if any. A run
// still `active` is not "completed"; a run that was rolled back on failure is
// not fed here (the wake was restored — that surfaces as wake-not-claimed).
function completedRunFor(sessions, agentId, object) {
  const s = sessions && sessions[agentId];
  if (!s || !Array.isArray(s.runs)) return null;
  for (const r of s.runs) {
    if (!r || r.active) continue;
    if (r.kind === object.kind && Number(r.number) === Number(object.number)) return r;
  }
  return null;
}

function isRunning(sessions, agentId) {
  const s = sessions && sessions[agentId];
  return !!(s && s.running);
}

function objectRef(object) {
  return {
    kind: object.kind,
    number: object.number,
    title: str(object.title) || null,
    url: str(object.url) || null,
    state: object.state || 'open',
  };
}

/**
 * Classify anomalies over a GitHub + run-state snapshot. Pure and deterministic:
 * given the same inputs (including `now`) it always returns the same list.
 *
 * @param {object} args
 * @param {object} args.model     from `buildFlowModel`.
 * @param {object} args.github    `{ objects: [{ kind:'issue'|'pr', number, url,
 *                                 title, state, merged?, createdAt, updatedAt,
 *                                 labels:[{name, appliedAt?}], linkedPrNumbers?,
 *                                 lastActivityAt? }] }`.
 * @param {object} args.sessions  `{ [agentId]: { running:bool, runs:[{ kind,
 *                                 number, ranAt, finishedAt?, active? }] } }`.
 * @param {object} [args.thresholds]  overrides `DEFAULT_THRESHOLDS`.
 * @param {number} args.now       epoch ms — injected so tests are deterministic.
 * @returns {{now, thresholds, anomalies: Array}}
 */
function detectFlowAnomalies(args = {}) {
  const model = args.model || { wakeEdges: [], claimEdges: [], gateLabels: [], consumers: {} };
  const github = args.github || { objects: [] };
  const sessions = args.sessions || {};
  const now = typeof args.now === 'number' ? args.now : toMs(args.now) || 0;
  const T = { ...DEFAULT_THRESHOLDS, ...(args.thresholds || {}) };

  const wakeByLabel = new Map((model.wakeEdges || []).map((w) => [w.label, w]));
  const claimByLabel = new Map((model.claimEdges || []).map((c) => [c.claimLabel, c]));
  const gateLabels = new Set(model.gateLabels || []);
  const consumers = model.consumers || {};

  const objects = Array.isArray(github.objects) ? github.objects : [];
  const anomalies = [];

  // Which (object, consumer) pairs have a completed run — so wake-not-claimed
  // (a wake that never started) is suppressed when a run demonstrably DID start
  // but produced nothing (that is output-missing instead).
  const ranPairs = new Set();
  for (const object of objects) {
    for (const agentId of Object.keys(consumers)) {
      if (completedRunFor(sessions, agentId, object)) {
        ranPairs.add(`${object.kind}:${object.number}:${agentId}`);
      }
    }
  }

  for (const object of objects) {
    if ((object.state || 'open') !== 'open') continue; // resolved — nothing to nudge
    const labelEntries = Array.isArray(object.labels) ? object.labels : [];
    const present = new Set(labelEntries.map((l) => str(l && l.name)).filter(Boolean));

    for (const le of labelEntries) {
      const name = str(le && le.name);
      if (!name) continue;
      const since = labelSince(le, object);
      const ageMs = since == null ? null : now - since;

      // --- wake-not-claimed --------------------------------------------------
      const we = wakeByLabel.get(name);
      if (we && ageMs != null && ageMs > T.wakeNotClaimedMs) {
        const claimPresent = present.has(we.claimLabel);
        const anyRan = we.consumers.some((id) => ranPairs.has(`${object.kind}:${object.number}:${id}`));
        // A linked PR from a PR-producing consumer means the wake WAS consumed
        // successfully even without a claim label — don't nudge healthy work.
        const workExists =
          Array.isArray(object.linkedPrNumbers) &&
          object.linkedPrNumbers.length > 0 &&
          we.consumers.some((id) => consumers[id] && consumers[id].producesPr);
        if (!claimPresent && !anyRan && !workExists) {
          // Every wake is poller-delivered (the internal transport was removed
          // in #2578), so a lost Events-API event is always a plausible cause.
          const cause = 'the wake may have been lost or the run crashed before claiming.';
          anomalies.push(mkAnomaly('wake-not-claimed', {
            object,
            label: name,
            since,
            ageMs,
            agentId: we.consumers[0] || null,
            consumers: we.consumers,
            message:
              `\`${name}\` has waited ${humanizeAge(ageMs)} with no \`${we.claimLabel}\` claim and no run — ${cause}`,
          }));
        }
      }

      // --- claim-stalled -----------------------------------------------------
      const ce = claimByLabel.get(name);
      if (ce && ageMs != null && ageMs > T.claimStalledMs) {
        const activity = hasActivitySince(object, since);
        const running = ce.consumers.some((id) => isRunning(sessions, id));
        if (!activity && !running) {
          anomalies.push(mkAnomaly('claim-stalled', {
            object,
            label: name,
            since,
            ageMs,
            agentId: ce.consumers[0] || null,
            consumers: ce.consumers,
            message:
              `\`${name}\` has been claimed for ${humanizeAge(ageMs)} with no branch/PR/commit activity ` +
              `and no running session — the run likely died silently.`,
          }));
        }
      }

      // --- gate-idle ---------------------------------------------------------
      if (gateLabels.has(name) && ageMs != null && ageMs > T.gateIdleMs) {
        anomalies.push(mkAnomaly('gate-idle', {
          object,
          label: name,
          since,
          ageMs,
          agentId: null,
          consumers: [],
          message: `human gate \`${name}\` has been pending ${humanizeAge(ageMs)} — a nudge, never an auto-approval.`,
        }));
      }
    }

    // --- output-missing (run-driven, not label-driven) ----------------------
    // A consumer that verifiably ran against this still-open object but neither
    // set one of its declared outgoing labels nor produced its declared PR, and
    // the object still carries a wake/claim label it consumes → the flow
    // dead-ended (#949) or the agent forgot the label.
    for (const agentId of Object.keys(consumers)) {
      const run = completedRunFor(sessions, agentId, object);
      if (!run) continue;
      const c = consumers[agentId];
      // Declared open end (#1004): this agent may legitimately end a run
      // without a forward signal — never an output-missing anomaly.
      if (c.openEnd) continue;
      const producedLabel = (c.emits || []).some((l) => present.has(l));
      const producedPr =
        c.producesPr && object.kind === 'issue' &&
        Array.isArray(object.linkedPrNumbers) && object.linkedPrNumbers.length > 0;
      // Still parked on a label this consumer woke on (the wake or its claim)?
      const stillWaiting = (c.consumesLabels || []).some(
        (l) => present.has(l) || present.has(claimLabelFor(l)),
      );
      // A PR the consumer was meant to resolve is still open (merger case #949):
      // no forward label, no new PR, the object itself is the thing that should
      // have changed state.
      if (!producedLabel && !producedPr && stillWaiting) {
        const since = toMs(run.finishedAt) ?? toMs(run.ranAt) ?? toMs(object.updatedAt);
        const ageMs = since == null ? null : now - since;
        anomalies.push(mkAnomaly('output-missing', {
          object,
          label: (c.consumesLabels || [])[0] || null,
          since,
          ageMs,
          agentId,
          consumers: [agentId],
          message:
            `\`${c.displayName}\` ran on ${object.kind} #${object.number} but no outgoing ` +
            `${c.emits && c.emits.length ? `label (\`${c.emits.join('`, `')}\`)` : (c.producesPr ? 'PR' : 'label/PR')} ` +
            `ever appeared — the chain dead-ended.`,
        }));
      }
    }
  }

  return { now, thresholds: T, anomalies: dedupe(anomalies) };
}

function mkAnomaly(cls, { object, label, since, ageMs, agentId, consumers, message }) {
  const evidence = [];
  if (object && str(object.url)) {
    evidence.push({ type: object.kind === 'pr' ? 'pr' : 'issue', text: `#${object.number}`, url: object.url });
  }
  return {
    class: cls,
    severity: CLASS_SEVERITY[cls] || 'info',
    label: label || null,
    object: object ? objectRef(object) : null,
    agentId: agentId || null,
    consumers: Array.isArray(consumers) ? consumers : [],
    since: since != null ? new Date(since).toISOString() : null,
    ageMs: ageMs != null ? ageMs : null,
    message,
    evidence,
  };
}

// Collapse duplicate findings for the same (object, agent, class), and suppress
// a weaker class when a stronger one already covers the same (object, agent) —
// e.g. a completed run makes output-missing beat wake-not-claimed.
function dedupe(anomalies) {
  const bestPerPair = new Map(); // object+agent -> best rank seen
  for (const a of anomalies) {
    const pairKey = `${a.object ? a.object.kind + ':' + a.object.number : '_'}:${a.agentId || '_'}`;
    const rank = CLASS_RANK[a.class] || 0;
    const prev = bestPerPair.get(pairKey);
    if (prev == null || rank > prev) bestPerPair.set(pairKey, rank);
  }
  const seen = new Set();
  const out = [];
  for (const a of anomalies) {
    const pairKey = `${a.object ? a.object.kind + ':' + a.object.number : '_'}:${a.agentId || '_'}`;
    // A gate-idle has no agent, so its pair is unique — never suppressed here.
    if (a.agentId && (CLASS_RANK[a.class] || 0) < bestPerPair.get(pairKey)) continue;
    const uniqKey = `${a.class}:${pairKey}:${a.label || ''}`;
    if (seen.has(uniqKey)) continue;
    seen.add(uniqKey);
    out.push(a);
  }
  // Stable, most-actionable first: by class rank desc, then by age desc.
  out.sort((x, y) => {
    const r = (CLASS_RANK[y.class] || 0) - (CLASS_RANK[x.class] || 0);
    if (r !== 0) return r;
    return (y.ageMs || 0) - (x.ageMs || 0);
  });
  return out;
}

function humanizeAge(ms) {
  if (ms == null) return 'an unknown time';
  const min = Math.floor(ms / 60000);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} h`;
  return `${Math.floor(h / 24)} d`;
}

module.exports = {
  buildFlowModel,
  detectFlowAnomalies,
  CLAIM_SUFFIX,
  COMPLETED_SUFFIX,
  claimLabelFor,
  DEFAULT_THRESHOLDS,
  CLASS_SEVERITY,
  humanizeAge,
};
