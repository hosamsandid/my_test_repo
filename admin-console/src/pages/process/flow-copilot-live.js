// flow-copilot-live.js — Flow Copilot on a LIVE team (#2556).
//
// A draft proposal is applied by swapping the whole bundle. A live team has no
// bundle to swap: it is a set of running agent configs. So a live proposal is
// turned into the SAME per-field writes a person makes on the live canvas
// (PUT /api/agents/:id, the trigger routes, POST …/members, DELETE for an
// opted-in removal) — nothing here adds a write path or an authorization rule;
// every step goes through a route that already gates on canManageAgent (AC8).
//
// Pure and node:test-covered (#651 keeps the JSX uncovered): diff → plan →
// run, with the HTTP transport injected.
//
//   diffLiveProposal(live, proposed)      grouped, named change items (AC3/AC14)
//   carryUnauthored(live, proposed)       keep what the copilot cannot author (autoDispatch, hillClimb, pool)
//   planLiveApply(diff, ctx)              ordered write steps + "not applied" (AC6)
//   runLiveApply(plan, call)              sequential, continues past failures (AC7)
//   summarizeLiveApply(diff, result)      what the result message says
//   bundleFingerprint / isStaleBase       the "team changed since" guard (AC15)
//
// Both bundles are PORTABLE (GET /api/process/template?team= is the live side):
// roles are keyed by role key (member id minus the `<teamId>-` prefix) and every
// cross-role reference (dependsOn, parent, channel.from, outcome wakeAgent.to,
// human consume.from) names a role key. `memberIdMap` maps them back.

import { ADD_ROLE_MATERIALIZE_DEFAULT, addRoleMaterializeBody } from './add-role-materialize.js';

// ── shared helpers ───────────────────────────────────────────────────────────

export function stableStringify(x) {
  if (Array.isArray(x)) return `[${x.map(stableStringify).join(',')}]`;
  if (x && typeof x === 'object') {
    return `{${Object.keys(x).sort()
      .filter(k => x[k] !== undefined)
      .map(k => `${JSON.stringify(k)}:${stableStringify(x[k])}`).join(',')}}`;
  }
  return JSON.stringify(x);
}
const same = (a, b) => stableStringify(a) === stableStringify(b);
const arr = (v) => (Array.isArray(v) ? v : []);
const str = (v) => (typeof v === 'string' ? v : '');

/** The inverse of the export's `roleKeyOf` (api/process-template.js). */
export function roleKeyOf(id, teamId) {
  if (teamId && typeof id === 'string' && id.startsWith(`${teamId}-`)) return id.slice(teamId.length + 1);
  return id;
}

/**
 * role key → live member id, from the team's actual member ids. A new role
 * gets the id the live "Add role" path would give it (`<teamId>-<key>`).
 */
export function memberIdMap(teamId, memberIds) {
  const m = new Map();
  for (const id of arr(memberIds)) if (typeof id === 'string' && id) m.set(roleKeyOf(id, teamId), id);
  return (key) => m.get(key) || `${teamId}-${key}`;
}

/**
 * The staleness fingerprint (AC15): the portable export is exactly what the
 * proposal was generated against, so re-exporting just before Apply and
 * comparing tells whether anyone changed the team in between.
 */
export function bundleFingerprint(bundle) {
  if (!bundle || typeof bundle !== 'object') return '';
  // `name`/`level` are presentation — only the team's content counts.
  const { name, level, ...rest } = bundle; // eslint-disable-line no-unused-vars
  return stableStringify(rest);
}

export function isStaleBase(baseBundle, currentBundle) {
  return bundleFingerprint(baseBundle) !== bundleFingerprint(currentBundle);
}

// ── diff ─────────────────────────────────────────────────────────────────────

// Role fields a live edit can write, and what the change list calls them.
// `sessionPolicy` has no live write path (the PUT route does not accept it) and
// `github`/`emits`/`role` are derived or legacy — so they are either reported
// as not applicable or ignored, never silently "applied".
const ROLE_FIELD_LABELS = {
  displayName: 'name',
  systemPrompt: 'prompt',
  outcomes: 'outcomes',
  stage: 'stage',
  dependsOn: 'dependencies',
  inputs: 'inputs',
  outputs: 'outputs',
  parent: 'parent',
  channels: 'PR/issue channels',
  pool: 'pooling',
  triggers: 'triggers',
  sessionPolicy: 'session policy',
};
const LIVE_ROLE_FIELDS = Object.keys(ROLE_FIELD_LABELS).filter(f => f !== 'triggers' && f !== 'sessionPolicy');

// Derived listeners are regenerated from the ports on every write, so they are
// never diffed (the export already drops channel/wake-handoff ones).
const authoredTriggers = (r) => arr(r && r.triggers).filter(t => t && typeof t === 'object' && !t.dataFlow && !t.channel);
// A trigger still carrying a `{{var}}` placeholder is a template artifact: the
// live create path substitutes nothing, so writing it would store the braces.
const hasPlaceholder = (t) => /\{\{[^}]*\}\}/.test(JSON.stringify(t));

function fieldValue(role, f) {
  const v = role ? role[f] : undefined;
  if (f === 'systemPrompt') return str(v).trim();
  if (f === 'sessionPolicy') return str(v) || 'persistent';
  if (['dependsOn', 'inputs', 'outputs', 'channels'].includes(f)) return arr(v);
  return v === undefined || v === '' ? null : v;
}

// The trigger PUT route merges the body over the stored trigger
// (`{ ...prev, ...body }`), so a key the proposal DROPS from an existing
// trigger (labelFilter, claim, transport, prompt, …) is never cleared. Such a
// trigger only counts as changed when the merged result differs, and the
// dropped keys are reported as not applied (`dropped`) instead of claimed.
// Exception: a key the route clears on an explicit `null` (CLEARABLE) is sent
// as null — a dropped readiness gate is the Copilot switching it off (#2915),
// the same write the trigger dialog makes.
const CLEARABLE_TRIGGER_KEYS = ['readinessGate'];
function triggerChanges(before, after) {
  const b = new Map(authoredTriggers(before).map(t => [t.id, t]));
  const a = new Map(authoredTriggers(after).map(t => [t.id, t]));
  const out = { added: [], changed: [], removed: [], dropped: [] };
  for (const [id, t] of a) {
    if (!b.has(id)) { out.added.push(t); continue; }
    const prev = b.get(id);
    const cleared = CLEARABLE_TRIGGER_KEYS.filter(k => prev[k] !== undefined && t[k] === undefined);
    const body = cleared.length ? { ...t, ...Object.fromEntries(cleared.map(k => [k, null])) } : t;
    if (!same(prev, { ...prev, ...body })) out.changed.push(body);
    const keys = Object.keys(prev).filter(k => prev[k] !== undefined && t[k] === undefined && !cleared.includes(k));
    if (keys.length) out.dropped.push({ id, keys });
  }
  for (const [id, t] of b) if (!a.has(id)) out.removed.push(t);
  return out;
}

// Fields the copilot cannot author: its sanitizer (api/flow-copilot.js
// BUNDLE_KEYS / ROLE_KEYS) strips them from every proposal, so their absence
// there means "not expressed", never "removed". Carrying the live value over
// keeps a copilot turn from switching off the Flow Supervisor, flagging the
// hill-climb collector, or un-pooling a role.
const UNAUTHORED_TEAM_KEYS = ['autoDispatch', 'hillClimb'];
const UNAUTHORED_ROLE_KEYS = ['pool'];

export function carryUnauthored(live, proposed) {
  const L = live || {};
  const P = { ...(proposed || {}) };
  for (const k of UNAUTHORED_TEAM_KEYS) if (P[k] === undefined && L[k] !== undefined) P[k] = L[k];
  if (Array.isArray(P.roles)) {
    const lr = new Map(arr(L.roles).filter(r => r && r.id).map(r => [r.id, r]));
    P.roles = P.roles.map((r) => {
      const before = r && lr.get(r.id);
      if (!before) return r;
      const out = { ...r };
      for (const k of UNAUTHORED_ROLE_KEYS) if (out[k] === undefined && before[k] !== undefined) out[k] = before[k];
      return out;
    });
  }
  return P;
}

const gateLabels = (b) => new Set(arr(b && b.labels).filter(l => l && l.humanGate).map(l => l.name));

/**
 * Grouped change items for a live team (AC3). Each item names its entity and
 * says whether it can be applied live; removals of a role or human are their
 * own opt-in items (AC14).
 *
 * @returns {{ items: object[], live: object, proposed: object }}
 *   item: { key, group: 'added'|'changed'|'removed', entity, id, name,
 *           fields?: string[], applicable, reason?, removal?, gate? }
 */
export function diffLiveProposal(live, proposed) {
  const L = live || {};
  const P = carryUnauthored(L, proposed);
  const items = [];
  const push = (it) => items.push({ applicable: true, ...it, key: `${it.entity}:${it.group}:${it.id}` });

  // Roles.
  const lr = new Map(arr(L.roles).filter(r => r && r.id).map(r => [r.id, r]));
  const pr = new Map(arr(P.roles).filter(r => r && r.id).map(r => [r.id, r]));
  for (const [id, r] of pr) {
    const name = r.displayName || id;
    if (!lr.has(id)) {
      const blocked = authoredTriggers(r).filter(hasPlaceholder);
      push({
        group: 'added', entity: 'role', id, name,
        ...(blocked.length ? { note: `${blocked.length} trigger(s) with {{placeholders}} are not created` } : {}),
      });
      continue;
    }
    const before = lr.get(id);
    const fields = LIVE_ROLE_FIELDS.filter(f => !same(fieldValue(before, f), fieldValue(r, f)));
    const tc = triggerChanges(before, r);
    if (tc.added.length || tc.changed.length || tc.removed.length) fields.push('triggers');
    if (fields.length) push({ group: 'changed', entity: 'role', id, name, fields: fields.map(f => ROLE_FIELD_LABELS[f]) });
    if (tc.dropped.length) {
      push({
        group: 'changed', entity: 'role', id: `${id}#triggerSettings`, name, fields: ['triggers'],
        applicable: false,
        reason: `removing a trigger setting is not supported on a live team (${tc.dropped.map(d => `${d.keys.join(', ')} on ${d.id}`).join('; ')}) — edit the trigger in the Triggers tab`,
      });
    }
    if (fieldValue(before, 'sessionPolicy') !== fieldValue(r, 'sessionPolicy')) {
      push({
        group: 'changed', entity: 'role', id: `${id}#sessionPolicy`, name, fields: ['session policy'],
        applicable: false, reason: 'the session policy of a running agent cannot be changed from the canvas',
      });
    }
  }
  for (const [id, r] of lr) {
    if (!pr.has(id)) push({ group: 'removed', entity: 'role', id, name: r.displayName || id, removal: true });
  }

  // Humans.
  const lh = new Map(arr(L.humans).filter(h => h && h.id).map(h => [h.id, h]));
  const ph = new Map(arr(P.humans).filter(h => h && h.id).map(h => [h.id, h]));
  for (const [id, h] of ph) {
    if (!lh.has(id)) push({ group: 'added', entity: 'human', id, name: h.name || id });
    else if (!same(lh.get(id), h)) push({ group: 'changed', entity: 'human', id, name: h.name || id });
  }
  for (const [id, h] of lh) {
    if (!ph.has(id)) push({ group: 'removed', entity: 'human', id, name: h.name || id, removal: true });
  }

  // Stages: one item per added/removed stage, plus the order when only that moved.
  const ls = arr(L.stages);
  const ps = arr(P.stages);
  for (const s of ps) if (!ls.includes(s)) push({ group: 'added', entity: 'stage', id: s, name: s });
  for (const s of ls) if (!ps.includes(s)) push({ group: 'removed', entity: 'stage', id: s, name: s });
  const commonL = ls.filter(s => ps.includes(s));
  const commonP = ps.filter(s => ls.includes(s));
  if (!same(commonL, commonP)) push({ group: 'changed', entity: 'stage', id: '(order)', name: 'stage order' });

  // Labels (the gate/brake registry). Anything touching a human gate is flagged.
  const ll = new Map(arr(L.labels).filter(l => l && l.name).map(l => [l.name, l]));
  const pl = new Map(arr(P.labels).filter(l => l && l.name).map(l => [l.name, l]));
  const lg = gateLabels(L);
  const pg = gateLabels(P);
  for (const [n, l] of pl) {
    const gate = lg.has(n) || pg.has(n);
    if (!ll.has(n)) push({ group: 'added', entity: 'label', id: n, name: n, ...(gate ? { gate: true } : {}) });
    else if (!same({ g: !!ll.get(n).humanGate, b: !!ll.get(n).brake }, { g: !!l.humanGate, b: !!l.brake })) {
      push({ group: 'changed', entity: 'label', id: n, name: n, ...(gate ? { gate: true } : {}) });
    }
  }
  for (const [n] of ll) {
    if (!pl.has(n)) push({ group: 'removed', entity: 'label', id: n, name: n, ...(lg.has(n) ? { gate: true } : {}) });
  }

  // Team-level settings.
  if (!same(L.wipLimit ?? null, P.wipLimit ?? null)) push({ group: 'changed', entity: 'team', id: 'wipLimit', name: 'WIP limit' });
  if (!same(L.autoDispatch ?? null, P.autoDispatch ?? null)) push({ group: 'changed', entity: 'team', id: 'autoDispatch', name: 'Flow Supervisor' });
  if (str(P.name) && str(L.name) && P.name !== L.name) {
    push({ group: 'changed', entity: 'team', id: 'name', name: 'team name', applicable: false, reason: 'rename the team in its settings' });
  }
  if (!same(L.hillClimb ?? null, P.hillClimb ?? null)) {
    push({ group: 'changed', entity: 'team', id: 'hillClimb', name: 'hill-climb collector', applicable: false, reason: 'configure it in the team settings' });
  }

  return { items, live: L, proposed: P };
}

/** Items grouped for display, in the fixed added → changed → removed order. */
export function groupItems(items) {
  const out = { added: [], changed: [], removed: [] };
  for (const it of arr(items)) if (out[it.group]) out[it.group].push(it);
  return out;
}

const ENTITY_NOUN = { role: 'Agent', human: 'Human', stage: 'Stage', label: 'Label', team: 'Team' };

/** One human-readable line for a change item. */
export function describeLiveItem(it) {
  const noun = ENTITY_NOUN[it.entity] || it.entity;
  const verb = it.group === 'added' ? 'added' : it.group === 'removed' ? 'removed' : 'changed';
  if (it.entity === 'team') return `${it.name} ${verb}`;
  if (it.entity === 'stage' && it.id === '(order)') return 'Stage order changed';
  const fields = Array.isArray(it.fields) && it.fields.length ? ` (${it.fields.join(', ')})` : '';
  const note = it.note ? ` — ${it.note}` : '';
  return `${noun} “${it.name}” ${verb}${fields}${note}`;
}

// ── plan ─────────────────────────────────────────────────────────────────────

const mapOutcomes = (o, toMember) => {
  if (!o || typeof o !== 'object' || !Array.isArray(o.options)) return o;
  return {
    ...o,
    options: o.options.map(opt => ({
      ...opt,
      actions: arr(opt && opt.actions).map(a => (a && a.type === 'wakeAgent' && typeof a.to === 'string' && a.to
        ? { ...a, to: toMember(a.to) } : a)),
    })),
  };
};
const mapChannels = (cs, toMember) => arr(cs).map(c => ({ ...c, from: toMember(c.from) }));
const mapHumans = (hs, toMember) => arr(hs).map(h => (Array.isArray(h.consumes)
  ? { ...h, consumes: h.consumes.map(c => (c && typeof c.from === 'string' && c.from ? { ...c, from: toMember(c.from) } : c)) }
  : h));

// The member-config PUT body for the role fields that differ.
function rolePortBody(before, after, toMember) {
  const body = {};
  const differs = (f) => !same(fieldValue(before, f), fieldValue(after, f));
  if (differs('displayName')) body.displayName = after.displayName || after.id;
  // A live member's prompt edit is its own ("exclusive") prompt — the same
  // write the node inspector's prompt field makes.
  if (differs('systemPrompt')) {
    body.promptMode = 'exclusive';
    body.systemPrompt = str(after.systemPrompt);
  }
  if (differs('outcomes')) body.outcomes = after.outcomes ? mapOutcomes(after.outcomes, toMember) : null;
  if (differs('stage')) body.stage = str(after.stage);
  if (differs('dependsOn') || differs('inputs') || differs('outputs')) {
    body.dataFlow = {
      inputs: arr(after.inputs), outputs: arr(after.outputs),
      dependsOn: arr(after.dependsOn).map(toMember),
    };
  }
  if (differs('parent')) body.parentMemberId = after.parent ? toMember(after.parent) : null;
  if (differs('channels')) body.channels = mapChannels(after.channels, toMember);
  if (differs('pool')) body.pool = after.pool || null;
  return body;
}

function triggerSteps(memberId, before, after, itemKey) {
  const tc = triggerChanges(before, after);
  const steps = [];
  for (const t of tc.added.filter(t => !hasPlaceholder(t))) {
    steps.push({ op: 'createTrigger', memberId, body: t, itemKeys: [itemKey], label: `create trigger ${t.id}` });
  }
  for (const t of tc.changed.filter(t => !hasPlaceholder(t))) {
    steps.push({ op: 'api', method: 'PUT', url: `/api/agents/${memberId}/triggers/${t.id}`, body: t, itemKeys: [itemKey], label: `update trigger ${t.id}` });
  }
  for (const t of tc.removed) {
    steps.push({ op: 'api', method: 'DELETE', url: `/api/agents/${memberId}/triggers/${t.id}`, itemKeys: [itemKey], label: `delete trigger ${t.id}` });
  }
  return steps;
}

/**
 * Turn a diff into ordered write steps. Order matters on a live team:
 *   1. team registry (stages, labels, WIP limit) — members and pools read them
 *   2. create new members (id + name + prompt), then
 *   3. wire every new/changed member's ports — after ALL creations, so a port
 *      may name a member created in the same apply
 *   4. humans (their consumes name members, which the server prunes if absent)
 *   5. the Flow Supervisor opt-in (needs a pooled member)
 *   6. opted-in removals last (AC14) — nothing added above depends on them
 *
 * @param diff  diffLiveProposal() result
 * @param ctx   { teamId, memberIds, selectedRemovals: Set<itemKey> | string[],
 *                materializeNow?: boolean — new agents are stubs unless true }
 * @returns {{ steps: object[], notApplied: object[], skippedRemovals: object[] }}
 */
export function planLiveApply(diff, { teamId, memberIds, selectedRemovals, materializeNow = ADD_ROLE_MATERIALIZE_DEFAULT } = {}) {
  const { items, live, proposed } = diff;
  const picked = new Set(selectedRemovals || []);
  const toMember = memberIdMap(teamId, memberIds);
  const steps = [];
  const notApplied = items.filter(it => !it.applicable);
  const skippedRemovals = items.filter(it => it.removal && !picked.has(it.key));
  const keysOf = (entity) => items.filter(it => it.entity === entity && it.applicable).map(it => it.key);
  const teamUrl = `/api/agents/${teamId}`;

  // 1. team registry
  const stageKeys = keysOf('stage');
  if (stageKeys.length) steps.push({ op: 'api', method: 'PUT', url: teamUrl, body: { stages: arr(proposed.stages) }, itemKeys: stageKeys, label: 'stages' });
  const labelKeys = keysOf('label');
  if (labelKeys.length) {
    steps.push({
      op: 'api', method: 'PUT', url: teamUrl,
      body: { labels: arr(proposed.labels).map(l => ({ name: l.name, ...(l.humanGate ? { humanGate: true } : {}), ...(l.brake ? { brake: true } : {}) })) },
      itemKeys: labelKeys, label: 'labels',
    });
  }
  const wip = items.find(it => it.entity === 'team' && it.id === 'wipLimit');
  if (wip) steps.push({ op: 'api', method: 'PUT', url: teamUrl, body: { wipLimit: proposed.wipLimit ?? null }, itemKeys: [wip.key], label: 'WIP limit' });

  // 2 + 3. roles
  const lr = new Map(arr(live.roles).map(r => [r.id, r]));
  const pr = new Map(arr(proposed.roles).map(r => [r.id, r]));
  const roleItems = items.filter(it => it.entity === 'role' && it.applicable && !it.removal);
  const created = roleItems.filter(it => it.group === 'added');
  for (const it of created) {
    const r = pr.get(it.id);
    steps.push({
      op: 'api', method: 'POST', url: `/api/agents/${teamId}/members`,
      body: {
        id: toMember(it.id), displayName: r.displayName || it.id,
        ...(str(r.systemPrompt).trim() ? { systemPromptOverride: r.systemPrompt } : {}),
        ...(r.sessionPolicy ? { sessionPolicy: r.sessionPolicy } : {}),
        // Stub or provision now — the flow editor's Add-agent choice (#2558),
        // always explicit because the route's default is materialize-now.
        ...addRoleMaterializeBody({ materializeNow }),
      },
      itemKeys: [it.key], label: `create ${r.displayName || it.id}`,
    });
  }
  for (const it of roleItems) {
    const after = pr.get(it.id);
    // A new member was just created with name + prompt; wire the rest.
    const before = it.group === 'added'
      ? { id: it.id, displayName: after.displayName || it.id, systemPrompt: after.systemPrompt }
      : lr.get(it.id);
    const memberId = toMember(it.id);
    const body = rolePortBody(before, after, toMember);
    if (Object.keys(body).length) {
      steps.push({ op: 'api', method: 'PUT', url: `/api/agents/${memberId}`, body, itemKeys: [it.key], label: `update ${after.displayName || it.id}` });
    }
    steps.push(...triggerSteps(memberId, it.group === 'added' ? {} : before, after, it.key));
  }

  // 4. humans — the proposal's set, plus every live human whose removal was NOT
  // ticked (AC14: an unticked removal keeps the human).
  const humanItems = items.filter(it => it.entity === 'human' && (!it.removal || picked.has(it.key)));
  if (humanItems.length) {
    const keep = arr(live.humans).filter(h => !arr(proposed.humans).some(p => p.id === h.id)
      && !picked.has(`human:removed:${h.id}`));
    steps.push({
      op: 'api', method: 'PUT', url: teamUrl,
      body: { humans: mapHumans([...arr(proposed.humans), ...keep], toMember) },
      itemKeys: humanItems.map(it => it.key), label: 'humans',
    });
  }

  // 5. supervisor opt-in
  const sup = items.find(it => it.entity === 'team' && it.id === 'autoDispatch');
  if (sup) steps.push({ op: 'api', method: 'PUT', url: teamUrl, body: { autoDispatch: proposed.autoDispatch ?? null }, itemKeys: [sup.key], label: 'Flow Supervisor' });

  // 6. opted-in agent removals
  for (const it of items.filter(i => i.entity === 'role' && i.removal && picked.has(i.key))) {
    steps.push({ op: 'api', method: 'DELETE', url: `/api/agents/${toMember(it.id)}`, itemKeys: [it.key], label: `remove ${it.name}` });
  }

  return { steps, notApplied, skippedRemovals };
}

// ── run ──────────────────────────────────────────────────────────────────────

/**
 * Run the steps in order. A failed step does not stop the rest (AC7: the user
 * sees which changes landed and which did not). An item counts as applied only
 * when every step it owns succeeded.
 *
 * @param plan  planLiveApply() result
 * @param call  async (step) => void — the transport (throws on failure)
 * @returns {{ applied: string[], failed: {key, error}[], notApplied, skippedRemovals }}
 */
export async function runLiveApply(plan, call) {
  const failedBy = new Map();
  const touched = new Set();
  for (const step of plan.steps) {
    for (const k of step.itemKeys) touched.add(k);
    try {
      await call(step);
    } catch (e) {
      const msg = (e && e.message) || 'request failed';
      for (const k of step.itemKeys) if (!failedBy.has(k)) failedBy.set(k, `${step.label}: ${msg}`);
    }
  }
  return {
    applied: [...touched].filter(k => !failedBy.has(k)),
    failed: [...failedBy].map(([key, error]) => ({ key, error })),
    notApplied: plan.notApplied,
    skippedRemovals: plan.skippedRemovals,
  };
}

/**
 * The result message (AC6/AC7). `ok` is true only when nothing failed — the
 * panel must never claim success on a partial apply.
 */
export function summarizeLiveApply(diff, result) {
  const byKey = new Map(arr(diff && diff.items).map(it => [it.key, it]));
  const line = (k) => (byKey.get(k) ? describeLiveItem(byKey.get(k)) : k);
  const applied = arr(result.applied).map(line);
  const failed = arr(result.failed).map(f => `${line(f.key)} — ${f.error}`);
  const notApplied = arr(result.notApplied).map(it => `${describeLiveItem(it)}${it.reason ? ` — ${it.reason}` : ''}`);
  const kept = arr(result.skippedRemovals).map(it => `${describeLiveItem(it)} — kept (not ticked)`);
  const ok = failed.length === 0;
  const headline = !ok
    ? (applied.length ? `Partly applied: ${applied.length} change(s) applied, ${failed.length} failed.` : `Nothing was applied: ${failed.length} change(s) failed.`)
    : applied.length ? `Applied ${applied.length} change(s) to the live team.` : 'Nothing to apply.';
  const parts = [headline];
  if (applied.length) parts.push(`Applied:\n${applied.map(s => `- ${s}`).join('\n')}`);
  if (failed.length) parts.push(`Failed:\n${failed.map(s => `- ${s}`).join('\n')}`);
  if (notApplied.length) parts.push(`Not applied (not supported on a live team):\n${notApplied.map(s => `- ${s}`).join('\n')}`);
  if (kept.length) parts.push(`Left in place:\n${kept.map(s => `- ${s}`).join('\n')}`);
  return { ok, applied, failed, notApplied, kept, text: parts.join('\n\n') };
}

// ── in-progress work for a removal (AC14) ────────────────────────────────────

/**
 * Open ledger rows owned by a member (GET /api/teams/:id/tickets). Returns
 * null when the ledger could not be read — "unknown", which the dialog says,
 * rather than a false "no work".
 */
export function inProgressFor(tickets, memberId) {
  if (!Array.isArray(tickets)) return null;
  return tickets
    .filter(t => t && t.ownerAgentId === memberId && t.state !== 'done')
    .map(t => ({
      label: `${t.kind === 'pr' ? 'PR' : 'Issue'} #${t.number}${t.title ? ` ${t.title}` : ''}`,
      url: typeof t.url === 'string' ? t.url : '',
      openPr: !!(t.prNumber && t.prState !== 'merged' && t.prState !== 'closed'),
    }));
}

/**
 * Gate warnings for the confirmation (edge case): any item touching a
 * human-gate label, which a person applies and agents must never set.
 */
export function gateWarnings(items) {
  return arr(items).filter(it => it.gate).map(describeLiveItem);
}

/** New agents a live apply adds are stubs unless the user opts in (#2558's default). */
export const NEW_AGENTS_NOW_DEFAULT = ADD_ROLE_MATERIALIZE_DEFAULT;

// ── confirmation + card view-model (AC4/AC6/AC14) ────────────────────────────

/**
 * Everything the Apply confirmation shows, derived once: the applicable
 * changes grouped (removals excluded — each is its own opt-in row), the
 * removal rows with the member's in-progress work (null = the ledger could not
 * be read), what will NOT be applied, and gate warnings.
 *
 * @param diff     diffLiveProposal() result
 * @param opts     { teamId, memberIds, tickets } — tickets as returned by
 *                 GET /api/teams/:id/tickets, or null when unreadable
 */
export function liveConfirmModel(diff, { teamId, memberIds, tickets } = {}) {
  const items = arr(diff && diff.items);
  const toMember = memberIdMap(teamId, memberIds);
  const applicable = items.filter(it => it.applicable && !it.removal);
  const removals = items.filter(it => it.applicable && it.removal).map(it => ({
    key: it.key,
    label: describeLiveItem(it),
    // Only an agent owns ledger work; a named human role never does.
    inProgress: it.entity === 'role' ? inProgressFor(tickets, toMember(it.id)) : [],
  }));
  const notApplied = items.filter(it => !it.applicable)
    .map(it => `${describeLiveItem(it)}${it.reason ? ` — ${it.reason}` : ''}`);
  const notes = items.filter(it => it.note).map(it => `${describeLiveItem(it)}: ${it.note}`);
  return {
    groups: groupItems(applicable),
    removals,
    notApplied,
    notes,
    gates: gateWarnings(items),
    empty: applicable.length === 0 && removals.length === 0,
  };
}

/**
 * The committed card's status after an apply — 'applied' only when nothing
 * failed; 'partial' when some changes landed and some failed; 'failed' when
 * nothing landed (AC7: never claim success on a partial apply).
 */
export function liveResultStatus(summary) {
  if (!summary || summary.ok) return 'applied';
  return arr(summary.applied).length ? 'partial' : 'failed';
}
