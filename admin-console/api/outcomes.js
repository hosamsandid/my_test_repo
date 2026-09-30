'use strict';

// ─── agent/role OUTCOMES port (#827, agent-outcomes concept §3/§5.1/§7) ──────
//
// The structured successor to the flat `emits` string[] (#414/#783). An agent
// declares its possible *outcomes* — e.g. a code reviewer's *accepted* vs
// *revisions required*, a dispatcher's *route to Developer 1 / 2 / hold* — as a
// first-class, editable port:
//
//   outcomes: {
//     mode: "exactlyOne" | "anyOf",      // switch vs. zero-or-more per run
//     options: [
//       { id, title?, when?, notify?,
//         actions: [ { type: "setLabel"|"openPr"|"openIssue"|"wakeAgent"|"none",
//                      label?, target?, to?, note? } ] }
//     ]
//   }
//
// Phase 2 (this module) is the data model only: schema, validation, the
// read-path lift of flat `emits`, and the pure projections the graph builders +
// bundle transforms consume. NOTHING here has runtime meaning — outcomes stay
// declarative (concept decision 4). No I/O; pure functions only.
//
// The lift (§7) is the compatibility hinge: an agent/role with a flat `emits`
// and no `outcomes` is read *everywhere* (graph build, export, materialise) as
// the degenerate set { mode: "anyOf", options: emits.map(l => ({ id: slug(l),
// actions: [{ type: "setLabel", label: l }] })) } — so a legacy agent projects
// back to exactly its original label set and yields byte-identical graph edges.

const OUTCOME_MODES = new Set(['exactlyOne', 'anyOf']);
const ACTION_TYPES = new Set(['setLabel', 'openPr', 'openIssue', 'wakeAgent', 'none']);

// ─── where a `setLabel` lands: Issue vs Pull Request (#2629) ─────────────────
//
// GitHub reports a label on a PR as `pull_request.labeled` and a label on an
// issue as `issues.labeled` — never both, and the poller has no alias between
// them. A consumer listening on the wrong one never wakes. So a `setLabel`
// action may carry an explicit `target: 'issue' | 'pr'`; when absent, the
// target is IMPLIED, in this order:
//   1. the same option opens a PR / an issue (`openPr` / `openIssue`) — the
//      label goes on the artifact that outcome produces;
//   2. the producer is only ever woken by one kind of GitHub object (all its
//      github-event triggers are `pull_request*` or all are `issues.*`) — it
//      can only be labelling the object it was woken on;
//   otherwise null (genuinely unknown).
const LABEL_TARGETS = new Set(['issue', 'pr']);

// The one GitHub object kind a producer's github-event triggers react to, or
// null when it listens on both, neither, or only kind-ambiguous events
// (`issue_comment` fires for PR comments too, `push` has no object).
function triggerObjectKind(triggers) {
  const kinds = new Set();
  for (const t of (Array.isArray(triggers) ? triggers : [])) {
    if (!t || t.type !== 'github-event' || !Array.isArray(t.events)) continue;
    for (const e of t.events) {
      const obj = String(e || '').split('.')[0];
      if (obj === 'issues') kinds.add('issue');
      else if (obj.startsWith('pull_request')) kinds.add('pr');
    }
  }
  return kinds.size === 1 ? [...kinds][0] : null;
}

/**
 * The object a `setLabel` action applies its label to — 'issue' | 'pr' | null.
 * @param {object} option - the outcome option carrying the action
 * @param {object} action - the setLabel action
 * @param {Array} [producerTriggers] - the producer's triggers (rule 2 above)
 */
function setLabelTarget(option, action, producerTriggers) {
  if (action && LABEL_TARGETS.has(action.target)) return action.target;
  for (const a of (option && Array.isArray(option.actions) ? option.actions : [])) {
    if (a && a.type === 'openPr') return 'pr';
    if (a && a.type === 'openIssue') return 'issue';
  }
  return triggerObjectKind(producerTriggers);
}

// The `.labeled` event GitHub emits for a label on that target.
function labelTargetEvent(target) {
  return target === 'pr' ? 'pull_request.labeled' : target === 'issue' ? 'issues.labeled' : null;
}

// ─── the `wakeAgent` action (#2030, direct-agent-handoff concept §4.1) ───────
//
// A direct, label-free hand-off: `{ type: 'wakeAgent', to: '<roleId>', note? }`
// wakes a wired SAME-TEAM role inside the platform. `to` is a role id in this
// flow (remapped to a member id at materialise, back on export — see
// process-template.js), NOT a label token: label-suffix.js must never stamp it.
//
// `note` is a short sentence of context from the producer. It is CAPPED, not
// rejected: the cap is half the §5.3 defence (the other half is the untrusted
// envelope the consumer wraps it in), so a producer cannot turn the note into a
// prompt for its peer. Truncation is explicit — a silently shortened note would
// read as the producer's complete thought.
const WAKE_NOTE_MAX = 1024;
const WAKE_NOTE_TRUNCATION_MARK = ' […truncated]';

// Counted and cut in CODE POINTS, not UTF-16 code units. `String#slice` can
// land between a surrogate pair, and the resulting lone surrogate is not
// encodable as UTF-8 — it would blow up on the consumer side when the prompt is
// written to the Claude CLI's stdin, where the write error is swallowed and the
// pipe is never closed, hanging the run while it holds the workspace gate.
// `Array.from` iterates code points, so a cut can never split a character.
function clampWakeNote(note) {
  const s = typeof note === 'string' ? note : String(note == null ? '' : note);
  const chars = Array.from(s);
  if (chars.length <= WAKE_NOTE_MAX) return s;
  const markChars = Array.from(WAKE_NOTE_TRUNCATION_MARK).length;
  return chars.slice(0, WAKE_NOTE_MAX - markChars).join('') + WAKE_NOTE_TRUNCATION_MARK;
}

// The team an addressable entry belongs to, using the one idiom the rest of the
// platform uses (`orchestrator.js`: `cfg.parentTeamId || cfg.teamId || null`).
// A BUNDLE role carries neither — every role in one bundle is in one flow by
// construction, so `null` correctly means "no cross-team claim to make".
function wakeTargetTeam(entry) {
  if (!entry || typeof entry !== 'object') return null;
  return entry.parentTeamId || entry.teamId || null;
}

// Index the addressable roles/agents a `wakeAgent` may name, or null when the
// caller threaded no `agents` source at all. Null is "unknown, so forbid
// nothing" — the same posture the gate rule takes without a label registry:
// a target whose existence cannot be checked is not an authoring error.
function wakeTargetIndex(sources) {
  const list = sources && Array.isArray(sources.agents) ? sources.agents : null;
  if (!list) return null;
  const idx = new Map();
  for (const a of list) {
    if (!a || typeof a !== 'object' || typeof a.id !== 'string' || !a.id.trim()) continue;
    if (!idx.has(a.id.trim())) idx.set(a.id.trim(), a);
  }
  return idx;
}

// A human-GATE label is set by a human by definition, so an agent may not set it
// as an outcome action (concept §3, same rule as `gate-violation`). Gate-ness is
// CONFIGURATION, not a naming convention (#928): it comes from the label
// registry's `humanGate` flag (or a channel's `gate: 'human'`) that the caller
// threads in as `sources`, never from the label's name. With no registry nothing
// is forbidden — a label whose flags are unknown is a plain agent label.
//
// A `brake` label is deliberately NOT forbidden: a brake pauses the loop and may
// be agent-applied (the reworker setting `human-decision-required` when it needs
// a human decision).
//
// Reuse the single canonical classifier in process-graph.js. Lazy require to
// avoid a load-time circular dependency (process-graph.js requires this module
// for the graph projection).
function forbiddenOutcomeLabel(label, sources) {
  const { makeLabelClassifier } = require('./process-graph');
  return makeLabelClassifier(sources).isHumanGate(label);
}

// Stable slug from a label, used only for the degenerate lift's option ids.
// Lower-case, collapse non-`[a-z0-9-]` runs to `-`, trim, fall back to `outcome`.
// (Authored options carry their own author-given ids; this never touches them.)
function slugifyOutcome(label) {
  const collapsed = String(label == null ? '' : label)
    .toLowerCase().replace(/[^a-z0-9-]+/g, '-');
  // Trim leading/trailing `-` with a linear scan rather than `/^-+|-+$/g`: the
  // anchored `-+$` alternative backtracks quadratically on a long run of `-`
  // (js/polynomial-redos). char code 45 === '-'; output is byte-identical.
  let start = 0;
  let end = collapsed.length;
  while (start < end && collapsed.charCodeAt(start) === 45) start++;
  while (end > start && collapsed.charCodeAt(end - 1) === 45) end--;
  const base = collapsed.slice(start, end);
  return base || 'outcome';
}

/**
 * Validate an `outcomes` port. Returns { ok: true } or { ok: false, error }.
 * Rules (concept §3, AC3):
 *   - `mode` must be "exactlyOne" | "anyOf".
 *   - `options` must be an array; option `id`s must be non-empty and unique.
 *   - each action `type` must be known; a `setLabel` needs a non-empty `label`,
 *     and that label may not be a human-gate label.
 * `exactlyOne` with fewer than two options is intentionally VALID here — that is
 * a phase-5 `switch-with-one-option` lint (info), not a schema error.
 *
 * @param {object} outcomes
 * @param {object} [sources] - gate/brake flag sources (#928), forwarded to
 *   `makeLabelClassifier`: `{ labels: [{ name, humanGate?, brake? }], agents }`.
 *   Absent = no label is known to be a gate, so no `setLabel` is rejected on
 *   gate grounds (gate-ness is configuration, never inferred from the name).
 */
function validateOutcomes(outcomes, sources) {
  if (!outcomes || typeof outcomes !== 'object' || Array.isArray(outcomes)) {
    return { ok: false, error: 'outcomes must be an object' };
  }
  if (!OUTCOME_MODES.has(outcomes.mode)) {
    return { ok: false, error: "outcomes.mode must be 'exactlyOne' or 'anyOf'" };
  }
  if (!Array.isArray(outcomes.options)) {
    return { ok: false, error: 'outcomes.options must be an array' };
  }
  const seenIds = new Set();
  for (const o of outcomes.options) {
    if (!o || typeof o !== 'object' || typeof o.id !== 'string' || !o.id.trim()) {
      return { ok: false, error: 'each outcome option needs a non-empty string id' };
    }
    const id = o.id.trim();
    if (seenIds.has(id)) return { ok: false, error: `duplicate outcome option id: ${id}` };
    seenIds.add(id);
    if (o.title !== undefined && typeof o.title !== 'string') {
      return { ok: false, error: `option ${id}: title must be a string` };
    }
    if (o.when !== undefined && typeof o.when !== 'string') {
      return { ok: false, error: `option ${id}: when must be a string` };
    }
    if (o.notify !== undefined && typeof o.notify !== 'string') {
      return { ok: false, error: `option ${id}: notify must be a string` };
    }
    // Open-end markers (#1004, concept §4.7): `terminal: true` ("this is the
    // end product") and `external: {note?}` ("consumed outside this flow").
    // Mutually exclusive — an outcome is one kind of endpoint, not both.
    if (o.terminal !== undefined && o.terminal !== true) {
      return { ok: false, error: `option ${id}: terminal must be true when present` };
    }
    if (o.external !== undefined) {
      if (!o.external || typeof o.external !== 'object' || Array.isArray(o.external)) {
        return { ok: false, error: `option ${id}: external must be an object ({note?})` };
      }
      if (o.external.note !== undefined && typeof o.external.note !== 'string') {
        return { ok: false, error: `option ${id}: external.note must be a string` };
      }
    }
    if (o.terminal === true && o.external !== undefined) {
      return { ok: false, error: `option ${id}: terminal and external are mutually exclusive` };
    }
    if (!Array.isArray(o.actions)) {
      return { ok: false, error: `option ${id}: actions must be an array` };
    }
    for (const a of o.actions) {
      if (!a || typeof a !== 'object' || !ACTION_TYPES.has(a.type)) {
        return { ok: false, error: `option ${id}: unknown action type ${a && a.type}` };
      }
      if (a.type === 'setLabel') {
        if (typeof a.label !== 'string' || !a.label.trim()) {
          return { ok: false, error: `option ${id}: setLabel action needs a label` };
        }
        if (forbiddenOutcomeLabel(a.label.trim(), sources)) {
          return { ok: false, error: `option ${id}: outcome may not set human-gate label \`${a.label.trim()}\`` };
        }
        if (a.target !== undefined && !LABEL_TARGETS.has(a.target)) {
          return { ok: false, error: `option ${id}: setLabel target must be 'issue' or 'pr'` };
        }
      }
      if (a.type === 'wakeAgent') {
        const err = validateWakeAction(a, id, sources);
        if (err) return { ok: false, error: err };
      }
    }
  }
  return { ok: true };
}

/**
 * The five §4.2 rules for one `wakeAgent` action. Returns an error string or
 * null. Split out of `validateOutcomes` so the rule set reads as a unit — this
 * is the part of P1 the concept calls the easiest to get wrong.
 *
 * Both target rules degrade honestly when the caller threaded no `agents`
 * source (the live PUT path before #2030 wired one, an ad-hoc suggester check):
 * an unverifiable target is not an authoring error, and delivery still refuses
 * it with a `404 unknown-target` / `403 cross-team`.
 */
function validateWakeAction(action, optionId, sources) {
  const to = typeof action.to === 'string' ? action.to.trim() : '';
  if (!to) return `option ${optionId}: wakeAgent action needs a to`;
  const index = wakeTargetIndex(sources);
  if (index && !index.has(to)) {
    return `option ${optionId}: wakeAgent target \`${to}\` is not a role in this flow`;
  }
  const fromId = sources && typeof sources.roleId === 'string' ? sources.roleId.trim() : '';
  if (fromId && fromId === to) {
    return `option ${optionId}: wakeAgent may not target its own role`;
  }
  // Same-team only (§6). This is reachable only where the `agents` source spans
  // more than one team (the live PUT passes every agent, deliberately, so a
  // real agent elsewhere reads as "outside this team" rather than "not a role in
  // this flow"). Inside one bundle both sides resolve to null and the rule is
  // silent — which is correct, not a gap.
  if (index && fromId) {
    const fromTeam = wakeTargetTeam(index.get(fromId));
    const toTeam = wakeTargetTeam(index.get(to));
    if (fromTeam && toTeam && fromTeam !== toTeam) {
      return `option ${optionId}: wakeAgent target \`${to}\` is outside this team`;
    }
  }
  if (action.note !== undefined && typeof action.note !== 'string') {
    return `option ${optionId}: note must be a string`;
  }
  return null;
}

// Whether a value is an authored outcomes port (well-formed shape with at least
// one option) — the signal to prefer it over flat `emits` on read. Kept
// deliberately lenient (mode + non-empty options); persistence gates on the
// stricter validateOutcomes.
function isAuthoredOutcomes(outcomes) {
  return !!(outcomes && typeof outcomes === 'object' && !Array.isArray(outcomes)
    && OUTCOME_MODES.has(outcomes.mode)
    && Array.isArray(outcomes.options) && outcomes.options.length > 0);
}

// Canonical stored shape: drop unknown fields, coerce known ones. Used by the
// PUT persistence + the edit adapters + the bundle transforms so the port
// round-trips losslessly for its documented fields (id/title/when/notify/mode +
// actions[].type/label + the #1004 open-end markers terminal/external).
// Assumes an already-validated port.
function normalizeOutcomes(outcomes) {
  return {
    mode: outcomes.mode,
    options: (Array.isArray(outcomes.options) ? outcomes.options : []).map(o => ({
      id: o.id.trim(),
      ...(typeof o.title === 'string' && o.title ? { title: o.title } : {}),
      ...(typeof o.when === 'string' && o.when ? { when: o.when } : {}),
      actions: (Array.isArray(o.actions) ? o.actions : []).map(a => ({
        type: a.type,
        ...(a.type === 'setLabel' && typeof a.label === 'string' && a.label.trim()
          ? { label: a.label.trim() } : {}),
        ...(a.type === 'setLabel' && LABEL_TARGETS.has(a.target) ? { target: a.target } : {}),
        // wakeAgent (#2030): `to` + the capped `note` must survive every
        // persist, or the edge is lost with no error anywhere.
        ...(a.type === 'wakeAgent' && typeof a.to === 'string' && a.to.trim()
          ? { to: a.to.trim() } : {}),
        ...(a.type === 'wakeAgent' && typeof a.note === 'string' && a.note.trim()
          ? { note: clampWakeNote(a.note.trim()) } : {}),
      })),
      ...(typeof o.notify === 'string' && o.notify ? { notify: o.notify } : {}),
      // Open-end markers (#1004): terminal XOR external ({note?}).
      ...(o.terminal === true ? { terminal: true } : {}),
      ...(o.terminal !== true && o.external && typeof o.external === 'object' && !Array.isArray(o.external)
        ? { external: {
            ...(typeof o.external.note === 'string' && o.external.note.trim()
              ? { note: o.external.note.trim() } : {}),
          } }
        : {}),
    })),
  };
}

/**
 * Read-path lift (§7). Returns the EFFECTIVE outcomes for an agent/role:
 *   - an authored `outcomes` port (normalized), when present; else
 *   - the degenerate `anyOf` set derived from flat `emits`; else
 *   - null when the agent declares neither.
 * @param {{ outcomes?, emits? }} src
 */
function liftOutcomes(src = {}) {
  const { outcomes, emits } = src;
  if (isAuthoredOutcomes(outcomes)) return normalizeOutcomes(outcomes);
  const labels = Array.isArray(emits)
    ? [...new Set(emits.filter(e => typeof e === 'string' && e))] : [];
  if (!labels.length) return null;
  return {
    mode: 'anyOf',
    options: labels.map(l => ({ id: slugifyOutcome(l), actions: [{ type: 'setLabel', label: l }] })),
  };
}

// The (label, outcomeId) pairs an outcomes port sets via `setLabel` actions —
// the outcome-keyed emit index the graph builders consume. Order-preserving,
// de-duplicated on the (label, outcomeId) pair. Human-gate labels are skipped
// defensively (they can never be persisted, but the read path stays safe) — so
// imported/legacy data with a gate label in an outcome is caught by the
// `human-label-as-outcome` lint rather than double-reported as `gate-violation`.
// `sources` carries the gate flags (#928); with none, nothing is filtered.
function outcomeEmitPairs(outcomes, sources) {
  const out = [];
  const seen = new Set();
  for (const o of (outcomes && Array.isArray(outcomes.options) ? outcomes.options : [])) {
    if (!o || typeof o.id !== 'string') continue;
    for (const a of (Array.isArray(o.actions) ? o.actions : [])) {
      if (!a || a.type !== 'setLabel') continue;
      const label = typeof a.label === 'string' ? a.label.trim() : '';
      if (!label || forbiddenOutcomeLabel(label, sources)) continue;
      const key = `${label} ${o.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ label, outcome: o.id });
    }
  }
  return out;
}

// The flat set of labels an outcomes port sets (the projection that replaces
// `emits` in the emit index). Order-preserving, unique.
function outcomeSetLabels(outcomes, sources) {
  return [...new Set(outcomeEmitPairs(outcomes, sources).map(p => p.label))];
}

// The github produce flags an outcomes port implies via openPr/openIssue actions
// (concept decision 3 — `github.produces*` becomes an outcome projection).
function outcomesToGithub(outcomes) {
  const g = {};
  for (const o of (outcomes && Array.isArray(outcomes.options) ? outcomes.options : [])) {
    for (const a of (o && Array.isArray(o.actions) ? o.actions : [])) {
      if (a && a.type === 'openPr') g.producesPr = true;
      if (a && a.type === 'openIssue') g.producesIssue = true;
    }
  }
  return g;
}

// Apply a `{{var}}` substitution fn to the template-bearing fields of an
// outcomes port — `label` (setLabel actions) and `when` (documentation +
// prompt material), exactly like trigger `labelFilter`/prompt fields (§3).
// Returns a NEW port; `subst` is the caller's substituteVars-style fn.
function substituteOutcomes(outcomes, subst) {
  if (!isAuthoredOutcomes(outcomes)) return outcomes;
  const f = typeof subst === 'function' ? subst : (s => s);
  return {
    mode: outcomes.mode,
    options: outcomes.options.map(o => ({
      id: o.id,
      ...(typeof o.title === 'string' && o.title ? { title: o.title } : {}),
      ...(typeof o.when === 'string' && o.when ? { when: f(o.when) } : {}),
      actions: (Array.isArray(o.actions) ? o.actions : []).map(a => ({
        type: a.type,
        ...(a.type === 'setLabel' && typeof a.label === 'string' ? { label: f(a.label) } : {}),
        ...(a.type === 'setLabel' && LABEL_TARGETS.has(a.target) ? { target: a.target } : {}),
        // wakeAgent (#2030): `to` is a role id — carried through UNsubstituted,
        // because the role-id → member-id remap is buildMemberFromTemplate's
        // job, not a `{{var}}` expansion. `note` is template-bearing free text
        // like `when` / `external.note`, and is re-clamped after substitution
        // (a `{{var}}` can expand past the cap).
        ...(a.type === 'wakeAgent' && typeof a.to === 'string' ? { to: a.to } : {}),
        ...(a.type === 'wakeAgent' && typeof a.note === 'string'
          ? { note: clampWakeNote(f(a.note)) } : {}),
      })),
      ...(typeof o.notify === 'string' && o.notify ? { notify: o.notify } : {}),
      // Open-end markers (#1004) ride through materialise; the note is
      // template-bearing free text like `when`.
      ...(o.terminal === true ? { terminal: true } : {}),
      ...(o.external && typeof o.external === 'object' && !Array.isArray(o.external)
        ? { external: { ...(typeof o.external.note === 'string' && o.external.note ? { note: f(o.external.note) } : {}) } }
        : {}),
    })),
  };
}

// The `{to, note?, outcome}` triples an outcomes port hands off directly
// (#2030) — the wake-edge index the graph builders + the prompt projection
// consume, mirroring `outcomeEmitPairs`. Order-preserving, de-duplicated on the
// (to, outcomeId) pair; a `to`-less action is skipped defensively (it can never
// be persisted, but the read path must stay safe for imported/legacy data).
function outcomeWakePairs(outcomes) {
  const out = [];
  const seen = new Set();
  for (const o of (outcomes && Array.isArray(outcomes.options) ? outcomes.options : [])) {
    if (!o || typeof o.id !== 'string') continue;
    for (const a of (Array.isArray(o.actions) ? o.actions : [])) {
      if (!a || a.type !== 'wakeAgent') continue;
      const to = typeof a.to === 'string' ? a.to.trim() : '';
      if (!to) continue;
      const key = `${to} ${o.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        to,
        outcome: o.id,
        ...(typeof a.note === 'string' && a.note.trim()
          ? { note: clampWakeNote(a.note.trim()) } : {}),
      });
    }
  }
  return out;
}

module.exports = {
  OUTCOME_MODES, ACTION_TYPES,
  slugifyOutcome, validateOutcomes, normalizeOutcomes, isAuthoredOutcomes,
  liftOutcomes, outcomeEmitPairs, outcomeSetLabels, outcomesToGithub,
  substituteOutcomes, forbiddenOutcomeLabel,
  // wakeAgent (#2030)
  WAKE_NOTE_MAX, WAKE_NOTE_TRUNCATION_MARK, clampWakeNote,
  validateWakeAction, outcomeWakePairs,
  // setLabel target (#2629)
  LABEL_TARGETS, setLabelTarget, triggerObjectKind, labelTargetEvent,
};
