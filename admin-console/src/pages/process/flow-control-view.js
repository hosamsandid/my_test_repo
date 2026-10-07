// Pure view helpers for the Flow Control board (#2573, concept
// `docs/flow-control-concept.md` Amendment 3). Dependency-free so it
// unit-tests under `node --test` in the `admin-console-src` job — the JSX page
// cannot be imported there (#651).
//
// The board answers one question — who is working on what, and where does a
// person have to step in. Every decision (which items appear, the stages, the
// row's position, the human-block reason) is made server-side by
// `orchestrator/flow-board.js`; this module only turns that response into
// display strings. It never reads a GitHub label.
//
// Input is the `GET /api/teams/:teamId/flow-board` response:
//   { stages[{id,label,roles}], rows[], needsHuman[], sessions[], pools[],
//     held[], removed[], config, canManage, generatedAt, stale, warning,
//     maintenance }

import { absoluteWhen } from '../../components/format-when.js';
import { eventLogHref } from '../github-event-focus.js';

// ---------------------------------------------------------------------------
// Durations
// ---------------------------------------------------------------------------

// "4m", "3h 10m", "2d 5h" — compact enough for a table cell, precise enough
// that two rows can be compared at a glance.
export function formatDuration(ms) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '';
  const min = Math.floor(ms / 60000);
  if (min < 1) return 'under 1m';
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 24) return min % 60 ? `${h}h ${min % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

// Time elapsed since an ISO timestamp, or '' when it is missing or unparseable.
export function since(iso, now = Date.now()) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return '';
  return formatDuration(Math.max(0, now - t));
}

// The header's "Updated 12s ago". Seconds matter here: with a 30 s refresh the
// operator wants to see the counter reset.
export function updatedAgo(iso, now = Date.now()) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 5) return 'Updated just now';
  if (s < 60) return `Updated ${s}s ago`;
  return `Updated ${formatDuration(s * 1000)} ago`;
}

// ---------------------------------------------------------------------------
// Work items
// ---------------------------------------------------------------------------

// `o/r#12` → `#12` when the whole board is one repository; the full ref
// otherwise, so two repos' #12 never read the same.
export function itemRef(repo, number, singleRepo) {
  if (number == null) return '';
  return singleRepo || !repo ? `#${number}` : `${repo}#${number}`;
}

// The board's leading Issue and Pull request columns (#2800). An empty cell
// is a placeholder with an explanation: neutral for "no PR yet" (the work is
// still at issue level), warning-toned for "no linked issue" (a PR an agent
// opened on its own), so the two never read alike.
export const NO_PR_TEXT = 'No pull request yet';
export const NO_ISSUE_TEXT = 'No linked issue';

export function issueCell(issue, fallbackUrl, singleRepo) {
  if (!issue) return { text: '—', url: null, title: NO_ISSUE_TEXT, empty: 'missing' };
  return { text: itemRef(issue.repo, issue.number, singleRepo), url: issue.url || fallbackUrl || null, title: '', empty: null };
}

// One entry per PR, in the order the backend delivers them. The number has no
// `PR` prefix — the column header says it.
function prCells(prs, singleRepo) {
  return (Array.isArray(prs) ? prs : []).map((p) => {
    const state = p.state || 'open';
    return {
      key: `${p.repo}#${p.number}`,
      text: `${itemRef(p.repo, p.number, singleRepo)}${state === 'merged' ? ' (merged)' : ''}`,
      url: p.url || null,
      state,
      struck: state === 'closed',
    };
  });
}

export function prEmptyCell(prs) {
  return Array.isArray(prs) && prs.length ? null : { text: '—', title: NO_PR_TEXT, empty: 'pending' };
}

// `draft` is stage 0: nobody released the item yet and no agent is on it, so
// the sub-label says a person has to act (#2637) — never "released".
const STATUS_TEXT = {
  working: 'working',
  queued: 'up next',
  idle: 'waiting',
  draft: 'awaiting release',
  done: 'done',
};

// Hover text for a done row's "In stage" value: the absolute completion time
// in the viewer's local time zone (#2643). '' when the row is not done or has
// no usable timestamp, so the cell then carries no tooltip either.
export function doneTitle(row) {
  if (!row || !row.done) return '';
  const when = absoluteWhen(row.since);
  return when ? `Finished ${when}` : '';
}

// ---------------------------------------------------------------------------
// Jump to the working agent's chat (#2723)
// ---------------------------------------------------------------------------

// The pool item a `<template>-i<item>` instance id encodes, or null — the same
// shape `orchestrator/flow-board.js` reads.
export function instanceOf(agentId) {
  const m = /-i(\d+)$/.exec(typeof agentId === 'string' ? agentId : '');
  return m ? Number(m[1]) : null;
}

// The in-console link to the chat of the agent running right now, or null.
// `agentId` is the exact runner — for a pooled role its instance, never the
// template — so a row that is `working` only by a claim label (no session,
// `agentId` null) gets no link. `name` is the role's display name.
export function chatLink(agentId, name, instance = instanceOf(agentId)) {
  if (typeof agentId !== 'string' || !agentId) return null;
  const who = `${name || agentId}${instance != null ? ` #${instance}` : ''}`;
  return { to: `/chats/${encodeURIComponent(agentId)}`, label: `Open chat with ${who}` };
}

// Hover and keyboard-focus affordance for those links; inline styles cannot
// express `:hover`/`:focus-visible`, so `FlowControl.jsx` mounts this once.
export const CHAT_LINK_CLASS = 'flow-control-chat-link';
export const CHAT_LINK_CSS = `
.${CHAT_LINK_CLASS} { color: inherit; text-decoration: none; border-radius: var(--eb-radius-sm, 4px); }
.${CHAT_LINK_CLASS}:hover { text-decoration: underline; color: var(--eb-accent-primary); }
.${CHAT_LINK_CLASS}:focus-visible { outline: 2px solid var(--eb-accent-primary); outline-offset: 2px; }
`.trim();

// One board row: title, links, the progress steps and the current stage with
// its time in stage. For a done row `since` is the completion time, so "in
// stage" reads "in Done since" (#2643). `stages` is the board's own stage list, so the step count
// is exactly the team's hand-off chain.
// #2795: a PR hand-off held by its readiness gate — "waiting for CI" on the
// row, so a hand-off that has not reached the next agent yet is not mistaken
// for one that is lost. `waitingFor` empty = verdicts are in, resolving.
const GATE_WAIT = { ci: 'CI', conflict: 'conflict-free' };

export function gateHoldText(gateHold) {
  if (!gateHold || typeof gateHold !== 'object') return '';
  const w = (Array.isArray(gateHold.waitingFor) ? gateHold.waitingFor : []).map(g => GATE_WAIT[g]).filter(Boolean);
  return w.length ? `waiting for ${w.join(' / ')}` : 'hand-off gate resolving';
}

export function gateHoldTitle(gateHold, { now = Date.now() } = {}) {
  if (!gateHold || typeof gateHold !== 'object') return '';
  const pr = Number.isInteger(gateHold.number) ? `PR #${gateHold.number}` : 'The PR';
  const held = since(gateHold.since, now);
  return `${pr}'s hand-off is held until the PR is green and conflict-free${held ? ` (held ${held})` : ''}. The next agent is woken then; a failure or timeout is labelled and commented on the PR.`;
}

// ---------------------------------------------------------------------------
// PR hand-off gates (#2914)
// ---------------------------------------------------------------------------

// Whether a PR hand-off waits before it wakes its agent: "waits for CI",
// "waits for conflict-free", "waits for CI + conflict-free" or "not gated".
export function handoffGateText(h) {
  const what = [h && h.ci ? 'CI' : null, h && h.conflict ? 'conflict-free' : null].filter(Boolean);
  return what.length ? `waits for ${what.join(' + ')}` : 'not gated';
}

// Where the gate is changed, or null when the viewer may not change it (AC4):
// a flow-derived hand-off in the Flow Editor (the receiving node's routing
// tab), a raw trigger in Agent Chat → Triggers (its edit form).
export function handoffEditLink(h, { teamId = null, canManage = false } = {}) {
  if (!canManage || !h || typeof h.agentId !== 'string' || !h.agentId) return null;
  const agent = encodeURIComponent(h.agentId);
  if (h.flowManaged) {
    if (!teamId) return null;
    return { to: `/flows?proc=${encodeURIComponent(teamId)}&node=${agent}&tab=routing`, label: `Change in the Flow Editor (${h.to || h.agentId})` };
  }
  if (typeof h.triggerId !== 'string' || !h.triggerId) return null;
  return { to: `/chats/${agent}?rail=triggers&trigger=${encodeURIComponent(h.triggerId)}`, label: `Change in Agent Chat → Triggers (${h.to || h.agentId})` };
}

function handoffWake(h) {
  return h.label ? `the label ${h.label} is set` : 'the PR is opened';
}

// One line of the board's "Hand-off gates" list.
export function handoffView(h, opts = {}) {
  const gated = !!(h.ci || h.conflict);
  const from = Array.isArray(h.from) && h.from.length ? h.from.join(' / ') : 'A person';
  const to = h.to || h.agentId;
  return {
    id: h.id,
    from,
    to,
    label: h.label || null,
    gated,
    text: handoffGateText(h),
    title: gated
      ? `${to} is woken once ${handoffWake(h)} and the PR is ${[h.ci ? 'green' : null, h.conflict ? 'conflict-free' : null].filter(Boolean).join(' and ')}.`
      : `${to} is woken as soon as ${handoffWake(h)} — even while CI is running or the PR conflicts with its base.`,
    edit: handoffEditLink(h, opts),
  };
}

// The row hint for a PR parked behind an ungated hand-off (AC2), or null.
export const UNGATED_TEXT = 'hand-off not gated';

export function ungatedView(u, opts = {}) {
  if (!u || typeof u !== 'object') return null;
  return {
    text: UNGATED_TEXT,
    title: `The hand-off to ${u.to || u.agentId}${u.label ? ` (${u.label})` : ''} does not wait for CI or a conflict-free PR — the PR was handed on as it was.`,
    edit: handoffEditLink(u, opts),
  };
}

export function rowView(row, stages, { now = Date.now(), singleRepo = true, teamId = null, canManage = false } = {}) {
  const list = Array.isArray(stages) ? stages : [];
  const current = Number.isInteger(row.stageIndex) ? row.stageIndex : list.findIndex((s) => s.id === row.stageId);
  const steps = list.map((s, i) => ({
    id: s.id,
    label: s.label,
    state: i < current || row.done ? 'past' : i === current ? 'current' : 'future',
  }));
  const stage = list[current] || null;
  return {
    id: row.id,
    title: row.title || '(untitled)',
    url: row.url || null,
    ref: row.issue ? itemRef(row.issue.repo, row.issue.number, singleRepo) : '',
    issue: issueCell(row.issue, row.url, singleRepo),
    prs: prCells(row.prs, singleRepo),
    prEmpty: prEmptyCell(row.prs),
    steps,
    stageLabel: stage ? stage.label : '',
    status: row.status,
    statusText: STATUS_TEXT[row.status] || '',
    agentId: row.agentId || null,
    chat: row.status === 'working' ? chatLink(row.agentId, row.roleLabel || (stage && stage.label)) : null,
    inStage: since(row.since, now),
    inStageTitle: doneTitle(row),
    done: !!row.done,
    blocked: !!row.needsHuman,
    removable: !!row.removable,
    gateText: gateHoldText(row.gateHold),
    gateTitle: gateHoldTitle(row.gateHold, { now }),
    ungated: ungatedView(row.ungatedHandoff, { teamId, canManage }),
  };
}

// ---------------------------------------------------------------------------
// Remove from board (#2637)
// ---------------------------------------------------------------------------

// Said before anything is removed: only the board entry goes, the GitHub item
// stays as it is. `help-topics/flow-control.md` quotes the same promise.
export const REMOVE_CONFIRM_TEXT = 'Only the board entry is removed — the GitHub ticket stays unchanged. The item comes back on its own as soon as the flow picks it up again, and you can restore it from Removed at any time.';

export function removeDialogTitle(ref) {
  return ref ? `Remove ${ref} from the board?` : 'Remove this item from the board?';
}

export function removedView(entry, { now = Date.now(), singleRepo = true } = {}) {
  const ref = entry.issue
    ? itemRef(entry.issue.repo, entry.issue.number, singleRepo)
    : Array.isArray(entry.prs) && entry.prs[0]
      ? `PR ${itemRef(entry.prs[0].repo, entry.prs[0].number, singleRepo)}`
      : '';
  return {
    id: entry.id,
    removalId: entry.removalId || entry.id,
    ref,
    title: entry.title || '(untitled)',
    url: entry.url || null,
    removedAgo: since(entry.removedAt, now),
  };
}

// The rows left once `ids` are taken off — so a removal shows at once, before
// the next snapshot arrives (AC6).
export function withoutRows(data, ids) {
  if (!data || !Array.isArray(data.rows)) return data;
  const gone = new Set(ids);
  return {
    ...data,
    rows: data.rows.filter((r) => !gone.has(r.id)),
    needsHuman: Array.isArray(data.needsHuman) ? data.needsHuman.filter((n) => !gone.has(n.id)) : data.needsHuman,
  };
}

// ---------------------------------------------------------------------------
// Area ① — who is working right now
// ---------------------------------------------------------------------------

export function sessionView(s, { now = Date.now(), singleRepo = true } = {}) {
  const item = s.issue
    ? itemRef(s.issue.repo, s.issue.number, singleRepo)
    : Array.isArray(s.prs) && s.prs[0]
      ? `PR ${itemRef(s.prs[0].repo, s.prs[0].number, singleRepo)}`
      : '';
  const role = s.roleLabel || s.roleId || s.agentId;
  return {
    id: s.id || s.agentId,
    role,
    instance: s.instance != null ? `#${s.instance}` : null,
    agentId: s.agentId,
    roleId: s.roleId || null,
    chat: chatLink(s.agentId, role, s.instance != null ? s.instance : null),
    item,
    title: s.title || null,
    running: since(s.startedAt, now),
  };
}

// Tooltips a newcomer can act on: what happens to running work, what happens
// to new work, and how to undo it. `help-topics/flow-control.md` quotes the
// same three facts — `flow-control-view.test.js` keeps the two in step.
export const POOL_ACTION_TOOLTIPS = Object.freeze({
  pause: 'Pause: running instances finish their current work. New work waits in a queue and starts when you click Resume.',
  drain: 'Drain: running instances finish their current work, new work waits, and the role switches itself Off once the last one is done — including any instance still waiting on an open pull request. Click Switch on to start it again.',
  resume: 'Resume: start taking new work again. Anything that waited while paused starts now.',
  switchOn: 'Switch on: start taking new work again. Anything that waited while the role was off starts now.',
});

// One pooled role: occupancy, the plain-language state and the buttons that
// apply to it. `running` → Pause + Drain; `paused` → Resume; `draining` and
// `off` → Switch on (the same "back to running" write, named for what the
// operator sees).
//
// #2789: instances kept alive for an open pull request are outside the cap and
// named apart — "on a PR", since "waiting" already means held new work here.
export function poolView(p) {
  const busy = Number.isFinite(p.busy) ? p.busy : 0;
  const onPr = Number.isFinite(p.waiting) && p.waiting > 0 ? p.waiting : 0;
  const onPrText = onPr ? ` · ${onPr} waiting on a PR` : '';
  const occupancy = (p.capacity != null ? `${busy} of ${p.capacity} busy` : `${busy} busy`) + onPrText;
  const held = Number.isFinite(p.held) && p.held > 0 ? p.held : 0;
  const waiting = held ? ` · ${held} waiting` : '';
  let stateText;
  let actions;
  switch (p.state) {
    case 'paused':
      stateText = `Paused${busy ? `, ${busy} still running` : ''}${waiting}`;
      actions = ['resume'];
      break;
    case 'draining':
      stateText = `Draining, ${busy} still running${onPrText}${waiting}`;
      actions = ['switchOn'];
      break;
    case 'off':
      stateText = `Off${waiting}`;
      actions = ['switchOn'];
      break;
    default:
      stateText = null;
      actions = ['pause', 'drain'];
  }
  return {
    key: p.roleId || p.agentId,
    roleId: p.roleId,
    agentId: p.agentId || null,
    label: p.label || p.roleId,
    occupancy,
    state: p.state || 'running',
    stateText,
    actions: actions.map((a) => ({
      id: a,
      label: { pause: 'Pause', drain: 'Drain', resume: 'Resume', switchOn: 'Switch on' }[a],
      tooltip: POOL_ACTION_TOOLTIPS[a],
      nextState: a === 'pause' ? 'paused' : a === 'drain' ? 'draining' : 'running',
    })),
  };
}

// #2848: each running instance of a pooled role is listed beneath that role's
// pool line. A session's `roleId` is its role's member id — the pool's
// `agentId`, the same key the server counts the pool's occupancy by (the pool's
// own `roleId` is the short role id). A session whose pool is not on the board
// stays top level, so no run ever disappears. Server order (longest-running
// first) is kept, so instances do not jump around on refresh.
export function groupWorkingNow(sessions, pools) {
  const list = Array.isArray(sessions) ? sessions : [];
  const byRole = new Map();
  const grouped = (Array.isArray(pools) ? pools : []).map((p) => {
    const g = { ...p, instances: [] };
    const key = p.agentId || p.roleId;
    if (key && !byRole.has(key)) byRole.set(key, g);
    return g;
  });
  const top = [];
  for (const s of list) {
    const pool = s && s.roleId ? byRole.get(s.roleId) : null;
    if (pool) pool.instances.push(s);
    else top.push(s);
  }
  return { sessions: top, pools: grouped };
}

// ---------------------------------------------------------------------------
// Area ② — where a person is needed
// ---------------------------------------------------------------------------

// "Release claim" (#2754): what the confirm dialog says before a stuck row's
// orphaned `<wake>:wip` claim is swapped back to its wake label on GitHub.
export const RELEASE_CONFIRM_TEXT = 'The stale claim label is removed and the wake label put back on the GitHub item, so the flow picks it up again on its next poll (within about a minute). Only do this when nobody is still working on it.';

export function releaseDialogTitle(ref) {
  return ref ? `Release the claim on ${ref}?` : 'Release this claim?';
}

// The notice after a release that swapped at least one claim — on success the
// dialog just closes, so say what happens next (#2754 review). Null when
// nothing was released (the error bar carries that).
export function releaseNotice(res, ref) {
  const n = res && Number.isFinite(res.released) ? res.released : 0;
  if (n < 1) return null;
  const what = n === 1 ? 'Claim released' : `${n} claims released`;
  return `${what}${ref ? ` on ${ref}` : ''} — its agent picks it up on the next poll (within about a minute).`;
}

// "Wake never delivered" (#2872): why each parked wake label never reached its
// agent, as the GitHub Event Log recorded it. `help-topics/flow-control.md`
// explains the same four causes.
export const WAKE_CAUSE_TEXT = Object.freeze({
  'history-horizon': 'older than its agent\u2019s trigger (flow re-applied or team moved)',
  'wake-already-armed': 're-add dropped as already armed',
  'not-seen': 'never reported by the GitHub Events API',
});

export function wakeCauseText(w) {
  if (!w || typeof w !== 'object') return '';
  if (WAKE_CAUSE_TEXT[w.cause]) return WAKE_CAUSE_TEXT[w.cause];
  return `dropped (${w.dropReason || 'unknown'})`;
}

// "Wake again" (#2873): what the confirm dialog says before a parked wake is
// delivered to its agent again. `help-topics/flow-control.md` quotes it.
export const WAKE_CONFIRM_TEXT = 'The wake label already on the GitHub item is delivered to its agent again, directly — no label is changed. A pooled role starts on the item\u2019s own instance; a hand-off with a readiness gate still waits for CI. Only do this when nobody is already working on it.';

// "Adopt" (#2877): the same delivery for a row carried over from another
// instance or an earlier flow. `help-topics/flow-control.md` quotes it.
export const CARRIED_OVER_REASON = 'carried over — not started here';
export const ADOPT_CONFIRM_TEXT = 'These items already carry a wake label from before this team\u2019s triggers were activated here — after a move to this instance or a flow re-apply. Adopting delivers each label to its agent once, directly — no label is changed. Items an agent is already working on, or that wait in a queue, are skipped.';

export function adoptDialogTitle(n) {
  return n === 1 ? 'Adopt 1 carried-over item?' : `Adopt ${n} carried-over items?`;
}

// The notice after "Adopt all"; null when nothing was adopted.
export function adoptNotice(res) {
  const n = res && Number.isFinite(res.adopted) ? res.adopted : 0;
  if (n < 1) return null;
  return `${n === 1 ? '1 item' : `${n} items`} adopted — each agent starts on its next check.`;
}

export function wakeDialogTitle(ref) {
  return ref ? `Wake the agent for ${ref} again?` : 'Wake the agent again?';
}

// "Wake Code Reviewer for PR #2844 (ready-for-review)".
export function wakeTargetText(w) {
  const roles = (Array.isArray(w && w.roles) ? w.roles : []).map((r) => r && (r.label || r.id)).filter(Boolean);
  return `Wake ${roles.join(' and ') || 'its agent'} for ${w.ref} (${w.label})`;
}

// The notice after a wake that reached at least one agent; null otherwise
// (the error bar carries that).
export function wakeNotice(res, ref) {
  const n = res && Number.isFinite(res.woken) ? res.woken : 0;
  if (n < 1) return null;
  const held = (Array.isArray(res.results) ? res.results : []).some((r) => r && r.ok && r.held > 0 && !r.delivered);
  return `${n === 1 ? 'Wake' : `${n} wakes`} delivered again${ref ? ` for ${ref}` : ''} — ${held ? 'its hand-off waits for CI first' : 'its agent starts on its next check (within a few seconds)'}.`;
}

export function needsYouView(entry, { now = Date.now(), singleRepo = true } = {}) {
  const ref = entry.issue
    ? itemRef(entry.issue.repo, entry.issue.number, singleRepo)
    : Array.isArray(entry.prs) && entry.prs[0]
      ? `PR ${itemRef(entry.prs[0].repo, entry.prs[0].number, singleRepo)}`
      : '';
  const release = (Array.isArray(entry.release) ? entry.release : [])
    .filter((c) => c && typeof c.claim === 'string' && typeof c.wake === 'string')
    .map((c) => ({
      ref: `${c.kind === 'pr' ? 'PR ' : ''}${itemRef(c.repo, c.number, singleRepo)}`,
      claim: c.claim,
      wake: c.wake,
      text: `${c.claim} → ${c.wake}`,
    }));
  const wakes = (Array.isArray(entry.wakes) ? entry.wakes : [])
    .filter((w) => w && typeof w.label === 'string')
    .map((w) => ({
      ref: `${w.kind === 'pr' ? 'PR ' : ''}${itemRef(w.repo, w.number, singleRepo)}`,
      label: w.label,
      cause: w.cause,
      text: wakeCauseText(w),
      href: eventLogHref(w.eventId),
      roles: (Array.isArray(w.roles) ? w.roles : []).filter((r) => r && r.id),
    }))
    .map((w) => ({ ...w, target: wakeTargetText(w) }));
  return {
    id: entry.id,
    ref,
    title: entry.title || '(untitled)',
    url: entry.url || null,
    reason: entry.reason || (entry.needsHuman && entry.needsHuman.reason) || '',
    waiting: since(entry.since || (entry.needsHuman && entry.needsHuman.since), now),
    release,
    wakes,
    canWake: wakes.some((w) => w.roles.length > 0),
    // #2877: a carried-over row's wake button reads "Adopt".
    carriedOver: (entry.reason || (entry.needsHuman && entry.needsHuman.reason)) === CARRIED_OVER_REASON,
  };
}

// ---------------------------------------------------------------------------
// The whole board
// ---------------------------------------------------------------------------

export const EMPTY_TEXT = 'Nothing in progress';

// The note under "Recently completed": how long a finished item stays on the
// board. `doneRetentionHours` comes from the per-team column configuration.
export function retentionHint(hours) {
  const h = Number(hours);
  if (hours == null || !Number.isFinite(h) || h <= 0) return 'Kept for a limited time · configurable in columns settings';
  return `Kept for ${h} h · configurable in columns settings`;
}

// Everything the page renders, in render order. Area ② and "Recently
// completed" are `null`/empty when there is nothing to show so the page simply
// does not mount them (AC8, #2607). Finished rows (closed issue, merged PR) are
// never mixed into "In progress": `empty` counts active rows only.
export function boardView(data, now = Date.now()) {
  const d = data || {};
  const repos = Array.isArray(d.repos) ? d.repos : [];
  const opts = { now, singleRepo: repos.length <= 1, teamId: d.teamId || null, canManage: !!d.canManage };
  const stages = Array.isArray(d.stages) ? d.stages : [];
  const rows = (Array.isArray(d.rows) ? d.rows : []).map((r) => rowView(r, stages, opts));
  const activeRows = rows.filter((r) => !r.done);
  const doneRows = rows.filter((r) => r.done);
  const doneRetentionHours = d.doneRetentionHours ?? (d.config && d.config.doneRetentionHours) ?? null;
  const needs = (Array.isArray(d.needsHuman) ? d.needsHuman : []).map((n) => needsYouView(n, opts));
  const removed = (Array.isArray(d.removed) ? d.removed : []).map((r) => removedView(r, opts));
  const working = groupWorkingNow(
    (Array.isArray(d.sessions) ? d.sessions : []).map((s) => sessionView(s, opts)),
    (Array.isArray(d.pools) ? d.pools : []).map(poolView),
  );
  return {
    stages,
    roles: Array.isArray(d.roles) ? d.roles : [],
    handoffs: (Array.isArray(d.handoffs) ? d.handoffs : []).filter((h) => h && h.id).map((h) => handoffView(h, opts)),
    sessions: working.sessions,
    pools: working.pools,
    held: Array.isArray(d.held) ? d.held : [],
    needsYou: needs.length ? needs : null,
    // #2877: rows the board's "Adopt all" would start.
    carriedOver: Array.isArray(d.carriedOver) ? d.carriedOver.filter((id) => needs.some((n) => n.id === id && n.canWake)) : [],
    activeRows,
    doneRows,
    removed,
    removedLabel: `Removed (${removed.length})`,
    empty: activeRows.length === 0,
    emptyText: EMPTY_TEXT,
    warning: d.warning || null,
    stale: !!d.stale,
    partial: Array.isArray(d.warnings) ? d.warnings : [],
    noRepos: !d.maintenance && repos.length === 0 && d.generatedAt != null,
    maintenance: !!d.maintenance,
    canManage: !!d.canManage,
    doneRetentionHours,
    retentionHint: retentionHint(doneRetentionHours),
  };
}

// ---------------------------------------------------------------------------
// Auto-refresh preference — remembered per user
// ---------------------------------------------------------------------------

export const AUTO_REFRESH_MS = 30_000;
const AUTO_REFRESH_PREFIX = 'flowControl.autoRefresh.';

// Per-username key, matching `agentChat.coachmark.<id>.<username>`; a missing
// username (the env single-admin) falls back to a shared `anon` bucket.
export function autoRefreshKey(username) {
  return `${AUTO_REFRESH_PREFIX}${username || 'anon'}`;
}

function resolveStore(store) {
  if (store) return store;
  return typeof window !== 'undefined' ? window.localStorage : null;
}

// On unless the user switched it off — the board is a live view.
export function readAutoRefresh(username, store) {
  const ls = resolveStore(store);
  if (!ls) return true;
  try {
    return ls.getItem(autoRefreshKey(username)) !== 'off';
  } catch {
    return true;
  }
}

export function writeAutoRefresh(username, on, store) {
  const ls = resolveStore(store);
  if (!ls) return;
  try {
    ls.setItem(autoRefreshKey(username), on ? 'on' : 'off');
  } catch {
    /* ignore — the worst case is the default next visit */
  }
}

// ---------------------------------------------------------------------------
// Column configuration (optional, per team)
// ---------------------------------------------------------------------------

// The editable form of the config: one entry per role in the order the graph
// derives (`roles` from the board response — before any rename/merge/hide, so
// a hidden or merged role can be brought back). Draft and Done are fixed frames
// and never appear here.
export function configFormRows(roles, config) {
  const cfg = (config && config.stages) || {};
  return (Array.isArray(roles) ? roles : []).map((r) => {
    const c = cfg[r.id] || {};
    return {
      id: r.id,
      derivedLabel: r.label || r.id,
      label: c.label || '',
      hidden: !!c.hidden,
      mergeInto: c.mergeInto || '',
    };
  });
}

// Back to the stored shape; empty fields are dropped so "no config" stays the
// automatic derivation.
export function configFromForm(formRows, doneRetentionHours) {
  const stages = {};
  for (const r of Array.isArray(formRows) ? formRows : []) {
    const entry = {};
    if (r.label && r.label.trim()) entry.label = r.label.trim();
    if (r.hidden) entry.hidden = true;
    if (r.mergeInto && r.mergeInto !== r.id) entry.mergeInto = r.mergeInto;
    if (Object.keys(entry).length) stages[r.id] = entry;
  }
  const hours = Number(doneRetentionHours);
  return {
    doneRetentionHours: Number.isFinite(hours) && hours >= 0 ? hours : 24,
    stages,
  };
}
