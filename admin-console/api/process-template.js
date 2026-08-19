'use strict';

// ─── process-template bundle (Process Canvas, #334) ──────────────────────────
//
// A *process template* is a portable, git-committable JSON description of a
// modeled orchestration: the roles (each with its persona prompt and triggers,
// including the declarative `emits`), plus the human gates and the label
// registry. It is the export format of the Process Canvas and the import format
// for materialising a real team. Pure transforms only — no I/O here.
//
// Shape (processTemplateVersion 1):
//   {
//     processTemplateVersion: 1,
//     name, level,                       // level: 'live' | 'template' (informational)
//     roles: [ { id, displayName, role, sessionPolicy, systemPrompt,
//                triggers: [ { id, type, events, labelFilter, cron, at,
//                              emits, description, prompt } ] } ],
//     gates:  [ { label } ],
//     labels: [ { name, humanGate, brake } ],
//   }
//
// `labels[]` is the AUTHORITATIVE gate/brake registry (#928): `humanGate: true`
// makes the label a human approval gate (no agent may set it) and `brake: true`
// makes it pause the loop — whatever the label is called. Nothing is inferred
// from the label's name any more.

const {
  validateOutcomes, normalizeOutcomes, isAuthoredOutcomes, substituteOutcomes,
  outcomesToGithub,
} = require('./outcomes');

const VERSION = 1;

// ─── named human roles (#987) ────────────────────────────────────────────────
// Optional top-level `humans[]` on the bundle: first-class human flow nodes
// [{ id, name, description?, stage?, emits?, consumes? }]. Purely declarative —
// they never materialise into an agent; the graph builders bind them to the
// #981 gate/brake/delivery touchpoints. Normalized to the persisted shape so a
// re-import reads clean values and export→materialise round-trips.
function normalizeHumans(humans) {
  const out = [];
  const seen = new Set();
  for (const h of (Array.isArray(humans) ? humans : [])) {
    if (!h || typeof h !== 'object' || Array.isArray(h)) continue;
    const id = typeof h.id === 'string' ? h.id.trim() : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const entry = { id, name: (typeof h.name === 'string' && h.name.trim()) ? h.name.trim() : id };
    if (typeof h.description === 'string' && h.description.trim()) entry.description = h.description.trim();
    if (typeof h.stage === 'string' && h.stage.trim()) entry.stage = h.stage.trim();
    const emits = (Array.isArray(h.emits) ? h.emits : [])
      .filter(e => typeof e === 'string' && e.trim()).map(e => e.trim());
    if (emits.length) entry.emits = [...new Set(emits)];
    const consumes = [];
    for (const c of (Array.isArray(h.consumes) ? h.consumes : [])) {
      if (!c || typeof c !== 'object' || Array.isArray(c)) continue;
      if (typeof c.label === 'string' && c.label.trim()) consumes.push({ label: c.label.trim() });
      else if ((c.artifact === 'pr' || c.artifact === 'issue') && typeof c.from === 'string' && c.from.trim()) {
        consumes.push({ artifact: c.artifact, from: c.from.trim() });
      } else if (c.artifact === 'file' && typeof c.name === 'string' && c.name.trim()) {
        consumes.push({ artifact: 'file', name: c.name.trim() });
      }
    }
    if (consumes.length) entry.consumes = consumes;
    out.push(entry);
  }
  return out;
}

// Optional top-level `hillClimb` on the bundle (hill-climbing loop, #1222 +
// #1224): the team's loop config `{ autonomy?, cron?, windowDays?,
// minRunsPerWindow?, maxCardsPerPass?, excludeAgents? }` on the team agent.
// Round-tripped through export→materialise→Edit-as-draft like `stages`/`labels`/
// `anomalyThresholds`. Normalized to only the known config keys — the
// applied-card / snapshot state deliberately NEVER travels (it is per-instance
// run history, not config). `autonomy` (0–2; 3 is not authored in v1) is the
// analyst/apply dial (#1224): 0 = collector only (no cards). Returns null when
// nothing meaningful is set, so an empty config stays byte-identical to a flow
// that never configured it.
function normalizeHillClimb(hc) {
  if (!hc || typeof hc !== 'object' || Array.isArray(hc)) return null;
  const out = {};
  if ([0, 1, 2, 3].includes(hc.autonomy)) out.autonomy = hc.autonomy;
  if (typeof hc.cron === 'string' && hc.cron.trim()) out.cron = hc.cron.trim();
  if (Number.isFinite(hc.windowDays) && hc.windowDays > 0) out.windowDays = hc.windowDays;
  if (Number.isFinite(hc.minRunsPerWindow) && hc.minRunsPerWindow >= 0) out.minRunsPerWindow = hc.minRunsPerWindow;
  if (Number.isFinite(hc.maxCardsPerPass) && hc.maxCardsPerPass >= 0) out.maxCardsPerPass = hc.maxCardsPerPass;
  const ex = (Array.isArray(hc.excludeAgents) ? hc.excludeAgents : [])
    .filter(s => typeof s === 'string' && s.trim()).map(s => s.trim());
  if (ex.length) out.excludeAgents = [...new Set(ex)];
  return Object.keys(out).length ? out : null;
}

// Strip a leading `<teamId>-` so an exported member id becomes a reusable role
// key (e.g. `acme-developer` → `developer`). Idempotent for ids without it.
function roleKeyOf(id, teamId) {
  if (teamId && id.startsWith(teamId + '-')) return id.slice(teamId.length + 1);
  return id;
}

// Normalize an optional authored wake-prompt override (#868) to a trimmed
// non-empty string, else '' (falsy). A blank/whitespace override is treated as
// "no override" so the derived listener keeps its generated prompt.
function cleanWakePrompt(v) {
  return typeof v === 'string' && v.trim() ? v.trim() : '';
}

// Claim labels (#958, concept §3.4). A label listener's claim is DERIVED by
// convention — `<wakeLabel>:wip` — never authored: Layer 3 reconciliation has to
// be able to compute the claim label from the wake label alone (a
// `wake-not-claimed` probe looks for exactly `<wake>:wip`), so an arbitrary
// `add` would make stalls invisible again. The validator enforces the convention
// rather than merely tolerating it, for that reason.
const CLAIM_SUFFIX = ':wip';

// The claim label a given wake label maps to.
function claimLabelFor(wakeLabel) {
  return `${wakeLabel}${CLAIM_SUFFIX}`;
}

// The success mirror `<wakeLabel>:completed` (#1163) — the runtime swaps
// `<wake>:wip` for it when a claimed run finishes, so "done" is a visibly
// distinct third state. Never authored (runtime-derived only, like `:wip`); this
// constant/helper keep the convention's third location in sync with
// `CLAIM_COMPLETED_SUFFIX` in agent-entrypoint.py and flow-anomaly-detector.js.
const COMPLETED_SUFFIX = ':completed';

// The completed label a given wake label maps to.
function completedLabelFor(wakeLabel) {
  return `${wakeLabel}${COMPLETED_SUFFIX}`;
}

/**
 * Derive the `claim` field for a label listener, or null when the trigger is not
 * claimable. Pure — the single source of truth for the convention, shared by the
 * draft expanders, the live reconcilers (which delegate to those) and the weaver.
 *
 * Not claimable: a missing/blank label filter (a raw event listener has no wake
 * label to take over), or a listener that already waits on a claim label — that
 * would derive `ready:wip:wip` and claim its own claim.
 */
function deriveClaim(labelFilter) {
  const wake = typeof labelFilter === 'string' ? labelFilter.trim() : '';
  if (!wake) return null;
  if (wake.endsWith(CLAIM_SUFFIX)) return null;
  return { remove: wake, add: claimLabelFor(wake) };
}

/**
 * Validate a trigger's `claim` against its own `labelFilter` (#958, concept §3.5).
 * Returns an error string, or null when the claim is absent (optional field) or
 * well-formed. Shared by the bundle validator and the export whitelist.
 */
function claimError(claim, labelFilter, type) {
  if (claim === undefined || claim === null) return null; // optional
  if (typeof claim !== 'object' || Array.isArray(claim)) return 'claim must be an object';
  if (type !== 'github-event') return 'claim is only valid on a github-event trigger';
  const wake = typeof labelFilter === 'string' ? labelFilter.trim() : '';
  if (!wake) return 'claim requires a labelFilter (only a label listener can be claimed)';
  if (typeof claim.remove !== 'string' || !claim.remove.trim()) return 'claim.remove must be a non-empty string';
  if (typeof claim.add !== 'string' || !claim.add.trim()) return 'claim.add must be a non-empty string';
  // The runtime swap removes the wake label it just woke on — a `remove` that
  // disagrees with the listener would strip an unrelated label (concept §3.2).
  if (claim.remove.trim() !== wake) {
    return `claim.remove (\`${claim.remove.trim()}\`) must equal labelFilter (\`${wake}\`)`;
  }
  // Naming convention `<wakeLabel>:wip` (concept §3.4) — enforced, not merely
  // derived, so reconciliation can always compute the claim label.
  const expected = claimLabelFor(wake);
  if (claim.add.trim() !== expected) {
    return `claim.add (\`${claim.add.trim()}\`) must follow the \`<wakeLabel>:wip\` convention (\`${expected}\`)`;
  }
  return null;
}

/**
 * The raw-layer wiring rules in one place (#1006, concept §4.8): what a
 * `github-event` trigger must satisfy REGARDLESS of which surface wrote it —
 * the engine, the TriggersPanel, a draft bundle, a direct API call, or a
 * hand-edited triggers.json. Shared by the live trigger endpoints, the bundle
 * validator and the `raw-trigger-nonconformant` graph lint, so the rule set
 * cannot drift between enforcement points.
 *
 * Rules: exactly ONE event per github-event trigger (the 2026-07-05 migration,
 * whose absence server-side let the #987 two-event regression persist), and a
 * well-formed claim (`claimError`). `prev` is the stored trigger on an update:
 * a pre-existing multi-event trigger passing through UNCHANGED is tolerated
 * (the LegacyMultiEventNote migration flow keeps working); changing the events
 * of one must shrink it to a single event.
 *
 * Returns an actionable error string, or null when conformant.
 */
function rawTriggerError(t, prev) {
  if (!t || typeof t !== 'object' || t.type !== 'github-event') return null;
  const events = Array.isArray(t.events) ? t.events : [];
  if (events.length > 1) {
    const prevEvents = prev && Array.isArray(prev.events) ? prev.events : null;
    const unchanged = prevEvents && prevEvents.length === events.length
      && prevEvents.every((e, i) => e === events[i]);
    if (!unchanged) {
      return `a github-event trigger carries exactly ONE event (got ${events.length}: ${events.join(', ')}) — create one trigger per event`;
    }
  }
  return claimError(t.claim, t.labelFilter, t.type);
}

function isValidClaim(claim, labelFilter) {
  return !!claim && claimError(claim, labelFilter, 'github-event') === null;
}

// At most one active chat-launched loop per agent (#1020 AC8). A launched loop
// is a one-off "run until done" tagged `launched: true`; starting a second one
// while one runs would race two runners. Returns true when `candidate` is a
// launched loop AND `existing` already holds one. Pure — unit-tested.
function launchedLoopConflict(existing, candidate) {
  const isLaunchedLoop = (t) => !!t && t.type === 'loop' && !!t.launched;
  if (!isLaunchedLoop(candidate)) return false;
  return (Array.isArray(existing) ? existing : []).some(isLaunchedLoop);
}

// Whether a channel port opts OUT of the derived claim (#958). Default is ON, so
// only an explicit `autoClaim: false` disables it. The opt-out lives on the PORT,
// not on the derived trigger: channel/data-flow triggers are stripped and
// regenerated on every reconcile, so a trigger-level flag would be silently
// wiped on the next port write — the same reason the authored wake-prompt
// override (#868) lives on the channel.
function channelAutoClaim(ch) {
  return !(ch && ch.autoClaim === false);
}

// A channel opts its derived listener into internal delivery (#1194) only when it
// is a **labelled, non-human** channel. `transport: 'internal'` on an unlabelled
// channel (artifact-open — that is artifact creation, a real GitHub write) or a
// `gate: 'human'` channel (a person applies the label in the GitHub UI, only the
// poller can see it) is meaningless, so it is treated as absent everywhere. Same
// shape as `channelAutoClaim`: the port carries the intent, the expander decides.
function channelIsInternal(ch) {
  return !!(ch && ch.transport === 'internal'
    && typeof ch.label === 'string' && ch.label.trim()
    && ch.gate !== 'human');
}

// Remap a channel's `from` role reference through roleKeyOf so an exported team's
// GitHub-channel wiring uses portable role keys (#380).
function remapChannel(ch, teamId) {
  const wakePrompt = cleanWakePrompt(ch.wakePrompt);
  return {
    artifact: ch.artifact === 'issue' ? 'issue' : 'pr',
    from: roleKeyOf(ch.from, teamId),
    ...(ch.label ? { label: ch.label } : {}),
    ...(ch.gate ? { gate: ch.gate } : {}),
    // Optional authored wake-prompt override (#868) — carried on the portable
    // bundle so an exported team round-trips its override.
    ...(wakePrompt ? { wakePrompt } : {}),
    // Claim opt-out (#958) — only the non-default is carried, so a bundle stays
    // free of `autoClaim: true` noise on every channel.
    ...(channelAutoClaim(ch) ? {} : { autoClaim: false }),
    // Internal-channel transport (#1194) — a labelled channel may opt its derived
    // listener into internal delivery (poller-excluded, woken by `aee-emit`). Only
    // the non-default is carried, and only where it is meaningful: a labelled,
    // non-human channel. Dropping it would silently turn the listener back into a
    // poller-delivered one on re-materialise (same reason as the trigger-level
    // carry in bundleTrigger).
    ...(channelIsInternal(ch) ? { transport: 'internal' } : {}),
  };
}

// Slim a trigger for the bundle: keep what defines the wiring + behaviour, drop
// team-specific/runtime cruft (repo is re-applied at materialise time; secrets
// never live on triggers).
function bundleTrigger(t) {
  const out = { id: t.id, type: t.type, enabled: t.enabled !== false };
  if (t.type === 'github-event') {
    out.events = Array.isArray(t.events) ? t.events : [];
    if (t.labelFilter) out.labelFilter = t.labelFilter;
    // Claim (#958) — carried on the portable bundle so the claim survives
    // export → materialise → edit-as-draft. Derived listeners get it re-stamped
    // by the expanders anyway; a hand-authored claim would otherwise be lost.
    if (isValidClaim(t.claim, t.labelFilter)) out.claim = { remove: t.claim.remove, add: t.claim.add };
    // Internal-channel transport (#1174) — part of the wiring, must round-trip:
    // dropping it would silently turn an internal listener back into a
    // poller-delivered one on re-materialise. Only the non-default is carried.
    if (t.transport === 'internal') out.transport = 'internal';
  } else if (t.type === 'cron') {
    out.cron = t.cron || null;
  } else if (t.type === 'once') {
    out.at = t.at || null;
  }
  // Trigger-level `emits` was removed (#783) — the portable bundle carries
  // label hand-offs only at the role level. A legacy trigger `emits` is dropped
  // here; callers lift it to the role level (liftTriggerEmits) before export.
  if (t.dataFlow) out.dataFlow = true; // data-flow (agent dependency) marker (#379)
  if (t.description) out.description = t.description;
  if (t.prompt) out.prompt = t.prompt;
  if (t.preCheckScript) out.preCheckScript = t.preCheckScript;
  if (t.preCheckEnv && typeof t.preCheckEnv === 'object') out.preCheckEnv = { ...t.preCheckEnv };
  return out;
}

/**
 * Assemble a process-template bundle.
 * @param {object} opts
 * @param {string} opts.name
 * @param {string} opts.level - 'live' | 'template'
 * @param {string} [opts.teamId] - when exporting a team, used to derive role keys
 * @param {Array} opts.roles - [{ id, displayName, role, sessionPolicy, systemPrompt, triggers }]
 * @param {Array} [opts.gates]
 * @param {Array} [opts.labels]
 */
function buildProcessTemplate({ name, level, teamId, roles, gates, labels, stages, humans, hillClimb }) {
  const normHumans = normalizeHumans(humans);
  const normHillClimb = normalizeHillClimb(hillClimb);
  return {
    processTemplateVersion: VERSION,
    name: name || 'process-template',
    level: level || 'template',
    // Ordered stage names — the layout backbone (agents snap to their stage's
    // column in this order). Portable + git-committable like gates/labels.
    ...(Array.isArray(stages) && stages.length
      ? { stages: stages.map(s => (typeof s === 'string' ? s : s && s.name)).filter(Boolean) }
      : {}),
    // Named human roles (#987) — first-class human flow nodes, round-tripped so
    // an exported team re-materialises its human boxes and Edit-as-draft carries
    // them. Omitted when empty so a flow with no humans stays byte-identical.
    ...(normHumans.length ? { humans: normHumans } : {}),
    // Hill-climb collector config (#1222) — team-agent config, round-tripped;
    // omitted when unset so a flow that never configured it stays byte-identical.
    ...(normHillClimb ? { hillClimb: normHillClimb } : {}),
    roles: (roles || []).map(r => ({
      id: roleKeyOf(r.id, teamId),
      displayName: r.displayName || r.id,
      role: r.role || 'team-member',
      sessionPolicy: r.sessionPolicy || 'persistent',
      // Drop the derived prompt blocks (github-io #380 + outcomes #829) so the
      // portable bundle stays clean; they are regenerated from the `github` flag
      // and the `outcomes` port by expandGithubChannels on import/materialise.
      systemPrompt: stripDerivedPromptBlocks(r.systemPrompt),
      // Agent-level OUTCOMES port (#827/#831). Authored outcomes are used directly;
      // legacy flat `emits` are lifted to a degenerate anyOf so the exported bundle
      // never carries a raw `emits` field. Import still works via liftOutcomes (#831).
      ...((() => {
        if (isAuthoredOutcomes(r.outcomes)) return { outcomes: normalizeOutcomes(r.outcomes) };
        if (Array.isArray(r.emits) && r.emits.length) {
          return { outcomes: normalizeOutcomes({
            mode: 'anyOf',
            options: r.emits.map(l => ({ id: l, title: l, actions: [{ type: 'setLabel', label: l }] })),
          }) };
        }
        return {};
      })()),
      // Process stage band — portable so an exported team round-trips its stage
      // layout back into a draft (Edit as draft) and re-materialises unchanged.
      ...(typeof r.stage === 'string' && r.stage ? { stage: r.stage } : {}),
      // GitHub artifact ports (#380): what this role produces (PR/issue) and the
      // PR/issue channels it consumes. Declarative source of truth — the runtime
      // github-event triggers are re-derived from these (expandGithubChannels),
      // so the derived `channel:true` triggers are dropped from the portable bundle.
      ...(r.github && (r.github.producesPr || r.github.producesIssue)
        ? { github: {
          ...(r.github.producesPr ? { producesPr: true } : {}),
          ...(r.github.producesIssue ? { producesIssue: true } : {}),
          // Artifact audience (#981) — a person consumes the PR/issue; must
          // round-trip or a re-materialised team regains the
          // producer-unconsumed lint and loses its delivery touchpoint.
          ...(r.github.producesPr && r.github.prAudience === 'human' ? { prAudience: 'human' } : {}),
          ...(r.github.producesIssue && r.github.issueAudience === 'human' ? { issueAudience: 'human' } : {}),
        } }
        : {}),
      ...(Array.isArray(r.channels) && r.channels.length
        ? { channels: r.channels.map(c => remapChannel(c, teamId)) } : {}),
      triggers: (r.triggers || []).filter(t => !t.channel).map(bundleTrigger),
    })),
    gates: (gates || []).map(g => ({ label: g.label })),
    labels: (labels || []).map(l => ({ name: l.name, humanGate: !!l.humanGate, brake: !!l.brake })),
  };
}

// Basic shape validation for a bundle. Returns { ok, error }.
// `allowEmptyRoles` is for in-progress drafts (#344) — materialisation still
// requires a non-empty role set, so the default stays strict.
function validateProcessTemplate(b, { allowEmptyRoles = false } = {}) {
  if (!b || typeof b !== 'object') return { ok: false, error: 'not an object' };
  if (b.processTemplateVersion !== VERSION) {
    return { ok: false, error: `unsupported processTemplateVersion (expected ${VERSION})` };
  }
  if (!Array.isArray(b.roles)) return { ok: false, error: 'roles must be an array' };
  if (!allowEmptyRoles && b.roles.length === 0) return { ok: false, error: 'roles must be a non-empty array' };
  for (const r of b.roles) {
    if (!r || typeof r.id !== 'string' || !r.id) return { ok: false, error: 'each role needs a string id' };
    if (r.triggers && !Array.isArray(r.triggers)) return { ok: false, error: `role ${r.id}: triggers must be an array` };
    // Wiring rules on bundle triggers (#1006 §4.8, flipped by #1008 now that
    // the generators — weaver, curated templates — are migrated:
    //  - STRICT mode (materialise, registry, weaver self-check) enforces the
    //    full `rawTriggerError` contract: exactly ONE event per github-event
    //    trigger + a well-formed claim.
    //  - DRAFT mode (`allowEmptyRoles`) keeps claim validation only: a draft
    //    holding a pre-flip multi-event trigger must stay SAVEABLE, or the
    //    editor's own migration flow (shrink the events, then save) deadlocks.
    for (const t of (r.triggers || [])) {
      if (!t || typeof t !== 'object') continue;
      const te = allowEmptyRoles ? claimError(t.claim, t.labelFilter, t.type) : rawTriggerError(t);
      if (te) return { ok: false, error: `role ${r.id}: trigger ${t.id || '(unnamed)'}: ${te}` };
      // Internal-channel transport (#1174): a mistyped value would silently
      // fall back to poller delivery, so the shape is checked, not tolerated.
      if (t.transport !== undefined && t.transport !== 'internal' && t.transport !== 'github') {
        return { ok: false, error: `role ${r.id}: trigger ${t.id || '(unnamed)'}: transport must be 'internal' or 'github'` };
      }
      if (t.transport === 'internal'
          && !(t.type === 'github-event' && typeof t.labelFilter === 'string' && t.labelFilter.trim())) {
        return { ok: false, error: `role ${r.id}: trigger ${t.id || '(unnamed)'}: transport 'internal' requires a github-event label listener (labelFilter)` };
      }
    }
    if (r.outcomes !== undefined) {
      // The bundle's own label registry is the gate authority (#928) — an outcome
      // may not set a `humanGate` label, whatever it is named.
      const vo = validateOutcomes(r.outcomes, { labels: b.labels, agents: b.roles });
      if (!vo.ok) return { ok: false, error: `role ${r.id}: ${vo.error}` };
    }
    if (r.channels !== undefined) {
      if (!Array.isArray(r.channels)) return { ok: false, error: `role ${r.id}: channels must be an array` };
      for (const c of r.channels) {
        if (!c || (c.artifact !== 'pr' && c.artifact !== 'issue')) {
          return { ok: false, error: `role ${r.id}: each channel needs artifact 'pr' or 'issue'` };
        }
        if (typeof c.from !== 'string' || !c.from) return { ok: false, error: `role ${r.id}: each channel needs a string 'from'` };
        if (c.wakePrompt !== undefined && typeof c.wakePrompt !== 'string') {
          return { ok: false, error: `role ${r.id}: channel wakePrompt must be a string` };
        }
        // Internal-channel transport (#1194): a mistyped value would silently fall
        // back to poller delivery, so the shape is checked, not tolerated — and
        // `internal` is only meaningful on a labelled, non-human channel (an
        // unlabelled/human-gated channel stays poller-delivered by design).
        if (c.transport !== undefined && c.transport !== 'internal' && c.transport !== 'github') {
          return { ok: false, error: `role ${r.id}: channel transport must be 'internal' or 'github'` };
        }
        if (c.transport === 'internal' && !(typeof c.label === 'string' && c.label.trim())) {
          return { ok: false, error: `role ${r.id}: channel transport 'internal' requires a label (an unlabelled channel stays poller-delivered)` };
        }
        if (c.transport === 'internal' && c.gate === 'human') {
          return { ok: false, error: `role ${r.id}: channel transport 'internal' is not allowed on a human-approval gate (a person applies the label on GitHub)` };
        }
      }
    }
  }
  if (b.gates && !Array.isArray(b.gates)) return { ok: false, error: 'gates must be an array' };
  if (b.labels !== undefined) {
    if (!Array.isArray(b.labels)) return { ok: false, error: 'labels must be an array' };
    // The registry carries the authoritative gate/brake flags (#928), so its
    // shape is checked rather than merely tolerated: a mistyped `humanGate` used
    // to be harmless (the name decided) and would now silently drop a gate.
    const seen = new Set();
    for (const l of b.labels) {
      if (!l || typeof l !== 'object' || Array.isArray(l)) return { ok: false, error: 'each label must be an object' };
      if (typeof l.name !== 'string' || !l.name.trim()) return { ok: false, error: 'each label needs a non-empty string name' };
      const name = l.name.trim();
      if (seen.has(name)) return { ok: false, error: `duplicate label \`${name}\` in the registry` };
      seen.add(name);
      if (l.humanGate !== undefined && typeof l.humanGate !== 'boolean') {
        return { ok: false, error: `label ${name}: humanGate must be a boolean` };
      }
      if (l.brake !== undefined && typeof l.brake !== 'boolean') {
        return { ok: false, error: `label ${name}: brake must be a boolean` };
      }
    }
  }
  if (b.stages) {
    if (!Array.isArray(b.stages)) return { ok: false, error: 'stages must be an array' };
    if (!b.stages.every(s => typeof s === 'string')) return { ok: false, error: 'stages must be an array of strings' };
  }
  // Hill-climb loop config (#1222 + #1224): an object of known scalar/array keys.
  if (b.hillClimb !== undefined) {
    const hc = b.hillClimb;
    if (!hc || typeof hc !== 'object' || Array.isArray(hc)) return { ok: false, error: 'hillClimb must be an object' };
    if (hc.autonomy !== undefined && ![0, 1, 2, 3].includes(hc.autonomy)) {
      return { ok: false, error: 'hillClimb.autonomy must be 0, 1, 2 or 3' };
    }
    if (hc.cron !== undefined && typeof hc.cron !== 'string') return { ok: false, error: 'hillClimb.cron must be a string' };
    if (hc.windowDays !== undefined && !(Number.isFinite(hc.windowDays) && hc.windowDays > 0)) {
      return { ok: false, error: 'hillClimb.windowDays must be a positive number' };
    }
    if (hc.minRunsPerWindow !== undefined && !(Number.isFinite(hc.minRunsPerWindow) && hc.minRunsPerWindow >= 0)) {
      return { ok: false, error: 'hillClimb.minRunsPerWindow must be a non-negative number' };
    }
    if (hc.maxCardsPerPass !== undefined && !(Number.isFinite(hc.maxCardsPerPass) && hc.maxCardsPerPass >= 0)) {
      return { ok: false, error: 'hillClimb.maxCardsPerPass must be a non-negative number' };
    }
    if (hc.excludeAgents !== undefined && (!Array.isArray(hc.excludeAgents) || !hc.excludeAgents.every(s => typeof s === 'string'))) {
      return { ok: false, error: 'hillClimb.excludeAgents must be an array of strings' };
    }
  }
  // Named human roles (#987): unique slug ids, non-empty names, well-formed
  // consume entries. Purely declarative — no trigger/runtime shape to check.
  if (b.humans !== undefined) {
    if (!Array.isArray(b.humans)) return { ok: false, error: 'humans must be an array' };
    const seenH = new Set();
    for (const h of b.humans) {
      if (!h || typeof h !== 'object' || Array.isArray(h)) return { ok: false, error: 'each human must be an object' };
      if (typeof h.id !== 'string' || !h.id.trim()) return { ok: false, error: 'each human needs a non-empty string id' };
      const id = h.id.trim();
      if (seenH.has(id)) return { ok: false, error: `duplicate human id \`${id}\`` };
      seenH.add(id);
      if (typeof h.name !== 'string' || !h.name.trim()) return { ok: false, error: `human ${id}: name must be a non-empty string` };
      if (h.emits !== undefined && (!Array.isArray(h.emits) || !h.emits.every(e => typeof e === 'string'))) {
        return { ok: false, error: `human ${id}: emits must be an array of strings` };
      }
      if (h.consumes !== undefined) {
        if (!Array.isArray(h.consumes)) return { ok: false, error: `human ${id}: consumes must be an array` };
        for (const c of h.consumes) {
          if (!c || typeof c !== 'object' || Array.isArray(c)) return { ok: false, error: `human ${id}: each consume must be an object` };
          const isLabel = typeof c.label === 'string' && c.label.trim();
          const isArtifact = (c.artifact === 'pr' || c.artifact === 'issue') && typeof c.from === 'string' && c.from.trim();
          const isFile = c.artifact === 'file' && typeof c.name === 'string' && c.name.trim();
          if (!isLabel && !isArtifact && !isFile) {
            return { ok: false, error: `human ${id}: each consume needs { label } or { artifact: 'pr'|'issue', from } or { artifact: 'file', name }` };
          }
        }
      }
    }
  }
  return { ok: true };
}

// An empty draft skeleton (#344).
function emptyDraftBundle(name) {
  return {
    processTemplateVersion: VERSION,
    name: name || 'Untitled flow',
    level: 'template',
    roles: [],
    gates: [],
    labels: [],
    stages: [],
    humans: [],
  };
}

// Draft storage id (slug) derivation. A draft's id is a name-derived, mutable
// slug — re-keyed whenever the name changes (#581), not a permanent external
// identifier. Kept identical to the original creation-time behaviour: lower-case,
// collapse non-`[a-z0-9-]` runs to `-`, trim leading/trailing `-`, 48-char cap,
// empty result falls back to `process`.
const DRAFT_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
function slugifyDraft(name) {
  // Collapse non-`[a-z0-9-]` runs to `-`, then trim leading/trailing `-` with a
  // linear char scan rather than `/^-+|-+$/g` — the anchored `-+$` alternative is
  // polynomial-ReDoS on a long run of `-` (CodeQL js/polynomial-redos). Behaviour
  // is byte-identical: trim both ends, then 48-char cap.
  const collapsed = String(name || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-');
  let start = 0;
  let end = collapsed.length;
  while (start < end && collapsed.charCodeAt(start) === 45) start += 1; // 45 === '-'
  while (end > start && collapsed.charCodeAt(end - 1) === 45) end -= 1;
  const base = collapsed.slice(start, end).slice(0, 48);
  return base || 'process';
}

// Derive a unique draft id from a name. `exists(id)` reports whether an id is
// already taken; `currentId` (when re-deriving on rename) is treated as free so
// a name whose slug already equals the draft's own id is a no-op — never
// spuriously suffixed. Collisions reuse the creation-time `-2`/`-3` suffix loop.
function deriveUniqueDraftId(name, { currentId = null, exists } = {}) {
  let base = slugifyDraft(name);
  if (!DRAFT_ID_RE.test(base)) base = 'process';
  let id = base;
  let n = 2;
  while (id !== currentId && exists(id)) { id = `${base}-${n++}`; }
  return id;
}

// Transform a bundle's roles into the `customRoles` shape consumed by
// POST /api/teams — pseudo-templates the existing materialisation loop renders
// exactly like catalog templates (var substitution over prompt + triggers).
function templateToCustomRoles(bundle) {
  return (bundle.roles || []).map(r => ({
    id: r.id,
    displayName: r.displayName || r.id,
    sessionPolicy: r.sessionPolicy === 'per-invocation' ? 'per-invocation' : undefined,
    promptTemplate: r.systemPrompt || '',
    // Carry the BP data-flow ports + dependencies through so the materialised
    // member's config can record them — the live graph then renders the
    // dependency/artifact edges of an imported flow, not just the push triggers
    // (#379). No-op for ordinary catalog roles (they carry none).
    ...(Array.isArray(r.inputs) && r.inputs.length ? { inputs: r.inputs } : {}),
    ...(Array.isArray(r.outputs) && r.outputs.length ? { outputs: r.outputs } : {}),
    ...(Array.isArray(r.dependsOn) && r.dependsOn.length ? { dependsOn: r.dependsOn } : {}),
    // Parent role id (hierarchy) — the materialiser maps it to a member id so
    // the agent overview + live graph render the parent-child tree (#377).
    ...(typeof r.parent === 'string' && r.parent ? { parent: r.parent } : {}),
    // Process stage band — carried onto the materialised member's config so the
    // live graph reproduces the draft's stage layout instead of collapsing to
    // the auto-layered columns.
    ...(typeof r.stage === 'string' && r.stage ? { stage: r.stage } : {}),
    // Agent-level OUTCOMES port (#827) — recorded on member config; supersedes
    // `emits` when present (the two never coexist on a materialised member).
    ...(isAuthoredOutcomes(r.outcomes) ? { outcomes: normalizeOutcomes(r.outcomes) } : {}),
    // Agent-level emitted labels (legacy flat hand-offs) — recorded on member
    // config only when no structured outcomes supersede them.
    ...(!isAuthoredOutcomes(r.outcomes) && Array.isArray(r.emits) && r.emits.length
      ? { emits: r.emits } : {}),
    // GitHub artifact ports (#380) — carried to member config so the live graph
    // renders channel edges + the orchestrator instructs the agent to open
    // PRs/issues. The functional consumer triggers are already expanded by
    // expandGithubChannels before this runs.
    ...(r.github && (r.github.producesPr || r.github.producesIssue) ? { github: r.github } : {}),
    ...(Array.isArray(r.channels) && r.channels.length ? { channels: r.channels } : {}),
    triggers: (r.triggers || []).map(t => ({
      id: t.id,
      type: t.type,
      enabled: t.enabled !== false,
      events: t.events,
      labelFilter: t.labelFilter,
      // Claim (#958) — MUST survive into the member config: this is the field the
      // container runtime (`_claim_plan` in agent-entrypoint.py, #957) reads to
      // swap the wake label for `<wake>:wip`. Dropping it here made the whole
      // feature a silent no-op at runtime even though the graph rendered it.
      ...(t.claim ? { claim: t.claim } : {}),
      // Internal-channel transport (#1174) — MUST survive for the same reason:
      // the poller excludes `transport: 'internal'` triggers from its plan and
      // /internal/flow-emit only matches them; dropping the field here would
      // leave the listener poller-delivered and the producer's `aee-emit`
      // waking nobody.
      ...(t.transport === 'internal' ? { transport: 'internal' } : {}),
      cron: t.cron,
      at: t.at,
      // Trigger-level emits removed (#783) — label hand-offs ride on role `emits`.
      dataFlow: t.dataFlow,
      channel: t.channel,
      // Informational provenance for a consolidated channel listener (#826).
      ...(Array.isArray(t.sources) ? { sources: t.sources } : {}),
      description: t.description,
      promptTemplate: t.prompt || '',
      preCheckScript: t.preCheckScript,
      preCheckEnv: t.preCheckEnv,
    })),
  }));
}

// ─── GitHub PR/Issue channels (#380) ─────────────────────────────────────
// The declarative way agents hand work off over GitHub. A role's `github` flags
// say what it *produces* (opens PRs / opens issues); a consumer role's
// `channels: [{ artifact, from, label?, gate? }]` say which producer's PR/issue
// it *reacts to* (optionally only when a label is present, optionally only when a
// human applied that label — the inline approval gate). This mirrors the
// data-flow port model: the ports are the single source of truth, and this
// expansion (materialise time + live reconcile) derives the concrete
// github-event trigger on the consumer, marked `channel: true` so it can be
// regenerated idempotently. The producer-side instruction ("open a PR/issue") is
// appended to the producer's systemPrompt as an idempotent, marker-delimited
// block (stripped on export, regenerated on expand) so a re-import never
// duplicates it.

// Marker-delimited producer instruction block (#380) — kept idempotent so
// export→import→materialise round-trips cleanly.
const PRODUCE_MARK_START = '<!-- github-io:start -->';
const PRODUCE_MARK_END = '<!-- github-io:end -->';

function producePrText() {
  return [
    '**Opening pull requests.** When a unit of your work is ready for the team, open a',
    'Pull Request: write the PR body to a file, run `gh-as-agent stamp <file>`, then',
    '`gh pr create --title "<title>" --body-file <file>`. Downstream agents are woken by',
    'your PR, so always open one when you finish a piece of work.',
  ].join('\n');
}

function produceIssueText() {
  return [
    '**Opening issues.** When you identify work another agent should pick up, open a',
    'GitHub Issue: write the issue body to a file, run `gh-as-agent stamp <file>`, then',
    '`gh issue create --title "<title>" --body-file <file>`.',
  ].join('\n');
}

function stripProduceBlock(text) {
  if (typeof text !== 'string' || !text.includes(PRODUCE_MARK_START)) return typeof text === 'string' ? text : '';
  return text.replace(
    new RegExp(`\\n*${PRODUCE_MARK_START}[\\s\\S]*?${PRODUCE_MARK_END}\\n*`, 'g'), '',
  ).trimEnd();
}

function produceBlock(github) {
  const parts = [];
  if (github && github.producesPr) parts.push(producePrText());
  if (github && github.producesIssue) parts.push(produceIssueText());
  if (!parts.length) return '';
  return `${PRODUCE_MARK_START}\n\n## GitHub outputs\n\n${parts.join('\n\n')}\n\n${PRODUCE_MARK_END}`;
}

// ─── Outcomes prompt block (#829, agent-outcomes concept §6) ─────────────────
//
// The structured `outcomes` declaration (#827) is the source of truth; this is
// its generated *prompt projection* — the same marker-delimited, strip-then-
// reappend idempotency as the github-io produce block above, so a re-import /
// re-reconcile never duplicates it. Only an **authored** outcomes port projects
// a block: an agent carrying just flat `emits` (the degenerate read-path lift)
// gets nothing, so a migration alone changes no behaviour (concept §7, AC4).
//
// It closes the gap the produce block leaves open — today's producePrText /
// produceIssueText never mention the routing *label* the consumer filters on, so
// agent-driven labelling only worked if the author remembered to put it in
// prose. With outcomes the projection is guaranteed consistent with the switch.
const OUTCOMES_MARK_START = '<!-- outcomes:start -->';
const OUTCOMES_MARK_END = '<!-- outcomes:end -->';

function stripOutcomesBlock(text) {
  if (typeof text !== 'string' || !text.includes(OUTCOMES_MARK_START)) {
    return typeof text === 'string' ? text : '';
  }
  return text.replace(
    new RegExp(`\\n*${OUTCOMES_MARK_START}[\\s\\S]*?${OUTCOMES_MARK_END}\\n*`, 'g'), '',
  ).trimEnd();
}

/**
 * The wiring context an outcomes block projects (#1007, concept V4): who
 * consumes each label this role sets, which person reviews its PR/issue
 * artifacts (and via which gate labels), and every gate label a human in the
 * flow applies. Pure derivation from the same ports the graph reads:
 *
 *   consumersByLabel — label -> [displayName…] of OTHER roles listening on it
 *                      (github-event `labelFilter` triggers);
 *   reviewers        — { pr?: {name, gates: []}, issue?: {…} } from the humans
 *                      registry (`consumes: {artifact, from: thisRole}`; the
 *                      reviewer's `emits` are its gate labels);
 *   gateLabels       — every human-applied gate label in the flow (registry
 *                      `humanGate` flags + all human `emits`), sorted.
 *
 * `roles` accepts bundle roles and live member shapes ({id, displayName?/name?,
 * triggers?}). Returns null when no context at all exists — the block then
 * renders exactly as before #1007 (byte-identical legacy output).
 */
function outcomesWiringContext(roleId, { roles = [], humans = [], labels = [] } = {}) {
  const nameOf = (r) => r.displayName || r.name || r.id;
  const consumersByLabel = {};
  // Labels with ≥1 `transport: 'internal'` listener (#1174). One internal
  // listener is enough to flip the producer instruction to `aee-emit`: the
  // emit delivers internally AND mirrors the label onto GitHub, so any
  // remaining poller-delivered listener of the same label still fires — the
  // reverse (a plain `gh` label) can never wake the internal one.
  const internalLabels = new Set();
  for (const r of roles) {
    if (!r || r.id === roleId) continue;
    for (const t of (Array.isArray(r.triggers) ? r.triggers : [])) {
      if (!t || t.type !== 'github-event') continue;
      const lf = typeof t.labelFilter === 'string' ? t.labelFilter.trim() : '';
      if (!lf) continue;
      (consumersByLabel[lf] = consumersByLabel[lf] || []).push(nameOf(r));
      if (t.transport === 'internal') internalLabels.add(lf);
    }
  }
  const reviewers = {};
  const gateSet = new Set();
  for (const h of (Array.isArray(humans) ? humans : [])) {
    if (!h || !h.id) continue;
    const emits = (Array.isArray(h.emits) ? h.emits : []).filter(e => typeof e === 'string' && e.trim());
    for (const e of emits) gateSet.add(e.trim());
    for (const c of (Array.isArray(h.consumes) ? h.consumes : [])) {
      if (c && (c.artifact === 'pr' || c.artifact === 'issue') && c.from === roleId && !reviewers[c.artifact]) {
        reviewers[c.artifact] = { name: h.name || h.id, gates: emits };
      }
    }
  }
  for (const l of (Array.isArray(labels) ? labels : [])) {
    if (l && l.humanGate && typeof l.name === 'string' && l.name.trim()) gateSet.add(l.name.trim());
  }
  const gateLabels = [...gateSet].sort();
  if (!Object.keys(consumersByLabel).length && !Object.keys(reviewers).length && !gateLabels.length) {
    return null;
  }
  return {
    consumersByLabel,
    reviewers,
    gateLabels,
    ...(internalLabels.size ? { internalLabels: [...internalLabels].sort() } : {}),
  };
}

// The "Then: …" action clause for one option — a human-readable summary of its
// actions joined with " and ". `setLabel` names the label; `openPr`/`openIssue`
// use the produce verbs (the full how-to is appended once below, reusing
// producePrText/produceIssueText); a `none`-only / empty action set is
// "set no label". A `notify: "dm"` option appends the DM-reporting instruction.
// With a wiring context (#1007) a setLabel clause names its consumer ("— this
// wakes **Developer**"). Returns the clause plus whether it opens a PR/issue.
function outcomeActionClause(option, wiring) {
  const parts = [];
  let opensPr = false;
  let opensIssue = false;
  let setsLabel = false;
  for (const a of (option && Array.isArray(option.actions) ? option.actions : [])) {
    if (!a || typeof a !== 'object') continue;
    if (a.type === 'setLabel' && typeof a.label === 'string' && a.label.trim()) {
      const label = a.label.trim();
      setsLabel = true;
      const consumers = wiring && wiring.consumersByLabel && wiring.consumersByLabel[label];
      const who = consumers && consumers.length
        ? ` — this wakes **${[...new Set(consumers)].join('**, **')}**` : '';
      // Internal-channel label (#1174): the hand-off is delivered by the
      // orchestrator, so the instruction is `aee-emit` (which also mirrors the
      // label onto GitHub) — a plain `gh` label would wake nobody internal.
      const internal = wiring && Array.isArray(wiring.internalLabels)
        && wiring.internalLabels.includes(label);
      parts.push(internal
        ? `announce label \`${label}\` over the internal channel: run \`aee-emit "${label}" --issue <n>\` (or \`--pr <n>\`)${who ? `${who} directly` : ''}`
        : `apply label \`${label}\`${who}`);
    } else if (a.type === 'openPr') {
      parts.push('open a pull request'); opensPr = true;
    } else if (a.type === 'openIssue') {
      parts.push('open a GitHub issue'); opensIssue = true;
    }
  }
  if (!parts.length) parts.push('set no label');
  let clause = parts.join(' and ');
  if (option && option.notify === 'dm') clause += '; report to the user in the DM';
  return { clause, opensPr, opensIssue, setsLabel };
}

// Generate the marker-delimited `## Outcomes` block for an authored outcomes
// port (concept §6). Empty string for a non-authored port (nothing to project).
// Pure; the caller (expandGithubChannels / reconcileTeamOutcomes) does the
// strip-then-reappend into the systemPrompt.
function outcomesBlock(outcomes, wiring) {
  if (!isAuthoredOutcomes(outcomes)) return '';
  const exactlyOne = outcomes.mode === 'exactlyOne';
  const lead = exactlyOne
    ? 'At the end of every run you choose **exactly one** of the following outcomes:'
    : 'At the end of every run you choose **all outcomes that apply** — zero is allowed:';
  const items = [];
  let anyPr = false;
  let anyIssue = false;
  let anyLabel = false;
  outcomes.options.forEach((o, i) => {
    const title = (typeof o.title === 'string' && o.title.trim()) ? o.title.trim() : o.id;
    const { clause, opensPr, opensIssue, setsLabel } = outcomeActionClause(o, wiring);
    anyPr = anyPr || opensPr;
    anyIssue = anyIssue || opensIssue;
    anyLabel = anyLabel || setsLabel;
    const when = (typeof o.when === 'string' && o.when.trim()) ? ` when: ${o.when.trim()}.` : '';
    let line = `${i + 1}. **${title}** —${when} Then: ${clause}.`;
    // Reviewer context (#1007): the person reviewing this option's artifact,
    // and the explicit prohibition on its gate label(s) — declaration and
    // agent behaviour must not drift (a gate set by an agent is a hard error).
    const reviewer = wiring && wiring.reviewers
      && ((opensPr && wiring.reviewers.pr) || (opensIssue && wiring.reviewers.issue));
    if (reviewer) {
      line += ` **${reviewer.name}** reviews it.`;
      if (reviewer.gates && reviewer.gates.length) {
        const gates = reviewer.gates.map(g => `\`${g}\``).join(', ');
        line += ` Do **not** apply the gate label${reviewer.gates.length > 1 ? 's' : ''} ${gates} yourself — a person applies ${reviewer.gates.length > 1 ? 'them' : 'it'}.`;
      }
    }
    // Open-end markers (#1004/#1007): a declared endpoint tells the agent to
    // stop signalling, instead of leaving the run feeling unfinished.
    if (o.terminal === true) {
      line += ' This is the final deliverable — set no further signal.';
    } else if (o.external && typeof o.external === 'object') {
      const note = typeof o.external.note === 'string' && o.external.note.trim()
        ? ` (${o.external.note.trim()})` : '';
      line += ` Consumed outside this flow${note} — no further signal expected.`;
    }
    items.push(line);
  });
  const body = [lead, '', ...items];
  if (exactlyOne) {
    body.push('', 'Never apply more than one of these labels in a single run.');
  }
  // Verbatim-label contract: downstream listeners match the exact string, so a
  // "close enough" label that already exists in the repo wakes nobody. Without
  // this an agent hitting `gh`'s "'<label>' not found" error tends to fall
  // back to a similar-sounding existing label instead of creating the right
  // one — which silently breaks the flow.
  if (anyLabel) {
    body.push('', 'Outcome labels are exact contracts: apply each label **verbatim as written above**, never a similar-sounding label that happens to exist in the repository. If the label does not exist yet, create it first (`gh label create "<label>" --color FBCA04 --description "flow outcome label"`), then apply it — downstream listeners match the exact string, so a near-miss label wakes nobody.');
    // Internal-channel labels (#1174): the aee-emit instruction is repeated as
    // a hard rule, because the failure mode (agent falls back to `gh` and the
    // hand-off silently reaches nobody) is invisible on GitHub — the label
    // looks set either way.
    if (wiring && Array.isArray(wiring.internalLabels) && wiring.internalLabels.length) {
      const ints = wiring.internalLabels.map(l => `\`${l}\``).join(', ');
      body.push('', `The label${wiring.internalLabels.length > 1 ? 's' : ''} ${ints} ${wiring.internalLabels.length > 1 ? 'are' : 'is'} delivered over the **internal channel**: always announce ${wiring.internalLabels.length > 1 ? 'them' : 'it'} with \`aee-emit\`, never with \`gh issue edit --add-label\` — a manually applied label is only visible decoration and wakes no internal listener. \`aee-emit\` also mirrors the label onto GitHub for you, so it needs no separate \`gh\` step and no \`gh label create\`.`);
    }
  }
  // Flow-wide gate prohibition (#1007, §4.8 known gap): whenever the flow
  // contains human gates this agent could plausibly touch, the prohibition is
  // in the generated prose — not left to the author to remember.
  if (wiring && wiring.gateLabels && wiring.gateLabels.length) {
    const gates = wiring.gateLabels.map(g => `\`${g}\``).join(', ');
    body.push('', wiring.gateLabels.length > 1
      ? `The labels ${gates} are human approval gates — a person applies them; never set them yourself.`
      : `The label ${gates} is a human approval gate — a person applies it; never set it yourself.`);
  }
  // Absorb the produce how-to once for any option that opens a PR/issue —
  // reusing the exact producePrText/produceIssueText wording. The github-io
  // produce block omits the flags an outcome already covers (see
  // expandGithubChannels), so the "open a PR/issue" instruction never doubles.
  const tail = [];
  if (anyPr) tail.push(producePrText());
  if (anyIssue) tail.push(produceIssueText());
  const full = tail.length ? `${body.join('\n')}\n\n${tail.join('\n\n')}` : body.join('\n');
  return `${OUTCOMES_MARK_START}\n\n## Outcomes\n\n${full}\n\n${OUTCOMES_MARK_END}`;
}

// Strip both derived prompt blocks (github-io #380 + outcomes #829) from a
// systemPrompt — the portable/base form. Used on export and by the reconciler
// before re-appending freshly-generated blocks.
function stripDerivedPromptBlocks(text) {
  return stripOutcomesBlock(stripProduceBlock(text));
}

// Re-render a role/agent's systemPrompt with both derived prompt blocks from its
// declarative ports (`github` + `outcomes`) — strip-then-reappend, idempotent.
// Coexistence (AC3): an outcome that opens a PR/issue already carries the produce
// how-to inside the outcomes block, so the produce flags it covers are dropped
// from the github-io block — the instruction never appears twice. Order is
// produce-then-outcomes so a github-only agent's prompt stays byte-identical to
// before #829 (the outcomes block is empty and appends nothing). Pure.
function applyDerivedPromptBlocks(systemPrompt, { github, outcomes, wiring } = {}) {
  const base = stripDerivedPromptBlocks(systemPrompt || '');
  const covered = isAuthoredOutcomes(outcomes) ? outcomesToGithub(outcomes) : {};
  const effGithub = github && typeof github === 'object'
    ? {
      producesPr: !!(github.producesPr && !covered.producesPr),
      producesIssue: !!(github.producesIssue && !covered.producesIssue),
    }
    : github;
  const appended = [produceBlock(effGithub), outcomesBlock(outcomes, wiring)]
    .filter(Boolean).join('\n\n');
  return appended ? `${base ? `${base}\n\n` : ''}${appended}` : base;
}

const CHANNEL_EVENTS = {
  pr: { open: ['pull_request.opened', 'pull_request.reopened'], labeled: ['pull_request.labeled'] },
  issue: { open: ['issues.opened'], labeled: ['issues.labeled'] },
};

// Canonical id for a derived channel trigger, so reconciliation can find and
// regenerate it (kept in sync with reconcileTeamGithubChannels in api.js).
// The id is keyed on the (artifact, label) the trigger listens on — NOT on the
// producer (#826): channels from several producers over the same label collapse
// into ONE derived listener (the poller has no origin filter, so per-producer
// triggers were functionally identical duplicates). The contributing producers
// are recorded informationally on the trigger's `sources`.
function channelTriggerId(consumerId, artifact, label) {
  const lbl = typeof label === 'string' && label.trim() ? label.trim() : '';
  return `${consumerId}-on-${artifact}${lbl ? `-${lbl}` : ''}`;
}

function isChannelTrigger(t) {
  return !!(t && t.channel === true);
}

// A derived trigger owns no stable authoring point: channel (#380) and data-flow
// (#379) triggers are stripped and regenerated on every reconcile. Without a
// stamp, the poller's per-subscriber history horizon falls back to the volatile
// triggers.json mtime (effectiveHorizon in github-poller.js), so each reconcile
// rewrite pushes the horizon to "now" and can silently drop events that arrived
// in between (the #446 residual). `stampDerivedActivation` carries the prior
// same-id trigger's `activatedAt` onto its regenerated replacement — keeping the
// horizon fixed across reconciles — and stamps a genuinely new derived trigger
// with `now`. Non-derived and already-stamped triggers pass through untouched.
//
// Consolidation (#826): the channel id scheme changed from `<c>-on-<art>-<prod>`
// to `<c>-on-<art>[-<label>]` (producer dropped), so a reconcile that migrates an
// old team's per-producer triggers onto the new consolidated one cannot match by
// id — the ids differ. To keep the history horizon fixed across that migration, a
// derived trigger with no exact id match falls back to matching prior derived
// triggers by their (events, labelFilter) *listener signature* and carries the
// **oldest** `activatedAt` of that merged set. So merging N old triggers into one
// listener can never shove the poller's horizon forward to "now" and drop a
// pending event that arrived before the oldest of them. Id match still wins first
// (steady-state regeneration).
//
// The signature fallback is deliberately scoped to `channel` triggers: their id
// scheme changed (#826), so a migrated trigger must re-find its predecessors by
// signature. Data-flow (`<c>-on-push-<upstream>`) ids never changed and every
// data-flow trigger of one consumer shares the same `push` signature, so a
// signature fallback there would make a genuinely-new upstream inherit a
// sibling's old horizon and replay stale pushes — data-flow stays id-match only.
// Pure; `now` is injectable for tests.
function derivedListenerSignature(t) {
  const events = Array.isArray(t.events) ? t.events.slice().sort() : [];
  const label = typeof t.labelFilter === 'string' ? t.labelFilter : '';
  return `${events.join(',')}|${label}`;
}
function stampDerivedActivation(nextTriggers, prevTriggers, now) {
  const prevAt = new Map();           // id -> activatedAt (exact-id preservation)
  const prevChannelBySig = new Map(); // channel listener signature -> oldest activatedAt
  for (const t of (Array.isArray(prevTriggers) ? prevTriggers : [])) {
    if (!t || typeof t !== 'object' || !t.activatedAt) continue;
    if (!(t.channel === true || t.dataFlow === true)) continue;
    if (typeof t.id === 'string') prevAt.set(t.id, t.activatedAt);
    if (t.channel === true) {
      const sig = derivedListenerSignature(t);
      const cur = prevChannelBySig.get(sig);
      if (!cur || t.activatedAt < cur) prevChannelBySig.set(sig, t.activatedAt); // ISO strings sort lexicographically
    }
  }
  const stamp = now || new Date().toISOString();
  return (Array.isArray(nextTriggers) ? nextTriggers : []).map((t) => {
    if (!t || typeof t !== 'object') return t;
    const derived = t.channel === true || t.dataFlow === true;
    if (!derived || t.activatedAt) return t;
    const carried = prevAt.get(t.id)
      || (t.channel === true ? prevChannelBySig.get(derivedListenerSignature(t)) : undefined);
    return { ...t, activatedAt: carried || stamp };
  });
}

function consumePrPrompt(producerName, { label, human } = {}) {
  const lead = human && label
    ? `A human applied the \`${label}\` label to a pull request from **${producerName}** — that is your go-ahead.`
    : label
      ? `A pull request from **${producerName}** was labelled \`${label}\`.`
      : `**${producerName}** opened a pull request (see the event payload above).`;
  return [
    lead,
    '',
    'Act on it:',
    '1. `gh pr checkout <number>` (the PR number is in the payload) and read the diff.',
    '2. Do your part of the work on that PR / branch.',
    '3. Use `gh-as-agent` for any PR comments or reviews so your identity is stamped.',
    '',
    'Reply `[PASS]` if there is nothing for you to do here.',
  ].join('\n');
}

function consumeIssuePrompt(producerName, { label, human } = {}) {
  const lead = human && label
    ? `A human applied the \`${label}\` label to an issue from **${producerName}** — that is your go-ahead.`
    : label
      ? `An issue from **${producerName}** was labelled \`${label}\`.`
      : `**${producerName}** opened a GitHub issue (see the event payload above).`;
  return [
    lead,
    '',
    'Pick it up: read the issue, do the work it describes, then report back on the issue',
    '(write any comment to a file, run `gh-as-agent stamp <file>`, then `gh issue comment <n> --body-file <file>`).',
    '',
    'Reply `[PASS]` if this issue is not for you.',
  ].join('\n');
}

/**
 * Expand a role's `channels` ports into concrete consumer github-event triggers.
 * Returns a NEW bundle. Previously-derived `channel:true` triggers are stripped
 * first so an edited port (e.g. a newly-added label) regenerates cleanly rather
 * than leaving a stale trigger behind. Idempotent. Roles without channels are
 * untouched (no-op for catalog teams).
 * @param {object} bundle
 * @param {object} [_opts] - accepted for call-site parity; derived channel
 *   triggers carry no origin filter, so no team→member mapping is needed.
 */
function expandGithubChannels(bundle, _opts = {}) {
  const roles = (bundle.roles || []).map(r => ({
    ...r,
    triggers: (r.triggers || []).filter(t => !isChannelTrigger(t)),
  }));
  const byId = new Map(roles.map(r => [r.id, r]));

  for (const b of roles) {
    // Group this consumer's channels by the (artifact, label) listener they
    // resolve to (#826). Several producers over the same label yield ONE derived
    // trigger: since the poller carries no origin filter, per-producer triggers
    // were functionally identical (same events + labelFilter) and woke the agent
    // once per producer. The contributing producers are kept on `sources` for
    // provenance only. Insertion order (first channel wins the slot) is preserved
    // so the derivation stays deterministic.
    const groups = new Map(); // `${artifact}::${label}` -> { artifact, label, human, wakePrompt, sources: [] }
    for (const ch of (b.channels || [])) {
      const artifact = ch.artifact === 'issue' ? 'issue' : 'pr';
      const from = typeof ch.from === 'string' ? ch.from : '';
      if (!from || from === b.id) continue;
      const label = typeof ch.label === 'string' && ch.label.trim() ? ch.label.trim() : '';
      const human = ch.gate === 'human';
      const key = `${artifact}::${label}`;
      let g = groups.get(key);
      if (!g) { g = { artifact, label, human: false, wakePrompt: '', autoClaim: true, internal: true, sources: [] }; groups.set(key, g); }
      // Claim opt-out (#958): several channels consolidate into ONE derived
      // listener, and the claim is a property of that single listener — so an
      // explicit opt-out on any contributing channel wins, mirroring the
      // any-channel-gates-it rule for `human` below. Silently claiming when one
      // author asked not to would be the surprising direction.
      if (!channelAutoClaim(ch)) g.autoClaim = false;
      // Gated iff any contributing channel gates it (a mixed gated/ungated set on
      // the same label is degenerate — treat as gated, matching the old behaviour
      // where the labelled trigger already reacted to the label change).
      g.human = g.human || human;
      // Internal delivery (#1194): several channels consolidate into ONE derived
      // listener, and a listener is either poller-excluded or not — so it may go
      // internal only when EVERY contributing channel opted in. A lone
      // poller-delivered producer in the group would otherwise be dropped by the
      // poller exclusion (its plain `gh` label never reaches an internal-only
      // listener); the safe fallback is poller delivery, where the internal
      // producer's `aee-emit` still mirrors the label onto GitHub and the poller
      // picks it up. Mirrors the anomaly detector's all-or-nothing edge rule.
      g.internal = g.internal && channelIsInternal(ch);
      // Optional authored wake-prompt override (#868): several channels can
      // consolidate into one derived listener, so the first non-empty override in
      // insertion order wins the slot (deterministic; the graph shows one edge).
      if (!g.wakePrompt) g.wakePrompt = cleanWakePrompt(ch.wakePrompt);
      if (!g.sources.includes(from)) g.sources.push(from);
    }

    for (const g of groups.values()) {
      const id = channelTriggerId(b.id, g.artifact, g.label);
      if (b.triggers.some(t => t.id === id)) continue;
      const events = (g.label ? CHANNEL_EVENTS[g.artifact].labeled : CHANNEL_EVENTS[g.artifact].open).slice();
      const producerNames = g.sources.map(s => byId.get(s)?.displayName || s);
      const producerLabel = producerNames.join(', ') || 'an upstream';
      const claim = g.autoClaim ? deriveClaim(g.label) : null;
      // Internal-channel transport (#1194): only a labelled, non-human,
      // all-opted-in group delivers internally (deriveClaim/channelIsInternal
      // guarantee a label is present). The poller then excludes this listener and
      // `/internal/flow-emit` wakes it — the runtime, anomaly detector and
      // producer-instruction plumbing all key off this one field, unchanged.
      const internal = !!g.label && !g.human && g.internal;
      b.triggers.push({
        id,
        type: 'github-event',
        events,
        ...(g.label ? { labelFilter: g.label } : {}),
        ...(internal ? { transport: 'internal' } : {}),
        // Derived claim (#958, concept §3.4) — zero authoring cost: every derived
        // LABEL listener takes over its wake label as `<wake>:wip` when it fires.
        // An unlabelled channel listener (PR/issue opened) has no wake label to
        // claim, so deriveClaim returns null and no field is stamped.
        ...(claim ? { claim } : {}),
        // No origin filter: the trigger fires on any matching PR/issue event.
        // A human gate is expressed by the channel's `gate: 'human'` flag and/or
        // the label registry's `humanGate` flag (#928) — humans apply the label,
        // agents don't. The listener itself is the same either way.
        channel: true,
        // Informational only (#826): which producers' channels contributed to
        // this consolidated listener. No runtime meaning (the poller ignores it);
        // kept for provenance and so the graph can map each channel edge onto the
        // shared listener.
        sources: g.sources.slice(),
        enabled: true,
        description: `${g.artifact === 'pr' ? 'PR' : 'Issue'} from ${producerLabel}`
          + `${g.label ? ` labelled ${g.label}` : ''}${g.human ? ' (human-approved)' : ''}`,
        // Authored override (#868) wins over the generated prompt when present;
        // otherwise the derived listener keeps its generated wake prompt.
        prompt: g.wakePrompt
          || (g.artifact === 'pr'
            ? consumePrPrompt(producerLabel, { label: g.label, human: g.human })
            : consumeIssuePrompt(producerLabel, { label: g.label, human: g.human })),
      });
    }
  }
  // Derived prompt blocks — idempotent (strip any prior blocks, re-append):
  // the github-io producer instruction (#380) and the outcomes projection
  // (#829, wiring-aware since #1007). A SECOND pass, after every role's
  // listeners were derived above — a producer earlier in the list must see
  // consumers whose derived triggers only appear later in the loop.
  for (const b of roles) {
    const wiring = outcomesWiringContext(b.id, {
      roles, humans: bundle.humans, labels: bundle.labels,
    });
    b.systemPrompt = applyDerivedPromptBlocks(b.systemPrompt, {
      github: b.github, outcomes: b.outcomes, ...(wiring ? { wiring } : {}),
    });
  }
  return { ...bundle, roles };
}

/**
 * Back-compat: map a legacy `kind:'pr-review'` role (#347) onto the #380 channel
 * ports so old drafts/teams keep rendering. The reviewer becomes a plain agent
 * consuming a PR channel from its reviewed producer; the producer gets
 * `producesPr`. The approve/changes outcome routing is dropped (superseded by the
 * channel model). Idempotent; roles without the legacy meta pass through.
 */
function normalizeLegacyReview(bundle) {
  if (!bundle || !Array.isArray(bundle.roles)) return bundle;
  const roles = bundle.roles.map(r => ({ ...r }));
  const byId = new Map(roles.map(r => [r.id, r]));
  let changed = false;
  for (const r of roles) {
    if (r.kind !== 'pr-review') continue;
    changed = true;
    const rv = r.review || {};
    if (rv.reviewsPrFrom && byId.has(rv.reviewsPrFrom)) {
      r.channels = Array.isArray(r.channels) ? r.channels.slice() : [];
      if (!r.channels.some(c => c.artifact === 'pr' && c.from === rv.reviewsPrFrom)) {
        r.channels.push({ artifact: 'pr', from: rv.reviewsPrFrom });
      }
      const producer = byId.get(rv.reviewsPrFrom);
      producer.github = { ...(producer.github || {}), producesPr: true };
    }
    delete r.kind;
    delete r.review;
  }
  return changed ? { ...bundle, roles } : bundle;
}

/**
 * Backward-compat lift (#783). Trigger-level `emits` was removed — the agent/
 * role level is the canonical, sole source of label hand-off edges. An old
 * bundle, draft, exported team, or live `triggers.json` may still carry `emits`
 * on a role's triggers. Merge every such label into the role-level `emits`
 * (deduped, order-preserving: role labels first, then lifted trigger labels) and
 * strip `emits`/`emitsDerived` from the triggers, so no drawn edge is lost on
 * import/materialisation. Returns a NEW bundle; roles carrying no trigger emits
 * pass through untouched. Idempotent.
 */
function liftTriggerEmits(bundle) {
  if (!bundle || !Array.isArray(bundle.roles)) return bundle;
  let changed = false;
  const roles = bundle.roles.map((r) => {
    const triggers = Array.isArray(r.triggers) ? r.triggers : [];
    const hasTriggerEmits = triggers.some(
      (t) => t && typeof t === 'object' && ('emits' in t || 'emitsDerived' in t));
    if (!hasTriggerEmits) return r;
    changed = true;
    const lifted = [];
    for (const t of triggers) {
      if (t && Array.isArray(t.emits)) {
        for (const e of t.emits) if (typeof e === 'string' && e) lifted.push(e);
      }
    }
    const roleEmits = Array.isArray(r.emits) ? r.emits.filter((e) => typeof e === 'string' && e) : [];
    const merged = [...new Set([...roleEmits, ...lifted])];
    const strippedTriggers = triggers.map((t) => {
      if (t && typeof t === 'object' && ('emits' in t || 'emitsDerived' in t)) {
        const { emits, emitsDerived, ...rest } = t; // eslint-disable-line no-unused-vars
        return rest;
      }
      return t;
    });
    return { ...r, ...(merged.length ? { emits: merged } : {}), triggers: strippedTriggers };
  });
  return changed ? { ...bundle, roles } : bundle;
}

// ─── Data-flow steps (#379) ───────────────────────────────────────────────
// Core principle: agents hand files off via `git commit` + `git push`, so a
// push by an upstream agent IS the signal that downstream data is ready. This
// expansion (run only at materialise time) turns each data-flow edge —
// `depends_on` (ordering) and artifact output→input matches (data) — into a
// concrete `push` github-event trigger on the *consumer*. The trigger carries
// no origin filter — it fires on any push to the repo and the woken agent
// decides whether the change is relevant (it can `[PASS]`). The Layer-3
// throttle caps runaway wake-ups per branch. No runtime/router change.
//
// Path-level precision is deliberately NOT applied: this also covers the case
// where an agent chose to produce something other than its declared artifact.
//
// Artifacts are matched by their *logical name* (#382), not their physical path:
// an agent instance may write "the Functional Design" to a different path each
// run (or a whole directory, or something it couldn't predict). The path becomes
// an optional `hint`; the real location is resolved at runtime from the git-
// committed artifact manifest (`.agent-studio/artifacts.jsonl`, written via `aee-artifact
// add`). A port with only a `path` (BriefingPack artifacts + legacy team ports)
// still matches by path — unchanged.

// The match key of an artifact port: its logical name if present, else its path.
function artifactKey(a) {
  if (typeof a === 'string') return a;
  return (a && (a.name || a.path)) || '';
}
// The physical hint for a named artifact (informative; path IS the key when
// there is no name).
function artifactHint(a) {
  if (!a || typeof a !== 'object') return '';
  return a.hint || (a.name ? a.path : '') || '';
}
function artifactIsNamed(a) { return !!(a && typeof a === 'object' && a.name); }

// Build the consumer's wake prompt. `artifacts` = [{ key, hint, named }] for the
// one upstream. Named artifacts are resolved from the manifest; path-only
// (legacy/BP) artifacts are named inline; a bare dependency has neither.
function dataFlowPrompt(upstreamName, artifacts) {
  const list = Array.isArray(artifacts) ? artifacts : [];
  const named = list.filter(a => a.named && a.key);
  const legacy = list.filter(a => !a.named && a.key);
  const lines = [
    `Your upstream **${upstreamName}** just pushed to the team repo (the event payload above has the branch and commits).`,
  ];
  if (named.length) {
    const desc = named.map(a => `**${a.key}**${a.hint ? ` (usually under \`${a.hint}\`)` : ''}`).join(', ');
    lines.push(`It may have produced the artifact(s) you consume: ${desc}.`);
    lines.push('The exact path can vary per run, so resolve it from the artifact manifest instead of guessing — run `aee-artifact list "<artifact name>"` (or read `.agent-studio/artifacts.jsonl`) to get the path the upstream registered.');
  } else if (legacy.length) {
    lines.push(`Your declared inputs from it: ${legacy.map(a => `\`${a.key}\``).join(', ')}.`);
  } else {
    lines.push('It is an upstream dependency of yours.');
  }
  lines.push('');
  lines.push('Before you act:');
  lines.push('1. `git fetch`, then check out the pushed branch and `git pull --ff-only` (the ref is in the payload).');
  if (named.length) {
    lines.push('2. Resolve each artifact you need from the manifest and confirm the file/directory is present and complete.');
    lines.push('3. If the upstream pushed but never registered an artifact you expect, don\'t guess a path — tell the user it is missing and stop.');
  } else {
    lines.push('2. Inspect what changed and confirm the inputs you need are present and complete.');
    lines.push('3. If this push does not actually affect your work, reply `[PASS]` — skipping is fine.');
  }
  lines.push('');
  lines.push(named.length
    ? 'Then do your part. When you produce an artifact others depend on, register it so downstream agents can find it: `aee-artifact add "<name>" <path>`. Commit + push so they are notified the same way.'
    : 'Then do your part and commit + push your own outputs so your downstream agents are notified the same way.');
  return lines.join('\n');
}

/**
 * Expand data-flow edges into `push` triggers (materialise time). Returns a NEW
 * bundle; roles without dependencies/inputs are untouched (no-op for catalog
 * teams). `inputs/outputs/dependsOn` stay on the roles (carried to config by
 * templateToCustomRoles for the live graph).
 * @param {object} bundle
 * @param {{ teamId?: string }} [opts] - teamId (accepted for signature parity
 *   with expandGithubChannels; the derived triggers carry no origin filter).
 */
function expandDataFlowSteps(bundle) {
  const roles = (bundle.roles || []).map(r => ({ ...r, triggers: (r.triggers || []).slice() }));
  const byId = new Map(roles.map(r => [r.id, r]));

  // Producers by artifact match key (logical name, else path).
  const producersByKey = new Map();
  for (const r of roles) {
    for (const a of (r.outputs || [])) {
      const k = artifactKey(a);
      if (!k) continue;
      if (!producersByKey.has(k)) producersByKey.set(k, []);
      producersByKey.get(k).push(r.id);
    }
  }

  for (const b of roles) {
    // upstream role id -> Map(key -> {key, hint, named}); empty map = pure
    // dependency edge (ordering only, no artifact).
    const upstream = new Map();
    const ensure = (id) => { if (!upstream.has(id)) upstream.set(id, new Map()); return upstream.get(id); };
    // upstream role id -> authored wake-prompt override (#868). One derived
    // "push from <upstream>" listener aggregates all of that upstream's artifact
    // inputs, so the first non-empty override in insertion order wins the slot.
    const overrides = new Map();

    for (const dep of (b.dependsOn || [])) {
      if (typeof dep === 'string' && dep && dep !== b.id && byId.has(dep)) ensure(dep);
    }
    for (const a of (b.inputs || [])) {
      const k = artifactKey(a);
      if (!k) continue;
      for (const producer of (producersByKey.get(k) || [])) {
        if (producer !== b.id) {
          ensure(producer).set(k, { key: k, hint: artifactHint(a), named: artifactIsNamed(a) });
          const ov = cleanWakePrompt(a && a.wakePrompt);
          if (ov && !overrides.get(producer)) overrides.set(producer, ov);
        }
      }
    }

    for (const [upId, artifacts] of upstream) {
      const triggerId = `${b.id}-on-push-${upId}`;
      if (b.triggers.some(t => t.id === triggerId)) continue; // idempotent
      const list = [...artifacts.values()].sort((x, y) => x.key.localeCompare(y.key));
      b.triggers.push({
        id: triggerId,
        type: 'github-event',
        events: ['push'],
        // Marker so the UI renders this as an agent data-flow dependency (an
        // editable "push from <upstream>" hand-off) rather than a raw push
        // trigger. The poller ignores unknown fields. (#379)
        dataFlow: true,
        // No `claim` (#958): a data-flow step wakes on `push`, not on a label, so
        // there is no wake label to take over. The claim convention applies to
        // LABEL listeners only — asserted by test rather than left implicit.
        enabled: true,
        description: `Data flow: wake on push from ${byId.get(upId)?.displayName || upId}`,
        // Authored override (#868) wins over the generated prompt when present.
        prompt: overrides.get(upId)
          || dataFlowPrompt(byId.get(upId)?.displayName || upId, list),
      });
    }
  }

  return { ...bundle, roles };
}

// Substitute `{{varname}}` placeholders. Unknown vars stay literal so a rogue
// template field doesn't silently disappear into "undefined". Kept local so
// this module stays dependency-free.
function substituteVars(s, vars) {
  if (typeof s !== 'string') return s;
  return s.replace(/\{\{(\w+)\}\}/g, (_m, k) =>
    vars && vars[k] !== undefined ? String(vars[k]) : `{{${k}}}`);
}

/**
 * Build the orchestrator member-create body from a role TEMPLATE, applying
 * per-member `{{var}}` substitution. This is the single source of truth shared
 * by the Team-Setup wizard (POST /api/teams[/stream]) and the Flow Editor's
 * "add role from a template" flow (#586), so both express a template's fields
 * — prompt, sessionPolicy, triggers, and the catalog-v2 declarative ports —
 * identically. Pure; the caller supplies the resolved substitution `vars`
 * (repoFullName, teamName, agentId, readyLabel, …) and the target ids.
 *
 * @param {object} template - a raw agent template ({ promptTemplate, triggers, … })
 * @param {object} opts
 * @param {string} opts.teamId          - owning team agent id (for `<teamId>-<roleId>` refs)
 * @param {string} opts.memberId        - the new member's id
 * @param {string} opts.memberDisplayName - the new member's display name
 * @param {object} opts.vars            - substitution variables
 * @param {boolean} [opts.materialize]  - when defined, passed through to the orchestrator
 * @returns {object} the member-create body for POST /internal/teams/:teamId/members
 */
function buildMemberFromTemplate(template, { teamId, memberId, memberDisplayName, vars, materialize } = {}) {
  const t = template && typeof template === 'object' ? template : {};
  const subst = (s) => substituteVars(s, vars);

  const triggers = (Array.isArray(t.triggers) ? t.triggers : []).map((tr) => {
    const out = {
      id: tr.id,
      type: tr.type,
      enabled: tr.enabled !== false,
      description: tr.description || `${t.displayName} — ${tr.id}`,
      prompt: subst(tr.promptTemplate || ''),
    };
    if (tr.type === 'github-event') {
      out.events = tr.events || [];
      out.repo = vars ? vars.repoFullName : undefined;
      if (typeof tr.labelFilter === 'string' && tr.labelFilter.trim()) {
        out.labelFilter = subst(tr.labelFilter);
      }
      // Claim (#958). Re-derived from the SUBSTITUTED label filter rather than
      // copied: a template's labelFilter may be a `{{var}}`, and the claim has to
      // name the concrete runtime label the entrypoint will swap. Absence of a
      // claim on the template is preserved (an opt-out stays opted out).
      if (tr.claim && out.labelFilter) {
        const c = deriveClaim(out.labelFilter);
        if (c) out.claim = c;
      }
      // Internal-channel transport (#1174): the runtime field the poller
      // exclusion and /internal/flow-emit matching read — must land on the
      // materialised trigger or the listener silently reverts to poller
      // delivery. Suffix/var substitution never touches it (not a label).
      if (tr.transport === 'internal') out.transport = 'internal';
      // Data-flow (agent dependency) marker so the trigger UI renders it as an
      // editable "push from <upstream>" hand-off rather than a raw push (#379).
      if (tr.dataFlow) out.dataFlow = true;
      // GitHub-channel marker (#380) so reconciliation can regenerate it and the
      // graph builders skip it (the on:'github' edge comes from the port).
      if (tr.channel) out.channel = true;
      // Consolidated-listener provenance (#826), informational only.
      if (Array.isArray(tr.sources)) out.sources = tr.sources.slice();
      // Stamp the history horizon (#320/#446) on EVERY github-event trigger so
      // the poller starts a fresh member from "now", not the triggers.json mtime.
      const now = new Date().toISOString();
      out.createdAt = now;
      out.activatedAt = now;
    } else if (tr.type === 'cron') {
      out.cron = tr.cron;
    }
    if (tr.preCheckScript) out.preCheckScript = tr.preCheckScript;
    if (tr.preCheckEnv && typeof tr.preCheckEnv === 'object') {
      out.preCheckEnv = Object.fromEntries(
        Object.entries(tr.preCheckEnv).map(([k, v]) => [k, subst(v)]));
    }
    // Trigger-level `emits` (#328) was removed (#783). Label hand-offs are the
    // template's role-level `emits`, applied to the member config below.
    return out;
  });

  const inputs = Array.isArray(t.inputs) ? t.inputs : [];
  const outputs = Array.isArray(t.outputs) ? t.outputs : [];
  const dependsOn = Array.isArray(t.dependsOn) ? t.dependsOn : [];
  const dataFlow = (inputs.length || outputs.length || dependsOn.length)
    ? {
      ...(inputs.length ? { inputs } : {}),
      ...(outputs.length ? { outputs } : {}),
      // dependsOn role ids → member ids so the live graph connects members.
      ...(dependsOn.length ? { dependsOn: dependsOn.map((d) => `${teamId}-${d}`) } : {}),
    }
    : null;

  return {
    id: memberId,
    displayName: memberDisplayName,
    systemPromptOverride: subst(t.promptTemplate || ''),
    // skillsOverride deliberately omitted — members inherit the team agent's
    // `skills[]` (team-owned grant).
    sessionPolicy: t.sessionPolicy === 'per-invocation' ? 'per-invocation' : undefined,
    triggers,
    // Declarative ports (parity with POST /api/teams): data-flow (#379),
    // hierarchy (#377), agent-level emits, stage band, GitHub ports (#380).
    ...(dataFlow ? { dataFlow } : {}),
    ...(typeof t.parent === 'string' && t.parent ? { parentMemberId: `${teamId}-${t.parent}` } : {}),
    // OUTCOMES port (#827): `{{var}}` substituted inside label/when like trigger
    // fields; supersedes `emits` when present. Only one of the two is carried.
    ...(isAuthoredOutcomes(t.outcomes)
      ? { outcomes: normalizeOutcomes(substituteOutcomes(t.outcomes, subst)) }
      : (Array.isArray(t.emits) && t.emits.length ? { emits: t.emits } : {})),
    ...(typeof t.stage === 'string' && t.stage ? { stage: t.stage } : {}),
    ...(t.github && (t.github.producesPr || t.github.producesIssue) ? { github: t.github } : {}),
    ...(Array.isArray(t.channels) && t.channels.length
      ? { channels: t.channels.map((c) => ({ ...c, from: `${teamId}-${c.from}` })) }
      : {}),
    ...(materialize !== undefined ? { materialize } : {}),
  };
}

module.exports = {
  buildProcessTemplate, validateProcessTemplate, templateToCustomRoles,
  buildMemberFromTemplate, liftTriggerEmits,
  expandGithubChannels, expandDataFlowSteps, normalizeLegacyReview,
  channelTriggerId, isChannelTrigger, stampDerivedActivation,
  outcomesBlock, stripOutcomesBlock, stripDerivedPromptBlocks, applyDerivedPromptBlocks,
  outcomesWiringContext,
  emptyDraftBundle, roleKeyOf, VERSION, normalizeHumans, normalizeHillClimb,
  artifactKey, artifactHint, artifactIsNamed,
  slugifyDraft, deriveUniqueDraftId, cleanWakePrompt,
  // Claim labels (#958) + success mirror (#1163)
  deriveClaim, claimLabelFor, claimError, rawTriggerError, isValidClaim, channelAutoClaim, CLAIM_SUFFIX,
  completedLabelFor, COMPLETED_SUFFIX,
  // Chat-launched loops (#1020)
  launchedLoopConflict,
};
